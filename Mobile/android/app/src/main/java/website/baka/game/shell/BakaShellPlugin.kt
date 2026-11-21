package website.baka.game.shell

import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import website.baka.game.MainActivity

/**
 * 壳的界面能力：页面把自己的实际外观告诉原生，原生据此给系统栏配色；
 * 系统返回键交给页面处理，页面在首页时请原生把应用退到后台。
 *
 * 只由 `Mobile/bridge/baka-bridge.js` 调用，不挂到页面可见的 `__BAKA_CHANNEL__` 上，
 * 与通道证明（BakaChannel）分开：这里只有界面，不涉及密钥与票据。
 * 插件方法跑在 Capacitor 的插件线程上，碰窗口的操作一律切回主线程（在 MainActivity 里做）。
 */
@CapacitorPlugin(name = "BakaShell")
class BakaShellPlugin : Plugin() {

    /**
     * `{ dark: boolean, color: "#rrggbb" }`：页面当前是否暗色、页面底色。
     * 暗色决定状态栏与导航栏图标用浅色，底色铺在系统栏与挖孔区。颜色格式不对时只更新明暗。
     */
    @PluginMethod
    fun setSystemBars(call: PluginCall) {
        val dark = call.getBoolean("dark")
        if (dark == null) {
            call.reject("BAKA_SHELL_BAD_ARGUMENT")
            return
        }
        val host = activity as? MainActivity
        if (host == null) {
            call.reject("BAKA_SHELL_NO_WINDOW")
            return
        }
        host.applyPageAppearance(dark, ShellUiPolicy.parseOpaqueHex(call.getString("color")))
        call.resolve()
    }

    /** 首页按返回：把应用退到后台而不是结束，回来时页面、对局与连接都还在。 */
    @PluginMethod
    fun moveToBack(call: PluginCall) {
        val host = activity as? MainActivity
        if (host == null) {
            call.reject("BAKA_SHELL_NO_WINDOW")
            return
        }
        host.moveToBackground()
        call.resolve()
    }
}
