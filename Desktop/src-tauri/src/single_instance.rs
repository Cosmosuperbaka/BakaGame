//! 单实例保护：同一登录会话里只允许一个壳进程。
//!
//! 双开会让两个进程同时首次生成并写同一份设备密钥文件、各起一套回环隧道、各跑一份自检与取票，
//! 先写入者的内存密钥与磁盘对不上。判定都用系统能力，不引入插件：
//! - Windows：具名互斥量。第一个进程持有它，后来者发现它已存在就把已有窗口拉到前台并退出。
//! - 其余平台（macOS）：对壳数据目录里的锁文件加独占锁（`File::try_lock`，即 `flock`）。
//!   锁随文件句柄存活，进程无论怎么退出系统都会释放，不会留下需要手工清理的陈旧锁。
//!   后来者直接退出：从访达或程序坞重复打开同一个 .app 时，系统本身会把已有实例带到前台。
//!
//! 取不到互斥量或锁（权限、系统异常、文件系统不支持加锁）时**失败放行**：保护不可用不能拦玩家启动。

use std::path::Path;
use std::time::Duration;

#[cfg(target_os = "windows")]
use crate::winapi as w;

/// 具名互斥量名。`Local\` 命名空间按登录会话隔离：多用户同机、远程桌面会话各自独立，互不影响。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub const MUTEX_NAME: &str = "Local\\BakaGame.Desktop.SingleInstance";

/// 非 Windows 平台的锁文件名，放在壳的数据目录（`device::storage_dir`）里。
/// 文件本身只是加锁的载体，内容为空、退出时不删：删文件会和正在加锁的后来者赛跑。
#[cfg_attr(target_os = "windows", allow(dead_code))]
const LOCK_FILE: &str = "instance.lock";

/// 持有期间互斥量（或锁文件上的独占锁）存在；进程退出或释放时系统回收
pub struct Guard {
    #[cfg(target_os = "windows")]
    handle: w::HANDLE,
    /// 加了独占锁的锁文件句柄：句柄关闭即释放锁
    _lock: Option<std::fs::File>,
}

impl Guard {
    /// 保护不可用而放行时的空守卫
    fn unguarded() -> Self {
        Self {
            #[cfg(target_os = "windows")]
            handle: std::ptr::null_mut(),
            _lock: None,
        }
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        #[cfg(target_os = "windows")]
        if !self.handle.is_null() {
            unsafe { w::CloseHandle(self.handle) };
        }
    }
}

pub enum Instance {
    /// 本进程是第一个（或保护不可用而放行）
    First(Guard),
    /// 已有另一个实例在运行
    AlreadyRunning,
}

/// 本平台的单实例保护：Windows 抢具名互斥量，其余平台给壳数据目录里的锁文件加独占锁
pub fn acquire_for_app() -> Instance {
    #[cfg(target_os = "windows")]
    {
        acquire(MUTEX_NAME)
    }
    #[cfg(not(target_os = "windows"))]
    {
        match crate::device::storage_dir() {
            Some(dir) => acquire_lock_file(&dir.join(LOCK_FILE)),
            None => {
                eprintln!("取不到壳的数据目录，本次不做单实例保护");
                Instance::First(Guard::unguarded())
            }
        }
    }
}

/// 抢占名为 `name` 的互斥量
#[cfg(target_os = "windows")]
pub fn acquire(name: &str) -> Instance {
    let Some(wide_name) = w::wide(name) else {
        return Instance::First(Guard::unguarded());
    };
    let handle = unsafe { w::CreateMutexW(std::ptr::null_mut(), 0, wide_name.as_ptr()) };
    if handle.is_null() {
        eprintln!("单实例互斥量创建失败，本次不做单实例保护");
        return Instance::First(Guard::unguarded());
    }
    // 同名互斥量已存在时 CreateMutexW 仍返回有效句柄，要靠最后的错误码区分
    if unsafe { w::GetLastError() } == w::ERROR_ALREADY_EXISTS {
        unsafe { w::CloseHandle(handle) };
        return Instance::AlreadyRunning;
    }
    Instance::First(Guard {
        handle,
        _lock: None,
    })
}

/// 给 `path` 这个锁文件加独占锁（不等待）。文件与上级目录不存在就建出来。
///
/// 只有「别人正持有这把锁」才判已有实例；建目录、打开文件或加锁本身出错都失败放行。
/// 用的是标准库的文件锁，在 Windows 上同样可用，所以判定逻辑能在任何平台上单测；
/// 但 Windows 的发布构建仍用具名互斥量，行为不变。
#[cfg_attr(target_os = "windows", allow(dead_code))]
fn acquire_lock_file(path: &Path) -> Instance {
    if let Some(parent) = path.parent() {
        if let Err(err) = std::fs::create_dir_all(parent) {
            eprintln!("单实例锁目录建不出来，本次不做单实例保护：{err}");
            return Instance::First(Guard::unguarded());
        }
    }
    let file = match std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
    {
        Ok(file) => file,
        Err(err) => {
            eprintln!("单实例锁文件打不开，本次不做单实例保护：{err}");
            return Instance::First(Guard::unguarded());
        }
    };
    match file.try_lock() {
        Ok(()) => Instance::First(Guard {
            #[cfg(target_os = "windows")]
            handle: std::ptr::null_mut(),
            _lock: Some(file),
        }),
        Err(std::fs::TryLockError::WouldBlock) => Instance::AlreadyRunning,
        Err(std::fs::TryLockError::Error(err)) => {
            eprintln!("单实例锁加锁失败，本次不做单实例保护：{err}");
            Instance::First(Guard::unguarded())
        }
    }
}

/// 已有实例在跑时，本进程让位前要做的事（调用方随后退出）
pub fn yield_to_existing(title: &str) {
    #[cfg(target_os = "windows")]
    {
        eprintln!("已有一个 BakaGame 桌面客户端在运行，聚焦它的窗口后退出");
        if !focus_existing_window(title) {
            eprintln!("没有找到已有实例的窗口，可能它正在启动或退出，本次直接退出");
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        // 从访达或程序坞重复打开同一个 .app 时，系统自己会把已有实例带到前台；
        // 能走到这里的是绕过启动服务直接起的第二个进程，不去替它找窗口
        let _ = title;
        eprintln!("已有一个 BakaGame 桌面客户端在运行，本次直接退出");
    }
}

/// 找已有窗口的重试节奏：第一个实例持有互斥量但窗口还没建好、或者已在收尾时，
/// 第二个实例给它一点时间再放弃。总等待约一秒半，点图标的人能接受，也不至于挂住
const FOCUS_RETRY_DELAY: Duration = Duration::from_millis(250);
const FOCUS_MAX_RETRIES: u32 = 6;

/// 第 `retries_done` 次找不到之后还要不要等、等多久；`None` 表示放弃
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn focus_retry_delay(retries_done: u32) -> Option<Duration> {
    (retries_done < FOCUS_MAX_RETRIES).then_some(FOCUS_RETRY_DELAY)
}

/// 一个顶层窗口的可观察事实
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
struct WindowFacts<'a> {
    title: &'a str,
    process_id: u32,
    /// 所属进程的可执行文件路径；读不到（权限、进程已退出）为 `None`
    exe_path: Option<&'a str>,
}

/// 路径比较口径：Windows 路径不分大小写、分隔符可混用、可能带 `\\?\` 前缀
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn normalize_path(path: &str) -> String {
    let trimmed = path.strip_prefix(r"\\?\").unwrap_or(path);
    trimmed.replace('/', "\\").to_lowercase()
}

/// 这个窗口是不是「已经在运行的本程序实例」的主窗口：标题相同**且**属于同一个可执行文件、
/// 不是本进程自己。只看标题会把资源管理器里叫同名的文件夹窗口当成目标
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn is_existing_instance_window(
    window: &WindowFacts<'_>,
    expected_title: &str,
    own_exe: &str,
    own_process_id: u32,
) -> bool {
    window.title == expected_title
        && window.process_id != own_process_id
        && window
            .exe_path
            .is_some_and(|exe| normalize_path(exe) == normalize_path(own_exe))
}

/// 枚举时带进回调的查找状态
#[cfg(target_os = "windows")]
struct Search<'a> {
    title: &'a str,
    own_exe: &'a str,
    own_process_id: u32,
    found: w::HANDLE,
}

/// 窗口所属进程的映像路径
#[cfg(target_os = "windows")]
fn process_image_path(process_id: u32) -> Option<String> {
    unsafe {
        let process = w::OpenProcess(w::PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id);
        if process.is_null() {
            return None;
        }
        let mut buf = vec![0u16; 4096];
        let mut len = buf.len() as w::DWORD;
        let ok = w::QueryFullProcessImageNameW(process, 0, buf.as_mut_ptr(), &mut len);
        w::CloseHandle(process);
        (ok == w::TRUE).then(|| w::from_wide_array(&buf[..(len as usize).min(buf.len())]))
    }
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn visit_window(window: w::HANDLE, param: isize) -> w::BOOL {
    // SAFETY: `param` 是 `find_existing_window` 传入、整个枚举期间有效的 `Search` 指针
    let search = unsafe { &mut *(param as *mut Search<'_>) };
    let mut text = [0u16; 256];
    let len = unsafe { w::GetWindowTextW(window, text.as_mut_ptr(), text.len() as i32) };
    if len <= 0 {
        return w::TRUE;
    }
    let title = String::from_utf16_lossy(&text[..len as usize]);
    if title != search.title {
        return w::TRUE;
    }
    let mut process_id: w::DWORD = 0;
    unsafe { w::GetWindowThreadProcessId(window, &mut process_id) };
    let exe = process_image_path(process_id);
    let facts = WindowFacts {
        title: &title,
        process_id,
        exe_path: exe.as_deref(),
    };
    if is_existing_instance_window(&facts, search.title, search.own_exe, search.own_process_id) {
        search.found = window;
        return 0;
    }
    w::TRUE
}

/// 枚举顶层窗口，找本程序另一个实例的主窗口
#[cfg(target_os = "windows")]
fn find_existing_window(title: &str) -> Option<w::HANDLE> {
    let own_exe = w::self_exe_path()?;
    let mut search = Search {
        title,
        own_exe: &own_exe,
        own_process_id: unsafe { w::GetCurrentProcessId() },
        found: std::ptr::null_mut(),
    };
    unsafe { w::EnumWindows(visit_window, &mut search as *mut Search<'_> as isize) };
    (!search.found.is_null()).then_some(search.found)
}

/// 把已经在运行的实例的主窗口拉到前台（最小化则先还原），返回是否找到。
/// 窗口暂时不在时按 `focus_retry_delay` 的节奏重试几次再放弃。
#[cfg(target_os = "windows")]
fn focus_existing_window(title: &str) -> bool {
    let mut retries_done = 0;
    loop {
        if let Some(window) = find_existing_window(title) {
            unsafe {
                if w::IsIconic(window) == w::TRUE {
                    w::ShowWindow(window, w::SW_RESTORE);
                }
                w::SetForegroundWindow(window);
            }
            return true;
        }
        let Some(delay) = focus_retry_delay(retries_done) else {
            return false;
        };
        std::thread::sleep(delay);
        retries_done += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    /// 锁文件：第一个拿到、第二个发现已有实例；失败的尝试不能把锁弄丢；第一个释放后又能拿到。
    /// 第二次尝试会另开一个句柄再关掉——如果底层是「关掉任一句柄就释放整个进程的锁」的
    /// POSIX 记录锁，第三次尝试就会错拿到锁，这条用例能把它拦下来
    #[test]
    fn lock_file_admits_only_the_first_holder() {
        let dir = TempDir::new("instance-lock");
        let path = dir.path().join("nested").join(LOCK_FILE);
        let first = acquire_lock_file(&path);
        assert!(matches!(first, Instance::First(_)), "第一个应当拿到");
        assert!(path.exists(), "锁文件与上级目录应当被建出来");
        assert!(
            matches!(acquire_lock_file(&path), Instance::AlreadyRunning),
            "第二个应当发现已有实例"
        );
        assert!(
            matches!(acquire_lock_file(&path), Instance::AlreadyRunning),
            "失败的尝试不能把锁弄丢"
        );
        drop(first);
        assert!(
            matches!(acquire_lock_file(&path), Instance::First(_)),
            "第一个退出后锁应当可以重新拿到"
        );
    }

    /// 锁文件打不开（这里用「路径是个目录」模拟）时失败放行：保护不可用不能拦玩家启动
    #[test]
    fn unusable_lock_path_fails_open() {
        let dir = TempDir::new("instance-lock-dir");
        assert!(matches!(acquire_lock_file(dir.path()), Instance::First(_)));
    }

    #[cfg(target_os = "windows")]
    fn unique_name(tag: &str) -> String {
        format!("Local\\BakaGame.Test.{}.{tag}", std::process::id())
    }

    /// 第一个拿到、第二个发现已有实例；第一个释放后名字又可以被占
    #[cfg(target_os = "windows")]
    #[test]
    fn second_acquire_sees_the_first_instance() {
        let name = unique_name("second");
        let first = acquire(&name);
        assert!(matches!(first, Instance::First(_)), "第一个应当拿到");
        assert!(
            matches!(acquire(&name), Instance::AlreadyRunning),
            "第二个应当发现已有实例"
        );
        assert!(
            matches!(acquire(&name), Instance::AlreadyRunning),
            "失败的尝试不能把互斥量弄丢"
        );
        drop(first);
        assert!(
            matches!(acquire(&name), Instance::First(_)),
            "第一个退出后名字应当可以重新占用"
        );
    }

    /// 不同的名字互不干扰
    #[cfg(target_os = "windows")]
    #[test]
    fn different_names_do_not_conflict() {
        let a = acquire(&unique_name("a"));
        let b = acquire(&unique_name("b"));
        assert!(matches!(a, Instance::First(_)));
        assert!(matches!(b, Instance::First(_)));
    }

    const OWN_EXE: &str = r"C:\Program Files\BakaGame\BakaGame.exe";

    fn facts<'a>(title: &'a str, process_id: u32, exe_path: Option<&'a str>) -> WindowFacts<'a> {
        WindowFacts {
            title,
            process_id,
            exe_path,
        }
    }

    /// 同标题且同一个可执行文件的另一个进程：就是要找的窗口
    #[test]
    fn same_title_and_same_exe_is_the_existing_instance() {
        let window = facts("BakaGame", 200, Some(OWN_EXE));
        assert!(is_existing_instance_window(
            &window, "BakaGame", OWN_EXE, 100
        ));
    }

    /// 资源管理器里打开一个叫 BakaGame 的文件夹，标题相同但不是本程序：不能拉到前台
    #[test]
    fn same_title_from_another_program_is_not_the_instance() {
        let explorer = facts("BakaGame", 300, Some(r"C:\Windows\explorer.exe"));
        assert!(!is_existing_instance_window(
            &explorer, "BakaGame", OWN_EXE, 100
        ));
    }

    /// 读不到所属进程路径的窗口宁可放过，也不拿标题去赌
    #[test]
    fn unknown_owner_is_not_the_instance() {
        let window = facts("BakaGame", 300, None);
        assert!(!is_existing_instance_window(
            &window, "BakaGame", OWN_EXE, 100
        ));
    }

    /// 本进程自己的窗口不算「已有实例」
    #[test]
    fn own_process_window_is_excluded() {
        let window = facts("BakaGame", 100, Some(OWN_EXE));
        assert!(!is_existing_instance_window(
            &window, "BakaGame", OWN_EXE, 100
        ));
    }

    #[test]
    fn other_titles_are_ignored() {
        let window = facts("BakaGame - 设置", 200, Some(OWN_EXE));
        assert!(!is_existing_instance_window(
            &window, "BakaGame", OWN_EXE, 100
        ));
    }

    /// 路径口径：大小写、分隔符、`\\?\` 前缀的差异不影响判定
    #[test]
    fn exe_paths_compare_loosely() {
        let loose = facts(
            "BakaGame",
            200,
            Some("c:/program files/bakagame/BAKAGAME.EXE"),
        );
        assert!(is_existing_instance_window(
            &loose, "BakaGame", OWN_EXE, 100
        ));
        let prefixed = facts(
            "BakaGame",
            200,
            Some(r"\\?\C:\Program Files\BakaGame\BakaGame.exe"),
        );
        assert!(is_existing_instance_window(
            &prefixed, "BakaGame", OWN_EXE, 100
        ));
    }

    /// 重试节奏：会等几次（给窗口留出建好的时间），总等待在一两秒内，且一定会放弃
    #[test]
    fn focus_retry_schedule_is_bounded() {
        let mut total = Duration::ZERO;
        let mut retries = 0;
        while let Some(delay) = focus_retry_delay(retries) {
            total += delay;
            retries += 1;
            assert!(retries < 100, "必须在有限次内放弃");
        }
        assert!(retries >= 2, "至少要重试几次");
        assert!(total >= Duration::from_millis(500), "总等待太短：{total:?}");
        assert!(total <= Duration::from_secs(2), "总等待太长：{total:?}");
    }

    /// 系统里确实没有这个标题的窗口时，枚举结果为空
    #[cfg(target_os = "windows")]
    #[test]
    fn enumeration_finds_nothing_for_an_unused_title() {
        assert!(find_existing_window("BakaGame-window-that-does-not-exist-0xDEADBEEF").is_none());
    }
}
