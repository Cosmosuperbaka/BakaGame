package website.baka.game.update

import java.net.URI

/** 热更新的可归因失败：`code` 回给页面，`message` 只用于日志与调试。 */
internal class HotUpdateError(val code: String, message: String) : Exception(message)

/**
 * 热更新的信任判定，全部是不依赖 Android 的纯函数，方便脱离设备验证。
 *
 * 为什么要有这一层：插件的下载地址与校验值都由页面脚本传入，校验值与下载内容同源，
 * 等于没有信任锚。壳内能写死的只有「资源包只会从自家站点的域名下来」这一条，
 * 所以来源按壳内定下的站点域名收口；页面脚本再怎么构造参数，也指不到别的主机。
 */
internal object HotUpdatePolicy {
    /**
     * 自家站点主机。必须与 `bridge/baka-bridge.js` 的 `DEFAULT_API_ORIGIN` 同一个主机：
     * 两份写法的一致性由 `Mobile/scripts` 下的脚本测试断言，改一处必须同批改另一处。
     */
    const val SITE_HOST = "game.baka.website"

    /** 重定向最多跟随几跳；CDN 的规范化跳转一两跳足够。 */
    const val MAX_REDIRECTS = 3

    private val PUBLISHED_AT_PATTERN =
        Regex("""^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$""")

    /**
     * 站点主机去掉最左一级后的父域：资源包放在站点的同级子域（对象存储 CDN），
     * 所以信任范围是「站点所在的这个域」，而不是某一台主机。
     */
    private fun parentDomain(siteHost: String): String =
        siteHost.substringAfter('.', siteHost)

    fun isTrustedHost(host: String?, siteHost: String = SITE_HOST): Boolean {
        val name = host?.trim()?.lowercase().orEmpty()
        if (name.isEmpty()) return false
        val site = siteHost.lowercase()
        val parent = parentDomain(site)
        return name == site || name == parent || name.endsWith(".$parent")
    }

    /**
     * 下载地址（含每一跳重定向）必须：https、无用户信息、默认端口、主机在站点域内。
     * 任何一项不满足整次安装作废，不下载任何字节。
     */
    fun checkSource(rawUrl: String, siteHost: String = SITE_HOST): URI {
        val uri = try {
            URI(rawUrl)
        } catch (_: Exception) {
            throw HotUpdateError("HOT_UPDATE_BAD_ARGS", "下载地址不合法")
        }
        if (uri.scheme != "https" || uri.host.isNullOrEmpty()) {
            throw HotUpdateError("HOT_UPDATE_BAD_ARGS", "只接受 https 下载地址")
        }
        if (uri.userInfo != null || (uri.port != -1 && uri.port != 443)) {
            throw HotUpdateError("HOT_UPDATE_UNTRUSTED_SOURCE", "下载地址带有用户信息或非默认端口")
        }
        if (!isTrustedHost(uri.host, siteHost)) {
            throw HotUpdateError("HOT_UPDATE_UNTRUSTED_SOURCE", "下载地址不在可信来源内")
        }
        return uri
    }

    /**
     * 发布时间只接受清单生成器写的固定宽度 UTC 形态（毫秒三位、结尾 Z），
     * 这样字符串字典序就是时间序，不必依赖 API 26 才有的 java.time。其它形态一律当没有。
     */
    fun normalizePublishedAt(raw: String?): String? {
        val text = raw?.trim().orEmpty()
        return if (PUBLISHED_AT_PATTERN.matches(text)) text else null
    }

    /**
     * 防降级：已装版本记过发布时间时，新包必须给出不早于它的发布时间。
     * 已装版本没有记录（首次安装、壳升级清空后）时没有下限可比，放行。
     */
    fun isDowngrade(candidate: String?, installedFloor: String?): Boolean {
        if (installedFloor == null) return false
        if (candidate == null) return true
        return candidate < installedFloor
    }
}
