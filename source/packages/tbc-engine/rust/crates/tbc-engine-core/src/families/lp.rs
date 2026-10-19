//! New LP public holder operations. Shared immutable Pool anchor, minimum direct
//! ancestors and independent signing; no Pool current-state query for transfers.
use std::collections::{BTreeMap,BTreeSet};
use tbc_sdk::{Address,PublicKey,OutPoint,TxOut,script::Script};
use crate::{EngineError,ErrorCode,model::{CanonicalRequest,WalletMaterial,PlannedTransfer,AssetFlow,error},
    normalize::{hex,parse_decimal_u64,parse_decimal_u128,validate_request},
    protocols::{amm::MAX_AMOUNT,amm_lp,amm_lp_proof,amm_lp_batch::{self,BatchOptions,Operation},amm_lp_transfer::{LpInput,TransferOptions,FeeInput,MinerFeePolicy}},signing::PublicSigningContext};
use super::{amm::{self,Transactions},ft::{decode_hex,validate_material_identity,funding_candidates},tbc20::{finish,max_fee,permitted}};
fn invalid(message:&str)->EngineError{error(ErrorCode::InvalidInput,message,"request.intent")}
fn insufficient(message:&str)->EngineError{error(ErrorCode::InsufficientFunds,message,"snapshot.payload.utxos")}
pub(crate) fn validate_lp_request(request:&CanonicalRequest)->Result<(),EngineError>{
    let i=&request.intent;let fields=serde_json::to_value(i).map_err(|_|invalid("LP request encoding invalid"))?;
    let allowed:&[&str]=match i.intent_type.as_str(){
        "tbc20-lp-transfer"=>&["type","version","poolContractId","amount","to"],
        "tbc20-lp-lock"=>&["type","version","poolContractId","amount","lockTime"],
        _=>&["type","version","poolContractId"],
    };
    if fields.as_object().unwrap().keys().any(|k|!allowed.contains(&k.as_str())){return Err(invalid("LP request contains fields from another operation"));}
    let id=i.pool_contract_id.as_deref().ok_or_else(||invalid("LP requires Pool genesis transaction ID"))?;
    if id.len()!=64||!id.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)){return Err(invalid("LP Pool ID must be canonical txid"));}
    if matches!(i.intent_type.as_str(),"tbc20-lp-transfer"|"tbc20-lp-lock"){
        let amount=parse_decimal_u64(i.amount.as_deref().ok_or_else(||invalid("LP amount required"))?,"request.intent.amount")?;
        if amount==0||amount>MAX_AMOUNT{return Err(invalid("LP amount must be positive signed-63-bit atomic units"));}
    }
    if i.intent_type=="tbc20-lp-transfer"{Address::from_string(i.to.as_deref().ok_or_else(||invalid("LP recipient required"))?).map_err(|_|invalid("LP recipient invalid"))?;}
    if i.intent_type=="tbc20-lp-lock"{let lock=parse_decimal_u64(i.lock_time.as_deref().ok_or_else(||invalid("LP lockTime required"))?,"request.intent.lockTime")?;
        if lock==0||lock>u32::MAX as u64{return Err(invalid("LP lockTime must be a positive uint32"));}}
    Ok(())
}
pub(crate) fn check_policy(material:&WalletMaterial<'_>,id:&str,total:u128,slots:impl Iterator<Item=u64>)->Result<(),EngineError>{
    let mut found=false;
    for p in &material.policy.payload.contract_policies{if p.get("family").and_then(|v|v.as_str())!=Some("pool"){continue;}
        if found{return Err(amm::invalid("duplicate Pool contract policy"));}found=true;
        let versions=p.get("allowedVersions").and_then(|v|v.as_array()).ok_or_else(||amm::invalid("Pool allowedVersions missing"))?;
        let unique:Option<BTreeSet<_>>=versions.iter().map(|v|v.as_str()).collect();let unique=unique.ok_or_else(||amm::invalid("Pool version must be string"))?;
        if unique.len()!=versions.len()||!unique.contains("pool3"){return Err(amm::invalid("Pool policy does not allow new Pool3"));}
    }
    if !found{return Err(amm::invalid("new LP requires explicit Pool3 policy"));}
    let mut max_total=u128::MAX;let mut max_slot=MAX_AMOUNT as u128;let mut seen=BTreeMap::new();
    for l in &material.policy.payload.amount_limits{
        if !matches!(l.scope.as_str(),"lp-total"|"lp-slot")||l.protocol_version.as_deref().is_some_and(|v|v!="pool3")||l.contract_id.as_deref().is_some_and(|v|v!=id){continue;}
        let n=parse_decimal_u128(&l.maximum,"policy.payload.amountLimits.maximum")?;
        if n==0||seen.insert((&l.scope,&l.protocol_version,&l.contract_id),n).is_some_and(|old|old!=n){return Err(amm::invalid("LP limits zero or contradictory"));}
        if l.scope=="lp-total"{max_total=max_total.min(n);}else{max_slot=max_slot.min(n);}
    }
    if total>max_total||slots.into_iter().any(|n|n as u128>max_slot){return Err(amm::invalid("LP amount exceeds authenticated total/slot limit"));}Ok(())
}
pub(crate) fn plan_lp(request:&CanonicalRequest,material:&WalletMaterial<'_>,signing:&PublicSigningContext)->Result<PlannedTransfer,EngineError>{
    validate_request(request)?;validate_material_identity(request,material)?;
    let policy=&material.policy.payload;
    if policy.chain_id!=request.chain_id||policy.fee_rate_sat_per_kb!="80"||policy.dust_threshold!="10"||policy.sighash_type!=65{return Err(invalid("new LP policy requires 80 atomic/kB, dust10, sighash65"));}
    let public=PublicKey::from_slice(&decode_hex(&signing.public_key,"snapshot.payload.account.publicKey")?).map_err(|_|invalid("LP public key invalid"))?;
    let id=request.intent.pool_contract_id.as_deref().unwrap();let mut parents=Transactions::new(material)?;
    let anchor=amm::pool_anchor(id,material,&mut parents,&public)?;let state=anchor.config.read_pool(&anchor.genesis,&anchor.code_hash)?;
    let mut owner=[0;21];owner[..20].copy_from_slice(&public.hash160());
    let identity=amm_lp::code_identity(&anchor.config.lp_code(anchor.code_hash,owner)?).map_err(|_|amm::invalid("LP bound identity invalid"))?;
    let kind=request.intent.intent_type.as_str();let all=matches!(kind,"tbc20-lp-merge"|"tbc20-lp-unlock");
    let wanted=request.intent.amount.as_deref().map(|s|parse_decimal_u64(s,"request.intent.amount")).transpose()?.unwrap_or(0);
    if matches!(kind,"tbc20-lp-lock"|"tbc20-lp-unlock")&&!anchor.config.timelocked(){return Err(invalid("plain LP cannot be converted into a timelocked template"));}
    let exact=request.constraints.as_ref().and_then(|c|c.input_outpoints.as_ref()).is_some();
    let minimum=parse_decimal_u64(&policy.min_confirmations,"policy.payload.minConfirmations")?;
    let mut candidates:Vec<_>=material.snapshot.payload.utxos.iter().filter(|u|u.contract_id.as_deref()==Some(id)&&u.classification=="ftlp").collect();
    candidates.sort_by(|a,b|(&a.txid,a.vout).cmp(&(&b.txid,b.vout)));
    let mut selected=vec![];let mut total=0u128;let mut seen=BTreeSet::new();
    for u in candidates{
        if !seen.insert((&u.txid,u.vout)){return Err(amm::invalid("LP outpoint repeated"));}
        if !permitted(request,&u.txid,u.vout)||(!all&&total>=wanted as u128&&!exact){continue;}
        if !crate::confirmations::meets_minimum(u.confirmations.as_deref(),minimum,"snapshot.payload.utxos.confirmations")?{continue;}
        let tx=parents.get(&u.txid)?;let point=OutPoint{txid:tx.txid(),vout:u.vout};
        anchor.config.validate_lp(&tx,u.vout as usize,&public,&state)?;
        let parent=amm_lp_proof::inspect_parent(&tx.serialize(),&point,Some(&identity))?;
        if u.satoshis!="500"||u.script_pub_key!=hex(tx.outputs[u.vout as usize].script_pubkey.as_bytes()){return Err(amm::invalid("LP UTXO descriptor differs from material"));}
        let lock=parent.tape().lock_time;
        let mature=if lock==0{true}else if lock<amm_lp::LOCKTIME_THRESHOLD{u64::from(lock)<=parse_decimal_u64(&material.snapshot.payload.require_block()?.height,"snapshot.payload.block.height")?}else{
            let time=material.snapshot.payload.require_block()?.median_time_past.as_deref().ok_or_else(||error(ErrorCode::MissingMaterial,"LP timestamp lock requires trusted medianTimePast","snapshot.payload.block"))?;
            u64::from(lock)<parse_decimal_u64(time,"snapshot.payload.block.medianTimePast")?
        };
        if !mature{if exact{return Err(error(ErrorCode::MissingMaterial,"selected LP is not mature at bound chain tip","snapshot.payload.utxos"));}continue;}
        if selected.len()==128{return Err(invalid("LP selected asset input bound exceeded"));}
        let ids:BTreeSet<_>=parent.dependencies().iter().map(|p|p.txid.to_string()).collect();
        let raws=ids.iter().map(|id|parents.get(id).map(|t|t.serialize())).collect::<Result<Vec<_>,_>>()?;
        total+=parent.tape().balance().map_err(|_|amm::invalid("LP input amount invalid"))?;
        check_policy(material,id,total,parent.tape().amounts.into_iter())?;selected.push((parent,raws));
    }
    if selected.is_empty()||(!all&&total<wanted as u128){return Err(insufficient("no sufficient mature authenticated LP inputs"));}
    if kind=="tbc20-lp-merge"&&selected.len()<2{return Err(invalid("LP merge requires at least two inputs"));}
    let output_lock=request.intent.lock_time.as_deref().map(|s|parse_decimal_u64(s,"request.intent.lockTime").map(|v|v as u32)).transpose()?;
    if let Some(lock)=output_lock{let old=amm_lp::required_lock_time(&selected.iter().map(|(p,_)|p.tape().lock_time).collect::<Vec<_>>()).map_err(|_|invalid("LP selected locks mix domains"))?;
        if lock<old||(old!=0&&(old<amm_lp::LOCKTIME_THRESHOLD)!=(lock<amm_lp::LOCKTIME_THRESHOLD)){return Err(invalid("LP lock cannot shorten or change an existing lock domain"));}}
    let receiver=if let Some(to)=&request.intent.to{let mut c=[0;21];c[..20].copy_from_slice(&Address::from_string(to).map_err(|_|invalid("LP recipient invalid"))?.hash160());c}else{owner};
    let amount=if all{u64::try_from(total).map_err(|_|invalid("LP merged amount exceeds uint64"))?}else{wanted};
    check_policy(material,id,amount as u128,[amount].into_iter())?;
    let raw_refs:Vec<Vec<_>>=selected.iter().map(|(_,raws)|raws.iter().map(Vec::as_slice).collect()).collect();
    let inputs:Vec<_>=selected.iter().zip(&raw_refs).map(|((parent,_),raws)|LpInput{parent,ancestor_raws:raws,public_key:&public}).collect();
    let mut funding=funding_candidates(material,signing)?;funding.retain(|f|permitted(request,&f.txid,f.vout));funding.sort_by(|a,b|(a.satoshis,&a.txid,a.vout).cmp(&(b.satoshis,&b.txid,b.vout)));
    let maximum=max_fee(request)?;let mut cap=None;
    for f in funding{
        let output=TxOut{satoshis:f.satoshis,script_pubkey:Script::from_bytes(decode_hex(&f.script,"snapshot.payload.utxos")?)};
        let fee=FeeInput{outpoint:OutPoint{txid:f.txid.parse().map_err(|_|invalid("LP funding txid invalid"))?,vout:f.vout},output:&output,public_key:&public};
        let options=TransferOptions{inputs:&inputs,fee_input:&fee,expected_identity:&identity,receiver_controller:receiver,amount,lp_change_controller:None,native_change_hash:public.hash160(),lock_time:None,output_lock_time:output_lock,fee_policy:MinerFeePolicy::default(),max_fee:maximum};
        let operation=match kind{"tbc20-lp-merge"=>Operation::Merge,"tbc20-lp-unlock"=>Operation::Unlock,_=>Operation::Transfer};
        let built=amm_lp_batch::build_batch_plan(BatchOptions{transfer:options,max_transactions:policy.max_bundle_transactions as usize,operation});
        let mut built=match built{Ok(b)=>b,Err(e)if e.code==ErrorCode::InsufficientFunds=>continue,Err(e)if e.code==ErrorCode::FeeCapExceeded=>{cap=Some(e);continue;},Err(e)=>return Err(e)};
        let last=built.unsigned_plan.transactions.last_mut().ok_or_else(||invalid("LP plan is empty"))?;
        last.transaction_id=kind.into();last.role="primary".into();
        let direction=if kind=="tbc20-lp-transfer"{"send"}else{kind.strip_prefix("tbc20-lp-").unwrap()};
        return finish(request,material,built.unsigned_plan,built.fees,vec![AssetFlow{kind:"lp".into(),direction:direction.into(),amount:amount.to_string(),contract_id:Some(id.into()),from:request.from.clone(),to:Some(request.intent.to.clone().unwrap_or_else(||request.from.clone()))}]);
    }
    Err(cap.unwrap_or_else(||insufficient("LP needs one sufficient native fee input")))
}
