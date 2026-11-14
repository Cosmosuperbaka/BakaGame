//! 腾讯云 HTTPDNS：壳内 API 与 WebView 转发隧道共用的域名解析。
//!
//! 解析结果按 TTL 缓存；HTTPDNS 超时、无结果或填写错误时回落到系统 DNS，并在日志里
//! 标 `degraded=true`。回落后仍然只连域名对应的 IP，TLS 证书校验与 SNI 由下层客户端按
//! 原域名完成，本模块不接触 TLS 会话。
//!
//! 密钥在构建期注入（`option_env!`），仓库里只有变量名与占位说明：
//! - AES 模式：`BAKA_HTTPDNS_APP_ID` + `BAKA_HTTPDNS_SECRET_KEY`（16 位 AES 密钥）
//! - HTTPS Token 模式：`BAKA_HTTPDNS_TOKEN`（优先于 AES 模式）
//! - `BAKA_HTTPDNS_DOMAIN` 可选，缺省取站点与接口基址的 host。
//!
//! 两种模式都走腾讯云的固定 IP 入口，不依赖系统 DNS 去解析 DNS 服务本身。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{IpAddr, SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use aes::cipher::block_padding::Pkcs7;
use aes::cipher::generic_array::GenericArray;
use aes::cipher::{BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use cbc::{Decryptor, Encryptor};
use rand_core::RngCore;

const HTTP_ENDPOINT: &str = "http://119.29.29.98/d";
const HTTPS_ENDPOINT: &str = "https://119.29.29.99/d";
const QUERY_TIMEOUT: Duration = Duration::from_millis(1500);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const DEFAULT_TTL_SECS: u32 = 60;
/// 上限防止服务端下发一个过长的 TTL 让解析结果永久滞留
const MAX_TTL_SECS: u32 = 3600;
/// 真实应答只有几十字节；与安卓壳取同一个上限，数值由共享向量文件对账
const MAX_RESPONSE_BYTES: usize = 8 * 1024;
const CACHE_LOG_INTERVAL: Duration = Duration::from_secs(5);

const BUILD_APP_ID: &str = match option_env!("BAKA_HTTPDNS_APP_ID") {
    Some(value) => value,
    None => "",
};
const BUILD_SECRET_KEY: &str = match option_env!("BAKA_HTTPDNS_SECRET_KEY") {
    Some(value) => value,
    None => "",
};
const BUILD_TOKEN: &str = match option_env!("BAKA_HTTPDNS_TOKEN") {
    Some(value) => value,
    None => "",
};
const BUILD_DOMAIN: &str = match option_env!("BAKA_HTTPDNS_DOMAIN") {
    Some(value) => value,
    None => "",
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolutionSource {
    HttpDns,
    Cache,
    System,
    SystemFallback,
}

#[derive(Debug, Clone)]
pub struct Resolution {
    pub addrs: Vec<SocketAddr>,
    pub source: ResolutionSource,
    pub ttl: Option<u32>,
    pub elapsed: Duration,
    pub degraded: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct Config {
    pub(crate) app_id: String,
    pub(crate) secret_key: String,
    pub(crate) token: String,
    pub(crate) endpoint: String,
    pub(crate) domains: Vec<String>,
    pub(crate) timeout: Duration,
}

impl Config {
    /// 从构建期注入的密钥与运行期站点配置组装。缺密钥、密钥长度不对或没有域名时返回 `None`。
    pub(crate) fn from_build() -> Option<Self> {
        let token = BUILD_TOKEN.trim().to_string();
        let app_id = BUILD_APP_ID.trim().to_string();
        let secret_key = BUILD_SECRET_KEY.trim().to_string();

        let (endpoint, app_id, secret_key) = if !token.is_empty() {
            (HTTPS_ENDPOINT.to_string(), String::new(), String::new())
        } else if !app_id.is_empty() && secret_key.len() == 16 {
            (HTTP_ENDPOINT.to_string(), app_id, secret_key)
        } else {
            if !app_id.is_empty() || !secret_key.is_empty() {
                eprintln!(
                    "[baka-httpdns] disabled reason=incomplete-credentials：\
                     需要 BAKA_HTTPDNS_APP_ID + 16 位 BAKA_HTTPDNS_SECRET_KEY，或 BAKA_HTTPDNS_TOKEN"
                );
            }
            return None;
        };

        let mut domains = Vec::new();
        push_domain(&mut domains, BUILD_DOMAIN);
        for base in [crate::config::site_url(), crate::config::api_base()] {
            if let Ok(url) = reqwest::Url::parse(&base) {
                if let Some(host) = url.host_str() {
                    push_domain(&mut domains, host);
                }
            }
        }
        if domains.is_empty() {
            eprintln!("[baka-httpdns] disabled reason=no-domain");
            return None;
        }
        Some(Self {
            app_id,
            secret_key,
            token,
            endpoint,
            domains,
            timeout: QUERY_TIMEOUT,
        })
    }

    fn is_managed(&self, host: &str) -> bool {
        let host = normalize_host(host);
        self.domains.iter().any(|domain| domain == &host)
    }
}

fn push_domain(domains: &mut Vec<String>, raw: &str) {
    let host = normalize_host(raw);
    if host.is_empty() {
        return;
    }
    if !domains.iter().any(|domain| domain == &host) {
        domains.push(host);
    }
}

fn normalize_host(raw: &str) -> String {
    raw.trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_ascii_lowercase()
}

struct CacheEntry {
    ips: Vec<IpAddr>,
    ttl: u32,
    expires_at: Instant,
}

impl CacheEntry {
    fn is_fresh(&self, now: Instant) -> bool {
        now < self.expires_at
    }

    fn remaining_secs(&self, now: Instant) -> u32 {
        self.expires_at
            .saturating_duration_since(now)
            .as_secs()
            .max(1) as u32
    }
}

pub struct HttpDnsResolver {
    config: Config,
    cache: Mutex<HashMap<String, CacheEntry>>,
    /// 同一时刻只让一个 HTTPDNS 往返在跑；命中缓存的请求不受影响。
    query_gate: Mutex<()>,
    last_cache_log: Mutex<Instant>,
}

impl HttpDnsResolver {
    pub(crate) fn new(config: Config) -> Self {
        let now = Instant::now();
        Self {
            config,
            cache: Mutex::new(HashMap::new()),
            query_gate: Mutex::new(()),
            last_cache_log: Mutex::new(now.checked_sub(CACHE_LOG_INTERVAL).unwrap_or(now)),
        }
    }

    pub fn is_managed(&self, host: &str) -> bool {
        self.config.is_managed(host)
    }

    /// 解析 `host`；受管域名走 HTTPDNS，其它域名直接走系统 DNS。
    /// 受管域名失败时回落系统 DNS 并返回 `degraded`，不把错误抛给调用方。
    pub fn resolve(&self, host: &str, port: u16) -> Result<Resolution, String> {
        let host = normalize_host(host);
        if host.is_empty() {
            return Err("域名为空".to_string());
        }
        let started = Instant::now();
        if !self.config.is_managed(&host) {
            let addrs = system_resolve(&host, port)?;
            return Ok(Resolution {
                addrs,
                source: ResolutionSource::System,
                ttl: None,
                elapsed: started.elapsed(),
                degraded: None,
            });
        }

        if let Some(hit) = self.cached(&host, port, started) {
            return Ok(hit);
        }

        let _gate = self.query_gate.lock().map_err(|_| "HTTPDNS 查询锁已损坏".to_string())?;
        // 等锁期间可能已有别的线程把结果写进缓存
        if let Some(hit) = self.cached(&host, port, started) {
            return Ok(hit);
        }

        match self.query(&host) {
            Ok((ips, ttl)) => {
                let expires_at = Instant::now() + Duration::from_secs(ttl as u64);
                if let Ok(mut cache) = self.cache.lock() {
                    cache.insert(
                        host.clone(),
                        CacheEntry { ips: ips.clone(), ttl, expires_at },
                    );
                }
                let addrs = with_port(&ips, port);
                let elapsed = started.elapsed();
                eprintln!(
                    "[baka-httpdns] source=httpdns host={host} ips={} ttl={ttl}s took={}ms",
                    render_ips(&ips),
                    elapsed.as_millis()
                );
                Ok(Resolution {
                    addrs,
                    source: ResolutionSource::HttpDns,
                    ttl: Some(ttl),
                    elapsed,
                    degraded: None,
                })
            }
            Err(err) => {
                let fallback = system_resolve(&host, port);
                let elapsed = started.elapsed();
                match fallback {
                    Ok(addrs) => {
                        eprintln!(
                            "[baka-httpdns] degraded=true host={host} reason={err} \
                             fallback=system ips={} ttl=- took={}ms",
                            render_addrs(&addrs),
                            elapsed.as_millis()
                        );
                        Ok(Resolution {
                            addrs,
                            source: ResolutionSource::SystemFallback,
                            ttl: None,
                            elapsed,
                            degraded: Some(err),
                        })
                    }
                    Err(system_err) => Err(format!(
                        "HTTPDNS 失败（{err}），系统 DNS 也失败（{system_err}）"
                    )),
                }
            }
        }
    }

    fn cached(&self, host: &str, port: u16, started: Instant) -> Option<Resolution> {
        let (ips, ttl, remaining) = {
            let cache = self.cache.lock().ok()?;
            let entry = cache.get(host)?;
            let now = Instant::now();
            if !entry.is_fresh(now) {
                return None;
            }
            (entry.ips.clone(), entry.ttl, entry.remaining_secs(now))
        };
        let elapsed = started.elapsed();
        if let Ok(mut last) = self.last_cache_log.lock() {
            if last.elapsed() >= CACHE_LOG_INTERVAL {
                *last = Instant::now();
                eprintln!(
                    "[baka-httpdns] source=cache host={host} ips={} ttl={}s took={}ms",
                    render_ips(&ips),
                    remaining,
                    elapsed.as_millis()
                );
            }
        }
        Some(Resolution {
            addrs: with_port(&ips, port),
            source: ResolutionSource::Cache,
            ttl: Some(remaining.min(ttl.max(1))),
            elapsed,
            degraded: None,
        })
    }

    fn query(&self, host: &str) -> Result<(Vec<IpAddr>, u32), String> {
        let (query, encrypted) = if !self.config.token.is_empty() {
            (format!("dn={host}&token={}&ttl=1&timeout=1500", self.config.token), false)
        } else {
            let encrypted = encrypt_domain(host, &self.config.secret_key)?;
            (
                format!(
                    "dn={encrypted}&id={}&alg=aes&ttl=1&timeout=1500",
                    self.config.app_id
                ),
                true,
            )
        };
        let body = get(&self.config.endpoint, &query, self.config.timeout)?;
        let plain = if encrypted {
            decrypt_answer(&body, &self.config.secret_key)?
        } else {
            body.trim().to_string()
        };
        parse_answer(&plain)
    }
}

fn system_resolve(host: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
    (host, port)
        .to_socket_addrs()
        .map(|addrs| addrs.collect())
        .map_err(|err| format!("系统 DNS 解析 {host} 失败：{err}"))
}

fn with_port(ips: &[IpAddr], port: u16) -> Vec<SocketAddr> {
    ips.iter().map(|ip| SocketAddr::new(*ip, port)).collect()
}

fn render_ips(ips: &[IpAddr]) -> String {
    ips.iter().map(ToString::to_string).collect::<Vec<_>>().join(",")
}

fn render_addrs(addrs: &[SocketAddr]) -> String {
    addrs.iter().map(ToString::to_string).collect::<Vec<_>>().join(",")
}

/// 解析腾讯云应答：`ip;ip,ttl`，可能带 ` | 客户端IP`。空应答按失败处理。
fn parse_answer(answer: &str) -> Result<(Vec<IpAddr>, u32), String> {
    let answer = answer.trim();
    if answer.is_empty() {
        return Err("HTTPDNS 返回空结果".to_string());
    }
    let answer = answer.split('|').next().unwrap_or(answer).trim();
    let (ips_part, ttl) = match answer.rsplit_once(',') {
        Some((left, right)) => match right.trim().parse::<u32>() {
            Ok(ttl) => (left, Some(ttl)),
            Err(_) => (answer, None),
        },
        None => (answer, None),
    };
    let ips: Vec<IpAddr> = ips_part
        .split(';')
        .filter_map(|part| part.trim().parse::<IpAddr>().ok())
        .collect();
    if ips.is_empty() {
        return Err(format!("HTTPDNS 应答里没有合法 IP：{ips_part}"));
    }
    let ttl = ttl.unwrap_or(DEFAULT_TTL_SECS).clamp(1, MAX_TTL_SECS);
    Ok((ips, ttl))
}

fn encrypt_domain(domain: &str, key: &str) -> Result<String, String> {
    let mut iv = [0u8; 16];
    rand_core::OsRng.fill_bytes(&mut iv);
    encrypt_with_iv(domain, key, &iv)
}

fn encrypt_with_iv(domain: &str, key: &str, iv: &[u8; 16]) -> Result<String, String> {
    let key = key_bytes(key)?;
    let mut buffer = vec![0u8; domain.len() + 16];
    buffer[..domain.len()].copy_from_slice(domain.as_bytes());
    let cipher = Encryptor::<aes::Aes128>::new(
        GenericArray::from_slice(&key),
        GenericArray::from_slice(iv),
    );
    let ciphertext = cipher
        .encrypt_padded_mut::<Pkcs7>(&mut buffer, domain.len())
        .map_err(|_| "HTTPDNS 域名加密失败".to_string())?;
    let mut out = Vec::with_capacity(16 + ciphertext.len());
    out.extend_from_slice(iv);
    out.extend_from_slice(ciphertext);
    Ok(hex::encode(out))
}

fn decrypt_answer(answer: &str, key: &str) -> Result<String, String> {
    let raw = hex::decode(answer.trim()).map_err(|err| format!("HTTPDNS 应答不是十六进制：{err}"))?;
    if raw.len() <= 16 || (raw.len() - 16) % 16 != 0 {
        return Err("HTTPDNS 加密应答长度不合法".to_string());
    }
    let key = key_bytes(key)?;
    let mut ciphertext = raw[16..].to_vec();
    let cipher = Decryptor::<aes::Aes128>::new(
        GenericArray::from_slice(&key),
        GenericArray::from_slice(&raw[..16]),
    );
    let plaintext = cipher
        .decrypt_padded_mut::<Pkcs7>(&mut ciphertext)
        .map_err(|_| "HTTPDNS 应答解密失败".to_string())?;
    String::from_utf8(plaintext.to_vec()).map_err(|err| format!("HTTPDNS 应答不是 UTF-8：{err}"))
}

fn key_bytes(key: &str) -> Result<[u8; 16], String> {
    key.as_bytes()
        .try_into()
        .map_err(|_| "HTTPDNS AES 密钥必须是 16 字节".to_string())
}

/// 这一轮（换到下一个地址之前）还剩多少时间：已过截止时间返回 `None`，调用方就此退出；
/// 否则返回这个地址的建连超时，取「固定建连超时」与「剩余时间」里较小的一个，
/// 多个地址都慢时总耗时才不会累加成「地址数 × 建连超时」
fn attempt_budget(now: Instant, deadline: Instant, connect_timeout: Duration) -> Option<Duration> {
    let remaining = deadline.checked_duration_since(now)?;
    (!remaining.is_zero()).then(|| connect_timeout.min(remaining))
}

/// 明文 HTTP 与 HTTPS 各一条路径；两条都使用系统 CA 校验服务端证书。
fn get(endpoint: &str, query: &str, timeout: Duration) -> Result<String, String> {
    let separator = if endpoint.contains('?') { '&' } else { '?' };
    let url = format!("{endpoint}{separator}{query}");
    let parsed = reqwest::Url::parse(&url).map_err(|err| format!("HTTPDNS 地址非法：{err}"))?;
    let host = parsed.host_str().ok_or("HTTPDNS 地址没有 host")?.to_string();
    let port = parsed.port_or_known_default().ok_or("HTTPDNS 地址没有端口")?;
    let target = match parsed.query() {
        Some(query) => format!("{}?{}", parsed.path(), query),
        None => parsed.path().to_string(),
    };
    let addresses: Vec<SocketAddr> = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|err| format!("连接 HTTPDNS 服务失败：{err}"))?
        .collect();
    // 整个往返（连接、握手、收发）共用一个截止时间：连接要等多久、握手慢不慢都算在里面
    let deadline = Instant::now() + timeout.saturating_mul(2);
    let mut last_error = String::from("HTTPDNS 地址没有可用 IP");
    for address in addresses {
        // 每个地址的建连、握手、收发都不能越过同一个截止时间
        let Some(budget) = attempt_budget(Instant::now(), deadline, CONNECT_TIMEOUT) else {
            last_error = "HTTPDNS 请求超过总时限".to_string();
            break;
        };
        let stream = match TcpStream::connect_timeout(&address, budget) {
            Ok(stream) => stream,
            Err(err) => {
                last_error = format!("连接 {address} 失败：{err}");
                continue;
            }
        };
        // 握手阶段只受这两个读写超时约束，所以也要按剩余时间收紧
        let io_timeout = timeout.min(deadline.saturating_duration_since(Instant::now()));
        if io_timeout.is_zero() {
            last_error = "HTTPDNS 请求超过总时限".to_string();
            break;
        }
        let _ = stream.set_read_timeout(Some(io_timeout));
        let _ = stream.set_write_timeout(Some(io_timeout));
        let result = if parsed.scheme() == "https" {
            let connector = native_tls::TlsConnector::new()
                .map_err(|err| format!("TLS 初始化失败：{err}"))?;
            // 握手失败只是这个地址不可用，换下一个地址再试，不整体放弃
            match connector.connect(&host, stream) {
                Ok(tls) => send_http(tls, &host, Some(port), &target, deadline),
                Err(err) => Err(format!("HTTPDNS TLS 握手失败：{err}")),
            }
        } else {
            send_http(stream, &host, Some(port), &target, deadline)
        };
        match result {
            Ok(body) => return Ok(body),
            Err(err) => last_error = err,
        }
    }
    Err(last_error)
}

fn send_http<S: Read + Write>(
    mut stream: S,
    host: &str,
    port: Option<u16>,
    target: &str,
    deadline: Instant,
) -> Result<String, String> {
    let host_header = match port {
        Some(80) | Some(443) | None => host.to_string(),
        Some(port) => format!("{host}:{port}"),
    };
    let request = format!(
        "GET {target} HTTP/1.1\r\nHost: {host_header}\r\nConnection: close\r\nAccept: */*\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|err| format!("发送 HTTPDNS 请求失败：{err}"))?;
    stream
        .flush()
        .map_err(|err| format!("发送 HTTPDNS 请求失败：{err}"))?;
    let mut response = Vec::new();
    let mut buffer = [0u8; 4096];
    loop {
        // 单次读超时只管「一次读多久没数据」，慢速滴灌能让每次读都在超时内到达一点数据；
        // 整个往返的总时限才是兜底，否则它能长期占住查询闸门，让所有受管域名的新解析排队
        if Instant::now() >= deadline {
            return Err("HTTPDNS 应答超过总时限".to_string());
        }
        let read = stream
            .read(&mut buffer)
            .map_err(|err| format!("读取 HTTPDNS 应答失败：{err}"))?;
        if read == 0 {
            break;
        }
        if response.len() + read > MAX_RESPONSE_BYTES {
            return Err("HTTPDNS 应答过大".to_string());
        }
        response.extend_from_slice(&buffer[..read]);
    }
    parse_response(&response)
}

/// 解析一个完整的 HTTP 应答：检查状态行，按 `Transfer-Encoding: chunked` 还原分块，
/// 按 `Content-Length` 校验应答体没有被截断，取出应答体。
fn parse_response(response: &[u8]) -> Result<String, String> {
    let split = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "HTTPDNS 应答缺少响应头".to_string())?;
    let head = String::from_utf8_lossy(&response[..split]);
    let mut lines = head.lines();
    let status = lines.next().unwrap_or_default();
    if !(status.starts_with("HTTP/1.1 200") || status.starts_with("HTTP/1.0 200")) {
        return Err(format!("HTTPDNS 返回非 200：{status}"));
    }
    let mut chunked = false;
    let mut content_length: Option<usize> = None;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        match name.trim().to_ascii_lowercase().as_str() {
            "transfer-encoding" if value.to_ascii_lowercase().contains("chunked") => chunked = true,
            "content-length" => content_length = value.trim().parse().ok(),
            _ => {}
        }
    }
    let raw_body = &response[split + 4..];
    let payload = if chunked {
        decode_chunked(raw_body)?
    } else {
        match content_length {
            Some(length) if raw_body.len() < length => {
                return Err("HTTPDNS 应答体被截断".to_string());
            }
            Some(length) => raw_body[..length].to_vec(),
            None => raw_body.to_vec(),
        }
    };
    String::from_utf8(payload).map_err(|err| format!("HTTPDNS 应答不是 UTF-8：{err}"))
}

/// 还原 `Transfer-Encoding: chunked` 的应答体：十六进制块长（可带 `;扩展`）+ 块数据，
/// 以长度 0 的块结束，其后的尾部头忽略；任何一块缺失或块后缺 CRLF 都当作损坏
fn decode_chunked(mut body: &[u8]) -> Result<Vec<u8>, String> {
    const BAD: &str = "HTTPDNS 分块应答损坏";
    let mut out = Vec::new();
    loop {
        let line_end = body
            .windows(2)
            .position(|window| window == b"\r\n")
            .ok_or_else(|| BAD.to_string())?;
        let size_text = std::str::from_utf8(&body[..line_end]).map_err(|_| BAD.to_string())?;
        let size_text = size_text.split(';').next().unwrap_or_default().trim();
        let size = usize::from_str_radix(size_text, 16).map_err(|_| BAD.to_string())?;
        body = &body[line_end + 2..];
        if size == 0 {
            return Ok(out);
        }
        // 块长来自对端：用带检查的加法，避免超大块长在加 2 时溢出
        let end = size.checked_add(2).filter(|end| *end <= body.len());
        let Some(end) = end.filter(|end| &body[end - 2..*end] == b"\r\n") else {
            return Err(BAD.to_string());
        };
        out.extend_from_slice(&body[..size]);
        body = &body[end..];
    }
}

/// 给 reqwest 用的适配器；返回端口 0，由 hyper 按 URL 方案补 80/443。
pub struct ReqwestResolver {
    inner: Arc<HttpDnsResolver>,
}

impl ReqwestResolver {
    pub fn new(inner: Arc<HttpDnsResolver>) -> Self {
        Self { inner }
    }
}

type DnsError = Box<dyn std::error::Error + Send + Sync>;

fn dns_error(kind: std::io::ErrorKind, message: impl ToString) -> DnsError {
    Box::new(std::io::Error::new(kind, message.to_string()))
}

impl reqwest::dns::Resolve for ReqwestResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        let inner = self.inner.clone();
        Box::pin(async move {
            // `HttpDnsResolver::resolve` 是为线程模型的回环隧道写的同步实现：缓存过期时会持
            // 查询闸门做一次最长数秒的 TCP/TLS 往返。直接在这里调用会占住轮询本 Future 的
            // 反应堆线程，同线程上的其它请求跟着卡住，所以整个解析交给阻塞线程池。
            let joined = tauri::async_runtime::spawn_blocking(move || inner.resolve(&host, 0))
                .await
                .map_err(|err| dns_error(std::io::ErrorKind::Other, err))?;
            let resolution = joined.map_err(|err| dns_error(std::io::ErrorKind::Other, err))?;
            let addrs: Vec<SocketAddr> = resolution
                .addrs
                .into_iter()
                .map(|mut addr| {
                    addr.set_port(0);
                    addr
                })
                .collect();
            if addrs.is_empty() {
                return Err(dns_error(
                    std::io::ErrorKind::NotFound,
                    "HTTPDNS 没有返回地址",
                ));
            }
            Ok(Box::new(addrs.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

static SHARED: OnceLock<Option<Arc<HttpDnsResolver>>> = OnceLock::new();

/// 进程内共享的解析器；未配置密钥时返回 `None`，壳保持原来的系统 DNS 行为。
pub fn shared() -> Option<Arc<HttpDnsResolver>> {
    SHARED
        .get_or_init(|| {
            let config = Config::from_build()?;
            eprintln!(
                "[baka-httpdns] enabled domains={} mode={} endpoint={}",
                config.domains.join(","),
                if config.token.is_empty() { "aes" } else { "https-token" },
                config.endpoint
            );
            Some(Arc::new(HttpDnsResolver::new(config)))
        })
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::pin::Pin;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const KEY: &str = "0123456789abcdef";

    #[test]
    fn parses_ttl_and_client_ip() {
        let (ips, ttl) = parse_answer("1.2.3.4;5.6.7.8,120 | 9.9.9.9").unwrap();
        assert_eq!(
            ips,
            vec![
                "1.2.3.4".parse::<IpAddr>().unwrap(),
                "5.6.7.8".parse::<IpAddr>().unwrap()
            ]
        );
        assert_eq!(ttl, 120);

        let (ips, ttl) = parse_answer("1.2.3.4;5.6.7.8").unwrap();
        assert_eq!(ips.len(), 2);
        assert_eq!(ttl, DEFAULT_TTL_SECS);
    }

    /// 与安卓壳共用的向量：同一条应答两端必须给出同样的结果（已知分叉在向量里按端分别写明）。
    const SHARED_VECTORS: &str = include_str!("../tests/httpdns_vectors.tsv");

    fn render_expected(result: Result<(Vec<IpAddr>, u32), String>) -> String {
        match result {
            Ok((ips, ttl)) => format!(
                "ips={} ttl={ttl}",
                ips.iter().map(ToString::to_string).collect::<Vec<_>>().join(";")
            ),
            Err(_) => "error".to_string(),
        }
    }

    #[test]
    fn answers_match_shared_vectors() {
        let mut checked = 0;
        for line in SHARED_VECTORS.lines().map(|line| line.trim_end_matches('\r')) {
            let columns: Vec<&str> = line.split('\t').collect();
            if columns.first() != Some(&"case") {
                continue;
            }
            assert_eq!(columns.len(), 5, "向量格式不对：{line}");
            assert_eq!(
                render_expected(parse_answer(columns[2])),
                columns[3],
                "向量 {} 桌面端结果不符",
                columns[1]
            );
            checked += 1;
        }
        assert!(checked >= 10, "向量文件没读到足够的用例：{checked}");
    }

    #[test]
    fn limits_match_shared_vectors() {
        let limit = |name: &str| -> u64 {
            SHARED_VECTORS
                .lines()
                .map(|line| line.trim_end_matches('\r').split('\t').collect::<Vec<_>>())
                .find(|columns| columns.len() == 3 && columns[0] == "limit" && columns[1] == name)
                .unwrap_or_else(|| panic!("向量文件缺少常量 {name}"))[2]
                .parse()
                .unwrap()
        };
        assert_eq!(limit("maxResponseBytes"), MAX_RESPONSE_BYTES as u64);
        assert_eq!(limit("defaultTtlSeconds"), DEFAULT_TTL_SECS as u64);
        assert_eq!(limit("maxTtlSeconds"), MAX_TTL_SECS as u64);
        assert_eq!(limit("queryTimeoutMillis"), QUERY_TIMEOUT.as_millis() as u64);
    }

    #[test]
    fn rejects_empty_or_invalid_answers() {
        assert!(parse_answer("").is_err());
        assert!(parse_answer("no-such-ip,60").is_err());
    }

    /// 腾讯云文档里的 AES 请求示例：固定 IV 后密文必须逐字节一致。
    #[test]
    fn aes_request_matches_tencent_example() {
        let iv = hex::decode("68058d1967c6c8c9aa734dfc8a18ead9").unwrap();
        let iv: [u8; 16] = iv.try_into().unwrap();
        let encrypted = encrypt_with_iv("www.dnspod.cn", "dnspodaespasswrd", &iv).unwrap();
        assert_eq!(
            encrypted,
            "68058d1967c6c8c9aa734dfc8a18ead97a23bf3e8f011f6509a37ed2b25a1192"
        );
    }

    /// 腾讯云文档里的 AES 应答示例：解密后应得到五个 IP。
    #[test]
    fn aes_response_matches_tencent_example() {
        let answer = "f689db945693bde440729ec30fb3824c\
                      739838a72a30777b123dd1b8e0bb89de\
                      4c57d546e74f96ceab2664c3bb684850\
                      24339ad198675ac59e2cb5b60e726eb2\
                      34609ac1c7c0925449f3f505f22104e4\
                      8de7b2ee19aede451b09691c6826bea3";
        let plain = decrypt_answer(answer, "dnspodaespasswrd").unwrap();
        assert_eq!(
            plain,
            "112.30.175.208;117.148.128.189;117.163.48.119;36.150.211.79;111.48.99.206"
        );
    }

    fn mock_httpdns(answer: &str, hits: Arc<AtomicUsize>) -> String {
        mock_httpdns_with_delay(answer, hits, Duration::ZERO)
    }

    /// 收到请求后先等 `delay` 再回应，用来模拟慢的 HTTPDNS 往返
    fn mock_httpdns_with_delay(answer: &str, hits: Arc<AtomicUsize>, delay: Duration) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let answer = answer.to_string();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                hits.fetch_add(1, Ordering::SeqCst);
                let mut request = [0u8; 4096];
                let _ = stream.read(&mut request);
                std::thread::sleep(delay);
                let encrypted = encrypt_domain(&answer, KEY).unwrap();
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    encrypted.len(),
                    encrypted
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });
        format!("http://{address}/d")
    }

    fn resolver(endpoint: String, domains: Vec<&str>, timeout: Duration) -> HttpDnsResolver {
        HttpDnsResolver::new(Config {
            app_id: "12345".to_string(),
            secret_key: KEY.to_string(),
            token: String::new(),
            endpoint,
            domains: domains.into_iter().map(normalize_host).collect(),
            timeout,
        })
    }

    #[test]
    fn fetches_then_serves_from_cache() {
        let hits = Arc::new(AtomicUsize::new(0));
        let endpoint = mock_httpdns("203.0.113.10;203.0.113.11,120", hits.clone());
        let resolver = resolver(endpoint, vec!["game.example.com"], Duration::from_secs(1));

        let first = resolver.resolve("game.example.com", 443).unwrap();
        assert_eq!(first.source, ResolutionSource::HttpDns);
        assert_eq!(first.ttl, Some(120));
        assert_eq!(first.addrs.len(), 2);
        assert_eq!(first.addrs[0].port(), 443);

        let second = resolver.resolve("game.example.com", 443).unwrap();
        assert_eq!(second.source, ResolutionSource::Cache);
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn falls_back_to_system_dns_when_httpdns_is_down() {
        let resolver = resolver(
            "http://127.0.0.1:9/d".to_string(),
            vec!["localhost"],
            Duration::from_millis(300),
        );
        let resolution = resolver.resolve("localhost", 80).unwrap();
        assert_eq!(resolution.source, ResolutionSource::SystemFallback);
        assert!(resolution.degraded.is_some());
        assert!(!resolution.addrs.is_empty());
    }

    #[test]
    fn unknown_hosts_do_not_use_httpdns() {
        let resolver = resolver(
            "http://127.0.0.1:9/d".to_string(),
            vec!["game.example.com"],
            Duration::from_millis(300),
        );
        let resolution = resolver.resolve("localhost", 80).unwrap();
        assert_eq!(resolution.source, ResolutionSource::System);
        assert!(resolution.degraded.is_none());
    }

    /// 给 reqwest 的适配器不能在轮询它的线程上同步做 HTTPDNS 往返：
    /// 同一反应堆上的其它请求会被一并卡住。首次轮询必须立刻让出（Pending），
    /// 往返放到阻塞线程池里做，最终仍能拿到结果。
    #[test]
    fn reqwest_resolver_does_not_block_the_polling_thread() {
        use reqwest::dns::Resolve;
        use std::future::Future;
        use std::task::{Context, Poll, Waker};

        let hits = Arc::new(AtomicUsize::new(0));
        let endpoint =
            mock_httpdns_with_delay("203.0.113.10,120", hits.clone(), Duration::from_millis(600));
        let adapter = ReqwestResolver::new(Arc::new(resolver(
            endpoint,
            vec!["game.example.com"],
            Duration::from_secs(3),
        )));
        let name: reqwest::dns::Name = "game.example.com".parse().unwrap();

        let mut pending = adapter.resolve(name);
        let started = Instant::now();
        let first = Pin::new(&mut pending).poll(&mut Context::from_waker(Waker::noop()));
        assert!(
            started.elapsed() < Duration::from_millis(300),
            "首次轮询在同步等 HTTPDNS 往返：{:?}",
            started.elapsed()
        );
        assert!(matches!(first, Poll::Pending), "慢往返期间应当返回 Pending");

        let addrs = tauri::async_runtime::block_on(pending).expect("往返完成后应解析成功");
        let addrs: Vec<SocketAddr> = addrs.collect();
        assert_eq!(addrs.len(), 1);
        assert_eq!(addrs[0].ip(), "203.0.113.10".parse::<IpAddr>().unwrap());
        assert_eq!(addrs[0].port(), 0, "端口由 hyper 按 URL 方案补全");
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }

    fn http_200(headers: &str, body: &[u8]) -> Vec<u8> {
        let mut out = format!("HTTP/1.1 200 OK\r\n{headers}\r\n").into_bytes();
        out.extend_from_slice(body);
        out
    }

    /// 应答改用分块传输时要能还原应答体，而不是把分块框架当原文去解析
    #[test]
    fn chunked_response_body_is_decoded() {
        let body = b"7\r\n1.2.3.4\r\n8;ext=1\r\n;5.6.7.8\r\n4\r\n,120\r\n0\r\nX-Trailer: 1\r\n\r\n";
        let response = http_200("Transfer-Encoding: chunked\r\nConnection: close\r\n", body);
        assert_eq!(parse_response(&response).unwrap(), "1.2.3.4;5.6.7.8,120");

        let mixed = http_200("transfer-encoding: Chunked\r\n", b"3\r\nabc\r\n0\r\n\r\n");
        assert_eq!(parse_response(&mixed).unwrap(), "abc");
    }

    #[test]
    fn malformed_chunked_body_is_rejected() {
        for body in [
            &b"zz\r\nabc\r\n0\r\n\r\n"[..],
            b"5\r\nabc",
            b"3\r\nabcXX0\r\n\r\n",
            b"3\r\nabc\r\n",
            b"ffffffffffffffff\r\nabc\r\n0\r\n\r\n",
        ] {
            let response = http_200("Transfer-Encoding: chunked\r\n", body);
            assert!(
                parse_response(&response).is_err(),
                "{:?}",
                String::from_utf8_lossy(body)
            );
        }
    }

    /// 带 Content-Length 的应答体被截断时不能当成完整应答
    #[test]
    fn truncated_content_length_body_is_rejected() {
        let response = http_200("Content-Length: 10\r\n", b"1.2.3.4");
        assert!(parse_response(&response).is_err());
        let exact = http_200("Content-Length: 7\r\n", b"1.2.3.4");
        assert_eq!(parse_response(&exact).unwrap(), "1.2.3.4");
        let without = http_200("Connection: close\r\n", b"1.2.3.4");
        assert_eq!(parse_response(&without).unwrap(), "1.2.3.4");
    }

    /// 总时限管住建连：换地址前已过截止时间就不再尝试，建连超时不得超过剩余时间
    #[test]
    fn attempt_budget_respects_the_deadline() {
        let now = Instant::now();
        let connect = Duration::from_secs(3);
        // 时间充裕：用固定建连超时
        assert_eq!(
            attempt_budget(now, now + Duration::from_secs(10), connect),
            Some(connect)
        );
        // 剩余不足一个建连超时：只给剩余时间
        assert_eq!(
            attempt_budget(now, now + Duration::from_millis(800), connect),
            Some(Duration::from_millis(800))
        );
        // 已到或已过截止时间：不再继续
        assert_eq!(attempt_budget(now, now, connect), None);
        assert_eq!(
            attempt_budget(now + Duration::from_millis(1), now, connect),
            None
        );
    }

    #[test]
    fn non_200_and_headerless_responses_are_rejected() {
        assert!(parse_response(b"HTTP/1.1 503 Service Unavailable\r\n\r\n").is_err());
        assert!(parse_response(b"HTTP/1.1 200 OK\r\nContent-Length: 1").is_err());
    }

    /// 慢速滴灌：每次读都在单次超时内到达一点数据，也必须受整个往返的总时限约束，
    /// 否则它能长期占住查询闸门，让所有受管域名的新解析排队
    #[test]
    fn slow_drip_response_hits_the_total_deadline() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut request = [0u8; 4096];
                let _ = stream.read(&mut request);
                std::thread::spawn(move || {
                    let response = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n1.2.3.4;5.6.7.8";
                    for byte in response {
                        if stream.write_all(&[*byte]).is_err() {
                            return;
                        }
                        std::thread::sleep(Duration::from_millis(100));
                    }
                });
            }
        });
        let started = Instant::now();
        let result = get(
            &format!("http://{address}/d"),
            "dn=a",
            Duration::from_millis(300),
        );
        assert!(result.is_err(), "慢速滴灌的应答不该成功返回");
        assert!(
            started.elapsed() < Duration::from_millis(1500),
            "总时限没有生效：{:?}",
            started.elapsed()
        );
    }
}
