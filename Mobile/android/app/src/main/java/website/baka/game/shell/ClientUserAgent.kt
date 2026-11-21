package website.baka.game.shell

import android.content.Context
import android.os.Build
import android.util.Log
import website.baka.game.BuildConfig
import website.baka.game.update.HotUpdateStore
import java.io.File

/**
 * 壳的 User-Agent 段：`BakaGame/<壳版本> (Android <系统版本>; <架构>; mobile) Game/<游戏版本>`。
 *
 * - WebView 里追加在系统默认 UA 之后（见 MainActivity.runtimeConfig），页面与接口请求都带上它；
 * - 壳自己发的原生 HTTP 请求（热更新下载、HTTPDNS 查询）只用这一段。
 *
 * **只用于诊断与统计**，不参与任何信任或准入判定：UA 谁都能伪造，准入只看通道证明。
 *
 * 游戏版本取**当前生效的那份网页资源**（内嵌产物或热更新包）根目录的 `version.json`：
 * 网页产品版本加 `+<短提交号>`。热更新在冷启动时切换，所以启动时确定一次即可。
 * 读不到、字段不全或格式不对时写 `unknown`，整体形状不变。
 */
internal object ClientUserAgent {
    private const val TAG = "BakaUserAgent"
    private const val PRODUCT = "BakaGame"
    private const val CLIENT_TYPE = "mobile"
    private const val UNKNOWN = "unknown"
    private const val VERSION_FILE = "version.json"
    private const val MAX_VERSION_FILE_BYTES = 16 * 1024

    private val TOKEN_UNSAFE = Regex("[^A-Za-z0-9._-]")
    private val PRODUCT_VERSION = Regex("^\\d+(\\.\\d+){1,3}([-.][0-9A-Za-z.-]{1,32})?$")
    private val SHORT_COMMIT = Regex("^[0-9a-fA-F]{7,40}$")

    /** 版本字段的候选键名：`version.json` 由前端构建生成，取第一个合法的值。 */
    private val VERSION_KEYS = listOf("version", "productVersion", "appVersion")
    private val COMMIT_KEYS = listOf("commit", "shortCommit", "build", "hash", "gitCommit")

    /** 启动时确定的那一段；还没确定前按「游戏版本未知」给出，形状一致。 */
    @Volatile
    private var resolved: String? = null

    val current: String
        get() = resolved ?: format(BuildConfig.VERSION_NAME, Build.VERSION.RELEASE, primaryAbi(), UNKNOWN)

    /**
     * 拼出 UA 段。每个字段只留 `[A-Za-z0-9._-]`（游戏版本另外允许一个 `+`），
     * 空值写 unknown：括号、分号与空格是 UA 的分隔符，混进来会把整段切坏。
     */
    fun format(clientVersion: String?, osVersion: String?, abi: String?, gameVersion: String?): String =
        "$PRODUCT/${token(clientVersion)} (Android ${token(osVersion)}; ${token(abi)}; $CLIENT_TYPE) " +
            "Game/${gameToken(gameVersion)}"

    /**
     * 从 `version.json` 的内容得出游戏版本 `<产品版本>+<短提交号>`；任一项缺失或不合法返回 unknown。
     * 短提交号统一成小写、截到 7 位，与页面上 `bakagame-build` 的写法一致。
     */
    fun gameVersionFrom(json: String?): String {
        if (json.isNullOrBlank() || !json.trimStart().startsWith("{")) return UNKNOWN
        val version = firstString(json, VERSION_KEYS)?.takeIf { PRODUCT_VERSION.matches(it) } ?: return UNKNOWN
        val commit = firstString(json, COMMIT_KEYS)?.takeIf { SHORT_COMMIT.matches(it) } ?: return UNKNOWN
        return "$version+${commit.lowercase().take(7)}"
    }

    /**
     * 启动时调用一次（MainActivity，HotUpdateStore.prepareBoot 之后、super.onCreate 之前）：
     * 此时生效的资源目录已经定下来。返回确定后的 UA 段。
     */
    fun resolve(context: Context): String {
        val game = gameVersionFrom(readActiveVersionFile(context))
        val value = format(BuildConfig.VERSION_NAME, Build.VERSION.RELEASE, primaryAbi(), game)
        resolved = value
        Log.i(TAG, value)
        return value
    }

    private fun readActiveVersionFile(context: Context): String? = try {
        val bundle = HotUpdateStore.activeBasePath(context)
        if (bundle.isNotEmpty()) {
            val file = File(bundle, VERSION_FILE)
            if (file.isFile && file.length() in 1..MAX_VERSION_FILE_BYTES) file.readText() else null
        } else {
            context.assets.open("public/$VERSION_FILE").use { input ->
                String(input.readNBytesCompat(MAX_VERSION_FILE_BYTES), Charsets.UTF_8)
            }
        }
    } catch (_: Exception) {
        // 内嵌产物或热更新包里还没有 version.json（前端尚未生成）时就是 unknown
        null
    }

    private fun primaryAbi(): String? = Build.SUPPORTED_ABIS?.firstOrNull()

    /**
     * 取顶层字符串字段。version.json 是一层扁平对象，这里用正则取值而不是 org.json：
     * 后者在 JVM 单测里只是空壳桩，规则就没法单测了。取到的值还要过上面的格式校验，误取也只会落到 unknown。
     */
    private fun firstString(json: String, keys: List<String>): String? =
        keys.firstNotNullOfOrNull { key ->
            Regex("\"" + Regex.escape(key) + "\"\\s*:\\s*\"([^\"\\\\]{1,64})\"")
                .find(json)
                ?.groupValues
                ?.get(1)
                ?.trim()
                ?.takeIf { it.isNotEmpty() }
        }

    private fun token(raw: String?): String =
        raw?.trim()?.replace(TOKEN_UNSAFE, "")?.take(32)?.takeIf { it.isNotEmpty() } ?: UNKNOWN

    private fun gameToken(raw: String?): String {
        val text = raw?.trim().orEmpty()
        if (text.isEmpty() || text == UNKNOWN) return UNKNOWN
        val parts = text.split('+')
        if (parts.size != 2) return UNKNOWN
        val version = token(parts[0])
        val commit = token(parts[1])
        return if (version == UNKNOWN || commit == UNKNOWN) UNKNOWN else "$version+$commit"
    }

    /** `InputStream.readNBytes` 要 API 33；这里按上限读，超出部分丢弃（version.json 本就很小）。 */
    private fun java.io.InputStream.readNBytesCompat(limit: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(4096)
        while (out.size() < limit) {
            val read = read(buffer, 0, minOf(buffer.size, limit - out.size()))
            if (read < 0) break
            out.write(buffer, 0, read)
        }
        return out.toByteArray()
    }
}
