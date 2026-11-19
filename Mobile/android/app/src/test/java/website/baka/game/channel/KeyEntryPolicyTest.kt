package website.baka.game.channel

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class KeyEntryPolicyTest {
    @Test fun generateOnlyWhenEntryTrulyAbsent() {
        assertTrue(KeyEntryPolicy.mustGenerate(aliasPresent = false, chainPresent = false))
        assertFalse(KeyEntryPolicy.mustGenerate(aliasPresent = true, chainPresent = false))
        assertFalse(KeyEntryPolicy.mustGenerate(aliasPresent = true, chainPresent = true))
        assertFalse(KeyEntryPolicy.mustGenerate(aliasPresent = false, chainPresent = true))
    }

    @Test fun transientFailureIsRetriedThenSucceeds() {
        var calls = 0
        val value = KeyEntryPolicy.readWithRetry(attempts = 3, pauseMs = 0) {
            calls += 1
            if (calls < 3) throw java.security.KeyStoreException("busy")
            "ok"
        }
        assertEquals("ok", value)
        assertEquals(3, calls)
    }

    @Test fun persistentFailureThrowsInsteadOfPretendingNoKey() {
        var calls = 0
        try {
            KeyEntryPolicy.readWithRetry<String>(attempts = 3, pauseMs = 0) {
                calls += 1
                throw java.security.KeyStoreException("down")
            }
            fail("应当抛出")
        } catch (e: KeystoreChannel.ChannelKeyException) {
            assertEquals(3, calls)
        }
    }
}
