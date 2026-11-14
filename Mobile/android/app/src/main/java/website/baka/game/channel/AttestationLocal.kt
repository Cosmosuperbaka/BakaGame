package website.baka.game.channel

import java.security.cert.X509Certificate

/**
 * Key Attestation 叶子证书扩展 OID 1.3.6.1.4.1.11129.2.1.17（KeyDescription）的
 * 本地最小解析，仅用于自检展示（selfCheck 的 attestationLevel 参考值）。
 * **服务端才是验证方**（链验证 / CRL / 根信任 / 启动状态与设备锁都在服务端，见 Mobile/README.md）。
 *
 * 这里只读 KeyDescription 的 attestationSecurityLevel，因此本地档位只有两档：
 * 硬件级（TEE / StrongBox）给 trusted，其余一律 degraded；**不会**给出 rejected。
 * 启动状态与设备锁挂在 AuthorizationList 的 EXPLICIT 标签（704）里，由服务端读取与判定，
 * 本地不重复实现——重复实现一旦与服务端口径不一致，就会让自报档位与服务端结论互相打架。
 *
 * 手写 DER 读取而不引 BouncyCastle：Capacitor 模板不含 BC 依赖，运行时内置的
 * com.android.org.bouncycastle 属隐藏 API（新系统 greylist），不可靠。
 */
object AttestationLocal {

    const val OID_KEY_DESCRIPTION = "1.3.6.1.4.1.11129.2.1.17"

    private val SecurityLevels = mapOf(0 to "SOFTWARE", 1 to "TRUSTED_ENVIRONMENT", 2 to "STRONGBOX")

    /** 本地档位：读不到扩展 ≠ 设备被破坏，一律按 degraded 交给服务端处置，不抛出。 */
    fun attestationLevel(leaf: X509Certificate?): String =
        levelOf(leaf?.getExtensionValue(OID_KEY_DESCRIPTION))

    internal fun levelOf(extensionValue: ByteArray?): String =
        when (securityLevelOf(extensionValue)) {
            "TRUSTED_ENVIRONMENT", "STRONGBOX" -> "trusted"
            else -> "degraded"
        }

    /**
     * KeyDescription ::= SEQUENCE { attestationVersion INTEGER, attestationSecurityLevel ENUMERATED, ... }。
     * 任何结构异常都退化为 null（未认证），不抛出。
     */
    internal fun securityLevelOf(extensionValue: ByteArray?): String? {
        try {
            val raw = extensionValue ?: return null
            // getExtensionValue 返回 DER OCTET STRING 包装，先解一层
            val wrapper = Der.parse(raw) ?: return null
            val keyDescription = Der.parse(wrapper.content) ?: return null
            val children = keyDescription.children() ?: return null
            val level = children.getOrNull(1) ?: return null
            return SecurityLevels[level.content.intBigEndian()]
        } catch (e: Exception) {
            return null
        }
    }
}

/** 极简 DER TLV 读取：只覆盖 KeyDescription 用到的结构（标签类/构造位/多位标签号/长长度） */
class Der private constructor(
    val tagClass: Int, // 0 universal, 2 context-specific
    val constructed: Boolean,
    val tagNumber: Long,
    val content: ByteArray,
) {
    fun children(): List<Der>? = if (constructed) parseSequenceContent(content) else null

    companion object {
        // readOne 返回 (解析出的节点, 消费到的下标)，这里只要节点本身。
        fun parse(bytes: ByteArray): Der? = readOne(bytes, 0)?.first

        private fun readOne(bytes: ByteArray, at: Int): Pair<Der, Int>? {
            if (at >= bytes.size) return null
            var p = at
            val first = bytes[p].toInt() and 0xFF
            val tagClass = first shr 6
            val constructed = (first shr 5) and 1 == 1
            p++
            var tagNumber = (first and 0x1F).toLong()
            if (tagNumber == 31L) {
                tagNumber = 0
                while (p < bytes.size) {
                    val b = bytes[p].toInt() and 0xFF
                    p++
                    tagNumber = (tagNumber shl 7) or (b and 0x7F).toLong()
                    if (b and 0x80 == 0) break
                }
            }
            if (p >= bytes.size) return null
            var lenFirst = bytes[p].toInt() and 0xFF
            p++
            var length: Long
            if (lenFirst and 0x80 == 0) {
                length = lenFirst.toLong()
            } else {
                val n = lenFirst and 0x7F
                if (n == 0 || p + n > bytes.size) return null
                length = 0
                repeat(n) {
                    length = (length shl 8) or (bytes[p].toInt() and 0xFF).toLong()
                    p++
                }
            }
            if (length < 0 || p + length > bytes.size) return null
            val content = bytes.copyOfRange(p, p + length.toInt())
            return Pair(Der(tagClass, constructed, tagNumber, content), p + length.toInt())
        }

        private fun parseSequenceContent(bytes: ByteArray): List<Der>? {
            val out = ArrayList<Der>()
            var p = 0
            while (p < bytes.size) {
                val (token, next) = readOne(bytes, p) ?: return null
                out.add(token)
                p = next
            }
            return out
        }
    }
}

/** INTEGER/ENUMERATED 内容按无符号大端累加（KeyDescription 内均为小值） */
private fun ByteArray.intBigEndian(): Int {
    var v = 0
    for (b in this) v = (v shl 8) or (b.toInt() and 0xFF)
    return v
}
