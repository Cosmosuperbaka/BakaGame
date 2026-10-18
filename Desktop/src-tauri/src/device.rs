//! 设备密钥对与注册（计划 P2.2）。
//!
//! 首次运行生成 Ed25519 密钥对；私钥（32 字节种子）用 Windows DPAPI 当前用户范围加密后
//! 存本地文件，公钥 + 客户端版本 + 自检结果上报服务端换 `clientId`。
//!
//! DPAPI 不可用时**降级为软件保护并不拒绝启动**（计划里这是环境降级，不计分）：
//! 降级态只把种子按原样存进本地文件，仅依赖文件系统权限，不再叠任何假加密。
//!
//! 强度声明（与计划一致）：这是**门槛**，不是**证明**。私钥在用户自己的机器上，
//! 肯逆向就能提取；作用是让自写客户端必须先做一次逆向，而不是直接 `new WebSocket()`。

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use ed25519_dalek::{Signer, SigningKey};
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use crate::selfcheck::{KeyProtection, SelfCheckReport};

pub const CLIENT_TYPE: &str = "desktop";
pub const PLATFORM: &str = "windows";
/// §3 的算法词表取值：服务端按它选验签分支（ed25519 = 64 字节裸签名）
pub const KEY_ALGORITHM: &str = "ed25519";
pub const REGISTER_PATH: &str = "/api/client/register";

/// 注册只在首启与「服务端不认识这台设备」时发生，可以慢一点；
/// 领挑战与换票在建连关键路径上，用的是 `attest` 里更短的超时。
const REGISTER_TIMEOUT: Duration = Duration::from_secs(20);

/// DPAPI 可选熵。刻意只用固定应用域常量、不绑机器：
/// 重装系统后密钥仍然可解，避免把「换机」变成「设备被拉黑」。DPAPI 本身已是用户范围。
const DPAPI_ENTROPY: &[u8] = b"BakaGame.DesktopKey.v1";

/// 存储版本；将来换保护方式要升 `v` 而不是原地改语义
const STORE_VERSION: u8 = 1;

/// 磁盘上的密钥记录
#[derive(Serialize, Deserialize)]
struct StoredKey {
    v: u8,
    /// `"dpapi"` 或 `"software"`
    protection: String,
    /// dpapi: `base64(DPAPI(种子))`；software: `base64(种子)`
    key: String,
}

/// 注册请求体，字段名逐字对齐服务端契约
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RegisterRequest<'a> {
    public_key: &'a str,
    key_algorithm: &'a str,
    client_type: &'a str,
    client_version: &'a str,
    platform: &'a str,
    self_check: &'a SelfCheckReport,
}

/// 注册响应体
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterResponse {
    client_id: String,
    minimum_version: Option<String>,
    /// 服务端按最低支持版本给出的过期标记；本地比较（`version_lt`）仍会跑一次，两者取或
    #[serde(default)]
    outdated: bool,
}

/// 一个设备的运行时身份。`Option` 里的字段在注册成功后才被填上。
pub struct Device {
    signing: SigningKey,
    public_key_b64: String,
    protection: KeyProtection,
    client_id: Mutex<Option<String>>,
    minimum_version: Mutex<Option<String>>,
    outdated: Mutex<bool>,
}

impl Device {
    pub fn public_key_b64(&self) -> &str {
        &self.public_key_b64
    }

    pub fn protection(&self) -> KeyProtection {
        self.protection
    }

    pub fn client_id(&self) -> Option<String> {
        self.client_id.lock().ok().and_then(|g| g.clone())
    }

    /// 读回上次签发的 `clientId`（注册失败或首次启动时可能为空）
    pub fn set_client_id(&self, client_id: String) {
        if let Ok(mut guard) = self.client_id.lock() {
            *guard = Some(client_id);
        }
    }

    /// 服务端下发的最低支持版本；仅本地记录与提示，准入判断在服务端
    pub fn minimum_version(&self) -> Option<String> {
        self.minimum_version.lock().ok().and_then(|g| g.clone())
    }

    pub fn is_outdated(&self) -> bool {
        self.outdated.lock().map(|g| *g).unwrap_or(false)
    }

    /// 记下服务端在 `register` / `attest` 里回传的过期标记（§7：准入由服务端在握手时执行，
    /// 壳只保留事实供日志与后续提示，不自作主张拦玩家）
    pub fn mark_outdated(&self) {
        if let Ok(mut guard) = self.outdated.lock() {
            *guard = true;
        }
    }

    /// 对服务端下发的 challenge 签名：签名对象是 challenge 这个 ASCII 字符串的字节，
    /// 返回标准 base64（含 `=` 填充，无换行、无 URL-safe 变换）。
    pub fn sign(&self, challenge: &str) -> Result<String, String> {
        let bytes = challenge.as_bytes();
        if bytes.is_empty() || bytes.len() > 4096 {
            return Err("challenge 长度不合法".into());
        }
        // Ed25519 对纯 ASCII 字节签名；不做任何二次编码，服务端按同一口径验签
        let signature = self.signing.sign(bytes);
        Ok(B64.encode(signature.to_bytes()))
    }
}

/// 密钥与 `clientId` 的目录：`%APPDATA%\BakaGame\client`，取不到 APPDATA 时退回
/// `%USERPROFILE%\.bakagame\client`。
pub fn storage_dir() -> Option<PathBuf> {
    if let Ok(appdata) = std::env::var("APPDATA") {
        if !appdata.trim().is_empty() {
            return Some(Path::new(&appdata).join("BakaGame").join("client"));
        }
    }
    for key in ["USERPROFILE", "HOME"] {
        if let Ok(root) = std::env::var(key) {
            if !root.trim().is_empty() {
                return Some(Path::new(&root).join(".bakagame").join("client"));
            }
        }
    }
    None
}

/// DPAPI 包装：非 Windows 一律返回 `None`（等价于「DPAPI 不可用」→ 软件保护档位）。
/// 单独包一层是为了让 `winapi` 模块可以按平台裁剪，而不是在本模块里到处写 `cfg`。
#[cfg(target_os = "windows")]
fn dpapi_protect(data: &[u8]) -> Option<Vec<u8>> {
    crate::winapi::dpapi_protect(data, DPAPI_ENTROPY)
}

#[cfg(not(target_os = "windows"))]
fn dpapi_protect(_data: &[u8]) -> Option<Vec<u8>> {
    None
}

#[cfg(target_os = "windows")]
fn dpapi_unprotect(data: &[u8]) -> Option<Vec<u8>> {
    crate::winapi::dpapi_unprotect(data, DPAPI_ENTROPY)
}

#[cfg(not(target_os = "windows"))]
fn dpapi_unprotect(_data: &[u8]) -> Option<Vec<u8>> {
    None
}

/// 载入或创建设备密钥（不触网）。
pub fn load_or_create(dir: &Path) -> Result<Device, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("无法创建密钥目录：{e}"))?;
    let path = dir.join("device-key.json");

    if let Some(existing) = read_stored(&path)? {
        if existing.v != STORE_VERSION {
            return Err(format!("密钥存储版本不兼容：v={}", existing.v));
        }
        let raw = B64
            .decode(existing.key.as_bytes())
            .map_err(|e| format!("密钥文件损坏：{e}"))?;
        return match existing.protection.as_str() {
            "dpapi" => {
                let seed = dpapi_unprotect(&raw)
                    .ok_or_else(|| "DPAPI 无法解开本机私钥（用户或机器变更）".to_string())?;
                Ok(device_from_seed(&seed, KeyProtection::Hardware)?)
            }
            "software" => Ok(device_from_seed(&raw, KeyProtection::Software)?),
            other => Err(format!("未知的密钥保护方式：{other}")),
        };
    }

    // 首次运行：生成密钥对
    let signing = SigningKey::generate(&mut OsRng);
    let seed = signing.to_bytes();
    let (protection, stored) = match dpapi_protect(&seed) {
        Some(wrapped) => (KeyProtection::Hardware, wrapped),
        None => {
            // DPAPI 不可用：降级为软件保护，明确记录档位，不因此拒绝启动
            (KeyProtection::Software, seed.to_vec())
        }
    };
    let record = StoredKey {
        v: STORE_VERSION,
        protection: match protection {
            KeyProtection::Hardware => "dpapi".to_string(),
            KeyProtection::Software => "software".to_string(),
        },
        key: B64.encode(&stored),
    };
    let text = serde_json::to_string_pretty(&record).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("无法写入密钥文件：{e}"))?;
    // 落盘后不再改 ACL：`%APPDATA%` 属于用户配置文件，本身不对其它用户开放。
    // 显式写 SDDL ACL（`ConvertStringSecurityDescriptorToSecurityDescriptorW` +
    // `SetFileSecurityW`）是 README 里列出的 TODO，本机无工具链不敢硬写。
    device_from_seed(&seed, protection)
}

fn read_stored(path: &Path) -> Result<Option<StoredKey>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(path).map_err(|e| format!("无法读取密钥文件：{e}"))?;
    let record: StoredKey =
        serde_json::from_str(&text).map_err(|e| format!("密钥文件格式错误：{e}"))?;
    Ok(Some(record))
}

fn device_from_seed(seed: &[u8], protection: KeyProtection) -> Result<Device, String> {
    let bytes: [u8; 32] = seed
        .try_into()
        .map_err(|_| format!("私钥种子长度不是 32 字节（实际 {}）", seed.len()))?;
    let signing = SigningKey::from_bytes(&bytes);
    let public_key: [u8; 32] = ed25519_dalek::VerifyingKey::from(&signing).to_bytes();
    Ok(Device {
        signing,
        public_key_b64: B64.encode(public_key),
        protection,
        client_id: Mutex::new(None),
        minimum_version: Mutex::new(None),
        outdated: Mutex::new(false),
    })
}

/// 读回上次签发的 `clientId`（注册失败或首次启动时可能为空）
pub fn cached_client_id(dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(dir.join("client-id.txt")).ok()?;
    let trimmed = text.trim().to_string();
    (!trimmed.is_empty()).then_some(trimmed)
}

/// 上报公钥 + 版本 + 自检结果，换 `clientId`。同步阻塞，只在后台线程调用。
pub fn register(dir: &Path, device: &Device, report: &SelfCheckReport) -> Result<(), String> {
    let body = RegisterRequest {
        public_key: device.public_key_b64(),
        key_algorithm: KEY_ALGORITHM,
        client_type: CLIENT_TYPE,
        client_version: crate::config::client_version(),
        platform: PLATFORM,
        self_check: report,
    };
    let parsed: RegisterResponse =
        crate::http::post_json(REGISTER_PATH, &body, REGISTER_TIMEOUT).map_err(|e| e.text())?;
    if parsed.client_id.trim().is_empty() {
        return Err("注册响应缺少 clientId".into());
    }
    if let Ok(mut guard) = device.client_id.lock() {
        *guard = Some(parsed.client_id.clone());
    }
    let _ = std::fs::write(dir.join("client-id.txt"), &parsed.client_id);
    if let Some(minimum) = parsed.minimum_version.clone() {
        if let Ok(mut guard) = device.minimum_version.lock() {
            *guard = Some(minimum.clone());
        }
        if version_lt(crate::config::client_version(), &minimum) {
            device.mark_outdated();
            // 强制更新口径：壳只记录，准入由服务端在握手里回 CLIENT_OUTDATED；
            // 注入契约里没有版本字段可暴露，详见 README「强制更新的落点」。
            eprintln!(
                "客户端版本 {} 低于服务端最低版本 {minimum}，请更新 BakaGame 桌面客户端",
                crate::config::client_version()
            );
        }
    }
    // 服务端自己算的 outdated 与本地比较取或：最低版本可能带本地解析不了的预发布段
    if parsed.outdated {
        device.mark_outdated();
    }
    Ok(())
}

/// 点分十进制版本比较（够用即可，不引入 semver 依赖）；无法解析时按「不低于」处理，
/// 绝不因为解析失败而误判成过期。
fn version_lt(current: &str, minimum: &str) -> bool {
    let a = parse_version(current);
    let b = parse_version(minimum);
    match (a, b) {
        (Some(a), Some(b)) => cmp_parts(&a, &b) < 0,
        _ => false,
    }
}

fn parse_version(value: &str) -> Option<Vec<u64>> {
    let core = value
        .trim()
        .trim_start_matches('v')
        .split(['-', '+'])
        .next()
        .unwrap_or_default();
    if core.is_empty() {
        return None;
    }
    let mut parts = Vec::new();
    for seg in core.split('.') {
        parts.push(seg.parse::<u64>().ok()?);
    }
    Some(parts)
}

fn cmp_parts(a: &[u64], b: &[u64]) -> std::cmp::Ordering {
    for index in 0..a.len().max(b.len()) {
        let left = a.get(index).copied().unwrap_or(0);
        let right = b.get(index).copied().unwrap_or(0);
        if left != right {
            return left.cmp(&right);
        }
    }
    std::cmp::Ordering::Equal
}

// 尽力收紧本地文件权限（失败只记日志、不影响启动）目前没有实现：
// 软件保护档位本来就只依赖用户目录 ACL。显式 SDDL ACL 见 `load_or_create` 的说明与
// README「未验证与 TODO」，缺 `ConvertStringSecurityDescriptorToSecurityDescriptorW`
// + `SetFileSecurityW` 的绑定，本机无工具链不敢硬写。
