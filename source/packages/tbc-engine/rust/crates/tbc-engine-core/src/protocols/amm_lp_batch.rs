//! Bounded LP maintenance. Each round reuses the canonical LP builder; preview
//! handles are rebound to actual externally signed parents by the shared signer.
use std::collections::{BTreeMap,BTreeSet,VecDeque};
use tbc_sdk::{Transaction,TxIn,TxOut,OutPoint,PublicKey,script::Script};
use crate::{EngineError,ErrorCode,signing::{UnsignedPlan,bind_funding_recipe,remap_fungible_evidence}};
use super::{amm_lp,amm_lp_proof::{self,ParentMaterial},amm_lp_transfer::{self,LpInput,TransferOptions,TransferPlan,FeeInput},tbc20_transfer::TokenOutput};

pub enum Operation { Transfer, Merge, Unlock }
pub struct BatchOptions<'a>{pub transfer:TransferOptions<'a>,pub max_transactions:usize,pub operation:Operation}
pub struct BatchPlan{pub unsigned_plan:UnsignedPlan,pub token_outputs:Vec<TokenOutput>,pub fees:Vec<u64>,pub maximum_signed_bytes:Vec<usize>}
struct Token{parent:ParentMaterial,raws:Vec<Vec<u8>>,key:PublicKey}
struct Fee{point:OutPoint,output:TxOut,key:PublicKey}
struct Preview{raw:String,id:String}
fn invalid(s:&str)->EngineError{EngineError{code:ErrorCode::InvalidPlan,message:s.into(),path:None}}
fn decode(s:&str)->Result<Vec<u8>,EngineError>{
    if !s.is_ascii()||s.len()%2!=0{return Err(invalid("invalid staged LP hex"));}
    (0..s.len()).step_by(2).map(|i|u8::from_str_radix(&s[i..i+2],16).map_err(|_|invalid("invalid staged LP hex"))).collect()
}
fn preview(plan:&TransferPlan)->Result<Transaction,EngineError>{
    let p=&plan.unsigned_plan.transactions[0];let mut tx=Transaction::new();tx.version=p.version;tx.lock_time=p.lock_time;
    for i in &p.inputs{let mut vin=TxIn::new(OutPoint{txid:i.previous_transaction_id.parse().map_err(|_|invalid("invalid LP preview input"))?,vout:i.previous_output_index});vin.sequence=i.sequence;tx.inputs.push(vin);}
    for o in &p.outputs{tx.outputs.push(TxOut{satoshis:o.satoshis,script_pubkey:Script::from_bytes(decode(&o.locking_script)?)});}Ok(tx)
}
fn build_one(options:TransferOptions<'_>,operation:&Operation)->Result<TransferPlan,EngineError>{match operation{
    Operation::Transfer=>amm_lp_transfer::build_transfer_plan(options),Operation::Merge=>amm_lp_transfer::build_merge_plan(options),Operation::Unlock=>amm_lp_transfer::build_unlock_plan(options),
}}
pub fn build_batch_plan(options:BatchOptions<'_>)->Result<BatchPlan,EngineError>{
    let original=options.transfer;
    if original.inputs.is_empty()||original.inputs.len()>128||options.max_transactions==0{return Err(invalid("LP batch requires 1..128 assets and a positive bundle limit"));}
    if original.inputs.len()<=5{
        let p=build_one(original,&options.operation)?;
        return Ok(BatchPlan{unsigned_plan:p.unsigned_plan,token_outputs:p.token_outputs,fees:vec![p.fee],maximum_signed_bytes:vec![p.maximum_signed_bytes]});
    }
    let owner=original.inputs[0].parent.code().controller;
    if original.inputs.iter().any(|i|i.parent.code().controller!=owner||i.public_key.hash160()!=owner[..20])
        ||original.fee_input.public_key.hash160()!=original.native_change_hash{return Err(invalid("LP maintenance must preserve authenticated owners"));}
    amm_lp::required_lock_time(&original.inputs.iter().map(|i|i.parent.tape().lock_time).collect::<Vec<_>>()).map_err(|_|invalid("LP batch mixes lock domains"))?;
    let mut seen=BTreeSet::new();
    for p in original.inputs.iter().map(|i|i.parent.selected()).chain(std::iter::once(&original.fee_input.outpoint)){
        if !seen.insert((p.txid.to_string(),p.vout)){return Err(invalid("LP batch repeats an external outpoint"));}
    }
    let key=original.inputs[0].public_key.clone();
    let mut queue:VecDeque<_>=original.inputs.iter().map(|i|Token{parent:i.parent.clone(),raws:i.ancestor_raws.iter().map(|r|r.to_vec()).collect(),key:i.public_key.clone()}).collect();
    let mut fee=Fee{point:original.fee_input.outpoint.clone(),output:original.fee_input.output.clone(),key:original.fee_input.public_key.clone()};
    let mut result=BatchPlan{unsigned_plan:UnsignedPlan{transactions:vec![],evidence_table:vec![]},token_outputs:vec![],fees:vec![],maximum_signed_bytes:vec![]};
    let mut previews=BTreeMap::<String,Preview>::new();let mut evidence=BTreeMap::<String,u32>::new();let mut total_fee=0u64;
    loop{
        if result.fees.len()>=options.max_transactions{return Err(invalid("LP maintenance exceeds bundle transaction limit"));}
        let final_round=queue.len()<=5;let selected:Vec<_>=queue.drain(..queue.len().min(5)).collect();
        let refs:Vec<Vec<_>>=selected.iter().map(|i|i.raws.iter().map(Vec::as_slice).collect()).collect();
        let inputs:Vec<_>=selected.iter().zip(&refs).map(|(i,raws)|LpInput{parent:&i.parent,ancestor_raws:raws,public_key:&i.key}).collect();
        let fee_input=FeeInput{outpoint:fee.point.clone(),output:&fee.output,public_key:&fee.key};
        let round_options=TransferOptions{inputs:&inputs,fee_input:&fee_input,expected_identity:original.expected_identity,
            receiver_controller:if final_round{original.receiver_controller}else{owner},amount:original.amount,
            lp_change_controller:if final_round{original.lp_change_controller}else{Some(owner)},native_change_hash:original.native_change_hash,
            lock_time:original.lock_time,output_lock_time:if final_round{original.output_lock_time}else{None},
            fee_policy:original.fee_policy,max_fee:original.max_fee.checked_sub(total_fee).ok_or_else(||invalid("LP aggregate fee overflow"))?};
        let mut round=build_one(round_options,if final_round{&options.operation}else{&Operation::Merge})?;
        let tx=preview(&round)?;let txid=tx.txid().to_string();
        if previews.contains_key(&txid){return Err(invalid("LP preview identity collision"));}
        let id=if final_round{match options.operation{Operation::Transfer=>"tbc20-lp-transfer",Operation::Merge=>"tbc20-lp-merge",Operation::Unlock=>"tbc20-lp-unlock"}.into()}
            else{format!("tbc20-lp-maintenance-{}",result.fees.len())};
        let mut remap=BTreeMap::new();
        for (index,entry) in round.unsigned_plan.evidence_table.iter().enumerate(){
            if previews.contains_key(&entry.txid){continue;}
            let global=if let Some(&index)=evidence.get(&entry.txid){
                if result.unsigned_plan.evidence_table[index as usize]!=*entry{return Err(invalid("conflicting LP immutable evidence"));}index
            }else{let index=result.unsigned_plan.evidence_table.len() as u32;result.unsigned_plan.evidence_table.push(entry.clone());evidence.insert(entry.txid.clone(),index);index};
            remap.insert(index as u32,global);
        }
        let planned=&mut round.unsigned_plan.transactions[0];planned.transaction_id=id.clone();
        if !final_round{planned.role="maintenance".into();}
        let mut dependencies=Vec::new();
        for input in &mut planned.inputs{
            if let Some(prior)=previews.get(&input.previous_transaction_id){input.previous_transaction_id=prior.id.clone();if !dependencies.contains(&prior.id){dependencies.push(prior.id.clone());}}
            if input.unlocking_script.is_empty(){continue;}
            for(txid,prior)in &previews{
                let indices:Vec<_>=round.unsigned_plan.evidence_table.iter().enumerate().filter(|(_,e)|&e.txid==txid&&e.raw_transaction==prior.raw).map(|(i,_)|i as u32).collect();
                input.unlocking_script=bind_funding_recipe(&input.unlocking_script,&prior.raw,&indices,&prior.id)?;
            }
            input.unlocking_script=remap_fungible_evidence(&input.unlocking_script,&remap)?;
        }
        planned.depends_on=dependencies;
        planned.stage=planned.depends_on.iter().map(|id|result.unsigned_plan.transactions.iter().find(|p|&p.transaction_id==id).map(|p|p.stage+1).ok_or_else(||invalid("missing LP planned dependency"))).collect::<Result<Vec<_>,_>>()?.into_iter().max().unwrap_or(0);
        total_fee=total_fee.checked_add(round.fee).ok_or_else(||invalid("LP total fee overflow"))?;
        result.fees.push(round.fee);result.maximum_signed_bytes.push(round.maximum_signed_bytes);result.unsigned_plan.transactions.push(round.unsigned_plan.transactions.remove(0));
        if final_round{result.token_outputs=round.token_outputs;return Ok(result);}
        // A maintenance round must create one owner-preserving LP output and
        // one reusable P2PKH fee output. No parent is broadcast or fetched here.
        if round.token_outputs.len()!=1{return Err(invalid("LP maintenance does not reduce asset inputs"));}
        let next=amm_lp_proof::inspect_parent(&tx.serialize(),&OutPoint{txid:tx.txid(),vout:0},Some(original.expected_identity))?;
        let mut raws=Vec::new();let required:BTreeSet<_>=next.dependencies().iter().map(|p|p.txid.to_string()).collect();
        for id in required{let parent=selected.iter().find(|i|i.parent.transaction().txid().to_string()==id).ok_or_else(||invalid("LP maintenance ancestor closure missing"))?;raws.push(parent.parent.transaction().serialize());}
        queue.push_back(Token{parent:next,raws,key:key.clone()});
        let native:Vec<_>=tx.outputs.iter().enumerate().filter(|(_,o)|o.script_pubkey==Script::p2pkh(&original.native_change_hash)).collect();
        if native.len()!=1{return Err(EngineError{code:ErrorCode::InsufficientFunds,message:"LP maintenance requires retained funding change".into(),path:None});}
        fee=Fee{point:OutPoint{txid:tx.txid(),vout:native[0].0 as u32},output:native[0].1.clone(),key:fee.key};
        previews.insert(txid,Preview{raw:tx.to_hex(),id});
    }
}
