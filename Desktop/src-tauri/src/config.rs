//! 运行期配置：站点/接口基址、版本号与构建身份。
//!
//! 环境变量只在开发机上用（`BAKA_SITE_URL` / `BAKA_API_BASE`），发布构建必须留空——
//! 任何非 https 的地址都会被拒绝并退回默认值，不给「把签名发到假站」留口子。

/// 远程 URL 模式加载的站点（计划 P2.1）
pub const DEFAULT_SITE_URL: &str = "https://game.baka.website";

/// 窗口标题
pub const WINDOW_TITLE: &str = "BakaGame";

/// 主窗口标签：capabilities 里的 `windows` 字段要与之对应
pub const WINDOW_LABEL: &str = "main";

/// 应用标识：WebView2 的用户数据目录按它命名（`%LOCALAPPDATA%\<identifier>\EBWebView`），
/// 必须与 `tauri.conf.json` 的 `identifier` 逐字一致，改了那边要改这里。
pub const APP_IDENTIFIER: &str = "website.baka.game.desktop";

pub fn client_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

pub fn build_id() -> &'static str {
    env!("BAKA_BUILD_ID")
}

/// 本次构建的蜜标 `BKG-CANARY-<buildId>-<random8>`（由 `build.rs` 注入）
pub fn canary() -> &'static str {
    env!("BAKA_CANARY")
}

/// 壳加载的站点地址：必须是 https，否则退回默认值
pub fn site_url() -> String {
    let candidate = std::env::var("BAKA_SITE_URL")
        .ok()
        .map(|v| v.trim().trim_end_matches('/').to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| DEFAULT_SITE_URL.to_string());
    if !candidate.starts_with("https://") {
        eprintln!(
            "BAKA_SITE_URL 不是 https，已忽略并按默认站点加载：{DEFAULT_SITE_URL}（原值 {candidate}）"
        );
        return DEFAULT_SITE_URL.to_string();
    }
    candidate
}

/// 接口基址：注册与通道证明三趟往返（`/api/client/register`、`challenge`、`attest`）共用。
/// 默认与站点同源（服务端把这些路由挂在同一入口）。
pub fn api_base() -> String {
    let candidate = std::env::var("BAKA_API_BASE")
        .ok()
        .map(|v| v.trim().trim_end_matches('/').to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(site_url);
    if !candidate.starts_with("https://") {
        eprintln!("BAKA_API_BASE 不是 https，已忽略并按站点同源：{}", site_url());
        return site_url();
    }
    candidate
}
