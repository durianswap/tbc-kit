package io.tbc.starter

import io.tbc.engine.TbcEngine
import io.tbc.engine.TbcEngineMethod

/** Keyless glue only; no Context, Activity, vault, fetch, signature or retry. */
class EngineAdapter {
    private val engine = TbcEngine("__ARTIFACT_SET_ID__")
    suspend fun call(method: TbcEngineMethod, canonicalInput: String): String =
        engine.callEnvelope(method, canonicalInput)
}
