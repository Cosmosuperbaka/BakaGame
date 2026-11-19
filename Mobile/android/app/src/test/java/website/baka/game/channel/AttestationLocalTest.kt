package website.baka.game.channel

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AttestationLocalTest {
    private fun tlv(tag: Int, content: ByteArray): ByteArray {
        val length = content.size
        val header = when {
            length < 0x80 -> byteArrayOf(tag.toByte(), length.toByte())
            length < 0x100 -> byteArrayOf(tag.toByte(), 0x81.toByte(), length.toByte())
            else -> byteArrayOf(tag.toByte(), 0x82.toByte(), (length shr 8).toByte(), length.toByte())
        }
        return header + content
    }

    /** 带多字节标签号的 TLV：EXPLICIT 标签 704 编码为 BF 85 40。 */
    private fun explicit704(content: ByteArray): ByteArray {
        val tag = byteArrayOf(0xBF.toByte(), 0x85.toByte(), 0x40)
        val length = content.size
        val encoded = if (length < 0x80) {
            byteArrayOf(length.toByte())
        } else {
            byteArrayOf(0x82.toByte(), (length shr 8).toByte(), length.toByte())
        }
        return tag + encoded + content
    }

    private fun int(value: Int) = tlv(0x02, byteArrayOf(value.toByte()))

    private fun enumerated(value: Int) = tlv(0x0A, byteArrayOf(value.toByte()))

    /** 扩展值（getExtensionValue 的形态）：OCTET STRING 包着 KeyDescription。 */
    private fun extension(securityLevel: Int, softwareEnforced: ByteArray = ByteArray(0)): ByteArray {
        val keyDescription = tlv(
            0x30,
            int(4) + enumerated(securityLevel) + int(4) + enumerated(securityLevel) +
                tlv(0x04, ByteArray(16)) + tlv(0x04, ByteArray(0)) +
                tlv(0x30, softwareEnforced) + tlv(0x30, ByteArray(0)),
        )
        return tlv(0x04, keyDescription)
    }

    @Test fun hardwareBackedLevelsAreTrusted() {
        assertEquals("TRUSTED_ENVIRONMENT", AttestationLocal.securityLevelOf(extension(1)))
        assertEquals("STRONGBOX", AttestationLocal.securityLevelOf(extension(2)))
        assertEquals("trusted", AttestationLocal.levelOf(extension(1)))
        assertEquals("trusted", AttestationLocal.levelOf(extension(2)))
    }

    @Test fun softwareLevelIsDegraded() {
        assertEquals("SOFTWARE", AttestationLocal.securityLevelOf(extension(0)))
        assertEquals("degraded", AttestationLocal.levelOf(extension(0)))
        // 未知枚举值不当作硬件级
        assertEquals("degraded", AttestationLocal.levelOf(extension(9)))
    }

    @Test fun missingOrMalformedExtensionIsDegradedAndNeverThrows() {
        assertEquals("degraded", AttestationLocal.levelOf(null))
        assertEquals("degraded", AttestationLocal.levelOf(ByteArray(0)))
        assertEquals("degraded", AttestationLocal.levelOf(byteArrayOf(1, 2, 3, 4, 5)))
        val whole = extension(1)
        // 任意位置截断都不应抛出，也不应误判成硬件级
        for (cut in 0 until whole.size - 1) {
            assertEquals("截断到 $cut", "degraded", AttestationLocal.levelOf(whole.copyOf(cut)))
        }
        assertNull(AttestationLocal.securityLevelOf(null))
    }

    @Test fun localLevelNeverRejectsEvenWhenRootOfTrustSaysUnlocked() {
        // rootOfTrust（EXPLICIT 704）里写明 deviceLocked=false、verifiedBootState=Failed：
        // 启动状态与设备锁由服务端判定，本地档位只看 attestationSecurityLevel
        val rootOfTrust = tlv(
            0x30,
            tlv(0x04, ByteArray(32)) + tlv(0x01, byteArrayOf(0)) + enumerated(3) + tlv(0x04, ByteArray(32)),
        )
        val level = AttestationLocal.levelOf(extension(1, explicit704(rootOfTrust)))
        assertEquals("trusted", level)
    }

    @Test fun derReadsMultiByteTagAndLongLength() {
        val payload = ByteArray(300) { 7 }
        val node = Der.parse(tlv(0x30, explicit704(payload)))
        assertNotNull(node)
        val inner = node!!.children()!!.single()
        assertEquals(2, inner.tagClass) // context-specific
        assertTrue(inner.constructed)
        assertEquals(704L, inner.tagNumber)
        assertEquals(300, inner.content.size)
    }

    @Test fun derRejectsLengthBeyondInputAndIndefiniteForm() {
        assertNull(Der.parse(byteArrayOf(0x30, 0x05, 0x01)))
        assertNull(Der.parse(byteArrayOf(0x30, 0x80.toByte(), 0x00, 0x00)))
        assertNull(Der.parse(ByteArray(0)))
    }
}
