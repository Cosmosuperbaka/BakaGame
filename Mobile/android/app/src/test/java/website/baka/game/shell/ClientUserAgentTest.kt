package website.baka.game.shell

import org.junit.Assert.assertEquals
import org.junit.Test

class ClientUserAgentTest {
    @Test fun formatsTheAgreedShape() {
        assertEquals(
            "BakaGame/0.1.6 (Android 15; arm64-v8a; mobile) Game/2.0.3+eb11009",
            ClientUserAgent.format("0.1.6", "15", "arm64-v8a", "2.0.3+eb11009"),
        )
    }

    @Test fun unknownPartsKeepTheShape() {
        assertEquals(
            "BakaGame/0.1.6 (Android unknown; unknown; mobile) Game/unknown",
            ClientUserAgent.format("0.1.6", null, "", null),
        )
        // 只有版本或只有提交号都不算数
        assertEquals(
            "BakaGame/0.1.6 (Android 8.1.0; x86_64; mobile) Game/unknown",
            ClientUserAgent.format("0.1.6", "8.1.0", "x86_64", "2.0.3"),
        )
    }

    @Test fun separatorsCannotBreakTheSegment() {
        // 括号、分号、空格是 UA 的分隔符：混进系统版本或架构里会把整段切坏
        assertEquals(
            "BakaGame/0.1.6 (Android 15Beta; arm64; mobile) Game/2.0.3+eb11009",
            ClientUserAgent.format("0.1.6", "15 (Beta)", "arm64;", "2.0.3+eb11009"),
        )
        assertEquals(
            "BakaGame/0.1.6 (Android 15; arm64-v8a; mobile) Game/unknown",
            ClientUserAgent.format("0.1.6", "15", "arm64-v8a", "2.0.3+eb+11009"),
        )
    }

    @Test fun readsGameVersionFromVersionFile() {
        assertEquals("2.0.3+eb11009", ClientUserAgent.gameVersionFrom("""{"version":"2.0.3","commit":"eb11009"}"""))
        // 完整提交号截成 7 位小写，与页面 bakagame-build 的写法一致
        assertEquals(
            "2.0.3+eb11009",
            ClientUserAgent.gameVersionFrom("""{ "version" : "2.0.3", "build" : "EB11009F00AA" }"""),
        )
        assertEquals(
            "2.1.0-beta.1+0a1b2c3",
            ClientUserAgent.gameVersionFrom("""{"productVersion":"2.1.0-beta.1","shortCommit":"0a1b2c3"}"""),
        )
    }

    @Test fun badVersionFileIsUnknown() {
        for (bad in listOf(
            null,
            "",
            "not json",
            """{"version":"2.0.3"}""",
            """{"commit":"eb11009"}""",
            """{"version":"v2","commit":"eb11009"}""",
            """{"version":"2.0.3","commit":"dev"}""",
            """{"version":"2.0.3 (x)","commit":"eb11009"}""",
        )) {
            assertEquals("不该认 $bad", "unknown", ClientUserAgent.gameVersionFrom(bad))
        }
    }
}
