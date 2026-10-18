//! 通道证明闭环（`Agents/ClientChannel.md` §2）：
//! 领挑战 → 用设备私钥**逐字节**签名 → 交签名换一次性 ticket → 交给页面的 `channelTicket`。
//!
//! 三条硬约束决定了这里的写法：
//!
//! - ticket 只有 30 秒 TTL 且**用过即焚**：壳不能长期缓存，同一张票绝不交给页面两次；
//! - challenge 的签名对象就是它那段 ASCII 字节，不做任何二次编码（服务端按同一口径验签）；
//! - `attest` 每次都要重报 `selfCheck`：所以自检在签发时**现跑**，不复用启动那次的结果。
//!
//! 失败口径与注册一致：判定不过（`CLIENT_UNTRUSTED`）或设备不认识（`CLIENT_UNKNOWN`）都不抛给
//! 玩家，只记日志并让 `channelTicket` 保持空串——网页玩家本来就没有票，普通房不受影响。

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::device;
use crate::http::{self, ApiError};
use crate::selfcheck::{self, SelfCheckReport};

pub const CHALLENGE_PATH: &str = "/api/client/challenge";
pub const ATTEST_PATH: &str = "/api/client/attest";

/// 领挑战与换票都在建连的关键路径上：不像注册那样等 20 秒，超时就当这次没签成
const HTTP_TIMEOUT: Duration = Duration::from_secs(8);

/// 距过期不足这个余量就当作没有：票在页面手上才过期比没票更难排查。
/// 桥接脚本（`bridge.rs`）里的余量必须取同一个值，两边任一边算松了都会给出废票。
pub const TICKET_MARGIN_MS: u64 = 5_000;

/// 一轮证明最多两次：挑战 60 秒有效、单次消费，撞上并发消费或过期时重试一次足够
const MAX_ATTEMPTS: u8 = 2;

/// 交给页面的票（`baka_ticket` 命令的返回体）：字段名给桥接脚本读，不进 `__BAKA_CHANNEL__`
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketPayload {
    pub ticket: String,
    pub expires_at: u64,
}

/// 壳侧持有的票。`served` 记录「这张票已经交给过页面」：一次性票不得二次给出。
#[derive(Clone, Debug)]
pub struct Ticket {
    pub value: String,
    pub expires_at_ms: u64,
    pub served: bool,
}

impl Ticket {
    /// 还没交出去、并且离过期还有足够余量——只有这种票能直接给页面
    pub fn usable(&self, now_ms: u64) -> bool {
        !self.served && self.expires_at_ms.saturating_sub(now_ms) > TICKET_MARGIN_MS
    }

    pub fn payload(&self) -> TicketPayload {
        TicketPayload { ticket: self.value.clone(), expires_at: self.expires_at_ms }
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// —— 请求/响应体：字段名逐字对齐 §3，服务端 schema 是 strict 的，多一个字段就会被拒 ——

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChallengeRequest<'a> {
    client_id: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChallengeResponse {
    /// 不透明挑战串，形如 `ccd_xxx.nonce.issuedAt`；服务端 TTL 60 秒、单次消费。
    /// 响应里另有 `expiresAt`（挑战自身的过期时间），壳拿到就立刻签名使用，不解析它。
    challenge: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AttestRequest<'a> {
    client_id: &'a str,
    challenge: &'a str,
    signature: &'a str,
    client_type: &'a str,
    client_version: &'a str,
    self_check: &'a SelfCheckReport,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttestResponse {
    ticket: String,
    expires_at: u64,
    #[serde(default)]
    outdated: bool,
}

/// 签一张可用的票：确保已注册 → 领挑战 → 原样签名 → 换票。
/// 同步阻塞，只在后台线程或 `spawn_blocking` 里调用。
pub fn prove(device: &device::Device, dir: &Path) -> Result<Ticket, String> {
    let mut last = String::from("通道证明没有执行");
    for attempt in 1..=MAX_ATTEMPTS {
        // 每次签发都重跑一遍自检：调试器可能是中途才附上的（§5 的判定按最新事实）
        let report = selfcheck::run(device.protection());
        if let Err(err) = ensure_client_id(device, dir, &report) {
            return Err(err.text());
        }
        match attempt_once(device, &report) {
            Ok(ticket) => return Ok(ticket),
            Err(err) => {
                last = err.text();
                let retryable = err.is("CHALLENGE_EXPIRED") || err.is("CLIENT_UNKNOWN");
                if !retryable || attempt == MAX_ATTEMPTS {
                    return Err(last);
                }
                if err.is("CLIENT_UNKNOWN") {
                    // 服务端设备表里没有这个 clientId（换库或清理过）：按同一把公钥重注册，
                    // 派生规则保证幂等，下一轮循环会拿到同一个 clientId
                    if let Err(re) = device::register(dir, device, &report) {
                        return Err(format!("重新注册失败：{re}"));
                    }
                }
                eprintln!("通道证明第 {attempt} 次尝试失败，重试一轮：{last}");
            }
        }
    }
    Err(last)
}

/// `clientId` 是领挑战的前提；离线启动或首次运行时按同一份自检结果补一次注册。
fn ensure_client_id(
    device: &device::Device,
    dir: &Path,
    report: &SelfCheckReport,
) -> Result<(), ApiError> {
    if device.client_id().is_some() {
        return Ok(());
    }
    device::register(dir, device, report).map_err(|err| {
        ApiError::local(format!("设备注册未成功，无法领挑战：{err}"))
    })
}

/// 一轮完整的 challenge → sign → attest。
fn attempt_once(
    device: &device::Device,
    report: &SelfCheckReport,
) -> Result<Ticket, ApiError> {
    let client_id = device
        .client_id()
        .ok_or_else(|| ApiError::local("设备尚未注册，拿不到 clientId"))?;

    let challenge: ChallengeResponse = http::post_json(
        CHALLENGE_PATH,
        &ChallengeRequest { client_id: &client_id },
        HTTP_TIMEOUT,
    )?;
    if challenge.challenge.trim().is_empty() {
        return Err(ApiError::local("服务端返回的挑战为空"));
    }

    // 签名对象逐字是 challenge 的 ASCII 字节；base64 标准编码、无换行（§3 的 ed25519 口径）
    let signature = device
        .sign(&challenge.challenge)
        .map_err(ApiError::local)?;

    let response: AttestResponse = http::post_json(
        ATTEST_PATH,
        &AttestRequest {
            client_id: &client_id,
            challenge: &challenge.challenge,
            signature: &signature,
            client_type: device::CLIENT_TYPE,
            client_version: crate::config::client_version(),
            self_check: report,
        },
        HTTP_TIMEOUT,
    )?;
    if response.ticket.trim().is_empty() {
        return Err(ApiError::local("服务端返回的票据为空"));
    }
    if response.outdated {
        // 版本门槛由服务端在握手时执行（CLIENT_OUTDATED）；壳只如实记录，不自作主张拦玩家
        device.mark_outdated();
        eprintln!(
            "本次构建版本 {} 低于服务端最低支持版本，反作弊房会被拒",
            crate::config::client_version()
        );
    }
    Ok(Ticket { value: response.ticket, expires_at_ms: response.expires_at, served: false })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 票的一次性与时效：已交出去的票绝不再给出，临近过期的票当作没有
    #[test]
    fn ticket_usability() {
        let now = 1_000_000;
        let fresh = Ticket {
            value: "t".into(),
            expires_at_ms: now + 30_000,
            served: false,
        };
        assert!(fresh.usable(now));
        assert!(!fresh.usable(now + 26_000), "离过期不足余量后不得再交出去");
        let handed_out = Ticket { served: true, ..fresh.clone() };
        assert!(!handed_out.usable(now), "一次性票不得二次给出");
    }

    /// 上报字段名是协议本身：改名即断链，这里把 §3 的名字钉住
    #[test]
    fn request_field_names_are_literal() {
        let report = SelfCheckReport {
            hard_fail: Vec::new(),
            soft_fail: Vec::new(),
            key_protection: selfcheck::KeyProtection::Software,
        };
        let body = serde_json::to_value(AttestRequest {
            client_id: "ccd_x",
            challenge: "ccd_x.nonce.1",
            signature: "AAA",
            client_type: device::CLIENT_TYPE,
            client_version: "0.1.0",
            self_check: &report,
        })
        .expect("attest 请求体应能序列化");
        for key in [
            "clientId",
            "challenge",
            "signature",
            "clientType",
            "clientVersion",
            "selfCheck",
        ] {
            assert!(body.get(key).is_some(), "attest 请求体缺少字段 {key}");
        }
        assert_eq!(
            body.as_object().expect("attest 请求体应是对象").len(),
            6,
            "服务端 schema 是 strict 的，attest 只能带这六个字段"
        );
        let self_check = body["selfCheck"].as_object().expect("selfCheck 应是对象");
        for key in ["hardFail", "softFail", "keyProtection"] {
            assert!(self_check.get(key).is_some(), "selfCheck 缺少字段 {key}");
        }
        assert_eq!(self_check.len(), 3, "selfCheck 只能带这三个字段");

        let challenge = serde_json::to_value(ChallengeRequest { client_id: "ccd_x" })
            .expect("挑战请求应能序列化");
        assert_eq!(
            challenge.as_object().expect("挑战请求应是对象").len(),
            1,
            "challenge 请求只能带 clientId"
        );
        assert!(challenge.get("clientId").is_some());
    }
}
