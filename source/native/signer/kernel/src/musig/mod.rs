//! Wallet-private MuSig2 primitive, not a DApp signing endpoint.
//! Call only for an authenticated, approved task. `binding` commits to chain,
//! account/role, plan, task and approval identity; digest is bound separately.
//! No keys/nonces/entropy may originate from an untrusted page or coordinator.
//! Native/JS custody must supply fresh CSPRNG entropy and reject expired or
//! revoked approvals before entering this primitive. Sessions are memory-only.
mod ffi;
pub mod registry;
mod abi;
use secp256k1::{All,Keypair,PublicKey,Secp256k1,SecretKey,XOnlyPublicKey,schnorr,ffi::CPtr};
use std::sync::OnceLock;
use zeroize::{Zeroize,Zeroizing};
static CONTEXT:OnceLock<Secp256k1<All>>=OnceLock::new();
fn context()->&'static Secp256k1<All>{CONTEXT.get_or_init(Secp256k1::new)}
#[derive(Debug,Clone,Copy,PartialEq,Eq)]
pub enum Error { InvalidGroup, BindingMismatch, InvalidSecret, InvalidNonce, InvalidSignature, Consumed, CryptoFailure, Expired, Capacity }
fn ok(result:i32)->Result<(),Error>{if result==1{Ok(())}else{Err(Error::CryptoFailure)}}

/// Public group configuration. Sorted unique compressed keys, n-of-n, no tweaks.
#[derive(Clone)]
pub struct Group { keys:Vec<PublicKey>, cache:ffi::Cache, aggregate:[u8;32] }
impl Group {
    pub fn new(keys:&[[u8;33]],expected_aggregate:[u8;32])->Result<Self,Error>{
        let group=Self::from_public_keys(keys)?;
        if group.aggregate!=expected_aggregate{return Err(Error::BindingMismatch)}
        Ok(group)
    }
    /// Public configuration helper; does not authorize an on-chain administrator.
    /// Keep the caller's canonical ordering explicit, as required by signing.
    pub fn from_public_keys(keys:&[[u8;33]])->Result<Self,Error>{
        if !(2..=32).contains(&keys.len())||keys.windows(2).any(|w|w[0]>=w[1]){return Err(Error::InvalidGroup)}
        let keys=keys.iter().map(|k|PublicKey::from_slice(k).map_err(|_|Error::InvalidGroup)).collect::<Result<Vec<_>,_>>()?;
        let pointers:Vec<_>=keys.iter().map(|k|k.as_c_ptr()).collect();
        let mut cache=ffi::Cache([0;197]);let mut aggregate=[0;32];
        // FFI sizes match the pinned header; C initializes output before read.
        let mut output=unsafe{secp256k1::ffi::XOnlyPublicKey::new()};
        unsafe{ok(ffi::key_agg(context().ctx().as_ptr(),&mut output,&mut cache,pointers.as_ptr(),keys.len()))?;
            ok(secp256k1::ffi::secp256k1_xonly_pubkey_serialize(context().ctx().as_ptr(),aggregate.as_mut_ptr(),&output))?;}
        Ok(Self{keys,cache,aggregate})
    }
    pub fn aggregate_key(&self)->[u8;32]{self.aggregate}
}
impl Drop for ffi::SecretNonce { fn drop(&mut self){self.0.zeroize();} }
struct Pair(Keypair);
impl Drop for Pair {fn drop(&mut self){self.0.non_secure_erase();}}
fn pair(scalar:&[u8;32])->Result<Pair,Error>{
    let mut sk=SecretKey::from_byte_array(*scalar).map_err(|_|Error::InvalidSecret)?;
    let pair=Keypair::from_secret_key(context(),&sk);sk.non_secure_erase();Ok(Pair(pair))
}

/// No Clone, Debug, serialization or raw-secret getter. Moving moves only the
/// Box pointer; secret nonce bytes remain at one stable allocation until wiped.
pub struct SignerSession {
    group:Group,digest:[u8;32],binding:[u8;32],index:usize,
    nonce:Option<Box<ffi::SecretNonce>>,public_nonce:[u8;66],
}
impl SignerSession {
    /// Trusted custody supplies NEW entropy per invocation. The supplied buffer
    /// is wiped on success and failure. Never retry with the same entropy.
    pub fn begin(group:Group,digest:[u8;32],binding:[u8;32],scalar:&[u8;32],entropy:&mut[u8;32])->Result<Self,Error>{
        let mut random=Zeroizing::new(*entropy);entropy.zeroize();
        if *random==[0;32]{return Err(Error::InvalidNonce)}
        let pair=pair(scalar)?;let public=PublicKey::from_keypair(&pair.0);
        let index=group.keys.iter().position(|k|*k==public).ok_or(Error::InvalidSecret)?;
        let mut nonce=Box::new(ffi::SecretNonce([0;132]));let mut public_object=ffi::PublicNonce([0;132]);
        let mut public_nonce=[0;66];
        unsafe{ok(ffi::nonce_gen(context().ctx().as_ptr(),nonce.as_mut(),&mut public_object,random.as_mut_ptr(),scalar.as_ptr(),public.as_c_ptr(),digest.as_ptr(),&group.cache,binding.as_ptr()))?;
            ok(ffi::nonce_serialize(context().ctx().as_ptr(),public_nonce.as_mut_ptr(),&public_object))?;}
        Ok(Self{group,digest,binding,index,nonce:Some(nonce),public_nonce})
    }
    pub fn public_nonce(&self)->[u8;66]{self.public_nonce}
    pub fn cancel(&mut self){self.nonce.take();}
    pub fn is_consumed(&self)->bool{self.nonce.is_none()}
    /// Every attempt consumes nonce BEFORE checking external data or private key.
    /// Failure requires fresh approval validation and a new session, never retry.
    pub fn sign_once(&mut self,binding:[u8;32],digest:[u8;32],scalar:&[u8;32],nonces:&[[u8;66]])->Result<[u8;32],Error>{
        let mut nonce=self.nonce.take().ok_or(Error::Consumed)?;
        if binding!=self.binding||digest!=self.digest{return Err(Error::BindingMismatch)}
        if nonces.get(self.index)!=Some(&self.public_nonce){return Err(Error::InvalidNonce)}
        let round=Round::new(self.group.clone(),digest,nonces)?;
        let pair=pair(scalar)?;
        if PublicKey::from_keypair(&pair.0)!=self.group.keys[self.index]{return Err(Error::InvalidSecret)}
        let mut partial=ffi::Partial([0;36]);let mut output=[0;32];
        unsafe{ok(ffi::partial_sign(context().ctx().as_ptr(),&mut partial,nonce.as_mut(),pair.0.as_c_ptr(),&self.group.cache,&round.session))?;
            ok(ffi::partial_verify(context().ctx().as_ptr(),&partial,&round.nonces[self.index],self.group.keys[self.index].as_c_ptr(),&self.group.cache,&round.session))?;
            ok(ffi::partial_serialize(context().ctx().as_ptr(),output.as_mut_ptr(),&partial))?;}
        Ok(output)
    }
}

/// Public transcript only. Checks ALL shares and final BIP340 signature.
pub struct Round { group:Group,digest:[u8;32],nonces:Vec<ffi::PublicNonce>,session:ffi::Session }
impl Round {
    pub fn new(group:Group,digest:[u8;32],bytes:&[[u8;66]])->Result<Self,Error>{
        if bytes.len()!=group.keys.len()||bytes.iter().enumerate().any(|(i,n)|bytes[..i].contains(n)){return Err(Error::InvalidNonce)}
        let mut nonces=Vec::with_capacity(bytes.len());
        for bytes in bytes {let mut n=ffi::PublicNonce([0;132]);unsafe{if ffi::nonce_parse(context().ctx().as_ptr(),&mut n,bytes.as_ptr())!=1{return Err(Error::InvalidNonce)}}nonces.push(n);}
        let pointers:Vec<_>=nonces.iter().map(|n|n as *const _).collect();
        let mut aggregate=ffi::AggregateNonce([0;132]);let mut session=ffi::Session([0;133]);
        unsafe{ok(ffi::nonce_agg(context().ctx().as_ptr(),&mut aggregate,pointers.as_ptr(),pointers.len()))?;
            ok(ffi::nonce_process(context().ctx().as_ptr(),&mut session,&aggregate,digest.as_ptr(),&group.cache))?;}
        Ok(Self{group,digest,nonces,session})
    }
    pub fn combine(&self,shares:&[[u8;32]])->Result<[u8;64],Error>{
        if shares.len()!=self.group.keys.len(){return Err(Error::InvalidSignature)}
        let mut parsed=Vec::with_capacity(shares.len());
        for (i,bytes) in shares.iter().enumerate(){
            let mut part=ffi::Partial([0;36]);
            unsafe{if ffi::partial_parse(context().ctx().as_ptr(),&mut part,bytes.as_ptr())!=1
                ||ffi::partial_verify(context().ctx().as_ptr(),&part,&self.nonces[i],self.group.keys[i].as_c_ptr(),&self.group.cache,&self.session)!=1{return Err(Error::InvalidSignature)}}
            parsed.push(part);
        }
        let pointers:Vec<_>=parsed.iter().map(|p|p as *const _).collect();let mut signature=[0;64];
        unsafe{ok(ffi::partial_agg(context().ctx().as_ptr(),signature.as_mut_ptr(),&self.session,pointers.as_ptr(),pointers.len()))?;}
        let key=XOnlyPublicKey::from_byte_array(self.group.aggregate).map_err(|_|Error::InvalidGroup)?;
        context().verify_schnorr(&schnorr::Signature::from_byte_array(signature),&self.digest,&key).map_err(|_|Error::InvalidSignature)?;
        Ok(signature)
    }
}
