// PUBLIC fixture keys only; not a wallet-custody example.
import io.tbc.signer.TbcMuSigAuthorization
import io.tbc.signer.TbcMuSigSession
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicInteger

private fun bytes(hex: String) = hex.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }
private fun <T> key(n: Int, work: (ByteArray) -> T): T {
    val scalar = ByteArray(32); scalar[31] = n.toByte()
    return try { work(scalar) } finally { scalar.fill(0) }
}
fun main() { println(runMuSigProbe()) }
fun runMuSigProbe(): String {
    val keys = listOf(bytes("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"),
        bytes("02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"))
    val aggregate = bytes("3b46d262d2f610e9038b44beabdfe97ab5a0feb89870acc2264edfb7f63ec2ec")
    // Optional reflection keeps this probe runnable against frozen local4.
    // The current-source runner requires this new check, unlike old consumers.
    val groupMethod = TbcMuSigSession::class.java.methods.singleOrNull { it.name == "aggregateKey" }
    val publicGroupDerivation = groupMethod != null
    if (groupMethod != null) check((groupMethod.invoke(null, keys) as ByteArray).contentEquals(aggregate))
    val digest = ByteArray(32) { 0x37 }
    var allowed = true; var approvals = 0; var checks = 0
    fun reject(code: Int? = null, work: () -> Unit) {
        try { work(); error("REJECTION_MISSING") }
        catch (e: RuntimeException) {
            check(e.message != "REJECTION_MISSING")
            if (code != null) check(e.message == "MuSig rejected: $code")
            checks++
        }
    }
    fun auth(ttl: Long = 60_000, b: Byte = 0x20) = TbcMuSigAuthorization(ByteArray(32) { b }, digest,
        TbcMuSigSession.monotonicMilliseconds() + ttl)
    fun begin(n: Int, a: TbcMuSigAuthorization) = key(n) {
        TbcMuSigSession.begin(keys, aggregate, a, it) { approvals++; allowed }
    }
    fun sign(s: TbcMuSigSession, n: Int, a: TbcMuSigAuthorization, ns: List<ByteArray>) = key(n) { s.sign(a, it, ns) }
    val authorization = auth()
    val a = begin(1, authorization); val b = begin(2, authorization)
    val nonces = listOf(a.publicNonce, b.publicNonce)
    val shares = listOf(sign(a, 1, authorization, nonces), sign(b, 2, authorization, nonces))
    val signature = TbcMuSigSession.combine(keys, aggregate, digest, nonces, shares)
    check(approvals == 4 && signature.size == 64); checks++
    reject(106) { sign(a, 1, authorization, nonces) }
    reject(105) { TbcMuSigSession.combine(keys, aggregate, digest, nonces, shares.reversed()) }
    begin(1, authorization).use { s -> s.close(); s.close(); reject(106) { sign(s, 1, authorization, nonces) } }
    begin(1, authorization).use { s ->
        allowed = false; reject(102) { sign(s, 1, authorization, nonces) }
        reject(102) { begin(1, authorization) }; allowed = true
        reject(106) { sign(s, 1, authorization, nonces) }
    }
    begin(1, authorization).use { s ->
        reject(102) { sign(s, 1, auth(b = 0x21), nonces) }
        reject(106) { sign(s, 1, authorization, nonces) }
    }
    begin(1, authorization).use { s ->
        reject { sign(s, 1, authorization, listOf(byteArrayOf())) }
        reject(106) { sign(s, 1, authorization, nonces) }
    }
    begin(1, authorization).use { s ->
        reject { sign(s, 2, authorization, listOf(s.publicNonce, b.publicNonce)) }
        reject(106) { sign(s, 1, authorization, nonces) }
    }
    val short = auth(ttl = 20)
    begin(1, short).use { s ->
        Thread.sleep(30)
        reject(108) { sign(s, 1, short, listOf(s.publicNonce, b.publicNonce)) }
        reject(106) { sign(s, 1, short, nonces) }
    }
    reject(108) { begin(1, auth(ttl = 400_000)) }
    repeat(40) { begin(1, authorization).use { check(it.publicNonce.size == 66) } }; checks++
    var reentrant: TbcMuSigSession? = null
    reentrant = key(1) { TbcMuSigSession.begin(keys, aggregate, authorization, it) { reentrant?.close(); true } }
    reentrant.use { s -> reject(106) { sign(s, 1, authorization, listOf(s.publicNonce, b.publicNonce)) } }
    // External mutation cannot change the task snapshot or stored public nonce.
    val bind = ByteArray(32) { 0x20 }; val d = digest.copyOf()
    val immutable = TbcMuSigAuthorization(bind, d, authorization.expiresAt)
    bind.fill(0); d.fill(0); immutable.binding.fill(0); immutable.digest.fill(0)
    check(immutable.binding.contentEquals(authorization.binding) && immutable.digest.contentEquals(digest))
    begin(1, immutable).use { s -> val nonce = s.publicNonce; nonce.fill(0); check(s.publicNonce.any { it != 0.toByte() }) }
    checks++
    // An authorization callback throwing also burns the native session.
    var throwNow = false
    key(1) { TbcMuSigSession.begin(keys, aggregate, authorization, it) {
        if (throwNow) throw IllegalStateException("revoked"); true
    } }.use { s ->
        throwNow = true; reject { sign(s, 1, authorization, listOf(s.publicNonce, b.publicNonce)) }
        reject(106) { sign(s, 1, authorization, nonces) }
    }
    // Two simultaneous signing attempts yield exactly one partial signature.
    begin(1, authorization).use { s ->
        val gate = CountDownLatch(1); val successes = AtomicInteger(); val consumed = AtomicInteger()
        val ns = listOf(s.publicNonce, b.publicNonce)
        val threads = (1..2).map { Thread {
            gate.await()
            try { sign(s, 1, authorization, ns); successes.incrementAndGet() }
            catch (e: IllegalStateException) { if (e.message == "MuSig rejected: 106") consumed.incrementAndGet() }
        }.apply { start() } }
        gate.countDown(); threads.forEach { it.join() }
        check(successes.get() == 1 && consumed.get() == 1); checks++
    }
    a.close(); b.close()
    fun list(values: List<ByteArray>) = values.joinToString(",", "[", "]") { "\"${hex(it)}\"" }
    return """{"status":"PASS","checks":$checks,"publicFixturesOnly":true,"publicGroupDerivation":$publicGroupDerivation,"publicKeys":${list(keys)},"aggregateKey":"${hex(aggregate)}","digest":"${hex(digest)}","publicNonces":${list(nonces)},"partialSignatures":${list(shares)},"signature":"${hex(signature)}"} """.trim()
}
