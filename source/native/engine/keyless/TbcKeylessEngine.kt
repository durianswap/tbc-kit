package io.tbc.engine

import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

enum class TbcKeylessOperation(val wireName: String) {
    PREPARE_POOL_NFT("preparePoolNft"), PREPARE_ASSET_ANCESTRY("prepareAssetAncestry"),
    POOL_PREVIEW("legacyPoolPreview"), INSPECT_TOKEN_RECEIPT("inspectTokenReceipt"), INSPECT_NFT_RECEIPT("inspectNftReceipt"),
    PREPARE_REVIEWED_STAGE("prepareReviewedStage"), FINALIZE_REVIEWED_STAGE("finalizeReviewedStage"),
    INSPECT_AMM_MATERIAL("inspectAmmMaterial"),
    INSPECT_LOP_MATERIAL("inspectLopMaterial"), INSPECT_TOKEN_MATERIAL("inspectTokenMaterial"),
    DESCRIBE_MULTISIG("describeMultisig"), DECODE_MULTISIG_ADDRESS("decodeMultisigAddress"),
    PREPARE_MULTISIG("prepareMultisig"), INSPECT_MULTISIG("inspectMultisig"),
    VERIFY_MULTISIG_SIGNATURES("verifyMultisigSignatures"), FINALIZE_MULTISIG("finalizeMultisig")
}
internal object TbcKeylessNativeBridge {
    init { System.loadLibrary("tbc_engine_jni") }
    @JvmStatic private external fun callNative(operation: ByteArray, input: ByteArray): ByteArray
    fun call(operation: TbcKeylessOperation, input: String): String {
        val bytes = callNative(operation.wireName.toByteArray(Charsets.UTF_8), input.toByteArray(Charsets.UTF_8))
        return Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
    }
}
/** Companion computation, never a private key or signing operation. */
class TbcKeylessEngine(expectedArtifactSetId: String = TbcEngine.artifactSetId) {
    init { require(expectedArtifactSetId == TbcEngine.artifactSetId) { "TBC_NATIVE_ARTIFACT_MISMATCH" } }
    suspend fun callEnvelope(operation: TbcKeylessOperation, canonicalInput: String): String =
        withContext(Dispatchers.Default) { TbcKeylessNativeBridge.call(operation, canonicalInput) }
}
