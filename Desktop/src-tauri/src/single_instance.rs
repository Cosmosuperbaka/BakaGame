//! 单实例保护：同一登录会话里只允许一个壳进程。
//!
//! 双开会让两个进程同时首次生成并写同一份设备密钥文件、各起一套回环隧道、各跑一份自检与取票，
//! 先写入者的内存密钥与磁盘对不上。这里用具名互斥量（系统接口，不引入插件）判定：
//! 第一个进程持有互斥量，后来者发现它已存在就把已有窗口拉到前台并退出。
//!
//! 取不到互斥量（权限、系统异常）时**失败放行**：保护不可用不能拦玩家启动。

#[cfg(target_os = "windows")]
use crate::winapi as w;

/// 具名互斥量名。`Local\` 命名空间按登录会话隔离：多用户同机、远程桌面会话各自独立，互不影响。
pub const MUTEX_NAME: &str = "Local\\BakaGame.Desktop.SingleInstance";

/// 持有期间互斥量存在；进程退出或释放时系统回收
pub struct Guard {
    #[cfg(target_os = "windows")]
    handle: w::HANDLE,
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

/// 抢占名为 `name` 的互斥量
#[cfg(target_os = "windows")]
pub fn acquire(name: &str) -> Instance {
    let Some(wide_name) = w::wide(name) else {
        return Instance::First(Guard {
            handle: std::ptr::null_mut(),
        });
    };
    let handle = unsafe { w::CreateMutexW(std::ptr::null_mut(), 0, wide_name.as_ptr()) };
    if handle.is_null() {
        eprintln!("单实例互斥量创建失败，本次不做单实例保护");
        return Instance::First(Guard { handle });
    }
    // 同名互斥量已存在时 CreateMutexW 仍返回有效句柄，要靠最后的错误码区分
    if unsafe { w::GetLastError() } == w::ERROR_ALREADY_EXISTS {
        unsafe { w::CloseHandle(handle) };
        return Instance::AlreadyRunning;
    }
    Instance::First(Guard { handle })
}

#[cfg(not(target_os = "windows"))]
pub fn acquire(_name: &str) -> Instance {
    Instance::First(Guard {})
}

/// 把已经在运行的实例的主窗口拉到前台（最小化则先还原）。找不到窗口就什么都不做。
#[cfg(target_os = "windows")]
pub fn focus_existing_window(title: &str) {
    let Some(wide_title) = w::wide(title) else {
        return;
    };
    unsafe {
        let window = w::FindWindowW(std::ptr::null(), wide_title.as_ptr());
        if window.is_null() {
            return;
        }
        if w::IsIconic(window) == w::TRUE {
            w::ShowWindow(window, w::SW_RESTORE);
        }
        w::SetForegroundWindow(window);
    }
}

#[cfg(not(target_os = "windows"))]
pub fn focus_existing_window(_title: &str) {}

#[cfg(test)]
mod tests {
    use super::*;

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

    /// 找不到目标窗口时静默返回，不能崩
    #[test]
    fn focusing_a_missing_window_is_a_no_op() {
        focus_existing_window("BakaGame-window-that-does-not-exist-0xDEADBEEF");
    }
}
