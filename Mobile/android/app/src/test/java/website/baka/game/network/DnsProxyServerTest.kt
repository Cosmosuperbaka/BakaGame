package website.baka.game.network

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import kotlin.concurrent.thread

class DnsProxyServerTest {
    private val closers = mutableListOf<() -> Unit>()

    @After fun tearDown() {
        closers.forEach { runCatching(it) }
    }

    /** 解析一律指向本机回环，不碰 HTTPDNS 与网络。 */
    private val loopbackResolver = object : TunnelResolver {
        override fun isManaged(rawHost: String) = true

        override fun resolve(rawHost: String) = HttpDns.Resolution(
            addresses = listOf(InetAddress.getLoopbackAddress()),
            source = HttpDns.Source.HTTPDNS,
            ttlSeconds = 60,
            elapsedMs = 0,
            degraded = false,
        )
    }

    /** 回显 4 个字节后关闭；返回端口。 */
    private fun startEcho(): Int {
        val server = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
        closers += { server.close() }
        thread(isDaemon = true) {
            while (true) {
                val socket = try {
                    server.accept()
                } catch (_: Exception) {
                    break
                }
                thread(isDaemon = true) {
                    socket.use {
                        val buffer = ByteArray(4)
                        var read = 0
                        while (read < 4) {
                            val n = it.getInputStream().read(buffer, read, 4 - read)
                            if (n < 0) return@thread
                            read += n
                        }
                        it.getOutputStream().write(buffer)
                        it.getOutputStream().flush()
                    }
                }
            }
        }
        return server.localPort
    }

    private fun startProxy(): DnsProxyServer {
        val proxy = DnsProxyServer.start(loopbackResolver)
        closers += { proxy.close() }
        return proxy
    }

    private fun connectToProxy(proxy: DnsProxyServer): Socket {
        val socket = Socket(InetAddress.getLoopbackAddress(), proxy.port)
        socket.soTimeout = 5_000
        closers += { socket.close() }
        return socket
    }

    private fun readHead(input: InputStream): String {
        val head = StringBuilder()
        while (!head.endsWith("\r\n\r\n")) {
            val byte = input.read()
            if (byte < 0) break
            head.append(byte.toChar())
        }
        return head.toString()
    }

    @Test fun bytesArrivingWithConnectHeadReachUpstream() {
        val echoPort = startEcho()
        val proxy = startProxy()
        val client = connectToProxy(proxy)
        // 流水线化客户端：头与握手首包同一批发出，不等 200
        client.getOutputStream().write(
            "CONNECT game.example.com:$echoPort HTTP/1.1\r\nHost: game.example.com\r\n\r\nPING"
                .toByteArray(Charsets.ISO_8859_1),
        )
        client.getOutputStream().flush()
        val head = readHead(client.getInputStream())
        assertTrue(head, head.startsWith("HTTP/1.1 200"))
        val reply = ByteArray(4)
        var read = 0
        while (read < 4) {
            val n = client.getInputStream().read(reply, read, 4 - read)
            assertTrue("回显提前结束", n >= 0)
            read += n
        }
        assertEquals("PING", String(reply, Charsets.ISO_8859_1))
    }

    private fun readAll(socket: Socket): String =
        try {
            String(socket.getInputStream().readBytes(), Charsets.ISO_8859_1)
        } catch (_: java.net.SocketException) {
            "" // 服务端带着未读数据关闭时按 RST 处理，也算已断开
        }

    @Test fun oversizedHeaderWithoutNewlineIsRejected() {
        val proxy = startProxy()
        val client = connectToProxy(proxy)
        runCatching {
            client.getOutputStream().write(ByteArray(32 * 1024) { 'a'.code.toByte() })
            client.getOutputStream().flush()
        }
        // 读到 EOF（服务端断开）而不是读超时，说明没有无界等待
        val response = readAll(client)
        assertTrue(response, response.isEmpty() || response.startsWith("HTTP/1.1 4"))
    }

    private fun connectTunnel(proxy: DnsProxyServer, echoPort: Int): Socket {
        val client = connectToProxy(proxy)
        client.getOutputStream().write(
            "CONNECT game.example.com:$echoPort HTTP/1.1\r\nHost: game.example.com\r\n\r\n"
                .toByteArray(Charsets.ISO_8859_1),
        )
        client.getOutputStream().flush()
        val head = readHead(client.getInputStream())
        assertTrue(head, head.startsWith("HTTP/1.1 200"))
        return client
    }

    /**
     * 已经建立并保持着的隧道不占并发名额：名额只挡读头阶段的慢连接，
     * 长连接（对局的 WebSocket）整局都在隧道里，不能把名额一直占住。
     */
    @Test fun establishedTunnelsDoNotHoldConnectionSlots() {
        val echoPort = startEcho()
        val proxy = DnsProxyServer.start(loopbackResolver, maxConnections = 2)
        closers += { proxy.close() }
        // 建立满额条数的隧道并保持不关
        val tunnels = (0 until 2).map { connectTunnel(proxy, echoPort) }
        // 再来一条：名额已不被隧道占用，必须拿到 200 并能回显
        val extra = connectTunnel(proxy, echoPort)
        extra.getOutputStream().write("PING".toByteArray(Charsets.ISO_8859_1))
        extra.getOutputStream().flush()
        val reply = ByteArray(4)
        var read = 0
        while (read < 4) {
            val n = extra.getInputStream().read(reply, read, 4 - read)
            assertTrue("回显提前结束", n >= 0)
            read += n
        }
        assertEquals("PING", String(reply, Charsets.ISO_8859_1))
        assertEquals(2, tunnels.size)
    }

    @Test fun connectionsBeyondTheLimitAreRefusedAndReleased() {
        val proxy = DnsProxyServer.start(loopbackResolver, maxConnections = 2)
        closers += { proxy.close() }
        // 只发半截请求头：连接停在读头阶段，占着名额
        val held = (0 until 2).map {
            connectToProxy(proxy).also {
                it.getOutputStream().write("CONNECT game.exam".toByteArray(Charsets.ISO_8859_1))
                it.getOutputStream().flush()
            }
        }
        val refused = connectToProxy(proxy)
        val response = readAll(refused)
        assertTrue(response, response.startsWith("HTTP/1.1 503"))

        // 放掉一条占用后重新接受（处理线程退出需要一点时间，轮询等待）
        held.first().close()
        var accepted = false
        repeat(30) {
            if (accepted) return@repeat
            val probe = connectToProxy(proxy)
            probe.soTimeout = 200
            val text = try {
                String(probe.getInputStream().readBytes(), Charsets.ISO_8859_1)
            } catch (_: java.net.SocketTimeoutException) {
                "" // 读超时：连接被接受并在等请求头
            }
            if (!text.startsWith("HTTP/1.1 503")) accepted = true
        }
        assertTrue("释放占用后仍在返回 503", accepted)
    }
}
