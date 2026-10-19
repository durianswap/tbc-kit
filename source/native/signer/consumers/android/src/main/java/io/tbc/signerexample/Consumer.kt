package io.tbc.signerexample
import io.tbc.signer.TbcDigestSigner
import io.tbc.signer.TbcSignatureEncoding
fun publicFixtureSign(): ByteArray {
    val key = ByteArray(32).also { it[31] = 1 }
    return try { TbcDigestSigner.sign(ByteArray(32) { 1 }, key, TbcSignatureEncoding.COMPACT64) }
    finally { key.fill(0) }
}
