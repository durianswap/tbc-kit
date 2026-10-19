//! Bounded local LOP read hints over the planner's exact codecs. No I/O,
//! custody, availability assertion, signature or replacement for plan validation.
use serde::Deserialize;
use serde_json::{Value,json};
use tbc_sdk::{Transaction,OutPoint};
use tbc_engine_core::protocols::{lop::{Code,Market,Side,AssetTerms,PRICE_SCALE},tbc20_material,coin_proof,coin_identity};

#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Raw{txid:String,raw_transaction:String}
#[derive(Deserialize)]
#[serde(tag="phase",rename_all="camelCase",rename_all_fields="camelCase",deny_unknown_fields)]
enum Request{
    InspectOrderScripts{scripts:Vec<String>},
    InspectOrder{parent:Raw,vout:u32},
    InspectAsset{parent:Raw,vout:u32},
    CoinSample{issuer:Raw,parent:Raw},
}
fn token_terms(asset:&AssetTerms)->Value{
    json!({"kind":"token","partialHash":hex::encode(asset.partial_hash),"contractId":hex::encode(asset.contract_id)})
}
/// Exact local script semantics, not asset-origin, availability or spend proof.
/// Keep integer fields as decimal strings through Native/WASM and JS UI layers.
fn order_terms(code:&Code)->Value{
    let (base,quote)=match code.market{
        Market::NativeToken{..}=>(json!({"kind":"native"}),token_terms(&code.terms.asset_a)),
        Market::TokenToken{..}=>(token_terms(&code.terms.asset_a),token_terms(code.terms.asset_b.as_ref().unwrap())),
    };
    json!({"standardId":"tbc-lop","side":if code.side==Side::Buy{"buy"}else{"sell"},
        "market":if matches!(code.market,Market::NativeToken{..}){"native-token"}else{"token-token"},
        "ownerHash":hex::encode(code.terms.owner_hash),"feeRecipientHash":hex::encode(code.tax_hash),
        "saleVolume":code.terms.sale_volume.to_string(),"unitPrice":code.terms.unit_price.to_string(),
        "feeRate":code.terms.fee_rate.to_string(),"priceScale":PRICE_SCALE.to_string(),"feeScale":PRICE_SCALE.to_string(),
        "baseAsset":base,"quoteAsset":quote})
}
fn transaction(raw:&Raw)->Result<Transaction,String>{
    if raw.txid.len()!=64||raw.raw_transaction.is_empty()||raw.raw_transaction.len()>2*1_048_576{return Err("LOP material size invalid".into());}
    let bytes=hex::decode(&raw.raw_transaction).map_err(|_|"LOP raw invalid")?;
    if hex::encode(&bytes)!=raw.raw_transaction{return Err("LOP raw must be canonical hex".into());}
    let tx=Transaction::from_bytes(&bytes).map_err(|_|"LOP raw malformed")?;
    if tx.serialize()!=bytes||tx.txid().to_string()!=raw.txid{return Err("LOP raw identity mismatch".into());}Ok(tx)
}
fn asset(tx:&Transaction,vout:u32)->Result<Value,String>{
    let raw=tx.serialize();let point=OutPoint{txid:tx.txid(),vout};
    let (standard,identity,controller,balance,lock,dependencies)=if let Ok(p)=tbc20_material::inspect_parent(&raw,&point,None){
        ("tbc20-standard",p.identity().to_vec(),p.code().controller,p.tape().balance,0,
            p.dependencies().iter().map(|d|json!({"txid":d.outpoint.txid.to_string(),"vout":d.outpoint.vout})).collect::<Vec<_>>())
    }else{
        let p=coin_proof::inspect_parent(&raw,&point,None).map_err(|_|"LOP requires an exact current Token Code/Tape")?;
        ("tbc20-stablecoin",p.identity().to_vec(),p.code().controller,p.tape().balance,p.tape().lock_time,
            p.dependencies().iter().map(|d|json!({"txid":d.txid.to_string(),"vout":d.vout})).collect::<Vec<_>>())
    };
    Ok(json!({"txid":tx.txid().to_string(),"vout":vout,"standardId":standard,"partialHash":hex::encode(&identity[..32]),
        "controller":hex::encode(controller),"balance":balance.to_string(),"lockTime":lock,"dependencies":dependencies,
        "scriptPubKey":hex::encode(tx.outputs[vout as usize].script_pubkey.as_bytes())}))
}
pub fn inspect(request:&str)->Result<String,String>{
    if request.len()>8*1_048_576{return Err("LOP request exceeds byte bound".into());}
    let request:Request=serde_json::from_str(request).map_err(|_|"Invalid LOP material request")?;
    let result=match request{
        Request::InspectOrderScripts{scripts}=>{
            if scripts.is_empty()||scripts.len()>256{return Err("LOP script batch bound exceeded".into());}
            let mut results=Vec::with_capacity(scripts.len());
            let mut controllers=Vec::with_capacity(scripts.len());
            for script in scripts{
                if script.len()>2*65_536{return Err("LOP script byte bound exceeded".into());}
                let bytes=hex::decode(&script).map_err(|_|"LOP script hex invalid")?;
                if hex::encode(&bytes)!=script{return Err("LOP script must be canonical hex".into());}
                let code=Code::decode(&bytes).ok();
                results.push(code.as_ref().map(order_terms));
                controllers.push(code.as_ref().map(|c|c.token_controller().map(hex::encode)).transpose().map_err(|_|"LOP controller invalid")?);
            }
            json!({"orders":results,"controllers":controllers})
        },
        Request::InspectAsset{parent,vout}=>asset(&transaction(&parent)?,vout)?,
        Request::InspectOrder{parent,vout}=>{
            let tx=transaction(&parent)?;let output=tx.outputs.get(vout as usize).ok_or("LOP order output missing")?;
            let code=Code::decode(output.script_pubkey.as_bytes()).map_err(|_|"LOP order template invalid")?;
            let native_sell=matches!(code.market,Market::NativeToken{..})&&code.side==Side::Sell;
            let selected=if native_sell{None}else{
                let next=vout.checked_add(1).ok_or("LOP output index overflow")?;
                let mut a=asset(&tx,next)?;
                let terms=if code.side==Side::Buy&&matches!(code.market,Market::TokenToken{..}){code.terms.asset_b.as_ref().unwrap()}else{&code.terms.asset_a};
                if a["partialHash"]!=hex::encode(terms.partial_hash){return Err("LOP escrow Code identity differs from order".into());}
                let mut controller=code.token_controller().map_err(|_|"LOP controller invalid")?.to_vec();controller.push(1);
                if a["controller"]!=hex::encode(controller)||output.satoshis!=300{return Err("LOP order/escrow linkage invalid".into());}
                a["contractId"]=json!(hex::encode(terms.contract_id));Some(a)
            };
            json!({"standardId":"tbc-lop","txid":parent.txid,"vout":vout,"side":if code.side==Side::Buy{"buy"}else{"sell"},
                "market":if matches!(code.market,Market::NativeToken{..}){"native-token"}else{"token-token"},
                "ownerHash":hex::encode(code.terms.owner_hash),"feeRecipientHash":hex::encode(code.tax_hash),
                "saleVolume":code.terms.sale_volume.to_string(),"unitPrice":code.terms.unit_price.to_string(),"feeRate":code.terms.fee_rate.to_string(),
                "satoshis":output.satoshis.to_string(),"scriptPubKey":hex::encode(output.script_pubkey.as_bytes()),"escrow":selected,
                "orderTerms":order_terms(&code)})
        },
        Request::CoinSample{issuer,parent}=>{
            let origin=transaction(&issuer)?;let tx=transaction(&parent)?;
            let identity=coin_identity::inspect_issuer(&origin.txid(),&origin.serialize()).map_err(|e|e.message)?;
            if tx.outputs.len()>128{return Err("LOP Coin sample output bound exceeded".into());}
            let mut found=None;let bytes=tx.serialize();let txid=tx.txid();
            for vout in 0..tx.outputs.len(){
                let point=OutPoint{txid,vout:vout as u32};
                if let Ok(p)=coin_proof::inspect_parent(&bytes,&point,None){
                    if coin_identity::validate_holder_identity(&identity,&p).is_ok(){found=Some(asset(&tx,vout as u32)?);break;}
                }
            }
            found.ok_or("Coin state has no issuer-bound holder Code sample")?
        },
    };serde_json::to_string(&result).map_err(|_|"LOP material encoding failed".into())
}
