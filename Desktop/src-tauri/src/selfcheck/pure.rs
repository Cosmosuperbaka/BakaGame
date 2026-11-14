//! 自检里与 Win32 无关的纯判定逻辑：路径归一化、模块白名单的前缀判定与前缀构造、
//! 两份模块基址列表的比对。
//!
//! 单独放在不带平台 `cfg` 的模块里，是为了能在任何平台、不带真实进程地直接单测这些判定；
//! 调用它们的 Win32 采样代码仍留在上一级，只负责取数据。

#![cfg_attr(not(target_os = "windows"), allow(dead_code))]

/// 白名单前缀的来源：由调用方从环境与进程信息里取出来，这里只做判定，不碰系统接口
#[derive(Default)]
pub struct PrefixSources {
    /// `SystemRoot`（取不到时的 `WINDIR`）
    pub system_root: Option<String>,
    /// 自身可执行文件所在目录
    pub self_dir: Option<String>,
    /// `ProgramFiles`、`ProgramFiles(x86)`、`ProgramW6432` 里设置了的那些值
    pub program_files: Vec<String>,
    /// `BAKA_MODULE_ALLOWLIST` 追加项的原文（分号分隔）
    pub extra_allowlist: Option<String>,
}

/// 模块路径是否落在白名单前缀之内（`prefixes` 须是 `build_prefixes` 的输出，已归一化）。
///
/// 按目录边界判，不是字符串前缀：路径要么就是前缀本身（追加项可以是单个文件），
/// 要么在前缀之后紧跟反斜杠。否则 `...\System32evil\` 这类与白名单目录只是前缀相同的
/// 兄弟目录也会被算进白名单。
pub fn path_allowed(raw_path: &str, prefixes: &[String]) -> bool {
    let path = normalize(raw_path);
    if path.is_empty() {
        return false;
    }
    prefixes.iter().any(|prefix| {
        path.strip_prefix(prefix.as_str())
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('\\'))
    })
}

/// 白名单前缀：系统目录、自身安装目录、WebView2 运行时目录，外加追加项
pub fn build_prefixes(sources: &PrefixSources) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let push = |out: &mut Vec<String>, value: Option<String>| {
        if let Some(dir) = value.map(|v| normalize(&v)) {
            if !dir.is_empty() {
                out.push(dir);
            }
        }
    };
    // 系统目录
    for leaf in ["System32", "SysWOW64", "WinSxS"] {
        push(
            &mut out,
            sources
                .system_root
                .as_ref()
                .map(|root| format!("{root}\\{leaf}")),
        );
    }
    // 自身安装目录（含同目录的 WebView2Loader.dll）
    push(&mut out, sources.self_dir.clone());
    // WebView2 运行时与 Edge（WebView2 的 dll 由运行时目录加载）
    for base in &sources.program_files {
        push(
            &mut out,
            Some(format!("{base}\\Microsoft\\EdgeWebView\\Application")),
        );
        push(
            &mut out,
            Some(format!("{base}\\Microsoft\\Edge\\Application")),
        );
        push(
            &mut out,
            Some(format!("{base}\\Common Files\\Microsoft Shared")),
        );
    }
    // 热修追加项：分号分隔的路径前缀，抬白名单不需要重新发版
    if let Some(extra) = &sources.extra_allowlist {
        for item in extra.split(';') {
            push(&mut out, Some(item.to_string()));
        }
    }
    out
}

pub fn normalize(value: &str) -> String {
    let mut out = value.trim().to_ascii_lowercase();
    // 去掉 Win32 扩展路径前缀 \\?\，否则与 `SystemRoot` 拼出来的前缀对不上
    while let Some(rest) = out.strip_prefix("\\\\?\\") {
        out = rest.to_string();
    }
    while out.ends_with('\\') {
        out.pop();
    }
    out
}

pub fn sorted_bases(iter: impl Iterator<Item = usize>) -> Vec<usize> {
    let mut v: Vec<usize> = iter.collect();
    v.sort_unstable();
    v
}

pub fn first_difference(a: &[usize], b: &[usize]) -> String {
    for (index, (left, right)) in a.iter().zip(b.iter()).enumerate() {
        if left != right {
            return format!("#{index}: {left:#x} vs {right:#x}");
        }
    }
    format!("长度不同 {} vs {}", a.len(), b.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sources() -> PrefixSources {
        PrefixSources {
            system_root: Some("C:\\Windows".to_string()),
            self_dir: Some("C:\\Users\\me\\AppData\\Local\\BakaGame".to_string()),
            program_files: vec!["C:\\Program Files (x86)".to_string()],
            extra_allowlist: None,
        }
    }

    #[test]
    fn normalize_lowercases_and_strips_extended_prefix_and_trailing_slash() {
        assert_eq!(
            normalize("  C:\\Windows\\System32\\  "),
            "c:\\windows\\system32"
        );
        assert_eq!(
            normalize("\\\\?\\C:\\Windows\\SYSTEM32"),
            "c:\\windows\\system32"
        );
        assert_eq!(normalize("\\\\?\\\\\\?\\C:\\X"), "c:\\x");
        assert_eq!(normalize(""), "");
        assert_eq!(normalize("\\\\\\"), "");
    }

    #[test]
    fn modules_inside_whitelisted_directories_are_allowed() {
        let prefixes = build_prefixes(&sources());
        for path in [
            "C:\\Windows\\System32\\kernel32.dll",
            "c:\\WINDOWS\\syswow64\\ntdll.dll",
            "\\\\?\\C:\\Windows\\WinSxS\\x86_foo\\bar.dll",
            "C:\\Users\\me\\AppData\\Local\\BakaGame\\WebView2Loader.dll",
            "C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application\\1.0\\x.dll",
            "C:\\Program Files (x86)\\Common Files\\Microsoft Shared\\y.dll",
        ] {
            assert!(path_allowed(path, &prefixes), "{path}");
        }
    }

    #[test]
    fn modules_elsewhere_or_with_empty_path_are_rejected() {
        let prefixes = build_prefixes(&sources());
        for path in [
            "",
            "   ",
            "C:\\Temp\\evil.dll",
            "D:\\Windows\\System32\\x.dll",
            "C:\\Users\\me\\Downloads\\x.dll",
        ] {
            assert!(!path_allowed(path, &prefixes), "{path}");
        }
        assert!(!path_allowed("C:\\Windows\\System32\\x.dll", &[]));
    }

    /// 白名单按目录边界判：与白名单目录只是字符串前缀相同的兄弟目录不算在内
    #[test]
    fn sibling_directories_sharing_a_prefix_are_rejected() {
        let mut with_extra = sources();
        with_extra.extra_allowlist = Some(r"D:\Tools\Lib".to_string());
        let prefixes = build_prefixes(&with_extra);
        for path in [
            r"C:\Windows\System32evil\x.dll",
            r"C:\Windows\SysWOW64-x\x.dll",
            r"C:\Windows\WinSxSx\x.dll",
            r"C:\Users\me\AppData\Local\BakaGame-x\x.dll",
            r"C:\Users\me\AppData\Local\BakaGameEvil.dll",
            r"C:\Program Files (x86)\Microsoft\EdgeWebView\Application2\x.dll",
            r"D:\Tools\Library\x.dll",
        ] {
            assert!(!path_allowed(path, &prefixes), "{path}");
        }
    }

    /// 边界判定不能把合法的嵌套路径、目录本身（追加项可以是单个文件路径）也挡掉
    #[test]
    fn directory_itself_and_nested_paths_stay_allowed() {
        let mut with_extra = sources();
        with_extra.extra_allowlist = Some(r"D:\Tools\one.dll;E:\".to_string());
        let prefixes = build_prefixes(&with_extra);
        assert!(path_allowed(r"C:\Windows\System32", &prefixes));
        assert!(path_allowed(
            r"c:\windows\system32\drivers\etc\x.dll",
            &prefixes
        ));
        assert!(path_allowed(r"D:\Tools\ONE.dll", &prefixes));
        assert!(
            path_allowed(r"E:\any\x.dll", &prefixes),
            "盘符根目录追加项应覆盖整盘"
        );
        assert!(!path_allowed(r"D:\Tools\one.dll.evil", &prefixes));
    }

    #[test]
    fn extra_allowlist_entries_are_normalized_and_blank_ones_dropped() {
        let mut with_extra = sources();
        with_extra.extra_allowlist = Some("D:\\Tools\\Lib\\ ; ;;E:\\More".to_string());
        let prefixes = build_prefixes(&with_extra);
        assert!(path_allowed("d:\\tools\\lib\\a.dll", &prefixes));
        assert!(path_allowed("E:\\More\\b.dll", &prefixes));
        assert!(!prefixes.iter().any(|prefix| prefix.is_empty()));
    }

    #[test]
    fn missing_sources_contribute_no_prefixes() {
        assert!(build_prefixes(&PrefixSources::default()).is_empty());
    }

    #[test]
    fn base_lists_compare_sorted_and_report_the_first_difference() {
        let sorted = sorted_bases([30usize, 10, 20].into_iter());
        assert_eq!(sorted, vec![10, 20, 30]);
        assert_eq!(first_difference(&[1, 2, 3], &[1, 9, 3]), "#1: 0x2 vs 0x9");
        assert_eq!(first_difference(&[1, 2], &[1, 2, 3]), "长度不同 2 vs 3");
        assert_eq!(first_difference(&[], &[]), "长度不同 0 vs 0");
    }
}
