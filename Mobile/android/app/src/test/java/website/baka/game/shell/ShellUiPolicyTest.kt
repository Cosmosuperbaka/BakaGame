package website.baka.game.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import website.baka.game.shell.ShellUiPolicy.BackMode

class ShellUiPolicyTest {
    @Test fun parsesOpaqueHexOnly() {
        assertEquals(0xFFF5F1E6.toInt(), ShellUiPolicy.parseOpaqueHex("#f5f1e6"))
        assertEquals(0xFF2D2621.toInt(), ShellUiPolicy.parseOpaqueHex(" #2D2621 "))
        // 只认 #rrggbb：带透明度、简写、颜色函数与空值一律不收，调用方保留上一次的颜色
        for (bad in listOf(null, "", "#fff", "#f5f1e6ff", "rgb(1, 2, 3)", "oklch(0.9 0.01 90)", "f5f1e6")) {
            assertNull("不该接受 $bad", ShellUiPolicy.parseOpaqueHex(bad))
        }
    }

    @Test fun keyboardRaisesOnlyTheBottomEdge() {
        // 手势条 63px、键盘 900px：底边取键盘，其余三边照旧
        assertEquals(
            ShellUiPolicy.Padding(0, 136, 0, 900),
            ShellUiPolicy.contentPadding(0, 136, 0, 63, imeBottom = 900),
        )
        // 键盘收起（插图为 0）时底边回到导航栏高度，不残留键盘的内边距
        assertEquals(
            ShellUiPolicy.Padding(0, 136, 0, 63),
            ShellUiPolicy.contentPadding(0, 136, 0, 63, imeBottom = 0),
        )
    }

    @Test fun landscapeCutoutPadsTheSide() {
        assertEquals(
            ShellUiPolicy.Padding(136, 0, 0, 63),
            ShellUiPolicy.contentPadding(136, 0, 0, 63, imeBottom = 0),
        )
    }

    @Test fun parsesOnlyTheFourBackModes() {
        assertEquals(BackMode.OVERLAY, ShellUiPolicy.parseBackMode("overlay"))
        assertEquals(BackMode.CLAIM, ShellUiPolicy.parseBackMode("claim"))
        assertEquals(BackMode.NAVIGATE, ShellUiPolicy.parseBackMode(" navigate "))
        assertEquals(BackMode.ROOT, ShellUiPolicy.parseBackMode("root"))
        for (bad in listOf(null, "", "ROOT", "home", "back")) {
            assertNull("不该接受 $bad", ShellUiPolicy.parseBackMode(bad))
        }
    }

    @Test fun onlyRootHandsBackToTheSystem() {
        // 只有首页且没人接手时撤掉拦截，系统才播放回到桌面的动画
        assertFalse(ShellUiPolicy.interceptsBack(BackMode.ROOT))
        for (mode in listOf(BackMode.OVERLAY, BackMode.CLAIM, BackMode.NAVIGATE)) {
            assertTrue("$mode 要拦截", ShellUiPolicy.interceptsBack(mode))
        }
        // 还不知道页面状态（没加载完、旧页面不回报）时照常拦截，交给页面兜底
        assertTrue(ShellUiPolicy.interceptsBack(null))
    }

    @Test fun onlyNavigationIsPreviewed() {
        assertTrue(ShellUiPolicy.previewsBack(BackMode.NAVIGATE))
        // 关浮层、弹确认都不会离开当前页；首页交给系统自己的动画
        for (mode in listOf(BackMode.OVERLAY, BackMode.CLAIM, BackMode.ROOT, null)) {
            assertFalse("$mode 不预演", ShellUiPolicy.previewsBack(mode))
        }
    }
}
