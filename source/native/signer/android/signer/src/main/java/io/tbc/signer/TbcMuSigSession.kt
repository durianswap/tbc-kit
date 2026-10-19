package io.tbc.signer

import java.security.SecureRandom

/** Trusted Host task identity, not page-provided approval. Defensive public-data copies. */
class TbcMuSigAuthorization(binding: ByteArray, digest: ByteArray, val expiresAt: Long) {
    private val bound = binding.copyOf()
    private val message = digest.copyOf()
    val binding: ByteArray get() = bound.copyOf()
    val digest: ByteArray get() = message.copyOf()
    init { require(bound.size == 32 && message.size == 32 && expiresAt >= 0) }
    internal fun matches(other: TbcMuSigAuthorization) = expiresAt == other.expiresAt &&
        bound.contentEquals(other.bound) && message.contentEquals(other.message)
}

// Only loaded by the optional MuSig path. Build JNI and Rust with matching feature.
private object MuSigNative {
    init { System.loadLibrary("tbc_signer_jni") }
    external fun version(): Int
    external fun aggregateKey(keys: ByteArray): ByteArray
    external fun begin(keys: ByteArray, aggregate: ByteArray, digest: ByteArray, binding: ByteArray,
        scalar: ByteArray, entropy: ByteArray, now: Long, expires: Long): ByteArray
    external fun sign(handle: ByteArray, binding: ByteArray, digest: ByteArray, scalar: ByteArray,
        nonces: ByteArray, now: Long): ByteArray
    external fun cancel(handle: ByteArray)
    external fun combine(keys: ByteArray, aggregate: ByteArray, digest: ByteArray,
        nonces: ByteArray, shares: ByteArray): ByteArray
}

/** Wallet-private n-of-n session. No WebView exposure, nonce serialization or recovery.
 * Host must close on navigation/revoke/account change; use try/finally or use{}.
 * JVM GC is not a resource-release mechanism. The native registry is bounded/TTL checked.
 * sign/close serialize on this object; authorize synchronously checks the exact approved
 * task at begin AND sign. Callers own and clear scalar arrays, including after exceptions.
 */
class TbcMuSigSession private constructor(
    private val handle: ByteArray,
    private val nonce: ByteArray,
    private val count: Int,
    private val authorization: TbcMuSigAuthorization,
    private val authorize: (TbcMuSigAuthorization) -> Boolean
) : AutoCloseable {
    private var active = true
    val publicNonce: ByteArray get() = nonce.copyOf()

    @Synchronized fun sign(current: TbcMuSigAuthorization, scalar: ByteArray,
                           publicNonces: List<ByteArray>): ByteArray {
        check(active) { "MuSig rejected: 106" }
        active = false
        try {
            check(current.matches(authorization) && authorize(current)) { "MuSig rejected: 102" }
            require(scalar.size == 32 && publicNonces.size == count)
            val nonces = flatten(publicNonces, 66)
            return MuSigNative.sign(handle, current.binding, current.digest, scalar, nonces, monotonicMilliseconds())
        } finally { MuSigNative.cancel(handle) }
    }

    @Synchronized override fun close() {
        active = false
        MuSigNative.cancel(handle)
    }

    companion object {
        /** Public-only sorted unique group keys; no implicit approval or custody. */
        @JvmStatic fun aggregateKey(publicKeys: List<ByteArray>): ByteArray =
            MuSigNative.aggregateKey(flatten(publicKeys, 33))
        private val clockOrigin = System.nanoTime()
        private val random = SecureRandom()
        @JvmStatic fun monotonicMilliseconds(): Long = (System.nanoTime() - clockOrigin) / 1_000_000L
        private fun flatten(items: List<ByteArray>, size: Int): ByteArray {
            require(items.size in 2..32 && items.all { it.size == size })
            val output = ByteArray(items.size * size)
            items.forEachIndexed { index, bytes -> bytes.copyInto(output, index * size) }
            return output
        }

        @JvmStatic fun begin(publicKeys: List<ByteArray>, aggregateKey: ByteArray,
            authorization: TbcMuSigAuthorization, scalar: ByteArray,
            authorize: (TbcMuSigAuthorization) -> Boolean): TbcMuSigSession {
            check(MuSigNative.version() == 1) { "Incompatible MuSig ABI" }
            val keys = flatten(publicKeys, 33)
            val aggregate = aggregateKey.copyOf()
            require(aggregate.size == 32 && scalar.size == 32)
            check(authorize(authorization)) { "MuSig rejected: 102" }
            val entropy = ByteArray(32)
            val result = try {
                random.nextBytes(entropy)
                MuSigNative.begin(keys, aggregate, authorization.digest, authorization.binding, scalar,
                    entropy, monotonicMilliseconds(), authorization.expiresAt)
            } finally { entropy.fill(0) }
            // Result contains only a private handle and public nonce; clean temporary storage.
            try {
                check(result.size == 98) { "Invalid MuSig result" }
                return TbcMuSigSession(result.copyOfRange(0, 32), result.copyOfRange(32, 98),
                    keys.size / 33, authorization, authorize)
            } catch (error: Throwable) {
                if (result.size >= 32) MuSigNative.cancel(result.copyOfRange(0, 32))
                throw error
            } finally { result.fill(0) }
        }

        @JvmStatic fun combine(publicKeys: List<ByteArray>, aggregateKey: ByteArray, digest: ByteArray,
            publicNonces: List<ByteArray>, partialSignatures: List<ByteArray>): ByteArray {
            check(MuSigNative.version() == 1) { "Incompatible MuSig ABI" }
            require(aggregateKey.size == 32 && digest.size == 32 && publicKeys.size == publicNonces.size &&
                publicKeys.size == partialSignatures.size)
            return MuSigNative.combine(flatten(publicKeys, 33), aggregateKey, digest,
                flatten(publicNonces, 66), flatten(partialSignatures, 32))
        }
    }
}
