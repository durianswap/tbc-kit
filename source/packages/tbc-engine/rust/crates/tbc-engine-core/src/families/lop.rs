//! Public LOP creation/cancellation/matching over authenticated assets.
//! Unspent quote metadata is not fetched for a refund.
use std::collections::BTreeSet;
use tbc_sdk::{OutPoint,PublicKey,Transaction,TxOut,UtxoInfo,script::Script};
use crate::{EngineError,ErrorCode,model::{CanonicalRequest,WalletMaterial,WalletUtxo,PlannedTransfer,AssetFlow,error},
    normalize::{hex,parse_decimal_u64,validate_request},signing::PublicSigningContext,
    protocols::{lop::{Code,Market,Side},lop_transaction,lop_token::{self,TokenInput,TokenProfile,ChainContext,CancelOptions},
        tbc20_material,coin_proof,coin_identity,tbc20_transfer::FeeInput}};
use super::{tbc20::{self,Parents,permitted,max_fee,finish},coin,ft::{decode_hex,funding_candidates,validate_material_identity}};
fn invalid(message:&str)->EngineError{error(ErrorCode::InvalidInput,message,"request.intent")}
fn material_error(message:&str)->EngineError{error(ErrorCode::InvalidAncestry,message,"snapshot.payload")}
pub(crate) fn validate_request_fields(request:&CanonicalRequest)->Result<(),EngineError>{
    let fields=serde_json::to_value(&request.intent).map_err(|_|invalid("LOP intent encoding invalid"))?;
    if request.intent.intent_type=="tbc-lop-create"{
        if fields.as_object().unwrap().keys().any(|k|!matches!(k.as_str(),"type"|"version"|"order")){
            return Err(invalid("LOP creation permits only explicit order terms"));
        }
        let order=request.intent.order.as_ref().ok_or_else(||invalid("LOP order terms required"))?;
        if !matches!(order.side.as_str(),"buy"|"sell")||!matches!(order.market.as_str(),"native-token"|"token-token")
            ||(order.market=="token-token")!=order.asset_b.is_some(){return Err(invalid("LOP side, market or quote asset invalid"));}
        for asset in std::iter::once(&order.asset_a).chain(order.asset_b.iter()){
            if !matches!(asset.standard.as_str(),"tbc20-standard"|"tbc20-stablecoin")||asset.contract_id.len()!=64
                ||!asset.contract_id.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)){
                return Err(invalid("LOP requires explicit current Token standard and canonical asset ID"));
            }
        }
        if order.asset_b.as_ref().is_some_and(|a|a.contract_id==order.asset_a.contract_id){return Err(invalid("LOP pair assets must differ"));}
        for (value,positive) in [(&order.sale_volume,true),(&order.unit_price,true),(&order.fee_rate,false)]{
            let n=parse_decimal_u64(value,"request.intent.order")?;
            if n>i64::MAX as u64||(positive&&n==0){return Err(invalid("LOP numeric term outside signed contract range"));}
        }
        let address=tbc_sdk::Address::from_string(&order.fee_recipient).map_err(|_|invalid("LOP fee recipient invalid"))?;
        if address.to_string()!=order.fee_recipient{return Err(invalid("LOP fee recipient must be canonical"));}
        return Ok(());
    }
    if fields.as_object().unwrap().keys().any(|k|!matches!(k.as_str(),"type"|"version"|"targetOutpoints")){
        return Err(invalid("LOP operation permits only exact order targets"));
    }
    let count=if request.intent.intent_type=="tbc-lop-match"{2}else{1};
    let points=request.intent.target_outpoints.as_ref().ok_or_else(||invalid("LOP requires exact order targets"))?;
    if points.len()!=count||points.iter().any(|p|p.txid.len()!=64||!p.txid.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)))
        ||(count==2&&points[0].txid==points[1].txid&&points[0].vout==points[1].vout){
        return Err(invalid("LOP requires distinct canonical order targets in buy/sell order"));
    }Ok(())
}

enum Anchor{Ft(tbc20::TokenIdentity),Coin(coin_identity::IssuerIdentity)}
struct CreateAsset{anchor:Anchor,profile:TokenProfile,id:String,script:Vec<u8>,identity:Vec<u8>}
fn create_asset(asset:&crate::model::LopAsset,material:&WalletMaterial<'_>,parents:&mut Parents<'_>)->Result<CreateAsset,EngineError>{
    let id=&asset.contract_id;
    let (anchor,profile,script,identity)=if asset.standard=="tbc20-standard"{
        let genesis=tbc20::trusted_token_identity(id,material,parents)?;
        let script=genesis.script.clone();
        let identity=genesis.identity().to_vec();(Anchor::Ft(genesis),TokenProfile::Tbc20,script,identity)
    }else{
        let issuer=coin::trusted_issuer(id,material,parents)?;
        let record=material.snapshot.payload.contracts.iter().find(|r|r.contract_id==*id).unwrap();
        if let Some(indexed)=&record.indexed_fungible{
            let script=decode_hex(&indexed.code_script,"snapshot.payload.contracts.indexedFungible.codeScript")?;
            let identity=crate::protocols::coin::code_identity(&script).map_err(|_|material_error("LOP indexed Coin identity invalid"))?;
            return Ok(CreateAsset{anchor:Anchor::Coin(issuer),profile:TokenProfile::Coin,id:id.clone(),script,identity});
        }
        // A non-spent market asset needs an authenticated Code sample, not
        // current spendability or an account-owned balance. This is read from
        // bound material; no history walk or network fetch is performed here.
        let point=&material.snapshot.payload.contracts.iter().find(|r|r.contract_id==*id).unwrap().current_outpoint;
        let outpoint=OutPoint{txid:point.txid.parse().map_err(|_|material_error("LOP Coin reference ID invalid"))?,vout:point.vout};
        let sample=coin_proof::inspect_parent(parents.bytes(&point.txid)?,&outpoint,None)?;
        coin_identity::validate_holder_identity(&issuer,&sample)?;
        let script=sample.transaction().outputs[point.vout as usize].script_pubkey.as_bytes().to_vec();
        (Anchor::Coin(issuer),TokenProfile::Coin,script,sample.identity().to_vec())
    };
    Ok(CreateAsset{anchor,profile,id:id.clone(),script,identity})
}
fn asset_terms(asset:&CreateAsset)->Result<crate::protocols::lop::AssetTerms,EngineError>{
    Ok(crate::protocols::lop::AssetTerms{partial_hash:asset.identity[..32].try_into().unwrap(),
        contract_id:decode_hex(&asset.id,"request.intent.order")?.try_into().map_err(|_|invalid("LOP asset ID width invalid"))?})
}
fn create_amount_policy(request:&CanonicalRequest,material:&WalletMaterial<'_>,asset:&CreateAsset,total:u128,slots:impl IntoIterator<Item=u64>)->Result<(),EngineError>{
    let mut asset_request=request.clone();asset_request.intent.contract_id=Some(asset.id.clone());
    match asset.profile{TokenProfile::Tbc20=>tbc20::check_shared_amount_policy(&asset_request,material,total,slots),
        TokenProfile::Coin=>coin::check_policy(material,&asset_request,total,slots.into_iter())}
}
struct Deposit{parent:Transaction,vout:u32,ancestors:Vec<Transaction>}
fn deposit_inputs(request:&CanonicalRequest,material:&WalletMaterial<'_>,parents:&mut Parents<'_>,asset:&CreateAsset,public:&PublicKey,wanted:u128)->Result<Vec<Deposit>,EngineError>{
    let exact=request.constraints.as_ref().and_then(|c|c.input_outpoints.as_ref()).is_some();
    let mut rows:Vec<_>=material.snapshot.payload.utxos.iter().filter(|u|u.contract_id.as_deref()==Some(&asset.id)).collect();
    rows.sort_by(|a,b|(&a.txid,a.vout).cmp(&(&b.txid,b.vout)));
    let mut seen=BTreeSet::new();let mut result=vec![];let mut total=0u128;let mut owner=[0;21];owner[..20].copy_from_slice(&public.hash160());
    for row in rows{
        if !seen.insert((&row.txid,row.vout)){return Err(material_error("LOP deposit descriptor repeated"));}
        if !permitted(request,&row.txid,row.vout)||(!exact&&total>=wanted){continue;}
        selected(material,request,&row.txid,row.vout)?;
        if row.classification!=if asset.profile==TokenProfile::Tbc20{"ft"}else{"stablecoin"}{return Err(material_error("LOP deposit classification differs from explicit standard"));}
        let point=OutPoint{txid:row.txid.parse().map_err(|_|material_error("LOP deposit ID invalid"))?,vout:row.vout};
        let raw=parents.bytes(&row.txid)?;
        let (parent,controller,balance,slots,dependencies)=match &asset.anchor{
            Anchor::Ft(genesis)=>{
                let p=tbc20_material::inspect_parent(raw,&point,Some(&asset.identity))?;
                if p.tape().extension!=genesis.tape().extension{return Err(material_error("LOP deposit metadata differs from issuance"));}
                (p.transaction().clone(),p.code().controller,p.tape().balance,p.tape().amounts,
                    p.dependencies().iter().map(|d|d.outpoint.txid.to_string()).collect::<BTreeSet<_>>())
            },
            Anchor::Coin(issuer)=>{
                let p=coin_proof::inspect_parent(raw,&point,Some(&asset.identity))?;coin_identity::validate_holder_identity(issuer,&p)?;
                (p.transaction().clone(),p.code().controller,p.tape().balance,p.tape().amounts,
                    p.dependencies().iter().map(|d|d.txid.to_string()).collect::<BTreeSet<_>>())
            },
        };
        check_output(row,&parent)?;
        if controller!=owner{return Err(material_error("LOP deposit is not account controlled"));}
        total=total.checked_add(balance).ok_or_else(||invalid("LOP deposit balance overflow"))?;
        create_amount_policy(request,material,asset,total,slots)?;
        if result.len()==5{return Err(invalid("LOP Token creation supports at most five selected asset inputs"));}
        let ancestors=dependencies.iter().map(|id|transaction(parents,id)).collect::<Result<Vec<_>,_>>()?;
        result.push(Deposit{parent,vout:row.vout,ancestors});
    }
    if result.is_empty()||total<wanted{return Err(error(ErrorCode::InsufficientFunds,"LOP authenticated deposit balance insufficient","snapshot.payload.utxos"));}
    Ok(result)
}

pub(crate) fn plan_create(request:&CanonicalRequest,material:&WalletMaterial<'_>,signing:&PublicSigningContext)->Result<PlannedTransfer,EngineError>{
    use crate::protocols::lop::{Terms,TapeMarker};
    validate_request(request)?;validate_material_identity(request,material)?;
    let policy=&material.policy.payload;
    if policy.chain_id!=request.chain_id||policy.fee_rate_sat_per_kb!="80"||policy.dust_threshold!="42"||policy.sighash_type!=65{
        return Err(invalid("LOP creation policy requires 80 atomic/kB, dust42 and sighash65"));
    }
    let public=PublicKey::from_slice(&decode_hex(&signing.public_key,"snapshot.payload.account.publicKey")?).map_err(|_|material_error("LOP account key invalid"))?;
    let order=request.intent.order.as_ref().unwrap();let mut parents=Parents::new(material)?;
    let a=create_asset(&order.asset_a,material,&mut parents)?;
    let b=order.asset_b.as_ref().map(|asset|create_asset(asset,material,&mut parents)).transpose()?;
    for asset in std::iter::once(&a).chain(b.iter()){create_amount_policy(request,material,asset,0,[])?;}
    let code=Code{side:if order.side=="sell"{Side::Sell}else{Side::Buy},
        market:if b.is_some(){Market::TokenToken{a:TapeMarker::Modern,b:TapeMarker::Modern}}else{Market::NativeToken{token_code_bytes:u16::try_from(a.script.len()).map_err(|_|invalid("LOP Token Code size overflow"))?,marker:TapeMarker::Modern}},
        tax_hash:tbc_sdk::Address::from_string(&order.fee_recipient).map_err(|_|invalid("LOP fee recipient invalid"))?.hash160(),
        terms:Terms{owner_hash:public.hash160(),sale_volume:parse_decimal_u64(&order.sale_volume,"request.intent.order.saleVolume")?,
            unit_price:parse_decimal_u64(&order.unit_price,"request.intent.order.unitPrice")?,fee_rate:parse_decimal_u64(&order.fee_rate,"request.intent.order.feeRate")?,
            asset_a:asset_terms(&a)?,asset_b:b.as_ref().map(asset_terms).transpose()?}};
    let native=b.is_none()&&code.side==Side::Sell;
    let asset=if code.side==Side::Buy{b.as_ref().unwrap_or(&a)}else{&a};
    let amount=if code.side==Side::Sell{u128::from(code.terms.sale_volume)}else{u128::from(code.terms.sale_volume)*u128::from(code.terms.unit_price)/1_000_000};
    if amount==0{return Err(invalid("LOP escrow amount rounds to zero"));}
    if native{super::tbc::validate_amount_limit(code.terms.sale_volume,policy)?;}
    let deposits=if native{vec![]}else{deposit_inputs(request,material,&mut parents,asset,&public,amount)?};
    let refs:Vec<Vec<_>>=deposits.iter().map(|d|d.ancestors.iter().collect()).collect();
    let inputs:Vec<_>=deposits.iter().zip(&refs).map(|(d,ancestors)|TokenInput{parent:&d.parent,vout:d.vout,ancestors}).collect();
    let block=material.snapshot.payload.block.as_ref();
    let chain=ChainContext{height:block.map(|b|parse_decimal_u64(&b.height,"snapshot.payload.block.height")).transpose()?,
        median_time_past:block.and_then(|b|b.median_time_past.as_deref()).map(|v|parse_decimal_u64(v,"snapshot.payload.block.medianTimePast")).transpose()?};
    let mut funding=funding_candidates(material,signing)?;funding.retain(|u|permitted(request,&u.txid,u.vout));
    funding.sort_by(|a,b|(a.satoshis,&a.txid,a.vout).cmp(&(b.satoshis,&b.txid,b.vout)));
    let exact=request.constraints.as_ref().and_then(|c|c.input_outpoints.as_ref()).is_some();
    if !native&&exact&&funding.len()!=1{return Err(invalid("LOP Token creation requires one selected fee input"));}
    let maximum=max_fee(request)?;let mut native_inputs=vec![];let mut last=None;
    for(index,f)in funding.iter().enumerate(){
        let out=TxOut{satoshis:f.satoshis,script_pubkey:Script::from_bytes(decode_hex(&f.script,"snapshot.payload.utxos.scriptPubKey")?)};
        let point=OutPoint{txid:f.txid.parse().map_err(|_|material_error("LOP funding ID invalid"))?,vout:f.vout};
        let built=if native{
            native_inputs.push(UtxoInfo{outpoint:point,satoshis:out.satoshis,script_pubkey:out.script_pubkey});
            if exact&&index+1!=funding.len(){continue;}
            lop_transaction::build_native_sell_plan(&native_inputs,&public,&code,&a.script,maximum)
        }else{
            let fee=FeeInput{outpoint:point,output:&out,public_key:&public};
            lop_token::build_make_plan(lop_token::MakeOptions{profile:asset.profile,inputs:&inputs,funding:&fee,expected_identity:&asset.identity,
                code:&code,asset_a_code:&a.script,asset_b_code:b.as_ref().map(|v|v.script.as_slice()),chain,max_fee:maximum})
        };
        let built=match built{Ok(v)=>v,Err(e)if matches!(e.code,ErrorCode::InsufficientFunds|ErrorCode::FeeCapExceeded)=>{last=Some(e);continue;},Err(e)=>return Err(e)};
        if !native{
            for output in &built.unsigned_plan.transactions[0].outputs{
                if output.satoshis!=0{continue;}
                let tape=decode_hex(&output.locking_script,"plan.outputs")?;
                let (balance,slots)=match asset.profile{
                    TokenProfile::Tbc20=>{let t=crate::protocols::tbc20::parse_tape(&tape).map_err(|_|material_error("LOP output Tape invalid"))?;(t.balance,t.amounts)},
                    TokenProfile::Coin=>{let t=crate::protocols::coin::parse_tape(&tape,None).map_err(|_|material_error("LOP Coin output Tape invalid"))?;(t.balance,t.amounts)},
                };
                create_amount_policy(request,material,asset,balance,slots)?;
            }
        }
        return finish(request,material,built.unsigned_plan,vec![built.fee],vec![AssetFlow{kind:if native{"native"}else if asset.profile==TokenProfile::Tbc20{"ft"}else{"stablecoin"}.into(),
            direction:"lock".into(),amount:amount.to_string(),contract_id:(!native).then(||asset.id.clone()),from:request.from.clone(),to:None}]);
    }
    Err(last.unwrap_or_else(||error(ErrorCode::InsufficientFunds,"LOP creation requires native fee funding","snapshot.payload.utxos")))
}

struct Escrow {
    profile:TokenProfile,identity:Vec<u8>,ancestors:Vec<Transaction>,amount:u128,id:String,
}
/// Only the actually spent asset is resolved. Ancestors are deduplicated and
/// fetched from the caller's already bound material, never by network here.
fn escrow(request:&CanonicalRequest,material:&WalletMaterial<'_>,parents:&mut Parents<'_>,parent:&Transaction,vout:u32,code:&Code)->Result<Escrow,EngineError>{
    let id_tx=parent.txid().to_string();
    let u=selected(material,request,&id_tx,vout)?;check_output(u,parent)?;
    let terms=if code.side==Side::Buy&&matches!(code.market,Market::TokenToken{..}){code.terms.asset_b.as_ref().unwrap()}else{&code.terms.asset_a};
    let id=hex(&terms.contract_id);
    if u.contract_id.as_deref()!=Some(id.as_str()){return Err(material_error("LOP escrow asset ID differs from committed order"));}
    let point=OutPoint{txid:parent.txid(),vout};let raw=parent.serialize();
    let (profile,identity,amount,slots,dependencies)=if u.classification=="ft"{
        let genesis=tbc20::trusted_token_identity(&id,material,parents)?;
        let p=tbc20_material::inspect_parent(&raw,&point,Some(genesis.identity()))?;
        if p.tape().extension!=genesis.tape().extension{return Err(material_error("LOP FT metadata differs from issuance"));}
        (TokenProfile::Tbc20,p.identity().to_vec(),p.tape().balance,p.tape().amounts,p.dependencies().iter().map(|p|p.outpoint.txid.to_string()).collect::<BTreeSet<_>>())
    }else if u.classification=="stablecoin"{
        let issuer=coin::trusted_issuer(&id,material,parents)?;let p=coin_proof::inspect_parent(&raw,&point,None)?;
        coin_identity::validate_holder_identity(&issuer,&p)?;
        (TokenProfile::Coin,p.identity().to_vec(),p.tape().balance,p.tape().amounts,p.dependencies().iter().map(|p|p.txid.to_string()).collect::<BTreeSet<_>>())
    }else{return Err(material_error("LOP escrow must use an explicit current Token standard"));};
    let mut asset_request=request.clone();asset_request.intent.contract_id=Some(id.clone());
    match profile{TokenProfile::Tbc20=>tbc20::check_shared_amount_policy(&asset_request,material,amount,slots)?,
        TokenProfile::Coin=>coin::check_policy(material,&asset_request,amount,slots.into_iter())?,}
    let ancestors=dependencies.iter().map(|id|transaction(parents,id)).collect::<Result<Vec<_>,_>>()?;
    Ok(Escrow{profile,identity,ancestors,amount,id})
}

pub(crate) fn plan_match(request:&CanonicalRequest,material:&WalletMaterial<'_>,signing:&PublicSigningContext)->Result<PlannedTransfer,EngineError>{
    use crate::protocols::{lop_match::{self,MatchOptions,OrderInput,AssetInput},lop_settlement::quote_match};
    validate_request(request)?;validate_material_identity(request,material)?;
    let policy=&material.policy.payload;
    if policy.chain_id!=request.chain_id||policy.fee_rate_sat_per_kb!="80"||policy.dust_threshold!="42"||policy.sighash_type!=65{
        return Err(invalid("LOP matching policy requires 80 atomic/kB, dust42 and sighash65"));
    }
    let public=PublicKey::from_slice(&decode_hex(&signing.public_key,"snapshot.payload.account.publicKey")?).map_err(|_|material_error("LOP matcher account key invalid"))?;
    let targets=request.intent.target_outpoints.as_ref().unwrap();let mut parents=Parents::new(material)?;
    let mut orders=vec![];
    for (target,side) in targets.iter().zip([Side::Buy,Side::Sell]){
        let row=selected(material,request,&target.txid,target.vout)?;
        let parent=transaction(&mut parents,&target.txid)?;check_output(row,&parent)?;
        if row.classification!="lop"||row.contract_id.is_some(){return Err(material_error("LOP order classification invalid"));}
        let code=Code::decode(parent.outputs[target.vout as usize].script_pubkey.as_bytes()).map_err(|_|material_error("LOP requires an exact current order template"))?;
        if code.side!=side{return Err(invalid("LOP match targets must be ordered buy then sell"));}
        orders.push((parent,code));
    }
    let (buy,buy_code)=&orders[0];let (sell,sell_code)=&orders[1];
    let quote_vout=targets[0].vout.checked_add(1).ok_or_else(||invalid("LOP quote output index overflow"))?;
    let quote=escrow(request,material,&mut parents,buy,quote_vout,buy_code)?;
    let base=if matches!(buy_code.market,Market::NativeToken{..}){None}else{
        Some(escrow(request,material,&mut parents,sell,targets[1].vout.checked_add(1).ok_or_else(||invalid("LOP base output index overflow"))?,sell_code)?)
    };
    let native_amount=sell.outputs[targets[1].vout as usize].satoshis;
    if base.is_none(){super::tbc::validate_amount_limit(native_amount,policy)?;}
    let narrow=|n:u128|u64::try_from(n).map_err(|_|invalid("LOP escrow amount exceeds u64"));
    let settlement=quote_match(buy_code,sell_code,match &base{Some(a)=>narrow(a.amount)?,None=>native_amount},narrow(quote.amount)?)
        .map_err(|_|invalid("LOP order terms or escrow cannot settle"))?;
    let quote_refs:Vec<_>=quote.ancestors.iter().collect();let base_refs:Vec<_>=base.as_ref().map(|a|a.ancestors.iter().collect()).unwrap_or_default();
    let block=material.snapshot.payload.block.as_ref();
    let chain=ChainContext{height:block.map(|b|parse_decimal_u64(&b.height,"snapshot.payload.block.height")).transpose()?,
        median_time_past:block.and_then(|b|b.median_time_past.as_deref()).map(|v|parse_decimal_u64(v,"snapshot.payload.block.medianTimePast")).transpose()?};
    let mut funding=funding_candidates(material,signing)?;funding.retain(|u|permitted(request,&u.txid,u.vout));
    funding.sort_by(|a,b|(a.satoshis,&a.txid,a.vout).cmp(&(b.satoshis,&b.txid,b.vout)));
    if request.constraints.as_ref().and_then(|c|c.input_outpoints.as_ref()).is_some()&&funding.len()!=1{return Err(invalid("LOP matching requires exactly one selected fee input"));}
    let maximum=max_fee(request)?;let mut last=None;
    for f in funding{
        let output=TxOut{satoshis:f.satoshis,script_pubkey:Script::from_bytes(decode_hex(&f.script,"snapshot.payload.utxos.scriptPubKey")?)};
        let fee=FeeInput{outpoint:OutPoint{txid:f.txid.parse().map_err(|_|material_error("LOP funding outpoint invalid"))?,vout:f.vout},output:&output,public_key:&public};
        let built=lop_match::build_match_plan(MatchOptions{
            buy:OrderInput{parent:buy,vout:targets[0].vout},sell:OrderInput{parent:sell,vout:targets[1].vout},
            quote:AssetInput{profile:quote.profile,token:TokenInput{parent:buy,vout:quote_vout,ancestors:&quote_refs},expected_identity:&quote.identity},
            base:base.as_ref().map(|a|AssetInput{profile:a.profile,token:TokenInput{parent:sell,vout:targets[1].vout+1,ancestors:&base_refs},expected_identity:&a.identity}),funding:&fee,chain,max_fee:maximum});
        let built=match built{Ok(p)=>p,Err(e)if matches!(e.code,ErrorCode::InsufficientFunds|ErrorCode::FeeCapExceeded)=>{last=Some(e);continue;},Err(e)=>return Err(e)};
        let address=|hash:&[u8;20]|tbc_sdk::Address::from_hash160(*hash).to_string();
        let flow=|kind:&str,id:Option<String>,amount:u64,from:&[u8;20],to:&[u8;20]|AssetFlow{kind:kind.into(),direction:"send".into(),amount:amount.to_string(),contract_id:id,from:address(from),to:Some(address(to))};
        let quote_kind=if quote.profile==TokenProfile::Tbc20{"ft"}else{"stablecoin"};
        let base_kind=match &base{None=>"native",Some(a)if a.profile==TokenProfile::Tbc20=>"ft",Some(_)=>"stablecoin"};
        let base_id=base.as_ref().map(|a|a.id.clone());
        let mut flows=vec![flow(quote_kind,Some(quote.id.clone()),settlement.b_to_seller,&buy_code.terms.owner_hash,&sell_code.terms.owner_hash),
            flow(base_kind,base_id.clone(),settlement.a_to_buyer,&sell_code.terms.owner_hash,&buy_code.terms.owner_hash)];
        if settlement.b_tax>0{flows.push(flow(quote_kind,Some(quote.id.clone()),settlement.b_tax,&buy_code.terms.owner_hash,&sell_code.tax_hash));}
        if settlement.a_tax>0{flows.push(flow(base_kind,base_id,settlement.a_tax,&sell_code.terms.owner_hash,&buy_code.tax_hash));}
        return finish(request,material,built.unsigned_plan,vec![built.fee],flows);
    }
    Err(last.unwrap_or_else(||error(ErrorCode::InsufficientFunds,"LOP matching requires native fee funding","snapshot.payload.utxos")))
}
fn selected<'a>(material:&'a WalletMaterial<'_>,request:&CanonicalRequest,txid:&str,vout:u32)->Result<&'a WalletUtxo,EngineError>{
    let rows:Vec<_>=material.snapshot.payload.utxos.iter().filter(|u|u.txid==txid&&u.vout==vout).collect();
    if rows.len()!=1||!permitted(request,txid,vout){return Err(material_error("LOP requires one unambiguous current selected UTXO"));}
    let row=rows[0];let minimum=parse_decimal_u64(&material.policy.payload.min_confirmations,"policy.payload.minConfirmations")?;
    if !crate::confirmations::meets_minimum(row.confirmations.as_deref(),minimum,"snapshot.payload.utxos.confirmations")?{
        return Err(material_error("LOP selected UTXO does not meet confirmation policy"));
    }Ok(row)
}
fn transaction(parents:&mut Parents<'_>,id:&str)->Result<Transaction,EngineError>{
    let raw=parents.bytes(id)?;let tx=Transaction::from_bytes(raw).map_err(|_|material_error("LOP parent malformed"))?;
    if tx.serialize()!=raw||tx.txid().to_string()!=id{return Err(material_error("LOP parent ID/canonical bytes mismatch"));}Ok(tx)
}
fn check_output(row:&WalletUtxo,parent:&Transaction)->Result<(),EngineError>{
    let out=parent.outputs.get(row.vout as usize).ok_or_else(||material_error("LOP selected output missing"))?;
    if row.satoshis!=out.satoshis.to_string()||row.script_pub_key!=hex(out.script_pubkey.as_bytes()){
        return Err(material_error("LOP current UTXO descriptor differs from parent"));
    }Ok(())
}
pub(crate) fn plan_cancel(request:&CanonicalRequest,material:&WalletMaterial<'_>,signing:&PublicSigningContext)->Result<PlannedTransfer,EngineError>{
    validate_request(request)?;validate_material_identity(request,material)?;
    let policy=&material.policy.payload;
    if policy.chain_id!=request.chain_id||policy.fee_rate_sat_per_kb!="80"||policy.dust_threshold!="42"||policy.sighash_type!=65{
        return Err(invalid("LOP cancellation policy requires 80 atomic/kB, dust42 and sighash65"));
    }
    let public=PublicKey::from_slice(&decode_hex(&signing.public_key,"snapshot.payload.account.publicKey")?).map_err(|_|material_error("LOP account key invalid"))?;
    let target=&request.intent.target_outpoints.as_ref().unwrap()[0];let mut parents=Parents::new(material)?;
    let row=selected(material,request,&target.txid,target.vout)?;let parent=transaction(&mut parents,&target.txid)?;check_output(row,&parent)?;
    if row.classification!="lop"||row.contract_id.is_some(){return Err(material_error("LOP order classification invalid"));}
    let code=Code::decode(parent.outputs[target.vout as usize].script_pubkey.as_bytes()).map_err(|_|material_error("LOP requires an exact current order template"))?;
    if code.terms.owner_hash!=public.hash160(){return Err(material_error("LOP cancellation requires the order owner's account"));}
    let native=code.side==Side::Sell&&matches!(code.market,Market::NativeToken{..});
    let maximum=max_fee(request)?;let mut funding=funding_candidates(material,signing)?;
    funding.retain(|u|permitted(request,&u.txid,u.vout));funding.sort_by(|a,b|(a.satoshis,&a.txid,a.vout).cmp(&(b.satoshis,&b.txid,b.vout)));
    let exact=request.constraints.as_ref().and_then(|c|c.input_outpoints.as_ref()).is_some();
    let (profile,identity,ancestors,amount,asset_id)=if native{
        let amount=parent.outputs[target.vout as usize].satoshis;super::tbc::validate_amount_limit(amount,policy)?;
        (TokenProfile::Tbc20,vec![],vec![],amount.to_string(),None)
    }else{
        let vout=target.vout.checked_add(1).ok_or_else(||invalid("LOP asset output index overflow"))?;
        let asset=escrow(request,material,&mut parents,&parent,vout,&code)?;
        (asset.profile,asset.identity,asset.ancestors,asset.amount.to_string(),Some(asset.id))
    };
    let block=material.snapshot.payload.block.as_ref();
    let chain=ChainContext{height:block.map(|b|parse_decimal_u64(&b.height,"snapshot.payload.block.height")).transpose()?,
        median_time_past:block.and_then(|b|b.median_time_past.as_deref()).map(|v|parse_decimal_u64(v,"snapshot.payload.block.medianTimePast")).transpose()?};
    let refs:Vec<_>=ancestors.iter().collect();let mut native_inputs=vec![];let mut last=None;
    for (index,f) in funding.iter().enumerate(){
        let out=TxOut{satoshis:f.satoshis,script_pubkey:Script::from_bytes(decode_hex(&f.script,"snapshot.payload.utxos.scriptPubKey")?)};
        let point=OutPoint{txid:f.txid.parse().map_err(|_|material_error("LOP funding outpoint invalid"))?,vout:f.vout};
        let built=if native{
            native_inputs.push(UtxoInfo{outpoint:point,satoshis:out.satoshis,script_pubkey:out.script_pubkey});
            if exact&&index+1!=funding.len(){continue;}
            let order=UtxoInfo{outpoint:OutPoint{txid:parent.txid(),vout:target.vout},satoshis:parent.outputs[target.vout as usize].satoshis,script_pubkey:parent.outputs[target.vout as usize].script_pubkey.clone()};
            lop_transaction::build_native_cancel_plan(&order,&native_inputs,&public,maximum)
        }else{
            if exact&&funding.len()!=1{return Err(invalid("LOP Token cancellation requires exactly one selected fee input"));}
            let fee=FeeInput{outpoint:point,output:&out,public_key:&public};
            lop_token::build_cancel_plan(CancelOptions{profile,token:TokenInput{parent:&parent,vout:target.vout+1,ancestors:&refs},order_vout:target.vout,
                funding:&fee,expected_identity:&identity,chain,max_fee:maximum})
        };
        let built=match built{Ok(b)=>b,Err(e)if matches!(e.code,ErrorCode::InsufficientFunds|ErrorCode::FeeCapExceeded)=>{last=Some(e);continue;},Err(e)=>return Err(e)};
        return finish(request,material,built.unsigned_plan,vec![built.fee],vec![AssetFlow{kind:if native{"native"}else if profile==TokenProfile::Tbc20{"ft"}else{"stablecoin"}.into(),
            direction:"unlock".into(),amount,contract_id:asset_id,from:request.from.clone(),to:Some(request.from.clone())}]);
    }
    Err(last.unwrap_or_else(||error(ErrorCode::InsufficientFunds,"LOP cancellation requires native fee funding","snapshot.payload.utxos")))
}
