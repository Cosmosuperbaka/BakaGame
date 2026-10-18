//! 手写的最小 Win32 绑定层。
//!
//! 为什么不直接用 `windows` crate：本壳只需要十几个**导出表里长期稳定**的 kernel32 /
//! crypt32 函数与几个结构体布局，用 `extern "system"` 声明可以把不确定性压到最小
//! （`windows` crate 的 feature 名与模块路径会随版本调整，本机没有工具链无法验证）。
//! 这里**不声明任何猜测出来的 API**：每一条都是 Windows 文档里明确导出的函数。
//!
//! `NtQueryInformationProcess` 属于 ntdll 的未公开导出，不保证跨版本稳定，因此不静态链接，
//! 而是运行期用 `GetModuleHandleW` + `GetProcAddress` 动态解析；解析不到就返回 `None`，
//! 由调用方按「该项无法执行」处理，不伪造结论。
#![allow(non_snake_case, non_camel_case_types, dead_code)]

use std::ffi::{c_char, c_int, c_void};
use std::mem::MaybeUninit;

pub type HANDLE = *mut c_void;
pub type HMODULE = *mut c_void;
pub type BOOL = c_int;
pub type DWORD = u32;
pub type LONG = i32;
pub type ULONG = u32;
pub type ULONG_PTR = usize;
pub type NTSTATUS = i32;
pub type LPCWSTR = *const u16;
pub type LPWSTR = *mut u16;
pub type LPCSTR = *const c_char;

pub const TRUE: BOOL = 1;

/// `CreateToolhelp32Snapshot` 失败时返回的伪句柄
pub const INVALID_HANDLE_VALUE: HANDLE = -1isize as HANDLE;

/// `CreateToolhelp32Snapshot` 标志位
pub const TH32CS_SNAPPROCESS: DWORD = 0x0000_0002;
pub const TH32CS_SNAPMODULE: DWORD = 0x0000_0008;
pub const TH32CS_SNAPMODULE32: DWORD = 0x2000_0000;

/// DPAPI：绝不允许弹 UI（壳不能拦玩家）
pub const CRYPTPROTECT_UI_FORBIDDEN: DWORD = 0x01;

/// `PROCESSINFOCLASS` 中本壳用到的两项（取值见公开文档）
pub const PROCESS_DEBUG_PORT: ULONG = 7;
pub const PROCESS_DEBUG_OBJECT_HANDLE: ULONG = 30;

pub const STATUS_SUCCESS: NTSTATUS = 0;

#[repr(C)]
pub struct DATA_BLOB {
    pub cb_data: DWORD,
    pub pb_data: *mut u8,
}

#[repr(C)]
pub struct MODULEENTRY32W {
    pub dw_size: DWORD,
    pub th32_module_id: DWORD,
    pub th32_process_id: DWORD,
    pub glblcnt_usage: DWORD,
    pub proccnt_usage: DWORD,
    pub mod_base_addr: *mut c_void,
    pub mod_base_size: DWORD,
    pub h_module: HMODULE,
    pub sz_module: [u16; 256],
    pub sz_exe_path: [u16; 260],
}

#[repr(C)]
pub struct PROCESSENTRY32W {
    pub dw_size: DWORD,
    pub cnt_usage: DWORD,
    pub th32_process_id: DWORD,
    pub th32_default_heap_id: ULONG_PTR,
    pub th32_module_id: DWORD,
    pub cnt_threads: DWORD,
    pub th32_parent_process_id: DWORD,
    pub pc_pri_class_base: LONG,
    pub dw_flags: DWORD,
    pub sz_exe_file: [u16; 260],
}

/// `PROCESS_BASIC_INFORMATION`（x64 布局：4 + 补 4 + 8 + 8 + 4 + 补 4 + 8 + 8 = 48 字节）
#[repr(C)]
pub struct PROCESS_BASIC_INFORMATION {
    pub exit_status: NTSTATUS,
    pub peb_base_address: *mut c_void,
    pub affinity_mask: ULONG_PTR,
    pub base_priority: LONG,
    pub unique_process_id: ULONG_PTR,
    pub inherited_from_unique_process_id: ULONG_PTR,
}

const _: () = assert!(
    std::mem::size_of::<PROCESS_BASIC_INFORMATION>() == 48,
    "PROCESS_BASIC_INFORMATION 只按 x64 布局实现"
);

#[link(name = "kernel32")]
extern "system" {
    pub fn GetLastError() -> DWORD;
    pub fn CloseHandle(handle: HANDLE) -> BOOL;
    pub fn GetCurrentProcess() -> HANDLE;
    pub fn GetCurrentProcessId() -> DWORD;
    pub fn IsDebuggerPresent() -> BOOL;
    pub fn CheckRemoteDebuggerPresent(process: HANDLE, debugger_present: *mut BOOL) -> BOOL;
    pub fn CreateToolhelp32Snapshot(flags: DWORD, process_id: DWORD) -> HANDLE;
    pub fn Module32FirstW(snapshot: HANDLE, entry: *mut MODULEENTRY32W) -> BOOL;
    pub fn Module32NextW(snapshot: HANDLE, entry: *mut MODULEENTRY32W) -> BOOL;
    pub fn Process32FirstW(snapshot: HANDLE, entry: *mut PROCESSENTRY32W) -> BOOL;
    pub fn Process32NextW(snapshot: HANDLE, entry: *mut PROCESSENTRY32W) -> BOOL;
    pub fn ReadProcessMemory(
        process: HANDLE,
        base_address: *const c_void,
        buffer: *mut c_void,
        size: usize,
        bytes_read: *mut usize,
    ) -> BOOL;
    pub fn GetModuleFileNameW(module: HMODULE, buffer: LPWSTR, size: DWORD) -> DWORD;
    pub fn GetModuleHandleW(name: LPCWSTR) -> HMODULE;
    pub fn GetProcAddress(module: HMODULE, name: LPCSTR) -> *mut c_void;
    pub fn GetEnvironmentVariableW(name: LPCWSTR, buffer: LPWSTR, size: DWORD) -> DWORD;
    pub fn GetCommandLineW() -> LPWSTR;
    pub fn LocalFree(memory: *mut c_void) -> *mut c_void;
}

#[link(name = "crypt32")]
extern "system" {
    pub fn CryptProtectData(
        data_in: *const DATA_BLOB,
        data_descr: LPCWSTR,
        optional_entropy: *const DATA_BLOB,
        reserved: *mut c_void,
        prompt_struct: *mut c_void,
        flags: DWORD,
        data_out: *mut DATA_BLOB,
    ) -> BOOL;
    pub fn CryptUnprotectData(
        data_in: *const DATA_BLOB,
        data_descr: *mut LPWSTR,
        optional_entropy: *const DATA_BLOB,
        reserved: *mut c_void,
        prompt_struct: *mut c_void,
        flags: DWORD,
        data_out: *mut DATA_BLOB,
    ) -> BOOL;
}

/// `NtQueryInformationProcess` 的函数指针类型
pub type NtQueryInformationProcessFn = unsafe extern "system" fn(
    process_handle: HANDLE,
    process_information_class: ULONG,
    process_information: *mut c_void,
    process_information_length: ULONG,
    return_length: *mut ULONG,
) -> NTSTATUS;

const _: () = assert!(
    std::mem::size_of::<*mut c_void>() == std::mem::size_of::<NtQueryInformationProcessFn>(),
    "GetProcAddress 返回值必须与函数指针同宽才能转换"
);

/// 运行期解析 ntdll 的 `NtQueryInformationProcess`；拿不到返回 `None`。
pub fn nt_query_information_process() -> Option<NtQueryInformationProcessFn> {
    let name = wide("ntdll.dll")?;
    let ntdll = unsafe { GetModuleHandleW(name.as_ptr()) };
    if ntdll.is_null() {
        return None;
    }
    let raw = unsafe { GetProcAddress(ntdll, b"NtQueryInformationProcess\0".as_ptr() as LPCSTR) };
    if raw.is_null() {
        return None;
    }
    // 已确认非空，且有上面的同宽断言
    Some(unsafe { std::mem::transmute::<*mut c_void, NtQueryInformationProcessFn>(raw) })
}

/// 带结尾 0 的 UTF-16 缓冲区；含内部 0 的输入直接拒绝，避免截断语义
pub fn wide(value: &str) -> Option<Vec<u16>> {
    let mut buf: Vec<u16> = value.encode_utf16().collect();
    if buf.contains(&0) {
        return None;
    }
    buf.push(0);
    Some(buf)
}

/// 读 `WCHAR[]` 固定数组到第一个 0
pub fn from_wide_array(raw: &[u16]) -> String {
    let end = raw.iter().position(|c| *c == 0).unwrap_or(raw.len());
    String::from_utf16_lossy(&raw[..end])
}

/// 环境变量；未设置或为空返回 `None`
pub fn env_string(name: &str) -> Option<String> {
    let key = wide(name)?;
    let need = unsafe { GetEnvironmentVariableW(key.as_ptr(), std::ptr::null_mut(), 0) };
    if need == 0 {
        return None;
    }
    let mut buf = vec![0u16; need as usize + 1];
    let got = unsafe { GetEnvironmentVariableW(key.as_ptr(), buf.as_mut_ptr(), need + 1) };
    if got == 0 || got >= need + 1 {
        return None;
    }
    let value = from_wide_array(&buf[..got as usize]);
    (!value.is_empty()).then_some(value)
}

/// 自身可执行文件的完整路径
pub fn self_exe_path() -> Option<String> {
    let mut buf = vec![0u16; 4096];
    let len = unsafe { GetModuleFileNameW(std::ptr::null_mut(), buf.as_mut_ptr(), buf.len() as DWORD) };
    if len == 0 || len as usize >= buf.len() {
        return None;
    }
    Some(from_wide_array(&buf[..len as usize]))
}

/// 当前进程的命令行原文
pub fn command_line() -> String {
    let ptr = unsafe { GetCommandLineW() };
    if ptr.is_null() {
        return String::new();
    }
    let mut len = 0usize;
    while len < 32_768 && unsafe { *ptr.add(len) } != 0 {
        len += 1;
    }
    String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(ptr, len) })
}

/// 经 `ReadProcessMemory` 读自身内存（读回的是内核视角的页内容，与被 hook 的用户态
/// 函数无关，这正是与 Toolhelp 枚举做交叉验证的意义）
pub fn read_memory<T: Copy>(base: *mut c_void) -> Option<T> {
    if base.is_null() {
        return None;
    }
    let mut out: MaybeUninit<T> = MaybeUninit::zeroed();
    let mut read = 0usize;
    let ok = unsafe {
        ReadProcessMemory(
            GetCurrentProcess(),
            base,
            (&mut out as *mut MaybeUninit<T>).cast::<c_void>(),
            std::mem::size_of::<T>(),
            &mut read,
        )
    };
    if ok == TRUE && read == std::mem::size_of::<T>() {
        Some(unsafe { out.assume_init() })
    } else {
        None
    }
}

fn blob(bytes: &[u8]) -> Option<DATA_BLOB> {
    // 空输入必须交出真正的零长度块，不能给 API 传空切片的悬垂指针
    if bytes.is_empty() {
        return Some(NULL_BLOB);
    }
    Some(DATA_BLOB {
        cb_data: bytes.len() as DWORD,
        pb_data: bytes.as_ptr() as *mut u8,
    })
}

fn take_owned(out: DATA_BLOB) -> Vec<u8> {
    let copied =
        unsafe { std::slice::from_raw_parts(out.pb_data, out.cb_data as usize).to_vec() };
    unsafe { LocalFree(out.pb_data as *mut c_void) };
    copied
}

/// DPAPI（当前用户范围）加密。返回 `None` 表示 DPAPI 不可用，调用方降级为软件保护。
pub fn dpapi_protect(data: &[u8], entropy: &[u8]) -> Option<Vec<u8>> {
    if data.is_empty() {
        return None;
    }
    let descr = wide("BakaGame device key")?;
    let in_blob = blob(data)?;
    let ent = blob(entropy);
    let mut out = DATA_BLOB {
        cb_data: 0,
        pb_data: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptProtectData(
            &in_blob,
            descr.as_ptr(),
            ent.as_ref().unwrap_or(&NULL_BLOB),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out,
        )
    };
    if ok != TRUE || out.pb_data.is_null() {
        return None;
    }
    Some(take_owned(out))
}

/// DPAPI 解密。失败即密文不属于当前用户或 DPAPI 不可用。
pub fn dpapi_unprotect(data: &[u8], entropy: &[u8]) -> Option<Vec<u8>> {
    if data.is_empty() {
        return None;
    }
    let in_blob = blob(data)?;
    let ent = blob(entropy);
    let mut out = DATA_BLOB {
        cb_data: 0,
        pb_data: std::ptr::null_mut(),
    };
    let mut descr: LPWSTR = std::ptr::null_mut();
    let ok = unsafe {
        CryptUnprotectData(
            &in_blob,
            &mut descr,
            ent.as_ref().unwrap_or(&NULL_BLOB),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out,
        )
    };
    if ok != TRUE || out.pb_data.is_null() {
        return None;
    }
    Some(take_owned(out))
}

/// 「不传可选熵」时使用的零长度块（避免把空切片的悬垂指针交给 API）
const NULL_BLOB: DATA_BLOB = DATA_BLOB {
    cb_data: 0,
    pb_data: std::ptr::null_mut(),
};
