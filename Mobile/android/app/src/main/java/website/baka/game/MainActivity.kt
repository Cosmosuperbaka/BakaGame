package website.baka.game

import android.os.Bundle
import android.util.Log
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature
import com.getcapacitor.Bridge
import com.getcapacitor.BridgeActivity
import com.getcapacitor.BridgeWebViewClient
import website.baka.game.channel.BakaChannelPlugin
import website.baka.game.network.DnsProxyServer
import website.baka.game.network.HttpDns
import java.util.concurrent.Executor

/**
 * Capacitor 壳主 Activity。只做四件事：装载内嵌前端、注册通道插件、放行跨站 Cookie、
 * 开启 WebAuthn 并放行接口请求。
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

    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(BakaChannelPlugin::class.java)
        // 必须在 super.onCreate 之前应用：bridge 会在 super 里创建 WebView 并 loadUrl，
        // 覆写晚于页面加载时，该 WebView 的首批请求仍会直连，已有连接还会被复用。
        prepareHttpDns()
        applyHttpDnsProxy()
        super.onCreate(savedInstanceState)
        // 注意：这里**不**设 FLAG_SECURE。窗口级防截屏只在反作弊房里开 —— 由页面根据
        // 房间快照经 BakaChannel.setSecureScreen 切换（见 Client/src/lib/BakaChannel.ts）。
        // 启动即全量开启会让普通玩家连截图分享都做不到。
        val bridge = bridge ?: return
        val webView = bridge.webView
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
        bridge.setWebViewClient(ApiPassthroughWebViewClient(bridge))
    }

    override fun onDestroy() {
        stopHttpDns()
        super.onDestroy()
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
    }
}

private class ApiPassthroughWebViewClient(bridge: Bridge) : BridgeWebViewClient(bridge) {
    override fun shouldInterceptRequest(
        view: WebView,
        request: WebResourceRequest
    ): WebResourceResponse? {
        val path = request.url.path
        if (path != null && (path == "/api" || path.startsWith("/api/"))) return null
        return super.shouldInterceptRequest(view, request)
    }
}
