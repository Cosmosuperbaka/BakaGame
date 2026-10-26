package website.baka.game.update

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import website.baka.game.BuildConfig
import java.io.BufferedInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.security.MessageDigest
import java.util.zip.ZipInputStream
import javax.net.ssl.HttpsURLConnection

/**
 * 移动壳的 Web 资源热更新：只换 `dist-web` 资源，不换 APK。
 *
 * 桥接脚本从服务端清单拿到 `{ build, url, sha256 }` 后调用本插件；插件负责下载、校验、
 * 解压到应用私有目录，并把 Capacitor 的资源基路径指向新目录。真正生效在**下一次启动**：
 * 热更新不打断当前对局，也不需要用户重新安装。
 *
 * 安全边界：
 * - 只接受 https 与清单给出的 sha256；校验不过就整包丢弃。
 * - 解压按 canonical path 校验，拒绝 `..`、绝对路径与超量条目/体积（zip slip 与 zip bomb）。
 * - 解压后核对 `index.html` 的构建标记，防止「清单说 A、包里是 B」。
 * - 只在非计费网络下载：一个包几十 MB，不能悄悄吃移动流量。
 *
 * 插件名 `BakaHotUpdate` 与 `baka-bridge.js` 的调用逐字对应；改名等于换协议。
 */
@CapacitorPlugin(name = "BakaHotUpdate")
class BakaHotUpdatePlugin : Plugin() {

    @PluginMethod
    fun install(call: PluginCall) {
        val ctx = context ?: activity
        if (ctx == null) {
            call.reject("插件没有可用的 Android Context", "HOT_UPDATE_NO_CONTEXT")
            return
        }
        val url = call.getString("url")?.trim().orEmpty()
        val sha256 = call.getString("sha256")?.trim().orEmpty()
        val build = call.getString("build")?.trim().orEmpty()
        if (!HotUpdateStore.BUILD_PATTERN.matches(build) || !SHA256_PATTERN.matches(sha256)) {
            call.reject("构建标记或校验值不合法", "HOT_UPDATE_BAD_ARGS")
            return
        }
        if (!isUnmetered(ctx)) {
            call.reject("当前网络按流量计费，暂不自动下载资源更新", "HOT_UPDATE_METERED")
            return
        }

        bridge.execute {
            try {
                val result = installBundle(ctx, url, sha256, build)
                call.resolve(result)
            } catch (error: HotUpdateError) {
                call.reject(error.message ?: error.code, error.code)
            } catch (error: Exception) {
                call.reject(error.message ?: "资源更新安装失败", "HOT_UPDATE_INSTALL_FAILED")
            }
        }
    }

    /** 页面确认自己是从待确认包加载起来的；不匹配时什么也不做。 */
    @PluginMethod
    fun confirm(call: PluginCall) {
        val ctx = context ?: activity
        val build = call.getString("build")?.trim().orEmpty()
        if (ctx == null || !HotUpdateStore.BUILD_PATTERN.matches(build)) {
            call.reject("构建标记不合法", "HOT_UPDATE_BAD_ARGS")
            return
        }
        val result = JSObject()
        result.put("confirmed", HotUpdateStore.confirm(ctx, build))
        call.resolve(result)
    }

    // 两次安装请求同时进来（页面重载、后台与首页各触发一次）会写同一个临时文件；
    // 串行化后第二次直接看到已落盘的包，走 reused 分支。
    @Synchronized
    private fun installBundle(
        ctx: Context,
        rawUrl: String,
        expectedSha256: String,
        build: String
    ): JSObject {
        val uri = try {
            URI(rawUrl)
        } catch (_: Exception) {
            throw HotUpdateError("HOT_UPDATE_BAD_ARGS", "下载地址不合法")
        }
        if (uri.scheme != "https" || uri.host.isNullOrEmpty()) {
            throw HotUpdateError("HOT_UPDATE_BAD_ARGS", "只接受 https 下载地址")
        }

        val active = HotUpdateStore.activeBuild(ctx)
        val pending = HotUpdateStore.pendingBuild(ctx)
        if (active == build || pending == build) {
            return JSObject().apply {
                put("staged", true)
                put("build", build)
                put("reused", true)
            }
        }

        val root = HotUpdateStore.root(ctx)
        root.mkdirs()
        val zipFile = File(root, "download-$build.zip")
        zipFile.delete()
        try {
            download(uri, zipFile)
            val actual = sha256Of(zipFile)
            if (!actual.equals(expectedSha256, ignoreCase = true)) {
                throw HotUpdateError("HOT_UPDATE_CHECKSUM_MISMATCH", "资源包校验失败")
            }
            val finalDir = HotUpdateStore.bundleDir(ctx, build)
                ?: throw HotUpdateError("HOT_UPDATE_BAD_ARGS", "构建标记不合法")
            val tmpDir = File(root, "bundles/$build.tmp")
            tmpDir.deleteRecursively()
            tmpDir.mkdirs()
            unzip(zipFile, tmpDir)
            val bundledBuild = readBuildMarker(tmpDir)
            if (bundledBuild != build) {
                throw HotUpdateError("HOT_UPDATE_BUILD_MISMATCH", "资源包内构建标记与清单不一致")
            }
            File(tmpDir, ".complete").writeText(build)
            finalDir.deleteRecursively()
            if (!tmpDir.renameTo(finalDir)) {
                throw HotUpdateError("HOT_UPDATE_INSTALL_FAILED", "资源包落位失败")
            }
            HotUpdateStore.markPending(ctx, build)
            HotUpdateStore.cleanup(
                ctx,
                setOfNotNull(HotUpdateStore.activeBuild(ctx), build)
            )
            return JSObject().apply {
                put("staged", true)
                put("build", build)
                put("reused", false)
            }
        } finally {
            zipFile.delete()
        }
    }

    private fun download(uri: URI, target: File) {
        val connection = uri.toURL().openConnection() as? HttpsURLConnection
            ?: throw HotUpdateError("HOT_UPDATE_BAD_ARGS", "只接受 https 下载地址")
        connection.connectTimeout = CONNECT_TIMEOUT_MS
        connection.readTimeout = READ_TIMEOUT_MS
        // 允许 CDN 做规范化跳转；完整性由清单里的 sha256 保证，与终点是哪个节点无关。
        connection.instanceFollowRedirects = true
        connection.setRequestProperty("Accept", "application/zip")
        connection.setRequestProperty("Accept-Encoding", "identity")
        connection.setRequestProperty("User-Agent", "BakaGame-HotUpdate/${BuildConfig.VERSION_NAME}")
        try {
            val status = connection.responseCode
            if (status !in 200..299) {
                throw HotUpdateError("HOT_UPDATE_DOWNLOAD_FAILED", "下载失败（HTTP $status）")
            }
            val declared = connection.contentLengthLong
            if (declared > MAX_DOWNLOAD_BYTES) {
                throw HotUpdateError("HOT_UPDATE_DOWNLOAD_FAILED", "资源包超过体积上限")
            }
            var total = 0L
            BufferedInputStream(connection.inputStream).use { input ->
                FileOutputStream(target).use { output ->
                    val buffer = ByteArray(BUFFER_SIZE)
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        total += read
                        if (total > MAX_DOWNLOAD_BYTES) {
                            throw HotUpdateError("HOT_UPDATE_DOWNLOAD_FAILED", "资源包超过体积上限")
                        }
                        output.write(buffer, 0, read)
                    }
                }
            }
            if (total <= 0) throw HotUpdateError("HOT_UPDATE_DOWNLOAD_FAILED", "资源包为空")
        } finally {
            connection.disconnect()
        }
    }

    private fun sha256Of(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use { input ->
            val buffer = ByteArray(BUFFER_SIZE)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }

    private fun unzip(zipFile: File, destination: File) {
        val destinationRoot = destination.canonicalFile
        var entries = 0
        var total = 0L
        ZipInputStream(BufferedInputStream(FileInputStream(zipFile))).use { zip ->
            var entry = zip.nextEntry
            while (entry != null) {
                entries += 1
                if (entries > MAX_ENTRIES) {
                    throw HotUpdateError("HOT_UPDATE_UNSAFE_ARCHIVE", "资源包条目过多")
                }
                val name = entry.name.replace('\\', '/')
                if (name.startsWith("/") || name.contains("..")) {
                    throw HotUpdateError("HOT_UPDATE_UNSAFE_ARCHIVE", "资源包包含不安全路径")
                }
                val target = File(destinationRoot, name).canonicalFile
                if (target != destinationRoot &&
                    !target.path.startsWith(destinationRoot.path + File.separator)
                ) {
                    throw HotUpdateError("HOT_UPDATE_UNSAFE_ARCHIVE", "资源包包含越界路径")
                }
                if (entry.isDirectory) {
                    target.mkdirs()
                } else {
                    target.parentFile?.mkdirs()
                    FileOutputStream(target).use { output ->
                        val buffer = ByteArray(BUFFER_SIZE)
                        while (true) {
                            val read = zip.read(buffer)
                            if (read < 0) break
                            total += read
                            if (total > MAX_UNCOMPRESSED_BYTES) {
                                throw HotUpdateError("HOT_UPDATE_UNSAFE_ARCHIVE", "资源包解压后过大")
                            }
                            output.write(buffer, 0, read)
                        }
                    }
                }
                zip.closeEntry()
                entry = zip.nextEntry
            }
        }
        if (!File(destinationRoot, "index.html").isFile) {
            throw HotUpdateError("HOT_UPDATE_UNSAFE_ARCHIVE", "资源包缺少 index.html")
        }
    }

    /** `index.html` 的 `bakagame-build` 必须与清单一致：防止错包被当成新版本装上。 */
    private fun readBuildMarker(directory: File): String? {
        val index = File(directory, "index.html")
        if (!index.isFile) return null
        val html = index.readText()
        val meta = Regex("<meta[^>]*name=[\"']bakagame-build[\"'][^>]*>", RegexOption.IGNORE_CASE)
            .find(html)?.value ?: return null
        return Regex("content=[\"']([^\"']+)[\"']", RegexOption.IGNORE_CASE)
            .find(meta)?.groupValues?.get(1)
    }

    private fun isUnmetered(context: Context): Boolean {
        val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: return false
        val network = manager.activeNetwork ?: return false
        val capabilities = manager.getNetworkCapabilities(network) ?: return false
        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
    }

    private class HotUpdateError(val code: String, message: String) : Exception(message)

    private companion object {
        val SHA256_PATTERN = Regex("^[a-fA-F0-9]{64}$")
        const val CONNECT_TIMEOUT_MS = 15_000
        const val READ_TIMEOUT_MS = 120_000
        const val BUFFER_SIZE = 64 * 1024
        const val MAX_DOWNLOAD_BYTES = 256L * 1024 * 1024
        const val MAX_UNCOMPRESSED_BYTES = 512L * 1024 * 1024
        const val MAX_ENTRIES = 10_000
    }
}
