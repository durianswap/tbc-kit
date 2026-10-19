//! Public synthetic material; never dump requests or unlocking scripts.
use serde_json::{Value, json};
use tbc_sdk::{Address, OutPoint, Transaction, TxIn, TxOut, Txid,
    contracts::nft::{CollectionData, NftData, scripts as nft}};

fn native() -> TxOut { TxOut {satoshis:100_000, script_pubkey:Address::from_hash160([1;20]).script_pubkey()} }
fn parent() -> Transaction { let mut tx=Transaction::new(); tx.outputs.push(native()); tx }
fn spend(parent:&Transaction, outputs:Vec<TxOut>) -> Transaction {
    let mut tx=Transaction::new();
    tx.inputs.push(TxIn::new(OutPoint {txid:parent.txid(), vout:0})); tx.outputs=outputs; tx
}
fn request(txs:&[Transaction], parents:&[Transaction]) -> Value {
    json!({"phase":"checkHistoricalIssuance", "transactions":txs.iter().map(|tx|json!({"rawTransaction":tx.to_hex()})).collect::<Vec<_>>(),
        "resolvedOutputs":parents.iter().flat_map(|tx|tx.outputs.iter().enumerate().map(move |(vout,out)|json!({
            "txid":tx.txid().to_string(),"vout":vout,"satoshis":out.satoshis.to_string(),"scriptPubKey":hex::encode(out.script_pubkey.as_bytes())
        }))).collect::<Vec<_>>()})
}
fn call(r:&Value)->Result<Value,String> {
    tbc_keyless_core::call("inspectTokenMaterial",&r.to_string()).and_then(|s|serde_json::from_str(&s).map_err(|_|"invalid response".into()))
}
fn nft_outputs(current:bool)->Vec<TxOut> {
    let owner=Address::from_hash160([1;20]); let txid=Txid::from_le_bytes([5;32]);
    let code=if current {
        tbc_sdk::script::Script::from_bytes(tbc_engine_core::protocols::tbc721::instantiate_code(
            &tbc_engine_core::protocols::tbc721::CodeDescriptor {original_outpoint:OutPoint {txid,vout:1}}))
    } else {nft::code_script(&txid.to_string(),1).unwrap()};
    vec![TxOut {satoshis:200,script_pubkey:code},TxOut {satoshis:100,script_pubkey:nft::hold_script(&owner)},
        TxOut {satoshis:0,script_pubkey:nft::tape_script(&NftData {nft_name:"Public".into(),symbol:"N".into(),description:"".into(),attributes:"[]".into(),file:None}).unwrap()}]
}

#[test]
fn whole_batch_check_allows_shared_collection_current_nft_but_rejects_old_mint() {
    let p=parent();
    let collection=vec![TxOut{satoshis:0,script_pubkey:nft::tape_script(&CollectionData{
        collection_name:"Public".into(),description:"".into(),supply:1,file:"".into()}).unwrap()},
        TxOut{satoshis:100,script_pubkey:nft::mint_script(&Address::from_hash160([1;20]))}];
    for outputs in [vec![native()],collection,nft_outputs(true)] {
        let tx=spend(&p,outputs);let result=call(&request(&[tx.clone()],&[p.clone()])).unwrap();
        assert_eq!(result["transactionIds"],json!([tx.txid().to_string()]));
        assert_eq!(result["verification"],"historical-issuance-policy");
        assert_eq!(result["assetIdentityVerified"],false);
        assert!(result.get("approved").is_none());
    }
    let first=spend(&p,vec![native()]);let old=spend(&first,nft_outputs(false));
    assert!(call(&request(&[first.clone(),old],&[p.clone()])).is_err());
    let second=spend(&first,vec![native()]);
    assert!(call(&request(&[first.clone(),second.clone()],&[p.clone()])).is_ok());
    assert!(call(&request(&[second,first],&[p])).is_err());
}

#[test]
fn canonical_material_bounds_duplicate_and_shadow_fail_closed_without_echo() {
    let p=parent();let tx=spend(&p,vec![native()]);let valid=request(&[tx.clone()],&[p.clone()]);
    assert!(call(&valid).is_ok());
    for (key,value) in [("satoshis",json!("01")),("satoshis",json!(-1)),("satoshis",json!("18446744073709551616")),
        ("scriptPubKey",json!("AB")),("vout",json!(-1)),("txid",json!("not-a-txid"))] {
        let mut bad=valid.clone();bad["resolvedOutputs"][0][key]=value;assert!(call(&bad).is_err());
    }
    let mut missing=valid.clone();missing["resolvedOutputs"]=json!([]);assert!(call(&missing).is_err());
    let mut duplicate=valid.clone();duplicate["resolvedOutputs"].as_array_mut().unwrap().push(valid["resolvedOutputs"][0].clone());
    assert!(call(&duplicate).is_err());
    assert!(call(&request(&[tx.clone()],&[p.clone(),tx.clone()])).is_err());
    assert!(call(&request(&[tx.clone(),tx.clone()],&[p])).is_err());
    for transactions in [json!([]),json!(vec![valid["transactions"][0].clone();34])] {
        let mut bad=valid.clone();bad["transactions"]=transactions;assert!(call(&bad).is_err());
    }
    for raw in [format!("{}00",tx.to_hex()),tx.to_hex().to_uppercase()] {
        let mut bad=valid.clone();bad["transactions"][0]["rawTransaction"]=json!(raw);assert!(call(&bad).is_err());
    }
    let mut bad=valid;bad["transactions"][0]["preimage"]=json!("never-echo-this-sentinel");
    assert!(!call(&bad).unwrap_err().contains("never-echo-this-sentinel"));
}

#[test]
fn historical_lp_transfer_auto_detects_but_rejects_conflicting_hints_and_issuance() {
    use tbc_sdk::contracts::pool_nft_v2::{FtScriptVersion,FtlpCodeParams,FtlpTapeParams,FtlpTapeLayout,ftlp_tape,ftlp_code};
    let tape=ftlp_tape(&FtlpTapeParams{amount_raw:10,layout:FtlpTapeLayout::Standard{decimal:6,name:"LP",symbol:"LP",is_coin:false}}).unwrap();
    let params=FtlpCodeParams::for_tape(&tape,FtScriptVersion::V4,false).unwrap();
    let code=ftlp_code([7;32],&Address::from_hash160([1;20]),&params).unwrap();
    let pair=vec![TxOut{satoshis:500,script_pubkey:code},TxOut{satoshis:0,script_pubkey:tape}];
    let mut p=Transaction::new();p.outputs=pair.clone();
    let tx=spend(&p,pair);let mut valid=request(&[tx.clone()],&[p.clone()]);
    let hint=json!({"kind":"ftlp","poolCodeHash":"07".repeat(32),"ftVersion":4,"isCoin":false,"lockTimeEnabled":false});
    valid["transactions"][0]["inputTemplates"]=json!([{"txid":p.txid().to_string(),"vout":0,"template":hint}]);
    valid["transactions"][0]["outputTemplates"]=json!([{"vout":0,"template":hint}]);
    assert!(call(&valid).is_ok());
    for key in ["inputTemplates","outputTemplates"] {
        let mut missing=valid.clone();missing["transactions"][0].as_object_mut().unwrap().remove(key);assert!(call(&missing).is_ok());
        let mut duplicate=valid.clone();let value=duplicate["transactions"][0][key][0].clone();
        duplicate["transactions"][0][key].as_array_mut().unwrap().push(value);assert!(call(&duplicate).is_err());
    }
    assert!(call(&request(&[tx.clone()],&[p.clone()])).is_ok());
    for (key,value) in [("poolCodeHash",json!("08".repeat(32))),("ftVersion",json!(3)),("ftVersion",json!(5)),
        ("isCoin",json!(true)),("lockTimeEnabled",json!(true)),("approved",json!(true))] {
        let mut bad=valid.clone();bad["transactions"][0]["outputTemplates"][0]["template"][key]=value;assert!(call(&bad).is_err());
    }
    let fund=parent();let mint=spend(&fund,tx.outputs.clone());
    let mut unbacked=request(&[mint],&[fund]);
    unbacked["transactions"][0]["outputTemplates"]=valid["transactions"][0]["outputTemplates"].clone();
    assert!(call(&unbacked).is_err());
    // An out-of-range or unspent hint is not silently accepted as evidence.
    let mut wrong=valid.clone();wrong["transactions"][0]["inputTemplates"][0]["vout"]=json!(1);assert!(call(&wrong).is_err());
    let mut wrong=valid;wrong["transactions"][0]["outputTemplates"][0]["vout"]=json!(2);assert!(call(&wrong).is_err());
}
