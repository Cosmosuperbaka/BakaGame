package website.baka.game

import android.os.Bundle
import android.view.WindowManager
import android.webkit.CookieManager
import com.getcapacitor.BridgeActivity
import website.baka.game.channel.BakaChannelPlugin

/**
 * Capacitor 壳主 Activity。只做四件事：装载内嵌前端、注册通道插件、窗口级防录屏、
 * 放行跨站 Cookie。
 * 不含任何业务 UI（UI 全部来自内嵌的 Client 构建产物）。
 *
 * 两点必须按 Capacitor 7 的口径来写，否则编译直接失败：
 * - 本地插件用 `registerPlugin(Class)` 登记，且**必须在 `super.onCreate` 之前** ——
 *   bridge 是在 `super.onCreate` 里按这份清单初始化的，晚一步插件就不在桥里。
 * - 不再 override `init()`：那是 Capacitor 更早版本的扩展点，7.x 的 `BridgeActivity`
 *   没有这个可覆写方法（`FragmentActivity` 里的同名方法是 private），
 *   `override fun init()` 会报 "'init' overrides nothing" 与 "it is private"。
 */
class MainActivity : BridgeActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(BakaChannelPlugin::class.java)
        super.onCreate(savedInstanceState)
        // FLAG_SECURE：系统层阻断截屏/录屏/MediaProjection 对本窗口的采集（计划 P3.3）
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        // 页面 origin 是 https://localhost，接口在公网域名上 —— 会话 Cookie 属于跨站 Cookie。
        // Capacitor 自己没有设置这个开关，不同 WebView 版本默认值不一致；显式打开，
        // 否则登录态在壳内时有时无（表现为昵称读不到、验证码发不出、WS 是游客）。
        bridge?.webView?.let { webView ->
            CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)
        }
    }
}
