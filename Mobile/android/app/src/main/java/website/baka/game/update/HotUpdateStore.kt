package website.baka.game.update

import android.content.Context
import website.baka.game.BuildConfig
import java.io.File

/**
 * 热更新资源包的落盘与启动选择。
 *
 * 资源包按构建标记放在 `filesDir/web-update/bundles/<build>/`，目录里是完整的 `dist-web`
 * 与一份 `.complete` 标记。Capacitor 的本地资源服务从 `CapWebViewSettings.serverBasePath`
 * 指定的目录取文件，所以「生效」= 下次启动前把那个键指向新目录。
 *
 * 三个约束：
 * - **壳版本变了就全部作废**：新资源可能调用旧壳没有的桥接能力，反过来也不成立。
 *   Capacitor 自己也会在版本变化时清 `serverBasePath`，这里把资源目录一并清掉，避免留下
 *   一份永远不会再被使用的 40 MB 文件。
 * - **待确认的包有启动次数上限**：页面加载失败（白屏）时桥接脚本不会调用 confirm，
 *   连续几次启动仍未确认就退回内嵌产物。不能把一台设备永久卡在坏包上。
 * - 只保留当前包与新包：每个包几十 MB，旧包没有回滚价值——回滚靠清单重新指向旧构建，
 *   下次下载即可。
 *
 * 路径与 SharedPreferences 的键名只在壳内使用；`CapWebViewSettings` 与 `serverBasePath`
 * 是 Capacitor 的既有契约（7.x `com.getcapacitor.plugin.WebView`），升级 Capacitor 时要一起看。
 */
internal object HotUpdateStore {
    private const val PREFS = "BakaHotUpdate"
    private const val KEY_SHELL_VERSION = "shellVersion"
    private const val KEY_ACTIVE = "activeBuild"
    private const val KEY_PENDING = "pendingBuild"
    private const val KEY_ATTEMPTS = "pendingAttempts"
    private const val MAX_BOOT_ATTEMPTS = 2
    private const val CAP_PREFS = "CapWebViewSettings"
    private const val CAP_SERVER_PATH = "serverBasePath"
    private const val COMPLETE_MARKER = ".complete"

    // 构建标记会拼进目录名：拒绝 `..` 与单独一个 `.`，其余字符只允许安全集合。
    internal val BUILD_PATTERN = Regex("^(?!.*\\.\\.)(?!\\.$)[A-Za-z0-9._-]{1,64}$")

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun root(context: Context): File = File(context.filesDir, "web-update")

    fun bundleDir(context: Context, build: String): File? =
        if (BUILD_PATTERN.matches(build)) File(root(context), "bundles/$build") else null

    fun isComplete(context: Context, build: String): Boolean {
        val dir = bundleDir(context, build) ?: return false
        return File(dir, COMPLETE_MARKER).isFile && File(dir, "index.html").isFile
    }

    fun activeBuild(context: Context): String? =
        prefs(context).getString(KEY_ACTIVE, null)?.takeIf { isComplete(context, it) }

    fun pendingBuild(context: Context): String? =
        prefs(context).getString(KEY_PENDING, null)?.takeIf { isComplete(context, it) }

    /**
     * 启动时决定这次用哪个目录，并把结果写进 Capacitor 的 `serverBasePath`。
     * 必须在 `super.onCreate` 之前调用：Capacitor 在 `loadWebView()` 里读这个键。
     */
    fun prepareBoot(context: Context) {
        val store = prefs(context)
        val shellVersion = BuildConfig.VERSION_NAME
        if (store.getString(KEY_SHELL_VERSION, null) != shellVersion) {
            clearAll(context)
            store.edit().putString(KEY_SHELL_VERSION, shellVersion).apply()
            return
        }

        val active = activeBuild(context)
        val pending = pendingBuild(context)
        if (pending == null) {
            useBundle(context, active)
            return
        }
        val attempts = store.getInt(KEY_ATTEMPTS, 0) + 1
        if (attempts > MAX_BOOT_ATTEMPTS) {
            // 连续几次启动都没有页面来确认：这个包加载不起来，丢掉它回到内嵌产物。
            bundleDir(context, pending)?.deleteRecursively()
            store.edit().remove(KEY_PENDING).remove(KEY_ATTEMPTS).apply()
            useBundle(context, active)
            return
        }
        store.edit().putInt(KEY_ATTEMPTS, attempts).apply()
        useBundle(context, pending)
    }

    private fun useBundle(context: Context, build: String?) {
        val path = build?.let { bundleDir(context, it)?.absolutePath }
        setServerBasePath(context, path ?: "")
    }

    /** 页面确认自己是从这个包加载起来的：把待确认转成当前包。 */
    fun confirm(context: Context, build: String): Boolean {
        val store = prefs(context)
        if (store.getString(KEY_PENDING, null) != build) return false
        if (!isComplete(context, build)) return false
        store.edit()
            .putString(KEY_ACTIVE, build)
            .remove(KEY_PENDING)
            .remove(KEY_ATTEMPTS)
            .apply()
        bundleDir(context, build)?.let { setServerBasePath(context, it.absolutePath) }
        return true
    }

    /** 新包解压完成：指针切到它，但等页面确认后才算「当前包」。 */
    fun markPending(context: Context, build: String) {
        prefs(context).edit()
            .putString(KEY_PENDING, build)
            .putInt(KEY_ATTEMPTS, 0)
            .apply()
        bundleDir(context, build)?.let { setServerBasePath(context, it.absolutePath) }
    }

    fun setServerBasePath(context: Context, path: String) {
        context.getSharedPreferences(CAP_PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(CAP_SERVER_PATH, path)
            .apply()
    }

    /** 只保留指定构建的资源目录，其余（含解压到一半的）全部删除。 */
    fun cleanup(context: Context, keep: Set<String>) {
        val bundles = File(root(context), "bundles")
        val entries = bundles.listFiles() ?: return
        for (entry in entries) {
            if (entry.name !in keep) entry.deleteRecursively()
        }
    }

    fun clearAll(context: Context) {
        root(context).deleteRecursively()
        prefs(context).edit().clear().apply()
        setServerBasePath(context, "")
    }
}
