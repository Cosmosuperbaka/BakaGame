//! 直接遍历 PEB 的 `Ldr.InLoadOrderModuleList`。
//!
//! 目的是与 `CreateToolhelp32Snapshot` 的模块枚举结果做**交叉验证**：单看任一条都能被
//! hook 骗过，两份列表比对才有意义，这也是唯一能发现「枚举 API 本身被篡改」的办法。
//! 读自身内存走 `ReadProcessMemory`（内核视角的页内容），不受用户态函数 hook 影响。
//!
//! 偏移量只对 x64 有效；非 x64 或非 Windows 返回 `None`，由调用方按「该项无法执行」处理，
//! 不伪造结论。
#![allow(dead_code)]

use std::ffi::c_void;

/// `PEB.Ldr`。x64 上 `0x10` 是 `ImageBaseAddress`，`Ldr` 在 `0x18`——
/// 写成 0x10 会把主模块基址当链表头，走出野指针后 `load_order_modules()` 直接返回 `None`，
/// 自检于是恒报 `ldr_enumeration_failed`、整机所有客户端都判 Untrusted。
const PEB_LDR: usize = 0x18;
/// `PEB_LDR_DATA.InLoadOrderModuleList`（`LIST_ENTRY`）
const LDR_IN_LOAD_ORDER_LIST: usize = 0x10;
/// `LDR_DATA_TABLE_ENTRY.InLoadOrderLinks`（`LIST_ENTRY`，本结构体首字段）
const ENTRY_LINKS: usize = 0x00;
/// `LDR_DATA_TABLE_ENTRY.DllBase`
const ENTRY_DLL_BASE: usize = 0x30;
/// `LDR_DATA_TABLE_ENTRY.FullDllName`（`UNICODE_STRING`）
const ENTRY_FULL_DLL_NAME: usize = 0x48;

/// 遍历上限：正常进程几十到一两百个模块，超出即认定链表被改坏（防止成环后死循环）
const MAX_ENTRIES: usize = 4096;

#[repr(C)]
#[derive(Clone, Copy)]
struct ListEntry {
    flink: *mut c_void,
    #[allow(dead_code)]
    blink: *mut c_void,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct UnicodeString {
    length: u16,
    maximum_length: u16,
    buffer: *const u16,
}

const _: () = assert!(
    std::mem::size_of::<ListEntry>() == 16 && std::mem::size_of::<UnicodeString>() == 16,
    "x64 的 LIST_ENTRY / UNICODE_STRING 都应是 16 字节"
);

// SAFETY: 两个结构体都只由整数与裸指针字段构成，任何位型都是合法取值
#[cfg(target_os = "windows")]
unsafe impl crate::winapi::AnyBitPattern for ListEntry {}
#[cfg(target_os = "windows")]
unsafe impl crate::winapi::AnyBitPattern for UnicodeString {}

/// 一条加载模块记录：基址用于交叉验证，路径用于白名单判定
pub struct LoadedModule {
    pub base: usize,
    pub path: String,
}

/// `PEB → Ldr → InLoadOrderModuleList` 走一遍，返回按加载顺序的模块列表。
/// `None` 表示无法执行（非 Windows、非 x64、查询失败或读内存失败）。
pub fn load_order_modules() -> Option<Vec<LoadedModule>> {
    #[cfg(target_os = "windows")]
    {
        if std::mem::size_of::<usize>() != 8 {
            return None;
        }
        use crate::winapi as w;
        let peb = peb_address()?;
        let ldr: *mut c_void = w::read_memory((peb + PEB_LDR) as *mut c_void)?;
        if ldr.is_null() {
            return None;
        }
        let head_addr = ldr as usize + LDR_IN_LOAD_ORDER_LIST;
        let head: ListEntry = w::read_memory(head_addr as *mut c_void)?;
        let mut current = head.flink;
        let mut out = Vec::new();
        let mut guard = 0usize;
        while !current.is_null() && (current as usize) != head_addr {
            guard += 1;
            if guard > MAX_ENTRIES {
                return None;
            }
            let entry_addr = current as usize - ENTRY_LINKS;
            let base: *mut c_void = w::read_memory((entry_addr + ENTRY_DLL_BASE) as *mut c_void)?;
            let name: UnicodeString =
                w::read_memory((entry_addr + ENTRY_FULL_DLL_NAME) as *mut c_void)?;
            let next: ListEntry = w::read_memory(current)?;
            out.push(LoadedModule {
                base: base as usize,
                path: read_unicode_string(&name).unwrap_or_default(),
            });
            current = next.flink;
        }
        Some(out)
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

/// 自身 PEB 地址：`NtQueryInformationProcess(ProcessBasicInformation)`
#[cfg(target_os = "windows")]
fn peb_address() -> Option<usize> {
    use crate::winapi as w;
    let query = w::nt_query_information_process()?;
    let mut info = w::PROCESS_BASIC_INFORMATION {
        exit_status: 0,
        peb_base_address: std::ptr::null_mut(),
        affinity_mask: 0,
        base_priority: 0,
        unique_process_id: 0,
        inherited_from_unique_process_id: 0,
    };
    let mut returned: w::ULONG = 0;
    let status = unsafe {
        query(
            w::GetCurrentProcess(),
            0, // ProcessBasicInformation
            (&mut info as *mut w::PROCESS_BASIC_INFORMATION).cast::<c_void>(),
            std::mem::size_of::<w::PROCESS_BASIC_INFORMATION>() as w::ULONG,
            &mut returned,
        )
    };
    if status != w::STATUS_SUCCESS || info.peb_base_address.is_null() {
        return None;
    }
    Some(info.peb_base_address as usize)
}

/// 读 `UNICODE_STRING` 指向的宽字符串（长度按字节数的一半换算）
#[cfg(target_os = "windows")]
fn read_unicode_string(value: &UnicodeString) -> Option<String> {
    use crate::winapi as w;
    let chars = (value.length as usize) / 2;
    if chars == 0 || chars > 8192 || value.buffer.is_null() {
        return None;
    }
    let mut buf = vec![0u16; chars];
    let mut read: usize = 0;
    let ok = unsafe {
        w::ReadProcessMemory(
            w::GetCurrentProcess(),
            value.buffer as *const c_void,
            buf.as_mut_ptr().cast::<c_void>(),
            chars * 2,
            &mut read,
        )
    };
    if ok != w::TRUE {
        return None;
    }
    let usable = (read / 2).min(chars);
    Some(String::from_utf16_lossy(&buf[..usable]))
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    /// 回归守卫：`PEB_LDR` 写成 `0x10`（x64 上那是 `ImageBaseAddress`）时，遍历会立刻撞上
    /// 野指针并返回 `None`，自检于是恒报 `ldr_enumeration_failed`、所有客户端一律 Untrusted，
    /// 而日志里只有「枚举失败」四个字，根本看不出是偏移量写错了。这条用例把
    /// 「能走通且内容合理」钉死：偏移错了第一句断言就炸。
    #[test]
    fn walks_own_module_list() {
        let modules = load_order_modules().expect("自身模块链表必须能遍历");
        assert!(modules.len() > 4, "模块数明显偏少：{}", modules.len());
        assert!(modules.iter().all(|m| m.base != 0), "存在基址为 0 的模块");
        let paths: Vec<String> = modules.iter().map(|m| m.path.to_ascii_lowercase()).collect();
        assert!(
            paths.iter().any(|p| p.ends_with("ntdll.dll")),
            "遍历结果里没有 ntdll.dll，偏移量或用例取值可能不对"
        );
    }
}
