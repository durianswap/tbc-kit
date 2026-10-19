//! Shared exact Token/Coin read hints and pair decoding. No I/O, custody,
//! ancestry validation or approval authority; callers authenticate material.
use serde::{Deserialize,Serialize};
use serde_json::{Value,json};
use tbc_engine_core::protocols::{tbc20,coin};
use tbc_engine_core::protocols::fungible_change::{inspect_fungible_pair, FungibleProtocol};
use tbc_sdk::{TxOut, script::Script};

#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct TokenCode {
    pub standard_id:&'static str,
    pub tape_size:u8,
    pub controller:String,
    pub code_identity:String,
    verification:&'static str,
    asset_identity_verified:bool,
    #[serde(skip_serializing_if="Option::is_none")]
    original_outpoint:Option<Value>,
    #[serde(skip_serializing_if="Option::is_none")]
    coin_nft_code_hash:Option<String>,
    #[serde(skip_serializing_if="Option::is_none")]
    admin_pubkey_hash:Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct TokenPair {
    pub code:TokenCode,
    pub balance_raw:String,
    #[serde(skip_serializing_if="Option::is_none")]
    pub lock_time:Option<u32>,
    #[serde(skip_serializing_if="Option::is_none")]
    pub input_lock_checked:Option<bool>,
}
pub(crate) fn inspect_code(code:&[u8])->Option<TokenCode>{
    let (standard,tape_size,controller,identity,original,nft,admin)=if let Ok(d)=tbc20::parse_code(code){
        let mut txid=d.original_outpoint[..32].to_vec();txid.reverse();
        let vout=u32::from_le_bytes(d.original_outpoint[32..].try_into().ok()?);
        ("tbc20-standard",d.tape_size,d.controller,tbc20::code_identity(code).ok()?,
            Some(json!({"txid":hex::encode(txid),"vout":vout})),None,None)
    }else if let Ok(d)=coin::parse_code(code){
        ("tbc20-stablecoin",d.tape_size,d.controller,coin::code_identity(code).ok()?,None,
            Some(hex::encode(d.coin_nft_code_hash)),Some(hex::encode(d.admin_pubkey_hash)))
    }else{return None;};
    Some(TokenCode{standard_id:standard,tape_size,controller:hex::encode(controller),code_identity:hex::encode(identity),
        verification:"exact-template",asset_identity_verified:false,original_outpoint:original,
        coin_nft_code_hash:nft,admin_pubkey_hash:admin})
}
pub(crate) fn inspect_pair(code:&[u8],code_satoshis:u64,tape:&[u8],tape_satoshis:u64)->Result<TokenPair,String>{
    let descriptor=inspect_code(code).ok_or("Unrecognized current Token Code")?;
    complete_pair(descriptor,code_satoshis,tape,tape_satoshis)
}
pub(crate) fn complete_pair(descriptor:TokenCode,code_satoshis:u64,tape:&[u8],tape_satoshis:u64)->Result<TokenPair,String>{
    if code_satoshis!=500||tape_satoshis!=0||tape.len()!=descriptor.tape_size as usize{
        return Err("Token Code/Tape values or embedded Tape length are invalid".into());
    }
    let (balance,lock)=if descriptor.standard_id=="tbc20-standard"{
        (tbc20::parse_tape(tape).map_err(|e|e.to_string())?.balance,None)
    }else{
        let d=coin::parse_tape(tape,Some(descriptor.tape_size as usize)).map_err(|e|e.to_string())?;
        (d.balance,Some(d.lock_time))
    };
    Ok(TokenPair{code:descriptor,balance_raw:balance.to_string(),lock_time:lock,input_lock_checked:None})
}

#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Pair {code_script:String,code_satoshis:u64,tape_script:String,tape_satoshis:u64,#[serde(default)]input_lock:Option<InputLock>}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct InputLock {sequence:u32,transaction_lock_time:u32}
#[derive(Deserialize)]
#[serde(tag="phase",rename_all="camelCase",deny_unknown_fields)]
enum Request{InspectCodes{scripts:Vec<String>},InspectPairs{pairs:Vec<Pair>},IdentifyPairs{pairs:Vec<Pair>},
    CheckHistoricalIssuance{transactions:Vec<crate::issuance_policy::PolicyTransaction>,
        #[serde(rename="resolvedOutputs")]resolved_outputs:Vec<crate::issuance_policy::ResolvedOutput>},
    IdentifyNftOrigin{#[serde(rename="contractId")]contract_id:String,#[serde(rename="rawTransaction")]raw_transaction:String},
    IdentifyOrigin{#[serde(rename="contractId")]contract_id:String,#[serde(rename="rawTransaction")]raw_transaction:String}}

// This is local template recognition, not asset-origin authentication or a
// supported-operation declaration. Reuse the existing shared exact codecs;
// never infer a template from its marker/length, or fall back after pair failure.
fn identify_pair(p:Pair)->Result<Value,String>{
    if p.input_lock.is_some(){return Err("Identification cannot assert input lock authority".into());}
    let code=bytes(&p.code_script)?;
    let tape=bytes(&p.tape_script)?;
    let code=TxOut{satoshis:p.code_satoshis,script_pubkey:Script::from_bytes(code)};
    let tape=TxOut{satoshis:p.tape_satoshis,script_pubkey:Script::from_bytes(tape)};
    let Some(pair)=inspect_fungible_pair(&code,Some(&tape))? else{return Ok(Value::Null);};
    let (family,protocol,version)=match pair.identity.protocol{
        FungibleProtocol::HistoricalFt(v)=>("tbc20","legacy-ft",v),
        FungibleProtocol::HistoricalTbc20=>("tbc20","legacy-tbc20",1),
        FungibleProtocol::HistoricalStableCoin(v)=>("tbc20Stablecoin","legacy-stablecoin",v),
        FungibleProtocol::Tbc20Standard | FungibleProtocol::Coin=>{
            let (family,standard)=if pair.identity.protocol==FungibleProtocol::Tbc20Standard {
                ("tbc20","tbc20-standard")
            }else{("tbc20Stablecoin","tbc20-stablecoin")};
            return Ok(json!({"family":family,"generation":"current","protocol":standard,"protocolVersion":1,
                "standardId":standard,"codeIdentity":pair.identity.code_identity,"balanceRaw":pair.amount.to_string(),
                "verification":"exact-template","assetIdentityVerified":false}));
        },
    };
    Ok(json!({"family":family,"generation":"historical","protocol":protocol,"protocolVersion":version,
        "codeIdentity":pair.identity.code_identity,"balanceRaw":pair.amount.to_string(),
        "verification":"exact-template","assetIdentityVerified":false}))
}
fn bytes(s:&str)->Result<Vec<u8>,String>{
    if s.len()>2*65_536{return Err("Token script exceeds byte bound".into());}
    let b=hex::decode(s).map_err(|_|"Token script hex invalid")?;
    if hex::encode(&b)!=s{return Err("Token script must be canonical hex".into());}Ok(b)
}
fn count(n:usize)->Result<(),String>{
    if n==0||n>256{return Err("Token material batch bound exceeded".into());}Ok(())
}
pub fn inspect(request:&str)->Result<String,String>{
    if request.len()>8*1_048_576{return Err("Token material request exceeds byte bound".into());}
    let r:Request=serde_json::from_str(request).map_err(|_|"Invalid Token material request")?;
    let result=match r{
        Request::CheckHistoricalIssuance{transactions,resolved_outputs}=>crate::issuance_policy::check(transactions,resolved_outputs)?,
        Request::IdentifyNftOrigin{contract_id,raw_transaction}=>{
            use tbc_engine_core::protocols::nft_origin::{inspect_nft_origin,NftOriginProfile};
            if contract_id.len()!=64 || !contract_id.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b))
                || raw_transaction.len()>2*1_048_576 { return Err("NFT origin encoding or size invalid".into()); }
            let id=contract_id.parse().map_err(|_|"NFT origin ID invalid")?;
            let raw=hex::decode(&raw_transaction).map_err(|_|"NFT origin hex invalid")?;
            if hex::encode(&raw)!=raw_transaction {return Err("NFT origin hex must be canonical".into());}
            let generation=match inspect_nft_origin(&id,&raw)?{
                NftOriginProfile::Current=>"current",NftOriginProfile::Historical=>"historical",
            };
            json!({"family":"tbc721","generation":generation,"verification":"origin-template","assetIdentityVerified":false})
        },
        Request::IdentifyOrigin{contract_id,raw_transaction}=>{
            use tbc_engine_core::protocols::fungible_origin::{inspect_fungible_origin,FungibleOriginProfile as Profile};
            if contract_id.len()!=64 || !contract_id.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b))
                || raw_transaction.len()>2*1_048_576 { return Err("Fungible origin encoding or size invalid".into()); }
            let txid=contract_id.parse().map_err(|_|"Fungible origin ID invalid")?;
            let raw=hex::decode(&raw_transaction).map_err(|_|"Fungible origin hex invalid")?;
            if hex::encode(&raw)!=raw_transaction { return Err("Fungible origin hex must be canonical".into()); }
            let (family,generation)=match inspect_fungible_origin(&txid,&raw)?{
                Profile::Tbc20=>("tbc20","current"),Profile::Coin=>("tbc20Stablecoin","current"),
                Profile::HistoricalFt=>("tbc20","historical"),Profile::HistoricalStablecoin=>("tbc20Stablecoin","historical"),
            };
            json!({"family":family,"generation":generation,"verification":"origin-template","assetIdentityVerified":false})
        },
        Request::IdentifyPairs{pairs}=>{
            count(pairs.len())?;
            let identities=pairs.into_iter().map(identify_pair).collect::<Result<Vec<_>,_>>()?;
            json!({"identities":identities})
        },
        Request::InspectCodes{scripts}=>{
            count(scripts.len())?;let mut codes=Vec::with_capacity(scripts.len());
            for s in scripts{codes.push(inspect_code(&bytes(&s)?));}json!({"codes":codes})
        },
        Request::InspectPairs{pairs}=>{
            count(pairs.len())?;let mut result=Vec::with_capacity(pairs.len());
            for p in pairs{
                let tape=bytes(&p.tape_script)?;
                let mut pair=inspect_pair(&bytes(&p.code_script)?,p.code_satoshis,&tape,p.tape_satoshis)?;
                if let Some(lock)=p.input_lock{
                    if pair.code.standard_id!="tbc20-stablecoin"{return Err("Input lock inspection requires current Coin".into());}
                    // No administrator bypass is accepted by this public raw
                    // material operation. Chain maturity remains a separate fact.
                    coin::verify_input_lock(lock.sequence,lock.transaction_lock_time,&tape,Some(pair.code.tape_size as usize),false)
                        .map_err(|e|e.to_string())?;
                    pair.input_lock_checked=Some(true);
                }
                result.push(pair);
            }
            json!({"pairs":result})
        },
    };serde_json::to_string(&result).map_err(|_|"Token material encoding failed".into())
}
