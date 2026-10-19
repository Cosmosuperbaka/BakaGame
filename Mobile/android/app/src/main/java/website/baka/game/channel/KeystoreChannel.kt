package website.baka.game.channel

import android.annotation.SuppressLint
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import androidx.annotation.WorkerThread
import android.util.Base64
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.SecureRandom
import java.security.Signature
import java.security.cert.X509Certificate
import java.security.spec.ECGenParameterSpec

/**
 * 设备密钥（与桌面端 P2.2 协议同构）：
 * - AndroidKeyStore 内的 EC P-256 私钥，首次使用时生成并绑定 attestation challenge；
 * - 注册（一次性）上报公钥 + 完整证书链，之后复用同一密钥做挑战-响应；
 * - 私钥永不导出；设备有 StrongBox 时优先使用。
 *
 * 选 EC P-256 而非 Ed25519：AndroidKeyStore 的 Ed25519 需 API 33+ 且各机型 attestation
 * 支持参差，P-256 + SHA256withECDSA 覆盖 Android 7+ 全平台（注册字段 keyAlgorithm 标明算法）。
 */
object KeystoreChannel {

    private const val KEYSTORE = "AndroidKeyStore"
    private const val ALIAS = "baka_channel_signing"
    private const val PREFS = "baka_channel"
    private const val PREF_NONCE = "attestation_challenge"
    private const val PREF_STRONGB0X = "strongbox"

    class ChannelKeyException(message: String, cause: Throwable? = null) : Exception(message, cause)

    @SuppressLint("TrulyRandom")
    private fun newNonce(): ByteArray = ByteArray(16).also { SecureRandom().nextBytes(it) }

    private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

    /** 密钥生成时写入的 nonce，注册时原样上报；服务端在证书扩展中核对绑定关系 */
    fun attestationChallenge(context: Context): ByteArray =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(PREF_NONCE, null)
            ?.let { Base64.decode(it, Base64.NO_WRAP) }
            ?: ByteArray(0)

    fun isStrongBox(context: Context): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getBoolean(PREF_STRONGB0X, false)

    private fun specBuilder(nonce: ByteArray) = KeyGenParameterSpec.Builder(
        ALIAS,
        KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY,
    )
        .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
        .setDigests(KeyProperties.DIGEST_SHA256)
        .setUserAuthenticationRequired(false)
        .setAttestationChallenge(nonce)

    /** StrongBox 优先；机型不支持时回退普通 Keystore（两次各自独立的 builder） */
    private fun generateKey(context: Context, nonce: ByteArray): Boolean {
        var strongBox = false
        try {
            val withSb = specBuilder(nonce).setIsStrongBoxBacked(true)
            // initialize() 返回 Unit，不能链式接 generateKeyPair()，必须分两步。
            keyPairGenerator().apply { initialize(withSb.build()) }.generateKeyPair()
            strongBox = true
        } catch (e: Exception) {
            runCatching { keyStore().deleteEntry(ALIAS) }
            try {
                keyPairGenerator().apply { initialize(specBuilder(nonce).build()) }.generateKeyPair()
            } catch (e2: Exception) {
                throw ChannelKeyException("keystore key generation failed", e2)
            }
        }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(PREF_NONCE, Base64.encodeToString(nonce, Base64.NO_WRAP))
            .putBoolean(PREF_STRONGB0X, strongBox)
            .apply()
        return strongBox
    }

    private fun keyPairGenerator() =
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE)

    /**
     * 证书链（叶子在前）。密钥永久失效（bootloader 解锁、出厂重置类场景）时销毁重建，
     * 新链会随下一次注册重新上报。
     */
    @Synchronized
    @WorkerThread
    fun ensureCertificateChain(context: Context): List<X509Certificate> {
        val ks = keyStore()
        val existing = runCatching { ks.getCertificateChain(ALIAS) }.getOrNull()
        if (existing != null) return existing.map { it as X509Certificate }
        generateKey(context, newNonce())
        return keyStore().getCertificateChain(ALIAS)?.map { it as X509Certificate }
            ?: throw ChannelKeyException("attestation chain unavailable after generation")
    }

    @WorkerThread
    fun publicKeySpki(context: Context): ByteArray =
        ensureCertificateChain(context).first().publicKey.encoded // X.509 SubjectPublicKeyInfo DER

    @WorkerThread
    fun sign(context: Context, challenge: String): ByteArray {
        val privateKey = keyStore().getKey(ALIAS, null) as? PrivateKey
            ?: throw ChannelKeyException("signing key unavailable; call getKeyInfo first")
        return Signature.getInstance("SHA256withECDSA").run {
            initSign(privateKey)
            update(challenge.toByteArray(Charsets.UTF_8))
            sign() // DER 编码 ECDSA 签名，JS 层转 base64 交给服务端
        }
    }
}
