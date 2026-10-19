//! Current associated profiles reconstruct proofs; no caller-supplied witness,
//! secret key, HTTP, approval or asset-indexing algorithm is introduced here.
use std::{borrow::Cow, collections::{BTreeSet, HashMap}};
use tbc_sdk::{Transaction, OutPoint, TxIn, script::Script};
use tbc_engine_core::protocols::{coin, coin_proof, htlc, tbc20, tbc20_material, tbc20_proof};
use super::{AssociatedInput, AssociatedScriptType, parse_script};

pub(super) enum Prepared {
    Token(tbc20_proof::PreparedUnlock),
    Coin(coin_proof::PreparedUnlock),
}
impl Prepared {
    pub(super) fn digest(&self)->&[u8;32]{match self{Self::Token(p)=>p.signing_digest(),Self::Coin(p)=>p.signing_digest()}}
    pub(super) fn public_key(&self)->&[u8]{match self{Self::Token(p)=>p.public_key(),Self::Coin(p)=>p.public_key()}}
    pub(super) fn finalize(&self,signature:&[u8])->Result<Script,String>{
        match self{Self::Token(p)=>p.finalize(signature),Self::Coin(p)=>p.finalize(signature)}
            .map_err(|_|"Current associated signature or proof invalid".into())
    }
}
pub(super) fn is_current(kind:AssociatedScriptType)->bool{
    matches!(kind,AssociatedScriptType::CurrentTbc20|AssociatedScriptType::CurrentCoin)
}
pub(super) fn child_input(point:OutPoint,sequence:u32)->TxIn{
    let mut input=TxIn::new(point);
    input.sequence=sequence;
    input
}
/// Only the exact refund witness selects a lock. Claim witnesses (including
/// their preimage) are not decoded/copied here. Full signer/witness validation
/// still runs independently in derive() at prepare and finalize.
fn child_htlc_refund(input:&AssociatedInput,previous:&Transaction)->Result<Option<u32>,String>{
    if !matches!(input.script_sig_type,AssociatedScriptType::Other){return Ok(None);}
    let Some(text)=input.unfinished_script_sig.as_deref() else{return Ok(None)};
    if text.len()!=90||!text.starts_with("097369676e617475726521")||!text.ends_with("00"){return Ok(None);}
    let local=previous.outputs.get(input.output_index as usize);
    let script=if input.tx_id.is_some(){Cow::Owned(parse_script(input.script.as_deref().ok_or("HTLC child script missing")?,"HTLC child script")?)}
        else{Cow::Borrowed(&local.ok_or("HTLC child parent output missing")?.script_pubkey)};
    let Ok(code)=htlc::Code::decode(script.as_bytes()) else{return Ok(None)};
    if let Some(id)=&input.tx_id{
        let parent=parse_parent(input.pre_tx.as_deref().ok_or("HTLC child parent required")?)?;
        let output=parent.outputs.get(input.output_index as usize).ok_or("HTLC child parent output missing")?;
        if parent.txid().to_string()!=*id||output.script_pubkey!=*script||Some(output.satoshis)!=input.satoshis{
            return Err("HTLC child parent material mismatch".into());
        }
    }
    let public=hex::decode(text.get(22..88).ok_or("Invalid associated HTLC witness")?).map_err(|_|"Invalid associated HTLC witness")?;
    k256::ecdsa::VerifyingKey::from_sec1_bytes(&public).map_err(|_|"Invalid associated HTLC witness")?;
    code.verify_refund(&tbc_sdk::hash::hash160(&public),htlc::REFUND_SEQUENCE,code.raw_lock_time)
        .map_err(|_|"Invalid associated HTLC witness")?;
    Ok(Some(code.raw_lock_time))
}
/// Derive Coin holder and HTLC refund locks from concrete parent Code/Tape.
/// Reused by policy preview and continuation; no caller lock override, HTTP,
/// caller-declared administrator privilege or claim about current chain maturity.
pub(super) fn child_constraints(inputs:&[AssociatedInput],previous:&Transaction)->Result<(u32,Vec<u32>),String>{
    let mut locks=Vec::new();let mut sequences=vec![u32::MAX;inputs.len()];let mut htlc_refund=false;
    for (index,input) in inputs.iter().enumerate(){
        if !matches!(input.script_sig_type,AssociatedScriptType::CurrentCoin){
            if let Some(lock)=child_htlc_refund(input,previous)?{
                locks.push(lock);sequences[index]=htlc::REFUND_SEQUENCE;htlc_refund=true;
            }
            continue;
        }
        sequences[index]=coin::HOLDER_INPUT_SEQUENCE;
        let external;
        let parent=if let Some(id)=&input.tx_id{
            external=parse_parent(input.pre_tx.as_deref().ok_or("Current associated Coin parent required")?)?;
            if external.txid().to_string()!=*id{return Err("Current associated Coin parent identity mismatch".into());}
            &external
        }else{previous};
        let index=input.output_index as usize;
        let code_output=parent.outputs.get(index).ok_or("Current associated Coin Code missing")?;
        let tape_output=parent.outputs.get(index.checked_add(1).ok_or("Current associated Coin Tape index overflow")?).ok_or("Current associated Coin Tape missing")?;
        if code_output.satoshis!=500||tape_output.satoshis!=0{return Err("Current associated Coin pair values invalid".into());}
        let code=coin::parse_code(code_output.script_pubkey.as_bytes()).map_err(|_|"Current associated Coin Code invalid")?;
        let tape=coin::parse_tape(tape_output.script_pubkey.as_bytes(),Some(code.tape_size as usize)).map_err(|_|"Current associated Coin Tape invalid")?;
        locks.push(if administrator_key(input,&code)?.is_some(){0}else{tape.lock_time});
    }
    let lock=coin::required_lock_time(&locks).map_err(|_|"Associated child locks mix height and timestamp domains")?;
    if htlc_refund&&lock>i32::MAX as u32{return Err("Associated HTLC refund lock outside supported range".into());}
    Ok((lock,sequences))
}
/// Authenticate explicit public role material against the actual Coin Code.
/// Wallet permission/account binding remains mandatory above this primitive.
pub(super) fn administrator_key(input:&AssociatedInput,code:&coin::CodeDescriptor)->Result<Option<Vec<u8>>,String>{
    let Some(text)=&input.signing_public_key else{return Ok(None)};
    let bytes=hex::decode(text).map_err(|_|"Invalid Coin administrator public key")?;
    let compressed=match bytes.len(){
        32=>{let mut key=vec![2];key.extend_from_slice(&bytes);key},
        33 if matches!(bytes[0],2|3)=>bytes.clone(),
        _=>return Err("Invalid Coin administrator public key".into()),
    };
    k256::ecdsa::VerifyingKey::from_sec1_bytes(&compressed).map_err(|_|"Invalid Coin administrator public key")?;
    if tbc_sdk::hash::hash160(&bytes)!=code.admin_pubkey_hash{return Err("Coin administrator public key does not match Code".into());}
    Ok(Some(bytes))
}
pub(super) fn parse_parent(raw:&str)->Result<Transaction,String>{
    if raw.len()>2*tbc20_material::MAX_MATERIAL_TRANSACTION_BYTES{return Err("Current associated material too large".into());}
    let tx=Transaction::from_hex(raw).map_err(|_|"Invalid current associated material")?;
    if tx.to_hex()!=raw.to_ascii_lowercase(){return Err("Noncanonical current associated material".into());}Ok(tx)
}
fn dependencies(parent:&Transaction,vout:u32,kind:AssociatedScriptType)->Result<Vec<OutPoint>,String>{
    let raw=parent.serialize();let point=OutPoint{txid:parent.txid(),vout};
    match kind{
        AssociatedScriptType::CurrentCoin=>coin_proof::inspect_parent(&raw,&point,None)
            .map(|p|p.dependencies().to_vec()),
        AssociatedScriptType::CurrentTbc20=>tbc20_material::inspect_parent(&raw,&point,None)
            .map(|p|p.dependencies().iter().map(|d|d.outpoint.clone()).collect()),
        _=>return Err("Current associated profile required".into()),
    }.map_err(|_|"Current associated parent invalid".into())
}
pub(super) fn local_ancestors(parent:&Transaction,vout:u32,kind:AssociatedScriptType,cache:&HashMap<String,Transaction>)->Result<Vec<String>,String>{
    let ids:BTreeSet<_>=dependencies(parent,vout,kind)?.iter().map(|p|p.txid.to_string()).collect();
    ids.into_iter().map(|id|cache.get(&id).map(Transaction::to_hex).ok_or_else(||"Current associated ancestor missing".into())).collect()
}
fn groups(tx:&Transaction)->Result<Vec<tbc20_proof::OutputGroup>,String>{
    let mut result=Vec::new();let mut i=0;
    while i<tx.outputs.len(){
        let script=tx.outputs[i].script_pubkey.as_bytes();
        if coin::parse_code(script).is_ok()||tbc20::parse_code(script).is_ok(){
            if i+1>=tx.outputs.len(){return Err("Current associated output Tape missing".into());}
            result.push(tbc20_proof::OutputGroup{code_vout:i,tape_vout:Some(i+1)});i+=2;
        }else if (script.len()==25&&script[..3]==[0x76,0xa9,0x14]&&script[23..]==[0x88,0xac])
            ||tbc_engine_core::protocols::htlc::Code::decode(script).is_ok()
            ||tbc_engine_core::protocols::lop::Code::decode(script).is_ok(){
            result.push(tbc20_proof::OutputGroup{code_vout:i,tape_vout:None});i+=1;
        }else{return Err("Unsupported current associated output group".into());}
    }Ok(result)
}
/// Derive the controller from another consumed, authenticated output, never
/// from a caller-selected vin or arbitrary proof blob. Only exact HTLC/LOP
/// profiles are admitted; derive() validates signed branches, while
/// permissionless_scripts() reconstructs and checks the LOP match proof.
/// The usual colocated escrow reuses the already parsed Token/Coin parent.
fn controller<'a>(tx:&Transaction,index:usize,controller:&[u8;21],inputs:&[AssociatedInput],parent:&'a Transaction)
    ->Result<Option<(Cow<'a,Transaction>,usize)>,String>{
    if controller[20]==0{return Ok(None);}
    if controller[20]!=1{return Err("Unsupported current associated controller kind".into());}
    let mut found=None;
    for (vin,item) in inputs.iter().enumerate(){
        if vin==index{continue;}
        let script=parse_script(item.script.as_deref().ok_or("Controller input script missing")?,"controller script")?;
        if tbc_sdk::hash::hash160(&tbc_sdk::hash::sha256(script.as_bytes()))!=controller[..20]{continue;}
        let supported=match item.script_sig_type{
            AssociatedScriptType::Other=>tbc_engine_core::protocols::htlc::Code::decode(script.as_bytes()).is_ok()
                ||tbc_engine_core::protocols::lop::Code::decode(script.as_bytes()).is_ok(),
            AssociatedScriptType::TbcLopMatch=>tbc_engine_core::protocols::lop::Code::decode(script.as_bytes()).is_ok(),
            _=>false,
        };
        if !supported{
            return Err("Unsupported current associated controller profile".into());
        }
        let selected=tx.inputs.get(vin).ok_or("Controller input missing")?;
        if !selected.script_sig.as_bytes().is_empty()||item.tx_id.as_deref()!=Some(selected.previous_output.txid.to_string().as_str())
            ||item.output_index!=selected.previous_output.vout{return Err("Controller input identity mismatch".into());}
        let proof=if selected.previous_output.txid==parent.txid(){Cow::Borrowed(parent)}
            else{Cow::Owned(parse_parent(item.pre_tx.as_deref().ok_or("Controller parent required")?)?)};
        if proof.txid()!=selected.previous_output.txid{return Err("Controller parent identity mismatch".into());}
        let output=proof.outputs.get(item.output_index as usize).ok_or("Controller output missing")?;
        if output.script_pubkey!=script||item.satoshis!=Some(output.satoshis){return Err("Controller parent output mismatch".into());}
        if found.is_some(){return Err("Ambiguous current associated controller input".into());}
        found=Some((proof,vin));
    }
    found.map(Some).ok_or_else(||"Current associated controller input missing".into())
}
pub(super) fn prepare(tx:&Transaction,index:usize,input:&AssociatedInput,inputs:&[AssociatedInput],public_key:&[u8])->Result<Prepared,String>{
    // Keep historical profiles intact and reject attempts to splice supplied
    // witness/context bytes into a proof built by the shared current planner.
    if input.unfinished_script_sig.is_some()||input.pre_pre_tx_data.is_some()||input.contract_tx.is_some()||input.ft_version.is_some(){
        return Err("Current associated profile rejects witness overrides".into());
    }
    let selected=tx.inputs.get(index).ok_or("Current associated input missing")?;
    if !selected.script_sig.as_bytes().is_empty()||input.tx_id.as_deref()!=Some(selected.previous_output.txid.to_string().as_str())||input.output_index!=selected.previous_output.vout{
        return Err("Current associated input identity mismatch".into());
    }
    let parent=parse_parent(input.pre_tx.as_deref().ok_or("Current associated parent required")?)?;
    if parent.txid()!=selected.previous_output.txid{return Err("Current associated parent identity mismatch".into());}
    let output=parent.outputs.get(input.output_index as usize).ok_or("Current associated output missing")?;
    if input.satoshis!=Some(output.satoshis)||parse_script(input.script.as_deref().ok_or("Current associated script required")?,"current script")?!=output.script_pubkey{
        return Err("Current associated parent output mismatch".into());
    }
    let raws=input.ancestor_transactions.as_deref().ok_or("Current associated ancestor set required")?;
    if raws.len()>6{return Err("Current associated ancestor bound exceeded".into());}
    let bytes=raws.iter().map(|raw|parse_parent(raw).map(|t|t.serialize())).collect::<Result<Vec<_>,_>>()?;
    let refs=bytes.iter().map(Vec::as_slice).collect::<Vec<_>>();let raw=parent.serialize();let output_groups=groups(tx)?;
    match input.script_sig_type{
        AssociatedScriptType::CurrentCoin=>{
            let p=coin_proof::inspect_parent(&raw,&selected.previous_output,None).map_err(|_|"Current associated Coin parent invalid")?;
            let administrator=administrator_key(input,p.code())?;
            let public_key=administrator.as_deref().unwrap_or(public_key);
            let proof=if tbc_sdk::hash::hash160(public_key)==p.code().admin_pubkey_hash{None}
                else{controller(tx,index,&p.code().controller,inputs,&parent)?};
            coin_proof::prepare_unlock(coin_proof::UnlockOptions{current_tx:tx,input_index:index,parent:&p,ancestor_raws:&refs,
                output_groups:&output_groups,public_key,contract_controller:proof.as_ref().map(|(parent,vin)|tbc20_proof::ContractControllerWitness{transaction:parent,current_input_index:*vin})}).map(Prepared::Coin)
                .map_err(|_|"Current associated Coin proof invalid".into())
        },
        AssociatedScriptType::CurrentTbc20=>{
            let p=tbc20_material::inspect_parent(&raw,&selected.previous_output,None).map_err(|_|"Current associated Token parent invalid")?;
            let linked=tbc20_material::link_ancestors(&p,&refs).map_err(|_|"Current associated Token ancestors invalid")?;
            let proof=controller(tx,index,&p.code().controller,inputs,&parent)?;
            tbc20_proof::prepare_unlock(tbc20_proof::UnlockOptions{current_tx:tx,input_index:index,parent:&p,ancestors:&linked,
                output_groups:&output_groups,public_key,contract_controller:proof.as_ref().map(|(parent,vin)|tbc20_proof::ContractControllerWitness{transaction:parent,current_input_index:*vin})}).map(Prepared::Token)
                .map_err(|_|"Current associated Token proof invalid".into())
        },
        _=>Err("Current associated profile required".into()),
    }
}

#[cfg(test)]
mod controller_tests {
    use super::*;
    use tbc_sdk::{TxOut,Txid};
    #[test]
    fn child_locks_bind_external_parents_and_combine_only_same_domain(){
        // Public generator point only; this test never has custody.
        let public=hex::decode("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798").unwrap();
        let make=|lock|htlc::Code{sender_hash:tbc_sdk::hash::hash160(&public),receiver_hash:[2;20],hashlock:[3;32],raw_lock_time:lock};
        let mut parent=Transaction::new();parent.inputs.push(TxIn::new(OutPoint{txid:Txid::from_le_bytes([9;32]),vout:0}));
        parent.outputs=vec![100,200].into_iter().map(|lock|TxOut{satoshis:1000,script_pubkey:Script::from_bytes(make(lock).encode())}).collect();
        let template=format!("097369676e617475726521{}00",hex::encode(&public));
        let inputs:Vec<AssociatedInput>=(0..2).map(|vout|serde_json::from_value(serde_json::json!({"outputIndex":vout,"scriptSigType":"other","unfinishedScriptSig":template})).unwrap()).collect();
        assert_eq!(child_constraints(&inputs,&parent).unwrap(),(200,vec![u32::MAX-1;2]));
        let mut mixed=parent.clone();mixed.outputs[1].script_pubkey=Script::from_bytes(make(1774427165).encode());
        assert!(child_constraints(&inputs,&mixed).is_err());
        for lock in [0,0x80000000,u32::MAX]{
            let mut unsafe_parent=parent.clone();unsafe_parent.outputs[0].script_pubkey=Script::from_bytes(make(lock).encode());
            assert!(child_constraints(&inputs,&unsafe_parent).is_err());
        }
        let mut external=inputs[0].clone();external.tx_id=Some(parent.txid().to_string());external.pre_tx=Some(parent.to_hex());
        external.script=Some(hex::encode(parent.outputs[0].script_pubkey.as_bytes()));external.satoshis=Some(1000);
        assert_eq!(child_constraints(&[external.clone()],&Transaction::new()).unwrap(),(100,vec![u32::MAX-1]));
        for case in 0..6{
            let mut bad=external.clone();match case{
                0=>bad.pre_tx=None,1=>bad.tx_id=Some("11".repeat(32)),2=>bad.satoshis=Some(1001),
                3=>bad.script=Some(hex::encode(make(101).encode())),4=>bad.output_index=99,
                _=>bad.unfinished_script_sig=Some(format!("097369676e617475726521{}00","é".repeat(33))),
            }
            assert!(child_constraints(&[bad],&parent).is_err());
        }
        // A Coin absolute time lock and HTLC height refund cannot be combined.
        let fixture:serde_json::Value=serde_json::from_str(include_str!("../../../../fixtures/coin-admin-proof.json")).unwrap();
        let frozen=Transaction::from_hex(fixture["cases"][0]["signedRaw"].as_str().unwrap()).unwrap();
        let code_index=frozen.outputs.iter().position(|o|coin::parse_code(o.script_pubkey.as_bytes()).is_ok()).unwrap();
        let mut combined=parent.clone();combined.outputs.extend_from_slice(&frozen.outputs[code_index..code_index+2]);
        let coin_input:AssociatedInput=serde_json::from_value(serde_json::json!({"outputIndex":2,"scriptSigType":"tbc20-stablecoin"})).unwrap();
        let mut combined_inputs=vec![inputs[0].clone(),coin_input];
        assert!(child_constraints(&combined_inputs,&combined).is_err());
        // Authenticated administrator ignores the holder lock, as before.
        combined_inputs[1].signing_public_key=Some(fixture["cases"][0]["publicKeyHex"].as_str().unwrap().into());
        assert_eq!(child_constraints(&combined_inputs,&combined).unwrap().0,100);
    }
    fn fixture()->(Transaction,Transaction,Vec<AssociatedInput>,[u8;21]){
        let code=tbc_engine_core::protocols::htlc::Code{sender_hash:[1;20],receiver_hash:[2;20],hashlock:[3;32],raw_lock_time:100};
        let mut parent=Transaction::new();parent.inputs.push(TxIn::new(OutPoint{txid:Txid::from_le_bytes([9;32]),vout:0}));
        parent.outputs.push(TxOut{satoshis:100,script_pubkey:Script::from_bytes(code.encode())});
        parent.outputs.push(TxOut{satoshis:500,script_pubkey:Script::from_bytes(vec![0x51])});
        let mut tx=Transaction::new();
        let inputs=parent.outputs.iter().enumerate().map(|(vout,o)|{
            tx.inputs.push(TxIn::new(OutPoint{txid:parent.txid(),vout:vout as u32}));
            serde_json::from_value(serde_json::json!({"txId":parent.txid().to_string(),"outputIndex":vout,
                "satoshis":o.satoshis,"script":hex::encode(o.script_pubkey.as_bytes()),"scriptSigType":"other"})).unwrap()
        }).collect();
        let mut controller=[0;21];controller[..20].copy_from_slice(&code.token_controller());controller[20]=1;
        (parent,tx,inputs,controller)
    }
    #[test]
    fn controller_material_is_unique_authenticated_and_reuses_colocated_parent(){
        let (parent,tx,inputs,id)=fixture();
        let (proof,vin)=controller(&tx,1,&id,&inputs,&parent).unwrap().unwrap();
        assert_eq!(vin,0);assert!(matches!(proof,Cow::Borrowed(_)));
        let mut address=id;address[20]=0;
        assert!(controller(&tx,1,&address,&[],&parent).unwrap().is_none());
        for case in 0..7{
            let mut items=inputs.clone();let mut changed=tx.clone();let mut controller_id=id;
            match case{
                0=>items[0].satoshis=Some(101),
                1=>items[0].script=Some("51".into()),
                2=>items[0].script_sig_type=AssociatedScriptType::P2pkh,
                3=>{items.push(items[0].clone());changed.inputs.push(changed.inputs[0].clone());},
                4=>{items.remove(0);changed.inputs.remove(0);},
                5=>controller_id[20]=2,
                _=>{items[0].output_index=1;changed.inputs[0].previous_output.vout=1;},
            }
            assert!(controller(&changed,if case==4{0}else{1},&controller_id,&items,&parent).is_err(),"case {case}");
        }
        // A matching hash alone must never admit an unknown Script template.
        let mut unknown=parent.clone();unknown.outputs[0].script_pubkey=Script::from_bytes(vec![0x51]);
        let mut point=tx.clone();let mut items=inputs.clone();
        for (item,input)in items.iter_mut().zip(&mut point.inputs){item.tx_id=Some(unknown.txid().to_string());input.previous_output.txid=unknown.txid();}
        items[0].script=Some("51".into());let mut unknown_id=[0;21];unknown_id[20]=1;
        unknown_id[..20].copy_from_slice(&tbc_sdk::hash::hash160(&tbc_sdk::hash::sha256(&[0x51])));
        assert_eq!(controller(&point,1,&unknown_id,&items,&unknown).unwrap_err(),"Unsupported current associated controller profile");
        // Non-colocated controllers need their own canonical authenticated parent.
        let mut unrelated=parent.clone();unrelated.lock_time=1;
        assert!(controller(&tx,1,&id,&inputs,&unrelated).is_err());
        let mut items=inputs.clone();items[0].pre_tx=Some(parent.to_hex());
        assert!(matches!(controller(&tx,1,&id,&items,&unrelated).unwrap().unwrap().0,Cow::Owned(_)));
        items[0].pre_tx=Some(unrelated.to_hex());assert!(controller(&tx,1,&id,&items,&unrelated).is_err());
    }
}
