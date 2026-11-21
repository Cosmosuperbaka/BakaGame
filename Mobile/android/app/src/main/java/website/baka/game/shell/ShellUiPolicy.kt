package website.baka.game.shell

/**
 * 壳的界面规则里能脱离 Android 运行时单测的部分：页面回报的颜色怎么解析、
 * 内容区要让出多少边距。调用方（MainActivity）只负责把系统给的插图与页面回报的值喂进来。
 */
internal object ShellUiPolicy {
    private val HEX_COLOR = Regex("^#[0-9a-fA-F]{6}$")

    /**
     * 页面回报的底色只认 `#rrggbb`，结果恒为不透明：系统栏与挖孔区铺的是这块底色，
     * 半透明会透出窗口背后的东西。格式不对返回 null，调用方保留上一次的颜色。
     */
    fun parseOpaqueHex(raw: String?): Int? {
        val text = raw?.trim() ?: return null
        if (!HEX_COLOR.matches(text)) return null
        return (0xFF shl 24) or text.substring(1).toInt(16)
    }

    /** 内容区（WebView 的父容器）四边的内边距，单位与插图一致（像素）。 */
    data class Padding(val left: Int, val top: Int, val right: Int, val bottom: Int)

    /**
     * 系统栏与挖孔已经按边取大（调用方用合并后的插图类型取值），底边再与输入法取大：
     * 键盘弹出时整个内容区让到键盘上方，与安卓 14 及以前 adjustResize 的效果一致，
     * 也不依赖 WebView 自己是否会按输入法缩小可视区域（那要 M139 起才有）。
     */
    fun contentPadding(left: Int, top: Int, right: Int, bottom: Int, imeBottom: Int): Padding =
        Padding(
            left.coerceAtLeast(0),
            top.coerceAtLeast(0),
            right.coerceAtLeast(0),
            maxOf(bottom, imeBottom).coerceAtLeast(0),
        )
}
