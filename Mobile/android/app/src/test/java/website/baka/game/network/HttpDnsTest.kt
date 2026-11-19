package website.baka.game.network

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.io.IOException

class HttpDnsTest {
    /** 与桌面壳共用的向量文件：从当前目录往上找，不依赖 Gradle 把工作目录放在哪。 */
    private val vectorLines: List<List<String>> by lazy {
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        var file: File? = null
        while (dir != null && file == null) {
            val candidate = File(dir, "Desktop/src-tauri/tests/httpdns_vectors.tsv")
            if (candidate.isFile) file = candidate
            dir = dir.parentFile
        }
        assertNotNull("找不到共享向量文件", file)
        file!!.readLines(Charsets.UTF_8).map { it.trimEnd('\r').split('\t') }
    }

    private fun render(answer: String): String =
        try {
            val (addresses, ttl) = HttpDns.parseAnswer(answer)
            "ips=" + addresses.joinToString(";") { it.hostAddress ?: "" } + " ttl=$ttl"
        } catch (_: IOException) {
            "error"
        }

    @Test fun answersMatchSharedVectors() {
        var checked = 0
        for (columns in vectorLines) {
            if (columns.firstOrNull() != "case") continue
            assertEquals("向量格式不对：$columns", 5, columns.size)
            assertEquals("向量 ${columns[1]} 安卓端结果不符", columns[4], render(columns[2]))
            checked++
        }
        assertTrue("向量文件没读到足够的用例：$checked", checked >= 10)
    }

    @Test fun limitsMatchSharedVectors() {
        fun limit(name: String): Int {
            val row = vectorLines.firstOrNull { it.size == 3 && it[0] == "limit" && it[1] == name }
            assertNotNull("向量文件缺少常量 $name", row)
            return row!![2].toInt()
        }
        assertEquals(limit("maxResponseBytes"), HttpDns.MAX_RESPONSE_BYTES)
        assertEquals(limit("defaultTtlSeconds"), HttpDns.DEFAULT_TTL_SECONDS)
        assertEquals(limit("maxTtlSeconds"), HttpDns.MAX_TTL_SECONDS)
        assertEquals(limit("queryTimeoutMillis"), HttpDns.QUERY_TIMEOUT_MS)
    }

    @Test fun normalizeHostStripsSchemePortBracketsAndDots() {
        assertEquals("game.example.com", HttpDns.normalizeHost("https://Game.Example.com:443/path?q=1#f"))
        assertEquals("game.example.com", HttpDns.normalizeHost("GAME.example.com."))
        assertEquals("game.example.com", HttpDns.normalizeHost(" game.example.com:8443 "))
        assertEquals("::1", HttpDns.normalizeHost("[::1]:8443"))
        // 多个冒号且没有方括号的是裸 IPv6，不能被当成「主机:端口」截断
        assertEquals("2001:db8::1", HttpDns.normalizeHost("2001:db8::1"))
        assertEquals("", HttpDns.normalizeHost("   "))
    }

    @Test fun targetSplitHandlesIpv4Ipv6AndBadPorts() {
        assertEquals("example.com" to 443, DnsProxyServer.splitTarget("example.com:443"))
        assertEquals("::1" to 8443, DnsProxyServer.splitTarget("[::1]:8443"))
        assertNull(DnsProxyServer.splitTarget("example.com"))
        assertNull(DnsProxyServer.splitTarget(":443"))
        assertNull(DnsProxyServer.splitTarget("example.com:0"))
        assertNull(DnsProxyServer.splitTarget("example.com:65536"))
        assertNull(DnsProxyServer.splitTarget("example.com:abc"))
        assertNull(DnsProxyServer.splitTarget("[::1"))
        assertNull(DnsProxyServer.splitTarget("[]:443"))
        assertNull(DnsProxyServer.splitTarget(""))
    }
}
