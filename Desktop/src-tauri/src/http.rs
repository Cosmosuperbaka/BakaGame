//! 壳 ↔ 服务端的 JSON POST 传输层（注册与通道证明共用）。
//!
//! 只有这一个地方构造 `reqwest::blocking::Client`：基址统一取自 `config::api_base()`
//! （强制 https），错误信封按服务端的 `{ error: { code, message, traceId } }` 解析，
//! 并兼容 `{ error: "CODE" }` 这种把码直接放在 `error` 上的写法。
//! 上层只需要 `code` 来决定「换一条路径重试」还是「就此放弃」，通道约束见 `Server/docs/ClientChannel.md`。

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;

/// 接口调用失败。`code` 为可归因码（§6 词表）；传输层与解析层的失败拿不到码，记 `None`。
pub struct ApiError {
    pub message: String,
    pub code: Option<String>,
}

impl ApiError {
    /// 壳侧自己构造的失败（没走到服务端，或响应体不合契约）
    pub fn local(message: impl Into<String>) -> Self {
        Self { message: message.into(), code: None }
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

/// 阻塞式 JSON POST：`path` 是接口相对路径（如 `/api/client/challenge`）。
/// 非 2xx 一律转成 `ApiError`，并尽量带上服务端的可归因码。
pub fn post_json<B, R>(path: &str, body: &B, timeout: Duration) -> Result<R, ApiError>
where
    B: Serialize + ?Sized,
    R: DeserializeOwned,
{
    let url = format!("{}{}", crate::config::api_base(), path);
    let mut builder = reqwest::blocking::Client::builder().timeout(timeout);
    if let Some(resolver) = crate::httpdns::shared() {
        builder = builder.dns_resolver(Arc::new(crate::httpdns::ReqwestResolver::new(resolver)));
    }
    // 回环目标一律直连。终端里常驻的 `HTTP_PROXY`（Clash 等，`Set-Proxy` 之类一行就设上）
    // 会把发往 localhost 的请求交给代理进程，代理再把它转到远端节点——那边连不到这台机器，
    // 回来就是一个**空响应体的 502**，看着像本地后端挂了，其实请求连 Vite 都没到过。
    // 生产域名照旧走环境里的代理，这里只掐回环。
    if is_loopback(&url) {
        builder = builder.no_proxy();
    }
    let client = builder
        .build()
        .map_err(|e| ApiError::local(format!("HTTP 客户端初始化失败：{e}")))?;
    let response = client
        .post(&url)
        .json(body)
        .send()
        .map_err(|e| ApiError::local(format!("请求 {url} 失败：{e}")))?;
    let status = response.status();
    if !status.is_success() {
        // 4xx 的响应体只有几百字节，读全文不改变「不重试」的结论；读不动就退回状态码文本
        let text = response.text().unwrap_or_default();
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
            if head.is_empty() && is_loopback(&url) {
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
    response
        .json::<R>()
        .map_err(|e| ApiError::local(format!("{path} 响应格式错误：{e}")))
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

    /// 回环目标必须直连：靠它把本地请求从代理手里抢回来（代理会给出空体 502）
    #[test]
    fn detects_loopback_targets() {
        assert!(is_loopback("http://localhost:5173/api/client/register"));
        assert!(is_loopback("http://127.0.0.1:4850/api/client/challenge"));
        assert!(is_loopback("http://[::1]:5173/api/client/register"));
        assert!(is_loopback("http://LOCALHOST:5173/api"));

        // 生产域名与「看着像回环」的域名都不算
        assert!(!is_loopback("https://game.baka.website/api/client/register"));
        assert!(!is_loopback("http://localhost.evil.example/api/client/register"));
        assert!(!is_loopback("http://10.0.0.2:5173/api"));
    }

    /// 服务端信封：`{ error: { code, message } }` 与 `{ error: "CODE" }` 两种写法都要能拿到码
    #[test]
    fn parses_both_error_shapes() {
        let coded: ErrorEnvelope =
            serde_json::from_str(r#"{"error":{"code":"CLIENT_UNTRUSTED","message":"完整性不通过"}}"#)
                .expect("标准信封应能解析");
        let (code, message) = match coded.error {
            Some(ErrorBody::Coded { code, message }) => (code, message),
            other => panic!("期望 Coded 分支，实际 {other:?}"),
        };
        assert_eq!(code.as_deref(), Some("CLIENT_UNTRUSTED"));
        assert_eq!(message.as_deref(), Some("完整性不通过"));

        let plain: ErrorEnvelope = serde_json::from_str(r#"{"error":"CLIENT_UNKNOWN"}"#)
            .expect("简写信封应能解析");
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
            ApiError { message: "完整性不通过".into(), code: Some("CLIENT_UNTRUSTED".into()) }.text(),
            "完整性不通过（CLIENT_UNTRUSTED）"
        );
    }
}
