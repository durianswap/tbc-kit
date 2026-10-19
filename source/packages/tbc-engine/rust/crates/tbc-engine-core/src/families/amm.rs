//! Public new Pool identity. API pool ID is the genesis txid, not Code hash.
//! Immutable anchors are separate from current spendability and pool reserves.
use std::{collections::BTreeMap,rc::Rc};
use tbc_sdk::{Transaction,PublicKey,hash};
use crate::{EngineError,ErrorCode,model::{WalletMaterial,error},normalize::hex,
    protocols::{amm_profile::{self,Tape},amm_code::Authorization,amm_state::PoolConfig,tbc20_proof::check_transaction}};
use super::ft::decode_hex;
use crate::{model::{CanonicalRequest,PlannedTransfer,AssetFlow},signing::PublicSigningContext,normalize::{parse_decimal_u64,validate_request}};
use super::{ft::{validate_material_identity,funding_candidates},tbc20::{Parents,trusted_genesis_id,permitted,max_fee,finish}};
pub(crate) fn invalid(message:&str)->EngineError{error(ErrorCode::InvalidAncestry,message,"snapshot.payload")}
pub(crate) struct Transactions<'a>{raw:BTreeMap<&'a str,&'a str>,parsed:BTreeMap<String,Rc<Transaction>>}
impl<'a> Transactions<'a>{
    pub(crate) fn new(material:&'a WalletMaterial<'_>)->Result<Self,EngineError>{
        let mut raw=BTreeMap::new();for p in &material.snapshot.payload.parents{if raw.insert(p.txid.as_str(),p.raw_transaction.as_str()).is_some(){return Err(invalid("AMM material repeats a parent"));}}
        Ok(Self{raw,parsed:BTreeMap::new()})
    }
    pub(crate) fn get(&mut self,id:&str)->Result<Rc<Transaction>,EngineError>{
        if let Some(tx)=self.parsed.get(id){return Ok(Rc::clone(tx));}
        let raw=self.raw.get(id).ok_or_else(||error(ErrorCode::MissingMaterial,"AMM required parent missing","snapshot.payload.parents"))?;
        if raw.len()>2*1_048_576{return Err(invalid("AMM parent exceeds local byte budget"));}
        let bytes=decode_hex(raw,"snapshot.payload.parents")?;
        let tx=Transaction::from_bytes(&bytes).map_err(|_|invalid("AMM parent malformed"))?;check_transaction(&tx)?;
        if tx.txid().to_string()!=id||tx.serialize()!=bytes||hex(&bytes)!=*raw{return Err(invalid("AMM parent txid or canonical raw mismatch"));}
        let tx=Rc::new(tx);self.parsed.insert(id.into(),Rc::clone(&tx));Ok(tx)
    }
}
pub(crate) struct PoolAnchor{pub config:PoolConfig,pub genesis:Rc<Transaction>,pub code_hash:[u8;32]}

fn request_error(message:&str)->EngineError{error(ErrorCode::InvalidInput,message,"request.intent")}
pub(crate) fn validate_create_request(request:&CanonicalRequest)->Result<(),EngineError>{
    let i=&request.intent;let encoded=serde_json::to_value(i).map_err(|_|request_error("AMM request encoding invalid"))?;
    let allowed=["type","version","ftContractId","feePolicy","lpTimelock","controllers","serviceProviderTag"];
    if encoded.as_object().unwrap().keys().any(|k|!allowed.contains(&k.as_str())){return Err(request_error("AMM create contains fields from another operation"));}
    let id=i.ft_contract_id.as_deref().ok_or_else(||request_error("AMM create requires underlying FT genesis ID"))?;
    if id.len()!=64||!id.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)){return Err(request_error("AMM FT ID must be canonical txid"));}
    if i.lp_timelock.is_none(){return Err(request_error("AMM lpTimelock must be explicit"));}
    creation_profile(request)?;
    authorization(request)?;Ok(())
}
fn creation_profile(request:&CanonicalRequest)->Result<amm_profile::Profile,EngineError>{
    let fees=request.intent.fee_policy.as_ref().ok_or_else(||request_error("AMM create requires explicit feePolicy"))?;
    let tag=request.intent.service_provider_tag.as_deref().unwrap_or("NULL");
    // A public JSON text label, not authorization or raw signature material.
    if tag.chars().count()>256{return Err(request_error("AMM provider tag exceeds 256 Unicode characters"));}
    amm_profile::Profile::explicit(crate::protocols::amm_explicit::FeeRates{
        lp_fee_rate:fees.lp_fee_rate,tax_fee_rate:fees.tax_fee_rate,
        service_provider_fee_rate:fees.service_provider_fee_rate,protocol_fee_rate:fees.protocol_fee_rate,
    },&fees.fee_address,tag.as_bytes().to_vec()).map_err(|_|request_error("AMM feePolicy requires canonical P2PKH and total below 10000 bps"))
}
fn authorization(request:&CanonicalRequest)->Result<Authorization,EngineError>{
    let Some(values)=&request.intent.controllers else{return Ok(Authorization::Public);};
    if !(1..=5).contains(&values.len()){return Err(request_error("AMM controllers requires one to five unique hashes; omit for public pool"));}
    let mut hashes=vec![];
    for value in values{
        if value.len()!=40||!value.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)){return Err(request_error("AMM controller must be canonical hash160"));}
        hashes.push(decode_hex(value,"request.intent.controllers")?.try_into().unwrap());
    }
    let auth=Authorization::Controller(hashes.clone()).normalized().map_err(|_|request_error("AMM controller whitelist invalid"))?;
    if auth!=Authorization::Controller(hashes){return Err(request_error("AMM controllers must use canonical ascending order"));}Ok(auth)
}
pub(crate) fn plan_create(request:&CanonicalRequest,material:&WalletMaterial<'_>,signing:&PublicSigningContext)->Result<PlannedTransfer,EngineError>{
    validate_request(request)?;validate_material_identity(request,material)?;
    let policy=&material.policy.payload;
    if policy.chain_id!=request.chain_id||policy.fee_rate_sat_per_kb!="80"||policy.dust_threshold!="10"||policy.sighash_type!=65{return Err(request_error("AMM policy requires 80 atomic/kB, dust10 and sighash65"));}
    let policies:Vec<_>=policy.contract_policies.iter().filter(|p|p.get("family").and_then(|v|v.as_str())==Some("pool")).collect();
    if policies.len()!=1||policies[0].get("createVersion").and_then(|v|v.as_str())!=Some("pool3"){return Err(request_error("AMM creation requires explicit Pool3 creation policy"));}
    let versions=policies[0].get("allowedVersions").and_then(|v|v.as_array()).ok_or_else(||request_error("AMM versions missing"))?;
    let unique:Option<std::collections::BTreeSet<_>>=versions.iter().map(|v|v.as_str()).collect();
    let unique=unique.ok_or_else(||request_error("AMM policy versions must be strings"))?;
    if unique.len()!=versions.len()||!unique.contains("pool3"){return Err(request_error("AMM policy must allow Pool3"));}
    let public=PublicKey::from_slice(&decode_hex(&signing.public_key,"snapshot.payload.account.publicKey")?).map_err(|_|request_error("AMM funding public key invalid"))?;
    let mut ft_parents=Parents::new(material)?;
    let ft_id=request.intent.ft_contract_id.as_deref().unwrap();
    // Validate the same FT standard/template/ID boundary used by holder spends.
    let _identity=super::tbc20::trusted_token_identity(ft_id,material,&mut ft_parents)?;
    let indexed=material.snapshot.payload.contracts.iter().find(|r|r.contract_id==ft_id).and_then(|r|r.indexed_fungible.as_ref());
    let config=if let Some(indexed)=indexed{
        PoolConfig::with_indexed_ft(ft_id.parse().map_err(|_|invalid("AMM FT ID invalid"))?,
            decode_hex(&indexed.code_script,"snapshot.payload.contracts.indexedFungible.codeScript")?,
            decode_hex(&indexed.tape_script,"snapshot.payload.contracts.indexedFungible.tapeScript")?,
            authorization(request)?,request.intent.lp_timelock.unwrap(),creation_profile(request)?)?
    }else{
        let ft=trusted_genesis_id(ft_id,material,&mut ft_parents)?;
        PoolConfig::with_profile(ft.transaction(),&ft.transaction().txid(),authorization(request)?,request.intent.lp_timelock.unwrap(),creation_profile(request)?)?
    };
    let mut funding=funding_candidates(material,signing)?;funding.retain(|u|permitted(request,&u.txid,u.vout));funding.sort_by(|a,b|(a.satoshis,&a.txid,a.vout).cmp(&(b.satoshis,&b.txid,b.vout)));
    let maximum=max_fee(request)?;let mut capped=None;
    for f in funding{
        let previous=tbc_sdk::TxOut{satoshis:f.satoshis,script_pubkey:tbc_sdk::script::Script::from_bytes(decode_hex(&f.script,"snapshot.payload.utxos")?)};
        let built=crate::protocols::amm_mint::build_funded_mint_from_output(crate::protocols::amm_mint::FundedMintOptions{config:&config,
            funding_outpoint:tbc_sdk::OutPoint{txid:f.txid.parse().map_err(|_|invalid("AMM funding txid invalid"))?,vout:f.vout},funding_output:&previous,
            funding_public_key:&public,change_hash:public.hash160(),fee_policy:crate::protocols::amm_transaction::MinerFeePolicy::default(),max_fee:maximum});
        let built=match built{Ok(b)=>b,Err(e)if e.code==ErrorCode::InsufficientFunds=>continue,Err(e)if e.code==ErrorCode::FeeCapExceeded=>{capped=Some(e);continue;},Err(e)=>return Err(e)};
        for limit in &policy.amount_limits{
            if limit.scope=="pool-state"&&limit.protocol_version.as_deref().is_none_or(|v|v=="pool3")&&limit.contract_id.is_none(){
                if parse_decimal_u64(&limit.maximum,"policy.payload.amountLimits.maximum")?<1500{return Err(request_error("AMM genesis exceeds Pool value policy"));}
            }
        }
        return finish(request,material,built.unsigned_plan,built.fees.to_vec(),vec![AssetFlow{kind:"pool".into(),direction:"create".into(),amount:"1".into(),contract_id:None,from:request.from.clone(),to:None}]);
    }
    Err(capped.unwrap_or_else(||error(ErrorCode::InsufficientFunds,"AMM creation needs one sufficient native funding input","snapshot.payload.utxos")))
}
pub(crate) fn pool_anchor(id:&str,material:&WalletMaterial<'_>,parents:&mut Transactions<'_>,public:&PublicKey)->Result<PoolAnchor,EngineError>{
    let records:Vec<_>=material.snapshot.payload.contracts.iter().filter(|r|r.contract_id==id).collect();
    if records.len()!=1{return Err(invalid("AMM requires exactly one Pool contract record"));}let record=records[0];
    if record.family!="pool"||record.protocol_version!="pool3"||record.standard_id.as_deref()!=Some("tbc-amm")
        ||record.creation_txid!=id||record.genesis_outpoint.as_ref().is_none_or(|p|p.txid!=id||p.vout!=0){return Err(invalid("AMM contract record must bind the new genesis standard"));}
    if let Some(indexed)=&record.indexed_pool{
        if record.current_outpoint.vout!=0{return Err(invalid("Indexed AMM must select current Code output zero"));}
        let current=parents.get(&record.current_outpoint.txid)?;
        let bound=crate::protocols::amm_material::bind_indexed(&current,
            decode_hex(&indexed.ft_code_script,"snapshot.payload.contracts.indexedPool.ftCodeScript")?,
            decode_hex(&indexed.ft_tape_script,"snapshot.payload.contracts.indexedPool.ftTapeScript")?)?;
        if record.template_revision.as_deref()!=Some(bound.template_revision){return Err(invalid("Indexed AMM template differs from actual Code"));}
        return Ok(PoolAnchor{config:bound.config,genesis:current,code_hash:bound.code_hash});
    }
    let genesis=parents.get(id)?;
    if genesis.inputs.len()!=1||!(4..=5).contains(&genesis.outputs.len()){return Err(invalid("AMM genesis shape invalid"));}
    let code=amm_profile::Code::decode(genesis.outputs[0].script_pubkey.as_bytes()).map_err(|_|invalid("AMM genesis full Code invalid"))?;
    let expected=crate::protocols::amm_material::template_revision(&code);
    if record.template_revision.as_deref()!=Some(expected){return Err(invalid("AMM template revision differs from full Code"));}
    let tape=Tape::decode(genesis.outputs[1].script_pubkey.as_bytes()).map_err(|_|invalid("AMM genesis Tape invalid"))?;
    let ft=parents.get(&hex(&tape.ft_a_contract_id))?;
    let profile=amm_profile::Profile::from_parts(&code,&tape).map_err(|_|invalid("AMM genesis profile invalid"))?;
    let config=PoolConfig::with_profile(&ft,&ft.txid(),code.authorization.clone(),tape.with_lp_locktime,profile)?;
    let code_hash=hash::sha256(genesis.outputs[0].script_pubkey.as_bytes());let state=config.read_pool(&genesis,&code_hash)?;
    if state.math().pool_value!=1500||state.math().ft_lp_amount!=0||state.math().ft_a_amount!=0||state.math().tbc_amount!=0{return Err(invalid("AMM genesis reserves must be empty"));}
    config.validate_ft(&genesis,2,public,Some(&state))?;
    let root=&genesis.inputs[0].previous_output;let mut original=vec![];root.serialize(&mut original);
    if code.original_utxo.as_slice()!=original{return Err(invalid("AMM genesis original funding differs"));}
    let source=parents.get(&root.txid.to_string())?;let output=source.outputs.get(root.vout as usize).ok_or_else(||invalid("AMM root output missing"))?;
    let script=output.script_pubkey.as_bytes();if script.len()!=25||script[..3]!=[0x76,0xa9,0x14]||script[23..]!=[0x88,0xac]{return Err(invalid("AMM genesis root is not P2PKH"));}
    let total=genesis.outputs.iter().try_fold(0u64,|sum,o|sum.checked_add(o.satoshis)).ok_or_else(||invalid("AMM genesis value overflow"))?;
    if total>=output.satoshis{return Err(invalid("AMM genesis overspends root or lacks miner fee"));}
    if let Some(change)=genesis.outputs.get(4){let script=change.script_pubkey.as_bytes();if change.satoshis<10||script.len()!=25||script[..3]!=[0x76,0xa9,0x14]||script[23..]!=[0x88,0xac]{return Err(invalid("AMM genesis change invalid"));}}
    Ok(PoolAnchor{config,genesis,code_hash})
}
