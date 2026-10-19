//! Explicit new-asset HTLC profile using shared identity, policy and signing.
//! No I/O, custody, secret logging, or inference from a self-asserted asset ID.
use std::collections::BTreeSet;
use tbc_sdk::{Address,OutPoint,PublicKey,Transaction,TxOut,script::Script};
use crate::{EngineError,ErrorCode,model::{AssetFlow,CanonicalRequest,PlannedTransfer,WalletMaterial,error},
    normalize::{hex,parse_decimal_u64},signing::PublicSigningContext,
    protocols::{coin_identity,coin_proof,tbc20_material,htlc::Code,
        htlc_token::{self,ChainContext,TokenInput,TokenProfile,LockOptions,SpendOptions},
        htlc_transaction::SpendBranch,tbc20_transfer::FeeInput}};
use super::{coin,tbc20::{self,Parents,max_fee,permitted,finish_with_warnings},ft::{decode_hex,funding_candidates}};
fn invalid(message:&str)->EngineError{error(ErrorCode::InvalidAncestry,message,"snapshot.payload")}
fn missing(message:&str)->EngineError{error(ErrorCode::MissingMaterial,message,"snapshot.payload")}
fn bound_tx(parents:&mut Parents<'_>,id:&str)->Result<Transaction,EngineError>{
    let raw=parents.bytes(id)?;let tx=Transaction::from_bytes(raw).map_err(|_|invalid("HTLC Token parent malformed"))?;
    if tx.serialize()!=raw||tx.txid().to_string()!=id{return Err(invalid("HTLC Token parent ID/canonical bytes mismatch"));}Ok(tx)
}
enum Anchor{Ft(tbc20::TokenIdentity),Coin(coin_identity::IssuerIdentity)}
struct Selected{parent:Transaction,vout:u32,ancestors:Vec<Transaction>}
fn check_amount(request:&CanonicalRequest,material:&WalletMaterial<'_>,profile:TokenProfile,total:u128,slots:impl IntoIterator<Item=u64>)->Result<(),EngineError>{
    match profile{TokenProfile::Tbc20=>tbc20::check_shared_amount_policy(request,material,total,slots),
        TokenProfile::Coin=>coin::check_policy(material,request,total,slots.into_iter())}
}
pub(crate) fn plan_token_htlc(request:&CanonicalRequest,material:&WalletMaterial<'_>,signing:&PublicSigningContext,
    public:&PublicKey,chain:ChainContext)->Result<PlannedTransfer,EngineError>{
    let profile=if request.intent.asset_standard.as_deref()==Some("tbc20-standard"){TokenProfile::Tbc20}else{TokenProfile::Coin};
    let id=request.intent.contract_id.as_deref().ok_or_else(||missing("HTLC Token asset ID absent"))?;
    let lock=request.intent.intent_type=="tbc-htlc-lock";
    let wanted=if lock{parse_decimal_u64(request.intent.amount.as_deref().unwrap(),"request.intent.amount")? as u128}else{0};
    let target=if lock{None}else{request.intent.target_outpoints.as_ref().and_then(|p|p.first())};
    let mut parents=Parents::new(material)?;
    let anchor=match profile{TokenProfile::Tbc20=>Anchor::Ft(tbc20::trusted_token_identity(id,material,&mut parents)?),
        TokenProfile::Coin=>Anchor::Coin(coin::trusted_issuer(id,material,&mut parents)?)};
    let minimum=parse_decimal_u64(&material.policy.payload.min_confirmations,"policy.payload.minConfirmations")?;
    let mut owner=[0;21];owner[..20].copy_from_slice(&public.hash160());
    let exact=request.constraints.as_ref().and_then(|c|c.input_outpoints.as_ref()).is_some();
    let mut candidates:Vec<_>=material.snapshot.payload.utxos.iter().filter(|u|u.contract_id.as_deref()==Some(id)
        && target.is_none_or(|p|u.txid==p.txid&&u.vout==p.vout)).collect();
    candidates.sort_by(|a,b|(&a.txid,a.vout).cmp(&(&b.txid,b.vout)));
    let mut selected=vec![];let mut total=0u128;let mut identity:Option<Vec<u8>>=None;let mut seen=BTreeSet::new();
    for u in candidates{
        if !seen.insert((&u.txid,u.vout)){return Err(invalid("HTLC Token descriptor repeated"));}
        if !permitted(request,&u.txid,u.vout){continue;}
        if lock&&total>=wanted&&!exact{continue;}
        let classification=if profile==TokenProfile::Tbc20{"ft"}else{"stablecoin"};
        if u.classification!=classification{return Err(invalid("HTLC asset classification differs from explicit standard"));}
        if !crate::confirmations::meets_minimum(u.confirmations.as_deref(),minimum,"snapshot.payload.utxos.confirmations")?{
            if !lock||exact{return Err(missing("HTLC selected asset does not meet confirmation policy"));}continue;
        }
        if selected.len()==5{return Err(error(ErrorCode::UnsupportedIntent,"HTLC Token deposit supports at most five selected asset inputs","snapshot.payload.utxos"));}
        let point=OutPoint{txid:u.txid.parse().map_err(|_|invalid("HTLC asset outpoint invalid"))?,vout:u.vout};
        let raw=parents.bytes(&u.txid)?;
        let (parent,controller,balance,slots,asset_identity,dependencies)=match &anchor{
            Anchor::Ft(genesis)=>{
                let p=tbc20_material::inspect_parent(raw,&point,Some(genesis.identity()))?;
                if p.tape().extension!=genesis.tape().extension{return Err(invalid("HTLC Token metadata differs from issuance"));}
                (p.transaction().clone(),p.code().controller,p.tape().balance,p.tape().amounts,p.identity().to_vec(),
                    p.dependencies().iter().map(|d|d.outpoint.txid.to_string()).collect::<BTreeSet<_>>())
            },
            Anchor::Coin(issuer)=>{
                let p=coin_proof::inspect_parent(raw,&point,identity.as_deref())?;coin_identity::validate_holder_identity(issuer,&p)?;
                (p.transaction().clone(),p.code().controller,p.tape().balance,p.tape().amounts,p.identity().to_vec(),
                    p.dependencies().iter().map(|p|p.txid.to_string()).collect::<BTreeSet<_>>())
            },
        };
        if u.satoshis!="500"||u.script_pub_key!=hex(parent.outputs[u.vout as usize].script_pubkey.as_bytes())||(lock&&controller!=owner){
            return Err(invalid("HTLC Token descriptor/holder differs from bound parent"));
        }
        if identity.is_none(){identity=Some(asset_identity);}
        total=total.checked_add(balance).ok_or_else(||invalid("HTLC Token amount overflow"))?;
        check_amount(request,material,profile,total,slots)?;
        let ancestors=dependencies.iter().map(|id|bound_tx(&mut parents,id)).collect::<Result<Vec<_>,_>>()?;
        selected.push(Selected{parent,vout:u.vout,ancestors});
    }
    if selected.is_empty()||(lock&&total<wanted){return Err(error(ErrorCode::InsufficientFunds,"HTLC authenticated asset balance unavailable","snapshot.payload.utxos"));}
    if !lock{
        if selected.len()!=1{return Err(invalid("HTLC Token spend must have one exact deployed pair"));}
        let deposit=&selected[0].parent;let txid=deposit.txid().to_string();
        let rows:Vec<_>=material.snapshot.payload.utxos.iter().filter(|u|u.txid==txid&&u.vout==0).collect();
        if rows.len()!=1{return Err(missing("HTLC paired escrow must have independent current UTXO status"));}
        let u=rows[0];let out=&deposit.outputs[0];
        if u.classification!="htlc"||u.contract_id.is_some()||u.satoshis!=out.satoshis.to_string()||u.script_pub_key!=hex(out.script_pubkey.as_bytes())
            ||!permitted(request,&txid,0)||!crate::confirmations::meets_minimum(u.confirmations.as_deref(),minimum,"snapshot.payload.utxos.confirmations")?{
            return Err(invalid("HTLC paired escrow descriptor or confirmation policy mismatch"));
        }
    }
    let refs:Vec<Vec<_>>=selected.iter().map(|s|s.ancestors.iter().collect()).collect();
    let inputs:Vec<_>=selected.iter().zip(&refs).map(|(s,ancestors)|TokenInput{parent:&s.parent,vout:s.vout,ancestors}).collect();
    let code=if lock{Some(Code{sender_hash:public.hash160(),receiver_hash:Address::from_string(request.intent.to.as_deref().unwrap())
        .map_err(|_|invalid("HTLC receiver invalid"))?.hash160(),raw_lock_time:parse_decimal_u64(request.intent.lock_time.as_deref().unwrap(),"request.intent.lockTime")? as u32,
        hashlock:decode_hex(request.intent.hashlock.as_deref().unwrap(),"request.intent.hashlock")?.try_into().unwrap()})}else{None};
    let branch=if request.intent.intent_type=="tbc-htlc-claim"{SpendBranch::Claim(decode_hex(request.intent.preimage.as_deref().unwrap(),"request.intent.preimage")?)}else{SpendBranch::Refund};
    let mut funding=funding_candidates(material,signing)?;funding.retain(|u|permitted(request,&u.txid,u.vout));
    funding.sort_by(|a,b|(a.satoshis,&a.txid,a.vout).cmp(&(b.satoshis,&b.txid,b.vout)));
    if exact&&funding.len()!=1{return Err(error(ErrorCode::UnsupportedIntent,"HTLC Token exact funding requires one native output","request.constraints.inputOutpoints"));}
    let maximum=max_fee(request)?;let mut cap_failure=None;
    for f in funding{
        let out=TxOut{satoshis:f.satoshis,script_pubkey:Script::from_bytes(decode_hex(&f.script,"snapshot.payload.utxos.scriptPubKey")?)};
        let fee=FeeInput{outpoint:OutPoint{txid:f.txid.parse().map_err(|_|invalid("HTLC fee outpoint invalid"))?,vout:f.vout},output:&out,public_key:public};
        let result=if let Some(code)=&code{htlc_token::build_lock_plan(LockOptions{profile,inputs:&inputs,funding:&fee,
            expected_identity:identity.as_deref().unwrap(),code,amount:wanted,chain,max_fee:maximum})}
        else{htlc_token::build_spend_plan(SpendOptions{profile,token:TokenInput{parent:inputs[0].parent,vout:inputs[0].vout,ancestors:inputs[0].ancestors},funding:&fee,
            expected_identity:identity.as_deref().unwrap(),branch:&branch,chain,max_fee:maximum})};
        let built=match result{Ok(v)=>v,Err(e)if e.code==ErrorCode::InsufficientFunds=>continue,
            Err(e)if e.code==ErrorCode::FeeCapExceeded=>{cap_failure=Some(e);continue;},Err(e)=>return Err(e)};
        for output in &built.unsigned_plan.transactions[0].outputs{
            if output.satoshis!=0{continue;}
            let tape=decode_hex(&output.locking_script,"plan.output")?;
            let (balance,slots)=match profile{TokenProfile::Tbc20=>{let t=crate::protocols::tbc20::parse_tape(&tape).map_err(|_|invalid("HTLC output Tape invalid"))?;(t.balance,t.amounts)},
                TokenProfile::Coin=>{let t=crate::protocols::coin::parse_tape(&tape,None).map_err(|_|invalid("HTLC Coin output Tape invalid"))?;(t.balance,t.amounts)}};
            check_amount(request,material,profile,balance,slots)?;
        }
        let warnings=if matches!(branch,SpendBranch::Claim(_)){vec!["HTLC_CLAIM_SIGNED_BYTES_DISCLOSE_PREIMAGE".into()]}else{vec![]};
        return finish_with_warnings(request,material,built.unsigned_plan,vec![built.fee],vec![AssetFlow{
            kind:if profile==TokenProfile::Tbc20{"ft"}else{"stablecoin"}.into(),direction:if lock{"lock"}else{"unlock"}.into(),
            amount:if lock{wanted}else{total}.to_string(),contract_id:Some(id.into()),from:request.from.clone(),
            to:Some(if lock{request.intent.to.as_ref().unwrap().clone()}else{request.from.clone()}),
        }],warnings);
    }
    Err(cap_failure.unwrap_or_else(||error(ErrorCode::InsufficientFunds,"HTLC Token requires sufficient native fee funding","snapshot.payload.utxos")))
}
