//! Private bindings matching pinned secp256k1-sys 0.11.0 MuSig header.
//! Opaque C objects never cross the wallet-private Rust API.
use secp256k1::ffi::{Context,PublicKey,Keypair,XOnlyPublicKey};
#[repr(C)] #[derive(Clone)] pub(super) struct Cache(pub [u8;197]);
#[repr(C)] pub(super) struct SecretNonce(pub [u8;132]);
#[repr(C)] pub(super) struct PublicNonce(pub [u8;132]);
#[repr(C)] pub(super) struct AggregateNonce(pub [u8;132]);
#[repr(C)] pub(super) struct Session(pub [u8;133]);
#[repr(C)] pub(super) struct Partial(pub [u8;36]);
unsafe extern "C" {
    #[link_name="rustsecp256k1_v0_11_musig_pubkey_agg"]
    pub(super) fn key_agg(ctx:*const Context,out:*mut XOnlyPublicKey,cache:*mut Cache,keys:*const *const PublicKey,len:usize)->i32;
    #[link_name="rustsecp256k1_v0_11_musig_nonce_gen"]
    pub(super) fn nonce_gen(ctx:*const Context,secret:*mut SecretNonce,public:*mut PublicNonce,entropy:*mut u8,scalar:*const u8,key:*const PublicKey,digest:*const u8,cache:*const Cache,extra:*const u8)->i32;
    #[link_name="rustsecp256k1_v0_11_musig_pubnonce_serialize"]
    pub(super) fn nonce_serialize(ctx:*const Context,out:*mut u8,nonce:*const PublicNonce)->i32;
    #[link_name="rustsecp256k1_v0_11_musig_pubnonce_parse"]
    pub(super) fn nonce_parse(ctx:*const Context,out:*mut PublicNonce,bytes:*const u8)->i32;
    #[link_name="rustsecp256k1_v0_11_musig_nonce_agg"]
    pub(super) fn nonce_agg(ctx:*const Context,out:*mut AggregateNonce,nonces:*const *const PublicNonce,len:usize)->i32;
    #[link_name="rustsecp256k1_v0_11_musig_nonce_process"]
    pub(super) fn nonce_process(ctx:*const Context,out:*mut Session,nonce:*const AggregateNonce,digest:*const u8,cache:*const Cache)->i32;
    #[link_name="rustsecp256k1_v0_11_musig_partial_sign"]
    pub(super) fn partial_sign(ctx:*const Context,out:*mut Partial,secret:*mut SecretNonce,key:*const Keypair,cache:*const Cache,session:*const Session)->i32;
    #[link_name="rustsecp256k1_v0_11_musig_partial_sig_verify"]
    pub(super) fn partial_verify(ctx:*const Context,sig:*const Partial,nonce:*const PublicNonce,key:*const PublicKey,cache:*const Cache,session:*const Session)->i32;
    #[link_name="rustsecp256k1_v0_11_musig_partial_sig_parse"]
    pub(super) fn partial_parse(ctx:*const Context,out:*mut Partial,bytes:*const u8)->i32;
    #[link_name="rustsecp256k1_v0_11_musig_partial_sig_serialize"]
    pub(super) fn partial_serialize(ctx:*const Context,out:*mut u8,sig:*const Partial)->i32;
    #[link_name="rustsecp256k1_v0_11_musig_partial_sig_agg"]
    pub(super) fn partial_agg(ctx:*const Context,out:*mut u8,session:*const Session,shares:*const *const Partial,len:usize)->i32;
}
