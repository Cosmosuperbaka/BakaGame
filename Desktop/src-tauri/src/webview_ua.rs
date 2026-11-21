//! 把客户端段追加到 WebView 的 User-Agent 后面（不整体覆盖默认 UA）。
//!
//! Tauri 只能在建 WebView 时整体指定 UA，所以这里直接走平台接口：先读出 WebView 自己的默认 UA
//! 记下来，再写回「默认 UA + 空格 + 客户端段」。建窗后立刻写一次（游戏版本是 `unknown`），
//! 读到站点的 `version.json` 后再写一次。写入只影响之后发出的请求，所以启动页要等这一步
//! 做完（或超时）再进站，见 `splash.rs` 与启动页脚本。
//!
//! 平台接口：Windows 是 WebView2 的 `ICoreWebView2Settings2::put_UserAgent`，
//! macOS 是 WKWebView 的 `customUserAgent`。

use std::sync::OnceLock;

use tauri::{Runtime, WebviewWindow};

/// WebView 自己的默认 UA（追加客户端段之前），第一次写入时记下
static BASE: OnceLock<String> = OnceLock::new();

/// 默认 UA 与客户端段拼起来；默认 UA 读不到时只用客户端段
fn combine(base: &str, segment: &str) -> String {
    let base = base.trim();
    if base.is_empty() {
        segment.to_string()
    } else {
        format!("{base} {segment}")
    }
}

/// 把当前客户端段写进 WebView 的 UA。在主线程上执行，结果只记日志，不影响页面加载。
pub fn apply<R: Runtime>(window: &WebviewWindow<R>) {
    let segment = crate::user_agent::current();
    let result = window.with_webview(move |webview| {
        if let Err(err) = platform::apply(&webview, &segment) {
            eprintln!("[baka-ua] WebView UA 写入失败：{err}");
        }
    });
    if let Err(err) = result {
        eprintln!("[baka-ua] 拿不到 WebView：{err}");
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings2;
    use windows_core::{Interface, PCWSTR, PWSTR};

    pub fn apply(webview: &tauri::webview::PlatformWebview, segment: &str) -> Result<(), String> {
        // SAFETY：以下都是 WebView2 的 COM 调用，在 with_webview 的主线程回调里执行；
        // 读出的字符串由 take_pwstr 接管并释放，写入的缓冲区在调用期间存活
        unsafe {
            let core = webview
                .controller()
                .CoreWebView2()
                .map_err(|err| format!("CoreWebView2：{err}"))?;
            let settings = core
                .Settings()
                .map_err(|err| format!("Settings：{err}"))?
                .cast::<ICoreWebView2Settings2>()
                .map_err(|err| format!("ICoreWebView2Settings2：{err}"))?;
            let base = super::BASE.get_or_init(|| {
                let mut raw = PWSTR::null();
                match settings.UserAgent(&mut raw) {
                    Ok(()) => webview2_com::take_pwstr(raw),
                    Err(_) => String::new(),
                }
            });
            let wide: Vec<u16> = super::combine(base, segment)
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();
            settings
                .SetUserAgent(PCWSTR::from_raw(wide.as_ptr()))
                .map_err(|err| format!("put_UserAgent：{err}"))
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{msg_send, sel};
    use objc2_foundation::NSString;

    /// WKWebView 在 macOS 上的默认 UA（Safari 14 起冻结的这一串）。读不到实际值时用它兜底。
    const FROZEN_DEFAULT: &str =
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";

    pub fn apply(webview: &tauri::webview::PlatformWebview, segment: &str) -> Result<(), String> {
        let pointer = webview.inner() as *const AnyObject;
        if pointer.is_null() {
            return Err("WKWebView 为空".to_string());
        }
        // SAFETY：指针来自 Tauri，在 with_webview 的主线程回调期间有效；
        // `valueForKey:` 与 `setCustomUserAgent:` 都是 WKWebView 上的 Objective-C 方法
        unsafe {
            let wk: &AnyObject = &*pointer;
            // KVC 找不到对应取值方法会抛 NSUndefinedKeyException，异常穿过 Rust 会直接中止进程，
            // 所以先确认 WKWebView 上确有 `userAgent` 或 `_userAgent`（KVC 会匹配后者），没有就用兜底串
            let readable: bool = msg_send![wk, respondsToSelector: sel!(userAgent)];
            let readable_private: bool = msg_send![wk, respondsToSelector: sel!(_userAgent)];
            let writable: bool = msg_send![wk, respondsToSelector: sel!(setCustomUserAgent:)];
            if !writable {
                return Err("WKWebView 不支持 setCustomUserAgent".to_string());
            }
            let base = super::BASE.get_or_init(|| {
                if !(readable || readable_private) {
                    return FROZEN_DEFAULT.to_string();
                }
                // 还没设过 customUserAgent 时，userAgent 键读到的就是 WebKit 的默认 UA
                let key = NSString::from_str("userAgent");
                let value: Option<Retained<AnyObject>> = msg_send![wk, valueForKey: &*key];
                value
                    .and_then(|object| object.downcast::<NSString>().ok())
                    .map(|text| text.to_string())
                    .filter(|text| !text.trim().is_empty())
                    .unwrap_or_else(|| FROZEN_DEFAULT.to_string())
            });
            let ua = NSString::from_str(&super::combine(base, segment));
            let _: () = msg_send![wk, setCustomUserAgent: &*ua];
        }
        Ok(())
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod platform {
    pub fn apply(_webview: &tauri::webview::PlatformWebview, _segment: &str) -> Result<(), String> {
        Err("当前平台不支持改写 WebView UA".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 客户端段追加在默认 UA 之后、空格分隔；默认 UA 读不到时只用客户端段
    #[test]
    fn segment_is_appended_after_the_default_user_agent() {
        let segment = "BakaGame/0.2.1 (Windows 10.0.26100; x64; desktop) Game/unknown";
        assert_eq!(
            combine(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/142.0",
                segment
            ),
            format!("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/142.0 {segment}")
        );
        assert_eq!(combine("  ", segment), segment);
    }
}
