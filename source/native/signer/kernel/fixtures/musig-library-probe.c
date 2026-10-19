/* Offline library-selection probe, not production custody. Scalars 1 and 2
 * and fixed entropy are public fixtures. Never use fixed entropy with real keys.
 * Prints public transcript only; no secret nonce export. */
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <secp256k1.h>
#include <secp256k1_preallocated.h>
#include <secp256k1_extrakeys.h>
#include <secp256k1_schnorrsig.h>
#include <secp256k1_musig.h>
#define S(name) rustsecp256k1_v0_11_##name
#define CHECK(x) do { if (!(x)) { fprintf(stderr,"probe failed at line %d\n",__LINE__); return 1; } } while (0)
static void erase(void *p, size_t n) { volatile unsigned char *b=p; while(n--) *b++=0; }
static void hex(const unsigned char *p,size_t n) { while(n--) printf("%02x",*p++); }
static void count_illegal(const char *message,void *data) { (void)message; (*(int*)data)++; }
int main(void) {
    void *memory=malloc(S(context_preallocated_size)(SECP256K1_CONTEXT_NONE)); CHECK(memory);
    S(context) *ctx=S(context_preallocated_create)(memory,SECP256K1_CONTEXT_NONE);
    S(keypair) keys[2]; S(pubkey) pubs[2]; const S(pubkey) *pubptr[2];
    S(musig_secnonce) secret[2]; S(musig_pubnonce) nonces[2]; const S(musig_pubnonce) *nonceptr[2];
    S(musig_partial_sig) shares[2]; const S(musig_partial_sig) *shareptr[2];
    S(musig_keyagg_cache) cache; S(xonly_pubkey) aggregate;
    S(musig_aggnonce) combined; S(musig_session) session;
    unsigned char message[32], sig[64], agg[32], pub[2][33], nonce[2][66], partial[2][32];
    memset(message,0x37,32);
    for(int i=0;i<2;i++) {
        unsigned char scalar[32]={0}; scalar[31]=(unsigned char)(i+1);
        CHECK(S(keypair_create)(ctx,&keys[i],scalar)); erase(scalar,32);
        CHECK(S(keypair_pub)(ctx,&pubs[i],&keys[i])); pubptr[i]=&pubs[i];
        size_t len=33; CHECK(S(ec_pubkey_serialize)(ctx,pub[i],&len,&pubs[i],SECP256K1_EC_COMPRESSED));
    }
    CHECK(memcmp(pub[0],pub[1],33)<0); /* Matches SDK keySort for fixtures 1,2. */
    CHECK(S(musig_pubkey_agg)(ctx,&aggregate,&cache,pubptr,2));
    CHECK(S(xonly_pubkey_serialize)(ctx,agg,&aggregate));
    for(int i=0;i<2;i++) {
        unsigned char seed[32],scalar[32]; memset(seed,0x41+i,32);
        CHECK(S(keypair_sec)(ctx,scalar,&keys[i]));
        CHECK(S(musig_nonce_gen)(ctx,&secret[i],&nonces[i],seed,scalar,&pubs[i],message,&cache,NULL));
        erase(seed,32); erase(scalar,32); nonceptr[i]=&nonces[i];
        CHECK(S(musig_pubnonce_serialize)(ctx,nonce[i],&nonces[i]));
    }
    CHECK(S(musig_nonce_agg)(ctx,&combined,nonceptr,2));
    CHECK(S(musig_nonce_process)(ctx,&session,&combined,message,&cache));
    for(int i=0;i<2;i++) {
        CHECK(S(musig_partial_sign)(ctx,&shares[i],&secret[i],&keys[i],&cache,&session));
        /* Test-only observation of the documented clearing guarantee. Never
         * interpret or serialize the opaque secret structure in production. */
        const unsigned char *p=(const unsigned char*)&secret[i];
        for(size_t j=0;j<sizeof(secret[i]);j++) CHECK(p[j]==0);
        CHECK(S(musig_partial_sig_verify)(ctx,&shares[i],&nonces[i],&pubs[i],&cache,&session));
        CHECK(S(musig_partial_sig_serialize)(ctx,partial[i],&shares[i])); shareptr[i]=&shares[i];
    }
    CHECK(S(musig_partial_sig_agg)(ctx,sig,&session,shareptr,2));
    CHECK(S(schnorrsig_verify)(ctx,sig,message,32,&aggregate));
    message[0]^=1; CHECK(!S(schnorrsig_verify)(ctx,sig,message,32,&aggregate)); message[0]^=1;
    /* Test-only callback catches the documented invalid-object rejection. A
     * production Rust guard must reject reuse before calling the C primitive. */
    int illegal=0; S(musig_partial_sig) rejected;
    S(context_set_illegal_callback)(ctx,count_illegal,&illegal);
    CHECK(!S(musig_partial_sign)(ctx,&rejected,&secret[0],&keys[0],&cache,&session));
    CHECK(illegal>0); S(context_set_illegal_callback)(ctx,NULL,NULL);
    printf("{\"message\":\"");hex(message,32);printf("\",\"aggregateKey\":\"");hex(agg,32);
    printf("\",\"signature\":\"");hex(sig,64);printf("\",\"parties\":[");
    for(int i=0;i<2;i++) {
        if(i)printf(",");printf("{\"publicKey\":\"");hex(pub[i],33);
        printf("\",\"publicNonce\":\"");hex(nonce[i],66);printf("\",\"partialSignature\":\"");hex(partial[i],32);printf("\"}");
    }
    printf("],\"nonceCleared\":true,\"nonceReuseRejected\":true,\"wrongMessageRejected\":true}\n");
    erase(keys,sizeof(keys)); erase(secret,sizeof(secret)); S(context_preallocated_destroy)(ctx); free(memory); return 0;
}
