package website.baka.game.network

import android.os.SystemClock
import android.util.Log
import website.baka.game.BuildConfig
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.URL
import java.net.URLEncoder
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * 腾讯云 HTTPDNS 的 Android 侧解析器。
 *
 * 只服务一个受管域名（页面与接口同源），结果按服务端给的 TTL 缓存；查询失败、应答为空或
 * 密钥不可用时回落系统 DNS，并在日志里标 `degraded=true`。AES 模式的请求加密只保护
 * DNS 查询本身，目标站点的 TLS 会话不经过这里。
 *
 * 密钥由 Gradle 在构建期从环境变量写进 BuildConfig，不进 Web 产物；这里不打印任何密钥。
 */
class HttpDns private constructor(
    private val domain: String,
    private val appId: String,
    private val secretKey: String,
    private val token: String,
) {
    enum class Source { HTTPDNS, CACHE, SYSTEM, SYSTEM_FALLBACK }

    data class Resolution(
        val addresses: List<InetAddress>,
        val source: Source,
        val ttlSeconds: Int?,
        val elapsedMs: Long,
        val degraded: Boolean,
    )

    private data class CacheEntry(
        val addresses: List<InetAddress>,
        val ttlSeconds: Int,
        val expiresAt: Long,
    )

    private val cache = ConcurrentHashMap<String, CacheEntry>()
    private val queryGate = Any()

    @Volatile
    private var lastCacheLogAt = 0L

    val managedHost: String
        get() = domain

    fun isManaged(rawHost: String): Boolean = normalizeHost(rawHost) == domain

    /**
     * 受管域名先查缓存再问 HTTPDNS；失败回落系统 DNS。非受管域名直接走系统 DNS，
     * 不访问 HTTPDNS，也不标降级。
     */
    fun resolve(rawHost: String): Resolution {
        val host = normalizeHost(rawHost)
        if (host.isEmpty()) throw IOException("host 为空")
        val started = SystemClock.elapsedRealtime()
        if (!isManaged(host)) {
            val addresses = InetAddress.getAllByName(host).toList()
            return Resolution(
                addresses = addresses,
                source = Source.SYSTEM,
                ttlSeconds = null,
                elapsedMs = SystemClock.elapsedRealtime() - started,
                degraded = false,
            )
        }

        cached(host, started)?.let { return it }

        synchronized(queryGate) {
            cached(host, started)?.let { return it }
            return try {
                val (addresses, ttl) = query(host)
                cache[host] = CacheEntry(
                    addresses = addresses,
                    ttlSeconds = ttl,
                    expiresAt = SystemClock.elapsedRealtime() + ttl * 1000L,
                )
                val elapsed = SystemClock.elapsedRealtime() - started
                Log.i(
                    TAG,
                    "source=httpdns host=$host ips=${render(addresses)} ttl=${ttl}s took=${elapsed}ms",
                )
                Resolution(addresses, Source.HTTPDNS, ttl, elapsed, false)
            } catch (err: Exception) {
                val addresses = try {
                    InetAddress.getAllByName(host).toList()
                } catch (systemErr: Exception) {
                    throw IOException(
                        "HTTPDNS 失败（${err.message}），系统 DNS 也失败（${systemErr.message}）",
                        err,
                    )
                }
                val elapsed = SystemClock.elapsedRealtime() - started
                Log.w(
                    TAG,
                    "degraded=true host=$host reason=${err.message} " +
                        "fallback=system ips=${render(addresses)} ttl=- took=${elapsed}ms",
                    err,
                )
                Resolution(addresses, Source.SYSTEM_FALLBACK, null, elapsed, true)
            }
        }
    }

    private fun cached(host: String, started: Long): Resolution? {
        val entry = cache[host] ?: return null
        val now = SystemClock.elapsedRealtime()
        if (now >= entry.expiresAt) return null
        val remaining = ((entry.expiresAt - now) / 1000L).toInt().coerceAtLeast(1)
        val elapsed = now - started
        if (now - lastCacheLogAt >= CACHE_LOG_INTERVAL_MS) {
            lastCacheLogAt = now
            Log.i(
                TAG,
                "source=cache host=$host ips=${render(entry.addresses)} ttl=${remaining}s took=${elapsed}ms",
            )
        }
        return Resolution(entry.addresses, Source.CACHE, remaining, elapsed, false)
    }

    private fun query(host: String): Pair<List<InetAddress>, Int> {
        val endpoint = if (token.isNotEmpty()) HTTPS_ENDPOINT else HTTP_ENDPOINT
        val params = if (token.isNotEmpty()) {
            "dn=${encode(host)}&token=${encode(token)}&ttl=1&timeout=1500"
        } else {
            "dn=${encryptDomain(host)}&id=${encode(appId)}&alg=aes&ttl=1&timeout=1500"
        }
        val connection = URL("$endpoint?$params").openConnection() as HttpURLConnection
        connection.connectTimeout = QUERY_TIMEOUT_MS
        connection.readTimeout = QUERY_TIMEOUT_MS
        connection.requestMethod = "GET"
        connection.useCaches = false
        try {
            val code = connection.responseCode
            if (code != HttpURLConnection.HTTP_OK) throw IOException("HTTPDNS 返回 HTTP $code")
            val body = connection.inputStream.use { readLimited(it, MAX_RESPONSE_BYTES) }
            val plain = if (token.isNotEmpty()) body.trim() else decryptAnswer(body)
            return parseAnswer(plain)
        } finally {
            connection.disconnect()
        }
    }

    private fun encryptDomain(host: String): String {
        val key = secretKey.toByteArray(Charsets.UTF_8)
        if (key.size != 16) throw IOException("HTTPDNS AES 密钥必须是 16 字节")
        val iv = ByteArray(16).also { SecureRandom().nextBytes(it) }
        val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), IvParameterSpec(iv))
        val ciphertext = cipher.doFinal(host.toByteArray(Charsets.UTF_8))
        return toHex(iv + ciphertext)
    }

    private fun decryptAnswer(body: String): String {
        val key = secretKey.toByteArray(Charsets.UTF_8)
        if (key.size != 16) throw IOException("HTTPDNS AES 密钥必须是 16 字节")
        val raw = fromHex(body)
        if (raw.size <= 16 || (raw.size - 16) % 16 != 0) {
            throw IOException("HTTPDNS 加密应答长度不合法")
        }
        val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            SecretKeySpec(key, "AES"),
            IvParameterSpec(raw, 0, 16),
        )
        return String(cipher.doFinal(raw, 16, raw.size - 16), Charsets.UTF_8)
    }

    private fun parseAnswer(answer: String): Pair<List<InetAddress>, Int> {
        val trimmed = answer.trim()
        if (trimmed.isEmpty()) throw IOException("HTTPDNS 返回空结果")
        val head = trimmed.substringBefore('|').trim()
        val comma = head.lastIndexOf(',')
        var ttl: Int? = null
        var ipPart = head
        if (comma >= 0) {
            val candidate = head.substring(comma + 1).trim().toIntOrNull()
            if (candidate != null) {
                ttl = candidate
                ipPart = head.substring(0, comma)
            }
        }
        val addresses = ipPart.split(';').mapNotNull { parseIpv4(it.trim()) }
        if (addresses.isEmpty()) throw IOException("HTTPDNS 应答里没有合法 IPv4：$ipPart")
        val ttlSeconds = (ttl ?: DEFAULT_TTL_SECONDS).coerceIn(1, MAX_TTL_SECONDS)
        return addresses to ttlSeconds
    }

    companion object {
        private const val TAG = "BakaHttpDns"
        private const val HTTP_ENDPOINT = "http://119.29.29.98/d"
        private const val HTTPS_ENDPOINT = "https://119.29.29.99/d"
        private const val QUERY_TIMEOUT_MS = 1500
        private const val DEFAULT_TTL_SECONDS = 60
        private const val MAX_TTL_SECONDS = 3600
        private const val MAX_RESPONSE_BYTES = 8 * 1024
        private const val CACHE_LOG_INTERVAL_MS = 5000L

        /** 密钥缺失或格式不对时返回 null，壳保持系统 DNS；不把半套配置当成可用。 */
        fun fromBuildConfig(): HttpDns? {
            val domain = normalizeHost(BuildConfig.HTTPDNS_DOMAIN)
            if (domain.isEmpty()) {
                Log.i(TAG, "disabled reason=no-domain")
                return null
            }
            val token = BuildConfig.HTTPDNS_TOKEN.trim()
            val appId = BuildConfig.HTTPDNS_APP_ID.trim()
            val secret = BuildConfig.HTTPDNS_SECRET_KEY.trim()
            if (token.isEmpty() &&
                (appId.isEmpty() || secret.toByteArray(Charsets.UTF_8).size != 16)
            ) {
                Log.w(TAG, "disabled reason=incomplete-credentials：需要 16 位 AES 密钥或 HTTPS Token")
                return null
            }
            return HttpDns(domain, appId, secret, token)
        }

        private fun normalizeHost(raw: String): String {
            var value = raw.trim().lowercase()
            val scheme = value.indexOf("://")
            if (scheme >= 0) value = value.substring(scheme + 3)
            value = value.substringBefore('/').substringBefore('?').substringBefore('#')
            value = if (value.startsWith("[")) {
                value.substringAfter('[').substringBefore(']')
            } else if (value.count { it == ':' } == 1) {
                value.substringBefore(':')
            } else {
                value
            }
            return value.trimEnd('.')
        }

        private fun parseIpv4(value: String): InetAddress? {
            val parts = value.split('.')
            if (parts.size != 4) return null
            val bytes = ByteArray(4)
            for ((index, part) in parts.withIndex()) {
                val octet = part.toIntOrNull() ?: return null
                if (octet !in 0..255) return null
                bytes[index] = octet.toByte()
            }
            return InetAddress.getByAddress(bytes)
        }

        private fun render(addresses: List<InetAddress>): String =
            addresses.joinToString(",") { it.hostAddress ?: it.toString() }

        private fun encode(value: String): String = URLEncoder.encode(value, "UTF-8")

        private fun readLimited(input: InputStream, limit: Int): String {
            val out = ByteArrayOutputStream()
            val buffer = ByteArray(1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                if (out.size() + read > limit) throw IOException("HTTPDNS 应答过大")
                out.write(buffer, 0, read)
            }
            return out.toString(Charsets.UTF_8.name())
        }

        private fun toHex(bytes: ByteArray): String {
            val builder = StringBuilder(bytes.size * 2)
            for (byte in bytes) {
                val value = byte.toInt() and 0xff
                builder.append(HEX[value ushr 4]).append(HEX[value and 0x0f])
            }
            return builder.toString()
        }

        private fun fromHex(value: String): ByteArray {
            val text = value.trim()
            if (text.length % 2 != 0) throw IOException("HTTPDNS 应答不是十六进制")
            val out = ByteArray(text.length / 2)
            for (index in out.indices) {
                val high = Character.digit(text[index * 2], 16)
                val low = Character.digit(text[index * 2 + 1], 16)
                if (high < 0 || low < 0) throw IOException("HTTPDNS 应答不是十六进制")
                out[index] = ((high shl 4) or low).toByte()
            }
            return out
        }

        private const val HEX = "0123456789abcdef"
    }
}
