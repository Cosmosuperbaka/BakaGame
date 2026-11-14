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

    /// `Secret` 的 Drop 就是调用 `wipe`：这里确认它读出来是原值、且能被清零，
    /// 释放后的堆内存不能再读，所以直接验证 `wipe` 作用在它内部缓冲上
    #[test]
    fn secret_derefs_to_original_bytes_and_wipes_its_buffer() {
        let mut secret = Secret::new(vec![1, 2, 3, 4]);
        assert_eq!(&secret[..], &[1, 2, 3, 4]);
        wipe(&mut secret.0);
        assert_eq!(&secret[..], &[0, 0, 0, 0]);
    }
}
