package website.baka.game.shell

import androidx.activity.BackEventCompat
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sign

/**
 * 应用内预测式返回的形态（纯计算，JVM 单测可测）：玩家从屏幕边缘往里滑时，整页跟着手势缩小、
 * 向手指一侧平移、圆角变大、背后压暗，读作「这一页正被拿开」；松手退回上一页，或取消后弹回原位。
 *
 * 幅度取 Material 3 预测式返回对全屏页面的口径：最多缩到 90%，平移不越过离边 8dp 的留白，
 * 纵向只跟手指走一小段。系统自己的回到桌面、跨任务动画由系统画，不经过这里。
 */
internal object BackPreviewPolicy {
    /** 手势进度到头时的缩放。 */
    const val MIN_SCALE = 0.9f

    /** 缩小后的页面离屏幕左右边至少留这么宽（dp）。 */
    const val MIN_EDGE_GAP_DP = 8f

    /** 纵向跟手的上限（dp）：只是一点跟随，不让页面被拖着上下跑。 */
    const val MAX_SHIFT_Y_DP = 16f

    /** 进度到头时页面四角的圆角（dp），与系统预测动画里的窗口圆角同一量级。 */
    const val CORNER_DP = 28f

    /** 进度到头时背后压暗的程度（与黑色混合的比例）。 */
    const val MAX_DIM = 0.25f

    /** 松手或取消后回到原位的时长（毫秒）；系统「移除动画」时 ValueAnimator 会直接跳到终点。 */
    const val SETTLE_MS = 320L

    /** 临界阻尼弹簧的角频率（以整段时长为单位）：够快收住、不过冲——整页过冲会把四边裁出屏幕。 */
    private const val SETTLE_OMEGA = 8f

    data class Frame(
        val scale: Float,
        val translationX: Float,
        val translationY: Float,
        val cornerRadius: Float,
        val dim: Float,
    ) {
        companion object {
            val REST = Frame(1f, 0f, 0f, 0f, 0f)
        }
    }

    /** 从哪条边滑进来，页面就往那一侧挪（跟着手指）；按键触发（没有边）时不平移。 */
    fun edgeDirection(swipeEdge: Int): Float =
        when (swipeEdge) {
            BackEventCompat.EDGE_LEFT -> 1f
            BackEventCompat.EDGE_RIGHT -> -1f
            else -> 0f
        }

    /**
     * @param progress 系统给的手势进度（已带系统的缓动），越界或 NaN 收进 0..1
     * @param width 页面宽（像素）
     * @param height 页面高（像素）
     * @param density 每 dp 的像素数
     * @param direction [edgeDirection] 的结果
     * @param touchDeltaY 手指相对起点的纵向位移（像素），按键触发时可能是 NaN
     */
    fun frame(
        progress: Float,
        width: Int,
        height: Int,
        density: Float,
        direction: Float,
        touchDeltaY: Float,
    ): Frame {
        val p = if (progress.isNaN()) 0f else progress.coerceIn(0f, 1f)
        if (width <= 0 || height <= 0) return Frame.REST
        val gap = MIN_EDGE_GAP_DP * density
        val maxShiftX = max(0f, (width - width * MIN_SCALE) / 2f - gap)
        val maxShiftY = min(max(0f, (height - height * MIN_SCALE) / 2f - gap), MAX_SHIFT_Y_DP * density)
        val dy = if (touchDeltaY.isNaN()) 0f else touchDeltaY
        val followY = (abs(dy) / height).coerceIn(0f, 1f)
        return Frame(
            scale = 1f - (1f - MIN_SCALE) * p,
            translationX = maxShiftX * p * direction,
            translationY = maxShiftY * followY * sign(dy),
            cornerRadius = CORNER_DP * density * p,
            dim = MAX_DIM * p,
        )
    }

    /**
     * 回到原位的时间曲线：临界阻尼弹簧 `1 - (1 + ωt)e^(-ωt)`，归一到 t=1 时恰好为 1。
     * 起步有初速度、尾段慢慢收住，读作被弹簧拉回，而不是匀速或对称的缓入缓出。
     */
    fun settle(t: Float): Float {
        val x = t.coerceIn(0f, 1f)
        val end = 1f - (1f + SETTLE_OMEGA) * exp(-SETTLE_OMEGA)
        return (1f - (1f + SETTLE_OMEGA * x) * exp(-SETTLE_OMEGA * x)) / end
    }
}
