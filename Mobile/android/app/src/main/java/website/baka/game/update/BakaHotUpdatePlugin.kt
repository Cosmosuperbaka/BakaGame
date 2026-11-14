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
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
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
 * - 下载地址（含每一跳重定向）只接受站点域内的 https 主机，见 [HotUpdatePolicy]：
 *   地址与校验值都来自页面脚本，校验值本身不是信任锚，来源收口才是。
 * - 新包的发布时间不得早于已装的包（防降级）；校验值不符整包丢弃，不解压、不切换。
 * - 解压按 canonical path 校验，拒绝 `..`、绝对路径与超量条目/体积（zip slip 与 zip bomb）。
 * - 解压后核对 `index.html` 的构建标记，防止「清单说 A、包里是 B」。
 * - 只在非计费网络下载：一个包几十 MB，不能悄悄吃移动流量。
 *
 * 线程：Capacitor 只有一条插件线程，所有插件方法与 `bridge.execute` 都排在它上面。
 * 下载与解压是几十 MB 的阻塞 IO，绝不能占着它，否则 `BakaChannel` 的取票与签名全部排队。
 * 所以 `install` 校验参数后立刻把活交给自己的后台线程，完成时再 resolve/reject（Capacitor 允许任意线程应答）。
 *
 * 插件名 `BakaHotUpdate` 与 `baka-bridge.js` 的调用逐字对应；改名等于换协议。
 */
@CapacitorPlugin(name = "BakaHotUpdate")
class BakaHotUpdatePlugin : Plugin() {

    // 单线程后台执行器：同一时刻只做一次安装，守护线程不拖住进程退出。
    private val worker: ExecutorService = Executors.newSingleThreadExecutor { task ->
        Thread(task, "BakaHotUpdate").apply {
            isDaemon = true
            priority = Thread.MIN_PRIORITY
        }
    }

    // 已有安装在跑时，新的请求直接拒绝而不是排队：页面重载、后台与首页各触发一次是常态，
    // 排队只会让同一个包被反复检查，页面侧本来就会在下次首页时重试。
    private val installing = AtomicBoolean(false)

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
        val publishedAt = HotUpdatePolicy.normalizePublishedAt(call.getString("publishedAt"))
        if (!HotUpdateStore.BUILD_PATTERN.matches(build) || !SHA256_PATTERN.matches(sha256)) {
            call.reject("构建标记或校验值不合法", "HOT_UPDATE_BAD_ARGS")
            return
        }
        if (!isUnmetered(ctx)) {
            call.reject("当前网络按流量计费，暂不自动下载资源更新", "HOT_UPDATE_METERED")
            return
        }

        if (!installing.compareAndSet(false, true)) {
            call.reject("已有资源更新正在安装", "HOT_UPDATE_BUSY")
            return
        }
        try {
            worker.execute {
                try {
                    call.resolve(installBundle(ctx, url, sha256, build, publishedAt))
                } catch (error: HotUpdateError) {
                    call.reject(error.message ?: error.code, error.code)
                } catch (error: Exception) {
                    call.reject(error.message ?: "资源更新安装失败", "HOT_UPDATE_INSTALL_FAILED")
                } finally {
                    installing.set(false)
                }
            }
        } catch (error: Exception) {
            // 执行器已关闭（页面正在销毁）：占位要还回去，否则之后永远是 BUSY。
            installing.set(false)
            call.reject("资源更新安装被取消", "HOT_UPDATE_CANCELLED")
        }
    }

    // 页面销毁时中断在途的下载：中断点在读写循环里，被中断的安装按取消清理并拒绝。
    override fun handleOnDestroy() {
        worker.shutdownNow()
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

    // 只会在 worker 线程上、且由 installing 保证同一时刻至多一次，写临时文件不会冲突。
    private fun installBundle(
        ctx: Context,
        rawUrl: String,
        expectedSha256: String,
        build: String,
        publishedAt: String?
    ): JSObject {
        val uri = HotUpdatePolicy.checkSource(rawUrl)

        val active = HotUpdateStore.activeBuild(ctx)
        val pending = HotUpdateStore.pendingBuild(ctx)
        if (active == build || pending == build) {
            return JSObject().apply {
                put("staged", true)
                put("build", build)
                put("reused", true)
            }
        }

        if (HotUpdatePolicy.isDowngrade(publishedAt, HotUpdateStore.publishedFloor(ctx))) {
            throw HotUpdateError("HOT_UPDATE_DOWNGRADE", "资源包比已安装的更旧，拒绝降级")
        }

        val root = HotUpdateStore.root(ctx)
        root.mkdirs()
        // 进程在下载途中被杀会留下半截文件：每次开始前清掉所有遗留的下载包。
        root.listFiles { file -> file.name.startsWith("download-") }?.forEach { it.delete() }
        val zipFile = File(root, "download-$build.zip")
        val tmpDir = File(root, "bundles/$build.tmp")
        try {
            download(uri, zipFile)
            val actual = sha256Of(zipFile)
            if (!actual.equals(expectedSha256, ignoreCase = true)) {
                throw HotUpdateError("HOT_UPDATE_CHECKSUM_MISMATCH", "资源包校验失败")
            }
            val finalDir = HotUpdateStore.bundleDir(ctx, build)
                ?: throw HotUpdateError("HOT_UPDATE_BAD_ARGS", "构建标记不合法")
            tmpDir.deleteRecursively()
            tmpDir.mkdirs()
            unzip(zipFile, tmpDir)
            val bundledBuild = readBuildMarker(tmpDir)
            if (bundledBuild != build) {
                throw HotUpdateError("HOT_UPDATE_BUILD_MISMATCH", "资源包内构建标记与清单不一致")
            }
            if (publishedAt != null) File(tmpDir, HotUpdateStore.PUBLISHED_MARKER).writeText(publishedAt)
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
            // 成功时 tmpDir 已改名为正式目录，这里只会清掉失败或被取消时残留的半成品。
            zipFile.delete()
            tmpDir.deleteRecursively()
        }
    }

    /**
     * 逐跳手动跟随重定向：每一跳都重新过 [HotUpdatePolicy.checkSource]，
     * 否则可信主机一个跳转就能把下载引到别处。
     */
    private fun openConnection(first: URI): HttpsURLConnection {
        var current = first
        var hops = 0
        while (true) {
            val connection = current.toURL().openConnection() as? HttpsURLConnection
                ?: throw HotUpdateError("HOT_UPDATE_BAD_ARGS", "只接受 https 下载地址")
            connection.connectTimeout = CONNECT_TIMEOUT_MS
            connection.readTimeout = READ_TIMEOUT_MS
            connection.instanceFollowRedirects = false
            connection.setRequestProperty("Accept", "application/zip")
            connection.setRequestProperty("Accept-Encoding", "identity")
            connection.setRequestProperty("User-Agent", "BakaGame-HotUpdate/${BuildConfig.VERSION_NAME}")
            val status = connection.responseCode
            if (status !in REDIRECT_STATUS) return connection
            val location = connection.getHeaderField("Location")
            connection.disconnect()
            hops += 1
            if (location.isNullOrBlank() || hops > HotUpdatePolicy.MAX_REDIRECTS) {
                throw HotUpdateError("HOT_UPDATE_DOWNLOAD_FAILED", "下载重定向无效或过多")
            }
            current = HotUpdatePolicy.checkSource(current.resolve(location).toString())
        }
    }

    private fun download(uri: URI, target: File) {
        val connection = openConnection(uri)
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
                        throwIfCancelled()
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

    private fun throwIfCancelled() {
        if (Thread.currentThread().isInterrupted) {
            throw HotUpdateError("HOT_UPDATE_CANCELLED", "资源更新安装被取消")
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
                throwIfCancelled()
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

    private companion object {
        val SHA256_PATTERN = Regex("^[a-fA-F0-9]{64}$")
        val REDIRECT_STATUS = setOf(301, 302, 303, 307, 308)
        const val CONNECT_TIMEOUT_MS = 15_000
        const val READ_TIMEOUT_MS = 120_000
        const val BUFFER_SIZE = 64 * 1024
        const val MAX_DOWNLOAD_BYTES = 256L * 1024 * 1024
        const val MAX_UNCOMPRESSED_BYTES = 512L * 1024 * 1024
        const val MAX_ENTRIES = 10_000
    }
}
