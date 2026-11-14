//! 通道证明闭环（`Server/docs/ClientChannel.md` §2）：
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
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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

/// 交给页面的票（`baka_ticket` 命令的返回体）：字段名给桥接脚本读，不进 `__BAKA_CHANNEL__`。
/// 只给「还剩多久」：页面脚本按自己的单调时钟加这个相对量算到期，两端都不碰墙上时钟。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketPayload {
    pub ticket: String,
    pub ttl_ms: u64,
}

/// 本地的一个时刻：单调时钟与墙上时钟各记一份。只用于算「过去了多久」，从不与服务端的时钟比较。
#[derive(Clone, Copy, Debug)]
pub struct Stamp {
    mono: Instant,
    wall_ms: u64,
}

impl Stamp {
    pub fn now() -> Self {
        Self { mono: Instant::now(), wall_ms: now_ms() }
    }

    /// 自 `earlier` 起过去了多久：取两种时钟里较大的那个。
    /// 单调时钟不受改时间影响，但在系统休眠期间未必走动；墙上时钟的**差值**休眠时照走，
    /// 而且与服务端时钟的偏差无关（偏差在相减时抵消）。取大者只会让票更早作废，不会放出废票。
    fn since(self, earlier: Stamp) -> Duration {
        let mono = self.mono.saturating_duration_since(earlier.mono);
        let wall = Duration::from_millis(self.wall_ms.saturating_sub(earlier.wall_ms));
        mono.max(wall)
    }
}

/// 壳侧持有的票。`served` 记录「这张票已经交给过页面」：一次性票不得二次给出。
///
/// 有效期按「发出换票请求之前起过去了多久」算：服务端给的绝对时刻属于服务端的时钟，
/// 本机时钟快慢几十秒是常态（手动改时间、未同步），拿它们互相比较会把好票判废、把废票放出去。
#[derive(Clone, Debug)]
pub struct Ticket {
    pub value: String,
    ttl: Duration,
    base: Stamp,
    pub served: bool,
}

/// 对服务端给的有效期做一次合理性封顶：异常响应不能让壳把一张票当成长期有效。
const TICKET_TTL_SANITY_CAP: Duration = Duration::from_secs(600);

impl Ticket {
    /// `base` 取发出换票请求之前的本地时刻：服务端在这之后才开始计时，所以从这里算起
    /// 只会让票比实际更早失效，绝不会更晚
    pub fn new(value: String, ttl: Duration, base: Stamp) -> Self {
        Self { value, ttl: ttl.min(TICKET_TTL_SANITY_CAP), base, served: false }
    }

    /// 还没交出去、并且离过期还有足够余量——只有这种票能直接给页面
    pub fn usable(&self, now: Stamp) -> bool {
        !self.served && self.remaining_ms(now) > TICKET_MARGIN_MS
    }

    pub fn remaining_ms(&self, now: Stamp) -> u64 {
        self.ttl.saturating_sub(now.since(self.base)).as_millis() as u64
    }

    pub fn payload(&self, now: Stamp) -> TicketPayload {
        TicketPayload { ticket: self.value.clone(), ttl_ms: self.remaining_ms(now) }
    }
}

/// 把换票响应变成壳侧的票，`base` 是发出请求之前取的本地时刻。优先用服务端追加的相对有效期
/// `ttlMs`；响应里没有它（服务端尚未升级）时，有效期取「绝对到期时刻减 `base` 里的墙上时钟」，
/// 经过时间同样从 `base` 起算。本机时钟不跳变时这与旧算法等价，跳变时只会更严；
/// 但这条路在两端时钟有偏差时仍然不准。两条路共用同一个基准。
fn ticket_from_response(response: AttestResponse, base: Stamp) -> Ticket {
    let ttl_ms = response
        .ttl_ms
        .unwrap_or_else(|| response.expires_at.saturating_sub(base.wall_ms));
    Ticket::new(response.ticket, Duration::from_millis(ttl_ms), base)
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
    /// 服务端时钟的绝对毫秒；只在没有 `ttlMs` 时作为退路
    expires_at: u64,
    /// 票还剩多久有效（毫秒），较新的服务端才有。解析不了（不是不小于 1 的数）就当没有，
    /// 退回 `expiresAt`，不让一个字段的形状毁掉整次换票；小数向下取整。移动桥脚本同口径。
    #[serde(default, deserialize_with = "lenient_ttl_ms")]
    ttl_ms: Option<u64>,
    #[serde(default)]
    outdated: bool,
}

fn lenient_ttl_ms<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(value
        .as_f64()
        .filter(|ms| ms.is_finite() && *ms >= 1.0)
        .map(|ms| ms.floor() as u64))
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

    let url = format!("{}{}", crate::config::api_base(), ATTEST_PATH);
    exchange_ticket(
        &url,
        &AttestRequest {
            client_id: &client_id,
            challenge: &challenge.challenge,
            signature: &signature,
            client_type: device::CLIENT_TYPE,
            client_version: crate::config::client_version(),
            self_check: report,
        },
    )
}

/// 发换票请求并把响应变成票。地址由调用方给，测试才能把它指到本机的模拟服务端。
fn exchange_ticket(url: &str, request: &AttestRequest) -> Result<Ticket, ApiError> {
    // 基准时刻必须在发出请求**之前**取：服务端的票从它处理请求那刻起计时，那一刻一定晚于这里，
    // 所以从这里算起只会让壳眼里的票比实际更早到期。响应回来再取，就把服务端处理与回程的
    // 耗时全算进了票的寿命，慢网下会把快过期的票当成新鲜的交给页面。
    let base = Stamp::now();
    let response: AttestResponse = http::post_json_to(url, ATTEST_PATH, request, HTTP_TIMEOUT)?;
    if response.ticket.trim().is_empty() {
        return Err(ApiError::local("服务端返回的票据为空"));
    }
    if response.outdated {
        // 版本门槛由服务端在握手时执行（CLIENT_OUTDATED）；壳只如实记录，不自作主张拦玩家
        eprintln!(
            "本次构建版本 {} 低于服务端最低支持版本，反作弊房会被拒",
            crate::config::client_version()
        );
    }
    Ok(ticket_from_response(response, base))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 票的一次性与时效：已交出去的票绝不再给出，临近过期的票当作没有
    #[test]
    fn ticket_usability() {
        let now = Stamp::now();
        let fresh = Ticket::new("t".into(), Duration::from_secs(30), now);
        assert!(fresh.usable(now));
        assert!(
            !fresh.usable(later(now, 26, 26)),
            "离过期不足余量后不得再交出去"
        );
        let handed_out = Ticket { served: true, ..fresh.clone() };
        assert!(!handed_out.usable(now), "一次性票不得二次给出");
    }

    /// 测试用：两种时钟各自前进指定秒数（模拟休眠、改时间）
    fn later(base: Stamp, mono_secs: u64, wall_secs: u64) -> Stamp {
        Stamp {
            mono: base.mono + Duration::from_secs(mono_secs),
            wall_ms: base.wall_ms + wall_secs * 1000,
        }
    }

    fn response(json: &str) -> AttestResponse {
        serde_json::from_str(json).expect("换票响应应能解析")
    }

    /// 服务端的绝对到期时刻属于服务端的时钟：本机时钟快慢都不能影响票的可用判定。
    /// 墙上时钟取远大于或远小于 `expiresAt` 两种偏差，结果必须一样。
    #[test]
    fn ticket_expiry_ignores_the_local_wall_clock() {
        let server_expires_at = 5_000_000u64;
        let body = format!(r#"{{"ticket":"t","expiresAt":{server_expires_at},"ttlMs":30000}}"#);
        let received = Stamp::now();
        for wall_now in [server_expires_at - 30_000, server_expires_at + 3_600_000, 1] {
            let base = Stamp { wall_ms: wall_now, ..received };
            let ticket = ticket_from_response(response(&body), base);
            assert!(ticket.usable(base), "墙上时钟 {wall_now} 不该让新票失效");
            assert!(
                !ticket.usable(later(base, 26, 26)),
                "按相对有效期，离过期不足余量后不得再交出去"
            );
            assert_eq!(ticket.remaining_ms(base), 30_000);
        }
    }

    /// 系统休眠时单调时钟可能不走：墙上时钟的差值照走，票因此作废，不会把睡前签的票交出去
    #[test]
    fn sleeping_through_the_ttl_invalidates_the_ticket() {
        let received = Stamp::now();
        let ticket = Ticket::new("t".into(), Duration::from_secs(30), received);
        assert!(!ticket.usable(later(received, 1, 600)), "休眠十分钟后的票必须作废");
        // 墙上时钟被改回去（差值为负）不能让票起死回生，也不能把好票判废
        let rewound = Stamp { mono: received.mono + Duration::from_secs(2), wall_ms: 0 };
        assert!(ticket.usable(rewound), "时钟回拨只应按单调时钟算");
    }

    /// 没有 ttlMs 的响应（旧服务端）退回绝对时刻算法：行为与改动前一致，不报错
    #[test]
    fn response_without_ttl_falls_back_to_absolute_expiry() {
        let body = r#"{"ticket":"t","expiresAt":1030000,"outdated":true}"#;
        let received = Stamp { wall_ms: 1_000_000, ..Stamp::now() };
        let ticket = ticket_from_response(response(body), received);
        assert_eq!(ticket.remaining_ms(received), 30_000);
        assert!(ticket.usable(received));
    }

    /// 响应在慢网下晚到：有效期要从「发出请求之前」算起，晚到的那段时间不能算进票的寿命里。
    /// 服务端的票从处理请求那刻起就开始计时，壳若从收到响应才起算，会把票看得比实际新鲜。
    /// 延迟取固定值，断言只依赖「剩余不超过 ttl 减延迟」，与机器快慢无关。
    #[test]
    fn ttl_counts_from_before_the_request_is_sent() {
        let delay = Duration::from_millis(400);
        let origin = http::tests::delayed_json_server(
            delay,
            r#"{"ticket":"t","expiresAt":1,"ttlMs":30000}"#,
        );
        let report = SelfCheckReport {
            hard_fail: Vec::new(),
            soft_fail: Vec::new(),
            key_protection: selfcheck::KeyProtection::Software,
        };
        let request = AttestRequest {
            client_id: "ccd_x",
            challenge: "ccd_x.nonce.1",
            signature: "AAA",
            client_type: device::CLIENT_TYPE,
            client_version: "0.1.0",
            self_check: &report,
        };
        let ticket = exchange_ticket(&format!("{origin}{ATTEST_PATH}"), &request)
            .unwrap_or_else(|e| panic!("换票应成功：{}", e.text()));
        let limit = 30_000 - delay.as_millis() as u64;
        let remaining = ticket.remaining_ms(Stamp::now());
        assert!(remaining <= limit, "剩余 {remaining} ms 超过 {limit} ms：晚到的响应被算成了票的寿命");
    }

    /// 没有 ttlMs 的旧服务端：有效期取绝对到期减「发出前」的墙上时钟，经过时间也从发出前起算
    #[test]
    fn fallback_expiry_counts_from_before_the_request_is_sent() {
        let delay = Duration::from_millis(400);
        let wall = now_ms();
        let body: &'static str = Box::leak(
            format!(r#"{{"ticket":"t","expiresAt":{}}}"#, wall + 30_000).into_boxed_str(),
        );
        let origin = http::tests::delayed_json_server(delay, body);
        let report = SelfCheckReport {
            hard_fail: Vec::new(),
            soft_fail: Vec::new(),
            key_protection: selfcheck::KeyProtection::Software,
        };
        let request = AttestRequest {
            client_id: "ccd_x",
            challenge: "ccd_x.nonce.1",
            signature: "AAA",
            client_type: device::CLIENT_TYPE,
            client_version: "0.1.0",
            self_check: &report,
        };
        let ticket = exchange_ticket(&format!("{origin}{ATTEST_PATH}"), &request)
            .unwrap_or_else(|e| panic!("换票应成功：{}", e.text()));
        let limit = 30_000 - delay.as_millis() as u64;
        let remaining = ticket.remaining_ms(Stamp::now());
        assert!(remaining <= limit, "剩余 {remaining} ms 超过 {limit} ms");
    }

    /// ttlMs 的形状不对（字符串、负数、零、空、小数）不能让整次换票失败：
    /// 不小于 1 的数才采用（小数向下取整），其余当作没有，退回 expiresAt
    #[test]
    fn malformed_ttl_is_treated_as_absent() {
        for bad in [r#""30000""#, "-5", "0", "null", "0.5", "[]"] {
            let body = format!(r#"{{"ticket":"t","expiresAt":1004000,"ttlMs":{bad}}}"#);
            let parsed = response(&body);
            assert_eq!(parsed.ttl_ms, None, "ttlMs={bad} 应当作没有");
            let base = Stamp { wall_ms: 1_000_000, ..Stamp::now() };
            let ticket = ticket_from_response(parsed, base);
            assert_eq!(ticket.remaining_ms(base), 4_000, "ttlMs={bad} 应退回 expiresAt");
        }
        let fractional = response(r#"{"ticket":"t","expiresAt":1,"ttlMs":30000.7}"#);
        assert_eq!(fractional.ttl_ms, Some(30_000));
        let normal = response(r#"{"ticket":"t","expiresAt":1,"ttlMs":30000}"#);
        assert_eq!(normal.ttl_ms, Some(30_000));
    }

    /// 异常的超长有效期要封顶，壳不会把一张票当成长期有效
    #[test]
    fn absurd_ttl_is_capped() {
        let body = r#"{"ticket":"t","expiresAt":1,"ttlMs":9999999999}"#;
        let received = Stamp::now();
        let ticket = ticket_from_response(response(body), received);
        assert_eq!(ticket.remaining_ms(received), TICKET_TTL_SANITY_CAP.as_millis() as u64);
    }

    /// 交给页面的是相对量，字段名是桥接脚本读的契约
    #[test]
    fn payload_carries_remaining_time_only() {
        let now = Stamp::now();
        let ticket = Ticket::new("t".into(), Duration::from_secs(30), now);
        let value = serde_json::to_value(ticket.payload(later(now, 10, 10)))
            .expect("票据载荷应能序列化");
        assert_eq!(value["ticket"], "t");
        assert_eq!(value["ttlMs"], 20_000);
        assert!(value.get("expiresAt").is_none(), "绝对时刻不再交给页面");
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
