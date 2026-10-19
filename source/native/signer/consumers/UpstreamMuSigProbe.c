/* Offline PUBLIC upstream fixtures only. Run the pinned crate's own MuSig
 * module tests without changing its algorithms, vectors, or test functions.
 * Minimal test context glue uses preallocation because the Rust sys crate
 * removes the malloc context convenience API from its bundled C source. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "src/secp256k1.c"
#include "src/testrand_impl.h"
#include "src/checkmem.h"
#include "src/testutil.h"

static int COUNT = 16;
static rustsecp256k1_v0_11_context *CTX;
static rustsecp256k1_v0_11_context *STATIC_CTX;
static void counting_callback_fn(const char *text, void *data) {
    (void)text; int32_t *count = data; CHECK(*count != INT32_MAX); ++*count;
}
/* Same assertion helper as pinned upstream src/tests.c (MIT/COPYING). */
static void test_sha256_eq(const rustsecp256k1_v0_11_sha256 *a, const rustsecp256k1_v0_11_sha256 *b) {
    CHECK((a->bytes & 0x3F) == 0);
    CHECK(a->bytes == b->bytes);
    CHECK(rustsecp256k1_v0_11_memcmp_var(a->s, b->s, sizeof(a->s)) == 0);
}
#define CHECK_ILLEGAL(ctx, expression) do { \
    int32_t calls = 0; \
    rustsecp256k1_v0_11_callback saved = (ctx)->illegal_callback; \
    rustsecp256k1_v0_11_context_set_illegal_callback(ctx, counting_callback_fn, &calls); \
    CHECK((expression) == 0); \
    (ctx)->illegal_callback = saved; \
    CHECK(calls == 1); \
} while (0)
#include "src/modules/musig/tests_impl.h"
#define LENGTH(array) (sizeof(array) / sizeof((array)[0]))

int main(void) {
    unsigned char seed[16] = {0x54, 0x42, 0x43, 0x34};
    testrand_seed(seed); /* Deterministic public test RNG, never a custody RNG. */
    void *allocation = malloc(rustsecp256k1_v0_11_context_preallocated_size(SECP256K1_CONTEXT_NONE));
    CHECK(allocation != NULL);
    CTX = rustsecp256k1_v0_11_context_preallocated_create(allocation, SECP256K1_CONTEXT_NONE);
    STATIC_CTX = malloc(sizeof(*rustsecp256k1_v0_11_context_static));
    CHECK(STATIC_CTX != NULL);
    memcpy(STATIC_CTX, rustsecp256k1_v0_11_context_static, sizeof(*STATIC_CTX));
    run_musig_tests();
    /* Pinned upstream's nonce aggregation positive loop compares only 33 bytes.
     * Independently check BOTH points (66 bytes) against each expected vector. */
    for (size_t i = 0; i < LENGTH(musig_nonce_agg_vector.valid_case); ++i) {
        const struct musig_nonce_agg_test_case *c = &musig_nonce_agg_vector.valid_case[i];
        rustsecp256k1_v0_11_musig_pubnonce nonces[2];
        const rustsecp256k1_v0_11_musig_pubnonce *pointers[2] = {&nonces[0], &nonces[1]};
        rustsecp256k1_v0_11_musig_aggnonce aggregate;
        unsigned char result[66];
        for (size_t j = 0; j < 2; ++j)
            CHECK(rustsecp256k1_v0_11_musig_pubnonce_parse(CTX, &nonces[j], musig_nonce_agg_vector.pnonces[c->pnonce_indices[j]]));
        CHECK(rustsecp256k1_v0_11_musig_nonce_agg(CTX, &aggregate, pointers, 2));
        CHECK(rustsecp256k1_v0_11_musig_aggnonce_serialize(CTX, result, &aggregate));
        CHECK(memcmp(result, c->expected, sizeof(result)) == 0);
    }
    rustsecp256k1_v0_11_context_preallocated_destroy(CTX);
    free(allocation); free(STATIC_CTX);
    printf("{\"status\":\"PASS\",\"vectorCases\":%zu,\"upstreamSkippedCases\":1,\"randomRounds\":16,\"fullNonceAggregateChecks\":2}\n",
        LENGTH(musig_key_agg_vector.valid_case) + LENGTH(musig_key_agg_vector.error_case) +
        LENGTH(musig_nonce_gen_vector.test_case) + LENGTH(musig_nonce_agg_vector.valid_case) + LENGTH(musig_nonce_agg_vector.error_case) +
        LENGTH(musig_sign_verify_vector.valid_case) + LENGTH(musig_sign_verify_vector.sign_error_case) +
        LENGTH(musig_sign_verify_vector.verify_fail_case) + LENGTH(musig_sign_verify_vector.verify_error_case) +
        LENGTH(musig_tweak_vector.valid_case) + LENGTH(musig_tweak_vector.error_case) +
        LENGTH(musig_sig_agg_vector.valid_case) + LENGTH(musig_sig_agg_vector.error_case));
    return 0;
}
