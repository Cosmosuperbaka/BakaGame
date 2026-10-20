//! 只监听回环地址的 HTTPS 转发隧道：WebView2 的请求经这里按域名分流。
//!
//! 受管域名先问 HTTPDNS（失败则系统 DNS，并标降级），其它域名直接走系统 DNS。
//! 这里只做 CONNECT 隧道，TLS 由 WebView 端到端完成——证书校验和 SNI 仍然是原域名，
//! 代理看不到明文，也不提供任何「忽略证书错误」的开关。
//!
//! 单独起一个回环端口并把 WebView2 的 proxy 指过来，是为了让 hosts 被污染时页面本身
//! 也能打开，而不只是壳自己的三趟通道证明请求。

use std::io::{BufRead, BufReader, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::Arc;
use std::time::Duration;

use crate::httpdns::HttpDnsResolver;

const HEADER_LIMIT_BYTES: usize = 16 * 1024;
const HEADER_TIMEOUT: Duration = Duration::from_secs(10);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// 启动隧道并返回回环地址；调用方把它交给 `WebviewWindowBuilder::proxy_url`。
pub fn start(resolver: Arc<HttpDnsResolver>) -> std::io::Result<SocketAddr> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let address = listener.local_addr()?;
    std::thread::Builder::new()
        .name("baka-dns-proxy".to_string())
        .spawn(move || {
            for stream in listener.incoming() {
                match stream {
                    Ok(stream) => {
                        let resolver = resolver.clone();
                        std::thread::spawn(move || {
                            if let Err(err) = handle(stream, resolver) {
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

fn handle(mut stream: TcpStream, resolver: Arc<HttpDnsResolver>) -> Result<(), String> {
    stream
        .set_read_timeout(Some(HEADER_TIMEOUT))
        .map_err(|err| format!("设置读超时失败：{err}"))?;
    let mut reader = BufReader::new(
        stream
            .try_clone()
            .map_err(|err| format!("复制客户端连接失败：{err}"))?,
    );
    let mut request_line = String::new();
    reader
        .read_line(&mut request_line)
        .map_err(|err| format!("读取请求行失败：{err}"))?;
    let mut consumed = request_line.len();
    loop {
        let mut line = String::new();
        let read = reader
            .read_line(&mut line)
            .map_err(|err| format!("读取请求头失败：{err}"))?;
        if read == 0 || line == "\r\n" || line == "\n" {
            break;
        }
        consumed += read;
        if consumed > HEADER_LIMIT_BYTES {
            let _ = write_response(&stream, "431 Request Header Fields Too Large");
            return Err("请求头过大，已断开".to_string());
        }
    }

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
    let _ = stream.flush();
    let _ = stream.set_read_timeout(None);
    let _ = stream.set_write_timeout(None);
    let _ = stream.set_nodelay(true);
    let _ = upstream.set_nodelay(true);
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

    /// 端到端：CONNECT 一个系统 DNS 解析不到的域名，HTTPDNS 指向本地回显服务。
    #[test]
    fn connect_uses_httpdns_for_managed_hosts() {
        let echo = TcpListener::bind("127.0.0.1:0").unwrap();
        let echo_port = echo.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in echo.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut buf = [0u8; 4];
                if stream.read_exact(&mut buf).is_ok() {
                    let _ = stream.write_all(&buf);
                }
            }
        });

        let dns = mock_httpdns();
        let resolver = Arc::new(HttpDnsResolver::new(Config {
            app_id: "12345".to_string(),
            secret_key: KEY.to_string(),
            token: String::new(),
            endpoint: dns,
            domains: vec![HOST.to_string()],
            timeout: Duration::from_secs(1),
        }));
        let proxy = start(resolver).unwrap();

        let mut client = TcpStream::connect(proxy).unwrap();
        client.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        client.set_write_timeout(Some(Duration::from_secs(5))).unwrap();
        client
            .write_all(format!("CONNECT {HOST}:{echo_port} HTTP/1.1\r\nHost: {HOST}\r\n\r\n").as_bytes())
            .unwrap();
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            client.read_exact(&mut byte).unwrap();
            head.push(byte[0]);
        }
        assert!(String::from_utf8_lossy(&head).starts_with("HTTP/1.1 200"));

        client.write_all(b"PING").unwrap();
        let mut reply = [0u8; 4];
        client.read_exact(&mut reply).unwrap();
        assert_eq!(&reply, b"PING");
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
