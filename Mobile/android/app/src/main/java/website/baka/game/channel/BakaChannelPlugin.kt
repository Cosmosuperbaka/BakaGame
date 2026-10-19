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
 *
 * 实现口径：三个方法都是同步的（Keystore 与自检没有真正的异步 IO），直接
 * `call.resolve` / `call.reject` 即可。原先写的 `bridge.asyncCall(call) { c -> … }`
 * 在 Capacitor 里并不存在，编译期会连带着把 `bridge` / `context` / `reject` 一起报成
 * unresolved——看着像一堆错，其实只是一个不存在的 API。
 */
@CapacitorPlugin(name = "BakaChannel")
class BakaChannelPlugin : Plugin() {

    /** 注册材料：公钥(SPKI base64) + 完整证书链(PEM, 叶子在前) + 绑定的 attestation nonce */
    @PluginMethod
    fun getKeyInfo(call: PluginCall) {
        try {
            val ctx = context ?: activity ?: error("插件没有可用的 Android Context")
            val chain = KeystoreChannel.ensureCertificateChain(ctx)
            val info = JSObject()
            info.put(
                "publicKey",
                Base64.encodeToString(KeystoreChannel.publicKeySpki(ctx), Base64.NO_WRAP)
            )
            // 取值必须是协议 §3 的词表项：服务端 register 的 keyAlgorithm 是
            // `ed25519 | ec-p256` 的枚举，多写后缀会让整次注册被 422 掉。
            // 签名算法（SHA256withECDSA）由服务端在同一分支里固定，不需要在这里声明。
            info.put("keyAlgorithm", "ec-p256")
            info.put(
                "attestationChallenge",
                Base64.encodeToString(
                    KeystoreChannel.attestationChallenge(ctx),
                    Base64.NO_WRAP
                )
            )
            info.put("keyAttestationChain", JSONArray(chain.map { it.toPem() }))
            info.put("packageName", ctx.packageName)
            info.put("strongBox", KeystoreChannel.isStrongBox(ctx))
            call.resolve(info)
        } catch (e: Exception) {
            call.reject("BAKA_CHANNEL_KEY_UNAVAILABLE", e)
        }
    }

    /** 挑战-响应：base64(DER ECDSA-P256-SHA256(challenge.utf8)) */
    @PluginMethod
    fun sign(call: PluginCall) {
        val challenge = call.getString("challenge")
        if (challenge.isNullOrEmpty()) {
            call.reject("BAKA_CHANNEL_BAD_CHALLENGE")
            return
        }
        try {
            val ctx = context ?: activity ?: error("插件没有可用的 Android Context")
            val signature = KeystoreChannel.sign(ctx, challenge)
            val result = JSObject()
            result.put("signature", Base64.encodeToString(signature, Base64.NO_WRAP))
            call.resolve(result)
        } catch (e: Exception) {
            call.reject("BAKA_CHANNEL_SIGN_FAILED", e)
        }
    }

    /** 运行时自检 + 本地 attestation 档位展示 */
    @PluginMethod
    fun selfCheck(call: PluginCall) {
        try {
            val ctx = context ?: activity ?: error("插件没有可用的 Android Context")
            val report = SelfCheck.check(ctx)
            val result = JSObject()
            result.put("hardFail", JSONArray(report.hardFail))
            result.put("softFail", JSONArray(report.softFail))
            result.put("attestationLevel", report.attestationLevel)
            call.resolve(result)
        } catch (e: Exception) {
            call.reject("BAKA_CHANNEL_SELFCHECK_FAILED", e)
        }
    }

    private fun X509Certificate.toPem(): String =
        "-----BEGIN CERTIFICATE-----\n" +
            Base64.encodeToString(encoded, Base64.NO_WRAP) +
            "\n-----END CERTIFICATE-----"
}
