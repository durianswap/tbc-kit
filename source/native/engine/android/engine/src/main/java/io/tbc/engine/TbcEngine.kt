package io.tbc.engine

import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

enum class TbcEngineMethod(val wireName: String) {
    NORMALIZE_REQUEST("normalizeRequest"), PLAN("plan"), VALIDATE("validate"), FINALIZE("finalize")
}

class TbcEngineFailure(val code: String, override val message: String, val path: String?) : RuntimeException(message)

internal object TbcEngineNativeBridge {
    init { System.loadLibrary("tbc_engine_jni") }
    @JvmStatic private external fun callNative(method: ByteArray, input: ByteArray): ByteArray

    fun call(method: TbcEngineMethod, input: String): String {
        val bytes = callNative(method.wireName.toByteArray(Charsets.UTF_8), input.toByteArray(Charsets.UTF_8))
        return Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
    }
}

/** Keyless JSON ABI; no Expo, React Native, network, account, approval or private key. */
class TbcEngine(expectedArtifactSetId: String = artifactSetId) {
    init { require(expectedArtifactSetId == artifactSetId) { "TBC_NATIVE_ARTIFACT_MISMATCH" } }
    companion object {
        const val artifactSetId = TbcEngineIdentity.artifactSetId
        const val protocolFingerprint = TbcEngineIdentity.protocolFingerprint
    }

    /** Preserve the Rust envelope intact. Kit adapters can perform their one existing decode. */
    suspend fun callEnvelope(method: TbcEngineMethod, canonicalInput: String): String =
        withContext(Dispatchers.Default) { TbcEngineNativeBridge.call(method, canonicalInput) }

    suspend fun normalizeRequest(input: String): String = execute(TbcEngineMethod.NORMALIZE_REQUEST, input)
    suspend fun plan(input: String): String = execute(TbcEngineMethod.PLAN, input)
    suspend fun validate(input: String): String = execute(TbcEngineMethod.VALIDATE, input)
    suspend fun finalize(input: String): String = execute(TbcEngineMethod.FINALIZE, input)

    // Native-only conveniences throw Engine errors and return the intact success envelope.
    private suspend fun execute(method: TbcEngineMethod, input: String): String {
        val raw = callEnvelope(method, input)
        val envelope = JSONObject(raw)
        check(envelope.optString("version") == "1.0" && envelope.opt("ok") is Boolean) { "Invalid Engine envelope" }
        if (!envelope.getBoolean("ok")) {
            val error = envelope.getJSONObject("error")
            throw TbcEngineFailure(error.getString("code"), error.getString("message"),
                if (error.has("path") && !error.isNull("path")) error.getString("path") else null)
        }
        check(envelope.has("result")) { "Invalid Engine envelope" }
        return raw
    }
}
