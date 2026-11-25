package website.baka.game.shell

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.TimeInterpolator
import android.animation.ValueAnimator
import android.graphics.Outline
import android.os.Build
import android.view.View
import android.view.ViewOutlineProvider
import androidx.activity.BackEventCompat

/**
 * 应用内预测式返回的预演：把 [BackPreviewPolicy] 算出的形态套到整页（WebView）上。
 *
 * 只在「退回上一页」时用（见 [ShellUiPolicy.previewsBack]）：SPA 的上一页不在屏幕外等着，
 * 所以不做「揭开上一页」，而是让当前页像卡片一样被拿起、背后压暗；松手后页面换成上一页，
 * 卡片弹回原位；取消就原样弹回。系统关了动画（开发者选项「移除动画」等）时不预演。
 *
 * 必须在主线程调用（OnBackPressedCallback 的回调本来就在主线程）。
 */
internal class BackPreview(
    private val target: View,
    /** 背后压暗的比例（0..1 已乘过 MAX_DIM），由系统栏控制器铺到父容器底色上。 */
    private val onDim: (Float) -> Unit,
) {
    private var active = false
    private var startTouchY = 0f
    private var direction = 0f
    private var progress = 0f
    private var deltaY = 0f
    private var cornerRadius = 0f
    private var settle: ValueAnimator? = null
    private var savedOutline: ViewOutlineProvider? = null
    private var savedClip = false

    private val rounded =
        object : ViewOutlineProvider() {
            override fun getOutline(view: View, outline: Outline) {
                outline.setRoundRect(0, 0, view.width, view.height, cornerRadius)
            }
        }

    fun start(event: BackEventCompat) {
        settle?.cancel()
        settle = null
        if (!animationsEnabled()) {
            if (active) reset()
            return
        }
        if (!active) {
            savedOutline = target.outlineProvider
            savedClip = target.clipToOutline
            target.outlineProvider = rounded
            target.clipToOutline = true
            active = true
        }
        startTouchY = event.touchY
        direction = BackPreviewPolicy.edgeDirection(event.swipeEdge)
        render(event.progress, 0f)
    }

    fun progress(event: BackEventCompat) {
        if (!active || settle != null) return
        render(event.progress, event.touchY - startTouchY)
    }

    /** 松手（已提交返回）或取消：从当前形态弹回原位，结束后撤掉圆角裁切与压暗。 */
    fun release() {
        if (!active || settle != null) return
        val fromProgress = progress
        val fromDeltaY = deltaY
        settle =
            ValueAnimator.ofFloat(1f, 0f).apply {
                duration = BackPreviewPolicy.SETTLE_MS
                interpolator = TimeInterpolator { BackPreviewPolicy.settle(it) }
                addUpdateListener {
                    val left = it.animatedValue as Float
                    render(fromProgress * left, fromDeltaY * left)
                }
                addListener(
                    object : AnimatorListenerAdapter() {
                        private var cancelled = false

                        override fun onAnimationCancel(animation: Animator) {
                            cancelled = true
                        }

                        override fun onAnimationEnd(animation: Animator) {
                            // 被新的一次手势打断时不复位：新手势从当前形态接着跟手。
                            if (cancelled) return
                            settle = null
                            reset()
                        }
                    }
                )
                start()
            }
    }

    private fun render(rawProgress: Float, touchDeltaY: Float) {
        val frame =
            BackPreviewPolicy.frame(
                rawProgress,
                target.width,
                target.height,
                target.resources.displayMetrics.density,
                direction,
                touchDeltaY,
            )
        progress = if (rawProgress.isNaN()) 0f else rawProgress.coerceIn(0f, 1f)
        deltaY = if (touchDeltaY.isNaN()) 0f else touchDeltaY
        target.scaleX = frame.scale
        target.scaleY = frame.scale
        target.translationX = frame.translationX
        target.translationY = frame.translationY
        cornerRadius = frame.cornerRadius
        target.invalidateOutline()
        onDim(frame.dim)
    }

    private fun reset() {
        active = false
        progress = 0f
        deltaY = 0f
        cornerRadius = 0f
        target.scaleX = 1f
        target.scaleY = 1f
        target.translationX = 0f
        target.translationY = 0f
        target.outlineProvider = savedOutline
        target.clipToOutline = savedClip
        savedOutline = null
        onDim(0f)
    }

    private fun animationsEnabled(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.O || ValueAnimator.areAnimatorsEnabled()
}
