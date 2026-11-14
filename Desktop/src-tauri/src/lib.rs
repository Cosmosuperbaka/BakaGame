//! BakaGame 桌面壳（Tauri v2 + 远程 URL，计划 P2.1）。
//!
//! 壳里只做三件事：开窗口、跑自检、给握手签名，**不含任何业务 UI**，也不打包前端。
//! 对页面暴露的能力全部集中在 `bridge` 注入的 `window.__BAKA_CHANNEL__` 上，
//! 具体条款见同目录 `CLIENT_NOTICE.md` 与 `notice.rs`。

mod attest;
mod bridge;
#[cfg(test)]
mod capability_policy;
mod config;
mod device;
mod dnsproxy;
mod http;
mod httpdns;
mod notice;
mod peb;
mod secret;
mod selfcheck;
mod single_instance;
#[cfg(test)]
mod test_support;
#[cfg(target_os = "windows")]
mod winapi;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// 等密钥就绪的上限：超过就返回错误，让页面按「桌面通道不可用」处理
const DEVICE_READY_TIMEOUT: Duration = Duration::from_secs(5);

/// 签发失败后的重试间隔：桥接脚本每几秒就来要一张票，离线时不能把它变成对证明接口的轰炸
/// （票的 TTL 只有几十秒，间隔再长就会让页面长时间拿不到票）
const TICKET_RETRY_SECONDS: u64 = 10;

/// 设备身份槽：启动线程载入密钥后发布，取票路径阻塞等待。用条件变量等，发布时立刻唤醒，
/// 不靠定时轮询。
struct DeviceSlot {
    device: Mutex<Option<Arc<device::Device>>>,
    ready: Condvar,
}

impl DeviceSlot {
    fn new() -> Self {
        Self {
            device: Mutex::new(None),
            ready: Condvar::new(),
        }
    }

    fn get(&self) -> Option<Arc<device::Device>> {
        self.device.lock().ok().and_then(|guard| guard.clone())
    }

    fn publish(&self, device: Arc<device::Device>) {
        if let Ok(mut guard) = self.device.lock() {
            *guard = Some(device);
            self.ready.notify_all();
        }
    }

    /// 最多等 `timeout`，发布后立即返回
    fn wait(&self, timeout: Duration) -> Option<Arc<device::Device>> {
        let guard = self.device.lock().ok()?;
        let (guard, _) = self
            .ready
            .wait_timeout_while(guard, timeout, |device| device.is_none())
            .ok()?;
        guard.clone()
    }
}

/// 壳的运行状态
pub struct AppState {
    /// 设备身份；启动线程载入密钥后立即发布（不等注册完成）
    device: DeviceSlot,
    /// 密钥与 `clientId` 的目录
    dir: PathBuf,
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
    fn new(dir: PathBuf) -> Self {
        Self {
            device: DeviceSlot::new(),
            dir,
            last_attest_failure: AtomicU64::new(0),
            ticket: Mutex::new(None),
            attesting: Mutex::new(()),
        }
    }

    /// 当前已发布的设备身份（非阻塞）
    fn current_device(&self) -> Option<Arc<device::Device>> {
        self.device.get()
    }

    /// 发布设备身份：密钥一就绪就发布，不等注册完成——注册在慢网下最长要 20 秒，
    /// 而取票路径自己会在没有 `clientId` 时补注册，不依赖启动线程先注册完
    fn publish_device(&self, device: Arc<device::Device>) {
        self.device.publish(device);
    }

    fn now_secs() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }

    /// 取设备身份，最多等 `DEVICE_READY_TIMEOUT`（阻塞调用，必须跑在 `spawn_blocking` 里）
    fn wait_for_device(&self) -> Option<Arc<device::Device>> {
        self.device.wait(DEVICE_READY_TIMEOUT)
    }

    /// 取缓存里那张**还没交给页面**且仍然新鲜的票；取出即记为已用，绝不二次给出
    fn take_cached_ticket(&self) -> Option<attest::TicketPayload> {
        let mut guard = self.ticket.lock().ok()?;
        let held = guard.as_mut()?;
        let now = attest::Stamp::now();
        if !held.usable(now) {
            return None;
        }
        held.served = true;
        Some(held.payload(now))
    }

    /// 放行一次导航时对票缓存的处理：只清掉**已经交给过页面**的票。
    /// 缓存里没交出去的票页面从没见过，旧页不可能把它用掉，换页面后仍然有效，
    /// 留着让新页面直接取，省掉重签的两趟 HTTP 和一次自检。
    fn on_navigation_allowed(&self) {
        if let Ok(mut guard) = self.ticket.lock() {
            if guard.as_ref().is_some_and(|held| held.served) {
                *guard = None;
            }
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
        Ok(ticket) => {
            let payload = ticket.payload(attest::Stamp::now());
            state.note_attest_success();
            // 这张票当场交给了调用方，不在缓存里留副本：留着只会被误当成还能用的票
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
        .and_then(|guard| guard.as_ref().map(|held| held.usable(attest::Stamp::now())))
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
            eprintln!("已预签票据，剩余有效 {} 毫秒", ticket.remaining_ms(attest::Stamp::now()));
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
    Ok(state.current_device().and_then(|device| device.client_id()))
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

/// 桥接的 `selfCheck()`：每次调用都重新跑一遍，不缓存（调试器可能中途才附着）
#[tauri::command]
async fn baka_self_check(app: tauri::AppHandle) -> Result<selfcheck::SelfCheckReport, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<AppState>();
        let protection = state
            .current_device()
            .map(|device| device.protection())
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
            Some(unwrapped) if &unwrapped[..] == MARK => selfcheck::KeyProtection::Hardware,
            _ => selfcheck::KeyProtection::Software,
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        selfcheck::KeyProtection::Software
    }
}

/// 载入/创建设备密钥并**立刻发布**，再交给 `register` 做自检与注册。
/// 发布必须排在注册之前：注册最长等 20 秒，期间页面桥每几秒就来取票，
/// 设备身份晚发布只会让这些取票空等并触发失败退避。
fn bootstrap_device(state: &AppState, register: impl FnOnce(&Arc<device::Device>)) {
    let current = match device::load_or_create(&state.dir) {
        Ok(created) => Arc::new(created),
        Err(err) => {
            // 密钥不可用不退出：自检仍可上报，签名会明确报错，页面按 Web 口径处理
            eprintln!("设备密钥不可用：{err}");
            return;
        }
    };
    if let Some(cached) = device::cached_client_id(&state.dir) {
        current.set_client_id(cached);
    }
    state.publish_device(current.clone());
    register(&current);
}

/// 启动后台线程：载入/创建设备密钥 → 跑一次自检 → 上报公钥换 `clientId` → 预签一张票
fn spawn_device_bootstrap(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        bootstrap_device(&state, |current| {
            let report = selfcheck::run(current.protection());
            eprintln!(
                "启动自检：判定={:?} hard={:?}",
                report.verdict(),
                report.hard_fail
            );
            if let Err(err) = device::register(&state.dir, current, &report) {
                // 注册失败（离线 / 服务端未就绪）不影响普通房游玩，反作弊房会被服务端拒
                eprintln!("设备注册失败，稍后按需重试：{err}");
            }
        });
        // 密钥与 clientId 就绪后先备一张票：页面脚本执行时首次同步读取就能拿到
        premint_ticket(&state);
    });
}

/// 只允许留在壳自己的站点与空白页上，其余导航一律拒绝（外链应由页面用系统浏览器打开）
fn navigation_allowed(url: &str, site: &str) -> bool {
    url == "about:blank" || within_site(url, site) || within_site(url, "https://bg.baka.website")
}

/// `url` 是否落在 `base` 这个站点上：整串相等，或紧接 `/`、`?`、`#` 的子路径。
///
/// 不能用 `starts_with(base)` 了事——那样 `https://game.baka.website.evil.example`
/// 也算「同一个站点」，页面能把窗口导航到外站，站内身份就成了钓鱼的外壳。
fn within_site(url: &str, base: &str) -> bool {
    let base = base.trim_end_matches('/');
    if base.is_empty() {
        return false;
    }
    match url.strip_prefix(base) {
        Some(rest) => {
            rest.is_empty()
                || rest.starts_with('/')
                || rest.starts_with('?')
                || rest.starts_with('#')
        }
        None => false,
    }
}

/// 页面、接口与 WS 统一经回环隧道：受管域名按 HTTPDNS 解析，所以 hosts 被污染时
/// 页面本身也打得开。没配 HTTPDNS 时不启隧道，保持原来的系统 DNS 与系统代理行为。
///
/// 应在设备引导线程启动之前调用：隧道直连目标、不读任何代理设置，启用后壳自己发的
/// 注册、领挑战与换票请求也要直连（见 `http::mark_webview_tunnel_active`），
/// 否则票据签发时的来源地址与页面握手时的来源地址可能不是同一个出口。
fn start_webview_tunnel() -> Option<tauri::Url> {
    let address = httpdns::shared().and_then(|resolver| match dnsproxy::start(resolver) {
        Ok(address) => {
            eprintln!("[baka-dns-proxy] listening on {address}");
            Some(address)
        }
        Err(err) => {
            eprintln!("[baka-dns-proxy] 启动失败，继续使用系统 DNS：{err}");
            None
        }
    })?;
    match format!("http://{address}").parse::<tauri::Url>() {
        Ok(url) => {
            http::mark_webview_tunnel_active();
            Some(url)
        }
        Err(err) => {
            eprintln!("[baka-dns-proxy] 隧道地址非法，改用系统代理：{err}");
            None
        }
    }
}

fn create_main_window(
    app: &tauri::App,
    tunnel: Option<tauri::Url>,
) -> Result<tauri::WebviewWindow, Box<dyn std::error::Error>> {
    let site = config::site_url();
    let nav_site = site.clone();
    // 导航回调里要动运行状态（弃票 + 预签），所以握一份 AppHandle
    let nav_handle = app.handle().clone();
    let pump_handle = nav_handle.clone();
    let parsed = site
        .parse()
        .map_err(|err| format!("站点地址 {site} 不是合法 URL：{err}"))?;

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
                // 换页面上下文：交给过旧页面的票先清掉，再后台补一张没交出去的（已有可用的就不补），
                // 让新页面的第一次同步读取就有票可用（票 30 秒 TTL）
                nav_handle.state::<AppState>().on_navigation_allowed();
                spawn_ticket_pump(pump_handle.clone());
            }
            allowed
        });

    if let Some(url) = tunnel {
        builder = builder.proxy_url(url);
    }

    Ok(builder.build()?)
}

pub fn run() {
    // 先落条款与构建身份，再启动任何可能失败的步骤
    notice::log_identity();

    // 单实例保护只在发布构建启用：开发时需要同时开多个壳（不同账号联调）。
    // 已有实例在跑就把它的窗口拉到前台并退出，不去碰同一份设备密钥文件、不再起第二套隧道。
    let _single_instance = if cfg!(debug_assertions) {
        None
    } else {
        match single_instance::acquire(single_instance::MUTEX_NAME) {
            single_instance::Instance::First(guard) => Some(guard),
            single_instance::Instance::AlreadyRunning => {
                eprintln!("已有一个 BakaGame 桌面客户端在运行，聚焦它的窗口后退出");
                if !single_instance::focus_existing_window(config::WINDOW_TITLE) {
                    eprintln!("没有找到已有实例的窗口，可能它正在启动或退出，本次直接退出");
                }
                return;
            }
        }
    };

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            baka_self_check,
            baka_client_id,
            baka_ticket
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let dir = device::storage_dir();
            // 先定下 WebView 的出口，再让设备引导线程发请求：登记前发出的请求仍走带代理的客户端
            let tunnel = start_webview_tunnel();
            app.manage(AppState::new(dir.clone().unwrap_or_default()));
            match dir {
                Some(_) => spawn_device_bootstrap(handle.clone()),
                None => eprintln!(
                    "无法确定密钥存储目录（APPDATA / USERPROFILE 都取不到），桌面通道未启用"
                ),
            }
            create_main_window(app, tunnel)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("BakaGame 桌面壳运行失败");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    /// 设备身份必须在注册开始之前就发布：注册在慢网下要等很久，
    /// 期间页面桥取票若看不到身份，会空等并触发失败退避
    #[test]
    fn device_is_published_before_registration_starts() {
        let dir = TempDir::new("publish-first");
        let state = AppState::new(dir.path().to_path_buf());
        let mut seen_during_register = None;
        bootstrap_device(&state, |_| {
            seen_during_register = Some(state.current_device().is_some());
        });
        assert_eq!(
            seen_during_register,
            Some(true),
            "注册开始时设备身份应已发布"
        );
        assert!(state.current_device().is_some());
    }

    fn ticket_in_cache(state: &AppState) -> Option<attest::Ticket> {
        state.ticket.lock().unwrap().clone()
    }

    fn fresh_ticket(served: bool) -> attest::Ticket {
        let mut ticket =
            attest::Ticket::new("t".to_string(), Duration::from_secs(30), attest::Stamp::now());
        ticket.served = served;
        ticket
    }

    /// 页面从没见过缓存里那张没交出去的票，换页面时它仍然有效，不该白白弃掉再重签
    /// （重签要多两趟 HTTP 和一次自检）；只有已经交给过页面的票才没有保留价值
    #[test]
    fn navigation_keeps_unserved_ticket_and_drops_served_one() {
        let state = AppState::new(PathBuf::new());
        state.store_ticket(fresh_ticket(false));
        state.on_navigation_allowed();
        assert!(ticket_in_cache(&state).is_some(), "没交出去的票不该被丢");
        assert!(
            state.take_cached_ticket().is_some(),
            "新页面应当还能直接取到它"
        );

        // 取出后它已记为已用；下一次导航再清掉这条已用记录
        state.on_navigation_allowed();
        assert!(ticket_in_cache(&state).is_none(), "已用的票应被清掉");
        assert!(state.take_cached_ticket().is_none());
    }

    /// 设备身份槽：发布立即唤醒等待者，超时返回 None，已发布时不阻塞
    #[test]
    fn device_slot_wakes_waiters_on_publish() {
        let dir = TempDir::new("slot");
        let slot = Arc::new(DeviceSlot::new());
        assert!(
            slot.wait(Duration::from_millis(80)).is_none(),
            "无人发布应超时"
        );

        let device = Arc::new(device::load_or_create(dir.path()).unwrap());
        let publisher = {
            let slot = slot.clone();
            let device = device.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(50));
                slot.publish(device);
            })
        };
        let started = std::time::Instant::now();
        let found = slot.wait(Duration::from_secs(5)).expect("发布后应被唤醒");
        assert_eq!(found.public_key_b64(), device.public_key_b64());
        assert!(started.elapsed() < Duration::from_secs(2));
        publisher.join().unwrap();

        let again = std::time::Instant::now();
        assert!(slot.wait(Duration::from_secs(5)).is_some());
        assert!(
            again.elapsed() < Duration::from_millis(500),
            "已发布时不应阻塞"
        );
    }

    /// 站内导航要放行，前缀相同的域名要挡住（否则窗口能被导航去外站当钓鱼壳）
    #[test]
    fn navigation_stays_on_site() {
        let site = "https://game.baka.website";
        assert!(navigation_allowed("https://game.baka.website", site));
        assert!(navigation_allowed("https://game.baka.website/", site));
        assert!(navigation_allowed("https://game.baka.website/cee?x=1", site));
        assert!(navigation_allowed("https://game.baka.website#top", site));
        assert!(navigation_allowed("about:blank", site));
        assert!(navigation_allowed("https://bg.baka.website/a.png", site));

        assert!(!navigation_allowed("https://game.baka.website.evil.example/", site));
        assert!(!navigation_allowed("https://evil.example/?next=https://game.baka.website", site));
        assert!(!navigation_allowed("https://game.baka.website:8443/", site));
        assert!(!navigation_allowed("http://localhost:5173/", site));
    }
}
