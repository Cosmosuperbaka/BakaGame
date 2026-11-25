package website.baka.game.shell

import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.view.View
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.content.ContextCompat
import androidx.core.graphics.ColorUtils
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import website.baka.game.R

/**
 * 系统栏、挖孔与软键盘的避让，以及系统栏的配色。
 *
 * 安卓 15 起 targetSdk 35 强制边到边，WebView 会铺到状态栏、挖孔与手势条下面；Capacitor 7 默认不处理
 * （`adjustMarginsForEdgeToEdge` 缺省为 disable），而它自带的 force/auto 会把输入法插图一并吞掉。
 * 这里在所有系统版本上统一走边到边，自己处理插图：
 *
 * - WebView 的父容器按「系统栏 ∪ 挖孔」加内边距，底边再与输入法取大，内容区整体让开；
 * - 交给 WebView 的插图把这几类置零（不是 CONSUMED，后者会挡住后续变化的通知，留下「幽灵内边距」），
 *   页面里的 `env(safe-area-inset-*)` 因此恒为 0，不会与这里的内边距叠加；
 * - 让出来的那几条边铺页面底色，图标深浅跟随页面实际明暗（由桥接经 BakaShell 插件回报）。
 *
 * 页面还没回报时用上次记下的同一系统明暗下的外观，再没有就用资源里的默认主题底色。
 */
internal class SystemBarsController(private val activity: ComponentActivity) {
    private var container: View? = null
    private var webView: WebView? = null
    private var dark = false
    private var color = Color.TRANSPARENT

    /** 预测式返回预演时背后的压暗比例（0..1），只作用于父容器，不改记下的页面底色。 */
    private var backdropDim = 0f

    fun attach(target: WebView) {
        webView = target
        val parent = target.parent as? View
        container = parent
        val night = isSystemNight()
        val stored = prefs()
        dark = stored.getBoolean(darkKey(night), night)
        color = stored.getInt(colorKey(night), ContextCompat.getColor(activity, R.color.baka_background))
        apply()
        if (parent == null) return
        ViewCompat.setOnApplyWindowInsetsListener(parent) { view, insets ->
            val bars = insets.getInsets(AVOIDED)
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            val padding = ShellUiPolicy.contentPadding(bars.left, bars.top, bars.right, bars.bottom, ime.bottom)
            view.setPadding(padding.left, padding.top, padding.right, padding.bottom)
            WindowInsetsCompat.Builder(insets)
                .setInsets(AVOIDED or WindowInsetsCompat.Type.ime(), Insets.NONE)
                .setDisplayCutout(null)
                .build()
        }
        ViewCompat.requestApplyInsets(parent)
    }

    /** 页面回报的外观；颜色为 null 时只换明暗。必须在主线程调用。 */
    fun update(pageDark: Boolean, pageColor: Int?) {
        dark = pageDark
        if (pageColor != null) color = pageColor
        val night = isSystemNight()
        prefs().edit().putBoolean(darkKey(night), dark).putInt(colorKey(night), color).apply()
        apply()
    }

    /** 预测式返回预演时把页面背后（父容器）压暗；0 恢复原色。必须在主线程调用。 */
    fun setBackdropDim(fraction: Float) {
        backdropDim = fraction.coerceIn(0f, 1f)
        container?.setBackgroundColor(backdropColor())
    }

    private fun backdropColor(): Int =
        if (backdropDim <= 0f) color else ColorUtils.blendARGB(color, Color.BLACK, backdropDim)

    private fun apply() {
        // 状态栏只有图标、没有底色：底色由父容器的内边距区域铺出来。
        val status =
            if (dark) SystemBarStyle.dark(Color.TRANSPARENT)
            else SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)
        // 安卓 8.0 以下导航栏图标只能是浅色：亮色页面上给一层深色遮罩，免得三键导航看不见。
        val navigation =
            if (dark) SystemBarStyle.dark(Color.TRANSPARENT)
            else SystemBarStyle.light(Color.TRANSPARENT, LEGACY_NAV_SCRIM)
        activity.enableEdgeToEdge(status, navigation)
        container?.setBackgroundColor(backdropColor())
        webView?.setBackgroundColor(color)
    }

    private fun isSystemNight(): Boolean =
        (activity.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
            Configuration.UI_MODE_NIGHT_YES

    private fun prefs() = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    // 按系统明暗分两份记：跟随系统的玩家换了系统明暗后，下次启动直接用对应那一份。
    private fun darkKey(night: Boolean) = if (night) "pageDarkNight" else "pageDarkDay"

    private fun colorKey(night: Boolean) = if (night) "pageColorNight" else "pageColorDay"

    private companion object {
        private const val PREFS = "BakaShell"
        private val AVOIDED = WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()

        /** 与 androidx.activity 默认的深色遮罩同值。 */
        private val LEGACY_NAV_SCRIM = Color.argb(0x80, 0x1b, 0x1b, 0x1b)
    }
}
