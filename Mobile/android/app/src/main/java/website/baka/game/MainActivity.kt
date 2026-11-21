package website.baka.game

import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature
import com.getcapacitor.Bridge
import com.getcapacitor.BridgeActivity
import com.getcapacitor.BridgeWebViewClient
import com.getcapacitor.CapConfig
import org.json.JSONObject
import website.baka.game.channel.BakaChannelPlugin
import website.baka.game.network.DnsProxyServer
import website.baka.game.network.HttpDns
import website.baka.game.shell.BakaShellPlugin
import website.baka.game.shell.ClientUserAgent
import website.baka.game.shell.SystemBarsController
import website.baka.game.update.BakaHotUpdatePlugin
import website.baka.game.update.HotUpdateStore
import java.io.File
import java.util.concurrent.Executor

/**
 * Capacitor 壳主 Activity：装载内嵌前端、注册通道插件、放行跨站 Cookie、
 * 开启 WebAuthn 并放行接口请求，外加启动画面、系统栏/挖孔/软键盘的避让（SystemBarsController），
 * 以及把系统返回键交给页面。
 * 不含任何业务 UI（UI 全部来自内嵌的 Client 构建产物）。
 *
 * 窗口级防截屏不在这里：它按房间开关，见 BakaChannelPlugin.setSecureScreen。
 *
 * 两点必须按 Capacitor 7 的口径来写，否则编译直接失败：
 * - 本地插件用 `registerPlugin(Class)` 登记，且**必须在 `super.onCreate` 之前** ——
 *   bridge 是在 `super.onCreate` 里按这份清单初始化的，晚一步插件就不在桥里。
 * - 不再 override `init()`：那是 Capacitor 更早版本的扩展点，7.x 的 `BridgeActivity`
 *   没有这个可覆写方法（`FragmentActivity` 里的同名方法是 private），
 *   `override fun init()` 会报 "'init' overrides nothing" 与 "it is private"。
 */
class MainActivity : BridgeActivity() {

    private var dnsProxy: DnsProxyServer? = null

    /** 页面已经画出第一帧（WebViewClient.onPageCommitVisible）；启动画面留到这一刻。 */
    @Volatile
    private var pageVisible = false

    private var systemBars: SystemBarsController? = null

    /**
     * 系统返回键交给页面（`window.__BAKA_SHELL_BACK__`，见 Mobile/bridge/baka-bridge.js）：
     * 关浮层、房间页弹离开确认、退回上一页，首页再退到后台。
     *
     * 所有系统版本上一直拦截。实测安卓 16 打开预测式返回后，首页不拦截时系统会结束 Activity
     * （即使从启动器进入），回来时页面重载、对局断开；安卓 7 到 11 的默认返回同样会结束它。
     * 代价是首页返回没有系统「回到桌面」的预测动画，换来的是退到后台后页面与连接都还在。
     */
    private val backToPage =
        object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                dispatchBackToPage()
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        // 必须在 super.onCreate 之前：它把启动主题换成 postSplashScreenTheme，并接管系统启动画面。
        val splash = installSplashScreen()
        registerPlugin(BakaChannelPlugin::class.java)
        registerPlugin(BakaHotUpdatePlugin::class.java)
        registerPlugin(BakaShellPlugin::class.java)
        // 必须在 super.onCreate 之前：Capacitor 在 super 里创建 WebView 并读取
        // `CapWebViewSettings.serverBasePath`，晚一步就会先加载内嵌产物、再被热更新目录覆盖。
        // 启动路径选择失败不能把应用带崩：退回内嵌产物，下次热更新仍会重试。
        try {
            HotUpdateStore.prepareBoot(this)
        } catch (err: Exception) {
            Log.w(TAG, "热更新启动检查失败，按内嵌产物启动：${err.message}")
            try {
                HotUpdateStore.setServerBasePath(this, "")
            } catch (_: Exception) {
                // 连 SharedPreferences 都写不了时只能交给 Capacitor 自己的缺省行为。
            }
        }
        // UA 段要在 super.onCreate 之前定下：Capacitor 在 super 里按 config 初始化 WebView
        // 并立即 loadUrl，晚一步首个页面就带着旧 UA 提交，整个会话的接口请求都跟着它。
        // 生效的资源目录此时已由 prepareBoot 定好，游戏版本从那份资源的 version.json 读。
        val userAgent = ClientUserAgent.resolve(this)
        runtimeConfig(userAgent)?.let { config = it }
        // 必须在 super.onCreate 之前应用：bridge 会在 super 里创建 WebView 并 loadUrl，
        // 覆写晚于页面加载时，该 WebView 的首批请求仍会直连，已有连接还会被复用。
        prepareHttpDns()
        applyHttpDnsProxy()
        super.onCreate(savedInstanceState)
        // 启动画面留到页面画出第一帧：否则它一退场就露出还没内容的 WebView。
        // 设上限兜底，页面出错时不至于一直卡在启动画面上。
        val splashDeadline = SystemClock.uptimeMillis() + SPLASH_MAX_MS
        splash.setKeepOnScreenCondition {
            !pageVisible && SystemClock.uptimeMillis() < splashDeadline
        }
        // 注意：这里**不**设 FLAG_SECURE。窗口级防截屏只在反作弊房里开 —— 由页面根据
        // 房间快照经 BakaChannel.setSecureScreen 切换（见 Client/src/lib/BakaChannel.ts）。
        // 启动即全量开启会让普通玩家连截图分享都做不到。
        val bridge = bridge ?: return
        val webView = bridge.webView
        // 兜底：运行期配置没写成时，至少让之后的导航带上 UA 段（首个页面可能已按默认 UA 提交）。
        if (!webView.settings.userAgentString.contains(userAgent)) {
            webView.settings.userAgentString = webView.settings.userAgentString + " " + userAgent
        }
        // 边到边与插图避让；同时给 WebView 铺上与启动画面同一档的底色（默认白底会在暗色下白闪）。
        systemBars = SystemBarsController(this).also { it.attach(webView) }
        // 页面 origin 是 https://localhost（未配置 server.hostname 时），接口在公网域名上 ——
        // 会话 Cookie 属于跨站 Cookie。Capacitor 自己没有设置这个开关，不同 WebView 版本默认值
        // 不一致；显式打开，否则登录态在壳内时有时无（表现为昵称读不到、验证码发不出、WS 是游客）。
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)

        // WebView 默认不暴露 WebAuthn。系统 WebView 124+ 内置支持，但必须由宿主显式开启；
        // FOR_APP 只放行与宿主应用关联的站点（rpID 域 + assetlinks.json），不是浏览器模式。
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_AUTHENTICATION)) {
            WebSettingsCompat.setWebAuthenticationSupport(
                webView.settings,
                WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_APP
            )
        }

        // server.hostname 把内嵌资源挂到站点域名后，/api/* 也落在该域名下：Capacitor 的本地
        // 资源服务会用 index.html 回答无扩展名的路径。接口与 WS 必须交给真实网络，其余路径
        // 仍走本地服务（SPA 深链刷新才不会 404）。
        bridge.setWebViewClient(ApiPassthroughWebViewClient(bridge) { pageVisible = true })

        onBackPressedDispatcher.addCallback(this, backToPage)
    }

    /** 页面回报的实际外观（BakaShell.setSystemBars）：系统栏图标深浅与让出区域的底色跟着它走。 */
    fun applyPageAppearance(dark: Boolean, color: Int?) {
        runOnUiThread { systemBars?.update(dark, color) }
    }

    /** 首页返回：退到后台，不结束 Activity（安卓 7 到 11 的默认返回会结束它并断开对局）。 */
    fun moveToBackground() {
        runOnUiThread { moveTaskToBack(true) }
    }

    /**
     * 把返回交给页面。页面没有桥接（加载失败、白屏）或脚本出错时，直接退到后台，
     * 不让玩家卡在一个按返回没有反应的界面上。
     */
    private fun dispatchBackToPage() {
        val webView = bridge?.webView
        if (webView == null) {
            moveTaskToBack(true)
            return
        }
        webView.evaluateJavascript(BACK_SCRIPT) { result ->
            if (result != "\"ok\"") moveTaskToBack(true)
        }
    }

    override fun onDestroy() {
        stopHttpDns()
        super.onDestroy()
    }

    /**
     * 在打包的 capacitor.config.json 上加一项 `android.appendUserAgent`，写到应用私有目录再交给 Capacitor。
     * `appendUserAgent` 本是静态配置，带不了运行期才知道的游戏版本；这样其余配置原样保留，
     * Capacitor 在初始化 WebView 时（加载页面之前）把它接到系统默认 UA 之后。失败返回 null，按默认配置启动。
     */
    private fun runtimeConfig(userAgent: String): CapConfig? = try {
        val packaged = assets.open("capacitor.config.json").use { it.readBytes().toString(Charsets.UTF_8) }
        val json = JSONObject(packaged)
        val android = json.optJSONObject("android") ?: JSONObject().also { json.put("android", it) }
        val existing = android.optString("appendUserAgent", "").trim()
        android.put("appendUserAgent", if (existing.isEmpty()) userAgent else "$existing $userAgent")
        val dir = File(filesDir, RUNTIME_CONFIG_DIR).apply { mkdirs() }
        File(dir, "capacitor.config.json").writeText(json.toString())
        CapConfig.loadFromFile(this, dir.absolutePath)
    } catch (err: Exception) {
        Log.w(TAG, "运行期配置写入失败，按打包配置启动：${err.message}")
        null
    }

    /**
     * 构建期注入了 HTTPDNS 凭据且 WebView 支持代理覆写时，把请求交给回环 CONNECT 隧道：
     * 隧道只替换解析结果，TLS 与 SNI 仍是原域名。任一环节不满足就保持系统 DNS。
     */
    private fun prepareHttpDns() {
        val resolver = HttpDns.fromBuildConfig() ?: return
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
            Log.w(TAG, "HTTPDNS 已配置，但当前 WebView 不支持代理覆写，继续使用系统 DNS")
            return
        }
        dnsProxy = try {
            DnsProxyServer.start(resolver)
        } catch (err: Exception) {
            Log.w(TAG, "HTTPDNS 回环隧道启动失败，继续使用系统 DNS：${err.message}")
            null
        }
    }

    private fun applyHttpDnsProxy() {
        val proxy = dnsProxy ?: return
        try {
            ProxyController.getInstance().setProxyOverride(
                ProxyConfig.Builder()
                    .addProxyRule("http://127.0.0.1:${proxy.port}")
                    .addBypassRule("127.0.0.1")
                    .addBypassRule("localhost")
                    .build(),
                Executor { it.run() },
            ) {
                Log.i(TAG, "HTTPDNS 回环隧道已启用，端口 ${proxy.port}")
            }
        } catch (err: Exception) {
            dnsProxy = null
            proxy.close()
            Log.w(TAG, "HTTPDNS 代理覆写失败，继续使用系统 DNS：${err.message}")
        }
    }

    private fun stopHttpDns() {
        val proxy = dnsProxy ?: return
        dnsProxy = null
        try {
            ProxyController.getInstance().clearProxyOverride(Executor { it.run() }) {
                Log.i(TAG, "HTTPDNS 代理覆写已清除")
            }
        } catch (err: Exception) {
            Log.w(TAG, "清除 HTTPDNS 代理覆写失败：${err.message}")
        }
        proxy.close()
    }

    private companion object {
        private const val TAG = "BakaMain"

        /** 启动画面最多停留这么久：页面迟迟画不出来时宁可露出底色，也不让玩家以为应用卡死。 */
        private const val SPLASH_MAX_MS = 3000L

        /** 运行期配置（打包配置 + UA 段）落盘的目录，位于应用私有目录下。 */
        private const val RUNTIME_CONFIG_DIR = "shell-config"

        /** 调用桥接的返回处理；返回 "ok" 表示页面已接手（结果是 JSON 序列化后的字符串）。 */
        private const val BACK_SCRIPT =
            "(function(){try{if(typeof window.__BAKA_SHELL_BACK__!=='function')return 'missing';" +
                "window.__BAKA_SHELL_BACK__();return 'ok'}catch(e){return 'error'}})()"
    }
}

private class ApiPassthroughWebViewClient(
    bridge: Bridge,
    private val onFirstVisible: () -> Unit,
) : BridgeWebViewClient(bridge) {
    override fun onPageCommitVisible(view: WebView, url: String) {
        super.onPageCommitVisible(view, url)
        onFirstVisible()
    }

    override fun shouldInterceptRequest(
        view: WebView,
        request: WebResourceRequest
    ): WebResourceResponse? {
        val path = request.url.path
        if (path != null && (path == "/api" || path.startsWith("/api/"))) return null
        return super.shouldInterceptRequest(view, request)
    }
}
