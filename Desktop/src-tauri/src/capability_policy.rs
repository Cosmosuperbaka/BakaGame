//! 能力文件的最小权限守卫（只在测试里跑）。
//!
//! Tauri 的能力文件默认 `local: true`：壳加载的站点按 `frontendDist` 算「本地来源」，
//! 所以**所有**面向 `main` 窗口的能力文件会对站点页面取并集生效，与文件里写的 `remote.urls`
//! 无关。任何一个文件多带一条 `core:*` 权限，站点页面（以及其中被注入的脚本）就多一块可调用面。
//! 页面实际只通过桥接脚本调用三条应用命令，这里把「只许这三条」钉死，
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

/// 发布构建会编译进去的能力文件（`capabilities/` 顶层）：权限只能是桥接用的三条应用命令
#[test]
fn release_capabilities_grant_only_the_bridge_commands() {
    let expected: BTreeSet<String> = declared_commands()
        .iter()
        .map(|command| allow_permission(command))
        .collect();
    assert_eq!(expected.len(), 3, "桥接命令应是 3 条：{expected:?}");

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
        "三条桥接命令都应被授权，否则页面会拿到 not allowed"
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

/// `withGlobalTauri` 会把整套 Tauri API 挂到页面的 `window.__TAURI__` 上，桥接脚本并不需要
#[test]
fn global_tauri_api_is_not_exposed_to_pages() {
    let config = read_json(&manifest_dir().join("tauri.conf.json"));
    assert_eq!(
        config["app"]["withGlobalTauri"],
        serde_json::Value::Bool(false)
    );
}
