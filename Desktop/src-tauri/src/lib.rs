//! BakaGame 桌面壳（Tauri v2 + 远程 URL，计划 P2.1）。
//!
//! 壳里只做三件事：开窗口、跑自检、给握手签名，**不含任何业务 UI**，也不打包前端。
//! 对页面暴露的能力全部集中在 `bridge` 注入的 `window.__BAKA_CHANNEL__` 上，
//! 具体条款见同目录 `CLIENT_NOTICE.md` 与 `notice.rs`。

mod attest;
mod bridge;
mod config;
mod device;
mod dnsproxy;
mod http;
mod httpdns;
mod notice;
mod peb;
mod selfcheck;
#[cfg(target_os = "windows")]
mod winapi;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// 首次注册失败后的重试间隔：给离线启动留出口，又不会变成对注册接口的轰炸
const REGISTER_RETRY_SECONDS: u64 = 60;

/// 等密钥就绪的上限：超过就返回错误，让页面按「桌面通道不可用」处理
const DEVICE_READY_TIMEOUT: Duration = Duration::from_secs(5);

/// 签发失败后的重试间隔：桥接脚本每几秒就来要一张票，离线时不能把它变成对证明接口的轰炸
/// （与注册的 60 秒节流同款口径，只是票的时间窗更短，所以间隔也更短）
const TICKET_RETRY_SECONDS: u64 = 10;

/// 壳的运行状态
pub struct AppState {
    /// 设备身份；启动线程完成密钥载入与注册后才为 `Some`
    device: Mutex<Option<Arc<device::Device>>>,
    /// 密钥与 `clientId` 的目录
    dir: PathBuf,
    /// 上一次注册尝试的 Unix 秒（离线启动后的懒重试节流用）
    last_register_attempt: AtomicU64,
    /// 最近一次签发失败的 Unix 秒（0 表示没有失败过）；与 `TICKET_RETRY_SECONDS` 一起做退避
    last_attest_failure: AtomicU64,
    /// 最近签发的票据。`served == true` 表示已经交给过页面（一次性，不再给出第二次）；
    /// 缓存里留一张**没交出去**的票，页面首次同步读取就能拿到，不必现场跑两趟 HTTP
    ticket: Mutex<Option<attest::Ticket>>,
    /// 签发串行闸门：同一时刻只让一次 challenge→attest 往返在跑，
    /// 免得轮询与导航预签撞在一起把两次往返变成四趟 HTTP
    attesting: Mutex<()>,
}

impl AppState {
    fn now_secs() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }

    /// 取设备身份，最多等 `DEVICE_READY_TIMEOUT`（阻塞调用，必须跑在 `spawn_blocking` 里）
    fn wait_for_device(&self) -> Option<Arc<device::Device>> {
        let deadline = Self::now_secs() + DEVICE_READY_TIMEOUT.as_secs().max(1);
        loop {
            if let Some(found) = self.device.lock().ok().and_then(|guard| guard.clone()) {
                return Some(found);
            }
            if Self::now_secs() >= deadline {
                return None;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// 注册没成功时是否该再试一次（60 秒节流）
    fn should_retry_register(&self) -> bool {
        let now = Self::now_secs();
        let previous = self.last_register_attempt.load(Ordering::Relaxed);
        if now < previous + REGISTER_RETRY_SECONDS {
            return false;
        }
        self.last_register_attempt
            .compare_exchange(previous, now, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok()
    }

    /// 取缓存里那张**还没交给页面**且仍然新鲜的票；取出即记为已用，绝不二次给出
    fn take_cached_ticket(&self) -> Option<attest::TicketPayload> {
        let mut guard = self.ticket.lock().ok()?;
        let held = guard.as_mut()?;
        if !held.usable(attest::now_ms()) {
            return None;
        }
        held.served = true;
        Some(held.payload())
    }

    /// 弃用当前票（导航换页面上下文时调用：旧页可能已经把它用掉了）
    fn clear_ticket(&self) {
        if let Ok(mut guard) = self.ticket.lock() {
            *guard = None;
        }
    }

    /// 把刚签好的票存进缓存。只有**没人取过**的票才走这里（`premint`），
    /// 直接交给调用方的那张不留副本，避免被当成还能用的票第二次给出
    fn store_ticket(&self, ticket: attest::Ticket) {
        if let Ok(mut guard) = self.ticket.lock() {
            *guard = Some(ticket);
        }
    }

    /// 这次能不能真的去签发：失败后 10 秒内一律不去（桥接脚本的轮询不会因此变成轰炸）。
    /// 返回 `true` 就已经把「失败时间」推到将来，成功路径再用 `note_attest_success` 抹平。
    fn may_attempt_attest(&self) -> bool {
        let now = Self::now_secs();
        let previous = self.last_attest_failure.load(Ordering::Relaxed);
        if previous != 0 && now < previous + TICKET_RETRY_SECONDS {
            return false;
        }
        self.last_attest_failure.store(now, Ordering::Relaxed);
        true
    }

    fn note_attest_success(&self) {
        self.last_attest_failure.store(0, Ordering::Relaxed);
    }
}

/// 现场签一张票（走完 challenge→sign→attest 才返回）。同步阻塞，只跑在后台线程里。
///
/// 签不出来不报错给页面：返回 `None`，桥接脚本把 `channelTicket` 保持成空串，
/// 页面按「没有通道证明」连接（普通房照常，反作弊房由服务端拒）。
fn mint_ticket(state: &AppState) -> Result<Option<attest::TicketPayload>, String> {
    // 先捡现成的：预签线程或上一次调用可能已经备好一张没人取过的票
    if let Some(payload) = state.take_cached_ticket() {
        return Ok(Some(payload));
    }
    let _gate = state
        .attesting
        .lock()
        .map_err(|_| "票据签发状态被污染".to_string())?;
    // 拿到闸门后再看一次：上一个持闸者签好的票正好可以省掉这一趟往返
    if let Some(payload) = state.take_cached_ticket() {
        return Ok(Some(payload));
    }
    if !state.may_attempt_attest() {
        return Ok(None);
    }
    let Some(current) = state.wait_for_device() else {
        eprintln!("设备密钥尚未就绪，本次不签发票据");
        return Ok(None);
    };
    match attest::prove(&current, &state.dir) {
        Ok(mut ticket) => {
            let payload = ticket.payload();
            state.note_attest_success();
            // 这张票当场就交给了调用方：缓存里留一份「已取用」的记录只为排查，绝不再二次给出
            ticket.served = true;
            state.store_ticket(ticket);
            Ok(Some(payload))
        }
        Err(err) => {
            // 失败时间已经由 may_attempt_attest 记下，接下来 10 秒内的轮询直接空手而归
            eprintln!("通道证明失败，页面将按无票（网页口径）连接：{err}");
            Ok(None)
        }
    }
}

/// 预签：把一张**没交出去**的票留在缓存里，让页面的首次同步读取就能拿到。
/// 已经有一张可用票时什么都不做——票不是越多越好，30 秒后它们都只是废数据。
fn premint_ticket(state: &AppState) {
    if state
        .ticket
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|held| held.usable(attest::now_ms())))
        .unwrap_or(false)
    {
        return;
    }
    let Ok(_gate) = state.attesting.lock() else { return };
    if !state.may_attempt_attest() {
        return;
    }
    let Some(current) = state.wait_for_device() else { return };
    match attest::prove(&current, &state.dir) {
        Ok(ticket) => {
            state.note_attest_success();
            eprintln!("已预签票据，到期时间 {}", ticket.expires_at_ms);
            state.store_ticket(ticket);
        }
        Err(err) => eprintln!("预签票据未就绪：{err}"),
    }
}

/// 后台跑一次预签：导航与启动都走这里，绝不占用调用方（IPC / 导航回调）的线程
fn spawn_ticket_pump(handle: tauri::AppHandle) {
    std::thread::spawn(move || {
        let state = handle.state::<AppState>();
        premint_ticket(&state);
    });
}

/// 设备注册成功后 `clientId` 的落盘位置由 `device` 模块负责；这里只做命令包装。
///
/// `clientId` 刻意**不进** `__BAKA_CHANNEL__`：契约里只有身份、能力与票据，多一个字段就是改协议。
/// 前端如果确实需要它（比如把它写进握手帧），调用这个契约外的命令取。
#[tauri::command]
async fn baka_client_id(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let state = app.state::<AppState>();
    Ok(state
        .device
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().and_then(|device| device.client_id())))
}

/// 桥接的 `channelTicket`：给页面一张**没用过**的一次性票据。
///
/// 缓存里正好有一张（导航后预签的那张）就直接给它并记为已取用；没有就现场跑一轮
/// challenge → sign → attest。签不出来（未注册、离线、自检判死）返回 `None`，
/// 桥接脚本会把 `channelTicket` 保持成空串——网页本来就没有票，普通房不受影响。
#[tauri::command]
async fn baka_ticket(app: tauri::AppHandle) -> Result<Option<attest::TicketPayload>, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<AppState>();
        mint_ticket(&state)
    })
    .await
    .map_err(|err| format!("取票任务异常：{err}"))?
}

/// 桥接的 `sign(challenge)`：用设备私钥对 challenge 的 ASCII 字节做 Ed25519 签名，返回 base64
#[tauri::command]
async fn baka_sign(app: tauri::AppHandle, challenge: String) -> Result<String, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<AppState>();
        let current = state
            .wait_for_device()
            .ok_or_else(|| "设备密钥尚未就绪".to_string())?;
        // 离线启动过：注册还没拿到 clientId 就按节流补一次，失败也只记日志
        if current.client_id().is_none() && state.should_retry_register() {
            let dir = state.dir.clone();
            let retry = Arc::clone(&current);
            std::thread::spawn(move || {
                let report = selfcheck::run(retry.protection());
                if let Err(err) = device::register(&dir, &retry, &report) {
                    eprintln!("补注册仍未成功：{err}");
                }
            });
        }
        current.sign(&challenge)
    })
    .await
    .map_err(|err| format!("签名任务异常：{err}"))?
}

/// 桥接的 `selfCheck()`：每次调用都重新跑一遍，不缓存（调试器可能中途才附着）
#[tauri::command]
async fn baka_self_check(app: tauri::AppHandle) -> Result<selfcheck::SelfCheckReport, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<AppState>();
        let protection = state
            .device
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|device| device.protection()))
            .unwrap_or_else(probe_dpapi);
        let report = selfcheck::run(protection);
        eprintln!(
            "自检完成：判定={:?} hard={:?} soft={:?} keyProtection={:?}",
            report.verdict(),
            report.hard_fail,
            report.soft_fail,
            report.key_protection
        );
        report
    })
    .await
    .map_err(|err| format!("自检任务异常：{err}"))
}

/// DPAPI 可用性探测：拿一段固定明文做一次「加密再解回来」，只在密钥尚未落地时使用。
/// 探测本身不产生任何密钥材料，也不落盘。
fn probe_dpapi() -> selfcheck::KeyProtection {
    #[cfg(target_os = "windows")]
    {
        const MARK: &[u8] = b"bakagame-dpapi-probe";
        let wrapped = winapi::dpapi_protect(MARK, b"bakagame-probe");
        let back = wrapped.and_then(|bytes| winapi::dpapi_unprotect(&bytes, b"bakagame-probe"));
        match back {
            Some(unwrapped) if unwrapped == MARK => selfcheck::KeyProtection::Hardware,
            _ => selfcheck::KeyProtection::Software,
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        selfcheck::KeyProtection::Software
    }
}

/// 启动后台线程：载入/创建设备密钥 → 跑一次自检 → 上报公钥换 `clientId`
fn spawn_device_bootstrap(app: tauri::AppHandle, dir: PathBuf) {
    std::thread::spawn(move || {
        let current = match device::load_or_create(&dir) {
            Ok(created) => Arc::new(created),
            Err(err) => {
                // 密钥不可用不退出：自检仍可上报，签名会明确报错，页面按 Web 口径处理
                eprintln!("设备密钥不可用：{err}");
                return;
            }
        };
        if let Some(cached) = device::cached_client_id(&dir) {
            current.set_client_id(cached);
        }
        let report = selfcheck::run(current.protection());
        eprintln!(
            "启动自检：判定={:?} hard={:?}",
            report.verdict(),
            report.hard_fail
        );
        if let Err(err) = device::register(&dir, &current, &report) {
            // 注册失败（离线 / 服务端未就绪）不影响普通房游玩，反作弊房会被服务端拒
            eprintln!("设备注册失败，稍后按需重试：{err}");
        }
        let state = app.state::<AppState>();
        if let Ok(mut guard) = state.device.lock() {
            *guard = Some(current);
        }
        // 密钥与 clientId 就绪后先备一张票：页面脚本执行时首次同步读取就能拿到
        premint_ticket(&state);
    });
}

/// 只允许留在壳自己的站点与空白页上，其余导航一律拒绝（外链应由页面用系统浏览器打开）
fn navigation_allowed(url: &str, site: &str) -> bool {
    url.starts_with(site) || url == "about:blank" || url.starts_with("https://bg.baka.website")
}

fn create_main_window(app: &tauri::App) -> Result<tauri::WebviewWindow, Box<dyn std::error::Error>> {
    let site = config::site_url();
    let nav_site = site.clone();
    // 导航回调里要动运行状态（弃票 + 预签），所以握一份 AppHandle
    let nav_handle = app.handle().clone();
    let pump_handle = nav_handle.clone();
    let parsed = site
        .parse()
        .map_err(|err| format!("站点地址 {site} 不是合法 URL：{err}"))?;

    // 页面、接口与 WS 统一经回环隧道：受管域名按 HTTPDNS 解析，所以 hosts 被污染时
    // 页面本身也打得开。没配 HTTPDNS 时不启隧道，保持原来的系统 DNS 与系统代理行为。
    let proxy = httpdns::shared().and_then(|resolver| match dnsproxy::start(resolver) {
        Ok(address) => {
            eprintln!("[baka-dns-proxy] listening on {address}");
            Some(address)
        }
        Err(err) => {
            eprintln!("[baka-dns-proxy] 启动失败，继续使用系统 DNS：{err}");
            None
        }
    });

    let mut builder =
        WebviewWindowBuilder::new(app, config::WINDOW_LABEL, WebviewUrl::External(parsed))
        .title(config::WINDOW_TITLE)
        // 常规窗口项：可缩放、有系统边框、初始尺寸与下限、居中、拿焦点
        .inner_size(1280.0, 800.0)
        .min_inner_size(960.0, 600.0)
        .resizable(true)
        .maximizable(true)
        .minimizable(true)
        .closable(true)
        .decorations(true)
        .center()
        .focused(true)
        .visible(true)
        // 不调用 builder 的 devtools()：它需要 `devtools` cargo feature，
        // 而 release 构建默认不开该 feature，DevTools 本身就不存在（计划 P2.1 的选型理由）
        // 初始化脚本在页面脚本之前执行，桥接必须在这个时机注入
        .initialization_script(bridge::build())
        .on_navigation(move |url| {
            let allowed = navigation_allowed(url.as_str(), &nav_site);
            if allowed {
                // 换页面上下文：旧票要么已被旧页面用掉、要么随旧页面作废，先弃掉再后台补签，
                // 让新页面的第一次同步读取就有票可用（票 30 秒 TTL，只在这一刻重签）
                let state = nav_handle.state::<AppState>();
                state.clear_ticket();
                drop(state);
                spawn_ticket_pump(pump_handle.clone());
            }
            allowed
        });

    if let Some(address) = proxy {
        match format!("http://{address}").parse::<tauri::Url>() {
            Ok(url) => builder = builder.proxy_url(url),
            Err(err) => eprintln!("[baka-dns-proxy] 隧道地址非法，改用系统代理：{err}"),
        }
    }

    Ok(builder.build()?)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 先落条款与构建身份，再启动任何可能失败的步骤
    notice::log_identity();

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            baka_sign,
            baka_self_check,
            baka_client_id,
            baka_ticket
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let dir = device::storage_dir();
            app.manage(AppState {
                device: Mutex::new(None),
                dir: dir.clone().unwrap_or_default(),
                last_register_attempt: AtomicU64::new(0),
                last_attest_failure: AtomicU64::new(0),
                ticket: Mutex::new(None),
                attesting: Mutex::new(()),
            });
            match dir {
                Some(dir) => spawn_device_bootstrap(handle.clone(), dir),
                None => eprintln!(
                    "无法确定密钥存储目录（APPDATA / USERPROFILE 都取不到），桌面通道未启用"
                ),
            }
            create_main_window(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("BakaGame 桌面壳运行失败");
}
