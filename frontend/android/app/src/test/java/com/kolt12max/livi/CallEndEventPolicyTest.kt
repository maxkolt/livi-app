package com.kolt12max.livi

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CallEndEventPolicyTest {
    @Test fun remoteEndClosesTheMatchingCall() {
        assertTrue(CallEndEventPolicy.matchesCurrentCall("call-2", "call-2"))
        assertTrue(CallEndEventPolicy.matchesCurrentCall(" call-2 ", "call-2"))
    }

    @Test fun delayedEndCannotCloseRedialOrRandomChat() {
        assertFalse(CallEndEventPolicy.matchesCurrentCall("call-1", "call-2"))
        assertFalse(CallEndEventPolicy.matchesCurrentCall("call-1", null))
        assertFalse(CallEndEventPolicy.matchesCurrentCall("call-1", ""))
    }

    @Test fun missingIdentityCannotActAsWildcard() {
        for (id in listOf(null, "", " ")) {
            assertFalse(CallEndEventPolicy.matchesCurrentCall(id, "call-2"))
            assertFalse(CallEndEventPolicy.matchesCurrentCall(id, id))
        }
    }
}
