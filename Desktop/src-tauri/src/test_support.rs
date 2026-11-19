//! 单测共用的小工具：不引入 `tempfile` 依赖，用进程号加递增序号拼一个独占的临时目录。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

static COUNTER: AtomicU32 = AtomicU32::new(0);

/// 离开作用域时递归删除的临时目录
pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new(tag: &str) -> Self {
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "bakagame-desktop-test-{}-{tag}-{seq}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).expect("应能创建临时目录");
        Self(path)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
