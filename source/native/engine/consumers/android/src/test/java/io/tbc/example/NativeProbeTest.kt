package io.tbc.example

import io.tbc.engine.TbcEngine
import io.tbc.engine.TbcEngineMethod
import io.tbc.engine.TbcEngineFailure
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.junit.Test
import org.junit.Assert.*
import java.io.File

// Actual packaged Kotlin classes and JNI boundary, backed by the exact candidate's
// macOS C ABI for this host test. This does NOT execute the Android ELF binaries.
class NativeProbeTest {
    @Test fun nativeEnvelopeParityAndConcurrency() = runBlocking {
        val cases = JSONArray(File(System.getProperty("nativeProbeVectors")).readText())
        val engine = TbcEngine()
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val method = TbcEngineMethod.entries.single { it.wireName == c.getString("method") }
            assertEquals(c.getString("expected"), engine.callEnvelope(method, c.getString("input")))
        }
        val first = cases.getJSONObject(0)
        (1..16).map { async {
            assertEquals(first.getString("expected"), engine.normalizeRequest(first.getString("input")))
        } }.awaitAll()
        println("KOTLIN_NATIVE_PROBE_PASS cases=${cases.length()} concurrent=16")
    }

    @Test fun identityAndErrorMapping() = runBlocking {
        try { TbcEngine("wrong"); fail("identity mismatch accepted") } catch (_: IllegalArgumentException) {}
        val engine = TbcEngine()
        for (method in TbcEngineMethod.entries) {
            try {
                when (method) {
                    TbcEngineMethod.NORMALIZE_REQUEST -> engine.normalizeRequest("中文🍈")
                    TbcEngineMethod.PLAN -> engine.plan("{}")
                    TbcEngineMethod.VALIDATE -> engine.validate("{}")
                    TbcEngineMethod.FINALIZE -> engine.finalize("{}")
                }
                fail("Engine error not mapped")
            } catch (error: TbcEngineFailure) { assertTrue(error.code.isNotEmpty()) }
        }
    }
}
