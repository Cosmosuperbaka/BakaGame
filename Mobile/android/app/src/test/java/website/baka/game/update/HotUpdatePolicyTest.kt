package website.baka.game.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class HotUpdatePolicyTest {
    private val site = "game.example.com"

    private fun codeOf(url: String): String? = try {
        HotUpdatePolicy.checkSource(url, site)
        null
    } catch (e: HotUpdateError) {
        e.code
    }

    @Test fun trustedHosts() {
        assertTrue(HotUpdatePolicy.isTrustedHost("game.example.com", site))
        assertTrue(HotUpdatePolicy.isTrustedHost("cdn.example.com", site))
        assertTrue(HotUpdatePolicy.isTrustedHost("a.b.example.com", site))
        assertTrue(HotUpdatePolicy.isTrustedHost("CDN.Example.COM", site))
        assertTrue(HotUpdatePolicy.isTrustedHost("example.com", site))
    }

    @Test fun untrustedHosts() {
        assertFalse(HotUpdatePolicy.isTrustedHost("evil.com", site))
        assertFalse(HotUpdatePolicy.isTrustedHost("example.com.evil.com", site))
        assertFalse(HotUpdatePolicy.isTrustedHost("notexample.com", site))
        assertFalse(HotUpdatePolicy.isTrustedHost("", site))
        assertFalse(HotUpdatePolicy.isTrustedHost(null, site))
    }

    @Test fun sourceAccepts() {
        assertNull(codeOf("https://cdn.example.com/files/BakaGame-web-abc.zip"))
        assertNull(codeOf("https://cdn.example.com:443/x.zip"))
    }

    @Test fun sourceRejects() {
        assertEquals("HOT_UPDATE_UNTRUSTED_SOURCE", codeOf("https://evil.com/x.zip"))
        assertEquals("HOT_UPDATE_UNTRUSTED_SOURCE", codeOf("https://cdn.example.com@evil.com/x.zip"))
        assertEquals("HOT_UPDATE_UNTRUSTED_SOURCE", codeOf("https://user:pw@cdn.example.com/x.zip"))
        assertEquals("HOT_UPDATE_UNTRUSTED_SOURCE", codeOf("https://cdn.example.com:8443/x.zip"))
        assertEquals("HOT_UPDATE_BAD_ARGS", codeOf("http://cdn.example.com/x.zip"))
        assertEquals("HOT_UPDATE_BAD_ARGS", codeOf("ftp://cdn.example.com/x.zip"))
        assertEquals("HOT_UPDATE_BAD_ARGS", codeOf("not a url"))
        assertEquals("HOT_UPDATE_BAD_ARGS", codeOf(""))
    }

    @Test fun publishedAtNormalization() {
        assertNotNull(HotUpdatePolicy.normalizePublishedAt("2026-11-12T08:00:00.000Z"))
        assertNull(HotUpdatePolicy.normalizePublishedAt("2026-11-12T08:00:00Z"))
        assertNull(HotUpdatePolicy.normalizePublishedAt("2026-11-12"))
        assertNull(HotUpdatePolicy.normalizePublishedAt(""))
        assertNull(HotUpdatePolicy.normalizePublishedAt(null))
    }

    @Test fun downgrade() {
        val floor = "2026-11-12T08:00:00.000Z"
        assertTrue(HotUpdatePolicy.isDowngrade("2026-11-12T07:59:59.999Z", floor))
        assertTrue(HotUpdatePolicy.isDowngrade(null, floor))
        assertFalse(HotUpdatePolicy.isDowngrade(floor, floor))
        assertFalse(HotUpdatePolicy.isDowngrade("2026-11-13T00:00:00.000Z", floor))
        assertFalse(HotUpdatePolicy.isDowngrade(null, null))
        assertFalse(HotUpdatePolicy.isDowngrade("2020-01-01T00:00:00.000Z", null))
    }
}
