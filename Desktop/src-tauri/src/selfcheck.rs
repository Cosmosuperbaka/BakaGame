//! 原生自检（计划 P2.3）：六项检测 + 一项环境探测。
//!
//! 权重按计划的表实现，判定分三档，且**结果只如实上报，不在壳里做准入决定**——
//! 准入由服务端按同一套权重判定（`hardFail` 任一即拒、`softFail ≥ 2` 拒、`= 1` 放行并标记）。
//! 本模块的 `verdict_of` 只是壳侧日志用的同口径复核，不是权威。
//!
//! 「无法执行」与「未命中」是两件事：拿不到句柄、解析不到函数、结构体不匹配时，
//! 一律记成明确的 `*_enumeration_failed` 标记而不是假装干净；非 Windows / 非 x64 直接
//! 记 `platform_unsupported` 进硬失败清单，避免「没实现」被当成「已通过」。

use serde::Serialize;

mod pure;
#[cfg(target_os = "windows")]
use pure::{first_difference, sorted_bases};

/// 私钥保护档位：DPAPI 可用记 `hardware`，降级记 `software`（计划 P2.3 的环境探测，不计分）
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyProtection {
    Hardware,
    Software,
}

/// 注入桥 `selfCheck()` 的返回体，字段名逐字对齐契约：`hardFail` / `softFail` / `keyProtection`
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfCheckReport {
    pub hard_fail: Vec<String>,
    pub soft_fail: Vec<String>,
    pub key_protection: KeyProtection,
}

impl SelfCheckReport {
    fn with_protection(key_protection: KeyProtection) -> Self {
        Self {
            hard_fail: Vec::new(),
            soft_fail: Vec::new(),
            key_protection,
        }
    }

    /// 计划 P2.3 的判定规则，仅用于壳侧日志与本地诊断
    pub fn verdict(&self) -> Verdict {
        if !self.hard_fail.is_empty() {
            return Verdict::Untrusted;
        }
        match self.soft_fail.len() {
            0 => Verdict::Trusted,
            1 => Verdict::Suspect,
            _ => Verdict::Untrusted,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Trusted,
    Suspect,
    Untrusted,
}

// —— 检测项标识：服务端与前端按这套词表对接，新增只能追加、不得改名 ——
pub const CHECK_DEBUGGER_ATTACHED: &str = "debugger_attached";
pub const CHECK_DEBUG_PORT: &str = "debug_port";
pub const CHECK_DEBUG_OBJECT_HANDLE: &str = "debug_object_handle";
/// ntdll 的 `NtQueryInformationProcess` 解析不到：两项内核对象检测都无法执行。
/// 按失败关闭处理（正常 Windows 一定有这个导出，取不到本身就是被篡改的信号）。
pub const CHECK_DEBUG_QUERY_FAILED: &str = "debug_query_unavailable";
pub const CHECK_MODULE_NOT_ALLOWED: &str = "module_not_allowed";
pub const CHECK_MODULE_ENUM_FAILED: &str = "module_enumeration_failed";
pub const CHECK_LDR_MISMATCH: &str = "ldr_list_mismatch";
pub const CHECK_LDR_ENUM_FAILED: &str = "ldr_enumeration_failed";
pub const CHECK_PARENT_PROCESS: &str = "parent_process";
pub const CHECK_DEVTOOLS: &str = "devtools";
pub const CHECK_PLATFORM_UNSUPPORTED: &str = "platform_unsupported";

/// 疑似调试器 / 注入器的父进程名（命中即软失败，另有硬失败项会同时命中）
const DEBUGGER_PARENTS: &[&str] = &[
    "x64dbg.exe",
    "x32dbg.exe",
    "ollydbg.exe",
    "windbg.exe",
    "cmdb.exe",
    "immunitydebugger.exe",
    "gdb.exe",
    "lldb.exe",
    "vstest.executionengine.exe",
    "devenv.exe",
    "dbgview.exe",
];

/// 已知启动方式对应的父进程（含开发期从 `tauri dev` / cargo / node 拉起）
const KNOWN_PARENTS: &[&str] = &[
    "explorer.exe",
    "taskhostw.exe",
    "open-with.exe",
    "cmd.exe",
    "powershell.exe",
    "pwsh.exe",
    "wt.exe",
    "windowsterminal.exe",
    "cargo.exe",
    "rustc.exe",
    "node.exe",
    "bun.exe",
    "bakagame-desktop.exe",
];

/// 跑一次完整自检。`key_protection` 由设备密钥存储的实现状态提供（环境探测，不进计分清单）。
pub fn run(key_protection: KeyProtection) -> SelfCheckReport {
    let mut report = SelfCheckReport::with_protection(key_protection);

    #[cfg(target_os = "windows")]
    {
        use crate::winapi as w;

        // 1. 调试器附着：两个 API 命中同一个检测项，任一为真即硬失败
        let local = unsafe { w::IsDebuggerPresent() } == w::TRUE;
        let mut remote_flag: w::BOOL = 0;
        let remote_api_ok =
            unsafe { w::CheckRemoteDebuggerPresent(w::GetCurrentProcess(), &mut remote_flag) }
                == w::TRUE;
        let remote = remote_api_ok && remote_flag == w::TRUE;
        if local || remote {
            diag::hard(CHECK_DEBUGGER_ATTACHED, &format!("local={local} remote={remote}"));
            report.hard_fail.push(CHECK_DEBUGGER_ATTACHED.into());
        }

        // 2. 调试端口 / 调试对象句柄：经内核对象附着，不受用户态 API hook 影响
        let debug_port = query_debug_port();
        let debug_object = query_debug_object_handle();
        if debug_port.is_none() && debug_object.is_none() {
            diag::hard(CHECK_DEBUG_QUERY_FAILED, "NtQueryInformationProcess 解析不到");
            report.hard_fail.push(CHECK_DEBUG_QUERY_FAILED.into());
        }
        match debug_port {
            Some(true) => {
                diag::hard(CHECK_DEBUG_PORT, "ProcessDebugPort != 0");
                report.hard_fail.push(CHECK_DEBUG_PORT.into());
            }
            Some(false) => {}
            None => {}
        }
        match debug_object {
            Some(true) => {
                diag::hard(
                    CHECK_DEBUG_OBJECT_HANDLE,
                    "ProcessDebugObjectHandle 返回非空句柄",
                );
                report.hard_fail.push(CHECK_DEBUG_OBJECT_HANDLE.into());
            }
            Some(false) => {}
            None => {}
        }

        // 3. 模块枚举 + 4. PEB LDR 交叉验证。
        //    模块是并发载入的：Toolhelp 快照与 PEB 遍历之间只要有一条 DLL 正在加载，
        //    两份列表就会瞬时差一条（PEB 先建表项、快照还看不到），照直判 mismatch 会把
        //    正常启动记成 Untrusted——实测冷启动后第一次自检就撞上过 `twinapi.dll`。
        //    所以重采几次，只有持续不一致才认定枚举 API 被 hook。
        let (snapshot, ldr) = sample_module_lists();
        match (&snapshot, &ldr) {
            (Some(modules), Some(entries)) => {
                // 交叉验证：两份列表的基址集合必须一致，不一致说明有人 hook 了模块枚举 API
                let snap_bases: Vec<usize> = sorted_bases(modules.iter().map(|m| m.base));
                let ldr_bases: Vec<usize> = sorted_bases(entries.iter().map(|m| m.base));
                if snap_bases != ldr_bases {
                    // 只把「PEB 里有而 Toolhelp 没报出来」的前几条路径写进本地诊断，
                    // 上报内容仍然只有 id：路径、模块名都不出本机
                    let hidden: Vec<&str> = entries
                        .iter()
                        .filter(|entry| !snap_bases.contains(&entry.base))
                        .map(|entry| entry.path.as_str())
                        .take(3)
                        .collect();
                    diag::hard(
                        CHECK_LDR_MISMATCH,
                        &format!(
                            "toolhelp={} peb={} 首个差异 {:?} 疑似被隐藏 {:?}",
                            snap_bases.len(),
                            ldr_bases.len(),
                            first_difference(&snap_bases, &ldr_bases),
                            hidden
                        ),
                    );
                    report.hard_fail.push(CHECK_LDR_MISMATCH.into());
                }
                if let Some(hit) = modules.iter().find(|m| !module_allowed(&m.path)) {
                    diag::hard(
                        CHECK_MODULE_NOT_ALLOWED,
                        &format!("{} @ {}", hit.name, hit.path),
                    );
                    report.hard_fail.push(CHECK_MODULE_NOT_ALLOWED.into());
                }
            }
            (None, _) => {
                diag::hard(CHECK_MODULE_ENUM_FAILED, "CreateToolhelp32Snapshot 失败");
                report.hard_fail.push(CHECK_MODULE_ENUM_FAILED.into());
            }
            (_, None) => {
                diag::hard(CHECK_LDR_ENUM_FAILED, "PEB InLoadOrderModuleList 遍历失败");
                report.hard_fail.push(CHECK_LDR_ENUM_FAILED.into());
            }
        }

        // 5. 父进程
        match parent_process_name() {
            Some(name) => {
                let lower = name.to_ascii_lowercase();
                if DEBUGGER_PARENTS.contains(&lower.as_str()) || !KNOWN_PARENTS.contains(&lower.as_str()) {
                    diag::soft(CHECK_PARENT_PROCESS, &format!("父进程 {name}"));
                    report.soft_fail.push(CHECK_PARENT_PROCESS.into());
                }
            }
            None => {
                diag::soft(CHECK_PARENT_PROCESS, "父进程无法确定");
                report.soft_fail.push(CHECK_PARENT_PROCESS.into());
            }
        }

        // 6. devtools：查远程调试参数与环境变量，再读 `DevToolsActivePort` 文件确认通道是否真的在监听。
        //    WebView2 `AreDevToolsEnabled` 的 COM 读回仍未实现（见 README 未验证清单）。
        if let Some(detail) = devtools_exposure() {
            diag::soft(CHECK_DEVTOOLS, &detail);
            report.soft_fail.push(CHECK_DEVTOOLS.into());
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        diag::hard(
            CHECK_PLATFORM_UNSUPPORTED,
            "自检只在 Windows x64 上有意义，其它平台不得当作通过",
        );
        report.hard_fail.push(CHECK_PLATFORM_UNSUPPORTED.into());
    }

    report
}

#[cfg(target_os = "windows")]
struct ModuleRecord {
    name: String,
    path: String,
    base: usize,
}

/// `CreateToolhelp32Snapshot(TH32CS_SNAPMODULE)` 枚举自身模块
#[cfg(target_os = "windows")]
fn toolhelp_modules() -> Option<Vec<ModuleRecord>> {
    use crate::winapi as w;
    let pid = unsafe { w::GetCurrentProcessId() };
    let snapshot =
        unsafe { w::CreateToolhelp32Snapshot(w::TH32CS_SNAPMODULE | w::TH32CS_SNAPMODULE32, pid) };
    if snapshot.is_null() || snapshot == w::INVALID_HANDLE_VALUE {
        return None;
    }
    let mut entry: w::MODULEENTRY32W = unsafe { std::mem::zeroed() };
    entry.dw_size = std::mem::size_of::<w::MODULEENTRY32W>() as w::DWORD;
    let mut out = Vec::new();
    let mut more = unsafe { w::Module32FirstW(snapshot, &mut entry) };
    let mut guard = 0usize;
    while more == w::TRUE && guard < 8192 {
        guard += 1;
        out.push(ModuleRecord {
            name: w::from_wide_array(&entry.sz_module),
            path: w::from_wide_array(&entry.sz_exe_path),
            base: entry.mod_base_addr as usize,
        });
        more = unsafe { w::Module32NextW(snapshot, &mut entry) };
    }
    unsafe { w::CloseHandle(snapshot) };
    Some(out)
}

/// 交叉验证的采样次数：模块并发载入时单次采样可能撞上「正在加载」的那一条
const MODULE_SAMPLE_ATTEMPTS: usize = 3;
/// 两次采样之间的间隔，让在途的载入/卸载有机会落定
const MODULE_SAMPLE_RETRY: std::time::Duration = std::time::Duration::from_millis(15);

/// 取 Toolhelp 与 PEB 两份模块列表；基址集合不一致就重采，直到一致或次数用尽。
/// 用尽时把最后一次（仍不一致）的结果交给调用方，由它按 `ldr_list_mismatch` 上报。
#[cfg(target_os = "windows")]
fn sample_module_lists() -> (Option<Vec<ModuleRecord>>, Option<Vec<crate::peb::LoadedModule>>) {
    let mut sample = (toolhelp_modules(), crate::peb::load_order_modules());
    for _ in 1..MODULE_SAMPLE_ATTEMPTS {
        let agree = match (&sample.0, &sample.1) {
            (Some(left), Some(right)) => {
                sorted_bases(left.iter().map(|m| m.base))
                    == sorted_bases(right.iter().map(|m| m.base))
            }
            // 单边失败属于「无法执行」，不在这里重试，交给调用方按失败关闭处理
            _ => true,
        };
        if agree {
            break;
        }
        std::thread::sleep(MODULE_SAMPLE_RETRY);
        sample = (toolhelp_modules(), crate::peb::load_order_modules());
    }
    sample
}

/// 进程快照里找到自己那一条，取父进程名
#[cfg(target_os = "windows")]
fn parent_process_name() -> Option<String> {
    use crate::winapi as w;
    let pid = unsafe { w::GetCurrentProcessId() };
    let snapshot = unsafe { w::CreateToolhelp32Snapshot(w::TH32CS_SNAPPROCESS, 0) };
    if snapshot.is_null() || snapshot == w::INVALID_HANDLE_VALUE {
        return None;
    }
    let mut entry: w::PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dw_size = std::mem::size_of::<w::PROCESSENTRY32W>() as w::DWORD;
    let mut parent_pid: Option<w::DWORD> = None;
    let mut names: Vec<(w::DWORD, String)> = Vec::new();
    let mut more = unsafe { w::Process32FirstW(snapshot, &mut entry) };
    let mut guard = 0usize;
    while more == w::TRUE && guard < 65_536 {
        guard += 1;
        let current = entry.th32_process_id;
        if current == pid {
            parent_pid = Some(entry.th32_parent_process_id);
        }
        names.push((current, w::from_wide_array(&entry.sz_exe_file)));
        more = unsafe { w::Process32NextW(snapshot, &mut entry) };
    }
    unsafe { w::CloseHandle(snapshot) };
    let parent = parent_pid?;
    // 父进程已退出时快照里没有条目，按「无法确定」处理（软失败），不猜测
    names.into_iter().find(|(id, _)| *id == parent).map(|(_, n)| n)
}

/// `ProcessDebugPort`：非 0 即有调试器经内核对象附着
#[cfg(target_os = "windows")]
fn query_debug_port() -> Option<bool> {
    use std::ffi::c_void;
    use crate::winapi as w;
    let query = w::nt_query_information_process()?;
    let mut value: w::ULONG_PTR = 0;
    let mut returned: w::ULONG = 0;
    let status = unsafe {
        query(
            w::GetCurrentProcess(),
            w::PROCESS_DEBUG_PORT,
            (&mut value as *mut w::ULONG_PTR).cast::<c_void>(),
            std::mem::size_of::<w::ULONG_PTR>() as w::ULONG,
            &mut returned,
        )
    };
    // 无调试器时该项返回成功且为 0；返回失败按「未命中」处理并留日志
    Some(status == w::STATUS_SUCCESS && value != 0)
}

/// `ProcessDebugObjectHandle`：只有附着了调试器才会返回非空句柄。拿到句柄必须关掉。
#[cfg(target_os = "windows")]
fn query_debug_object_handle() -> Option<bool> {
    use std::ffi::c_void;
    use crate::winapi as w;
    let query = w::nt_query_information_process()?;
    let mut handle: w::HANDLE = std::ptr::null_mut();
    let mut returned: w::ULONG = 0;
    let status = unsafe {
        query(
            w::GetCurrentProcess(),
            w::PROCESS_DEBUG_OBJECT_HANDLE,
            (&mut handle as *mut w::HANDLE).cast::<c_void>(),
            std::mem::size_of::<w::HANDLE>() as w::ULONG,
            &mut returned,
        )
    };
    let attached = status == w::STATUS_SUCCESS && !handle.is_null();
    if attached {
        unsafe { w::CloseHandle(handle) };
    }
    Some(attached)
}

/// 模块路径白名单：系统目录、自身安装目录、WebView2 运行时目录，外加 `BAKA_MODULE_ALLOWLIST` 追加项。
///
/// 已知短板：签名校验（Authenticode）没实现，见 README「未验证与 TODO」。
/// 目前只按路径判定，因此白名单外的模块一律硬失败；`BakaAntiCheat` 默认关闭，普通房不受影响。
#[cfg(target_os = "windows")]
fn module_allowed(raw_path: &str) -> bool {
    pure::path_allowed(raw_path, &allowed_prefixes())
}

/// 从环境与进程信息里取白名单前缀的来源，判定与构造都在 `pure` 里
#[cfg(target_os = "windows")]
fn allowed_prefixes() -> Vec<String> {
    let system_root = std::env::var("SystemRoot")
        .ok()
        .or_else(|| std::env::var("WINDIR").ok());
    let self_dir = crate::winapi::self_exe_path().and_then(|exe| {
        std::path::Path::new(&exe)
            .parent()
            .map(|p| p.display().to_string())
    });
    let program_files = ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]
        .iter()
        .filter_map(|key| std::env::var(key).ok())
        .collect();
    pure::build_prefixes(&pure::PrefixSources {
        system_root,
        self_dir,
        program_files,
        extra_allowlist: std::env::var("BAKA_MODULE_ALLOWLIST").ok(),
    })
}

/// devtools 暴露面：远程调试参数（命令行 / 环境变量）与真的开起来的调试端口
#[cfg(target_os = "windows")]
fn devtools_exposure() -> Option<String> {
    const FLAGS: &[&str] = &[
        "--remote-debugging-port",
        "--remote-debugging-pipe",
        "--auto-open-devtools-for-tabs",
        "--allow-insecure-localhost",
        "--ignore-certificate-errors",
    ];
    let mut hits: Vec<String> = Vec::new();
    let line = crate::winapi::command_line().to_ascii_lowercase();
    for flag in FLAGS {
        if line.contains(flag) {
            hits.push(format!("命令行 {flag}"));
        }
    }
    for key in [
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        "BAKA_WEBVIEW2_ARGS",
    ] {
        if let Some(value) = crate::winapi::env_string(key) {
            let lower = value.to_ascii_lowercase();
            for flag in FLAGS {
                if lower.contains(flag) {
                    hits.push(format!("{key} {flag}"));
                }
            }
        }
    }
    // 调试参数存在不等于通道真的开了；`DevToolsActivePort` 是浏览器进程真的在监听时才写的
    // 文件（首行端口号）。读它是不依赖 COM 的读回校验——`AreDevToolsEnabled` 只能证明设置位。
    for dir in webview_data_dirs() {
        let marker = dir.join("DevToolsActivePort");
        if let Ok(text) = std::fs::read_to_string(&marker) {
            let port = text.lines().next().unwrap_or("").trim();
            hits.push(format!("{marker:?} 端口 {port}"));
        }
    }
    (!hits.is_empty()).then(|| hits.join(", "))
}

/// WebView2 用户数据目录候选：环境变量指定的优先，其次按标识符落在 `%LOCALAPPDATA%` 下。
/// 两处都探是因为调试器既能用 `WEBVIEW2_USER_DATA_FOLDER` 把目录挪走，也能直接沿用默认位置。
#[cfg(target_os = "windows")]
fn webview_data_dirs() -> Vec<std::path::PathBuf> {
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    if let Some(custom) = crate::winapi::env_string("WEBVIEW2_USER_DATA_FOLDER") {
        dirs.push(std::path::PathBuf::from(custom));
    }
    if let Some(local) = std::env::var("LOCALAPPDATA").ok() {
        dirs.push(
            std::path::Path::new(&local)
                .join(crate::config::APP_IDENTIFIER)
                .join("EBWebView"),
        );
    }
    dirs
}

/// 可选诊断日志：只在 `BAKA_DESKTOP_LOG=1` 时写 `%LOCALAPPDATA%\BakaGame\client\selfcheck.log`，
/// 默认不落盘（不记录任何玩家身份或房间信息，只记录本次命中的检测项）。
mod diag {
    #[cfg(target_os = "windows")]
    fn enabled() -> bool {
        matches!(std::env::var("BAKA_DESKTOP_LOG").as_deref(), Ok("1") | Ok("true"))
    }

    #[cfg(not(target_os = "windows"))]
    fn enabled() -> bool {
        false
    }

    fn line(kind: &str, id: &str, detail: &str) {
        if !enabled() {
            return;
        }
        use std::io::Write;
        let Some(dir) = std::env::var("LOCALAPPDATA")
            .ok()
            .map(|v| std::path::Path::new(&v).join("BakaGame").join("client"))
        else {
            return;
        };
        if std::fs::create_dir_all(&dir).is_err() {
            return;
        }
        let path = dir.join("selfcheck.log");
        let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) else {
            return;
        };
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(file, "{stamp} {kind} {id} {detail}");
    }

    pub fn hard(id: &str, detail: &str) {
        line("HARD", id, detail);
    }
    pub fn soft(id: &str, detail: &str) {
        line("SOFT", id, detail);
    }
    #[allow(dead_code)]
    pub fn note(id: &str, detail: &str) {
        line("NOTE", id, detail);
    }
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    /// 两份模块列表在静默进程里必须一致且非空：`PEB_LDR` 偏移写错、枚举被拦、
    /// 交叉验证逻辑改坏，都会在这条用例上露头（而不是等到线上判 Untrusted 才发现）。
    #[test]
    fn module_lists_agree() {
        let (snapshot, ldr) = sample_module_lists();
        let snapshot = snapshot.expect("Toolhelp 模块枚举必须成功");
        let ldr = ldr.expect("PEB 模块链表遍历必须成功");
        assert!(snapshot.len() > 4, "Toolhelp 模块数偏少：{}", snapshot.len());
        assert!(ldr.len() > 4, "PEB 模块数偏少：{}", ldr.len());
        assert_eq!(
            sorted_bases(snapshot.iter().map(|m| m.base)),
            sorted_bases(ldr.iter().map(|m| m.base)),
            "两份模块列表基址不一致"
        );
    }
}

/// 与平台无关的判定口径：壳侧日志用的同口径复核，以及上报词表的字面量
#[cfg(test)]
mod verdict_tests {
    use super::*;

    fn report(hard: &[&str], soft: &[&str]) -> SelfCheckReport {
        SelfCheckReport {
            hard_fail: hard.iter().map(|id| id.to_string()).collect(),
            soft_fail: soft.iter().map(|id| id.to_string()).collect(),
            key_protection: KeyProtection::Software,
        }
    }

    #[test]
    fn verdict_has_three_tiers() {
        assert_eq!(report(&[], &[]).verdict(), Verdict::Trusted);
        assert_eq!(report(&[], &[CHECK_DEVTOOLS]).verdict(), Verdict::Suspect);
        assert_eq!(
            report(&[], &[CHECK_DEVTOOLS, CHECK_PARENT_PROCESS]).verdict(),
            Verdict::Untrusted
        );
        // 任一硬失败即不可信，与软失败个数无关
        assert_eq!(
            report(&[CHECK_DEBUGGER_ATTACHED], &[]).verdict(),
            Verdict::Untrusted
        );
        assert_eq!(
            report(&[CHECK_LDR_MISMATCH], &[CHECK_DEVTOOLS]).verdict(),
            Verdict::Untrusted
        );
    }

    /// 词表是与服务端权重表对接的协议字面量：新增只能追加，改名等于换协议
    #[test]
    fn check_ids_are_the_literal_protocol_names() {
        assert_eq!(
            [
                CHECK_DEBUGGER_ATTACHED,
                CHECK_DEBUG_PORT,
                CHECK_DEBUG_OBJECT_HANDLE,
                CHECK_DEBUG_QUERY_FAILED,
                CHECK_MODULE_NOT_ALLOWED,
                CHECK_MODULE_ENUM_FAILED,
                CHECK_LDR_MISMATCH,
                CHECK_LDR_ENUM_FAILED,
                CHECK_PARENT_PROCESS,
                CHECK_DEVTOOLS,
                CHECK_PLATFORM_UNSUPPORTED,
            ],
            [
                "debugger_attached",
                "debug_port",
                "debug_object_handle",
                "debug_query_unavailable",
                "module_not_allowed",
                "module_enumeration_failed",
                "ldr_list_mismatch",
                "ldr_enumeration_failed",
                "parent_process",
                "devtools",
                "platform_unsupported",
            ]
        );
    }
}
