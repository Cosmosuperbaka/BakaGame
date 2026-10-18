package website.baka.game.channel

import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONArray
import java.security.cert.X509Certificate

/**
 * 桥接原生层：JS 侧只通过 window.__BAKA_CHANNEL__ 的三个入口间接触达本插件
 * （sign / selfCheck，外加注册所需的 getKeyInfo）。
 * 密钥生成、链上报与验证分工见 Mobile/README.md「交给服务端的材料」。
 *
 * 通道证明闭环（challenge → sign → attest）在 `Mobile/bridge/baka-bridge.js` 里跑：
 * 本插件只提供密钥能力，不碰接口，也不持有票据——票据 30 秒 TTL 且用过即焚，
 * 由桥接脚本按页面读取的节奏补签最合适。
 */
@CapacitorPlugin(name = "BakaChannel")
class BakaChannelPlugin : Plugin() {

    /** 注册材料：公钥(SPKI base64) + 完整证书链(PEM, 叶子在前) + 绑定的 attestation nonce */
    @PluginMethod
    fun getKeyInfo(call: PluginCall) {
        bridge.asyncCall(call) { c ->
            try {
                val context = c.context ?: activity
                val chain = KeystoreChannel.ensureCertificateChain(context)
                val info = JSObject()
                info.put("publicKey", Base64.encodeToString(KeystoreChannel.publicKeySpki(context), Base64.NO_WRAP))
                // 取值必须是协议 §3 的词表项：服务端 register 的 keyAlgorithm 是
                // `ed25519 | ec-p256` 的枚举，多写后缀会让整次注册被 422 掉。
                // 签名算法（SHA256withECDSA）由服务端在同一分支里固定，不需要在这里声明。
                info.put("keyAlgorithm", "ec-p256")
                info.put("attestationChallenge", Base64.encodeToString(KeystoreChannel.attestationChallenge(context), Base64.NO_WRAP))
                info.put("keyAttestationChain", JSONArray(chain.map { it.toPem() }))
                info.put("packageName", context.packageName)
                info.put("strongBox", KeystoreChannel.isStrongBox(context))
                c.resolve(info)
            } catch (e: Exception) {
                c.reject("BAKA_CHANNEL_KEY_UNAVAILABLE", e)
            }
        }
    }

    /** 挑战-响应：base64(DER ECDSA-P256-SHA256(challenge.utf8)) */
    @PluginMethod
    fun sign(call: PluginCall) {
        bridge.asyncCall(call) { c ->
            val challenge = c.getString("challenge")
            if (challenge.isNullOrEmpty()) {
                c.reject("BAKA_CHANNEL_BAD_CHALLENGE")
                return@asyncCall
            }
            try {
                val signature = KeystoreChannel.sign(c.context ?: activity, challenge)
                val result = JSObject()
                result.put("signature", Base64.encodeToString(signature, Base64.NO_WRAP))
                c.resolve(result)
            } catch (e: Exception) {
                c.reject("BAKA_CHANNEL_SIGN_FAILED", e)
            }
        }
    }

    /** 运行时自检 + 本地 attestation 档位展示 */
    @PluginMethod
    fun selfCheck(call: PluginCall) {
        bridge.asyncCall(call) { c ->
            try {
                val report = SelfCheck.check(c.context ?: activity)
                val result = JSObject()
                result.put("hardFail", JSONArray(report.hardFail))
                result.put("softFail", JSONArray(report.softFail))
                result.put("attestationLevel", report.attestationLevel)
                c.resolve(result)
            } catch (e: Exception) {
                c.reject("BAKA_CHANNEL_SELFCHECK_FAILED", e)
            }
        }
    }

    private fun X509Certificate.toPem(): String =
        "-----BEGIN CERTIFICATE-----\n" +
            Base64.encodeToString(encoded, Base64.NO_WRAP) +
            "\n-----END CERTIFICATE-----"
}
