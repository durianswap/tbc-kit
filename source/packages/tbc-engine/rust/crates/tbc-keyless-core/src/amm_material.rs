//! JSON adapter over the same new AMM/LP codecs used by the keyless planner.
//! It provides local index keys/material requirements, never network authority.
use std::collections::{BTreeMap, BTreeSet};
use serde::Deserialize;
use serde_json::{Value, json};
use tbc_sdk::{Transaction, OutPoint, PublicKey, hash};
use tbc_engine_core::protocols::{amm_material, amm_state, amm_code::Authorization,
    amm_lp, amm_lp_proof, amm_math, amm_profile, historical_pool, pool_origin, tbc20, tbc20_material};

#[derive(Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct Raw { txid: String, raw_transaction: String }
#[derive(Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct IndexedPool { ft_code_script:String,ft_tape_script:String }
#[derive(Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct Selected { txid: String, vout: u32, kind: Kind }
#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all="lowercase")]
enum Kind { Ft, Lp }
#[derive(Deserialize)]
#[serde(tag="kind", rename_all="camelCase", rename_all_fields="camelCase", deny_unknown_fields)]
enum Action {
    AddTbc { amount: String, initial_ft_amount: Option<String> },
    AddFt { amount: String },
    Buy { amount: String },
    Sell { amount: String },
    Remove { amount: String },
}
#[derive(Deserialize)]
#[serde(tag="phase", rename_all="camelCase", rename_all_fields="camelCase", deny_unknown_fields)]
enum Request {
    IdentifyPoolOrigin { pool: Raw },
    IdentifyPoolState { pool: Raw },
    InspectPool { pool: Raw },
    Quote { pool: Raw, action: Action },
    Describe { pool_genesis: Option<Raw>, ft_genesis: Option<Raw>, indexed_pool:Option<IndexedPool>,pool_contract_id:Option<String>, public_key: String, controller_public_key: Option<String>, current_pool: Option<Raw>, action: Option<Action> },
    InspectAssets { parents: Vec<Raw>, outputs: Vec<Selected> },
    InspectLpReceipt { pool_origin: Raw, transaction: Raw },
}
fn bytes(raw: &Raw) -> Result<Vec<u8>, String> {
    if raw.txid.len()!=64 || raw.raw_transaction.is_empty() || raw.raw_transaction.len()>2*1_048_576 {
        return Err("AMM material exceeds identity/byte bounds".into());
    }
    let bytes=hex::decode(&raw.raw_transaction).map_err(|_|"AMM material raw invalid")?;
    if hex::encode(&bytes)!=raw.raw_transaction {return Err("AMM material must be canonical lowercase hex".into());}
    Ok(bytes)
}
fn transaction(raw: &Raw) -> Result<Transaction, String> {
    let bytes=bytes(raw)?;
    let tx=Transaction::from_bytes(&bytes).map_err(|_|"AMM transaction malformed")?;
    if tx.serialize()!=bytes || tx.txid().to_string()!=raw.txid {return Err("AMM transaction identity mismatch".into());}
    Ok(tx)
}
fn script_hash(script: &[u8]) -> String { let mut h=hash::sha256(script); h.reverse(); hex::encode(h) }
fn point(point: &OutPoint) -> Value { json!({"txid":point.txid.to_string(),"vout":point.vout}) }
fn public_key(value: &str) -> Result<PublicKey, String> {
    let bytes=hex::decode(value).map_err(|_|"AMM public key malformed")?;
    if bytes.len()!=33 || hex::encode(&bytes)!=value {return Err("AMM public key must be canonical compressed".into());}
    PublicKey::from_slice(&bytes).map_err(|_|"AMM public key invalid".into())
}

// A receipt is bound to a caller-selected Pool origin, not a current UTXO
// index or a supplied public key. Reuse planner/reviewer Code+Tape decoders;
// no ancestry fetch, spending authorization, maturity or chain-validity claim.
fn lp_receipt(origin: &Raw, receipt: &Raw) -> Result<Value, String> {
    let pool = transaction(origin)?;
    let tx = transaction(receipt)?;
    if tx.version != 10 || tx.inputs.is_empty() || tx.outputs.is_empty() {
        return Err("LP receipt transaction framing invalid".into());
    }
    let receipt_bytes = tx.serialize();
    let profile = pool_origin::inspect_pool_origin(&pool.txid(), &pool.serialize())?;
    let current = if profile == pool_origin::PoolProfile::Current {
        Some(amm_material::inspect_pool(&pool).map_err(|e|e.message)?)
    } else { None };
    let historical = if current.is_none() {
        Some(historical_pool::inspect_historical_pool_auto(&pool.outputs[0], pool.outputs.get(1))?
            .ok_or("Historical LP Pool origin absent")?)
    } else { None };
    let mut outputs = Vec::new();
    for (vout, output) in tx.outputs.iter().enumerate() {
        let script = output.script_pubkey.as_bytes();
        if amm_lp::parse_code(script).is_ok() {
            let point = OutPoint { txid: tx.txid(), vout: vout as u32 };
            let parsed = amm_lp_proof::inspect_parent(&receipt_bytes, &point, None).map_err(|e|e.message)?;
            let matches = current.as_ref().is_some_and(|pool| {
                parsed.code().pool_code_hash == pool.code_hash
                    && parsed.code().tape_size == pool.code.ft_tape_size
                    && parsed.code().timelocked == pool.tape.with_lp_locktime
                    && parsed.identity()[..32] == pool.tape.ft_lp_partial_hash
                    && script.len() == pool.tape.ft_lp_code_size as usize
            });
            outputs.push(json!({"codeVout":vout,"tapeVout":vout+1,"generation":"current",
                "balanceRaw":parsed.tape().balance().map_err(|_|"LP amount invalid")?.to_string(),
                "controller":hex::encode(parsed.code().controller),"lockTime":parsed.tape().lock_time,
                "contractCodeMatches":matches}));
        } else if let Some(parsed) = historical_pool::inspect_historical_ftlp_auto(output, tx.outputs.get(vout+1))? {
            let matches = historical.as_ref().is_some_and(|pool| {
                parsed.identity.pool_code_hash == pool.identity.code_hash
                    && parsed.identity.partial_hash.as_slice() == pool.state.ft_lp_partial_hash
                    && parsed.lock_time.is_some() == pool.state.ftlp_lock_time_enabled
            });
            outputs.push(json!({"codeVout":vout,"tapeVout":vout+1,"generation":"historical",
                "balanceRaw":parsed.amount.to_string(),"controller":hex::encode(parsed.controller),
                "lockTime":parsed.lock_time.unwrap_or(0),"contractCodeMatches":matches}));
        }
    }
    Ok(json!({"txid":receipt.txid,"poolContractId":origin.txid,
        "generation":if current.is_some(){"current"}else{"historical"},
        "verification":"pool-origin-and-output-structure","outputs":outputs}))
}
fn amount(value:&str)->Result<u64,String>{
    if value.is_empty()||!value.bytes().all(|b|b.is_ascii_digit())||(value.len()>1&&value.starts_with('0')){return Err("AMM amount must be a canonical atomic integer".into());}
    let n=value.parse::<u64>().map_err(|_|"AMM amount exceeds range")?;
    if n==0||n>i64::MAX as u64{return Err("AMM amount must be positive signed-63-bit".into());}Ok(n)
}
fn requirements(state:amm_math::State,action:Action,policy:&amm_profile::FeePolicy)->Result<Value,String>{
    let(holder,native,wanted)=match action{
        Action::AddTbc{amount:a,initial_ft_amount}=>{
            let q=amm_math::quote_add(state,amm_math::AddBudget::Tbc{amount:amount(&a)?,first_ft:initial_ft_amount.as_deref().map(amount).transpose()?}).map_err(|e|e.to_string())?;
            (Some("ft"),q.tbc_increment_sat,q.ft_a_increment_raw)
        },
        Action::AddFt{amount:a}=>{
            let q=amm_math::quote_add(state,amm_math::AddBudget::Ft(amount(&a)?)).map_err(|e|e.to_string())?;
            (Some("ft"),q.tbc_increment_sat,q.ft_a_increment_raw)
        },
        Action::Buy{amount:a}=>{let n=amount(&a)?;policy.quote_buy(state,n,0).map_err(|e|e.to_string())?;(None,n,0)},
        Action::Sell{amount:a}=>{let n=amount(&a)?;policy.quote_sell(state,n,0).map_err(|e|e.to_string())?;(Some("ft"),0,n)},
        Action::Remove{amount:a}=>{let n=amount(&a)?;amm_math::quote_remove(state,n).map_err(|e|e.to_string())?;(Some("lp"),0,n)},
    };
    Ok(json!({"holderKind":holder,"holderAmount":wanted.to_string(),"nativeAmount":native.to_string()}))
}
fn profile_fields(result:&mut Value,profile:&amm_profile::Profile)->Result<(),String>{
    profile.validate().map_err(|e|e.to_string())?;
    match &profile.fees {
        amm_profile::FeeTerms::Preset{lp_plan,service_fee_rate}=>{
            result["lpPlan"]=json!(lp_plan);result["serviceFeeRate"]=json!(service_fee_rate);
        },
        amm_profile::FeeTerms::Explicit{rates,fee_address}=>{
            let mut policy=serde_json::to_value(rates).map_err(|_|"AMM fee fields invalid")?;
            policy["feeAddress"]=json!(fee_address);result["feePolicy"]=policy;
            result["serviceProviderTagHex"]=json!(hex::encode(profile.service_provider_tag.as_ref().unwrap()));
        },
    }Ok(())
}

// Quote records contain atomic amounts only (plus the first-add boolean).
// Serialize those integers as strings before crossing JS's 53-bit boundary.
fn quote_amounts<T:serde::Serialize>(quote:T)->Result<Value,String>{
    fn strings(value:&mut Value){match value{
        Value::Number(n)=>*value=Value::String(n.to_string()),
        Value::Object(fields)=>for v in fields.values_mut(){strings(v)},
        Value::Array(items)=>for v in items{strings(v)},
        _=>{},
    }}
    let mut value=serde_json::to_value(quote).map_err(|_|"AMM quote encoding failed")?;
    strings(&mut value);Ok(value)
}

pub fn inspect(request: &str) -> Result<String, String> {
    if request.len()>8*1_048_576 {return Err("AMM request exceeds local byte bound".into());}
    let request:Request=serde_json::from_str(request).map_err(|_|"Invalid AMM material request")?;
    let result=match request {
        Request::InspectLpReceipt{pool_origin,transaction}=>lp_receipt(&pool_origin,&transaction)?,
        Request::Quote{pool,action}=>{
            let tx=transaction(&pool)?;
            let p=amm_material::inspect_pool(&tx).map_err(|e|e.message)?;
            let state=amm_math::State{ft_lp_amount:p.tape.ft_lp_amount,ft_a_amount:p.tape.ft_a_amount,
                tbc_amount:p.tape.tbc_amount,pool_value:tx.outputs[0].satoshis};
            let policy=p.tape.fees.policy().map_err(|e|e.to_string())?;
            let (kind,quote)=match action{
                Action::AddTbc{amount:a,initial_ft_amount}=>("addTbc",quote_amounts(amm_math::quote_add(state,
                    amm_math::AddBudget::Tbc{amount:amount(&a)?,first_ft:initial_ft_amount.as_deref().map(amount).transpose()?}).map_err(|e|e.to_string())?)?),
                Action::AddFt{amount:a}=>("addFt",quote_amounts(amm_math::quote_add(state,amm_math::AddBudget::Ft(amount(&a)?)).map_err(|e|e.to_string())?)?),
                Action::Buy{amount:a}=>("buy",quote_amounts(policy.quote_buy(state,amount(&a)?,0).map_err(|e|e.to_string())?)?),
                Action::Sell{amount:a}=>("sell",quote_amounts(policy.quote_sell(state,amount(&a)?,0).map_err(|e|e.to_string())?)?),
                Action::Remove{amount:a}=>("remove",quote_amounts(amm_math::quote_remove(state,amount(&a)?).map_err(|e|e.to_string())?)?),
            };
            // This authenticates bytes/template, not unspentness, provenance or
            // authorization. Transaction planning still performs its full checks.
            json!({"standardId":"tbc-amm","basis":"local-pool-transaction","kind":kind,
                "poolOutpoint":{"txid":pool.txid,"vout":0},"templateRevision":p.template_revision,
                "poolCodeHash":hex::encode(p.code_hash),"ftContractId":hex::encode(p.tape.ft_a_contract_id),
                "feePolicy":{"totalFeeBps":policy.total_fee_bps(),"lpFeeBps":policy.lp_fee_bps(),"serviceFeeAddress":policy.fee_address()},
                "quote":quote})
        },
        Request::IdentifyPoolOrigin{pool}=>{
            use tbc_engine_core::protocols::pool_origin::{inspect_pool_origin,PoolProfile};
            let id=pool.txid.parse().map_err(|_|"Pool origin ID invalid")?;
            let profile=inspect_pool_origin(&id,&bytes(&pool)?)?;
            json!({"family":"amm","generation":if profile==PoolProfile::Current{"current"}else{"historical"},
                "verification":"origin-template","assetIdentityVerified":false})
        },
        Request::IdentifyPoolState{pool}=>{
            let tx=transaction(&pool)?;
            let profile=pool_origin::inspect_pool_profile(&tx)?;
            json!({"family":"amm","generation":if profile==pool_origin::PoolProfile::Current{"current"}else{"historical"},
                "verification":"state-template","assetIdentityVerified":false})
        },
        Request::InspectPool{pool}=>{
            let tx=transaction(&pool)?;
            let p=amm_material::inspect_pool(&tx).map_err(|e|e.message)?;
            let controllers=match &p.code.authorization{Authorization::Public=>vec![],Authorization::Controller(h)=>h.iter().map(hex::encode).collect::<Vec<_>>()};
            let profile=amm_profile::Profile::from_parts(&p.code,&p.tape).map_err(|e|e.to_string())?;
            let mut result=json!({"standardId":"tbc-amm","protocolVersion":"pool3","templateRevision":p.template_revision,
                "txid":pool.txid,"poolCodeHash":hex::encode(p.code_hash),"ftContractId":hex::encode(p.tape.ft_a_contract_id),
                "lpTimelock":p.tape.with_lp_locktime,
                "controllers":controllers,"tapeSize":p.code.ft_tape_size,"parentOutpoint":point(&tx.inputs[0].previous_output),
                "state":{"lpAmount":p.tape.ft_lp_amount.to_string(),"ftAmount":p.tape.ft_a_amount.to_string(),"tbcAmount":p.tape.tbc_amount.to_string(),"poolValue":tx.outputs[0].satoshis.to_string()}});
            profile_fields(&mut result,&profile)?;result
        },
        Request::Describe{pool_genesis,ft_genesis,indexed_pool,pool_contract_id,public_key:owner_key,controller_public_key,current_pool,action}=>{
            let indexed_path=indexed_pool.is_some();
            let key=public_key(&owner_key)?;
            let controller_key=controller_public_key.as_deref().map(public_key).transpose()?;
            let (pool_id,genesis,anchor)=if let Some(indexed)=indexed_pool{
                if pool_genesis.is_some()||ft_genesis.is_some(){return Err("Indexed Pool cannot also supply genesis anchors".into());}
                let id=pool_contract_id.ok_or("Indexed Pool ID missing")?;
                let parsed:tbc_sdk::Txid=id.parse().map_err(|_|"Indexed Pool ID invalid")?;
                if parsed.to_string()!=id{return Err("Indexed Pool ID noncanonical".into());}
                let current=transaction(current_pool.as_ref().ok_or("Indexed Pool needs current raw")?)?;
                let scripts=[&indexed.ft_code_script,&indexed.ft_tape_script].map(|s|{
                    if s.is_empty()||s.len()>131072{return Err("Indexed FT script exceeds bounds");}
                    let bytes=hex::decode(s).map_err(|_|"Indexed FT hex invalid")?;
                    if hex::encode(&bytes)!=*s{return Err("Indexed FT hex noncanonical");}Ok(bytes)
                });
                let [code,tape]=scripts;let anchor=amm_material::bind_indexed(&current,code?,tape?).map_err(|e|e.message)?;
                (id,current,anchor)
            }else{
                if pool_contract_id.is_some(){return Err("Unexpected indexed Pool ID".into());}
                let raw=pool_genesis.ok_or("Pool genesis missing")?;
                let genesis=transaction(&raw)?;let ft=transaction(&ft_genesis.ok_or("FT genesis missing")?)?;
                let anchor=amm_material::bind_genesis(&genesis,&ft,&key).map_err(|e|e.message)?;
                (raw.txid,genesis,anchor)
            };
            let config=&anchor.config;let owner=amm_state::owner_controller(&key);
            let lp=config.lp_code(anchor.code_hash,owner).map_err(|e|e.message)?;
            let owner_ft=tbc20::replace_controller(config.ft_code(),owner).map_err(|_|"AMM owner FT script invalid")?;
            let pool_ft=tbc20::replace_controller(config.ft_code(),amm_state::contract_controller(&anchor.code_hash)).map_err(|_|"AMM Pool FT script invalid")?;
            let current=current_pool.as_ref().map(transaction).transpose()?;
            let state=config.read_pool(current.as_ref().unwrap_or(&genesis),&anchor.code_hash).map_err(|e|e.message)?;
            // Required contract role, derived from bound Code, not API metadata
            // or a permission grant. The planner still authorizes every signer.
            let authorization=match config.authorization() {
                Authorization::Public=>json!({"kind":"public"}),
                Authorization::Controller(hashes)=>json!({"kind":"controller",
                    "controllerHashes":hashes.iter().map(hex::encode).collect::<Vec<_>>(),
                    "accountMatches":hashes.contains(&controller_key.as_ref().unwrap_or(&key).hash160())}),
            };
            let mut result=json!({"standardId":"tbc-amm","protocolVersion":"pool3","templateRevision":anchor.template_revision,
                "poolContractId":pool_id,"ftContractId":config.ft_id().to_string(),"poolCodeHash":hex::encode(anchor.code_hash),
                "lpTimelock":config.timelocked(),
                "authorization":authorization,
                "poolCodeScript":hex::encode(genesis.outputs[0].script_pubkey.as_bytes()),
                "ownerLpScript":hex::encode(&lp),"ownerLpScriptHash":script_hash(&lp),
                "ownerFtScript":hex::encode(&owner_ft),"ownerFtScriptHash":script_hash(&owner_ft),
                "ownerCombineScript":hex::encode(owner),"poolCombineScript":hex::encode(amm_state::contract_controller(&anchor.code_hash)),
                "poolFtScript":hex::encode(&pool_ft),"poolFtScriptHash":script_hash(&pool_ft),
                "snapshotHash":hex::encode(state.snapshot_hash()),"currentOutpoint":{"txid":state.transaction().txid().to_string(),"vout":0},
                "state":{"lpAmount":state.math().ft_lp_amount.to_string(),"ftAmount":state.math().ft_a_amount.to_string(),
                    "tbcAmount":state.math().tbc_amount.to_string(),"poolValue":state.math().pool_value.to_string()}});
            profile_fields(&mut result,config.profile())?;
            if !indexed_path{result["genesisParentOutpoint"]=point(&genesis.inputs[0].previous_output);}
            if let Some(action)=action{
                if current_pool.is_none(){return Err("AMM business requirements need an explicit current Pool".into());}
                result["requirements"]=requirements(state.math(),action,config.fee_policy())?;
            }result
        },
        Request::InspectAssets{parents,outputs}=>{
            if parents.is_empty() || parents.len()>32 || outputs.is_empty() || outputs.len()>32 {return Err("AMM asset inspection exceeds count bounds".into());}
            let mut raw=BTreeMap::new();for p in parents{let b=bytes(&p)?;if raw.insert(p.txid,b).is_some(){return Err("AMM repeated parent".into());}}
            let mut seen=BTreeSet::new();let mut items=vec![];
            for output in outputs {
                if !seen.insert((output.txid.clone(),output.vout)){return Err("AMM repeated selected output".into());}
                let point=OutPoint{txid:output.txid.parse().map_err(|_|"AMM selected txid invalid")?,vout:output.vout};
                if point.txid.to_string()!=output.txid{return Err("AMM selected txid noncanonical".into());}
                let b=raw.get(&output.txid).ok_or("AMM selected parent missing")?;
                let(kind,amount,lock,controller,identity,script,deps)=match output.kind {
                    Kind::Ft=>{let p=tbc20_material::inspect_parent(b,&point,None).map_err(|e|e.message)?;
                        ("ft",p.tape().balance,None,p.code().controller,hex::encode(p.identity()),
                            hex::encode(p.transaction().outputs[output.vout as usize].script_pubkey.as_bytes()),
                            p.dependencies().iter().map(|d|d.outpoint.clone()).collect::<Vec<_>>())},
                    Kind::Lp=>{let p=amm_lp_proof::inspect_parent(b,&point,None).map_err(|e|e.message)?;
                        ("lp",p.tape().balance().map_err(|_|"AMM LP balance invalid")?,Some(p.tape().lock_time),p.code().controller,
                            hex::encode(p.identity()),hex::encode(p.transaction().outputs[output.vout as usize].script_pubkey.as_bytes()),p.dependencies().to_vec())},
                };
                let dependencies:BTreeSet<_>=deps.iter().map(|p|(p.txid.to_string(),p.vout)).collect();
                items.push(json!({"kind":kind,"txid":output.txid,"vout":output.vout,"balance":amount.to_string(),
                    "lockTime":lock,"controller":hex::encode(controller),"identity":identity,"scriptPubKey":script,
                    "dependencies":dependencies.into_iter().map(|(txid,vout)|json!({"txid":txid,"vout":vout})).collect::<Vec<_>>() }));
            }json!({"items":items})
        },
    };
    serde_json::to_string(&result).map_err(|_|"AMM result encoding failed".into())
}
