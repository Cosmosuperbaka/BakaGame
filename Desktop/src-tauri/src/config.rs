//! 运行期配置：站点/接口基址、版本号与构建身份。
//!
//! 环境变量只在开发机上用（`BAKA_SITE_URL` / `BAKA_API_BASE`），发布构建必须留空——
//! 任何非 https 的地址都会被拒绝并退回默认值，不给「把签名发到假站」留口子。
//!
//! 唯一的例外是**开发构建**（`debug_assertions`）里的回环 http：本地 Vite 开发服务器
//! 没有证书，只放行主机为 `localhost` / `127.0.0.1` 的明文地址。这段判断与开发默认站点
//! 都按 `cfg(debug_assertions)` 编译，release 产物里既没有放行分支，也没有本地默认值。

/// 远程 URL 模式加载的站点（计划 P2.1），发布构建的默认值
pub const DEFAULT_SITE_URL: &str = "https://game.baka.website";

/// 开发构建在没给 `BAKA_SITE_URL` 时加载的本地开发服务器：`pnpm dev:client` 的 Vite 5173。
/// 发布构建取回站点地址——「开发版默认连本地」这件事只存在于 debug 产物里。
const FALLBACK_SITE_URL: &str = if cfg!(debug_assertions) {
    "http://localhost:5173"
} else {
    DEFAULT_SITE_URL
};

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

/// 回环 http 地址：只有开发构建认它。
///
/// 主机必须是 `localhost` 或 `127.0.0.1` 本身（端口随意：5173 是 Vite 默认，歌词套件另占一个），
/// 不认 IPv6 字面量——`[::1]` 里的冒号会把「主机:端口」切坏，宁可不放行也不做半吊子解析。
/// 前缀匹配不算数：`localhost.evil.example`、`evil.example/?next=http://localhost`
/// 都不是回环地址，判断只看 authority 里的主机段。
fn loopback_http(candidate: &str) -> bool {
    // release 里恒为假：编译期关掉，运行期没有任何环境变量能把它打开
    if !cfg!(debug_assertions) {
        return false;
    }
    let Some(rest) = candidate.strip_prefix("http://") else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.contains('[') {
        return false;
    }
    // 带 userinfo 的写法（`http://someone@localhost:5173`）按 @ 之后的部分判主机
    let host_port = authority.rsplit('@').next().unwrap_or_default();
    let host = host_port.split(':').next().unwrap_or_default();
    matches!(host, "localhost" | "127.0.0.1")
}

/// 可接受的基址：https 恒可，http 只限开发构建里的回环地址
fn acceptable(candidate: &str) -> bool {
    candidate.starts_with("https://") || loopback_http(candidate)
}

/// 壳加载的站点地址：必须是 https（开发构建额外接受回环 http），否则退回默认值
pub fn site_url() -> String {
    let candidate = std::env::var("BAKA_SITE_URL")
        .ok()
        .map(|v| v.trim().trim_end_matches('/').to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| FALLBACK_SITE_URL.to_string());
    if !acceptable(&candidate) {
        eprintln!(
            "BAKA_SITE_URL 不是可用基址（只认 https；开发构建额外认回环 http），已忽略并按默认站点加载：{FALLBACK_SITE_URL}（原值 {candidate}）"
        );
        return FALLBACK_SITE_URL.to_string();
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
    if !acceptable(&candidate) {
        eprintln!(
            "BAKA_API_BASE 不是可用基址（只认 https；开发构建额外认回环 http），已忽略并按站点同源：{}",
            site_url()
        );
        return site_url();
    }
    candidate
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 回环 http 的放行完全跟着构建档位走：debug 接受，release 一律拒绝。
    /// 断言取 `cfg!(debug_assertions)` 而不是写死 `true`，这样 `cargo test --release`
    /// 会顺手把「release 不认明文地址」这条守卫也钉住，两种档位都是绿的。
    #[test]
    fn loopback_http_follows_build_profile() {
        let dev_build = cfg!(debug_assertions);
        for sample in [
            "http://localhost:5173",
            "http://127.0.0.1:5177",
            "http://localhost",
            "http://localhost:5173/some/path",
            // 带 userinfo 的写法按 @ 之后判主机：主机仍是回环，端口才是 5173
            "http://someone@localhost:5173",
        ] {
            assert_eq!(acceptable(sample), dev_build, "{sample}");
        }
    }

    /// 回环前缀不能当跳板：主机段必须逐字等于 localhost / 127.0.0.1
    #[test]
    fn rejects_lookalike_hosts() {
        assert!(!acceptable("http://localhost.evil.example"));
        assert!(!acceptable("http://127.0.0.1.evil.example"));
        assert!(!acceptable("http://evil.example/?next=http://localhost"));
        assert!(!acceptable("http://[::1]:5173"));
        assert!(!acceptable("http://192.168.1.10:5173"));
        assert!(!acceptable("ftp://localhost:5173"));
    }

    /// https 与开发构建无关，恒可
    #[test]
    fn accepts_https() {
        assert!(acceptable(DEFAULT_SITE_URL));
        assert!(acceptable("https://example.com:8443/path"));
    }

    /// 没设 `BAKA_SITE_URL` 时用的是编译期默认值：debug 取本地开发服务器，release 取站点
    #[test]
    fn fallback_matches_build_profile() {
        if cfg!(debug_assertions) {
            assert_eq!(FALLBACK_SITE_URL, "http://localhost:5173");
        } else {
            assert_eq!(FALLBACK_SITE_URL, DEFAULT_SITE_URL);
        }
    }
}
