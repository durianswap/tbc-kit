package io.tbc.signer

enum class TbcSignatureEncoding(val tag: Int, val size: Int) {
    COMPACT64(64, 64), COMPACT65_RECOVERABLE(65, 65), SCHNORR64(164, 64)
}

/** Wallet-private primitive. Does not hash, approve, store a key, or submit transactions.
 * Caller owns the scalar ByteArray and must clear it in finally after this synchronous call.
 * Do not pass secret strings/JSON or expose this object to WebView JavaScript.
 */
object TbcDigestSigner {
    init { System.loadLibrary("tbc_signer_jni") }
    fun sign(digest: ByteArray, scalar: ByteArray, encoding: TbcSignatureEncoding): ByteArray {
        require(digest.size == 32 && scalar.size == 32) { "Invalid signer input" }
        return signNative(digest, scalar, encoding.tag)
    }
    private external fun signNative(digest: ByteArray, scalar: ByteArray, encoding: Int): ByteArray
    fun crypt(input: ByteArray, scalar: ByteArray, decrypt: Boolean): ByteArray {
        require(scalar.size == 32 && input.size <= 1_048_661)
        return cryptNative(input, scalar, decrypt)
    }
    private external fun cryptNative(input: ByteArray, scalar: ByteArray, decrypt: Boolean): ByteArray
}
