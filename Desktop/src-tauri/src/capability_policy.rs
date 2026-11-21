//! 能力文件的最小权限守卫（只在测试里跑）。
//!
//! Tauri 的能力文件默认 `local: true`，对 `frontendDist` 里的本地页面生效。壳的本地页是打包进去的
//! 启动页，它不该拿到任何命令，所以每个能力文件都显式 `local: false`，只按 `remote.urls` 授给站点。
//! 任何一个文件多带一条 `core:*` 权限，站点页面（以及其中被注入的脚本）就多一块可调用面。
//! 页面实际只调用五条应用命令（桥接脚本的三条，加读更新状态与安装更新两条契约外命令），
//! 这里把「只许这五条」钉死，插件权限（含自动更新插件自带的命令）一条都不给，
//! 并保证只给开发服务器用的能力文件不会跟着发布构建一起编译进去。

use std::collections::BTreeSet;
use std::path::PathBuf;

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn read_json(path: &std::path::Path) -> serde_json::Value {
    let text = std::fs::read_to_string(path)
        .unwrap_or_else(|err| panic!("读不到 {}：{err}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|err| panic!("{} 不是合法 JSON：{err}", path.display()))
}

/// `build.rs` 里 `AppManifest::commands` 声明的命令名（页面能调的应用命令全集）
fn declared_commands() -> BTreeSet<String> {
    let source = include_str!("../build.rs");
    let start = source
        .find(".commands(&[")
        .expect("build.rs 应声明应用命令")
        + ".commands(&[".len();
    let end = start + source[start..].find("])").expect("命令列表应以 ]) 结束");
    source[start..end]
        .split(',')
        .map(|item| item.trim().trim_matches('"').to_string())
        .filter(|item| !item.is_empty())
        .collect()
}

/// 命令名对应的权限标识：`baka_ticket` → `allow-baka-ticket`
fn allow_permission(command: &str) -> String {
    format!("allow-{}", command.replace('_', "-"))
}

fn json_files_in(dir: &std::path::Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .unwrap_or_else(|err| panic!("读不到目录 {}：{err}", dir.display()))
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    files.sort();
    files
}

/// 发布构建会编译进去的能力文件（`capabilities/` 顶层）：权限只能是 `build.rs` 声明的五条应用命令
#[test]
fn release_capabilities_grant_only_the_bridge_commands() {
    let expected: BTreeSet<String> = declared_commands()
        .iter()
        .map(|command| allow_permission(command))
        .collect();
    assert_eq!(
        expected.len(),
        5,
        "页面可调的应用命令应是 5 条：{expected:?}"
    );

    let files = json_files_in(&manifest_dir().join("capabilities"));
    assert!(!files.is_empty(), "发布构建至少要有一个能力文件");
    let mut granted = BTreeSet::new();
    for file in &files {
        let capability = read_json(file);
        let permissions = capability["permissions"]
            .as_array()
            .unwrap_or_else(|| panic!("{} 缺少 permissions", file.display()));
        for permission in permissions {
            let permission = permission
                .as_str()
                .unwrap_or_else(|| panic!("{} 的权限应是字符串", file.display()));
            assert!(
                expected.contains(permission),
                "{} 授予了桥接命令之外的权限 {permission}",
                file.display()
            );
            granted.insert(permission.to_string());
        }
        // 只给开发服务器用的来源不能出现在发布构建的能力里
        let urls = capability["remote"]["urls"].to_string();
        assert!(
            !urls.contains("http://"),
            "{} 带了明文来源，开发用的能力应放在 capabilities/dev/",
            file.display()
        );
    }
    assert_eq!(
        granted, expected,
        "五条应用命令都应被授权，否则页面会拿到 not allowed"
    );
}

/// 开发用能力放在子目录，由 `build.rs` 只在调试构建里收进来；同样不许带 core 权限
#[test]
fn dev_capabilities_stay_in_subdirectory_without_core_permissions() {
    let top_level = json_files_in(&manifest_dir().join("capabilities"));
    for file in &top_level {
        assert!(
            !file.to_string_lossy().contains("dev-local"),
            "开发用能力不能放在发布构建会收的顶层：{}",
            file.display()
        );
    }
    let dev_dir = manifest_dir().join("capabilities").join("dev");
    for file in json_files_in(&dev_dir) {
        let capability = read_json(&file);
        for permission in capability["permissions"].as_array().unwrap() {
            let permission = permission.as_str().unwrap();
            assert!(
                !permission.starts_with("core:"),
                "{} 带了 core 权限 {permission}",
                file.display()
            );
        }
    }
}

/// 壳先打开打包在本地的启动页：任何能力文件都不许对本地来源生效（`local: false`），
/// 否则启动页（以及能把窗口导航回启动页的任何脚本）就能调用桥接与更新命令
#[test]
fn capabilities_never_apply_to_the_local_start_page() {
    let mut files = json_files_in(&manifest_dir().join("capabilities"));
    files.extend(json_files_in(
        &manifest_dir().join("capabilities").join("dev"),
    ));
    for file in &files {
        let capability = read_json(file);
        assert_eq!(
            capability["local"],
            serde_json::Value::Bool(false),
            "{} 必须显式写 local: false",
            file.display()
        );
        let urls = capability["remote"]["urls"]
            .as_array()
            .unwrap_or_else(|| panic!("{} 缺少远程来源", file.display()));
        assert!(!urls.is_empty(), "{} 的远程来源不能为空", file.display());
    }
}

/// 能力文件按 `platforms` 只在列出的系统上生效：漏了哪个桌面平台，那个平台的页面调桥接命令
/// 就一律被权限层拒（拿不到票、自检失败），壳自己却照常运行，很难从表面看出来
#[test]
fn capabilities_cover_every_desktop_platform() {
    let mut files = json_files_in(&manifest_dir().join("capabilities"));
    files.extend(json_files_in(
        &manifest_dir().join("capabilities").join("dev"),
    ));
    for file in &files {
        let capability = read_json(file);
        let platforms: BTreeSet<&str> = capability["platforms"]
            .as_array()
            .unwrap_or_else(|| panic!("{} 缺少 platforms", file.display()))
            .iter()
            .map(|value| value.as_str().unwrap_or_default())
            .collect();
        for platform in ["windows", "macOS"] {
            assert!(
                platforms.contains(platform),
                "{} 没有覆盖 {platform}，该平台的页面会拿到 not allowed",
                file.display()
            );
        }
    }
}

/// 自动更新插件的配置：公钥必须在（插件靠它校验更新包签名），任何放松传输或证书校验的开关都不许开，
/// 清单地址也不写死在配置里（运行时按 `config::api_base` 的口径拼，发布构建只认 https 站点）
#[test]
fn updater_config_keeps_every_safety_check_on() {
    use base64::Engine as _;
    let config = read_json(&manifest_dir().join("tauri.conf.json"));
    let updater = &config["plugins"]["updater"];
    let pubkey = updater["pubkey"].as_str().expect("updater 必须配置公钥");
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(pubkey)
        .expect("公钥应是 base64");
    let text = String::from_utf8(decoded).expect("公钥解码后应是文本");
    assert!(
        text.starts_with("untrusted comment: minisign public key"),
        "公钥应是 minisign 公钥：{text}"
    );
    for flag in [
        "dangerousInsecureTransportProtocol",
        "dangerousAcceptInvalidCerts",
        "dangerousAcceptInvalidHostnames",
        "allowDowngrades",
    ] {
        assert!(
            updater[flag].is_null() || updater[flag] == serde_json::Value::Bool(false),
            "updater 不许开 {flag}"
        );
    }
    assert!(
        updater["endpoints"].is_null(),
        "清单地址在运行时拼，不写进配置"
    );
    // 插件在启动时按自己的结构解析这段配置，解析失败壳直接起不来：这里用同一个类型先解析一遍
    let parsed: tauri_plugin_updater::Config =
        serde_json::from_value(updater.clone()).expect("updater 配置应能被插件解析");
    assert_eq!(parsed.pubkey, pubkey);
    assert!(!parsed.dangerous_insecure_transport_protocol);
}

/// `withGlobalTauri` 会把整套 Tauri API 挂到页面的 `window.__TAURI__` 上，桥接脚本并不需要
#[test]
fn global_tauri_api_is_not_exposed_to_pages() {
    let config = read_json(&manifest_dir().join("tauri.conf.json"));
    assert_eq!(
        config["app"]["withGlobalTauri"],
        serde_json::Value::Bool(false)
    );
}
