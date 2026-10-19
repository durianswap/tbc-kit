//! Selected-material Pool3 business construction. Quotes, evidence, fees and
//! external signing are shared; no HTTP, keys, coin selection or wallet policy.
use std::collections::{BTreeMap,BTreeSet};
use tbc_sdk::{Transaction,PublicKey,OutPoint,script::Script};
use crate::{EngineError,ErrorCode,signing::*};
use super::{amm,amm_code::Authorization,amm_lp,amm_lp_proof,amm_math::{self,AddBudget},
    amm_state::{PoolConfig,PoolSnapshot},amm_transaction::{self,FeePlan,MinerFeePolicy},
    tbc20,tbc20_material,tbc20_proof::check_transaction,tbc20_transfer::{intern,public_context}};
const MAX_SAFE:u64=9_007_199_254_740_991;
fn invalid(message:&str)->EngineError{EngineError{code:ErrorCode::InvalidPlan,message:message.into(),path:None}}
fn insufficient(message:&str)->EngineError{EngineError{code:ErrorCode::InsufficientFunds,message:message.into(),path:None}}
fn hex(bytes:&[u8])->String{bytes.iter().map(|b|format!("{b:02x}")).collect()}
fn amount(value:u64)->Result<u64,EngineError>{amm::amount(value).map_err(|_|invalid("AMM amount out of range"))}
fn narrow(value:u128)->Result<u64,EngineError>{u64::try_from(value).ok().filter(|v|*v<=amm::MAX_AMOUNT).ok_or_else(||invalid("AMM single output slot exceeds signed-63-bit range"))}

pub struct AssetInput<'a>{pub parent:&'a Transaction,pub vout:u32,pub ancestors:&'a [&'a Transaction],pub public_key:&'a PublicKey}
pub struct Funding<'a>{pub parent:&'a Transaction,pub vout:u32,pub public_key:&'a PublicKey}
#[derive(Clone,Copy,Debug)]
pub enum Action {
    Add{budget:AddBudget,min_lp:u64,max_ft:Option<u64>,max_tbc:Option<u64>,lp_lock_time:Option<u32>},
    Remove{burn:u64,min_ft:u64,min_tbc:u64,lock_time:Option<u32>},
    Buy{input_tbc:u64,min_ft:u64},
    Sell{input_ft:u64,min_tbc:u64},
}
#[derive(Debug)]
pub enum Quote{Add(amm_math::AddQuote),Remove(amm_math::RemoveQuote),Buy(amm_math::BuyQuote),Sell(amm_math::SellQuote)}
impl Quote{
    pub fn next_state(&self)->amm_math::State{match self{Self::Add(q)=>q.next_state,Self::Remove(q)=>q.next_state,Self::Buy(q)=>q.next_state,Self::Sell(q)=>q.next_state}}
    fn operation(&self)->u8{match self{Self::Add(_)=>1,Self::Remove(_)=>2,Self::Buy(_)=>3,Self::Sell(_)=>4}}
    fn name(&self)->&'static str{match self{Self::Add(_)=>"tbc-amm-add-lp",Self::Remove(_)=>"tbc-amm-remove-lp",Self::Buy(_)=>"tbc-amm-buy",Self::Sell(_)=>"tbc-amm-sell"}}
}
pub struct Options<'a>{
    pub config:&'a PoolConfig,pub pool:&'a PoolSnapshot<'a>,pub pool_ancestor:&'a Transaction,
    pub pool_ft:&'a AssetInput<'a>,pub user_asset:Option<&'a AssetInput<'a>>,pub funding:Funding<'a>,
    pub controller_public_key:Option<&'a PublicKey>,pub expected_snapshot_hash:Option<[u8;32]>,
    pub action:Action,pub receiver_hash:[u8;20],pub change_hash:[u8;20],pub fee_policy:MinerFeePolicy,pub max_fee:u64,
}
#[derive(Debug)]
pub struct BusinessPlan{pub funded:FeePlan,pub quote:Quote,pub consumed_snapshot_hash:[u8;32]}
struct Outputs{items:Vec<PlannedOutput>,groups:Vec<Tbc20OutputGroup>}
impl Outputs{
    fn single(&mut self,satoshis:u64,script:&[u8]){self.groups.push(Tbc20OutputGroup{code_vout:self.items.len() as u32,tape_vout:None});self.items.push(PlannedOutput{satoshis,locking_script:hex(script)});}
    fn pair(&mut self,satoshis:u64,code:&[u8],tape:&[u8]){self.groups.push(Tbc20OutputGroup{code_vout:self.items.len() as u32,tape_vout:Some(self.items.len() as u32+1)});self.items.push(PlannedOutput{satoshis,locking_script:hex(code)});self.items.push(PlannedOutput{satoshis:0,locking_script:hex(tape)});}
    fn ft(&mut self,code:&[u8],extension:&[u8],slots:[u64;6])->Result<(),EngineError>{let tape=tbc20::build_tape(slots,extension).map_err(|_|invalid("AMM FT output Tape invalid"))?;self.pair(500,code,&tape);Ok(())}
    fn lp(&mut self,code:&[u8],config:&PoolConfig,slots:[u64;6],lock:u32)->Result<(),EngineError>{let tape=amm_lp::Tape{amounts:slots,size:config.tape_size(),timelocked:config.timelocked(),lock_time:lock}.encode().map_err(|_|invalid("AMM LP output Tape invalid"))?;self.pair(500,code,&tape);Ok(())}
    fn payment(&mut self,hash:&[u8;20],satoshis:u64){self.single(satoshis,Script::p2pkh(hash).as_bytes());}
    fn service(&mut self,config:&PoolConfig,satoshis:u64){self.single(satoshis,if satoshis==0{&[0,0x6a]}else{config.fee_script().as_bytes()});}
}
fn slots(entries:&[(usize,u64)])->[u64;6]{let mut slots=[0;6];for &(i,n)in entries{slots[i]=n;}slots}
fn output<'a>(parent:&'a Transaction,vout:u32)->Result<&'a tbc_sdk::TxOut,EngineError>{parent.outputs.get(vout as usize).ok_or_else(||invalid("AMM input output missing"))}

pub fn build_plan(options:Options<'_>)->Result<BusinessPlan,EngineError>{
    let config=options.config;let pool=options.pool;let state=pool.math();let pool_ft=options.pool_ft;
    check_transaction(options.pool_ancestor)?;
    if options.expected_snapshot_hash.is_some_and(|h|&h!=pool.snapshot_hash()){return Err(invalid("AMM consumed Pool differs from quoted snapshot"));}
    match(config.authorization(),options.controller_public_key){
        (Authorization::Public,None)=>{},
        (Authorization::Controller(hashes),Some(key)) if hashes.contains(&key.hash160())=>{},
        _=>return Err(invalid("AMM controller role does not match Pool authorization")),
    }
    let pool_ft_tape=config.validate_ft(pool_ft.parent,pool_ft.vout as usize,pool_ft.public_key,Some(pool))?;
    let pool_ft_code=output(pool_ft.parent,pool_ft.vout)?.script_pubkey.as_bytes();
    let user=options.user_asset;
    if matches!(options.action,Action::Buy{..})!=user.is_none(){return Err(invalid("AMM action has wrong user asset presence"));}
    let (user_ft,user_lp)=match(options.action,user){
        (Action::Remove{..},Some(u))=>(None,Some(config.validate_lp(u.parent,u.vout as usize,u.public_key,pool)?)),
        (_,Some(u))=>(Some(config.validate_ft(u.parent,u.vout as usize,u.public_key,None)?),None),_ =>(None,None),
    };
    let fee=config.fee_policy();
    let quote=match options.action{
        Action::Add{budget,min_lp,max_ft,max_tbc,lp_lock_time}=>{
            amount(min_lp)?;if let Some(n)=max_ft{amount(n)?;}if let Some(n)=max_tbc{amount(n)?;}
            if config.timelocked()!=lp_lock_time.is_some(){return Err(invalid("AMM LP creation requires lock time only for locked template"));}
            let q=amm_math::quote_add(state,budget).map_err(|_|invalid("AMM add quote invalid"))?;
            if q.ft_lp_increment_raw<min_lp||max_ft.is_some_and(|n|q.ft_a_increment_raw>n)||max_tbc.is_some_and(|n|q.tbc_increment_sat>n){return Err(invalid("AMM add exceeds caller limits"));}Quote::Add(q)
        },
        Action::Remove{burn,min_ft,min_tbc,..}=>{amount(min_ft)?;amount(min_tbc)?;let q=amm_math::quote_remove(state,burn).map_err(|_|invalid("AMM remove quote invalid"))?;
            if q.ft_a_decrement_raw<min_ft||q.pool_value_decrement_sat<min_tbc{return Err(invalid("AMM remove below caller minimum"));}Quote::Remove(q)},
        Action::Buy{input_tbc,min_ft}=>Quote::Buy(fee.quote_buy(state,input_tbc,min_ft).map_err(|_|invalid("AMM buy quote invalid or below caller minimum"))?),
        Action::Sell{input_ft,min_tbc}=>Quote::Sell(fee.quote_sell(state,input_ft,min_tbc).map_err(|_|invalid("AMM sell quote invalid or below caller minimum"))?),
    };
    let next=quote.next_state();let mut tape=pool.tape().clone();tape.ft_lp_amount=next.ft_lp_amount;tape.ft_a_amount=next.ft_a_amount;tape.tbc_amount=next.tbc_amount;
    let mut outputs=Outputs{items:vec![],groups:vec![]};outputs.pair(next.pool_value,pool.transaction().outputs[0].script_pubkey.as_bytes(),&tape.encode().map_err(|_|invalid("AMM new state Tape invalid"))?);
    let mut receiver=[0;21];receiver[..20].copy_from_slice(&options.receiver_hash);
    let user_code=user.map(|u|output(u.parent,u.vout)).transpose()?.map(|o|o.script_pubkey.as_bytes());
    match &quote{
        Quote::Add(q)=>{
            let user_tape=user_ft.as_ref().unwrap();if user_tape.balance<q.ft_a_increment_raw as u128{return Err(insufficient("AMM selected user FT insufficient; explicit consolidation required"));}
            outputs.ft(pool_ft_code,&pool_ft_tape.extension,slots(&[(1,q.ft_a_increment_raw),(2,state.ft_a_amount)]))?;
            let lp_code=config.lp_code(*pool.pool_hash(),receiver)?;let Action::Add{lp_lock_time,..}=options.action else{unreachable!()};
            outputs.lp(&lp_code,config,slots(&[(0,q.ft_lp_increment_raw)]),lp_lock_time.unwrap_or(0))?;
            let change=narrow(user_tape.balance-q.ft_a_increment_raw as u128)?;if change>0{outputs.ft(user_code.unwrap(),&user_tape.extension,slots(&[(1,change)]))?;}
        },
        Quote::Remove(q)=>{
            let lp=user_lp.as_ref().unwrap();let balance=lp.balance().map_err(|_|invalid("AMM LP balance invalid"))?;if balance<q.ft_lp_burn_raw as u128{return Err(insufficient("AMM selected LP insufficient"));}
            outputs.payment(&options.receiver_hash,q.pool_value_decrement_sat);
            let ft_code=tbc20::replace_controller(pool_ft_code,receiver).map_err(|_|invalid("AMM receiver FT Code invalid"))?;
            outputs.ft(&ft_code,&pool_ft_tape.extension,slots(&[(2,q.ft_a_decrement_raw)]))?;
            let burn_controller=[0x75,0x9d,0x66,0x77,0x09,0x1e,0x97,0x3b,0x9e,0x9d,0x99,0xf1,0x9c,0x68,0xfb,0xf4,0x3e,0x3f,0x05,0xf9,0];
            let burn_code=amm_lp::replace_controller(user_code.unwrap(),burn_controller).map_err(|_|invalid("AMM LP burn Code invalid"))?;
            outputs.lp(&burn_code,config,slots(&[(1,q.ft_lp_burn_raw)]),0)?;
            outputs.ft(pool_ft_code,&pool_ft_tape.extension,slots(&[(2,next.ft_a_amount)]))?;
            let change=narrow(balance-q.ft_lp_burn_raw as u128)?;if change>0{outputs.lp(user_code.unwrap(),config,slots(&[(1,change)]),lp.lock_time)?;}
        },
        Quote::Buy(q)=>{
            let code=tbc20::replace_controller(pool_ft_code,receiver).map_err(|_|invalid("AMM receiver FT Code invalid"))?;
            outputs.ft(&code,&pool_ft_tape.extension,slots(&[(2,q.ft_out_raw)]))?;outputs.service(config,q.fees.service_fee_paid_sat);
            outputs.ft(pool_ft_code,&pool_ft_tape.extension,slots(&[(2,next.ft_a_amount)]))?;
        },
        Quote::Sell(q)=>{
            let user_tape=user_ft.as_ref().unwrap();if user_tape.balance<q.input_ft_raw as u128{return Err(insufficient("AMM selected FT insufficient"));}
            outputs.payment(&options.receiver_hash,q.tbc_out_sat);outputs.service(config,q.fees.service_fee_paid_sat);
            outputs.ft(pool_ft_code,&pool_ft_tape.extension,slots(&[(1,q.input_ft_raw),(2,state.ft_a_amount)]))?;
            let change=narrow(user_tape.balance-q.input_ft_raw as u128)?;if change>0{outputs.ft(user_code.unwrap(),&user_tape.extension,slots(&[(1,change)]))?;}
        },
    }
    let funding=&options.funding;check_transaction(funding.parent)?;let funding_output=output(funding.parent,funding.vout)?;
    if funding_output.satoshis==0||funding_output.script_pubkey!=Script::p2pkh(&funding.public_key.hash160()){return Err(invalid("AMM funding must be exact owner P2PKH"));}
    let lock_time=match options.action{Action::Remove{lock_time,..}=>lock_time.unwrap_or(user_lp.as_ref().unwrap().lock_time),_=>0};
    if let Some(lp)=&user_lp{lp.verify_input_lock(if config.timelocked(){0xfffffffe}else{tbc_sdk::DEFAULT_SEQUENCE},lock_time).map_err(|_|invalid("AMM LP input lock unsatisfied"))?;}
    let mut evidence=vec![];let mut ids=BTreeMap::new();let mut inputs=vec![];let mut recipes=vec![];
    let pool_source=intern(pool.transaction(),&mut evidence,&mut ids);let ancestor=intern(options.pool_ancestor,&mut evidence,&mut ids);
    let auxiliary=if quote.operation()==3{vec![funding.parent,pool_ft.parent]}else{vec![user.unwrap().parent,pool_ft.parent,funding.parent]};
    let auxiliary_parents=auxiliary.iter().map(|tx|intern(tx,&mut evidence,&mut ids)).collect();
    inputs.push(PlannedInput{previous_transaction_id:pool.transaction().txid().to_string(),previous_output_index:0,
        previous_output_script:hex(pool.transaction().outputs[0].script_pubkey.as_bytes()),previous_output_satoshis:state.pool_value,
        sequence:tbc_sdk::DEFAULT_SEQUENCE,signer:public_context(options.controller_public_key.unwrap_or(funding.public_key)),
        unlocking_script:amm_pool_unlocking_descriptor(AmmPoolUnlockRecipe{parent:pool_source.clone(),ancestor,auxiliary_parents,operation:quote.operation(),pool_code_hash:hex(pool.pool_hash())})?});
    let funding_input=PlannedInput{previous_transaction_id:funding.parent.txid().to_string(),previous_output_index:funding.vout,
        previous_output_script:hex(funding_output.script_pubkey.as_bytes()),previous_output_satoshis:funding_output.satoshis,
        sequence:tbc_sdk::DEFAULT_SEQUENCE,signer:public_context(funding.public_key),unlocking_script:String::new()};
    if quote.operation()==3{inputs.push(funding_input.clone());}
    let assets:Vec<_>=user.into_iter().map(|u|(u,quote.operation()==2,false)).chain(std::iter::once((pool_ft,false,true))).collect();
    for(asset,is_lp,pool_owned)in assets{
        let point=OutPoint{txid:asset.parent.txid(),vout:asset.vout};
        let dependencies=if is_lp{amm_lp_proof::inspect_parent(&asset.parent.serialize(),&point,None)?.dependencies().to_vec()}
            else{tbc20_material::inspect_parent(&asset.parent.serialize(),&point,None)?.dependencies().iter().map(|d|d.outpoint.clone()).collect()};
        if asset.ancestors.len()>6{return Err(invalid("AMM token ancestor set exceeds six slots"));}
        let mut supplied=BTreeMap::new();for tx in asset.ancestors{check_transaction(tx)?;if supplied.insert(tx.txid().to_string(),*tx).is_some(){return Err(invalid("AMM duplicate token ancestor"));}}
        let required:BTreeSet<_>=dependencies.iter().map(|p|p.txid.to_string()).collect();
        if required!=supplied.keys().cloned().collect(){return Err(invalid("AMM requires exactly the selected token direct ancestors"));}
        let parent=intern(asset.parent,&mut evidence,&mut ids);
        let proof_references=dependencies.iter().map(|p|ProofReference{source:intern(supplied[&p.txid.to_string()],&mut evidence,&mut ids),output_index:p.vout}).collect();
        recipes.push((inputs.len(),is_lp,Tbc20UnlockRecipe{parent,proof_references,output_groups:vec![],contract_controller:pool_owned.then(||Tbc20ContractControllerReference{source:pool_source.clone(),current_input_index:0})}));
        inputs.push(PlannedInput{previous_transaction_id:point.txid.to_string(),previous_output_index:point.vout,
            previous_output_script:hex(output(asset.parent,asset.vout)?.script_pubkey.as_bytes()),previous_output_satoshis:500,
            sequence:if is_lp&&config.timelocked(){0xfffffffe}else{tbc_sdk::DEFAULT_SEQUENCE},signer:public_context(asset.public_key),unlocking_script:String::new()});
    }
    if quote.operation()!=3{inputs.push(funding_input);}
    let mut points=BTreeSet::new();let total=inputs.iter().try_fold(0u64,|sum,i|{
        if !points.insert((&i.previous_transaction_id,i.previous_output_index)){return Err(invalid("AMM duplicate input"));}
        sum.checked_add(i.previous_output_satoshis).filter(|n|*n<=MAX_SAFE).ok_or_else(||invalid("AMM native inputs exceed safe range"))
    })?;
    let spent=outputs.items.iter().try_fold(0u64,|sum,o|sum.checked_add(o.satoshis).filter(|n|*n<=MAX_SAFE).ok_or_else(||invalid("AMM native outputs exceed safe range")))?;
    let available=total.checked_sub(spent).ok_or_else(||insufficient("AMM funding insufficient for business outputs"))?;
    let make_plan=|with_change:bool|{
        let mut items=outputs.items.clone();let mut groups=outputs.groups.clone();let mut inputs=inputs.clone();
        if with_change{groups.push(Tbc20OutputGroup{code_vout:items.len() as u32,tape_vout:None});items.push(PlannedOutput{satoshis:options.fee_policy.change_dust,locking_script:hex(Script::p2pkh(&options.change_hash).as_bytes())});}
        for(index,is_lp,recipe)in &recipes{let mut recipe=recipe.clone();recipe.output_groups=groups.clone();inputs[*index].unlocking_script=if *is_lp{amm_lp_unlocking_descriptor(recipe)}else{tbc20_unlocking_descriptor(recipe)}?;}
        Ok(UnsignedPlan{evidence_table:evidence.clone(),transactions:vec![PlannedTransaction{transaction_id:quote.name().into(),role:quote.name().into(),stage:0,depends_on:vec![],version:10,lock_time,inputs,outputs:items}]})
    };
    let funded=amm_transaction::finish_plan(make_plan,available,options.fee_policy,options.max_fee)?;
    Ok(BusinessPlan{funded,quote,consumed_snapshot_hash:*pool.snapshot_hash()})
}
