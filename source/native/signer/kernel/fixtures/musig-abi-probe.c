/* Public fixtures only, for Native/WASM ABI parity; never real custody. */
#include "tbc_signer_musig.h"
#include <stdio.h>
#include <string.h>
#define CHECK(x) do{if(!(x)){fprintf(stderr,"ABI probe failed line %d\n",__LINE__);return 1;}}while(0)
static void parse(unsigned char *out,const char *hex,size_t count){for(size_t i=0;i<count;i++){unsigned value=0;sscanf(hex+i*2,"%2x",&value);out[i]=(unsigned char)value;}}
int main(void){
    unsigned char keys[66],agg[32],digest[32],binding[32],scalar[32]={0},entropy[32],handles[2][32],nonces[2][66],shares[2][32],signature[64];
    parse(keys,"0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",33);
    parse(keys+33,"02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5",33);
    parse(agg,"3b46d262d2f610e9038b44beabdfe97ab5a0feb89870acc2264edfb7f63ec2ec",32);
    unsigned char derived[32];
    CHECK(tbc_signer_musig_aggregate_key(keys,2,derived)==0);CHECK(memcmp(agg,derived,32)==0);
    memset(derived,0x55,32);CHECK(tbc_signer_musig_aggregate_key(NULL,2,derived)==100);
    for(int i=0;i<32;i++)CHECK(derived[i]==0);
    memset(digest,0x37,32);memset(binding,0x20,32);CHECK(tbc_signer_musig_version()==1);
    for(int i=0;i<2;i++){
        scalar[31]=(unsigned char)(i+1);memset(entropy,0x61+i,32);
        CHECK(tbc_signer_musig_begin(keys,2,agg,digest,binding,scalar,entropy,100,200,handles[i],nonces[i])==0);
        for(int j=0;j<32;j++)CHECK(entropy[j]==0);
    }
    for(int i=0;i<2;i++){
        scalar[31]=(unsigned char)(i+1);
        CHECK(tbc_signer_musig_sign(handles[i],binding,digest,scalar,&nonces[0][0],2,150,shares[i])==0);
    }
    CHECK(tbc_signer_musig_combine(keys,2,agg,digest,&nonces[0][0],&shares[0][0],signature)==0);
    for(int i=0;i<64;i++)printf("%02x",signature[i]);printf("\n");
    memset(signature,0x55,64);
    CHECK(tbc_signer_musig_sign(handles[0],binding,digest,scalar,&nonces[0][0],2,150,signature)==106);
    for(int i=0;i<32;i++)CHECK(signature[i]==0);
    memset(scalar,0,32);tbc_signer_musig_cancel_all();return 0;
}
