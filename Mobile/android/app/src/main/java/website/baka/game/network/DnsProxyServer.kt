package website.baka.game.network

import android.os.SystemClock
import android.util.Log
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * 只监听回环地址的 CONNECT 代理：WebView 的请求先到本机端口，由这里用 HTTPDNS 解析
 * 目标域名并建立 TCP 隧道。
 *
 * 隧道内是原始字节流，不做 TLS 终结：SNI 仍是原域名，证书校验仍由 WebView 按原域名完成。
 * 非 CONNECT 的明文请求不支持（站点只有 HTTPS/WSS），返回 405。
 */
class DnsProxyServer private constructor(
    private val resolver: HttpDns,
    private val server: ServerSocket,
) {
    val port: Int = server.localPort

    private val running = AtomicBoolean(true)

    init {
        thread(name = "baka-dns-proxy-accept", isDaemon = true) {
            while (running.get()) {
                val client = try {
                    server.accept()
                } catch (err: Exception) {
                    if (running.get()) Log.w(TAG, "接受连接失败：${err.message}")
                    break
                }
                thread(name = "baka-dns-proxy-conn", isDaemon = true) {
                    handle(client)
                }
            }
        }
    }

    fun close() {
        if (!running.compareAndSet(true, false)) return
        try {
            server.close()
        } catch (_: Exception) {
        }
    }

    private fun handle(socket: Socket) {
        var upstream: Socket? = null
        try {
            socket.use { client ->
                client.soTimeout = HEADER_TIMEOUT_MS
                val input = BufferedInputStream(client.getInputStream())
                val requestLine = readLine(input, MAX_HEADER_BYTES) ?: return
                var consumed = requestLine.toByteArray(Charsets.ISO_8859_1).size + 2
                while (true) {
                    val line = readLine(input, MAX_HEADER_BYTES - consumed) ?: return
                    consumed += line.toByteArray(Charsets.ISO_8859_1).size + 2
                    if (line.isEmpty()) break
                }

                val parts = requestLine.trim().split(Regex("\\s+"))
                if (parts.size < 2 || !parts[0].equals("CONNECT", ignoreCase = true)) {
                    respond(client, "405 Method Not Allowed")
                    return
                }
                val target = splitTarget(parts[1])
                if (target == null) {
                    respond(client, "400 Bad Request")
                    return
                }
                val (host, port) = target
                val managed = resolver.isManaged(host)
                Log.d(TAG, "CONNECT host=$host port=$port managed=$managed")
                val started = SystemClock.elapsedRealtime()
                val resolution = try {
                    resolver.resolve(host)
                } catch (err: Exception) {
                    Log.w(TAG, "解析失败 host=$host port=$port reason=${err.message}")
                    respond(client, "502 Bad Gateway")
                    return
                }
                upstream = try {
                    connect(resolution.addresses, port)
                } catch (err: Exception) {
                    Log.w(
                        TAG,
                        "连接失败 host=$host port=$port " +
                            "ips=${render(resolution.addresses)} reason=${err.message}",
                    )
                    respond(client, "502 Bad Gateway")
                    return
                }
                val elapsed = SystemClock.elapsedRealtime() - started
                if (managed) {
                    Log.i(
                        TAG,
                        "CONNECT host=$host port=$port " +
                            "source=${resolution.source.name.lowercase()} " +
                            "ips=${render(resolution.addresses)} " +
                            "ttl=${resolution.ttlSeconds ?: "-"}s " +
                            "degraded=${resolution.degraded} took=${elapsed}ms",
                    )
                }
                write(client.getOutputStream(), "HTTP/1.1 200 Connection Established\r\n\r\n")
                client.soTimeout = 0
                tunnel(client, upstream)
            }
        } catch (err: Exception) {
            if (err !is SocketException) Log.w(TAG, "连接处理失败：${err.message}")
        } finally {
            try {
                upstream?.close()
            } catch (_: Exception) {
            }
        }
    }

    private fun tunnel(client: Socket, upstream: Socket) {
        val upload = thread(name = "baka-dns-proxy-up", isDaemon = true) {
            try {
                copy(client.getInputStream(), upstream.getOutputStream())
            } catch (_: IOException) {
            } finally {
                closeQuietly(upstream, output = true)
            }
        }
        try {
            copy(upstream.getInputStream(), client.getOutputStream())
        } catch (_: IOException) {
        } finally {
            closeQuietly(client, output = true)
        }
        upload.join(TUNNEL_DRAIN_MS)
    }

    private fun copy(input: InputStream, output: OutputStream) {
        val buffer = ByteArray(BUFFER_BYTES)
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            output.write(buffer, 0, read)
            output.flush()
        }
    }

    private fun connect(addresses: List<InetAddress>, port: Int): Socket {
        var lastError: Exception? = null
        for (address in addresses) {
            val socket = Socket()
            try {
                socket.connect(InetSocketAddress(address, port), CONNECT_TIMEOUT_MS)
                socket.tcpNoDelay = true
                return socket
            } catch (err: Exception) {
                lastError = err
                try {
                    socket.close()
                } catch (_: Exception) {
                }
            }
        }
        throw lastError ?: IOException("HTTPDNS 没有返回可用地址")
    }

    companion object {
        private const val TAG = "BakaDnsProxy"
        private const val HEADER_TIMEOUT_MS = 10_000
        private const val CONNECT_TIMEOUT_MS = 5_000
        private const val MAX_HEADER_BYTES = 8 * 1024
        private const val BUFFER_BYTES = 16 * 1024
        private const val TUNNEL_DRAIN_MS = 2_000L

        fun start(resolver: HttpDns): DnsProxyServer {
            val server = ServerSocket()
            server.reuseAddress = true
            server.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0))
            return DnsProxyServer(resolver, server)
        }

        private fun splitTarget(value: String): Pair<String, Int>? {
            val target = value.trim()
            if (target.isEmpty()) return null
            val host: String
            val portText: String
            if (target.startsWith("[")) {
                val end = target.indexOf(']')
                if (end <= 1 || end + 2 > target.length || target[end + 1] != ':') return null
                host = target.substring(1, end)
                portText = target.substring(end + 2)
            } else {
                val colon = target.lastIndexOf(':')
                if (colon <= 0) return null
                host = target.substring(0, colon)
                portText = target.substring(colon + 1)
            }
            val port = portText.toIntOrNull() ?: return null
            if (port !in 1..65535) return null
            return host to port
        }

        private fun readLine(input: InputStream, limit: Int): String? {
            if (limit <= 0) throw IOException("请求头过大")
            val out = ByteArrayOutputStream()
            while (true) {
                val byte = input.read()
                if (byte < 0) {
                    if (out.size() == 0) return null
                    return out.toString(Charsets.ISO_8859_1.name())
                }
                if (byte == '\n'.code) {
                    val bytes = out.toByteArray()
                    val length =
                        if (bytes.isNotEmpty() && bytes.last() == '\r'.code.toByte()) {
                            bytes.size - 1
                        } else {
                            bytes.size
                        }
                    return String(bytes, 0, length, Charsets.ISO_8859_1)
                }
                if (out.size() >= limit) throw IOException("请求头过大")
                out.write(byte)
            }
        }

        private fun respond(socket: Socket, status: String) {
            try {
                write(
                    socket.getOutputStream(),
                    "HTTP/1.1 $status\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
            } catch (_: IOException) {
            }
        }

        private fun write(output: OutputStream, text: String) {
            output.write(text.toByteArray(Charsets.ISO_8859_1))
            output.flush()
        }

        private fun closeQuietly(socket: Socket, output: Boolean) {
            try {
                if (output) socket.shutdownOutput() else socket.shutdownInput()
            } catch (_: Exception) {
            }
        }

        private fun render(addresses: List<InetAddress>): String =
            addresses.joinToString(",") { it.hostAddress ?: it.toString() }
    }
}
