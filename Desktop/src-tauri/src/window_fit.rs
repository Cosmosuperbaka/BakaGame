//! 窗口位置与尺寸的记忆与防溢出。
//!
//! 位置、尺寸与最大化状态由官方 `window-state` 插件记住并在建窗时恢复（只在 Rust 侧用，页面拿不到
//! 它自带的命令）。插件只在保存的矩形与某块显示器有交集时才恢复位置，但只要露出一个角就算交集，
//! 尺寸也照原样恢复：换到更小的屏幕、改了缩放比或拔掉外接屏之后，窗口仍可能大半在屏幕外、标题栏
//! 够不着。所以恢复之后再把窗口外框收进它所在显示器的工作区（扣掉任务栏）：先收尺寸、再挪位置，
//! 保证标题栏完整可见。最大化的窗口由系统摆放，不动它。

use tauri::{PhysicalPosition, PhysicalSize, Runtime, WebviewWindow};

/// 记哪些状态：位置、尺寸与最大化。可见性由壳自己控制（先隐藏、涂好背景色再显示），不交给插件。
pub fn state_flags() -> tauri_plugin_window_state::StateFlags {
    use tauri_plugin_window_state::StateFlags;
    StateFlags::POSITION | StateFlags::SIZE | StateFlags::MAXIMIZED
}

/// 屏幕上的一个矩形（物理像素）
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// 把窗口外框收进工作区：宽高不超过工作区，位置挪到整块窗口都在工作区里
pub fn fit_rect(window: Rect, area: Rect) -> Rect {
    let width = window.width.min(area.width);
    let height = window.height.min(area.height);
    let max_x = area.x.saturating_add((area.width - width) as i32);
    let max_y = area.y.saturating_add((area.height - height) as i32);
    Rect {
        x: window.x.clamp(area.x, max_x),
        y: window.y.clamp(area.y, max_y),
        width,
        height,
    }
}

/// 把已经恢复过状态的窗口收进它所在（或主）显示器的工作区。任何一步读不到都放弃，只记日志。
pub fn keep_on_screen<R: Runtime>(window: &WebviewWindow<R>) {
    if let Err(err) = try_keep_on_screen(window) {
        eprintln!("窗口防溢出未生效：{err}");
    }
}

fn try_keep_on_screen<R: Runtime>(window: &WebviewWindow<R>) -> tauri::Result<()> {
    if window.is_maximized()? {
        return Ok(());
    }
    // 窗口整块落在已拔掉的显示器上时找不到所在显示器，退回主显示器
    let Some(monitor) = window.current_monitor()?.or(window.primary_monitor()?) else {
        return Ok(());
    };
    let work = monitor.work_area();
    let area = Rect {
        x: work.position.x,
        y: work.position.y,
        width: work.size.width,
        height: work.size.height,
    };
    let position = window.outer_position()?;
    let outer = window.outer_size()?;
    let inner = window.inner_size()?;
    let current = Rect {
        x: position.x,
        y: position.y,
        width: outer.width,
        height: outer.height,
    };
    let fitted = fit_rect(current, area);
    if fitted.width != current.width || fitted.height != current.height {
        // set_size 设的是内容区：按外框缩了多少，内容区就缩多少
        window.set_size(PhysicalSize::new(
            inner.width.saturating_sub(current.width - fitted.width),
            inner.height.saturating_sub(current.height - fitted.height),
        ))?;
    }
    if fitted.x != current.x || fitted.y != current.y {
        window.set_position(PhysicalPosition::new(fitted.x, fitted.y))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const AREA: Rect = Rect {
        x: 0,
        y: 0,
        width: 1920,
        height: 1032,
    };

    fn rect(x: i32, y: i32, width: u32, height: u32) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn window_inside_the_work_area_is_left_alone() {
        let window = rect(100, 80, 1280, 800);
        assert_eq!(fit_rect(window, AREA), window);
    }

    /// 1080p 开 150% 缩放之类：保存的尺寸比工作区高，收到工作区高度并贴住顶边
    #[test]
    fn oversized_window_shrinks_to_the_work_area() {
        let fitted = fit_rect(rect(0, -20, 1920, 1200), AREA);
        assert_eq!(fitted, rect(0, 0, 1920, 1032));
    }

    /// 标题栏在屏幕上沿之外：挪下来，标题栏完整可见
    #[test]
    fn title_bar_above_the_screen_is_pulled_back() {
        assert_eq!(fit_rect(rect(200, -300, 1280, 800), AREA).y, 0);
    }

    /// 只露出一个角（插件仍会按「有交集」恢复）：整块挪回工作区
    #[test]
    fn window_hanging_off_the_corner_is_moved_back() {
        let fitted = fit_rect(rect(1800, 950, 1280, 800), AREA);
        assert_eq!(fitted, rect(640, 232, 1280, 800));
    }

    /// 落在已拔掉的副屏坐标上：退回到主显示器的工作区里
    #[test]
    fn window_on_a_removed_monitor_returns_to_the_area() {
        let fitted = fit_rect(rect(-2560, 100, 1280, 800), AREA);
        assert_eq!(fitted, rect(0, 100, 1280, 800));
    }

    /// 工作区不从原点开始（任务栏在左边或上边、副屏在主屏右侧）
    #[test]
    fn offset_work_areas_are_respected() {
        let area = rect(1920, 48, 1366, 720);
        let fitted = fit_rect(rect(1900, 0, 1280, 800), area);
        assert_eq!(fitted, rect(1920, 48, 1280, 720));
    }

    #[test]
    fn remembered_state_excludes_visibility() {
        use tauri_plugin_window_state::StateFlags;
        let flags = state_flags();
        assert!(flags.contains(StateFlags::POSITION | StateFlags::SIZE | StateFlags::MAXIMIZED));
        assert!(!flags.contains(StateFlags::VISIBLE));
        assert!(!flags.contains(StateFlags::FULLSCREEN));
        assert!(!flags.contains(StateFlags::DECORATIONS));
    }
}
