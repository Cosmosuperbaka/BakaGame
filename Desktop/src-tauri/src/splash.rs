//! 打包在壳里的本地启动页（`Desktop/splash/`，经 `frontendDist` 编进二进制）。
//!
//! 窗口先打开本地启动页：它探测站点连得上再整页切过去，连不上就给提示、「重试」与带退避的自动重试，
//! 而不是让 WebView 停在系统自带的错误页上。启动页拿不到任何桥接命令：能力文件只授给站点来源
//! （`local: false`），桥接脚本也不在本地页上注入。
//!
//! 窗口背景按系统明暗预先涂成站点默认主题的背景色，启动页与站点首屏之间不闪白。

use tauri::window::Color;

/// 启动页在包内的入口文件
pub const ENTRY: &str = "index.html";

/// 本地页的来源：Windows 上是 `http(s)://tauri.localhost`，macOS 上是 `tauri://localhost`
const LOCAL_ORIGINS: &[&str] = &[
    "http://tauri.localhost",
    "https://tauri.localhost",
    "tauri://localhost",
];

/// 站点默认主题的页面背景（与 `Desktop/splash/index.html` 里的取值同源）
const LIGHT_BACKGROUND: Color = Color(0xf5, 0xf1, 0xe6, 0xff);
const DARK_BACKGROUND: Color = Color(0x2d, 0x26, 0x21, 0xff);

/// 地址是不是壳自己的本地页（启动页）
pub fn is_local_page(url: &str) -> bool {
    LOCAL_ORIGINS.iter().any(|origin| {
        url.strip_prefix(origin).is_some_and(|rest| {
            rest.is_empty()
                || rest.starts_with('/')
                || rest.starts_with('?')
                || rest.starts_with('#')
        })
    })
}

/// 按系统明暗取窗口背景色
pub fn background(dark: bool) -> Color {
    if dark {
        DARK_BACKGROUND
    } else {
        LIGHT_BACKGROUND
    }
}

/// 给启动页的初始化脚本：只在本地页上把站点地址写进一个只读全局，站点页面上什么都不做，
/// 不往站点的全局作用域里多放东西。地址经 JSON 编码，拼不出脚本注入。
pub fn init_script(site: &str) -> String {
    let encoded = serde_json::to_string(site).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        r#"(function () {{
  try {{
    if (location.protocol !== "tauri:" && location.hostname !== "tauri.localhost") {{ return; }}
    Object.defineProperty(window, "__BAKA_SPLASH__", {{
      value: Object.freeze({{ site: {encoded} }}),
      enumerable: false,
      configurable: false,
      writable: false
    }});
  }} catch (e) {{}}
}})();"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 本地页只认壳自己的两种来源，前缀相同的外站不算
    #[test]
    fn local_pages_are_recognized_by_exact_origin() {
        assert!(is_local_page("http://tauri.localhost/index.html"));
        assert!(is_local_page("https://tauri.localhost/"));
        assert!(is_local_page("tauri://localhost/index.html"));
        assert!(is_local_page("http://tauri.localhost"));

        assert!(!is_local_page("http://tauri.localhost.evil.example/"));
        assert!(!is_local_page(
            "https://evil.example/?next=http://tauri.localhost"
        ));
        assert!(!is_local_page("http://localhost:5173/"));
        assert!(!is_local_page("https://game.example.com/"));
    }

    /// 初始化脚本只在本地页生效，站点地址经 JSON 编码：引号与反斜杠拼不出脚本
    #[test]
    fn init_script_is_local_only_and_escapes_the_site() {
        let script = init_script("https://example.com");
        assert!(script.contains(r#"site: "https://example.com""#));
        assert!(script.contains(r#"location.hostname !== "tauri.localhost""#));
        let hostile = init_script("https://example.com\"});alert(1);//");
        assert!(hostile.contains(r#"\"});alert(1);//"#), "{hostile}");
    }

    /// 背景色与启动页、站点默认主题同源
    #[test]
    fn background_follows_system_theme() {
        assert_eq!(background(false), Color(0xf5, 0xf1, 0xe6, 0xff));
        assert_eq!(background(true), Color(0x2d, 0x26, 0x21, 0xff));
        let splash = include_str!("../../splash/index.html");
        assert!(splash.contains("--background: #f5f1e6;"));
        assert!(splash.contains("--background: #2d2621;"));
    }
}
