//! 只监听回环地址的 HTTPS 转发隧道：WebView2 的请求经这里按域名分流。
//!
//! 受管域名先问 HTTPDNS（失败则系统 DNS，并标降级），其它域名直接走系统 DNS。
//! 这里只做 CONNECT 隧道，TLS 由 WebView 端到端完成——证书校验和 SNI 仍然是原域名，
//! 代理看不到明文，也不提供任何「忽略证书错误」的开关。
//!
//! 单独起一个回环端口并把 WebView2 的 proxy 指过来，是为了让 hosts 被污染时页面本身
//! 也能打开，而不只是壳自己的三趟通道证明请求。

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crate::httpdns::HttpDnsResolver;

/// CONNECT 请求头只有几百字节，上限给足余量即可；计的是请求头整体（含请求行与各行换行）
const HEADER_LIMIT_BYTES: usize = 8 * 1024;
const HEADER_TIMEOUT: Duration = Duration::from_secs(10);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// 处于「读请求头、解析、连上游」阶段的连接数上限，用来挡住慢连接把处理线程占满。
/// 回 200 进入隧道之后名额即归还：已建立的隧道（对局的长连接）由页面自己的连接池约束，
/// 不能让悬挂的隧道一点点占满名额、把后来的新连接全部拒掉
const MAX_CONNECTIONS: usize = 128;

/// 启动隧道并返回回环地址；调用方把它交给 `WebviewWindowBuilder::proxy_url`。
pub fn start(resolver: Arc<HttpDnsResolver>) -> std::io::Result<SocketAddr> {
    start_with_limit(resolver, MAX_CONNECTIONS)
}

fn start_with_limit(
    resolver: Arc<HttpDnsResolver>,
    max_connections: usize,
) -> std::io::Result<SocketAddr> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let address = listener.local_addr()?;
    let active = Arc::new(AtomicUsize::new(0));
    std::thread::Builder::new()
        .name("baka-dns-proxy".to_string())
        .spawn(move || {
            for stream in listener.incoming() {
                match stream {
                    Ok(stream) => {
                        // 占位在接受线程里同步完成：这样连接数在新连接被处理之前就已计入，
                        // 上限不会被「线程还没起来」的间隙冲破
                        let Some(slot) = ConnectionSlot::acquire(&active, max_connections) else {
                            let _ = write_response(&stream, "503 Service Unavailable");
                            continue;
                        };
                        let resolver = resolver.clone();
                        std::thread::spawn(move || {
                            if let Err(err) = handle(stream, resolver, slot) {
                                eprintln!("[baka-dns-proxy] {err}");
                            }
                        });
                    }
                    Err(err) => {
                        eprintln!("[baka-dns-proxy] accept 失败：{err}");
                        break;
                    }
                }
            }
        })?;
    Ok(address)
}

/// 并发连接名额：持有期间计数加一，释放（含处理线程 panic）时自动减一。
/// 所有权随连接移动，只会释放一次；处理函数在进入隧道前主动丢弃它。
struct ConnectionSlot(Arc<AtomicUsize>);

impl ConnectionSlot {
    fn acquire(active: &Arc<AtomicUsize>, max: usize) -> Option<Self> {
        // 只有接受线程调用，不存在并发竞争；先加后判，超限就退回
        if active.fetch_add(1, Ordering::AcqRel) >= max {
            active.fetch_sub(1, Ordering::AcqRel);
            return None;
        }
        Some(Self(active.clone()))
    }
}

impl Drop for ConnectionSlot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

/// 读到请求头结尾，返回请求行。每一行与总量都受 `HEADER_LIMIT_BYTES` 约束：
/// 先限长再读，没有换行的超长输入读到上限就停，不会无界占用内存。
fn read_head(reader: &mut BufReader<TcpStream>) -> Result<String, HeadError> {
    let mut remaining = HEADER_LIMIT_BYTES;
    let mut request_line = String::new();
    let mut first = true;
    loop {
        let mut line = String::new();
        let read = reader
            .by_ref()
            .take(remaining as u64)
            .read_line(&mut line)
            .map_err(|err| HeadError::Io(format!("读取请求头失败：{err}")))?;
        if read == 0 {
            break;
        }
        if !line.ends_with('\n') && read >= remaining {
            return Err(HeadError::TooLarge);
        }
        remaining -= read;
        if first {
            request_line = line;
            first = false;
            continue;
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
    }
    Ok(request_line)
}

enum HeadError {
    TooLarge,
    Io(String),
}

fn handle(
    mut stream: TcpStream,
    resolver: Arc<HttpDnsResolver>,
    slot: ConnectionSlot,
) -> Result<(), String> {
    stream
        .set_read_timeout(Some(HEADER_TIMEOUT))
        .map_err(|err| format!("设置读超时失败：{err}"))?;
    let mut reader = BufReader::new(
        stream
            .try_clone()
            .map_err(|err| format!("复制客户端连接失败：{err}"))?,
    );
    let request_line = match read_head(&mut reader) {
        Ok(line) => line,
        Err(HeadError::TooLarge) => {
            let _ = write_response(&stream, "431 Request Header Fields Too Large");
            return Err("请求头过大，已断开".to_string());
        }
        Err(HeadError::Io(message)) => return Err(message),
    };

    let leftover = reader.buffer().to_vec();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let target = parts.next().unwrap_or_default();
    if method != "CONNECT" {
        let _ = write_response(&stream, "405 Method Not Allowed");
        return Err(format!("拒绝非 CONNECT 请求：{method} {target}"));
    }
    let (host, port) = split_target(target)?;

    let resolution = resolver
        .resolve(host, port)
        .map_err(|err| format!("解析 {host}:{port} 失败：{err}"))?;
    let mut upstream = None;
    let mut last_error = String::from("没有可用地址");
    for address in &resolution.addrs {
        match TcpStream::connect_timeout(address, CONNECT_TIMEOUT) {
            Ok(stream) => {
                upstream = Some(stream);
                break;
            }
            Err(err) => last_error = format!("连接 {address} 失败：{err}"),
        }
    }
    let upstream = match upstream {
        Some(stream) => stream,
        None => {
            let _ = write_response(&stream, "502 Bad Gateway");
            return Err(format!("{host}:{port} 连接失败：{last_error}"));
        }
    };

    if resolver.is_managed(host) {
        eprintln!(
            "[baka-dns-proxy] CONNECT host={host} port={port} source={:?} ttl={:?} \
             degraded={} took={}ms",
            resolution.source,
            resolution.ttl,
            resolution.degraded.is_some(),
            resolution.elapsed.as_millis()
        );
    }

    stream
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .map_err(|err| format!("回复 CONNECT 失败：{err}"))?;
    // 读头阶段结束：归还名额，隧道的寿命不占并发额度（连上游失败走前面的返回，同样已归还）
    drop(slot);
    let _ = stream.flush();
    let _ = stream.set_read_timeout(None);
    let _ = stream.set_write_timeout(None);
    let _ = stream.set_nodelay(true);
    let _ = upstream.set_nodelay(true);
    // 读头的缓冲读取器可能已把随头到达的字节（流水线化的 TLS ClientHello）预读走，
    // 隧道从原始流读不到它们，这里先补发给上游
    let mut upstream = upstream;
    upstream
        .write_all(&leftover)
        .map_err(|err| format!("转发随头到达的数据失败：{err}"))?;
    tunnel(stream, upstream);
    Ok(())
}

fn write_response(stream: &TcpStream, status: &str) -> std::io::Result<()> {
    let mut stream = stream.try_clone()?;
    stream.write_all(format!("HTTP/1.1 {status}\r\nConnection: close\r\n\r\n").as_bytes())
}

/// `host:port` 或 `[::1]:port`。CONNECT 的端口是必须的。
fn split_target(target: &str) -> Result<(&str, u16), String> {
    if let Some(rest) = target.strip_prefix('[') {
        let end = rest.find(']').ok_or_else(|| format!("CONNECT 目标不合法：{target}"))?;
        let host = &rest[..end];
        let port = rest[end + 1..]
            .strip_prefix(':')
            .and_then(|value| value.parse::<u16>().ok())
            .ok_or_else(|| format!("CONNECT 目标没有端口：{target}"))?;
        return Ok((host, port));
    }
    let (host, port) = target
        .rsplit_once(':')
        .ok_or_else(|| format!("CONNECT 目标没有端口：{target}"))?;
    let port = port
        .parse::<u16>()
        .map_err(|_| format!("CONNECT 端口不合法：{target}"))?;
    if host.is_empty() {
        return Err(format!("CONNECT 目标没有主机：{target}"));
    }
    Ok((host, port))
}

fn tunnel(client: TcpStream, upstream: TcpStream) {
    let (Ok(client_read), Ok(upstream_write)) = (client.try_clone(), upstream.try_clone()) else {
        return;
    };
    let (Ok(upstream_read), Ok(client_write)) = (upstream.try_clone(), client.try_clone()) else {
        return;
    };
    let shutdown_client = client.try_clone().ok();
    let shutdown_upstream = upstream.try_clone().ok();

    let worker = std::thread::spawn(move || {
        pipe(client_read, upstream_write);
        if let Some(stream) = shutdown_upstream {
            let _ = stream.shutdown(Shutdown::Both);
        }
    });
    pipe(upstream_read, client_write);
    if let Some(stream) = shutdown_client {
        let _ = stream.shutdown(Shutdown::Both);
    }
    let _ = worker.join();
    drop(client);
    drop(upstream);
}

fn pipe(mut from: TcpStream, mut to: TcpStream) {
    let _ = std::io::copy(&mut from, &mut to);
    let _ = to.flush();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::httpdns::{Config, HttpDnsResolver};
    use std::io::Read;

    const KEY: &str = "0123456789abcdef";
    /// 保留域名，系统 DNS 不可能解析到本机；只有 HTTPDNS 返回 127.0.0.1 才能连通。
    const HOST: &str = "game.example.com";

    #[test]
    fn splits_ipv4_and_ipv6_targets() {
        assert_eq!(split_target("example.com:443").unwrap(), ("example.com", 443));
        assert_eq!(split_target("[::1]:8443").unwrap(), ("::1", 8443));
        assert!(split_target("example.com").is_err());
    }

    /// 回显 4 个字节的本地服务，每条连接一个线程（保持着的隧道不会挡住后来的连接）。
    fn start_echo() -> u16 {
        let echo = TcpListener::bind("127.0.0.1:0").unwrap();
        let echo_port = echo.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in echo.incoming() {
                let Ok(mut stream) = stream else { continue };
                std::thread::spawn(move || {
                    let mut buf = [0u8; 4];
                    if stream.read_exact(&mut buf).is_ok() {
                        let _ = stream.write_all(&buf);
                    }
                });
            }
        });
        echo_port
    }

    /// 回显服务 + 指向它的 HTTPDNS + 已启动的隧道，返回（隧道地址，回显端口）。
    fn proxy_to_echo() -> (SocketAddr, u16) {
        (start(test_resolver()).unwrap(), start_echo())
    }

    /// HTTPDNS 指向本机的解析器：受管域名解析成 127.0.0.1。
    fn test_resolver() -> Arc<HttpDnsResolver> {
        Arc::new(HttpDnsResolver::new(Config {
            app_id: "12345".to_string(),
            secret_key: KEY.to_string(),
            token: String::new(),
            endpoint: mock_httpdns(),
            domains: vec![HOST.to_string()],
            timeout: Duration::from_secs(1),
        }))
    }

    /// 读到响应头结尾并断言是 200。
    fn read_connect_head(client: &mut TcpStream) {
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            client.read_exact(&mut byte).unwrap();
            head.push(byte[0]);
        }
        assert!(String::from_utf8_lossy(&head).starts_with("HTTP/1.1 200"));
    }

    /// 端到端：CONNECT 一个系统 DNS 解析不到的域名，HTTPDNS 指向本地回显服务。
    #[test]
    fn connect_uses_httpdns_for_managed_hosts() {
        let (proxy, echo_port) = proxy_to_echo();
        let mut client = TcpStream::connect(proxy).unwrap();
        client.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        client.set_write_timeout(Some(Duration::from_secs(5))).unwrap();
        client
            .write_all(format!("CONNECT {HOST}:{echo_port} HTTP/1.1\r\nHost: {HOST}\r\n\r\n").as_bytes())
            .unwrap();
        read_connect_head(&mut client);

        client.write_all(b"PING").unwrap();
        let mut reply = [0u8; 4];
        client.read_exact(&mut reply).unwrap();
        assert_eq!(&reply, b"PING");
    }

    /// 流水线化客户端：CONNECT 头与随后的字节同一批到达（不等 200）。
    /// 读头用的缓冲读取器会把后面的字节一并读走，隧道必须把它们补发给上游。
    #[test]
    fn bytes_arriving_with_connect_head_reach_upstream() {
        let (proxy, echo_port) = proxy_to_echo();
        let mut client = TcpStream::connect(proxy).unwrap();
        client.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        client
            .write_all(format!("CONNECT {HOST}:{echo_port} HTTP/1.1\r\nHost: {HOST}\r\n\r\nPING").as_bytes())
            .unwrap();
        read_connect_head(&mut client);
        let mut reply = [0u8; 4];
        client.read_exact(&mut reply).unwrap();
        assert_eq!(&reply, b"PING");
    }

    /// 没有换行的超长请求头不能让隧道无界读取：超过上限就断开（能回 431 则回 431）。
    #[test]
    fn oversized_header_without_newline_is_rejected() {
        let (proxy, _) = proxy_to_echo();
        let mut client = TcpStream::connect(proxy).unwrap();
        client.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        client.write_all(&vec![b'a'; HEADER_LIMIT_BYTES * 2]).unwrap();
        let mut response = String::new();
        match client.read_to_string(&mut response) {
            Ok(_) => assert!(response.starts_with("HTTP/1.1 431"), "{response}"),
            // 服务端关闭时还有未读数据，回 RST 也是「已断开」；超时才是还在无界等待
            Err(err) => assert!(
                matches!(
                    err.kind(),
                    std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
                ),
                "隧道没有在上限处断开：{err}"
            ),
        }
    }

    /// 并发名额只覆盖读头阶段：停在读头阶段（只发半截请求头）的连接占满名额后，
    /// 新连接立即得到 503，释放后恢复接受。
    #[test]
    fn connections_beyond_the_limit_are_refused_and_released() {
        let proxy = start_with_limit(test_resolver(), 2).unwrap();
        let mut held: Vec<TcpStream> = (0..2)
            .map(|_| {
                let mut stream = TcpStream::connect(proxy).unwrap();
                stream.write_all(b"CONNECT game.exam").unwrap();
                stream
            })
            .collect();

        let mut refused = TcpStream::connect(proxy).unwrap();
        refused.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let mut response = String::new();
        let _ = refused.read_to_string(&mut response);
        assert!(response.starts_with("HTTP/1.1 503"), "{response}");

        // 放掉一条占用后，新连接重新被接受（处理线程退出需要一点时间，轮询等待）
        held.pop();
        let mut accepted = false;
        for _ in 0..30 {
            let mut probe = TcpStream::connect(proxy).unwrap();
            probe.set_read_timeout(Some(Duration::from_millis(200))).unwrap();
            let mut text = String::new();
            let _ = probe.read_to_string(&mut text);
            if !text.starts_with("HTTP/1.1 503") {
                accepted = true;
                break;
            }
        }
        assert!(accepted, "释放占用后仍在返回 503");
    }

    /// 已经建立并保持着的隧道不占并发名额：名额只挡读头阶段的慢连接，
    /// 长连接（对局的 WebSocket）整局都在隧道里，不能把名额一直占住。
    #[test]
    fn established_tunnels_do_not_hold_connection_slots() {
        let proxy = start_with_limit(test_resolver(), 2).unwrap();
        let echo_port = start_echo();
        let connect = || {
            let mut client = TcpStream::connect(proxy).unwrap();
            client.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            client
                .write_all(format!("CONNECT {HOST}:{echo_port} HTTP/1.1\r\nHost: {HOST}\r\n\r\n").as_bytes())
                .unwrap();
            client
        };
        // 建立满额条数的隧道并保持不关（不发数据，回显服务也不会结束它们）
        let mut tunnels = Vec::new();
        for _ in 0..2 {
            let mut client = connect();
            read_connect_head(&mut client);
            tunnels.push(client);
        }
        // 再来一条：名额已不被隧道占用，必须拿到 200
        let mut extra = connect();
        read_connect_head(&mut extra);
        extra.write_all(b"PING").unwrap();
        let mut reply = [0u8; 4];
        extra.read_exact(&mut reply).unwrap();
        assert_eq!(&reply, b"PING");
        drop(tunnels);
    }

    fn mock_httpdns() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let answer = hex::encode(encrypt_for_test(&format!("127.0.0.1,60")));
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut request = [0u8; 4096];
                let _ = stream.read(&mut request);
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    answer.len(),
                    answer
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });
        format!("http://{address}/d")
    }

    fn encrypt_for_test(answer: &str) -> Vec<u8> {
        use aes::cipher::block_padding::Pkcs7;
        use aes::cipher::generic_array::GenericArray;
        use aes::cipher::{BlockEncryptMut, KeyIvInit};
        let iv = [7u8; 16];
        let key = KEY.as_bytes();
        let mut buffer = vec![0u8; answer.len() + 16];
        buffer[..answer.len()].copy_from_slice(answer.as_bytes());
        let cipher = cbc::Encryptor::<aes::Aes128>::new(
            GenericArray::from_slice(key),
            GenericArray::from_slice(&iv),
        );
        let ciphertext = cipher
            .encrypt_padded_mut::<Pkcs7>(&mut buffer, answer.len())
            .unwrap();
        let mut out = iv.to_vec();
        out.extend_from_slice(ciphertext);
        out
    }
}
