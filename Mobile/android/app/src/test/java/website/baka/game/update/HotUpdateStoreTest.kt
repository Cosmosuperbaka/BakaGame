package website.baka.game.update

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HotUpdateStoreTest {
    private fun ok(build: String) = HotUpdateStore.BUILD_PATTERN.matches(build)

    @Test fun ordinaryBuildMarksAreAccepted() {
        for (build in listOf("abc123", "20261112-1", "v1.2.3", "a_b-c.d", "x".repeat(64))) {
            assertTrue(build, ok(build))
        }
    }

    // 构建标记会拼进目录名：任何能跳出 bundles 目录或造出隐藏目录的写法都必须被拒
    @Test fun pathTraversalAndSeparatorsAreRejected() {
        for (build in listOf("..", ".", "../x", "x/../y", "a..b", "a/b", "a\\b", "/abs", "C:\\x")) {
            assertFalse(build, ok(build))
        }
    }

    @Test fun emptyOverlongAndOddCharactersAreRejected() {
        for (build in listOf("", "x".repeat(65), "a b", "a\u0000b", "中文", "a\nb")) {
            assertFalse(build.replace("\u0000", "\\0"), ok(build))
        }
    }
}
