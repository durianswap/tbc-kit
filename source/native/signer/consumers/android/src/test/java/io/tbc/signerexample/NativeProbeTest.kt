package io.tbc.signerexample
import io.tbc.signer.TbcDigestSigner
import io.tbc.signer.TbcSignatureEncoding
import org.junit.Test
import org.junit.Assert.*
import org.json.JSONObject
import java.io.File

class NativeProbeTest {
    private fun bytes(hex: String) = hex.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    @Test fun publicVectorsAndRejects() {
        val vectors = JSONObject(File(System.getProperty("nativeProbeVectors")).readText()).getJSONArray("vectors")
        var count = 0
        for (i in 0 until vectors.length()) {
            val v = vectors.getJSONObject(i)
            val key = bytes(v.getString("scalar"))
            try {
                for (encoding in listOf(TbcSignatureEncoding.COMPACT64, TbcSignatureEncoding.COMPACT65_RECOVERABLE)) {
                    assertArrayEquals(bytes(v.getString("compact${encoding.size}")), TbcDigestSigner.sign(bytes(v.getString("digest")), key, encoding))
                    assertArrayEquals(bytes(v.getString("scalar")), key)
                    count++
                }
            } finally { key.fill(0) }
        }
        for ((digest, key) in listOf(ByteArray(31) to ByteArray(32) { 1 }, ByteArray(32) to ByteArray(31),
                                     ByteArray(32) to ByteArray(32), ByteArray(32) to ByteArray(32) { -1 })) {
            try { TbcDigestSigner.sign(digest, key, TbcSignatureEncoding.COMPACT64); fail("Invalid input accepted") }
            catch (_: IllegalArgumentException) { count++ }
        }
        assertEquals(52, count)
        println("SIGNER_KOTLIN_JNI_PASS checks=$count")
    }
    @Test fun schnorrVector() { SchnorrProbe.main(emptyArray()) }
}
