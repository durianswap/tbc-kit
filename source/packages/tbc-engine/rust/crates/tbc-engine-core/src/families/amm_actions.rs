//! Public Pool3 action mapping. Shared keyless business builder, bound current
//! state and minimum direct material; no transport, wallet UI or signer secrets.
use std::{collections::BTreeSet,rc::Rc};
use tbc_sdk::{Address,PublicKey,Transaction,OutPoint};
use crate::{EngineError,ErrorCode,model::{CanonicalRequest,WalletMaterial,PlannedTransfer,AssetFlow,WalletUtxo as Utxo,error},
    normalize::{hex,parse_decimal_u64,parse_decimal_u128,validate_request},signing::PublicSigningContext,
    protocols::{amm::MAX_AMOUNT,amm_code::Authorization,amm_math::{self,AddBudget},amm_business::{self,Action,Quote},amm_batch,amm_state::PoolSnapshot,amm_lp_proof,tbc20_material}};
use super::{amm::{self,Transactions},ft::{decode_hex,validate_material_identity,funding_candidates},tbc20::{permitted,max_fee,finish}};
fn invalid(s:&str)->EngineError{error(ErrorCode::InvalidInput,s,"request.intent")}
fn missing(s:&str)->EngineError{error(ErrorCode::MissingMaterial,s,"snapshot.payload")}
fn number(s:Option<&str>,name:&str,positive:bool)->Result<u64,EngineError>{
    let value=parse_decimal_u64(s.ok_or_else(||invalid(&format!("AMM {name} required")))?,name)?;
    if value>MAX_AMOUNT||(positive&&value==0){return Err(invalid("AMM atomic amount outside required range"));}Ok(value)
}
pub(crate) fn validate_request_fields(request:&CanonicalRequest)->Result<(),EngineError>{
    let i=&request.intent;let fields=serde_json::to_value(i).map_err(|_|invalid("AMM action encoding invalid"))?;
    let allowed:&[&str]=match i.intent_type.as_str(){
        "tbc-amm-add-liquidity"=>&["type","version","poolContractId","budgetAsset","amount","initialFtAmount","minimumLpAmount","maximumTbcAmount","maximumFtAmount","lockTime","receiver","poolStateHash"],
        "tbc-amm-remove-liquidity"=>&["type","version","poolContractId","lpAmount","minimumTbcAmount","minimumFtAmount","receiver","poolStateHash"],
        "tbc-amm-swap"=>&["type","version","poolContractId","direction","amount","minimumOutput","receiver","poolStateHash"],
        _=>return Err(invalid("unsupported AMM action")),
    };
    if fields.as_object().unwrap().keys().any(|k|!allowed.contains(&k.as_str())){return Err(invalid("AMM action contains unrelated fields"));}
    let id=i.pool_contract_id.as_deref().ok_or_else(||invalid("AMM Pool ID required"))?;
    let hash32=|v:&str|v.len()==64&&v.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b));
    if !hash32(id)||i.pool_state_hash.as_deref().is_some_and(|v|!hash32(v)){return Err(invalid("AMM ID/state hash must be canonical 32-byte hex"));}
    if let Some(receiver)=&i.receiver{Address::from_string(receiver).map_err(|_|invalid("AMM receiver invalid"))?;}
    match i.intent_type.as_str(){
        "tbc-amm-swap"=>{if !matches!(i.direction.as_deref(),Some("tbc-to-ft"|"ft-to-tbc")){return Err(invalid("AMM swap direction invalid"));}
            number(i.amount.as_deref(),"amount",true)?;number(i.minimum_output.as_deref(),"minimumOutput",false)?;},
        "tbc-amm-add-liquidity"=>{if !matches!(i.budget_asset.as_deref(),Some("tbc"|"ft")){return Err(invalid("AMM budgetAsset invalid"));}
            number(i.amount.as_deref(),"amount",true)?;number(i.minimum_lp_amount.as_deref(),"minimumLpAmount",false)?;
            for(name,value)in [("initialFtAmount",&i.initial_ft_amount),("maximumTbcAmount",&i.maximum_tbc_amount),("maximumFtAmount",&i.maximum_ft_amount)]{if let Some(v)=value{number(Some(v),name,true)?;}}
            if i.initial_ft_amount.is_some()&&i.budget_asset.as_deref()!=Some("tbc"){return Err(invalid("AMM initial FT amount requires TBC budget"));}
            if let Some(lock)=&i.lock_time{let n=parse_decimal_u64(lock,"lockTime")?;if n>u32::MAX as u64{return Err(invalid("AMM LP lock exceeds uint32"));}}},
        _=>{number(i.lp_amount.as_deref(),"lpAmount",true)?;number(i.minimum_ft_amount.as_deref(),"minimumFtAmount",false)?;number(i.minimum_tbc_amount.as_deref(),"minimumTbcAmount",false)?;}
    }Ok(())
}
fn action(request:&CanonicalRequest)->Result<Action,EngineError>{
    let i=&request.intent;let n=|v:&Option<String>|number(v.as_deref(),"amount",false);let optional=|v:&Option<String>|v.as_deref().map(|s|number(Some(s),"amount",true)).transpose();
    Ok(match i.intent_type.as_str(){
        "tbc-amm-add-liquidity"=>Action::Add{budget:if i.budget_asset.as_deref()==Some("tbc"){AddBudget::Tbc{amount:n(&i.amount)?,first_ft:optional(&i.initial_ft_amount)?}}else{AddBudget::Ft(n(&i.amount)?)},min_lp:n(&i.minimum_lp_amount)?,max_ft:optional(&i.maximum_ft_amount)?,max_tbc:optional(&i.maximum_tbc_amount)?,lp_lock_time:i.lock_time.as_deref().map(|s|parse_decimal_u64(s,"lockTime").map(|v|v as u32)).transpose()?},
        "tbc-amm-remove-liquidity"=>Action::Remove{burn:n(&i.lp_amount)?,min_ft:n(&i.minimum_ft_amount)?,min_tbc:n(&i.minimum_tbc_amount)?,lock_time:None},
        _=>if i.direction.as_deref()==Some("tbc-to-ft"){Action::Buy{input_tbc:n(&i.amount)?,min_ft:n(&i.minimum_output)?}}else{Action::Sell{input_ft:n(&i.amount)?,min_tbc:n(&i.minimum_output)?}},
    })
}
fn eligible<'a>(request:&CanonicalRequest,material:&'a WalletMaterial<'_>,class:&str,id:&str)->Result<Vec<&'a Utxo>,EngineError>{
    let min=parse_decimal_u64(&material.policy.payload.min_confirmations,"policy.payload.minConfirmations")?;
    let mut values=vec![];let mut seen=BTreeSet::new();
    for u in &material.snapshot.payload.utxos{
        if !seen.insert((&u.txid,u.vout)){return Err(amm::invalid("AMM repeats an input descriptor"));}
        if u.classification==class&&u.contract_id.as_deref()==Some(id)&&permitted(request,&u.txid,u.vout)
            &&crate::confirmations::meets_minimum(u.confirmations.as_deref(),min,"snapshot.payload.utxos.confirmations")?{values.push(u);}
    }values.sort_by(|a,b|(&a.txid,a.vout).cmp(&(&b.txid,b.vout)));Ok(values)
}
fn authenticate(u:&Utxo,parents:&mut Transactions<'_>)->Result<Rc<Transaction>,EngineError>{
    let tx=parents.get(&u.txid)?;let o=tx.outputs.get(u.vout as usize).ok_or_else(||amm::invalid("AMM descriptor output absent"))?;
    if o.satoshis.to_string()!=u.satoshis||hex(o.script_pubkey.as_bytes())!=u.script_pub_key{return Err(amm::invalid("AMM descriptor differs from canonical parent"));}Ok(tx)
}
fn ancestors(tx:&Transaction,vout:u32,lp:bool,parents:&mut Transactions<'_>)->Result<Vec<Rc<Transaction>>,EngineError>{
    let point=OutPoint{txid:tx.txid(),vout};
    let ids:BTreeSet<_>=if lp{amm_lp_proof::inspect_parent(&tx.serialize(),&point,None)?.dependencies().iter().map(|p|p.txid.to_string()).collect()}
        else{tbc20_material::inspect_parent(&tx.serialize(),&point,None)?.dependencies().iter().map(|d|d.outpoint.txid.to_string()).collect()};
    ids.iter().map(|id|parents.get(id)).collect()
}
fn check_limit(material:&WalletMaterial<'_>,scope:&str,id:Option<&str>,value:u128)->Result<(),EngineError>{
    let protocol=if scope.starts_with("lp-")||scope=="pool-state"{Some("pool3")}else if scope.starts_with("ft-"){Some("tbc20")}else{None};
    for l in &material.policy.payload.amount_limits{
        if l.scope==scope&&l.protocol_version.as_deref().is_none_or(|v|Some(v)==protocol)&&l.contract_id.as_deref().is_none_or(|v|Some(v)==id){
            let max=parse_decimal_u128(&l.maximum,"policy.payload.amountLimits.maximum")?;if max==0||value>max{return Err(invalid("AMM amount exceeds bound asset policy"));}
        }
    }Ok(())
}
pub(crate) fn plan_action(request:&CanonicalRequest,material:&WalletMaterial<'_>,signing:&PublicSigningContext)->Result<PlannedTransfer,EngineError>{
    validate_request(request)?;validate_material_identity(request,material)?;
    let policy=&material.policy.payload;if policy.chain_id!=request.chain_id||policy.fee_rate_sat_per_kb!="80"||policy.dust_threshold!="10"||policy.sighash_type!=65{return Err(invalid("AMM policy requires rate80/kB dust10 sighash65"));}
    // Reuse exact Pool3 family policy validation; business-specific limits below.
    super::lp::check_policy(material,request.intent.pool_contract_id.as_deref().unwrap(),0,std::iter::empty())?;
    let key=PublicKey::from_slice(&decode_hex(&signing.public_key,"snapshot.payload.account.publicKey")?).map_err(|_|invalid("AMM account key invalid"))?;
    let id=request.intent.pool_contract_id.as_deref().unwrap();let mut parents=Transactions::new(material)?;
    let anchor=amm::pool_anchor(id,material,&mut parents,&key)?;let config=&anchor.config;
    let record=material.snapshot.payload.contracts.iter().find(|r|r.contract_id==id).unwrap();
    let pool_points=eligible(request,material,"pool",id)?;let selected:Vec<_>=pool_points.into_iter().filter(|u|u.txid==record.current_outpoint.txid&&u.vout==record.current_outpoint.vout&&u.vout==0).collect();
    if selected.len()!=1{return Err(missing("AMM current Pool must be an eligible exact vout0 input"));}
    let pool_tx=authenticate(selected[0],&mut parents)?;let pool=config.read_pool(&pool_tx,&anchor.code_hash)?;
    if request.intent.pool_state_hash.as_deref().is_some_and(|h|h!=hex(pool.snapshot_hash())){return Err(invalid("AMM requested Pool state has changed"));}
    let ancestor=parents.get(&pool_tx.inputs[0].previous_output.txid.to_string())?;
    let roles=crate::signing_wire::SigningAccounts::resolve(request,&material.snapshot.payload)?;
    let selected_controller=roles.controller().map(|account| PublicKey::from_slice(&decode_hex(&account.public_key,"snapshot.payload.signingAccounts")?)
        .map_err(|_|invalid("AMM controller public key invalid"))).transpose()?;
    let controller=match config.authorization(){Authorization::Public=>{
        if selected_controller.is_some(){return Err(invalid("Public AMM Pool does not require a controller role"));}None
    },Authorization::Controller(hashes)=>{
        let selected=selected_controller.as_ref().unwrap_or(&key);
        if !hashes.contains(&selected.hash160()){return Err(error(ErrorCode::UnsupportedIntent,"AMM independent Pool controller needs an explicit shared signing role matching its Code","snapshot.payload.account"));}Some(selected)
    }};
    let pool_ft_points=eligible(request,material,"pool-ft",id)?;
    if pool_ft_points.len()!=1{return Err(missing("Pool3 requires one exact state-matching Pool FT input; arbitrary fragments cannot replace reserves"));}
    let pool_ft_point=pool_ft_points[0];let pool_ft_tx=authenticate(pool_ft_point,&mut parents)?;
    let pool_tape=config.validate_ft(&pool_ft_tx,pool_ft_point.vout as usize,&key,Some(&pool))?;
    asset_limits(material,"ft",&config.ft_id().to_string(),pool_tape.balance,pool_tape.amounts)?;
    let pool_ft_ancestors=ancestors(&pool_ft_tx,pool_ft_point.vout,false,&mut parents)?;let pool_refs:Vec<_>=pool_ft_ancestors.iter().map(Rc::as_ref).collect();
    let pool_ft=amm_business::AssetInput{parent:&pool_ft_tx,vout:pool_ft_point.vout,ancestors:&pool_refs,public_key:&key};
    let operation=action(request)?;let ft_id=config.ft_id().to_string();
    let needed=match operation{Action::Add{budget,..}=>amm_math::quote_add(pool.math(),budget).map_err(|_|invalid("AMM add budget invalid for bound state"))?.ft_a_increment_raw,Action::Sell{input_ft,..}=>input_ft,Action::Remove{burn,..}=>burn,_=>0};
    let mut users=vec![];
    if !matches!(operation,Action::Buy{..}){
        let lp=matches!(operation,Action::Remove{..});let candidates=eligible(request,material,if lp{"ftlp"}else{"ft"},if lp{id}else{&ft_id})?;
        let exact=request.constraints.as_ref().and_then(|c|c.input_outpoints.as_ref()).is_some();
        let mut available=vec![];
        for u in candidates{
            let tx=authenticate(u,&mut parents)?;
            let balance=if lp{let tape=config.validate_lp(&tx,u.vout as usize,&key,&pool)?;let lock=tape.lock_time;
                let mature=if lock==0{true}else if lock<500_000_000{u64::from(lock)<=parse_decimal_u64(&material.snapshot.payload.require_block()?.height,"snapshot.payload.block.height")?}else{
                    u64::from(lock)<parse_decimal_u64(material.snapshot.payload.require_block()?.median_time_past.as_deref().ok_or_else(||missing("AMM LP maturity requires trusted MTP"))?,"snapshot.payload.block.medianTimePast")?};
                if !mature{if exact{return Err(missing("AMM specified LP input is not mature"));}continue;}let balance=tape.balance().map_err(|_|invalid("LP balance invalid"))?;
                asset_limits(material,"lp",id,balance,tape.amounts)?;balance
            }else{let tape=config.validate_ft(&tx,u.vout as usize,&key,None)?;asset_limits(material,"ft",&ft_id,tape.balance,tape.amounts)?;tape.balance};
            available.push((tx,u.vout,balance));
            if !exact&&balance>=needed as u128{available=vec![available.pop().unwrap()];break;}
        }
        // Preserve the sufficient-single-input fast path; only consolidate when
        // needed or when the caller explicitly selects all these outpoints.
        let mut total=0u128;
        for(tx,vout,balance)in available{
            if !exact&&total>=needed as u128{break;}
            if users.len()==128{return Err(invalid("AMM holder input bound exceeded"));}
            total=total.checked_add(balance).ok_or_else(||invalid("AMM holder total overflow"))?;
            let proof=ancestors(&tx,vout,lp,&mut parents)?;users.push((tx,vout,proof));
        }
        if users.is_empty()||total<needed as u128{return Err(error(ErrorCode::InsufficientFunds,"AMM mature holder inputs are insufficient","snapshot.payload.utxos"));}
        check_limit(material,if lp{"lp-total"}else{"ft-total"},Some(if lp{id}else{&ft_id}),total)?;
    }
    let user_refs:Vec<Vec<_>>=users.iter().map(|(_,_,a)|a.iter().map(Rc::as_ref).collect()).collect();
    let user_assets:Vec<_>=users.iter().zip(&user_refs).map(|((tx,vout,_),refs)|amm_business::AssetInput{parent:tx,vout:*vout,ancestors:refs,public_key:&key}).collect();
    let receiver=request.intent.receiver.as_deref().unwrap_or(&request.from);let receiver_hash=Address::from_string(receiver).map_err(|_|invalid("AMM receiver invalid"))?.hash160();
    let mut funding=funding_candidates(material,signing)?;
    // As with historical Pool funding, Chain Data fetches the preferred parent
    // only. Fresh address-index alternatives are for the shared on-demand
    // P2PKH prerequisite, not direct AMM auxiliary proofs. Never use an
    // unproved parent directly or fetch every alternative on the hot path.
    funding.retain(|f|permitted(request,&f.txid,f.vout)&&material.snapshot.payload.parents.iter().any(|p|p.txid==f.txid));
    funding.sort_by(|a,b|b.satoshis.cmp(&a.satoshis).then_with(||a.txid.cmp(&b.txid)).then_with(||a.vout.cmp(&b.vout)));
    let maximum=max_fee(request)?;let mut cap=None;
    for f in funding{
        // Pool's auxiliary proof binds this parent; unlike plain P2PKH source,
        // its raw is required. Reuse the chosen parent's parsed cache entry.
        let funding_tx=parents.get(&f.txid)?;
        let built=amm_batch::build_batch_plan(amm_batch::BatchOptions{business:amm_business::Options{config,pool:&pool,pool_ancestor:&ancestor,pool_ft:&pool_ft,user_asset:None,funding:amm_business::Funding{parent:&funding_tx,vout:f.vout,public_key:&key},controller_public_key:controller,expected_snapshot_hash:Some(*pool.snapshot_hash()),action:operation,receiver_hash,change_hash:key.hash160(),fee_policy:crate::protocols::amm_transaction::MinerFeePolicy::default(),max_fee:maximum},user_inputs:&user_assets,max_transactions:policy.max_bundle_transactions as usize});
        let mut built=match built{Ok(v)=>v,Err(e)if e.code==ErrorCode::InsufficientFunds=>continue,Err(e)if e.code==ErrorCode::FeeCapExceeded=>{cap=Some(e);continue;},Err(e)=>return Err(e)};
        enforce_quote_limits(material,id,&ft_id,&pool,&built.quote)?;
        for tx in &built.unsigned_plan.transactions{output_limits(material,id,&ft_id,config.timelocked(),&tx.outputs)?;}
        let flows=flows(request,&ft_id,&built.quote);built.unsigned_plan.transactions.last_mut().ok_or_else(||invalid("empty AMM plan"))?.transaction_id=request.intent.intent_type.clone();
        return finish(request,material,built.unsigned_plan,built.fees,flows);
    }Err(cap.unwrap_or_else(||error(ErrorCode::InsufficientFunds,"AMM native funding insufficient","snapshot.payload.utxos")))
}
fn asset_limits(material:&WalletMaterial<'_>,kind:&str,id:&str,total:u128,slots:[u64;6])->Result<(),EngineError>{
    let(total_scope,slot_scope)=if kind=="ft"{("ft-total","ft-slot")}else{("lp-total","lp-slot")};
    check_limit(material,total_scope,Some(id),total)?;
    check_limit(material,slot_scope,Some(id),slots.into_iter().max().unwrap_or(0)as u128)
}
fn output_limits(material:&WalletMaterial<'_>,pool_id:&str,ft_id:&str,timelocked:bool,outputs:&[crate::signing::PlannedOutput])->Result<(),EngineError>{
    use crate::protocols::{amm_lp,tbc20};
    if !material.policy.payload.amount_limits.iter().any(|limit|matches!(limit.scope.as_str(),"ft-total"|"ft-slot"|"lp-total"|"lp-slot")){return Ok(());}
    // Only locally-built Code/Tape pairs; no ancestry traversal or API access.
    for pair in outputs.windows(2){
        if pair[0].satoshis!=500||pair[1].satoshis!=0{continue;}
        let code=decode_hex(&pair[0].locking_script,"plan.outputs.lockingScript")?;
        let tape=decode_hex(&pair[1].locking_script,"plan.outputs.lockingScript")?;
        if tbc20::parse_code(&code).is_ok(){
            let parsed=tbc20::parse_tape(&tape).map_err(|_|invalid("AMM generated FT Tape invalid"))?;
            asset_limits(material,"ft",ft_id,parsed.balance,parsed.amounts)?;
        }else if let Ok(descriptor)=amm_lp::parse_code(&code){
            let parsed=amm_lp::Tape::decode(&tape,timelocked,Some(descriptor.tape_size)).map_err(|_|invalid("AMM generated LP Tape invalid"))?;
            asset_limits(material,"lp",pool_id,parsed.balance().map_err(|_|invalid("AMM generated LP balance invalid"))?,parsed.amounts)?;
        }
    }Ok(())
}
fn enforce_quote_limits(material:&WalletMaterial<'_>,pool_id:&str,ft_id:&str,pool:&PoolSnapshot<'_>,q:&Quote)->Result<(),EngineError>{
    let next=q.next_state();check_limit(material,"pool-state",Some(pool_id),pool.math().pool_value.max(next.pool_value)as u128)?;
    check_limit(material,"ft-total",Some(ft_id),pool.math().ft_a_amount.max(next.ft_a_amount)as u128)?;
    let(ft,lp,native)=match q{Quote::Add(q)=>(q.ft_a_increment_raw,q.ft_lp_increment_raw,q.tbc_increment_sat),Quote::Remove(q)=>(q.ft_a_decrement_raw,q.ft_lp_burn_raw,q.pool_value_decrement_sat),Quote::Buy(q)=>(q.ft_out_raw,0,q.input_tbc_sat),Quote::Sell(q)=>(q.input_ft_raw,0,q.tbc_out_sat)};
    check_limit(material,"ft-slot",Some(ft_id),ft as u128)?;check_limit(material,"lp-slot",Some(pool_id),lp as u128)?;check_limit(material,"lp-total",Some(pool_id),lp as u128)?;check_limit(material,"native",None,native as u128)
}
fn flows(request:&CanonicalRequest,ft_id:&str,q:&Quote)->Vec<AssetFlow>{
    let pool_id=request.intent.pool_contract_id.as_deref().unwrap();let receiver=request.intent.receiver.as_deref().unwrap_or(&request.from);
    let flow=|kind:&str,direction:&str,amount:u64,id:Option<&str>|AssetFlow{kind:kind.into(),direction:direction.into(),amount:amount.to_string(),contract_id:id.map(str::to_owned),from:request.from.clone(),to:if direction=="receive"||direction=="mint"{Some(receiver.into())}else{None}};
    match q{
        Quote::Add(q)=>vec![flow("native","send",q.tbc_increment_sat,None),flow("ft","send",q.ft_a_increment_raw,Some(ft_id)),flow("lp","mint",q.ft_lp_increment_raw,Some(pool_id))],
        Quote::Remove(q)=>vec![flow("lp","burn",q.ft_lp_burn_raw,Some(pool_id)),flow("native","receive",q.pool_value_decrement_sat,None),flow("ft","receive",q.ft_a_decrement_raw,Some(ft_id))],
        Quote::Buy(q)=>vec![flow("native","send",q.input_tbc_sat,None),flow("ft","receive",q.ft_out_raw,Some(ft_id))],
        Quote::Sell(q)=>vec![flow("ft","send",q.input_ft_raw,Some(ft_id)),flow("native","receive",q.tbc_out_sat,None)],
    }
}
