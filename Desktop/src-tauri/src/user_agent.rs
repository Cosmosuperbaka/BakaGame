//! 壳的 User-Agent 段（格式与 `Server/src/shared/ClientUserAgent.ts` 一致，由壳契约对账测试核对）：
//!
//! ```text
//! BakaGame/<客户端版本> (<系统名> <系统版本>; <架构>; <客户端类型>) Game/<游戏版本>
//! ```
//!
//! WebView 里追加在默认浏览器 UA 之后（空格分隔，见 `webview_ua`），壳内原生请求（注册、领挑战、
//! 换票、HTTPDNS、自动更新）只发这一段。游戏版本在启动时还不知道，先写 `unknown`，读到站点的
//! `version.json` 后再换成 `<产品版本>+<短提交号>`。
//!
//! **用于诊断与统计**：UA 是客户端自报、可以随意伪造的，不得参与任何信任或准入判定。唯一例外是伪造只坏了
//! 伪造者自己的兼容性提示：服务端按其中的 macOS 版本决定给不给自动更新。

use std::sync::{OnceLock, RwLock};

/// 拼装模板；占位符由 `render` 替换。对账测试拿它渲染样例，与共享契约的拼装结果逐字比对
pub const SEGMENT_TEMPLATE: &str =
    "BakaGame/{client} ({os} {os_version}; {arch}; {client_type}) Game/{game}";

/// 系统名取固定词表里的值，不随系统自报的名字变化
#[cfg(target_os = "macos")]
pub const OS_NAME: &str = "macOS";
#[cfg(not(target_os = "macos"))]
pub const OS_NAME: &str = "Windows";

/// 任何一截取不到时的占位
pub const UNKNOWN: &str = "unknown";

/// 网页客户端在站点根下发布的版本清单
pub const GAME_VERSION_MANIFEST_PATH: &str = "/version.json";

/// 单截取值的长度上限（去掉非法字符之后截断）
pub const TOKEN_MAX_LENGTH: usize = 32;
/// 短提交号统一成这么长，与页面 `bakagame-build` 元信息的写法一致
pub const COMMIT_LENGTH: usize = 7;

/// 一截取值收成 UA 里安全的形状：只留字母数字与 `._-`，截到上限，空了就是 `unknown`。
/// 括号、分号、空白是 UA 的分隔符，混进来会把整段切坏（三端同一规则）
pub fn token(value: &str) -> String {
    let cleaned: String = value
        .trim()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        .take(TOKEN_MAX_LENGTH)
        .collect();
    if cleaned.is_empty() {
        UNKNOWN.to_string()
    } else {
        cleaned
    }
}

/// 游戏版本那一截：恰好是 `<版本>+<提交号>` 两段且都有值才保留，否则 `unknown`
pub fn game_token(value: &str) -> String {
    let text = value.trim();
    if text.is_empty() || text == UNKNOWN {
        return UNKNOWN.to_string();
    }
    let parts: Vec<&str> = text.split('+').collect();
    if parts.len() != 2 {
        return UNKNOWN.to_string();
    }
    let (version, commit) = (token(parts[0]), token(parts[1]));
    if version == UNKNOWN || commit == UNKNOWN {
        UNKNOWN.to_string()
    } else {
        format!("{version}+{commit}")
    }
}

/// 按模板拼出一段 UA
pub fn render(client: &str, os_version: &str, arch: &str, game: &str) -> String {
    SEGMENT_TEMPLATE
        .replace("{client}", &token(client))
        .replace("{os_version}", &token(os_version))
        .replace("{os}", OS_NAME)
        .replace("{arch}", &token(arch))
        .replace("{client_type}", crate::device::CLIENT_TYPE)
        .replace("{game}", &game_token(game))
}

/// 产品版本：与共享契约 `^\d+(\.\d+){1,3}([-.][0-9A-Za-z.-]{1,32})?$` 同一规则
fn is_product_version(value: &str) -> bool {
    let bytes = value.as_bytes();
    let digits_from = |mut at: usize| {
        let begin = at;
        while at < bytes.len() && bytes[at].is_ascii_digit() {
            at += 1;
        }
        (at > begin).then_some(at)
    };
    let suffix_ok = |at: usize| {
        let rest = &bytes[at..];
        rest.is_empty()
            || (matches!(rest[0], b'-' | b'.')
                && (2..=33).contains(&rest.len())
                && rest[1..]
                    .iter()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-')))
    };
    let Some(mut at) = digits_from(0) else {
        return false;
    };
    for _ in 0..3 {
        if at >= bytes.len() || bytes[at] != b'.' {
            return false;
        }
        let Some(next) = digits_from(at + 1) else {
            return false;
        };
        at = next;
        if suffix_ok(at) {
            return true;
        }
    }
    false
}

/// 短提交号：7 到 40 位十六进制，大小写都认
fn is_short_commit(value: &str) -> bool {
    (7..=40).contains(&value.len()) && value.chars().all(|c| c.is_ascii_hexdigit())
}

/// 游戏版本：`<产品版本>+<短提交号>`，任何一项缺失或格式不对都是 `unknown`；
/// 提交号统一成 7 位小写
pub fn format_game_version(version: &str, commit: &str) -> String {
    let version = version.trim();
    let commit = commit.trim();
    if !is_product_version(version) || !is_short_commit(commit) {
        return UNKNOWN.to_string();
    }
    let short: String = commit
        .to_ascii_lowercase()
        .chars()
        .take(COMMIT_LENGTH)
        .collect();
    format!("{version}+{short}")
}

/// 读 `version.json`（字段 `version` 与 `commit`）；形状不对一律 `unknown`
pub fn game_version_from_manifest(value: &serde_json::Value) -> String {
    let field = |name: &str| value.get(name).and_then(serde_json::Value::as_str);
    match field("version") {
        Some(version) => format_game_version(version, field("commit").unwrap_or_default()),
        None => UNKNOWN.to_string(),
    }
}

/// 系统版本与架构：运行时取真实值，进程内只取一次
fn system() -> &'static (String, String) {
    static SYSTEM: OnceLock<(String, String)> = OnceLock::new();
    SYSTEM.get_or_init(|| {
        (
            platform::os_version().unwrap_or_else(|| UNKNOWN.to_string()),
            platform::arch(),
        )
    })
}

/// 当前的游戏版本；读到 `version.json` 之前是 `unknown`
static GAME_VERSION: RwLock<String> = RwLock::new(String::new());

/// 记下读到的游戏版本，之后的原生请求与 WebView 都用它
pub fn set_game_version(game: &str) {
    if let Ok(mut guard) = GAME_VERSION.write() {
        *guard = game_token(game);
    }
}

fn game_version() -> String {
    GAME_VERSION
        .read()
        .ok()
        .map(|guard| guard.clone())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| UNKNOWN.to_string())
}

/// 本壳当前的完整客户端段：原生请求的 UA 就是它，WebView 把它追加在默认 UA 之后
pub fn current() -> String {
    let (os_version, arch) = system();
    render(
        crate::config::client_version(),
        os_version,
        arch,
        &game_version(),
    )
}

#[cfg(target_os = "windows")]
mod platform {
    pub fn os_version() -> Option<String> {
        crate::winapi::os_version()
    }

    /// 机器的真实架构；查不到时退回本进程的编译目标
    pub fn arch() -> String {
        crate::winapi::native_arch()
            .unwrap_or(if cfg!(target_arch = "aarch64") {
                "arm64"
            } else if cfg!(target_arch = "x86") {
                "x86"
            } else {
                "x64"
            })
            .to_string()
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::CString;

    fn sysctl_string(name: &str) -> Option<String> {
        let name = CString::new(name).ok()?;
        let mut size: libc::size_t = 0;
        // SAFETY：第一次只取长度，第二次写进按长度分配的缓冲区
        let ok = unsafe {
            libc::sysctlbyname(
                name.as_ptr(),
                std::ptr::null_mut(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        if ok != 0 || size == 0 {
            return None;
        }
        let mut buffer = vec![0u8; size];
        let ok = unsafe {
            libc::sysctlbyname(
                name.as_ptr(),
                buffer.as_mut_ptr().cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        if ok != 0 {
            return None;
        }
        let text = String::from_utf8_lossy(&buffer[..size]);
        let text = text.trim_end_matches('\0').trim();
        (!text.is_empty()).then(|| text.to_string())
    }

    fn sysctl_i32(name: &str) -> Option<i32> {
        let name = CString::new(name).ok()?;
        let mut value: libc::c_int = 0;
        let mut size = std::mem::size_of::<libc::c_int>() as libc::size_t;
        // SAFETY：按 int 的大小读一个整数
        let ok = unsafe {
            libc::sysctlbyname(
                name.as_ptr(),
                (&mut value as *mut libc::c_int).cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        (ok == 0).then_some(value)
    }

    /// 系统版本，如 `15.1`
    pub fn os_version() -> Option<String> {
        sysctl_string("kern.osproductversion")
    }

    /// 机器的真实架构：Intel 版壳经 Rosetta 跑在 Apple 芯片上时也报 `arm64`
    pub fn arch() -> String {
        if cfg!(target_arch = "aarch64") || sysctl_i32("sysctl.proc_translated") == Some(1) {
            "arm64".to_string()
        } else {
            "x86_64".to_string()
        }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod platform {
    pub fn os_version() -> Option<String> {
        None
    }

    pub fn arch() -> String {
        std::env::consts::ARCH.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 与共享契约同一组样例：三截取值、占位与非法字符的处理逐字一致
    #[test]
    fn renders_the_contract_format() {
        let expected_os = if cfg!(target_os = "macos") {
            "macOS"
        } else {
            "Windows"
        };
        assert_eq!(
            render("0.2.1", "10.0.26100", "x64", "2.0.3+eb11009"),
            format!("BakaGame/0.2.1 ({expected_os} 10.0.26100; x64; desktop) Game/2.0.3+eb11009")
        );
        assert_eq!(
            render("0.2.1", "", "x(64); evil+1", UNKNOWN),
            format!("BakaGame/0.2.1 ({expected_os} unknown; x64evil1; desktop) Game/unknown")
        );
        assert_eq!(token(" 1.2 3 "), "1.23");
        assert_eq!(token(&"a".repeat(40)), "a".repeat(32));
    }

    #[test]
    fn game_token_keeps_exactly_version_and_commit() {
        assert_eq!(game_token("2.0.3+eb11009"), "2.0.3+eb11009");
        assert_eq!(game_token("2.0.3"), "unknown");
        assert_eq!(game_token("2.0.3+eb1+1009"), "unknown");
        assert_eq!(game_token("2.0.3+;;"), "unknown");
        assert_eq!(game_token(""), "unknown");
    }

    #[test]
    fn game_version_follows_the_contract() {
        assert_eq!(format_game_version("2.0.3", "eb11009"), "2.0.3+eb11009");
        assert_eq!(format_game_version("2.0.3", "EB11009A3F"), "2.0.3+eb11009");
        assert_eq!(
            format_game_version("2.0.3-beta.1", "eb11009"),
            "2.0.3-beta.1+eb11009"
        );
        assert_eq!(
            format_game_version("2.0.3.4.5", "eb11009"),
            "2.0.3.4.5+eb11009"
        );
        assert_eq!(format_game_version("2.0.3", "dev"), "unknown");
        assert_eq!(format_game_version("2.0.3", ""), "unknown");
        assert_eq!(format_game_version("", "eb11009"), "unknown");
        assert_eq!(format_game_version("2", "eb11009"), "unknown");
        assert_eq!(format_game_version("v2.0", "eb11009"), "unknown");
        assert_eq!(format_game_version("2.0.", "eb11009"), "unknown");
        assert_eq!(format_game_version("2.0-", "eb11009"), "unknown");
        let manifest = serde_json::json!({ "version": "2.0.3", "commit": "eb11009", "extra": 1 });
        assert_eq!(game_version_from_manifest(&manifest), "2.0.3+eb11009");
        assert_eq!(
            game_version_from_manifest(&serde_json::json!({ "version": 2 })),
            "unknown"
        );
        assert_eq!(
            game_version_from_manifest(&serde_json::json!({ "version": "2.0.3" })),
            "unknown"
        );
        assert_eq!(
            game_version_from_manifest(&serde_json::json!(null)),
            "unknown"
        );
    }

    /// 本机的系统版本与架构是运行时取到的真实值，不是空串或占位
    #[test]
    fn current_segment_carries_runtime_system_facts() {
        let segment = current();
        assert!(segment.starts_with(&format!(
            "BakaGame/{} ({OS_NAME} ",
            crate::config::client_version()
        )));
        let (os_version, arch) = system();
        if cfg!(any(target_os = "windows", target_os = "macos")) {
            assert_ne!(os_version, UNKNOWN, "应取到系统版本");
            assert!(
                os_version.contains('.'),
                "系统版本应是点分形式：{os_version}"
            );
        }
        assert!(!arch.is_empty());
        assert!(segment.contains(&format!("; {arch}; desktop) Game/")));
    }
}
