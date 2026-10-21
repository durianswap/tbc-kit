//! Per-transaction output disclosure from the SAME parsed transaction used by
//! the planner. No keys, HTTP, witnesses, ancestry walk or second plan. Exact
//! existing codecs identify assets; unfamiliar outputs remain visibly unknown.
//! Output balances are not user debits: self/change, intermediate funding and
//! pool reserves must not be summed as a payment. Fee is a separate plan field.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tbc_sdk::{Address, Transaction, TxOut};
use crate::protocols::{tbc20, coin, tbc721, amm_lp, amm_profile, coin_identity,
    historical_nft, historical_pool, historical_coin, htlc, timelock, lop};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OutputReview {
    pub output_indices: Vec<u32>,
    pub kind: String,
    /// `code-identity:` is a template identity, never an API/genesis contract ID.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_identity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount_atomic: Option<String>,
    /// Address OR explicitly prefixed contract/script reference. Never pretend
    /// a contract controller is a simple P2PKH destination.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recipient: Option<String>,
    pub native_value_atomic: String,
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lock_time: Option<u32>,
}

fn hex(bytes: &[u8]) -> String { bytes.iter().map(|b| format!("{b:02x}")).collect() }
fn script_ref(bytes: &[u8]) -> String { format!("script-sha256:{}", hex(&Sha256::digest(bytes))) }
fn address(hash: &[u8]) -> String { Address::from_hash160(hash.try_into().expect("20-byte parsed owner")).to_string() }
fn controller(value: &[u8; 21]) -> String {
    if value[20] == 0 { address(&value[..20]) }
    else { format!("contract-controller:{}", hex(value)) }
}
fn asset(kind: &str, identity: String, amount: u128, owner: &[u8; 21], lock: Option<u32>) -> OutputReview {
    OutputReview { output_indices: vec![], kind: kind.into(), asset_identity: Some(identity),
        amount_atomic: Some(amount.to_string()), recipient: Some(controller(owner)), native_value_atomic: String::new(),
        warnings: if lock.is_some_and(|v|v>0) { vec!["ASSET_LOCKED_UNTIL_CONDITIONS_MET".into()] } else { vec![] }, lock_time: lock }
}
fn token_pair(code: &TxOut, tape: Option<&TxOut>) -> Option<OutputReview> {
    let bytes=code.script_pubkey.as_bytes();
    // Length checks in the exact codecs avoid template work for P2PKH/data.
    if bytes.len()<100 { return None; }
    let tape=tape?;
    if code.satoshis!=500 || tape.satoshis!=0 {return None;}
    let tb=tape.script_pubkey.as_bytes();
    if let Ok(c)=tbc20::parse_code(bytes) {
        if tb.len()!=usize::from(c.tape_size) {return None;}
        let t=tbc20::parse_tape(tb).ok()?;
        return Some(asset("tbc20-standard",format!("code-identity:{}",hex(&tbc20::code_identity(bytes).ok()?)),t.balance,&c.controller,None));
    }
    if let Ok(c)=coin::parse_code(bytes) {
        let t=coin::parse_tape(tb,Some(usize::from(c.tape_size))).ok()?;
        return Some(asset("tbc20-stablecoin",format!("code-identity:{}",hex(&coin::code_identity(bytes).ok()?)),t.balance,&c.controller,Some(t.lock_time)));
    }
    if let Ok(c)=amm_lp::parse_code(bytes) {
        let t=amm_lp::Tape::decode(tb,c.timelocked,Some(c.tape_size)).ok()?;
        return Some(asset("tbc20-lp",format!("code-identity:{}",hex(&amm_lp::code_identity(bytes).ok()?)),t.balance().ok()?,&c.controller,Some(t.lock_time)));
    }
    if let Ok(Some(p))=historical_pool::inspect_historical_ftlp_auto(code,Some(tape)) {
        return Some(asset("historical-lp",format!("code-identity:{}",hex(&p.identity.owner_independent_code_hash)),p.amount,&p.controller,p.lock_time));
    }
    if let Ok(Some(p))=tbc_sdk::validator::inspect_published_token_pair(code,Some(tape)) {
        // Successful exact SDK recognition precedes reading its released owner
        // tail. Marker/length by themselves are never trusted classification.
        let start=bytes.len().checked_sub(27)?;
        if bytes.get(start.wrapping_sub(1))!=Some(&21) {return None;}
        let owner: [u8;21]=bytes.get(start..start+21)?.try_into().ok()?;
        let lock=if p.protocol.family=="STABLE_COIN" {
            Some(tbc_sdk::contracts::stable_coin::scripts::get_lock_time_from_tape(&tape.script_pubkey).ok()?)
        } else {None};
        return Some(asset(&format!("historical-{}-v{}",p.protocol.family.to_lowercase(),p.protocol.version),
            format!("code-identity:{}",p.identity),p.balance,&owner,lock));
    }
    None
}
fn nft_group(code:&TxOut, hold:Option<&TxOut>, tape:Option<&TxOut>) -> Option<OutputReview> {
    if let Ok(c)=tbc721::parse_code(code.script_pubkey.as_bytes()) {
        let regular=historical_nft::is_current_regular_nft_group(code,hold,tape).unwrap_or(false);
        if !regular && !coin_identity::is_current_certificate_group(code,hold,tape).ok()? {return None;}
        let mut owner=[0;21];owner[..20].copy_from_slice(&hold?.script_pubkey.as_bytes()[3..23]);
        return Some(asset(if regular {"tbc721-standard"}else{"stablecoin-management-certificate"},format!("nft:{}:{}",c.original_outpoint.txid,c.original_outpoint.vout),1,&owner,None));
    }
    if let Ok(Some(c))=historical_coin::inspect_historical_coin_certificate(code,hold,tape) {
        let mut owner=[0;21];owner[..20].copy_from_slice(&c.admin_hash);
        return Some(asset("historical-stablecoin-management-certificate",format!("nft:{}:{}",c.source.txid,c.source.vout),1,&owner,None));
    }
    let p=historical_nft::inspect_historical_nft(code,hold,tape).ok()??;
    Some(asset(&format!("historical-nft-v{}",p.identity.version),format!("nft:{}:{}",p.identity.collection_id,p.identity.token_id),1,&p.controller,None))
}
fn native(kind:&str, out:&TxOut, recipient:String) -> OutputReview {
    OutputReview { output_indices:vec![], kind:kind.into(),asset_identity:None,amount_atomic:Some(out.satoshis.to_string()),
        recipient:Some(recipient),native_value_atomic:String::new(),warnings:vec![],lock_time:None }
}
fn classify(outputs:&[TxOut], i:usize) -> (OutputReview,usize) {
    let out=&outputs[i];let bytes=out.script_pubkey.as_bytes();
    if bytes.len()==25 && bytes.starts_with(&[0x76,0xa9,0x14]) && bytes.ends_with(&[0x88,0xac]) {
        return (native("native",out,address(&bytes[3..23])),1);
    }
    if let Some(r)=token_pair(out,outputs.get(i+1)) {return (r,2);}
    if let Some(r)=nft_group(out,outputs.get(i+1),outputs.get(i+2)) {return (r,3);}
    if let Ok(Some(owner))=historical_nft::inspect_historical_mint_slot(out) {
        return (asset("nft-mint-slot",format!("output:{i}"),1,&owner,None),1);
    }
    if let Ok(c)=timelock::Code::decode(bytes) {
        let mut r=native("native",out,address(&c.owner_hash));r.lock_time=Some(c.raw_lock_time);
        r.warnings.push("ASSET_LOCKED_UNTIL_CONDITIONS_MET".into());return (r,1);
    }
    if let Ok(c)=htlc::Code::decode(bytes) {
        let mut r=native("native",out,format!("htlc:claim={};refund={}",address(&c.receiver_hash),address(&c.sender_hash)));
        r.lock_time=Some(c.raw_lock_time);r.warnings.push("ASSET_LOCKED_UNTIL_CONDITIONS_MET".into());return (r,1);
    }
    if let Ok(c)=amm_profile::Code::decode(bytes) {
        if let Some(tape)=outputs.get(i+1).filter(|t|t.satoshis==0) {
            if let Ok(t)=amm_profile::Tape::decode(tape.script_pubkey.as_bytes()) {
                if amm_profile::Profile::from_parts(&c,&t).is_ok() {return (native("native-pool-reserve",out,script_ref(bytes)),2);}
            }
        }
    }
    if let Ok(Some(_))=historical_pool::inspect_historical_pool_auto(out,outputs.get(i+1)) {
        return (native("native-pool-reserve",out,script_ref(bytes)),2);
    }
    if lop::Code::decode(bytes).is_ok() {return (native("native-order-output",out,script_ref(bytes)),1);}
    if bytes.starts_with(&[0,0x6a]) || bytes.starts_with(&[0x6a]) {
        let mut r=native("data",out,script_ref(bytes));
        if out.satoshis>0 {r.warnings.push("NATIVE_VALUE_IN_UNSPENDABLE_OUTPUT".into());}
        return (r,1);
    }
    // Do not hide an unknown output or label its TBC value as a token balance.
    (OutputReview {output_indices:vec![],kind:"unrecognized".into(),asset_identity:None,amount_atomic:None,
        recipient:Some(script_ref(bytes)),native_value_atomic:String::new(),warnings:vec!["OUTPUT_ASSET_DETAILS_UNAVAILABLE".into()],lock_time:None},1)
}

pub(crate) fn outputs(tx:&Transaction) -> Vec<OutputReview> {
    let mut result=Vec::new();let mut i=0;
    while i<tx.outputs.len() {
        let (mut row,count)=classify(&tx.outputs,i);
        row.output_indices=(i..i+count).map(|n|n as u32).collect();
        row.native_value_atomic=tx.outputs[i..i+count].iter().map(|o|u128::from(o.satoshis)).sum::<u128>().to_string();
        result.push(row);i+=count;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value,json};
    use tbc_sdk::script::Script;
    fn raw_values(value:&Value, result:&mut Vec<Transaction>) {
        match value {
            Value::Object(o)=>for v in o.values(){raw_values(v,result)},
            Value::Array(a)=>for v in a{raw_values(v,result)},
            Value::String(s) if s.len()>120 && s.starts_with("0a000000")=>{
                if let Ok(tx)=Transaction::from_hex(s){result.push(tx);}
            }, _=>{}
        }
    }
    #[test]
    fn output_review_covers_all_outputs_without_mutating_transactions_or_exposing_scripts() {
        let mut count=0;let mut kinds=std::collections::BTreeSet::new();let mut unknown=std::collections::BTreeSet::new();
        for source in [include_str!("../../../fixtures/tbc-transfer.json"),
            include_str!("../../../fixtures/tbc20-standard-transfer.json"),
            include_str!("../../../fixtures/coin-proof.json"),
            include_str!("../../../fixtures/tbc721-standard-proof.json"),
            include_str!("../../../fixtures/amm-explicit173-lifecycle.json"),
            include_str!("../../../fixtures/amm-lp-proof.json")] {
            let mut transactions=vec![];raw_values(&serde_json::from_str(source).unwrap(),&mut transactions);
            for tx in transactions {
                let before=tx.serialize();let rows=outputs(&tx);assert_eq!(rows,outputs(&tx));
                assert_eq!(tx.serialize(),before);
                assert_eq!(rows.iter().flat_map(|o|o.output_indices.iter().copied()).collect::<Vec<_>>(),(0..tx.outputs.len() as u32).collect::<Vec<_>>());
                assert_eq!(rows.iter().map(|o|o.native_value_atomic.parse::<u128>().unwrap()).sum::<u128>(),tx.outputs.iter().map(|o|u128::from(o.satoshis)).sum::<u128>());
                for row in &rows {kinds.insert(row.kind.clone());
                    if row.kind=="unrecognized" {assert!(row.amount_atomic.is_none());assert!(!row.warnings.is_empty());
                        let b=tx.outputs[row.output_indices[0] as usize].script_pubkey.as_bytes();
                        unknown.insert((b.len(),hex(&b[b.len().saturating_sub(18)..])));
                    }
                    assert!(!serde_json::to_string(row).unwrap().contains("scriptSig"));
                }count+=1;
            }
        }
        for expected in ["native","tbc20-standard","tbc20-stablecoin","tbc721-standard","tbc20-lp","native-pool-reserve"] {assert!(kinds.contains(expected),"missing {expected}: {kinds:?}");}
        assert!(count>40);println!("OUTPUT_REVIEW_CORPUS {}",json!({"transactions":count,"kinds":kinds,"unknownFixtureTemplates":unknown}));
    }
    #[test]
    fn output_review_keeps_unknowns_unknown_and_never_suppresses_extra_outputs() {
        let mut tx=Transaction::new();tx.outputs=vec![TxOut{satoshis:42,script_pubkey:Address::from_hash160([1;20]).script_pubkey()},
            TxOut{satoshis:999,script_pubkey:Script::from_bytes(vec![0x51])},
            TxOut{satoshis:7,script_pubkey:Script::from_bytes(vec![0,0x6a,1,0x42])}];
        let before=outputs(&tx);assert_eq!(before.len(),3);assert_eq!(before[1].kind,"unrecognized");
        assert_eq!(before[1].native_value_atomic,"999");assert_eq!(before[1].amount_atomic,None);
        assert_eq!(before[2].warnings,vec!["NATIVE_VALUE_IN_UNSPENDABLE_OUTPUT"]);
        tx.outputs[0].satoshis=43;tx.outputs[0].script_pubkey=Address::from_hash160([2;20]).script_pubkey();
        let after=outputs(&tx);assert_ne!(before[0].amount_atomic,after[0].amount_atomic);assert_ne!(before[0].recipient,after[0].recipient);
    }
    #[test]
    fn output_review_tbc20_controller_is_not_misrepresented_as_an_address() {
        // Use a real checked-in pair rather than constructing Tape with a new codec.
        let mut txs=vec![];raw_values(&serde_json::from_str(include_str!("../../../fixtures/tbc20-standard-transfer.json")).unwrap(),&mut txs);
        let mut tx=txs.into_iter().find(|t|t.outputs.iter().any(|o|tbc20::parse_code(o.script_pubkey.as_bytes()).is_ok())).unwrap();
        let i=tx.outputs.iter().position(|o|tbc20::parse_code(o.script_pubkey.as_bytes()).is_ok()).unwrap();
        let mut actual=tbc20::parse_code(tx.outputs[i].script_pubkey.as_bytes()).unwrap();actual.controller=[1;21];
        tx.outputs[i].script_pubkey=Script::from_bytes(tbc20::instantiate_code(&actual).unwrap());
        let row=outputs(&tx).into_iter().find(|r|r.output_indices[0]==i as u32).unwrap();
        assert!(row.recipient.unwrap().starts_with("contract-controller:"));
        assert!(row.asset_identity.unwrap().starts_with("code-identity:"));
    }
}
