//! Bind the public/API asset ID to the issuance certificate source. The SDK's
//! mutable contractTxid after createCoin is a mint txid, not that index ID.
//! This is local structural consistency over trusted-node material, NOT a full
//! node proof of historical signatures, canonical-chain inclusion or spendability.
use serde::{Deserialize, Serialize};
use tbc_sdk::{hash, OutPoint, Transaction, TxOut, Txid, script::Script};
use crate::{EngineError, ErrorCode};
use super::{coin_proof::{self, ParentMaterial}, tbc721, nft_metadata,
    tbc20_material::MAX_MATERIAL_TRANSACTION_BYTES, tbc20::MAX_SLOT_AMOUNT};

fn invalid(message:&str)->EngineError {
    EngineError {code:ErrorCode::InvalidAncestry,message:message.into(),path:None}
}
fn parse(raw:&[u8])->Result<Transaction,EngineError> {
    if raw.is_empty() || raw.len()>MAX_MATERIAL_TRANSACTION_BYTES {return Err(invalid("Coin identity material exceeds byte budget"));}
    let tx=Transaction::from_bytes(raw).map_err(|_|invalid("Coin identity transaction malformed"))?;
    if tx.serialize()!=raw || tx.version!=10 {return Err(invalid("Coin identity raw must be canonical version 10"));}
    Ok(tx)
}
#[derive(Clone,Debug,Deserialize,Serialize,PartialEq,Eq)]
#[serde(rename_all="camelCase")]
pub(crate) struct Certificate {
    pub nft_name:String,
    pub nft_symbol:String,
    pub description:String,
    pub coin_decimal:u8,
    pub coin_total_supply:String,
}
pub(crate) fn certificate(tx:&Transaction)->Result<Certificate,EngineError> {
    if tx.outputs.len()<3 || tx.outputs[0].satoshis!=200 || tx.outputs[1].satoshis!=100 {
        return Err(invalid("Coin certificate Code/Hold amounts must be 200/100"));
    }
    validate_certificate(nft_metadata::decode_tape(&tx.outputs[2])?)
}
fn validate_certificate(data:Certificate)->Result<Certificate,EngineError> {
    if data.coin_decimal>18 || data.coin_total_supply.is_empty()
        || !data.coin_total_supply.bytes().all(|b|b.is_ascii_digit()) {
        return Err(invalid("Coin certificate precision or cumulative supply invalid"));
    }
    Ok(data)
}

fn certificate_admin(hold:&TxOut,data:&Certificate)->Result<[u8;20],EngineError> {
    let bytes=hold.script_pubkey.as_bytes();
    if bytes.len()<26 || bytes[..3]!=[0x76,0xa9,0x14] || bytes[23..26]!=[0x88,0xac,0x6a] {
        return Err(invalid("Coin certificate administrator Hold invalid"));
    }
    let admin_hash:[u8;20]=bytes[3..23].try_into().unwrap();
    let mut expected=Script::p2pkh(&admin_hash).into_bytes();expected.push(0x6a);
    let mut expected=Script::from_bytes(expected);
    expected.push_data(format!("For Coin {} NHold",data.nft_name).as_bytes());
    if expected!=hold.script_pubkey {return Err(invalid("Coin certificate Hold metadata differs"));}
    Ok(admin_hash)
}

/// Structural classification for the no-historical-issuance policy, not mint
/// permission or evidence of an authenticated issuer. Full current Code plus
/// certificate metadata and exact administrator Hold are required together.
pub(crate) fn is_current_certificate_group(
    code:&TxOut,hold:Option<&TxOut>,tape:Option<&TxOut>,
)->Result<bool,EngineError> {
    if tbc721::parse_code(code.script_pubkey.as_bytes()).is_err() {return Ok(false);}
    let hold=hold.ok_or_else(||invalid("Coin certificate Hold missing"))?;
    let tape=tape.ok_or_else(||invalid("Coin certificate Tape missing"))?;
    // A regular NFT shares this Code but has another typed metadata profile.
    // Failure here is not permission: the complete classifier must still match
    // that regular profile and its Hold, or reject the transaction.
    let data:Certificate=match nft_metadata::decode_tape(tape) {Ok(data)=>data,Err(_)=>return Ok(false)};
    let data=validate_certificate(data)?;
    if code.satoshis!=200 || hold.satoshis!=100 {
        return Err(invalid("Coin certificate Code/Hold amounts must be 200/100"));
    }
    certificate_admin(hold,&data)?;
    Ok(true)
}
// Metadata emitted by Coin.buildIssuanceScripts uses three ordinary data pushes,
// not numeric opcodes. Trailing OP_0 bytes are reserved Tape padding.
pub(crate) fn metadata_fields(mut bytes:&[u8])->Result<(u8,String,String),EngineError> {
    fn take<'a>(bytes:&mut &'a [u8])->Result<&'a [u8],EngineError> {
        let (&size,tail)=bytes.split_first().ok_or_else(||invalid("Coin metadata push missing"))?;
        if size>75 || tail.len()<size as usize {return Err(invalid("Coin initial metadata push invalid"));}
        let (value,rest)=tail.split_at(size as usize);*bytes=rest;Ok(value)
    }
    let decimal=take(&mut bytes)?;
    if decimal.len()!=1 || decimal[0]>18 {return Err(invalid("Coin initial decimal metadata invalid"));}
    let name=std::str::from_utf8(take(&mut bytes)?).map_err(|_|invalid("Coin name must be UTF-8"))?.to_owned();
    let symbol=std::str::from_utf8(take(&mut bytes)?).map_err(|_|invalid("Coin symbol must be UTF-8"))?.to_owned();
    if bytes.iter().any(|b|*b!=0) {return Err(invalid("Coin metadata has unexpected non-padding fields"));}
    Ok((decimal[0],name,symbol))
}

#[derive(Clone,Debug)]
pub struct GenesisIdentity {
    pub genesis:ParentMaterial,
    pub certificate_origin:OutPoint,
    pub decimals:u8,
    pub name:String,
    pub symbol:String,
    pub initial_supply:u64,
}

#[derive(Clone,Debug)]
pub struct IssuerIdentity {
    pub code_hash:[u8;32],
    pub admin_hash:[u8;20],
    pub decimals:u8,
    pub name:String,
    pub symbol:String,
}

/// Stable anchor independent of the latest mint state. A holder spend needs
/// this source plus its own immediate proof ancestors, not a history walk.
pub fn inspect_issuer(asset_id:&Txid,raw:&[u8])->Result<IssuerIdentity,EngineError> {
    let tx=parse(raw)?;
    if tx.txid()!=*asset_id || tx.inputs.len()!=1 || tx.outputs.len()!=4 || tx.lock_time!=0 {
        return Err(invalid("Coin asset ID must identify its issuance certificate source"));
    }
    let code=tbc721::parse_code(tx.outputs[0].script_pubkey.as_bytes())
        .map_err(|_|invalid("Coin issuance source must use the pinned TBC721 template"))?;
    if code.original_outpoint!=tx.inputs[0].previous_output {return Err(invalid("Coin certificate source outpoint differs"));}
    let cert=certificate(&tx)?;
    if cert.coin_total_supply!="0" {return Err(invalid("Coin issuance source must start with zero supply"));}
    let name=cert.nft_name.strip_suffix(" NFT").ok_or_else(||invalid("Coin certificate name suffix invalid"))?.to_owned();
    let symbol=cert.nft_symbol.strip_suffix(" NFT").ok_or_else(||invalid("Coin certificate symbol suffix invalid"))?.to_owned();
    let admin_hash=certificate_admin(&tx.outputs[1],&cert)?;
    Ok(IssuerIdentity {
        code_hash:hash::sha256(tx.outputs[0].script_pubkey.as_bytes()),admin_hash,
        decimals:cert.coin_decimal,name,symbol})
}

/// Holder identity supplied by the configured trusted API, not a claim that
/// certificate history has been independently replayed. No network or keys.
pub(crate) fn inspect_indexed_issuer(code:&[u8],tape:&[u8])->Result<IssuerIdentity,EngineError> {
    let descriptor=super::coin::parse_code(code).map_err(|_|invalid("indexed Coin Code template invalid"))?;
    let tape=super::coin::parse_tape(tape,Some(descriptor.tape_size as usize)).map_err(|_|invalid("indexed Coin Tape invalid"))?;
    let (decimals,name,symbol)=metadata_fields(&tape.metadata)?;
    Ok(IssuerIdentity{code_hash:descriptor.coin_nft_code_hash,admin_hash:descriptor.admin_pubkey_hash,decimals,name,symbol})
}

pub fn validate_holder_identity(issuer:&IssuerIdentity,parent:&ParentMaterial)->Result<(),EngineError> {
    let (decimals,name,symbol)=metadata_fields(&parent.tape().metadata)?;
    if parent.code().coin_nft_code_hash!=issuer.code_hash || parent.code().admin_pubkey_hash!=issuer.admin_hash
        || decimals!=issuer.decimals || name!=issuer.name || symbol!=issuer.symbol {
        return Err(invalid("Coin holder Code/admin/metadata differs from the bound issuer"));
    }
    Ok(())
}

/// Only the pinned latest initial-issuance layout. Reissuance txids, sibling
/// outputs, metadata labels and self-declared API IDs cannot replace this anchor.
pub fn inspect_genesis(contract_id:&Txid,genesis_raw:&[u8],issuer_raw:&[u8])->Result<GenesisIdentity,EngineError> {
    let selected=OutPoint {txid:*contract_id,vout:3};
    let genesis=coin_proof::inspect_parent(genesis_raw,&selected,None)?;
    let mint=genesis.transaction();let issuer=parse(issuer_raw)?;
    if issuer.inputs.len()!=1 || issuer.outputs.len()!=4 || mint.inputs.len()!=3
        || !(6..=7).contains(&mint.outputs.len()) || issuer.lock_time!=0 || mint.lock_time!=0 {
        return Err(invalid("Coin initial issuance source/mint shape invalid"));
    }
    for (input,vout) in mint.inputs.iter().zip([0,1,3]) {
        if input.previous_output!= (OutPoint {txid:issuer.txid(),vout}) {
            return Err(invalid("Coin initial mint must consume certificate Code, Hold and source change"));
        }
    }
    let code=tbc721::parse_code(issuer.outputs[0].script_pubkey.as_bytes())
        .map_err(|_|invalid("Coin initial certificate must use the pinned latest TBC721 template"))?;
    if code.original_outpoint!=issuer.inputs[0].previous_output
        || mint.outputs[0]!=issuer.outputs[0] || mint.outputs[1]!=issuer.outputs[1]
        || hash::sha256(issuer.outputs[0].script_pubkey.as_bytes())!=genesis.code().coin_nft_code_hash {
        return Err(invalid("Coin issuer origin, Code hash or Hold changed across first mint"));
    }
    let mut before=certificate(&issuer)?;let after=certificate(mint)?;
    if before.coin_total_supply!="0" {return Err(invalid("Coin initial certificate must start with zero supply"));}
    let amount=after.coin_total_supply.parse::<u64>().map_err(|_|invalid("Coin initial supply is outside one slot"))?;
    before.coin_total_supply=after.coin_total_supply.clone();
    if before!=after || amount==0 || amount>MAX_SLOT_AMOUNT || genesis.tape().amounts!=[amount,0,0,0,0,0]
        || genesis.tape().lock_time!=0 {
        return Err(invalid("Coin certificate metadata or first-mint supply/slots differ"));
    }
    let (decimals,name,symbol)=metadata_fields(&genesis.tape().metadata)?;
    if decimals!=after.coin_decimal || after.nft_name!=format!("{name} NFT") || after.nft_symbol!=format!("{symbol} NFT") {
        return Err(invalid("Coin Tape metadata does not match its issuance certificate"));
    }
    let mut hold=Script::p2pkh(&genesis.code().admin_pubkey_hash).into_bytes();hold.push(0x6a);
    let mut hold=Script::from_bytes(hold);hold.push_data(format!("For Coin {} NHold",after.nft_name).as_bytes());
    if issuer.outputs[1].script_pubkey!=hold {return Err(invalid("Coin certificate Hold does not bind its administrator"));}
    let funding=&issuer.outputs[3];let change=mint.outputs.last().unwrap();
    let script=funding.script_pubkey.as_bytes();
    if script.len()!=25 || script[..3]!=[0x76,0xa9,0x14] || script[23..]!=[0x88,0xac]
        || change.script_pubkey!=funding.script_pubkey || change.satoshis<24 {
        return Err(invalid("Coin issuance fee change is not canonical P2PKH"));
    }
    if mint.outputs.len()==7 && (mint.outputs[5].satoshis!=0 || !mint.outputs[5].script_pubkey.as_bytes().starts_with(&[0,0x6a])) {
        return Err(invalid("Coin optional issuance message is not zero-value data"));
    }
    let spent=mint.outputs.iter().try_fold(0u64,|n,o|n.checked_add(o.satoshis)).ok_or_else(||invalid("Coin issuance native sum overflow"))?;
    let available=funding.satoshis.checked_add(300).ok_or_else(||invalid("Coin issuance native sum overflow"))?;
    if available>9_007_199_254_740_991 || spent>=available {return Err(invalid("Coin first mint overspends or has no fee"));}
    Ok(GenesisIdentity {genesis,certificate_origin:code.original_outpoint,decimals,name,symbol,initial_supply:amount})
}
