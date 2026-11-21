//! 壳本体的自动更新（Tauri 官方 updater 插件，只在 Rust 侧使用）。
//!
//! 页面本来就是远程站点，这里更新的是壳自己（自检、签名、构建布局这些原生侧变更）。流程：
//! 启动后在后台线程检查 → 有新版就在后台下载并校验签名 → 校验过的包留在内存里、状态记为就绪 →
//! 页面通过契约外命令读状态，玩家点「重启更新」时才安装并重启。不做退出时静默安装。
//!
//! 页面能做的只有两件事：读状态、请求安装壳自己已经下载并校验过的那一份。它给不出地址也给不出
//! 字节；安装前插件还会用编进二进制的公钥再校验一遍签名，所以页面没有任何途径让壳装上一个
//! 未签名或被改过的包。任何一步失败都只记日志并退避重试，不影响游玩；网页上的「下载最新版」
//! 链接始终是兜底。

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

/// 更新清单接口的路径模板：三个占位段由插件按本机平台、架构与当前版本替换。
/// 服务端的壳契约对账测试拿它与服务端路由逐段比对。
pub const UPDATE_PATH: &str = "/api/client/desktop-update/{{target}}/{{arch}}/{{current_version}}";

/// 启动后先等一会儿再查：别和首屏加载、设备注册、预签票抢网络
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(20);
/// 查过且没有新版时，隔多久再查一次（长时间挂着的壳也能等到新版）
const RECHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// 失败退避：从这里起每次翻倍，封顶到 `RECHECK_INTERVAL`，离线时不会变成对接口的轰炸
const RETRY_BASE: Duration = Duration::from_secs(5 * 60);
/// 查询清单只是一个小 JSON，超时要短；下载安装包要给足时间（慢网下几十兆也得下得完）
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// 页面看到的更新阶段
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    /// 还没查完（启动后等待中或正在查）
    Checking,
    /// 查过了，没有新版；或者本构建不启用自动更新
    None,
    /// 发现新版，正在后台下载
    Downloading,
    /// 新版已下载并通过签名校验，等玩家点「重启更新」
    Ready,
    /// 这一轮失败了（离线、清单读不到、签名不对……），稍后自动重试
    Failed,
}

/// `baka_update_status` 的返回体
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub state: Phase,
    /// 发现的新版本号；没有新版时省略
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

/// 已下载并校验过的更新包
struct Prepared {
    update: Update,
    bytes: Vec<u8>,
}

/// 壳内的更新状态：后台线程写，页面命令读
pub struct UpdateState {
    status: Mutex<UpdateStatus>,
    prepared: Mutex<Option<Prepared>>,
}

impl UpdateState {
    pub fn new() -> Self {
        Self {
            status: Mutex::new(UpdateStatus {
                state: Phase::Checking,
                version: None,
            }),
            prepared: Mutex::new(None),
        }
    }

    pub fn status(&self) -> UpdateStatus {
        self.status
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or(UpdateStatus {
                state: Phase::Failed,
                version: None,
            })
    }

    fn set(&self, state: Phase, version: Option<String>) {
        if let Ok(mut guard) = self.status.lock() {
            *guard = UpdateStatus { state, version };
        }
    }

    fn store(&self, prepared: Prepared) {
        if let Ok(mut guard) = self.prepared.lock() {
            *guard = Some(prepared);
        }
    }

    fn take(&self) -> Option<Prepared> {
        self.prepared.lock().ok().and_then(|mut guard| guard.take())
    }
}

/// 本构建是否启用自动更新：发布构建恒启用；开发构建要显式设 `BAKA_UPDATER_DEV=1` 才启用，
/// 免得每次 `tauri dev` 都在后台下一遍安装包，点一下还会把已安装的正式版换掉。
fn enabled() -> bool {
    !cfg!(debug_assertions)
        || matches!(
            std::env::var("BAKA_UPDATER_DEV").as_deref(),
            Ok("1") | Ok("true")
        )
}

/// 第 `failures` 次连续失败后等多久再试：指数退避，封顶到常规复查间隔
fn retry_delay(failures: u32) -> Duration {
    let factor = 1u32 << failures.saturating_sub(1).min(16);
    RETRY_BASE.saturating_mul(factor).min(RECHECK_INTERVAL)
}

/// 更新清单地址：接口基址按 `config::api_base` 的口径（发布构建固定 https 站点，开发构建可覆盖）
fn endpoint(base: &str) -> Result<Url, String> {
    format!("{}{}", base.trim_end_matches('/'), UPDATE_PATH)
        .parse::<Url>()
        .map_err(|err| format!("更新清单地址不合法：{err}"))
}

/// 一轮检查的结局
enum Round {
    UpToDate,
    Ready,
    Failed(String),
}

/// 启动后台检查线程。只调用一次；检查本身是异步的，放进这条线程里阻塞地跑，不占用任何回调线程。
pub fn spawn(app: AppHandle) {
    if !enabled() {
        eprintln!(
            "[baka-updater] disabled reason=dev-build（设 BAKA_UPDATER_DEV=1 可在开发构建里启用）"
        );
        app.state::<UpdateState>().set(Phase::None, None);
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_CHECK_DELAY);
        let mut failures = 0u32;
        loop {
            let delay = match tauri::async_runtime::block_on(run_round(&app)) {
                // 就绪后不再查：包已经在手里，等玩家决定什么时候重启
                Round::Ready => return,
                Round::UpToDate => {
                    failures = 0;
                    RECHECK_INTERVAL
                }
                Round::Failed(reason) => {
                    failures = failures.saturating_add(1);
                    let delay = retry_delay(failures);
                    eprintln!(
                        "[baka-updater] 第 {failures} 次失败，{} 秒后重试：{reason}",
                        delay.as_secs()
                    );
                    delay
                }
            };
            std::thread::sleep(delay);
        }
    });
}

async fn run_round(app: &AppHandle) -> Round {
    let state = app.state::<UpdateState>();
    state.set(Phase::Checking, None);
    let checked = match endpoint(&crate::config::api_base()).and_then(|url| {
        app.updater_builder()
            .endpoints(vec![url])
            .and_then(|builder| builder.timeout(CHECK_TIMEOUT).build())
            .map_err(|err| format!("更新器初始化失败：{err}"))
    }) {
        Ok(updater) => updater
            .check()
            .await
            .map_err(|err| format!("检查更新失败：{err}")),
        Err(err) => Err(err),
    };
    let mut update = match checked {
        Ok(Some(update)) => update,
        Ok(None) => {
            state.set(Phase::None, None);
            return Round::UpToDate;
        }
        Err(reason) => {
            state.set(Phase::Failed, None);
            return Round::Failed(reason);
        }
    };
    let version = update.version.clone();
    eprintln!("[baka-updater] 发现新版 {version}，后台下载");
    state.set(Phase::Downloading, Some(version.clone()));
    update.timeout = Some(DOWNLOAD_TIMEOUT);
    // download 在返回前已经用编进二进制的公钥校验过签名，校验不过就是错误
    match update.download(|_, _| {}, || {}).await {
        Ok(bytes) => {
            eprintln!(
                "[baka-updater] 新版 {version} 已下载并通过签名校验（{} 字节）",
                bytes.len()
            );
            state.store(Prepared { update, bytes });
            state.set(Phase::Ready, Some(version));
            Round::Ready
        }
        Err(err) => {
            state.set(Phase::Failed, Some(version));
            Round::Failed(format!("下载或校验新版失败：{err}"))
        }
    }
}

/// 安装已就绪的更新并重启。只能装壳自己下载并校验过的那一份；没有就报错，不发任何请求。
///
/// Windows 上插件启动安装程序后直接退出本进程，由安装程序装完再把新版拉起来；
/// macOS 上包替换完成后返回，这里再重启。同步阻塞，只在后台线程里调用。
pub fn install(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<UpdateState>();
    let Some(prepared) = state.take() else {
        return Err("没有已就绪的更新".to_string());
    };
    let version = prepared.update.version.clone();
    eprintln!("[baka-updater] 安装新版 {version}");
    // install 会先用公钥把字节再校验一遍，校验不过绝不安装
    if let Err(err) = prepared.update.install(&prepared.bytes) {
        state.set(Phase::Failed, Some(version));
        return Err(format!("安装新版失败：{err}"));
    }
    // 走到这里只有 macOS（Windows 已经在 install 里退出）：重启会先拉起新进程再退出旧进程，
    // 先放掉单实例锁，否则新进程撞上还没退出的自己会直接退出，玩家就只剩一个关掉的窗口
    crate::single_instance::release();
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 退避从 5 分钟起翻倍，封顶到常规复查间隔，连续失败多少次都不会溢出
    #[test]
    fn retry_delay_doubles_and_is_capped() {
        assert_eq!(retry_delay(1), RETRY_BASE);
        assert_eq!(retry_delay(2), RETRY_BASE * 2);
        assert_eq!(retry_delay(3), RETRY_BASE * 4);
        assert_eq!(retry_delay(10), RECHECK_INTERVAL);
        assert_eq!(retry_delay(u32::MAX), RECHECK_INTERVAL);
        assert!(retry_delay(0) >= RETRY_BASE, "第 0 次也不能比基线更短");
        // 离线时一小时之内最多四五次，不会变成轰炸
        let first_hour: Duration = (1..=5).map(retry_delay).sum();
        assert!(first_hour >= Duration::from_secs(60 * 60));
    }

    /// 清单地址：接口基址加路径模板，占位段原样留给插件替换，结尾斜杠不会拼出双斜杠
    #[test]
    fn endpoint_keeps_placeholders_for_the_plugin() {
        let url = endpoint("https://example.com/").unwrap().to_string();
        assert!(url.starts_with("https://example.com/api/client/desktop-update/"));
        assert!(!url.contains("//api"));
        for placeholder in ["target", "arch", "current_version"] {
            assert!(
                url.contains(&format!("%7B%7B{placeholder}%7D%7D")),
                "缺占位段 {placeholder}：{url}"
            );
        }
    }

    /// 页面看到的状态词表：前端按这些字面量判断，改名等于改契约
    #[test]
    fn status_serializes_to_the_page_vocabulary() {
        let names: Vec<String> = [
            Phase::Checking,
            Phase::None,
            Phase::Downloading,
            Phase::Ready,
            Phase::Failed,
        ]
        .iter()
        .map(|phase| serde_json::to_string(phase).unwrap())
        .collect();
        assert_eq!(
            names,
            [
                "\"checking\"",
                "\"none\"",
                "\"downloading\"",
                "\"ready\"",
                "\"failed\""
            ]
        );
        let ready = UpdateStatus {
            state: Phase::Ready,
            version: Some("0.2.0".into()),
        };
        assert_eq!(
            serde_json::to_string(&ready).unwrap(),
            r#"{"state":"ready","version":"0.2.0"}"#
        );
        let none = UpdateStatus {
            state: Phase::None,
            version: None,
        };
        assert_eq!(serde_json::to_string(&none).unwrap(), r#"{"state":"none"}"#);
    }

    /// 没有就绪的包时，取出来是空的：安装命令据此直接报错，不会去装任何东西
    #[test]
    fn nothing_to_install_before_an_update_is_ready() {
        let state = UpdateState::new();
        assert_eq!(state.status().state, Phase::Checking);
        assert!(state.take().is_none());
    }

    /// 发布构建恒启用；开发构建默认不启用（这里只钉住开发构建不设变量时的默认值）
    #[test]
    fn dev_builds_do_not_self_update_by_default() {
        if cfg!(debug_assertions) && std::env::var("BAKA_UPDATER_DEV").is_err() {
            assert!(!enabled());
        }
        if !cfg!(debug_assertions) {
            assert!(enabled());
        }
    }
}
