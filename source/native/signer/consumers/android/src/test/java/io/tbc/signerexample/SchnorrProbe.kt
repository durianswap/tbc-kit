package io.tbc.signerexample

import io.tbc.signer.TbcDigestSigner
import io.tbc.signer.TbcSignatureEncoding

/** Public BIP340 vector 0; may also run directly on the host JVM/JNI boundary. */
object SchnorrProbe {
    @JvmStatic fun main(args: Array<String>) {
        val key = ByteArray(32); key[31] = 3
        val expected = "e907831f80848d1069a5371b402410364bdf1c5f8307b0084c55f1ce2dca821525f66a4a85ea8b71e482a74f382d2ce5ebeee8fdb2172f477df4900d310536c0"
            .chunked(2).map { it.toInt(16).toByte() }.toByteArray()
        check(TbcSignatureEncoding.SCHNORR64.tag == 164 && TbcSignatureEncoding.SCHNORR64.size == 64)
        val signed = TbcDigestSigner.sign(ByteArray(32), key, TbcSignatureEncoding.SCHNORR64)
        check(signed.contentEquals(expected))
        check(key[31] == 3.toByte())
        check(!signed.contentEquals(TbcDigestSigner.sign(ByteArray(32), key, TbcSignatureEncoding.COMPACT64)))
        key.fill(0)
        try {
            TbcDigestSigner.sign(ByteArray(32), key, TbcSignatureEncoding.SCHNORR64)
            error("Invalid scalar accepted")
        } catch (_: IllegalArgumentException) { }
        println("SCHNORR_KOTLIN_JNI_PASS checks=3")
    }
}
