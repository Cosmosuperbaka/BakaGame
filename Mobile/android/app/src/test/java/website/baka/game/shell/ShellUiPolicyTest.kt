package website.baka.game.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

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
}
