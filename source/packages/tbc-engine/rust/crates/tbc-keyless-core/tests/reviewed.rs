use std::str::FromStr;
use serde_json::{json, Value};
use secp256k1::{Message,PublicKey,Secp256k1,SecretKey};
use tbc_sdk::{OutPoint,Transaction,TxIn,TxOut,Txid,script::Script};

fn fixture()->(Value,Value,String){
 let secret=SecretKey::from_byte_array([7;32]).unwrap();
 let public=hex::encode(PublicKey::from_secret_key(&Secp256k1::new(),&secret).serialize());
 let script="76a914".to_owned()+&"22".repeat(20)+"88ac";
 let mut tx=Transaction::new();tx.inputs.push(TxIn::new(OutPoint{txid:Txid::from_str(&"11".repeat(32)).unwrap(),vout:0}));
 tx.outputs.push(TxOut{satoshis:9000,script_pubkey:Script::from_bytes(hex::decode(&script).unwrap())});
 (json!({"txraws":[tx.to_hex()],"utxosSatoshis":[[10000]],"scriptPubkeys":[[script]]}),
 json!({"sourceTxraw":tx.to_hex(),"sourceUtxos":[{"txId":"11".repeat(32),"outputIndex":0,"satoshis":10000,"script":script,"scriptSigType":"p2pkh"}],"inputs":[[{"outputIndex":0,"scriptSigType":"p2pkh"}]],"outputs":[[{"satoshis":8000,"script":script}]]}),public)
}
fn call(op:&str,value:&Value)->Value{serde_json::from_str(&tbc_keyless_core::call(op,&value.to_string()).unwrap()).unwrap()}
fn signatures(stage:&Value)->Vec<String>{stage["digests"].as_array().unwrap().iter().map(|v|{
 let digest:[u8;32]=hex::decode(v.as_str().unwrap()).unwrap().try_into().unwrap();
 let sig=Secp256k1::new().sign_ecdsa(Message::from_digest(digest),&SecretKey::from_byte_array([7;32]).unwrap());
 hex::encode(sig.serialize_der())+"41"
}).collect()}
#[test]
fn whole_reviewed_batch_rejects_later_old_nft_issuance_before_first_digest(){
 use tbc_sdk::{Address,contracts::nft::{scripts,NftData}};
 let(raw,mut associated,public)=fixture();
 let source=Transaction::from_hex(raw["txraws"][0].as_str().unwrap()).unwrap();
 let address=Address::from_hash160([2;20]);
 let outputs=vec![
  TxOut{satoshis:200,script_pubkey:scripts::code_script(&"33".repeat(32),1).unwrap()},
  TxOut{satoshis:100,script_pubkey:scripts::hold_script(&address)},
  TxOut{satoshis:0,script_pubkey:scripts::tape_script(&NftData{nft_name:"Public".into(),symbol:"N".into(),description:"".into(),attributes:"[]".into(),file:None}).unwrap()}];
 let mut child=Transaction::new();child.inputs.push(TxIn::new(OutPoint{txid:source.txid(),vout:0}));child.outputs=outputs.clone();
 let batch=json!({"txraws":[source.to_hex(),child.to_hex()],"utxosSatoshis":[[10000],[9000]],
  "scriptPubkeys":[raw["scriptPubkeys"][0],[hex::encode(source.outputs[0].script_pubkey.as_bytes())]]});
 associated["outputs"]=json!([outputs.iter().map(|o|json!({"satoshis":o.satoshis,"script":hex::encode(o.script_pubkey.as_bytes())})).collect::<Vec<_>>()]);
 for (format,request) in [("raw",batch),("associated",associated)] {
  assert!(tbc_keyless_core::call("prepareReviewedStage",&json!({"format":format,"request":request,"publicKey":public}).to_string()).is_err(),"must reject whole {format} batch before returning first digest");
 }
}
#[test]
fn reviewed_policy_binds_supplemental_material_and_finalized_parent_shape(){
 let(raw,associated,public)=fixture();
 let mut prepare=json!({"format":"raw","request":raw,"publicKey":public,
  "resolvedOutputs":[{"txid":"11".repeat(32),"vout":0,"satoshis":"9999","scriptPubKey":raw["scriptPubkeys"][0][0]}]});
 assert_eq!(tbc_keyless_core::call("prepareReviewedStage",&prepare.to_string()).unwrap_err(),"Reviewed policy material conflict");
 prepare["resolvedOutputs"][0]["satoshis"]=json!("10000");
 assert!(tbc_keyless_core::call("prepareReviewedStage",&prepare.to_string()).is_ok());
 let stage=call("prepareReviewedStage",&json!({"format":"associated","request":associated,"publicKey":public}));
 let finalized=call("finalizeReviewedStage",&json!({"stage":stage,"signatures":signatures(&stage)}));
 let parent=Transaction::from_hex(finalized["txraw"].as_str().unwrap()).unwrap();
 let base=json!({"format":"associated","request":associated,"publicKey":public,"transactionIndex":1,"previousTransactions":[parent.to_hex()]});
 let child=call("prepareReviewedStage",&base);
 assert_eq!(Transaction::from_hex(child["txraw"].as_str().unwrap()).unwrap().inputs[0].previous_output.txid,parent.txid());
 for case in 0..4{
  let mut changed=parent.clone();match case{0=>changed.outputs[0].satoshis-=1,1=>changed.outputs[0].script_pubkey=Script::p2pkh(&[3;20]),
   2=>changed.inputs[0].previous_output.vout=1,_=>changed.lock_time=1};
  let mut bad=base.clone();bad["previousTransactions"]=json!([changed.to_hex()]);
  assert_eq!(tbc_keyless_core::call("prepareReviewedStage",&bad.to_string()).unwrap_err(),"Reviewed finalized parent shape mismatch");
 }
}

#[test]
fn reviewed_old_nft_transfer_requires_complete_bound_hold_and_tape_not_a_label(){
 use tbc_sdk::{Address,contracts::nft::{scripts,NftData}};
 let(_,_,public)=fixture();let address=Address::from_hash160([2;20]);
 let id=Txid::from_str(&"44".repeat(32)).unwrap();
 let outputs=vec![TxOut{satoshis:200,script_pubkey:scripts::code_script(&"33".repeat(32),1).unwrap()},
  TxOut{satoshis:100,script_pubkey:scripts::hold_script(&address)},
  TxOut{satoshis:0,script_pubkey:scripts::tape_script(&NftData{nft_name:"Public".into(),symbol:"N".into(),description:"".into(),attributes:"[]".into(),file:None}).unwrap()}];
 let mut tx=Transaction::new();for vout in [0,1]{tx.inputs.push(TxIn::new(OutPoint{txid:id,vout}));}tx.outputs=outputs.clone();
 let mut request=json!({"format":"raw","publicKey":public,"request":{"txraws":[tx.to_hex()],"utxosSatoshis":[[200,100]],
  "scriptPubkeys":[outputs[..2].iter().map(|o|hex::encode(o.script_pubkey.as_bytes())).collect::<Vec<_>>()]}});
 assert!(tbc_keyless_core::call("prepareReviewedStage",&request.to_string()).is_err());
 request["resolvedOutputs"]=json!([{"txid":id.to_string(),"vout":2,"satoshis":"0","scriptPubKey":hex::encode(outputs[2].script_pubkey.as_bytes())}]);
 let stage=call("prepareReviewedStage",&request);assert_eq!(stage["digests"].as_array().unwrap().len(),2);
 request["resolvedOutputs"][0]["scriptPubKey"]=json!("006a");
 assert!(tbc_keyless_core::call("prepareReviewedStage",&request.to_string()).is_err());
}
#[test]
fn reviewed_errors_do_not_echo_untrusted_request_values(){
 const MARKER:&str="PUBLIC_SYNTHETIC_PRIVACY_SENTINEL";
 let(raw,associated,public)=fixture();
 for case in 0..4 {
  let mut request=json!({"format":"associated","request":associated,"publicKey":public});
  match case {
   0=>request[MARKER]=json!(true),
   1=>request["request"]["sourceUtxos"][0]["scriptSigType"]=json!(MARKER),
   2=>{request["format"]=json!("raw");request["request"]=raw.clone();request["request"]["utxosSatoshis"][0][0]=json!(MARKER);},
   _=>request["request"]["sourceUtxos"][0]["script"]=json!(format!("OP_{MARKER}")),
  }
  let error=tbc_keyless_core::call("prepareReviewedStage",&request.to_string()).unwrap_err();
  assert!(!error.contains(MARKER),"Reviewed parse error contains request data; case {case}");
 }
 let stage=call("prepareReviewedStage",&json!({"format":"raw","request":raw,"publicKey":public}));
 for case in 0..2 {
  let mut request=json!({"stage":stage,"signatures":[]});
  if case==0 {request["stage"]["format"]=json!(MARKER);}else{request[MARKER]=json!(true);}
  let error=tbc_keyless_core::call("finalizeReviewedStage",&request.to_string()).unwrap_err();
  assert!(!error.contains(MARKER),"Reviewed finalize parse error contains request data");
 }
}
#[test]
fn detached_raw_signatures_match_existing_private_implementation(){
 let(raw,_,public)=fixture();let stage=call("prepareReviewedStage",&json!({"format":"raw","request":raw,"publicKey":public}));
 assert_eq!(stage["format"],"raw");
 let result=call("finalizeReviewedStage",&json!({"stage":stage,"signatures":signatures(&stage)}));
 let old:Value=serde_json::from_str(&tbc_wallet_private_core::call("signP2pkh",&raw.to_string(),&[7;32]).unwrap()).unwrap();
 assert_eq!(result["sigs"],old["sigs"][0]);
 // Raw signing returns detached signatures, not a fabricated P2PKH assembly.
 // Preserve the exact input template; DApps supply their covenant witnesses.
 assert_eq!(result["txraw"],raw["txraws"][0]);
 let compact=signatures(&stage).iter().map(|wire|{
  let bytes=hex::decode(wire).unwrap();hex::encode(secp256k1::ecdsa::Signature::from_der(&bytes[..bytes.len()-1]).unwrap().serialize_compact())
 }).collect::<Vec<_>>();
 let result=call("finalizeReviewedStage",&json!({"stage":stage,"signatures":compact,"signatureEncoding":"compact64"}));
 assert_eq!(result["sigs"],old["sigs"][0]);
 assert_eq!(result["txraw"],raw["txraws"][0]);
}
#[test]
fn associated_parent_child_bytes_match_existing_implementation(){
 let(_,request,public)=fixture();let mut raws=Vec::new();
 for index in 0..2{
  let stage=call("prepareReviewedStage",&json!({"format":"associated","request":request,"publicKey":public,"transactionIndex":index,"previousTransactions":raws}));
  assert_eq!(stage["format"],"associated");
  let result=call("finalizeReviewedStage",&json!({"stage":stage,"signatures":signatures(&stage)}));raws.push(result["txraw"].as_str().unwrap().to_owned());
 }
 let old:Value=serde_json::from_str(&tbc_wallet_private_core::call("signAssociated",&request.to_string(),&[7;32]).unwrap()).unwrap();
 assert_eq!(json!(raws),old["txraws"]);
 let parent=Transaction::from_hex(&raws[0]).unwrap();let child=Transaction::from_hex(&raws[1]).unwrap();assert_eq!(child.inputs[0].previous_output.txid,parent.txid());
}
#[test]
fn rejects_tampered_stage_signature_and_secret_fields(){
 let(raw,_,public)=fixture();let stage=call("prepareReviewedStage",&json!({"format":"raw","request":raw,"publicKey":public}));let sigs=signatures(&stage);
 let mut changed=stage.clone();changed["inputs"][0]["satoshis"]=json!(9999);
 assert!(tbc_keyless_core::call("finalizeReviewedStage",&json!({"stage":changed,"signatures":sigs}).to_string()).is_err());
 let mut bad=sigs.clone();bad[0].replace_range(8..10,"ff");
 assert!(tbc_keyless_core::call("finalizeReviewedStage",&json!({"stage":stage,"signatures":bad}).to_string()).is_err());
 assert!(tbc_keyless_core::call("prepareReviewedStage",&json!({"format":"raw","request":raw,"publicKey":public,"privateKey":"not-accepted"}).to_string()).is_err());
}

// Assembly parity only, not chain-valid spends: public scalar 7 does not own
// the recorded FT fixture. No test here submits anything to a node.
#[test]
fn ft_and_contract_profile_assembly_matches_private_reference(){
 let recorded:Value=serde_json::from_str(include_str!("../../../../../kit/test/fixtures/controlled-pool.json")).unwrap();
 let parent_raw=recorded["rawTransactions"][recorded["ownerCandidate"]["txid"].as_str().unwrap()].as_str().unwrap();
 let parent=Transaction::from_hex(parent_raw).unwrap();
 let contract_raw=recorded["rawTransactions"][recorded["ftContractId"].as_str().unwrap()].as_str().unwrap();
 let (_,base,public)=fixture();
 for (profile,version) in [("tbc20",1),("tbc20_contract",1),("tbc20_contract",2),("tbc20_contract",3)] {
  let mut tx=Transaction::new();tx.inputs.push(TxIn::new(OutPoint{txid:parent.txid(),vout:0}));
  tx.outputs=Transaction::from_hex(base["sourceTxraw"].as_str().unwrap()).unwrap().outputs;
  let request=json!({"sourceTxraw":tx.to_hex(),"sourceUtxos":[{"txId":parent.txid().to_string(),"outputIndex":0,"satoshis":parent.outputs[0].satoshis,"script":hex::encode(parent.outputs[0].script_pubkey.as_bytes()),"scriptSigType":profile,"preTx":parent_raw,"prePreTxData":"00","contractTx":contract_raw,"ftVersion":version}],"inputs":[],"outputs":[]});
  let stage=call("prepareReviewedStage",&json!({"format":"associated","request":request,"publicKey":public}));
  let result=call("finalizeReviewedStage",&json!({"stage":stage,"signatures":signatures(&stage)}));
  let old:Value=serde_json::from_str(&tbc_wallet_private_core::call("signAssociated",&request.to_string(),&[7;32]).unwrap()).unwrap();
  assert_eq!(result["txraw"],old["txraws"][0],"{profile} version {version}");
 }
}

#[test]
fn contract_template_preserves_signature_substitution_and_rejects_ambiguity(){
 let(_,mut request,public)=fixture();request["inputs"]=json!([]);request["outputs"]=json!([]);
 request["sourceUtxos"][0]["scriptSigType"]=json!("other");
 request["sourceUtxos"][0]["unfinishedScriptSig"]=json!("00097369676e617475726551");
 let stage=call("prepareReviewedStage",&json!({"format":"associated","request":request,"publicKey":public}));
 let result=call("finalizeReviewedStage",&json!({"stage":stage,"signatures":signatures(&stage)}));
 let old:Value=serde_json::from_str(&tbc_wallet_private_core::call("signAssociated",&request.to_string(),&[7;32]).unwrap()).unwrap();
 assert_eq!(result["txraw"],old["txraws"][0]);
 for template in ["0051","097369676e6174757265097369676e6174757265"] {
  request["sourceUtxos"][0]["unfinishedScriptSig"]=json!(template);
  let stage=call("prepareReviewedStage",&json!({"format":"associated","request":request,"publicKey":public}));
  assert!(tbc_keyless_core::call("finalizeReviewedStage",&json!({"stage":stage,"signatures":signatures(&stage)}).to_string()).is_err());
 }
}

#[test]
fn associated_placeholder_is_an_opcode_not_bytes_inside_proof_data(){
 let(_,mut request,public)=fixture();request["inputs"]=json!([]);request["outputs"]=json!([]);
 request["sourceUtxos"][0]["scriptSigType"]=json!("other");
 // A proof data push contains the same bytes as the placeholder opcode. It
 // must remain intact; only the later actual push is a signature slot.
 let proof="0a097369676e6174757265";
 request["sourceUtxos"][0]["unfinishedScriptSig"]=json!(format!("{proof}097369676e6174757265"));
 let stage=call("prepareReviewedStage",&json!({"format":"associated","request":request,"publicKey":public}));
 let result=call("finalizeReviewedStage",&json!({"stage":stage,"signatures":signatures(&stage)}));
 let tx=Transaction::from_hex(result["txraw"].as_str().unwrap()).unwrap();
 let unlock=hex::encode(tx.inputs[0].script_sig.as_bytes());
 assert!(unlock.starts_with(proof));
 assert!(unlock.ends_with(&signatures(&stage)[0]));
 for template in [proof,"097369676e61747572654c","097369676e61747572654d01","097369676e61747572654effffffff"]{
  request["sourceUtxos"][0]["unfinishedScriptSig"]=json!(template);
  let stage=call("prepareReviewedStage",&json!({"format":"associated","request":request,"publicKey":public}));
  assert!(tbc_keyless_core::call("finalizeReviewedStage",&json!({"stage":stage,"signatures":signatures(&stage)}).to_string()).is_err());
 }
}

#[test]
fn associated_lop_match_reuses_shared_proof_and_only_requests_needed_signatures(){
 use tbc_engine_core::protocols::{lop::{Code,Market,Side,TapeMarker,Terms,AssetTerms},lop_proof::build_match_unlock_pair};
 let(_,base,public)=fixture();
 let f:Value=serde_json::from_str(include_str!("../../../fixtures/coin-proof.json")).unwrap();
 let mut parents=Vec::new();
 for side in [Side::Buy,Side::Sell]{
  let mut parent=Transaction::from_hex(f["vectors"][0]["parentRaw"].as_str().unwrap()).unwrap();
  let code=Code{side,market:Market::NativeToken{token_code_bytes:2981,marker:TapeMarker::Modern},tax_hash:[2;20],
   terms:Terms{owner_hash:[1;20],sale_volume:100,unit_price:2000000,fee_rate:100,asset_a:AssetTerms{partial_hash:[3;32],contract_id:[4;32]},asset_b:None}};
  parent.outputs=vec![TxOut{satoshis:300,script_pubkey:Script::from_bytes(code.encode().unwrap())}];parents.push(parent);
 }
 let mut tx=Transaction::from_hex(base["sourceTxraw"].as_str().unwrap()).unwrap();let funding=tx.inputs[0].clone();
 tx.inputs=vec![TxIn::new(OutPoint{txid:parents[0].txid(),vout:0}),funding.clone(),TxIn::new(OutPoint{txid:parents[1].txid(),vout:0})];
 let mut inputs=Vec::new();
 for i in 0..3{
  if i==1{inputs.push(base["sourceUtxos"][0].clone());}else{let parent=&parents[i/2];inputs.push(json!({
   "txId":parent.txid().to_string(),"outputIndex":0,"satoshis":300,"script":hex::encode(parent.outputs[0].script_pubkey.as_bytes()),"scriptSigType":"tbc_lop_match","preTx":parent.to_hex()}));}
 }
 let request=json!({"sourceTxraw":tx.to_hex(),"sourceUtxos":inputs,"inputs":[],"outputs":[]});
 let prepare=json!({"format":"associated","request":request,"publicKey":public});
 let stage=call("prepareReviewedStage",&prepare);assert_eq!(stage["signingInputIndexes"],json!([1]));
 let finalize=json!({"stage":stage,"signatures":signatures(&stage)});let result=call("finalizeReviewedStage",&finalize);
 let actual=Transaction::from_hex(result["txraw"].as_str().unwrap()).unwrap();
 let expected=build_match_unlock_pair(&tx,&parents[0],&parents[1]).unwrap();
 assert_eq!(actual.inputs[0].script_sig,expected[0]);assert_eq!(actual.inputs[2].script_sig,expected[1]);
 assert_eq!(result["sigs"].as_array().unwrap().len(),1);
 if std::env::var("REVIEWED_DUMP_WIRE").as_deref()==Ok("1"){
  println!("REVIEWED_WIRE:{}",json!({"operation":"prepareReviewedStage","input":prepare,"result":stage}));
  println!("REVIEWED_WIRE:{}",json!({"operation":"finalizeReviewedStage","input":finalize,"result":result}));
 }
 let mut bad=stage.clone();bad["signingInputIndexes"]=json!([0]);
 assert!(tbc_keyless_core::call("finalizeReviewedStage",&json!({"stage":bad,"signatures":signatures(&stage)}).to_string()).is_err());
 let mut bad=prepare.clone();bad["request"]["sourceUtxos"][0]["satoshis"]=json!(301);
 assert!(tbc_keyless_core::call("prepareReviewedStage",&bad.to_string()).is_err());
 // This is material/assembly parity, not a valid settlement or consensus test.
}
