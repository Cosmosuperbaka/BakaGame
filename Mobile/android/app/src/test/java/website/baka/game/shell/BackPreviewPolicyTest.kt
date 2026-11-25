package website.baka.game.shell

import androidx.activity.BackEventCompat
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BackPreviewPolicyTest {
    // 1080×2400、density 2.75 的常见手机
    private val width = 1080
    private val height = 2400
    private val density = 2.75f

    private fun frame(progress: Float, direction: Float = 1f, dy: Float = 0f) =
        BackPreviewPolicy.frame(progress, width, height, density, direction, dy)

    @Test fun restsAtZeroProgress() {
        assertEquals(BackPreviewPolicy.Frame.REST, frame(0f))
    }

    @Test fun fullProgressShrinksAndKeepsTheEdgeGap() {
        val full = frame(1f)
        assertEquals(BackPreviewPolicy.MIN_SCALE, full.scale, 1e-6f)
        // 缩到 90% 后每边空出 54px，留 8dp（22px）的边距，最多挪 32px
        assertEquals(54f - 8f * density, full.translationX, 1e-3f)
        assertEquals(BackPreviewPolicy.CORNER_DP * density, full.cornerRadius, 1e-3f)
        assertEquals(BackPreviewPolicy.MAX_DIM, full.dim, 1e-6f)
        // 挪完后页面右边缘仍在屏幕内
        val right = width / 2f + width * full.scale / 2f + full.translationX
        assertTrue("右边缘 $right 越出屏幕", right <= width - 8f * density + 1e-3f)
    }

    @Test fun shiftsTowardTheSwipeEdge() {
        assertEquals(BackPreviewPolicy.edgeDirection(BackEventCompat.EDGE_LEFT), 1f, 0f)
        assertEquals(BackPreviewPolicy.edgeDirection(BackEventCompat.EDGE_RIGHT), -1f, 0f)
        // 按键触发（三键导航长按返回）没有边：只缩放不平移
        assertEquals(BackPreviewPolicy.edgeDirection(2), 0f, 0f)
        assertTrue(frame(0.5f, direction = -1f).translationX < 0f)
        assertEquals(0f, frame(0.5f, direction = 0f).translationX, 0f)
    }

    @Test fun followsTheFingerVerticallyWithinACap() {
        val down = frame(1f, dy = height.toFloat())
        assertEquals(BackPreviewPolicy.MAX_SHIFT_Y_DP * density, down.translationY, 1e-3f)
        val up = frame(1f, dy = -height / 2f)
        assertEquals(-BackPreviewPolicy.MAX_SHIFT_Y_DP * density / 2f, up.translationY, 1e-3f)
        // 按键触发时触点是 NaN：不纵向移动
        assertEquals(0f, frame(1f, dy = Float.NaN).translationY, 0f)
    }

    @Test fun clampsBadInput() {
        assertEquals(frame(1f), frame(3f))
        assertEquals(BackPreviewPolicy.Frame.REST, frame(-1f))
        assertEquals(BackPreviewPolicy.Frame.REST, frame(Float.NaN))
        // 视图还没量出尺寸时不变形
        assertEquals(BackPreviewPolicy.Frame.REST, BackPreviewPolicy.frame(1f, 0, 0, density, 1f, 0f))
    }

    @Test fun settleStartsFastAndLandsExactlyWithoutOvershoot() {
        assertEquals(0f, BackPreviewPolicy.settle(0f), 1e-6f)
        assertEquals(1f, BackPreviewPolicy.settle(1f), 1e-6f)
        var previous = 0f
        for (step in 1..100) {
            val value = BackPreviewPolicy.settle(step / 100f)
            assertTrue("第 $step 步回退了", value >= previous)
            assertTrue("第 $step 步过冲了", value <= 1f + 1e-6f)
            previous = value
        }
        // 弹簧起步有初速度：前 30% 的时间走完大半程
        assertTrue(BackPreviewPolicy.settle(0.3f) > 0.6f)
    }
}
