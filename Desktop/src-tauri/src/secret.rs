//! 私钥种子这类明文敏感字节的清零工具。
//!
//! 为什么不直接用 `zeroize`：它只是 ed25519-dalek 的传递依赖，直接使用要在清单里新增声明；
//! 这里要的只是「用完就写零，并且别被优化器当成死存储删掉」，几行代码够了。

use std::ops::Deref;
use std::sync::atomic::{compiler_fence, Ordering};

/// 把缓冲区逐字节写零。用 volatile 写加编译器栅栏，防止优化器因为之后不再读取而删掉这些写入。
pub fn wipe(buf: &mut [u8]) {
    for byte in buf.iter_mut() {
        // SAFETY: `byte` 来自独占借用的切片，指针对齐且有效
        unsafe { std::ptr::write_volatile(byte, 0) };
    }
    compiler_fence(Ordering::SeqCst);
}

/// 持有明文敏感字节，离开作用域时清零。读取走 `Deref`，不提供取出内部 `Vec` 的方法，
/// 免得明文被移交给没人负责清零的变量。
pub struct Secret(Vec<u8>);

impl Secret {
    pub fn new(bytes: Vec<u8>) -> Self {
        Self(bytes)
    }
}

impl Deref for Secret {
    type Target = [u8];

    fn deref(&self) -> &[u8] {
        &self.0
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        wipe(&mut self.0);
        // 释放后的堆内存不能再读，只能在 Drop 里、清零之后留一份副本供测试核对
        #[cfg(test)]
        observe::record(&self.0);
    }
}

/// 仅测试可见的观察点：记录本线程最近一次 `Secret` 在 Drop 里清零之后的缓冲内容
#[cfg(test)]
mod observe {
    use std::cell::RefCell;

    thread_local! {
        static LAST_DROPPED: RefCell<Option<Vec<u8>>> = const { RefCell::new(None) };
    }

    pub fn record(buf: &[u8]) {
        LAST_DROPPED.with(|slot| *slot.borrow_mut() = Some(buf.to_vec()));
    }

    pub fn take() -> Option<Vec<u8>> {
        LAST_DROPPED.with(|slot| slot.borrow_mut().take())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wipe_zeroes_every_byte() {
        let mut buf = vec![0xAAu8; 37];
        wipe(&mut buf);
        assert!(buf.iter().all(|b| *b == 0));
        wipe(&mut []);
    }

    #[test]
    fn secret_derefs_to_original_bytes() {
        let secret = Secret::new(vec![1, 2, 3, 4]);
        assert_eq!(&secret[..], &[1, 2, 3, 4]);
    }

    /// 真正经由 `Drop` 清零：离开作用域时缓冲已被写零（长度不变），而不是只在测试里手动调用清零函数
    #[test]
    fn dropping_a_secret_wipes_its_buffer() {
        let _ = observe::take();
        {
            let secret = Secret::new(vec![0xA5; 32]);
            assert!(secret.iter().all(|b| *b == 0xA5));
        }
        let wiped = observe::take().expect("Drop 应当执行并留下观察记录");
        assert_eq!(wiped, vec![0u8; 32]);
    }
}
