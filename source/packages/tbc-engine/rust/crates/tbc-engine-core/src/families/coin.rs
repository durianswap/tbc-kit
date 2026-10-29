//! Latest Coin holder/administrator public profile. Shares immutable material and planning
//! boundaries; does not reinterpret old StableCoin intents or perform I/O.
use std::collections::{BTreeMap,BTreeSet};
use tbc_sdk::{Address,OutPoint,PublicKey,Transaction,TxOut,script::Script};
use crate::{EngineError,ErrorCode,model::{AssetFlow,CanonicalRequest,PlannedTransfer,WalletMaterial,error},
    normalize::{hex,parse_decimal_u64,parse_decimal_u128,tbc20_transfer_recipients,validate_request},
    protocols::{coin::LOCKTIME_THRESHOLD,coin_identity,coin_proof,coin_transfer::{CoinInput,FeeInput,Receiver,TransferOptions}},
    signing::PublicSigningContext};
use super::{ft::{decode_hex,funding_candidates,validate_material_identity},tbc20::{Parents,max_fee,permitted,finish}};

pub(crate) const TEMPLATE:&str="c686fc271f0ee8116325bf541d87c4d2e6ad839896a9d9dd21dcf2ac847660e3";
fn invalid(message:&str)->EngineError {error(ErrorCode::InvalidAncestry,message,"snapshot.payload")}
fn missing(message:&str)->EngineError {error(ErrorCode::MissingMaterial,message,"snapshot.payload")}

// Resolve only the explicitly bound administrator. Funding/holder selection
// continues to use the primary account; no key access or network lookup here.
fn administrator_key(request:&CanonicalRequest,material:&WalletMaterial<'_>,primary:&PublicKey)->Result<[u8;32],EngineError> {
    if request.signing_roles.is_none() {
        return primary.to_bytes()[1..].try_into().map_err(|_|invalid("Coin administrator key is not compressed SEC"));
    }
    let accounts=crate::signing_wire::SigningAccounts::resolve(request,&material.snapshot.payload)?;
    let account=accounts.coin_administrator();
    let key=PublicKey::from_slice(&decode_hex(&account.public_key,"snapshot.payload.signingAccounts.publicKey")?)
        .map_err(|_|invalid("Coin administrator requires compressed account public key"))?;
    key.to_bytes()[1..].try_into().map_err(|_|invalid("Coin administrator key is not compressed SEC"))
}

pub(crate) fn check_policy(material:&WalletMaterial<'_>,request:&CanonicalRequest,total:u128,slots:impl Iterator<Item=u64>)->Result<(),EngineError> {
    let mut seen=false;
    for policy in &material.policy.payload.contract_policies {
        if policy.get("family").and_then(|v|v.as_str())!=Some("stablecoin") {continue;}
        if seen {return Err(invalid("Coin stablecoin policy is duplicated"));}seen=true;
        let allowed=policy.get("allowedVersions").and_then(|v|v.as_array()).ok_or_else(||invalid("Coin policy versions malformed"))?;
        let versions:Option<BTreeSet<_>>=allowed.iter().map(|v|v.as_str()).collect();
        let versions=versions.ok_or_else(||invalid("Coin policy version must be a string"))?;
        if versions.len()!=allowed.len() || !versions.contains("coin") {return Err(invalid("Stablecoin policy does not allow Coin"));}
    }
    let mut max_total=u128::MAX;let mut max_slot=crate::protocols::tbc20::MAX_SLOT_AMOUNT as u128;let mut seen=BTreeMap::new();
    for limit in &material.policy.payload.amount_limits {
        if !matches!(limit.scope.as_str(),"stablecoin-total"|"stablecoin-slot")
            || limit.protocol_version.as_deref().is_some_and(|v|v!="coin")
            || limit.contract_id.as_deref().is_some_and(|v|Some(v)!=request.intent.contract_id.as_deref()) {continue;}
        let maximum=parse_decimal_u128(&limit.maximum,"policy.payload.amountLimits.maximum")?;
        let key=(&limit.scope,&limit.protocol_version,&limit.contract_id);
        if maximum==0 || seen.insert(key,maximum).is_some_and(|old|old!=maximum) {return Err(invalid("Coin amount policy is zero or contradictory"));}
        if limit.scope=="stablecoin-total" {max_total=max_total.min(maximum);}else{max_slot=max_slot.min(maximum);}
    }
    if total>max_total || slots.into_iter().any(|n|n as u128>max_slot) {return Err(invalid("Coin amount exceeds applicable total/slot policy"));}
    Ok(())
}

pub(crate) fn trusted_issuer(id:&str,material:&WalletMaterial<'_>,parents:&mut Parents<'_>)->Result<coin_identity::IssuerIdentity,EngineError> {
    let records:Vec<_>=material.snapshot.payload.contracts.iter().filter(|r|r.contract_id==id).collect();
    if records.len()!=1 {return Err(invalid("Coin requires one unambiguous contract record"));}
    let record=records[0];
    if record.family!="stablecoin" || record.protocol_version!="coin" || record.standard_id.as_deref()!=Some("tbc20-stablecoin")
        || record.template_revision.as_deref()!=Some(TEMPLATE) || record.creation_txid!=id
        || record.genesis_outpoint.as_ref().is_none_or(|p|p.txid!=id || p.vout!=0) {
        return Err(invalid("Coin contract record must bind issuer-source output zero and the pinned standard"));
    }
    if let Some(indexed)=&record.indexed_fungible {
        let code=decode_hex(&indexed.code_script,"snapshot.payload.contracts.indexedFungible.codeScript")?;
        let tape=decode_hex(&indexed.tape_script,"snapshot.payload.contracts.indexedFungible.tapeScript")?;
        if code.len()>65_536 || tape.len()>127 || hex(&code)!=indexed.code_script || hex(&tape)!=indexed.tape_script {
            return Err(invalid("indexed Coin scripts must be bounded canonical hex"));
        }
        coin_identity::inspect_indexed_issuer(&code,&tape)
    } else {
        coin_identity::inspect_issuer(&id.parse().map_err(|_|invalid("Coin contract ID invalid"))?,parents.bytes(id)?)
    }
}

fn coin_account(request:&CanonicalRequest,material:&WalletMaterial<'_>,signing:&PublicSigningContext)->Result<(PublicKey,[u8;21]),EngineError> {
    validate_request(request)?;validate_material_identity(request,material)?;
    let policy=&material.policy.payload;
    if policy.chain_id!=request.chain_id || policy.fee_rate_sat_per_kb!="80" || policy.dust_threshold!="24" || policy.sighash_type!=65 {
        return Err(error(ErrorCode::InvalidInput,"Coin pinned policy requires 80 atomic/kB, native change 24, sighash 65","policy.payload"));
    }
    let public=PublicKey::from_slice(&decode_hex(&signing.public_key,"snapshot.payload.account.publicKey")?).map_err(|_|invalid("Coin public key invalid"))?;
    let owner_hash=Address::from_string(&request.from).map_err(|_|invalid("Coin account address invalid"))?.hash160();
    let mut owner=[0;21];owner[..20].copy_from_slice(&owner_hash);
    Ok((public,owner))
}

pub(crate) fn plan_coin(request:&CanonicalRequest,material:&WalletMaterial<'_>,signing:&PublicSigningContext)->Result<PlannedTransfer,EngineError> {
    if matches!(request.intent.intent_type.as_str(),"tbc20-stablecoin-transfer"|"tbc20-stablecoin-merge") {
        return build_holder(request,material,signing,&prepare_holder(request,material,signing)?);
    }
    let (public,_)=coin_account(request,material,signing)?;
    if request.intent.intent_type=="tbc20-stablecoin-create" {
        return plan_create(request,material,&public,signing);
    }
    let id=request.intent.contract_id.as_deref().ok_or_else(||invalid("Coin contract ID missing"))?;
    let mut parents=Parents::new(material)?;
    let issuer=trusted_issuer(id,material,&mut parents)?;
    if matches!(request.intent.intent_type.as_str(),"tbc20-stablecoin-mint"|"tbc20-stablecoin-freeze"|"tbc20-stablecoin-unfreeze") {
        return plan_management(request,material,signing,&public,&issuer,&mut parents);
    }
    Err(error(ErrorCode::UnsupportedIntent,"unsupported Coin operation","request.intent.type"))
}

// Private, owned, non-serializable material. Constructed from the original
// authenticated snapshot exactly once per plan computation. Only the trusted
// funding wrapper may reuse it while replacing native fee inputs. Public plan,
// validate and finalize calls each prepare their own material independently.
struct HolderMaterial {
    public:PublicKey,owner:[u8;21],identity:Vec<u8>,
    selected:Vec<(coin_proof::ParentMaterial,Vec<Vec<u8>>)>,
    receivers:Vec<Receiver>,payment:Option<(Address,u64)>,flows:Vec<AssetFlow>,
}

pub(crate) fn plan_coin_with_funding(request:&CanonicalRequest,material:&WalletMaterial<'_>,signing:&PublicSigningContext)->Result<PlannedTransfer,EngineError> {
    let prepared=prepare_holder(request,material,signing)?;
    crate::funding_fallback::plan_with_funding(request,material,|request,material|build_holder(request,material,signing,&prepared))
}

fn prepare_holder(request:&CanonicalRequest,material:&WalletMaterial<'_>,signing:&PublicSigningContext)->Result<HolderMaterial,EngineError> {
    #[cfg(feature="coin-planning-profile")]
    let _prepare_timer=crate::planning_profile::Span::new("coin_material_prepare");
    let (public,owner)=coin_account(request,material,signing)?;
    let id=request.intent.contract_id.as_deref().ok_or_else(||invalid("Coin contract ID missing"))?;
    let mut parents=Parents::new(material)?;
    let issuer=trusted_issuer(id,material,&mut parents)?;
    let policy=&material.policy.payload;
    let is_merge=request.intent.intent_type=="tbc20-stablecoin-merge";
    let recipients=if is_merge {vec![]}else{tbc20_transfer_recipients(request)?};
    let amount=recipients.iter().map(|r|r.amount).sum::<u128>();
    let minimum=parse_decimal_u64(&policy.min_confirmations,"policy.payload.minConfirmations")?;
    let mut candidates:Vec<_>=material.snapshot.payload.utxos.iter().filter(|u|u.contract_id.as_deref()==Some(id)).collect();
    candidates.sort_by(|a,b|(&a.txid,a.vout).cmp(&(&b.txid,b.vout)));
    let mut selected=Vec::new();let mut total=0u128;let mut seen=BTreeSet::new();
    let mut identity:Option<Vec<u8>>=None;
    let exact=request.constraints.as_ref().and_then(|c|c.input_outpoints.as_ref()).is_some();
    for u in candidates {
        if !seen.insert((&u.txid,u.vout)) {return Err(invalid("Coin asset input repeated"));}
        if !permitted(request,&u.txid,u.vout) {continue;}
        if u.classification!="stablecoin" {return Err(invalid("Coin UTXO classification must be stablecoin"));}
        if !crate::confirmations::meets_minimum(u.confirmations.as_deref(),minimum,"snapshot.payload.utxos.confirmations")? {
            if exact {return Err(missing("Coin explicitly selected input does not satisfy the confirmation policy"));}
            continue;
        }
        if !is_merge && total>=amount && !exact {continue;}
        let point=OutPoint{txid:u.txid.parse().map_err(|_|invalid("Coin UTXO ID invalid"))?,vout:u.vout};
        let parent=coin_proof::inspect_parent(parents.bytes(&u.txid)?,&point,identity.as_deref())?;
        coin_identity::validate_holder_identity(&issuer,&parent)?;
        if identity.is_none() {identity=Some(parent.identity().to_vec());}
        let output=&parent.transaction().outputs[u.vout as usize];
        if u.satoshis!="500" || u.script_pub_key!=hex(output.script_pubkey.as_bytes()) || parent.code().controller!=owner {
            return Err(invalid("Coin descriptor, owner or metadata differs from its bound material"));
        }
        let lock=parent.tape().lock_time;
        if lock!=0 && parent.code().admin_pubkey_hash!=public.hash160()
            && parent.code().admin_pubkey_hash!=tbc_sdk::hash::hash160(&public.to_bytes()[1..]) {
            let mature = if lock<LOCKTIME_THRESHOLD {
                u64::from(lock)<=parse_decimal_u64(&material.snapshot.payload.require_block()?.height,"snapshot.payload.block.height")?
            }else{
                let time=material.snapshot.payload.require_block()?.median_time_past.as_deref().ok_or_else(||missing("Coin timestamp lock requires trusted medianTimePast"))?;
                let time=parse_decimal_u64(time,"snapshot.payload.block.medianTimePast")?;
                u64::from(lock)<time
            };
            if !mature {
                if exact {return Err(missing("Coin explicitly selected input lock is not mature at the bound chain tip"));}
                continue;
            }
        }
        if selected.len()==128 {return Err(error(ErrorCode::InvalidInput,"Coin maintenance exceeds the 128 asset input material bound","snapshot.payload.utxos"));}
        let required:BTreeSet<_>=parent.dependencies().iter().map(|p|p.txid.to_string()).collect();
        let raws=required.iter().map(|id|parents.bytes(id).map(Vec::from)).collect::<Result<Vec<_>,_>>()?;
        total+=parent.tape().balance;check_policy(material,request,total,parent.tape().amounts.into_iter())?;
        selected.push((parent,raws));
    }
    if selected.is_empty() || (!is_merge && total<amount) {return Err(error(ErrorCode::InsufficientFunds,"insufficient authenticated Coin balance","snapshot.payload.utxos"));}
    if let Some(indexed)=material.snapshot.payload.contracts.iter().find(|r|r.contract_id==id).and_then(|r|r.indexed_fungible.as_ref()) {
        let supply=parse_decimal_u128(&indexed.total_supply,"snapshot.payload.contracts.indexedFungible.totalSupply")?;
        if supply==0 || total>supply {return Err(invalid("Coin holdings exceed trusted index supply"));}
    }
    if is_merge && selected.len()<2 {return Err(error(ErrorCode::InvalidInput,"Coin merge requires at least two outputs","snapshot.payload.utxos"));}
    let receivers=if is_merge {vec![Receiver{controller:owner,amount:total}]}else{recipients.iter().map(|r|Receiver{controller:r.controller,amount:r.amount}).collect()};
    let payment=request.intent.payment.as_ref().map(|p|Ok((Address::from_string(&p.to).map_err(|_|invalid("Coin payment address invalid"))?,
        parse_decimal_u64(&p.amount,"request.intent.payment.amount")?))).transpose()?;
    let mut flows=if is_merge {vec![AssetFlow {kind:"stablecoin".into(),direction:"merge".into(),amount:total.to_string(),
        contract_id:Some(id.into()),from:request.from.clone(),to:Some(request.from.clone())}]}else{
        recipients.iter().map(|r|AssetFlow {kind:"stablecoin".into(),direction:"send".into(),amount:r.amount.to_string(),
            contract_id:Some(id.into()),from:request.from.clone(),to:Some(r.to.into())}).collect()};
    if let Some(p)=&request.intent.payment {flows.push(AssetFlow {kind:"native".into(),direction:"send".into(),amount:p.amount.clone(),
        contract_id:None,from:request.from.clone(),to:Some(p.to.clone())});}
    Ok(HolderMaterial{public,owner,identity:identity.unwrap(),selected,receivers,payment,flows})
}

fn build_holder(request:&CanonicalRequest,material:&WalletMaterial<'_>,signing:&PublicSigningContext,prepared:&HolderMaterial)->Result<PlannedTransfer,EngineError> {
    let HolderMaterial{public,owner,identity,selected,receivers,payment,flows}=prepared;
    let exact=request.constraints.as_ref().and_then(|c|c.input_outpoints.as_ref()).is_some();
    let is_merge=request.intent.intent_type=="tbc20-stablecoin-merge";
    let mut funding=funding_candidates(material,signing)?;funding.retain(|u|permitted(request,&u.txid,u.vout));
    funding.sort_by(|a,b|(a.satoshis,&a.txid,a.vout).cmp(&(b.satoshis,&b.txid,b.vout)));
    if exact {
        let points=request.constraints.as_ref().unwrap().input_outpoints.as_ref().unwrap();
        if points.len()!=selected.len()+funding.len() {
            return Err(error(ErrorCode::MissingMaterial,"Coin exact inputs must all be available, owned and eligible","request.constraints.inputOutpoints"));
        }
        if funding.len()>1 {
            // Internal signal to the common native-funding wrapper. Its exact
            // remap and final external-input audit must consume every point.
            return Err(error(ErrorCode::InsufficientFunds,"Coin selected native funding requires a planned prerequisite","request.constraints.inputOutpoints"));
        }
    }
    let raw_refs:Vec<Vec<_>>=selected.iter().map(|(_,raws)|raws.iter().map(Vec::as_slice).collect()).collect();
    let inputs:Vec<_>=selected.iter().zip(&raw_refs).map(|((parent,_),raws)|CoinInput {parent,ancestor_raws:raws,public_key:public}).collect();
    let maximum=max_fee(request)?;let mut cap_failure=None;
    for f in funding {
        let fee_output=TxOut{satoshis:f.satoshis,script_pubkey:Script::from_bytes(decode_hex(&f.script,"snapshot.payload.utxos")?)};
        let fee=FeeInput {outpoint:OutPoint{txid:f.txid.parse().map_err(|_|invalid("Coin fee txid invalid"))?,vout:f.vout},output:&fee_output,public_key:public};
        let options=TransferOptions {inputs:&inputs,fee_input:&fee,receivers,expected_identity:identity,
            token_change_controller:*owner,additional_payment:payment.as_ref().map(|(a,n)|(a,*n)),additional_info:None,max_fee:maximum};
        let options=crate::protocols::coin_batch::BatchOptions{transfer:options,max_transactions:material.policy.payload.max_bundle_transactions as usize};
        let result=if is_merge {crate::protocols::coin_batch::build_batch_merge_plan(options)}else{crate::protocols::coin_batch::build_batch_transfer_plan(options)};
        let built=match result {Ok(v)=>v,Err(e) if e.code==ErrorCode::InsufficientFunds=>continue,
            Err(e) if e.code==ErrorCode::FeeCapExceeded=>{cap_failure=Some(e);continue;},Err(e)=>return Err(e)};
        for output in &built.token_outputs {check_policy(material,request,output.amount,output.amounts_by_input.into_iter())?;}
        return finish(request,material,built.unsigned_plan,built.fees,flows.clone());
    }
    Err(cap_failure.unwrap_or_else(||error(ErrorCode::InsufficientFunds,"Coin requires one sufficient native fee output","snapshot.payload.utxos")))
}

fn plan_create(request:&CanonicalRequest,material:&WalletMaterial<'_>,public:&PublicKey,signing:&PublicSigningContext)->Result<PlannedTransfer,EngineError> {
    use crate::protocols::coin_issuance::{build_create_plan,CreateOptions,CoinDefinition};
    let amount=parse_decimal_u64(request.intent.initial_supply.as_deref().unwrap_or(""),"request.intent.initialSupply")?;
    check_policy(material,request,amount as u128,[amount].into_iter())?;
    let administrator=administrator_key(request,material,public)?;
    let to=request.intent.to.as_deref().unwrap_or(&request.from);
    let mut recipient=[0;21];recipient[..20].copy_from_slice(&Address::from_string(to).map_err(|_|invalid("Coin creation recipient invalid"))?.hash160());
    let mut funding=funding_candidates(material,signing)?;funding.retain(|u|permitted(request,&u.txid,u.vout));
    funding.sort_by(|a,b|(a.satoshis,&a.txid,a.vout).cmp(&(b.satoshis,&b.txid,b.vout)));
    if let Some(points)=request.constraints.as_ref().and_then(|c|c.input_outpoints.as_ref()) {
        if points.len()!=1 || funding.len()!=1 {return Err(error(ErrorCode::UnsupportedIntent,"Coin creation currently requires one explicit native funding output","request.constraints.inputOutpoints"));}
    }
    let mut parents=Parents::new(material)?;let maximum=max_fee(request)?;let mut cap_failure=None;
    for candidate in funding {
        let raw=parents.bytes(&candidate.txid)?;
        let parent=Transaction::from_bytes(raw).map_err(|_|invalid("Coin funding parent malformed"))?;
        let out=parent.outputs.get(candidate.vout as usize).ok_or_else(||invalid("Coin funding output absent"))?;
        if parent.txid().to_string()!=candidate.txid || parent.serialize()!=raw || out.satoshis!=candidate.satoshis || hex(out.script_pubkey.as_bytes())!=candidate.script {
            return Err(invalid("Coin funding index differs from its bound parent"));
        }
        let built=build_create_plan(CreateOptions {definition:CoinDefinition {name:request.intent.name.as_deref().unwrap(),symbol:request.intent.symbol.as_deref().unwrap(),
                decimals:request.intent.decimals.unwrap(),initial_amount:amount},administrator:&administrator,fee_public_key:public,funding:&parent,
            funding_outpoint:OutPoint{txid:parent.txid(),vout:candidate.vout},recipient,additional_info:None,max_fee:maximum});
        let built=match built {Ok(v)=>v,Err(e) if e.code==ErrorCode::InsufficientFunds=>continue,
            Err(e) if e.code==ErrorCode::FeeCapExceeded=>{cap_failure=Some(e);continue;},Err(e)=>return Err(e)};
        return finish(request,material,built.unsigned_plan,built.fees,vec![AssetFlow{kind:"stablecoin".into(),direction:"create".into(),amount:amount.to_string(),
            contract_id:None,from:request.from.clone(),to:Some(to.into())}]);
    }
    Err(cap_failure.unwrap_or_else(||error(ErrorCode::InsufficientFunds,"Coin creation requires one sufficient native output","snapshot.payload.utxos")))
}

fn bound_transaction(parents:&mut Parents<'_>,id:&str)->Result<Transaction,EngineError> {
    let raw=parents.bytes(id)?;
    let tx=Transaction::from_bytes(raw).map_err(|_|invalid("Coin management parent malformed"))?;
    if tx.txid().to_string()!=id || tx.serialize()!=raw {return Err(invalid("Coin management parent bytes do not match their ID"));}
    Ok(tx)
}

// Administration and funding are independently bound; holder outputs keep
// their existing controller. Host still owns per-account permission checks.
fn plan_management(request:&CanonicalRequest,material:&WalletMaterial<'_>,signing:&PublicSigningContext,public:&PublicKey,
    issuer:&coin_identity::IssuerIdentity,parents:&mut Parents<'_>)->Result<PlannedTransfer,EngineError> {
    use crate::protocols::{coin_admin::{self,AdminInput,ChangeLocksOptions},coin_issuance::{self,MintOptions}};
    let administrator=administrator_key(request,material,public)?;
    if tbc_sdk::hash::hash160(&administrator)!=issuer.admin_hash {return Err(invalid("Selected account is not the bound Coin administrator"));}
    let id=request.intent.contract_id.as_deref().unwrap();
    let is_mint=request.intent.intent_type=="tbc20-stablecoin-mint";
    let minimum=parse_decimal_u64(&material.policy.payload.min_confirmations,"policy.payload.minConfirmations")?;
    let mut selected=Vec::new();let mut flows=Vec::new();let mut total=0u128;
    let mint_material=if is_mint {
        let record=material.snapshot.payload.contracts.iter().find(|r|r.contract_id==id).unwrap();
        let point=&record.current_outpoint;
        if point.vout!=0 || request.intent.certificate_outpoint.as_ref().is_some_and(|p|p.txid!=point.txid || p.vout!=point.vout) {
            return Err(invalid("Coin current certificate must match the requested outpoint"));
        }
        let source=bound_transaction(parents,id)?;
        let certificate=bound_transaction(parents,&point.txid)?;
        let previous=certificate.inputs.first().ok_or_else(||invalid("Coin certificate input absent"))?.previous_output.txid.to_string();
        let grandparent=bound_transaction(parents,&previous)?;
        if certificate.outputs.len()<5 {return Err(invalid("Coin current certificate lacks its issuance template"));}
        let amount=parse_decimal_u64(request.intent.amount.as_deref().unwrap(),"request.intent.amount")?;
        check_policy(material,request,amount as u128,[amount].into_iter())?;
        let to=request.intent.to.as_deref().unwrap();
        let mut recipient=[0;21];recipient[..20].copy_from_slice(&Address::from_string(to).map_err(|_|invalid("Coin mint recipient invalid"))?.hash160());
        // Both certificate inputs must be explicitly present and unspent in the
        // supplied node snapshot; a historical raw is not spendability proof.
        for vout in [0usize,1] {
            let matching:Vec<_>=material.snapshot.payload.utxos.iter().filter(|u|u.txid==point.txid && u.vout==vout as u32).collect();
            if matching.len()!=1 {return Err(missing("Coin current certificate Code/Hold UTXO missing or ambiguous"));}
            let u=matching[0];let output=&certificate.outputs[vout];
            if u.contract_id.as_deref()!=Some(id) || u.classification!="nft" || u.satoshis!=output.satoshis.to_string()
                || u.script_pub_key!=hex(output.script_pubkey.as_bytes()) || !permitted(request,&u.txid,u.vout)
                || !crate::confirmations::meets_minimum(u.confirmations.as_deref(),minimum,"snapshot.payload.utxos.confirmations")? {
                return Err(invalid("Coin issuance UTXO does not match the bound certificate or policy"));
            }
        }
        flows.push(AssetFlow{kind:"stablecoin".into(),direction:"mint".into(),amount:amount.to_string(),contract_id:Some(id.into()),from:request.from.clone(),to:Some(to.into())});
        Some((source,certificate,grandparent,amount,recipient))
    }else{
        for point in request.intent.target_outpoints.as_ref().unwrap() {
            if !permitted(request,&point.txid,point.vout) {return Err(invalid("Coin lock target excluded by exact input constraints"));}
            let matching:Vec<_>=material.snapshot.payload.utxos.iter().filter(|u|u.txid==point.txid && u.vout==point.vout).collect();
            if matching.len()!=1 {return Err(missing("Coin exact lock target missing or ambiguous"));}
            let u=matching[0];
            let parent=coin_proof::inspect_parent(parents.bytes(&point.txid)?,&OutPoint{txid:point.txid.parse().map_err(|_|invalid("Coin target ID invalid"))?,vout:point.vout},None)?;
            coin_identity::validate_holder_identity(issuer,&parent)?;
            if u.contract_id.as_deref()!=Some(id) || u.classification!="stablecoin" || u.satoshis!="500"
                || u.script_pub_key!=hex(parent.transaction().outputs[point.vout as usize].script_pubkey.as_bytes())
                || !crate::confirmations::meets_minimum(u.confirmations.as_deref(),minimum,"snapshot.payload.utxos.confirmations")? {
                return Err(invalid("Coin exact target differs from bound raw or policy"));
            }
            total+=parent.tape().balance;check_policy(material,request,total,parent.tape().amounts.into_iter())?;
            let required:BTreeSet<_>=parent.dependencies().iter().map(|p|p.txid.to_string()).collect();
            let raws=required.iter().map(|id|parents.bytes(id).map(Vec::from)).collect::<Result<Vec<_>,_>>()?;
            let controller=parent.code().controller;
            let address=if controller[20]==0 {Some(Address::from_hash160(controller[..20].try_into().unwrap()).to_string())}else{None};
            flows.push(AssetFlow{kind:"stablecoin".into(),direction:if request.intent.intent_type=="tbc20-stablecoin-freeze"{"lock"}else{"unlock"}.into(),
                amount:parent.tape().balance.to_string(),contract_id:Some(id.into()),from:address.clone().unwrap_or_default(),to:address});
            selected.push((parent,raws));
        }
        None
    };
    let mut funding=funding_candidates(material,signing)?;funding.retain(|u|permitted(request,&u.txid,u.vout));
    funding.sort_by(|a,b|(a.satoshis,&a.txid,a.vout).cmp(&(b.satoshis,&b.txid,b.vout)));
    let maximum=max_fee(request)?;let mut cap_failure=None;
    for f in funding {
        let tx=bound_transaction(parents,&f.txid)?;
        let out=tx.outputs.get(f.vout as usize).ok_or_else(||invalid("Coin management fee output absent"))?;
        if out.satoshis!=f.satoshis || hex(out.script_pubkey.as_bytes())!=f.script {return Err(invalid("Coin management fee descriptor differs from bound parent"));}
        let fee=FeeInput{outpoint:OutPoint{txid:tx.txid(),vout:f.vout},output:out,public_key:public};
        let built=if let Some((source,certificate,grandparent,amount,recipient))=&mint_material {
            coin_issuance::build_mint_plan(MintOptions{issuer_id:&source.txid(),issuer:source,certificate,grandparent,
                coin_code:certificate.outputs[3].script_pubkey.as_bytes(),coin_tape:certificate.outputs[4].script_pubkey.as_bytes(),
                administrator:&administrator,fee_input:&fee,amount:*amount,recipient:*recipient,additional_info:None,max_fee:maximum})
        }else{
            let refs:Vec<Vec<_>>=selected.iter().map(|(_,raws)|raws.iter().map(Vec::as_slice).collect()).collect();
            let inputs:Vec<_>=selected.iter().zip(&refs).map(|((parent,_),raws)|AdminInput{parent,ancestor_raws:raws}).collect();
            let lock=request.intent.lock_time.as_deref().map(|value|parse_decimal_u64(value,"request.intent.lockTime")).transpose()?.unwrap_or(0) as u32;
            coin_admin::build_change_locks_plan(ChangeLocksOptions{inputs:&inputs,expected_identity:selected[0].0.identity(),administrator:&administrator,fee_input:&fee,lock_time:lock,max_fee:maximum})
        };
        let built=match built {Ok(v)=>v,Err(e) if e.code==ErrorCode::InsufficientFunds=>continue,
            Err(e) if e.code==ErrorCode::FeeCapExceeded=>{cap_failure=Some(e);continue;},Err(e)=>return Err(e)};
        return finish(request,material,built.unsigned_plan,built.fees,flows);
    }
    Err(cap_failure.unwrap_or_else(||error(ErrorCode::InsufficientFunds,"Coin management requires one sufficient native fee input","snapshot.payload.utxos")))
}
