//! 壳 ↔ 服务端的 JSON POST 传输层（注册与通道证明共用）。
//!
//! 只有这一个地方构造 `reqwest::blocking::Client`（进程内按是否直连各留一个、重复使用）：
//! 基址统一取自 `config::api_base()`（强制 https），不跟随重定向，响应体有上限，
//! 错误信封按服务端的 `{ error: { code, message, traceId } }` 解析，
//! 并兼容 `{ error: "CODE" }` 这种把码直接放在 `error` 上的写法。
//! 上层只需要 `code` 来决定「换一条路径重试」还是「就此放弃」，通道约束见 `Server/docs/ClientChannel.md`。

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

/// 接口调用失败。`code` 为可归因码（§6 词表）；传输层与解析层的失败拿不到码，记 `None`。
pub struct ApiError {
    pub message: String,
    pub code: Option<String>,
}

impl ApiError {
    /// 壳侧自己构造的失败（没走到服务端，或响应体不合契约）
    pub fn local(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: None,
        }
    }

    /// 按错误码判定，供上层决定重试策略
    pub fn is(&self, code: &str) -> bool {
        self.code.as_deref() == Some(code)
    }

    /// 只用于日志：带码时把码附在后面，排查时能直接对上 §6 的表
    pub fn text(&self) -> String {
        match &self.code {
            Some(code) => format!("{}（{code}）", self.message),
            None => self.message.clone(),
        }
    }
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct ErrorEnvelope {
    #[serde(default)]
    error: Option<ErrorBody>,
}

/// 服务端把错误码放在 `error.code`，早期写法是 `error` 直接给字符串；两种都认。
#[derive(Deserialize, Debug)]
#[serde(untagged)]
enum ErrorBody {
    Coded {
        #[serde(default)]
        code: Option<String>,
        #[serde(default)]
        message: Option<String>,
    },
    Plain(String),
}

impl ErrorBody {
    fn split(self) -> (Option<String>, Option<String>) {
        match self {
            ErrorBody::Coded { code, message } => (code, message),
            ErrorBody::Plain(code) => (Some(code), None),
        }
    }
}

/// 响应体读取上限：注册与证明的响应都只有几百字节，异常网关或被劫持的出口不该能让壳读无界数据
const MAX_RESPONSE_BYTES: u64 = 64 * 1024;

/// 两个进程级共享的客户端：Client 是连接池与 TLS 配置的持有者，每次请求都新建一个，
/// 等于每趟都重做 TLS 初始化与握手，延迟直接叠在建连关键路径上。
/// 回环目标必须直连（见 `post_json` 的说明），所以按「是否直连」各留一个。
///
/// 只缓存**成功**的结果：初始化偶发失败（系统证书库暂时读不出之类）不能被永久记住，
/// 否则这次进程里之后所有请求都会失败；失败不占位，下次请求重新构造。
static PROXIED_CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();
static DIRECT_CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();

/// 取缓存的值；没有就构造，成功才写入缓存。并发时两边都构造、先写入者胜，后者的实例丢弃。
fn get_or_try_build<T>(
    cell: &OnceLock<T>,
    build: impl FnOnce() -> Result<T, String>,
) -> Result<&T, String> {
    if let Some(value) = cell.get() {
        return Ok(value);
    }
    let built = build()?;
    Ok(cell.get_or_init(|| built))
}

fn build_client(direct: bool) -> Result<reqwest::blocking::Client, String> {
    // 不跟随重定向：服务端从不重定向这些接口，出现 30x 只可能是异常网关或被劫持的出口；
    // 默认策略会跟到明文地址，307/308 还会连同请求体（clientId、签名、挑战）一起重发。
    let mut builder =
        reqwest::blocking::Client::builder().redirect(reqwest::redirect::Policy::none());
    if let Some(resolver) = crate::httpdns::shared() {
        builder = builder.dns_resolver(Arc::new(crate::httpdns::ReqwestResolver::new(resolver)));
    }
    // 回环目标一律直连。终端里常驻的 `HTTP_PROXY`（Clash 等，`Set-Proxy` 之类一行就设上）
    // 会把发往 localhost 的请求交给代理进程，代理再把它转到远端节点——那边连不到这台机器，
    // 回来就是一个**空响应体的 502**，看着像本地后端挂了，其实请求连 Vite 都没到过。
    // 生产域名照旧走环境里的代理，这里只掐回环。
    if direct {
        builder = builder.no_proxy();
    }
    builder
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败：{e}"))
}

/// WebView 是否已经被指向本地隧道（见 `dnsproxy`）。隧道直连目标、不经系统代理，
/// 所以此后壳自己发的请求也必须直连，两条路径才是同一个出口。
static WEBVIEW_TUNNEL_ACTIVE: AtomicBool = AtomicBool::new(false);

/// 登记「WebView 走本地隧道」。必须在任何对外请求之前调用：共享客户端按需构造一次后就不再变。
pub fn mark_webview_tunnel_active() {
    WEBVIEW_TUNNEL_ACTIVE.store(true, Ordering::SeqCst);
}

/// 这条请求要不要绕过系统代理直连。
///
/// 回环目标永远直连（见 `build_client` 的说明）；WebView 走隧道时，壳内请求也直连：
/// 服务端把票绑定到签发时的来源地址，壳取票与页面握手的出口不同，握手就会因地址不符被拒。
fn bypasses_system_proxy(url: &str, tunnel_active: bool) -> bool {
    tunnel_active || is_loopback(url)
}

fn client_for(url: &str) -> Result<&'static reqwest::blocking::Client, ApiError> {
    let direct = bypasses_system_proxy(url, WEBVIEW_TUNNEL_ACTIVE.load(Ordering::SeqCst));
    let cell = if direct {
        &DIRECT_CLIENT
    } else {
        &PROXIED_CLIENT
    };
    get_or_try_build(cell, || build_client(direct)).map_err(ApiError::local)
}

/// 读响应体，最多 `MAX_RESPONSE_BYTES`；超出返回 `None`（调用方按「响应体过大」处理）
fn read_limited(response: reqwest::blocking::Response) -> Option<Vec<u8>> {
    let mut body = Vec::new();
    response
        .take(MAX_RESPONSE_BYTES + 1)
        .read_to_end(&mut body)
        .ok()?;
    (body.len() as u64 <= MAX_RESPONSE_BYTES).then_some(body)
}

/// 阻塞式 JSON POST：`path` 是接口相对路径（如 `/api/client/challenge`）。
/// 非 2xx 一律转成 `ApiError`，并尽量带上服务端的可归因码。
pub fn post_json<B, R>(path: &str, body: &B, timeout: Duration) -> Result<R, ApiError>
where
    B: Serialize + ?Sized,
    R: DeserializeOwned,
{
    let url = format!("{}{}", crate::config::api_base(), path);
    post_json_to(&url, path, body, timeout)
}

fn post_json_to<B, R>(url: &str, path: &str, body: &B, timeout: Duration) -> Result<R, ApiError>
where
    B: Serialize + ?Sized,
    R: DeserializeOwned,
{
    send_json(client_for(url)?, url, path, body, timeout)
}

fn send_json<B, R>(
    client: &reqwest::blocking::Client,
    url: &str,
    path: &str,
    body: &B,
    timeout: Duration,
) -> Result<R, ApiError>
where
    B: Serialize + ?Sized,
    R: DeserializeOwned,
{
    // 超时按请求设：共享客户端上注册与领挑战、换票用的超时各不相同
    let response = client
        .post(url)
        .timeout(timeout)
        .json(body)
        .send()
        .map_err(|e| ApiError::local(format!("请求 {url} 失败：{e}")))?;
    let status = response.status();
    if !status.is_success() {
        // 4xx 的响应体只有几百字节，读到上限为止不改变「不重试」的结论；读不动就退回状态码文本
        let text = read_limited_lossy(response);
        let (code, message) = serde_json::from_str::<ErrorEnvelope>(&text)
            .ok()
            .and_then(|envelope| envelope.error)
            .map(ErrorBody::split)
            .unwrap_or_default();
        if code.is_none() && message.is_none() {
            // 解不出信封多半是中间网关插了一手（生产边缘 502 是 HTML 兜底页）：
            // 把地址与响应体开头打到控制台，省得只看「HTTP 502」时连打到哪都不知道。
            let head: String = text.chars().take(160).collect();
            let head = head.split_whitespace().collect::<Vec<_>>().join(" ");
            eprintln!("[BakaGame http] POST {url} -> {status}，响应体开头：{head}");
            if head.is_empty() && is_loopback(url) {
                eprintln!(
                    "[BakaGame http] 回环请求的空体 {status} 通常是代理软件拦的：壳已对 localhost \
                     禁用代理，若仍出现请检查代理是否处于 TUN / 全局模式。"
                );
            }
        }
        return Err(ApiError {
            message: message
                .filter(|m| !m.trim().is_empty())
                .unwrap_or_else(|| format!("{url} 被拒绝：HTTP {status}")),
            code,
        });
    }
    let bytes = read_limited(response)
        .ok_or_else(|| ApiError::local(format!("{path} 响应体过大或读取失败")))?;
    serde_json::from_slice::<R>(&bytes)
        .map_err(|e| ApiError::local(format!("{path} 响应格式错误：{e}")))
}

/// 错误响应体：读到上限为止，超出部分丢弃；非 UTF-8 的字节按替换字符处理
fn read_limited_lossy(response: reqwest::blocking::Response) -> String {
    let mut body = Vec::new();
    let _ = response.take(MAX_RESPONSE_BYTES).read_to_end(&mut body);
    String::from_utf8_lossy(&body).into_owned()
}

/// 目标是否为回环地址（`localhost` / `127.0.0.0/8` / `[::1]`）。
///
/// 只用于「这条请求要不要绕过代理」：本地站点与本地接口永远在本机，绕代理才连得到。
/// 判据取自 URL 解析结果，`localhost.evil.example` 这类前缀相同的域名不算。
fn is_loopback(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    let Some(host) = parsed.host_str() else {
        return false;
    };
    // IPv6 字面量带方括号（`[::1]`），去掉后才能交给 `IpAddr` 解析
    let host = host.trim_matches(['[', ']']);
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    host.parse::<std::net::IpAddr>()
        .map(|ip| ip.is_loopback())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 初始化失败不缓存：一次瞬时失败之后，下次请求要重新构造；成功之后才缓存、不再构造
    #[test]
    fn failed_client_build_is_not_cached() {
        let cell: OnceLock<u32> = OnceLock::new();
        let calls = std::cell::Cell::new(0u32);
        let build = |ok: bool| {
            move || {
                if ok {
                    Ok(7)
                } else {
                    Err("瞬时失败".to_string())
                }
            }
        };
        let count = |f: &dyn Fn() -> Result<u32, String>| {
            calls.set(calls.get() + 1);
            f()
        };
        assert!(get_or_try_build(&cell, || count(&build(false))).is_err());
        assert!(cell.get().is_none(), "失败不能占位");
        assert_eq!(get_or_try_build(&cell, || count(&build(true))), Ok(&7));
        // 已成功缓存：再取不会再构造，哪怕此时构造函数会失败
        assert_eq!(get_or_try_build(&cell, || count(&build(false))), Ok(&7));
        assert_eq!(calls.get(), 2, "第三次必须直接命中缓存");
    }

    /// 回环目标必须直连：靠它把本地请求从代理手里抢回来（代理会给出空体 502）
    #[test]
    fn detects_loopback_targets() {
        assert!(is_loopback("http://localhost:5173/api/client/register"));
        assert!(is_loopback("http://127.0.0.1:4850/api/client/challenge"));
        assert!(is_loopback("http://[::1]:5173/api/client/register"));
        assert!(is_loopback("http://LOCALHOST:5173/api"));

        // 生产域名与「看着像回环」的域名都不算
        assert!(!is_loopback(
            "https://game.baka.website/api/client/register"
        ));
        assert!(!is_loopback(
            "http://localhost.evil.example/api/client/register"
        ));
        assert!(!is_loopback("http://10.0.0.2:5173/api"));
    }

    /// 服务端信封：`{ error: { code, message } }` 与 `{ error: "CODE" }` 两种写法都要能拿到码
    #[test]
    fn parses_both_error_shapes() {
        let coded: ErrorEnvelope = serde_json::from_str(
            r#"{"error":{"code":"CLIENT_UNTRUSTED","message":"完整性不通过"}}"#,
        )
        .expect("标准信封应能解析");
        let (code, message) = match coded.error {
            Some(ErrorBody::Coded { code, message }) => (code, message),
            other => panic!("期望 Coded 分支，实际 {other:?}"),
        };
        assert_eq!(code.as_deref(), Some("CLIENT_UNTRUSTED"));
        assert_eq!(message.as_deref(), Some("完整性不通过"));

        let plain: ErrorEnvelope =
            serde_json::from_str(r#"{"error":"CLIENT_UNKNOWN"}"#).expect("简写信封应能解析");
        let (code, _) = match plain.error {
            Some(body) => body.split(),
            None => panic!("简写信封应解析出 error"),
        };
        assert_eq!(code.as_deref(), Some("CLIENT_UNKNOWN"));
    }

    /// 非 JSON 的错误体（网关兜底页）解析失败只是拿不到码，不得影响调用方
    #[test]
    fn unparsable_body_degrades_to_no_code() {
        assert!(serde_json::from_str::<ErrorEnvelope>("<html>502</html>").is_err());
        let transport = ApiError::local("HTTP 400");
        assert_eq!(transport.text(), "HTTP 400");
        assert!(!transport.is("CLIENT_UNTRUSTED"));
        assert_eq!(
            ApiError {
                message: "完整性不通过".into(),
                code: Some("CLIENT_UNTRUSTED".into())
            }
            .text(),
            "完整性不通过（CLIENT_UNTRUSTED）"
        );
    }

    // —— 传输层行为：用本机回环上的小型 HTTP 服务模拟服务端与异常网关 ——

    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// 读完一个请求（含按 Content-Length 的请求体）；连接关闭返回 false
    fn read_request(stream: &mut TcpStream) -> bool {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&buf[..end]).to_ascii_lowercase();
                let length = head
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length:"))
                    .and_then(|value| value.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                while buf.len() < end + 4 + length {
                    match stream.read(&mut chunk) {
                        Ok(0) | Err(_) => return false,
                        Ok(n) => buf.extend_from_slice(&chunk[..n]),
                    }
                }
                return true;
            }
            match stream.read(&mut chunk) {
                Ok(0) | Err(_) => return false,
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
            }
        }
    }

    /// 起一个回环 HTTP 服务：每个请求用 `respond` 生成完整响应；返回基址与「已接受连接数」
    fn mock_server(
        respond: impl Fn() -> Vec<u8> + Send + Sync + 'static,
    ) -> (String, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let connections = Arc::new(AtomicUsize::new(0));
        let counter = connections.clone();
        let respond = Arc::new(respond);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                counter.fetch_add(1, Ordering::SeqCst);
                let respond = respond.clone();
                std::thread::spawn(move || {
                    while read_request(&mut stream) {
                        if stream.write_all(&respond()).is_err() {
                            break;
                        }
                    }
                });
            }
        });
        (format!("http://{address}"), connections)
    }

    fn json_response(body: &str) -> Vec<u8> {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .into_bytes()
    }

    #[derive(serde::Deserialize)]
    struct Echo {
        ok: bool,
    }

    /// 服务端或边缘异常重定向时不得跟随：307/308 会连同请求体（clientId、签名、挑战）重发到新地址
    #[test]
    fn redirects_are_never_followed() {
        let (target, target_hits) = mock_server(|| json_response(r#"{"ok":true}"#));
        let location = format!("{target}/elsewhere");
        let (origin, _) = mock_server(move || {
            format!(
                "HTTP/1.1 307 Temporary Redirect\r\nLocation: {location}\r\nContent-Length: 0\r\n\r\n"
            )
            .into_bytes()
        });
        let result: Result<Echo, ApiError> = post_json_to(
            &format!("{origin}/api/client/attest"),
            "/api/client/attest",
            &serde_json::json!({"clientId": "ccd_x"}),
            Duration::from_secs(3),
        );
        assert!(result.is_err(), "30x 必须当作失败，而不是跟过去");
        assert_eq!(
            target_hits.load(Ordering::SeqCst),
            0,
            "重定向目标不应收到任何请求"
        );
    }

    /// 响应体有上限：超大响应不能让壳读无界数据
    #[test]
    fn oversized_response_body_is_rejected() {
        let padding = "a".repeat(200 * 1024);
        let body = format!(r#"{{"ok":true,"pad":"{padding}"}}"#);
        let (origin, _) = mock_server(move || json_response(&body));
        let result: Result<Echo, ApiError> = post_json_to(
            &format!("{origin}/api/client/register"),
            "/api/client/register",
            &serde_json::json!({}),
            Duration::from_secs(5),
        );
        let err = result.err().expect("超过上限的响应应被拒绝");
        assert!(err.message.contains("过大"), "{}", err.message);

        let (small, _) = mock_server(|| json_response(r#"{"ok":true}"#));
        let ok: Echo = post_json_to(
            &format!("{small}/api/client/register"),
            "/api/client/register",
            &serde_json::json!({}),
            Duration::from_secs(5),
        )
        .unwrap_or_else(|e| panic!("正常响应应成功：{}", e.text()));
        assert!(ok.ok);
    }

    /// 连续请求复用同一个客户端与连接，不再每次重建 TLS 与连接池
    #[test]
    fn consecutive_requests_share_one_connection() {
        let (origin, connections) = mock_server(|| json_response(r#"{"ok":true}"#));
        for _ in 0..3 {
            let reply: Echo = post_json_to(
                &format!("{origin}/api/client/challenge"),
                "/api/client/challenge",
                &serde_json::json!({"clientId": "ccd_x"}),
                Duration::from_secs(3),
            )
            .unwrap_or_else(|e| panic!("请求应成功：{}", e.text()));
            assert!(reply.ok);
        }
        assert_eq!(
            connections.load(Ordering::SeqCst),
            1,
            "三次请求应复用同一条连接"
        );
    }

    /// 取环境里的代理设置，构造完客户端立刻还原：reqwest 在构造时读取，之后改环境无影响
    struct ProxyEnv(Vec<(&'static str, Option<std::ffi::OsString>)>);

    impl ProxyEnv {
        fn set(proxy: &str) -> Self {
            const KEYS: [&str; 6] = [
                "HTTP_PROXY",
                "http_proxy",
                "HTTPS_PROXY",
                "https_proxy",
                "NO_PROXY",
                "no_proxy",
            ];
            let saved = KEYS.iter().map(|key| (*key, std::env::var_os(key))).collect();
            for key in KEYS {
                std::env::remove_var(key);
            }
            std::env::set_var("HTTP_PROXY", proxy);
            std::env::set_var("http_proxy", proxy);
            Self(saved)
        }
    }

    impl Drop for ProxyEnv {
        fn drop(&mut self) {
            for (key, value) in &self.0 {
                match value {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }
    }

    /// 用「环境里配了系统代理」的条件构造一个客户端，向一个不可路由的地址发请求；
    /// 返回代理收到的请求数与请求是否成功。走代理就会到达本机的模拟代理，直连就连不出去。
    fn request_with_system_proxy(tunnel_active: bool) -> (usize, bool) {
        let (proxy, hits) = mock_server(|| json_response(r#"{"ok":true}"#));
        let url = "http://203.0.113.1:81/api/client/attest";
        let client = {
            let _env = ProxyEnv::set(&proxy);
            build_client(bypasses_system_proxy(url, tunnel_active)).expect("客户端应能构造")
        };
        let result: Result<Echo, ApiError> = send_json(
            &client,
            url,
            "/api/client/attest",
            &serde_json::json!({}),
            Duration::from_millis(800),
        );
        (hits.load(Ordering::SeqCst), result.is_ok())
    }

    /// WebView 走本地隧道（直连）时，壳内请求不得再走系统代理，否则取票与握手出口不同、
    /// 票据绑定的来源地址对不上；没有隧道时保持系统代理行为（企业网络只能靠它出网）
    #[test]
    fn shell_requests_leave_the_same_way_as_the_webview() {
        let (hits, ok) = request_with_system_proxy(false);
        assert!(ok && hits >= 1, "没有隧道时应沿用系统代理");
        let (hits, ok) = request_with_system_proxy(true);
        assert_eq!(hits, 0, "隧道启用后壳内请求不能再交给系统代理");
        assert!(!ok);
    }

    /// 超时按请求设置：共享客户端不能让「每请求超时」失效
    #[test]
    fn per_request_timeout_still_applies() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            // 接受连接但永不回应
            let held: Vec<TcpStream> = listener.incoming().flatten().take(1).collect();
            std::thread::sleep(Duration::from_secs(3));
            drop(held);
        });
        let started = std::time::Instant::now();
        let result: Result<Echo, ApiError> = post_json_to(
            &format!("http://{address}/api/client/attest"),
            "/api/client/attest",
            &serde_json::json!({}),
            Duration::from_millis(300),
        );
        assert!(result.is_err());
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "{:?}",
            started.elapsed()
        );
    }
}
