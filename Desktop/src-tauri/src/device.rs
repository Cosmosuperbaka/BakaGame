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

use crate::secret::{wipe, Secret};
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
    /// 服务端按最低支持版本给出的过期标记。版本比较只在服务端做一次（唯一权威），
    /// 壳不实现第二份，免得两端对「够不够新」的判断各自漂移；这里只用来写日志
    #[serde(default)]
    outdated: bool,
}

/// 一个设备的运行时身份。`Option` 里的字段在注册成功后才被填上。
pub struct Device {
    signing: SigningKey,
    public_key_b64: String,
    protection: KeyProtection,
    client_id: Mutex<Option<String>>,
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
fn dpapi_unprotect(data: &[u8]) -> Option<Secret> {
    crate::winapi::dpapi_unprotect(data, DPAPI_ENTROPY)
}

#[cfg(not(target_os = "windows"))]
fn dpapi_unprotect(_data: &[u8]) -> Option<Secret> {
    None
}

/// 密钥文件与缓存的 `clientId` 文件名
const KEY_FILE: &str = "device-key.json";
const CLIENT_ID_FILE: &str = "client-id.txt";
/// 确认损坏的密钥文件改名后的后缀：留一份现场供排查，同时把路径让给新密钥
const QUARANTINE_SUFFIX: &str = ".bad";

/// 读文件遇到「不是不存在」的失败（被占用、磁盘忙）时的重试次数与间隔：
/// 这类失败是瞬时的，绝不能因此就把好的身份丢掉重建
const READ_ATTEMPTS: u32 = 3;
const READ_RETRY_DELAY: Duration = Duration::from_millis(100);

/// DPAPI 解密的重试次数与间隔：同上，只在**确认 DPAPI 本身可用**之后才认定密文不可解
const UNPROTECT_ATTEMPTS: u32 = 3;
const UNPROTECT_RETRY_DELAY: Duration = Duration::from_millis(150);

/// 读密钥文件的结论。「确实坏了」与「这次没读成」必须分开：前者可以重建身份，
/// 后者重建就是把一台好设备当成新设备丢掉（服务端按公钥派生 `clientId`）
enum KeyFile {
    Missing,
    Present(StoredKey),
    /// 文件在，`v` 是别的版本：结构可能完全不同，不是损坏，只报错、文件原样保留
    Incompatible(String),
    /// 文件在，但内容不是本版本写得出的密钥记录（截断、乱码、非 UTF-8、`v` 缺失）
    Corrupt(String),
    /// 读取本身失败（权限、占用等），文件内容未知
    Unreadable(String),
}

fn read_key_file(path: &Path) -> KeyFile {
    let mut last = String::new();
    for attempt in 0..READ_ATTEMPTS {
        match std::fs::read(path) {
            Ok(bytes) => return classify_key_bytes(&bytes),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return KeyFile::Missing,
            Err(err) => {
                last = err.to_string();
                if attempt + 1 < READ_ATTEMPTS {
                    std::thread::sleep(READ_RETRY_DELAY);
                }
            }
        }
    }
    KeyFile::Unreadable(last)
}

fn classify_key_bytes(bytes: &[u8]) -> KeyFile {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return KeyFile::Corrupt("文件不是 UTF-8 文本".to_string());
    };
    // 先按通用 JSON 看版本：将来版本可能换了记录结构，严格结构解析不了也不能当损坏
    let value = match serde_json::from_str::<serde_json::Value>(text) {
        Ok(value) => value,
        Err(err) => return KeyFile::Corrupt(format!("密钥文件格式错误：{err}")),
    };
    let Some(version) = value.get("v").and_then(serde_json::Value::as_number) else {
        return KeyFile::Corrupt("密钥文件缺少数字类型的版本号 v".to_string());
    };
    if version.as_u64() != Some(u64::from(STORE_VERSION)) {
        return KeyFile::Incompatible(format!("密钥存储版本不兼容：v={version}"));
    }
    match serde_json::from_value::<StoredKey>(value) {
        Ok(record) => KeyFile::Present(record),
        Err(err) => KeyFile::Corrupt(format!("密钥文件格式错误：{err}")),
    }
}

/// 打开一条存储记录失败的原因
enum OpenError {
    /// 记录是别的版本或别的保护方式写的：不是损坏，重建会毁掉别的版本的密钥，只报错
    Incompatible(String),
    /// 记录确实不可用（base64 坏、长度不对、DPAPI 在可用的前提下解不开）：可以重建
    Corrupt(String),
    /// DPAPI 当前整体不可用：说不清密文好坏，不重建
    DpapiUnavailable(String),
}

/// DPAPI 的两个动作，抽成特征是为了让「解不开」与「DPAPI 不可用」的判据能脱离系统接口单测
trait KeyWrap {
    fn unprotect(&self, wrapped: &[u8]) -> Option<Secret>;
    /// DPAPI 此刻能否正常加解密一段探测数据
    fn is_functional(&self) -> bool;
}

struct SystemKeyWrap;

impl KeyWrap for SystemKeyWrap {
    fn unprotect(&self, wrapped: &[u8]) -> Option<Secret> {
        dpapi_unprotect(wrapped)
    }

    fn is_functional(&self) -> bool {
        const PROBE: &[u8] = b"bakagame-key-probe";
        dpapi_protect(PROBE)
            .and_then(|wrapped| dpapi_unprotect(&wrapped))
            .is_some_and(|back| &back[..] == PROBE)
    }
}

fn open_stored(
    record: &StoredKey,
    wrap: &dyn KeyWrap,
    unprotect_delay: Duration,
) -> Result<Device, OpenError> {
    if record.v != STORE_VERSION {
        return Err(OpenError::Incompatible(format!(
            "密钥存储版本不兼容：v={}",
            record.v
        )));
    }
    // 软件保护档位下这就是种子明文，用 Secret 持有以便离开作用域时清零
    let raw = Secret::new(
        B64.decode(record.key.as_bytes())
            .map_err(|e| OpenError::Corrupt(format!("密钥文件损坏：{e}")))?,
    );
    match record.protection.as_str() {
        "dpapi" => {
            let mut seed = None;
            for attempt in 0..UNPROTECT_ATTEMPTS {
                seed = wrap.unprotect(&raw);
                if seed.is_some() {
                    break;
                }
                if attempt + 1 < UNPROTECT_ATTEMPTS {
                    std::thread::sleep(unprotect_delay);
                }
            }
            let Some(seed) = seed else {
                // 解不开有两种可能：密文确实不属于当前用户/机器（或已损坏），或者 DPAPI 此刻坏了。
                // 只有 DPAPI 能正常加解密探测数据时，才把失败归给密文本身
                return Err(if wrap.is_functional() {
                    OpenError::Corrupt("DPAPI 无法解开本机私钥（用户或机器变更）".to_string())
                } else {
                    OpenError::DpapiUnavailable("DPAPI 当前不可用，暂不重建密钥".to_string())
                });
            };
            device_from_seed(&seed, KeyProtection::Hardware).map_err(OpenError::Corrupt)
        }
        "software" => device_from_seed(&raw, KeyProtection::Software).map_err(OpenError::Corrupt),
        other => Err(OpenError::Incompatible(format!(
            "未知的密钥保护方式：{other}"
        ))),
    }
}

/// 载入或创建设备密钥（不触网）。
///
/// 只有两种情形会**生成新密钥**：文件不存在，或文件确认损坏、密文确认解不开。
/// 后者先把旧文件改名为 `device-key.json.bad` 留作现场，再重建——新密钥即新设备，
/// 服务端按公钥派生 `clientId`，重新注册天然幂等。读取失败（被占用等）、版本或保护方式
/// 不认识、DPAPI 暂不可用都只报错，不重建，免得一次瞬时故障就丢掉好身份。
pub fn load_or_create(dir: &Path) -> Result<Device, String> {
    load_or_create_with(dir, &SystemKeyWrap, UNPROTECT_RETRY_DELAY)
}

fn load_or_create_with(
    dir: &Path,
    wrap: &dyn KeyWrap,
    unprotect_delay: Duration,
) -> Result<Device, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("无法创建密钥目录：{e}"))?;
    let path = dir.join(KEY_FILE);

    match read_key_file(&path) {
        KeyFile::Missing => generate_and_store(dir, &path),
        KeyFile::Unreadable(err) => Err(format!("无法读取密钥文件，暂不重建：{err}")),
        KeyFile::Incompatible(reason) => Err(reason),
        KeyFile::Corrupt(reason) => replace_corrupt_key(dir, &path, &reason),
        KeyFile::Present(record) => match open_stored(&record, wrap, unprotect_delay) {
            Ok(device) => Ok(device),
            Err(OpenError::Incompatible(reason)) | Err(OpenError::DpapiUnavailable(reason)) => {
                Err(reason)
            }
            Err(OpenError::Corrupt(reason)) => replace_corrupt_key(dir, &path, &reason),
        },
    }
}

/// 确认损坏的密钥文件：改名留证后重建。改名失败就不动手——
/// 在连旧文件都挪不开的环境里硬写新文件，只会让现场与新密钥一起不可信
fn replace_corrupt_key(dir: &Path, path: &Path, reason: &str) -> Result<Device, String> {
    let mut quarantined = path.as_os_str().to_owned();
    quarantined.push(QUARANTINE_SUFFIX);
    std::fs::rename(path, &quarantined)
        .map_err(|e| format!("密钥文件已损坏（{reason}），改名留证失败：{e}"))?;
    eprintln!(
        "设备密钥文件已损坏（{reason}），旧文件改名为 {KEY_FILE}{QUARANTINE_SUFFIX}，重新生成设备身份"
    );
    generate_and_store(dir, path)
}

/// 生成新密钥并原子落盘。新密钥对应新的 `clientId`，上一把密钥缓存下来的 id 随之作废。
fn generate_and_store(dir: &Path, path: &Path) -> Result<Device, String> {
    let signing = SigningKey::generate(&mut OsRng);
    let mut seed_bytes = signing.to_bytes();
    let seed = Secret::new(seed_bytes.to_vec());
    wipe(&mut seed_bytes);
    let (protection, stored) = match dpapi_protect(&seed) {
        Some(wrapped) => (KeyProtection::Hardware, Secret::new(wrapped)),
        None => {
            // DPAPI 不可用：降级为软件保护，明确记录档位，不因此拒绝启动
            (KeyProtection::Software, Secret::new(seed.to_vec()))
        }
    };
    let record = StoredKey {
        v: STORE_VERSION,
        protection: match protection {
            KeyProtection::Hardware => "dpapi".to_string(),
            KeyProtection::Software => "software".to_string(),
        },
        key: B64.encode(&stored[..]),
    };
    let text = serde_json::to_string_pretty(&record).map_err(|e| e.to_string())?;
    write_atomic(path, text.as_bytes()).map_err(|e| format!("无法写入密钥文件：{e}"))?;
    // 旧密钥缓存下来的 clientId 对新密钥没有意义：留着只会让第一次领挑战必然撞上「设备未知」
    let _ = std::fs::remove_file(dir.join(CLIENT_ID_FILE));
    // 落盘后不再改 ACL：`%APPDATA%` 属于用户配置文件，本身不对其它用户开放。
    // 显式写 SDDL ACL（`ConvertStringSecurityDescriptorToSecurityDescriptorW` +
    // `SetFileSecurityW`）是 README 里列出的 TODO，本机无工具链不敢硬写。
    device_from_seed(&seed, protection)
}

/// 先写同目录临时文件、落盘，再改名覆盖目标：写到一半被杀或断电时，
/// 目标文件要么是旧内容要么是新内容，不会留下截断的半份
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    let written = (|| {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()
    })();
    let renamed = written.and_then(|()| std::fs::rename(&tmp, path));
    if renamed.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    renamed
}

fn device_from_seed(seed: &[u8], protection: KeyProtection) -> Result<Device, String> {
    let mut bytes: [u8; 32] = seed
        .try_into()
        .map_err(|_| format!("私钥种子长度不是 32 字节（实际 {}）", seed.len()))?;
    let signing = SigningKey::from_bytes(&bytes);
    wipe(&mut bytes);
    let public_key: [u8; 32] = ed25519_dalek::VerifyingKey::from(&signing).to_bytes();
    Ok(Device {
        signing,
        public_key_b64: B64.encode(public_key),
        protection,
        client_id: Mutex::new(None),
    })
}

/// 读回上次签发的 `clientId`（注册失败或首次启动时可能为空）
pub fn cached_client_id(dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(dir.join(CLIENT_ID_FILE)).ok()?;
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
    let _ = write_atomic(&dir.join(CLIENT_ID_FILE), parsed.client_id.as_bytes());
    if parsed.outdated {
        // 强制更新口径：壳只记录，准入由服务端在握手里回 CLIENT_OUTDATED；
        // 注入契约里没有版本字段可暴露，详见 README「强制更新的落点」。
        eprintln!(
            "客户端版本 {} 低于服务端最低版本 {}，请更新 BakaGame 桌面客户端",
            crate::config::client_version(),
            parsed.minimum_version.as_deref().unwrap_or("（未给出）")
        );
    }
    Ok(())
}

// 尽力收紧本地文件权限（失败只记日志、不影响启动）目前没有实现：
// 软件保护档位本来就只依赖用户目录 ACL。显式 SDDL ACL 见 `load_or_create` 的说明与
// README「未验证与 TODO」，缺 `ConvertStringSecurityDescriptorToSecurityDescriptorW`
// + `SetFileSecurityW` 的绑定，本机无工具链不敢硬写。

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    fn key_path(dir: &TempDir) -> PathBuf {
        dir.path().join("device-key.json")
    }

    fn quarantine_path(dir: &TempDir) -> PathBuf {
        dir.path().join("device-key.json.bad")
    }

    fn record_json(v: u8, protection: &str, key_bytes: &[u8]) -> String {
        serde_json::to_string(&StoredKey {
            v,
            protection: protection.to_string(),
            key: B64.encode(key_bytes),
        })
        .unwrap()
    }

    /// 注册响应只认 clientId，其余字段缺省或多出来都不影响解析：服务端加字段不能让旧壳注册失败
    #[test]
    fn register_response_tolerates_missing_and_extra_fields() {
        let minimal: RegisterResponse = serde_json::from_str(r#"{"clientId":"ccd_a"}"#).unwrap();
        assert_eq!(minimal.client_id, "ccd_a");
        assert!(!minimal.outdated);
        assert!(minimal.minimum_version.is_none());

        let full: RegisterResponse = serde_json::from_str(
            r#"{"clientId":"ccd_a","minimumVersion":"1.2.3","outdated":true,"future":1}"#,
        )
        .unwrap();
        assert!(full.outdated);
        assert_eq!(full.minimum_version.as_deref(), Some("1.2.3"));
    }

    /// 首次运行生成密钥，再次载入得到同一把公钥；落盘不留临时文件
    #[test]
    fn first_run_creates_key_and_reload_is_stable() {
        let dir = TempDir::new("first-run");
        let first = load_or_create(dir.path()).expect("首次运行应生成密钥");
        assert!(key_path(&dir).exists());
        assert!(!dir.path().join("device-key.json.tmp").exists());
        let second = load_or_create(dir.path()).expect("再次载入应成功");
        assert_eq!(first.public_key_b64(), second.public_key_b64());
        assert!(!quarantine_path(&dir).exists());
    }

    /// 写到一半被杀留下的截断文件：确认损坏，改名留证并重建，之后身份稳定
    #[test]
    fn truncated_json_is_quarantined_and_replaced() {
        let dir = TempDir::new("truncated");
        let broken = r#"{"v":1,"protection":"soft"#;
        std::fs::write(key_path(&dir), broken).unwrap();

        let device = load_or_create(dir.path()).expect("损坏的密钥文件应自愈");
        assert_eq!(
            std::fs::read_to_string(quarantine_path(&dir)).unwrap(),
            broken
        );
        let again = load_or_create(dir.path()).expect("自愈后应能正常载入");
        assert_eq!(device.public_key_b64(), again.public_key_b64());
    }

    #[test]
    fn invalid_base64_is_replaced() {
        let dir = TempDir::new("bad-b64");
        let json = r#"{"v":1,"protection":"software","key":"@@not-base64@@"}"#;
        std::fs::write(key_path(&dir), json).unwrap();
        load_or_create(dir.path()).expect("base64 损坏应自愈");
        assert!(quarantine_path(&dir).exists());
    }

    #[test]
    fn non_utf8_file_is_replaced() {
        let dir = TempDir::new("non-utf8");
        std::fs::write(key_path(&dir), [0xff, 0xfe, 0x00, 0x9f]).unwrap();
        load_or_create(dir.path()).expect("乱码文件应自愈");
        assert!(quarantine_path(&dir).exists());
    }

    #[test]
    fn wrong_seed_length_is_replaced() {
        let dir = TempDir::new("short-seed");
        std::fs::write(key_path(&dir), record_json(1, "software", &[7u8; 5])).unwrap();
        load_or_create(dir.path()).expect("种子长度不对应自愈");
        assert!(quarantine_path(&dir).exists());
    }

    /// DPAPI 可用的前提下解不开的密文（换用户或换机留下的）：确实解不开，重建
    #[test]
    fn undecryptable_dpapi_blob_is_replaced() {
        let dir = TempDir::new("dpapi-garbage");
        std::fs::write(key_path(&dir), record_json(1, "dpapi", &[9u8; 40])).unwrap();
        load_or_create(dir.path()).expect("解不开的密文应自愈");
        assert!(quarantine_path(&dir).exists());
    }

    /// 别的版本写的记录不是损坏：重建会毁掉那个版本的密钥，只报错、文件原样保留
    #[test]
    fn other_store_version_is_left_untouched() {
        let dir = TempDir::new("other-version");
        let json = record_json(2, "software", &[1u8; 32]);
        std::fs::write(key_path(&dir), &json).unwrap();
        assert!(load_or_create(dir.path()).is_err());
        assert_eq!(std::fs::read_to_string(key_path(&dir)).unwrap(), json);
        assert!(!quarantine_path(&dir).exists());
    }

    /// 将来版本改了记录结构（没有 `key` 字段）：严格结构解析不了，也不能当损坏挪走，
    /// 否则降级回本版本会把原身份丢掉
    #[test]
    fn future_version_with_different_shape_is_left_untouched() {
        let dir = TempDir::new("future-shape");
        let json = r#"{"v":2,"protection":"tpm","handle":"h-1"}"#;
        std::fs::write(key_path(&dir), json).unwrap();
        let err = match load_or_create(dir.path()) {
            Ok(_) => panic!("不认识的版本不应载入成功"),
            Err(err) => err,
        };
        assert!(err.contains("版本不兼容"), "应报版本不兼容：{err}");
        assert_eq!(std::fs::read_to_string(key_path(&dir)).unwrap(), json);
        assert!(!quarantine_path(&dir).exists());
    }

    /// 超出 u8 的版本号同样是「别的版本」，不是损坏
    #[test]
    fn out_of_range_version_number_is_incompatible() {
        let dir = TempDir::new("big-version");
        let json = r#"{"v":300,"blob":"x"}"#;
        std::fs::write(key_path(&dir), json).unwrap();
        assert!(load_or_create(dir.path()).is_err());
        assert_eq!(std::fs::read_to_string(key_path(&dir)).unwrap(), json);
        assert!(!quarantine_path(&dir).exists());
    }

    /// `v` 缺失或不是数字：本版本自己写不出这种形状，按损坏处理
    #[test]
    fn missing_or_non_numeric_version_is_corrupt() {
        for (name, json) in [
            ("no-v", r#"{"protection":"software","key":"AAAA"}"#),
            ("str-v", r#"{"v":"1","protection":"software","key":"AAAA"}"#),
            ("not-object", r#"[1,2,3]"#),
        ] {
            let dir = TempDir::new(name);
            std::fs::write(key_path(&dir), json).unwrap();
            load_or_create(dir.path()).expect("本版本写不出的形状应按损坏自愈");
            assert!(quarantine_path(&dir).exists(), "{name} 应改名留证");
        }
    }

    /// `v` 等于当前版本而结构不合法才算损坏
    #[test]
    fn current_version_with_broken_shape_is_corrupt() {
        let dir = TempDir::new("v1-broken");
        std::fs::write(key_path(&dir), r#"{"v":1,"protection":"software"}"#).unwrap();
        load_or_create(dir.path()).expect("当前版本结构不合法应自愈");
        assert!(quarantine_path(&dir).exists());
    }

    /// 改名留证失败：连旧文件都挪不开，只报错，不在原地硬写新密钥，旧文件原样保留
    #[test]
    fn quarantine_rename_failure_does_not_regenerate() {
        let dir = TempDir::new("rename-fails");
        let broken = r#"{"v":1,"protection":"soft"#;
        std::fs::write(key_path(&dir), broken).unwrap();
        // 留证路径已被一个非空目录占着：文件改名到它上面必然失败
        std::fs::create_dir(quarantine_path(&dir)).unwrap();
        std::fs::write(quarantine_path(&dir).join("keep"), "x").unwrap();
        let err = match load_or_create(dir.path()) {
            Ok(_) => panic!("改名失败时不应重建"),
            Err(err) => err,
        };
        assert!(err.contains("改名留证失败"), "{err}");
        assert_eq!(std::fs::read_to_string(key_path(&dir)).unwrap(), broken);
    }

    #[test]
    fn unknown_protection_is_left_untouched() {
        let dir = TempDir::new("unknown-protection");
        let json = record_json(1, "tpm", &[1u8; 32]);
        std::fs::write(key_path(&dir), &json).unwrap();
        assert!(load_or_create(dir.path()).is_err());
        assert_eq!(std::fs::read_to_string(key_path(&dir)).unwrap(), json);
        assert!(!quarantine_path(&dir).exists());
    }

    /// 读取本身失败（这里用「路径是个目录」模拟被占用、拒绝访问之类的瞬时故障）：
    /// 内容未知，绝不能当作损坏去重建
    #[test]
    fn unreadable_key_path_is_never_replaced() {
        let dir = TempDir::new("unreadable");
        std::fs::create_dir(key_path(&dir)).unwrap();
        assert!(load_or_create(dir.path()).is_err());
        assert!(key_path(&dir).is_dir(), "不得动被占用的路径");
        assert!(!quarantine_path(&dir).exists());
    }

    /// 新密钥即新设备：上一把密钥缓存的 clientId 必须随之作废，否则第一次领挑战必然撞上设备未知
    #[test]
    fn regeneration_drops_stale_client_id() {
        let dir = TempDir::new("stale-id");
        std::fs::write(dir.path().join("client-id.txt"), "ccd_old").unwrap();
        std::fs::write(key_path(&dir), "garbage").unwrap();
        load_or_create(dir.path()).expect("应自愈");
        assert_eq!(cached_client_id(dir.path()), None);
    }

    /// 原子写入失败时不留临时文件，目标保持原样
    #[test]
    fn failed_atomic_write_leaves_no_temp_file() {
        let dir = TempDir::new("atomic-fail");
        let target = dir.path().join("target");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("keep"), "x").unwrap();
        assert!(write_atomic(&target, b"new").is_err());
        assert!(!dir.path().join("target.tmp").exists());
        assert!(target.join("keep").exists());
    }

    /// 临时文件建不出来时，目标原样保留：证明写入确实走「先写临时文件再改名」，
    /// 而不是直接覆盖目标（直接覆盖在中途被杀时会留下截断的半份）
    #[test]
    fn atomic_write_never_touches_target_when_temp_is_unavailable() {
        let dir = TempDir::new("atomic-tmp-blocked");
        let target = dir.path().join("f.txt");
        std::fs::write(&target, "old").unwrap();
        std::fs::create_dir(dir.path().join("f.txt.tmp")).unwrap();
        assert!(write_atomic(&target, b"new").is_err());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "old");
    }

    #[test]
    fn atomic_write_replaces_existing_content() {
        let dir = TempDir::new("atomic-ok");
        let target = dir.path().join("f.txt");
        write_atomic(&target, b"one").unwrap();
        write_atomic(&target, b"two").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "two");
        assert!(!dir.path().join("f.txt.tmp").exists());
    }

    /// 可编程的 DPAPI：前 `fail_first` 次解密失败，之后返回固定种子；`functional` 决定探测结论
    struct FakeWrap {
        calls: std::cell::Cell<u32>,
        fail_first: u32,
        functional: bool,
    }

    impl KeyWrap for FakeWrap {
        fn unprotect(&self, _wrapped: &[u8]) -> Option<Secret> {
            let call = self.calls.get() + 1;
            self.calls.set(call);
            (call > self.fail_first).then(|| Secret::new(vec![5u8; 32]))
        }

        fn is_functional(&self) -> bool {
            self.functional
        }
    }

    fn write_dpapi_record(dir: &TempDir) {
        std::fs::write(key_path(dir), record_json(1, "dpapi", &[9u8; 40])).unwrap();
    }

    /// 解密偶发失败、重试后成功：用的是原密钥，不重建
    #[test]
    fn transient_unprotect_failure_is_retried() {
        let dir = TempDir::new("unprotect-retry");
        write_dpapi_record(&dir);
        let wrap = FakeWrap {
            calls: std::cell::Cell::new(0),
            fail_first: 2,
            functional: true,
        };
        let device = load_or_create_with(dir.path(), &wrap, Duration::ZERO)
            .expect("重试后解密成功应直接载入");
        assert_eq!(wrap.calls.get(), 3);
        assert!(!quarantine_path(&dir).exists());
        let expected = device_from_seed(&[5u8; 32], KeyProtection::Hardware).unwrap();
        assert_eq!(device.public_key_b64(), expected.public_key_b64());
    }

    /// 解密始终失败而 DPAPI 本身能正常加解密：密文确实不可解，重建
    #[test]
    fn persistent_failure_with_working_dpapi_replaces_key() {
        let dir = TempDir::new("unprotect-corrupt");
        write_dpapi_record(&dir);
        let wrap = FakeWrap {
            calls: std::cell::Cell::new(0),
            fail_first: u32::MAX,
            functional: true,
        };
        load_or_create_with(dir.path(), &wrap, Duration::ZERO).expect("应自愈");
        assert_eq!(wrap.calls.get(), UNPROTECT_ATTEMPTS);
        assert!(quarantine_path(&dir).exists());
    }

    /// 解密失败而 DPAPI 本身也不可用：说不清密文好坏，只报错，文件原样保留
    #[test]
    fn failure_with_broken_dpapi_keeps_the_key_file() {
        let dir = TempDir::new("unprotect-dpapi-down");
        write_dpapi_record(&dir);
        let before = std::fs::read_to_string(key_path(&dir)).unwrap();
        let wrap = FakeWrap {
            calls: std::cell::Cell::new(0),
            fail_first: u32::MAX,
            functional: false,
        };
        assert!(load_or_create_with(dir.path(), &wrap, Duration::ZERO).is_err());
        assert_eq!(std::fs::read_to_string(key_path(&dir)).unwrap(), before);
        assert!(!quarantine_path(&dir).exists());
    }
}
