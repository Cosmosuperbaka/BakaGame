package website.baka.game.channel

import java.security.cert.X509Certificate

/**
 * Key Attestation 叶子证书扩展 OID 1.3.6.1.4.1.11129.2.1.17（KeyDescription）的
 * 本地最小解析，仅用于自检展示（selfCheck 的 attestationLevel 参考值）。
 * **服务端才是验证方**（链验证 / CRL / 根信任都在服务端，见 Mobile/README.md）。
 *
 * 手写 DER 读取而不引 BouncyCastle：Capacitor 模板不含 BC 依赖，运行时内置的
 * com.android.org.bouncycastle 属隐藏 API（新系统 greylist），不可靠。
 */
object AttestationLocal {

    const val OID_KEY_DESCRIPTION = "1.3.6.1.4.1.11129.2.1.17"

    data class Local(
        val securityLevel: String?, // SOFTWARE | TRUSTED_ENVIRONMENT | STRONGBOX | null(未认证)
        val verifiedBootState: String?, // Verified | SelfSigned | Unverified | Failed
        val deviceLocked: Boolean?,
        val packageName: String?, // attestationApplicationId 内的包名
    ) {
        /** 本地三档参考值；与服务端口径一致但只作展示，最终以服务端验证结果为准 */
        fun attestationLevel(): String = when {
            securityLevel != "TRUSTED_ENVIRONMENT" && securityLevel != "STRONGBOX" -> "degraded"
            deviceLocked == false || verifiedBootState == "Unverified" ||
                verifiedBootState == "Failed" || verifiedBootState == "SelfSigned" -> "rejected"
            else -> "trusted"
        }
    }

    /** 从叶子证书读扩展；任何异常都退化为「无 attestation 信息」，不抛出 */
    fun read(leaf: X509Certificate?): Local {
        try {
            val raw = leaf?.getExtensionValue(OID_KEY_DESCRIPTION) ?: return Local(null, null, null, null)
            // getExtensionValue 返回 DER OCTET STRING 包装，先解一层
            val wrapper = Der.parse(raw) ?: return Local(null, null, null, null)
            val keyDescription = Der.parse(wrapper.content) ?: return Local(null, null, null, null)
            // KeyDescription ::= SEQUENCE { version INT, attestationSecurityLevel ENUM, ... }
            val children = keyDescription.children() ?: return Local(null, null, null, null)
            val securityLevel = children.getOrNull(1)
                ?.let { enumName(SecurityLevels, it.content.intBigEndian()) }
            // softwareEnforced / teeEnforced：rootOfTrust 与 attestationApplicationId 挂在
            // 这两个 AuthorizationList（universal SEQUENCE）之一，按序扫描全部子列表
            var root: Der? = null
            var applicationId: ByteArray? = null
            for (list in children.filter { it.tagClass == 0 && it.tagNumber == 0x30L && it.constructed }) {
                val inner = list.children() ?: continue
                for (item in inner) {
                    if (item.tagClass == 2 && item.tagNumber == 112L && root == null) root = item
                    if (item.tagClass == 2 && item.tagNumber == 70L && applicationId == null) {
                        applicationId = item.content
                    }
                }
            }
            var bootState: String? = null
            var locked: Boolean? = null
            root?.children()?.let { rt ->
                // RootOfTrust ::= SEQUENCE { verifiedBootKey OCTET, deviceLocked BOOL, verifiedBootState ENUM, hash OCTET }
                locked = rt.getOrNull(1)?.content?.firstOrNull()?.toInt() != 0
                rt.getOrNull(2)?.let { bootState = enumName(BootStates, it.content.intBigEndian()) }
            }
            val pkg = applicationId?.let { extractPackageName(it) }
            return Local(securityLevel, bootState, locked, pkg)
        } catch (e: Exception) {
            return Local(null, null, null, null)
        }
    }

    private val SecurityLevels = mapOf(0 to "SOFTWARE", 1 to "TRUSTED_ENVIRONMENT", 2 to "STRONGBOX")
    private val BootStates = mapOf(0 to "Verified", 1 to "SelfSigned", 2 to "Unverified", 3 to "Failed")
    private fun enumName(table: Map<Int, String>, v: Int) = table[v]

    /** attestationApplicationId 内容是 DER SEQUENCE { IA5String packageName, ... }；容错扫描 */
    private fun extractPackageName(bytes: ByteArray): String? {
        val text = String(bytes, Charsets.ISO_8859_1)
        val match = Regex("[a-zA-Z][a-zA-Z0-9_.]*\\.[a-zA-Z][a-zA-Z0-9_.]*").find(text)
        return match?.value
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
