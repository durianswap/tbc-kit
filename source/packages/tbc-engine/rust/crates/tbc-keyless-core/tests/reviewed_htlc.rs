//! Public synthetic fixtures only. Never load or print a wallet preimage.
use serde_json::{json,Value};
use secp256k1::{Message,PublicKey,Secp256k1,SecretKey};
use std::str::FromStr;
use tbc_sdk::{hash,OutPoint,Transaction,TxIn,TxOut,Txid,script::Script};
use tbc_engine_core::protocols::htlc::Code;

fn fixture(claim:bool,secret:&[u8],lock:u32)->Value {
 let public=PublicKey::from_secret_key(&Secp256k1::new(),&SecretKey::from_byte_array([7;32]).unwrap()).serialize();
 let own=hash::hash160(&public);
 let code=Code{sender_hash:if claim{[2;20]}else{own},receiver_hash:if claim{own}else{[2;20]},hashlock:hash::sha256(secret),raw_lock_time:lock};
 let mut tx=Transaction::new();tx.inputs.push(TxIn::new(OutPoint{txid:Txid::from_str(&"11".repeat(32)).unwrap(),vout:0}));
 if !claim {tx.lock_time=lock;tx.inputs[0].sequence=u32::MAX-1;}
 tx.outputs.push(TxOut{satoshis:9000,script_pubkey:Script::p2pkh(&own)});
 let mut template=hex::decode("097369676e617475726521").unwrap();template.extend_from_slice(&public);
 if claim {
  match secret {
   []=>template.push(0),[n @ 1..=16]=>template.push(0x50+n),[0x81]=>template.push(0x4f),
   data=>{match data.len(){0..=75=>template.push(data.len() as u8),76..=255=>template.extend_from_slice(&[0x4c,data.len() as u8]),_=>{template.push(0x4d);template.extend_from_slice(&(data.len() as u16).to_le_bytes());}}template.extend_from_slice(data);}
  }template.push(0x51);
 }else {template.push(0);}
 json!({"format":"associated","publicKey":hex::encode(public),"request":{"sourceTxraw":tx.to_hex(),"sourceUtxos":[{"txId":"11".repeat(32),"outputIndex":0,"satoshis":10000,"script":hex::encode(code.encode()),"scriptSigType":"other","unfinishedScriptSig":hex::encode(template)}],"inputs":[],"outputs":[]}})
}
fn call(op:&str,v:&Value)->Value {serde_json::from_str(&tbc_keyless_core::call(op,&v.to_string()).unwrap()).unwrap()}
fn sign(stage:&Value)->Value {
 let signatures=stage["digests"].as_array().unwrap().iter().map(|d|{
  let digest:[u8;32]=hex::decode(d.as_str().unwrap()).unwrap().try_into().unwrap();
  hex::encode(Secp256k1::new().sign_ecdsa(Message::from_digest(digest),&SecretKey::from_byte_array([7;32]).unwrap()).serialize_der())+"41"
 }).collect::<Vec<_>>();json!({"stage":stage,"signatures":signatures})
}
fn dump(value:Value){if std::env::var("HTLC_ASSOCIATED_DUMP_WIRE").as_deref()==Ok("1"){println!("HTLC_ASSOCIATED_WIRE:{value}");}}

#[test]
fn supported_associated_htlc_witnesses_keep_native_bytes_and_detached_path(){
 let mut requests=vec![fixture(false,&[0x33;32],834801),fixture(false,&[0x33;32],1774427165)];
 for preimage in [vec![],vec![1],vec![0x81],vec![0],vec![0x33;32],vec![0x33;76],vec![0x33;256]]{requests.push(fixture(true,&preimage,834801));}
 for request in requests {
  let stage=call("prepareReviewedStage",&request);let final_request=sign(&stage);let result=call("finalizeReviewedStage",&final_request);
  let old:Value=serde_json::from_str(&tbc_wallet_private_core::call("signAssociated",&request["request"].to_string(),&[7;32]).unwrap()).unwrap();
  assert_eq!(result["txraw"],old["txraws"][0]);
  let raw=json!({"format":"raw","publicKey":request["publicKey"],"request":{"txraws":[request["request"]["sourceTxraw"]],"utxosSatoshis":[[10000]],"scriptPubkeys":[[request["request"]["sourceUtxos"][0]["script"]]]}});
  let detached=call("prepareReviewedStage",&raw);assert_eq!(detached["digests"],stage["digests"]);
  dump(json!({"kind":"valid","request":request,"stage":stage,"finalRequest":final_request,"result":result}));
 }
}

#[test]
fn invalid_associated_htlc_fails_before_signing_and_again_at_finalization(){
 for case in 0..15 {
  let base=fixture(case<10,&[0x33;32],834801);let stage=call("prepareReviewedStage",&base);
  let mut changed=base.clone();
  match case {
   0=>{let text=changed["request"]["sourceUtxos"][0]["unfinishedScriptSig"].as_str().unwrap().replace(&"33".repeat(32),&"34".repeat(32));changed["request"]["sourceUtxos"][0]["unfinishedScriptSig"]=json!(text);},
   1=>{let text=changed["request"]["sourceUtxos"][0]["unfinishedScriptSig"].as_str().unwrap().replace(base["publicKey"].as_str().unwrap(),&("02".to_owned()+&"22".repeat(32)));changed["request"]["sourceUtxos"][0]["unfinishedScriptSig"]=json!(text);},
   2=>changed["request"]["sourceUtxos"][0]["unfinishedScriptSig"]=json!("097369676e6174757265"),
   3=>{let text=changed["request"]["sourceUtxos"][0]["unfinishedScriptSig"].as_str().unwrap().to_owned()+"51";changed["request"]["sourceUtxos"][0]["unfinishedScriptSig"]=json!(text);},
   4=>changed["request"]["sourceUtxos"][0]["scriptSigType"]=json!("p2pkh"),
   5=>changed["request"]["sourceUtxos"][0]["txId"]=json!("22".repeat(32)),
   6=>changed["request"]["sourceUtxos"][0]["outputIndex"]=json!(1),
   7=>{let text=changed["request"]["sourceUtxos"][0]["unfinishedScriptSig"].as_str().unwrap().to_owned();changed["request"]["sourceUtxos"][0]["unfinishedScriptSig"]=json!(format!("{}4c20{}",&text[..88],&text[90..]));},
   8=>{let mut tx=Transaction::from_hex(changed["request"]["sourceTxraw"].as_str().unwrap()).unwrap();tx.inputs[0].script_sig=Script::from_bytes(vec![0x51]);changed["request"]["sourceTxraw"]=json!(tx.to_hex());},
   9=>{let mut code=Code::decode(&hex::decode(changed["request"]["sourceUtxos"][0]["script"].as_str().unwrap()).unwrap()).unwrap();code.receiver_hash=[2;20];changed["request"]["sourceUtxos"][0]["script"]=json!(hex::encode(code.encode()));},
   10..=12=>{let mut tx=Transaction::from_hex(changed["request"]["sourceTxraw"].as_str().unwrap()).unwrap();match case{10=>tx.inputs[0].sequence=u32::MAX,11=>tx.lock_time=834800,_=>tx.lock_time=1774427165};changed["request"]["sourceTxraw"]=json!(tx.to_hex());},
   13=>{let mut code=Code::decode(&hex::decode(changed["request"]["sourceUtxos"][0]["script"].as_str().unwrap()).unwrap()).unwrap();code.sender_hash=[2;20];changed["request"]["sourceUtxos"][0]["script"]=json!(hex::encode(code.encode()));},
   _=>changed["request"]["sourceUtxos"][0]["unfinishedScriptSig"]=json!("00"),
  }
  let Err(error)=tbc_keyless_core::call("prepareReviewedStage",&changed.to_string()) else {panic!("invalid HTLC template reached signing; request withheld");};
  // The shared preflight now rejects incorrect outpoint identity even before
  // reaching HTLC-specific witness validation; both boundaries are required.
  assert_eq!(error,if [5,6].contains(&case){"Reviewed policy input identity mismatch"}else{"Invalid associated HTLC witness"});
  // Digest-independent template changes must also be rejected by finalize.
  if [0,1,2,3,4,5,6,7,14].contains(&case){
   let mut final_request=sign(&stage);final_request["stage"]["inputs"]=changed["request"]["sourceUtxos"].clone();
   assert!(tbc_keyless_core::call("finalizeReviewedStage",&final_request.to_string()).is_err());
   dump(json!({"kind":"invalid-final","request":final_request}));
  }
  dump(json!({"kind":"invalid-prepare","case":case,"request":changed}));
 }
}

#[test]
fn associated_htlc_children_derive_refund_locks_from_finalized_parent(){
 for (claim,lock) in [(true,834801),(false,834801),(false,1774427165)] {
  let base=fixture(claim,&[0x33;32],lock);
  let public=hex::decode(base["publicKey"].as_str().unwrap()).unwrap();let own=hash::hash160(&public);
  let code=base["request"]["sourceUtxos"][0]["script"].as_str().unwrap();
  let mut parent=Transaction::new();
  parent.inputs.push(TxIn::new(OutPoint{txid:Txid::from_str(&"44".repeat(32)).unwrap(),vout:0}));
  parent.outputs.push(TxOut{satoshis:10000,script_pubkey:Script::from_bytes(hex::decode(code).unwrap())});
  let request=json!({"sourceTxraw":parent.to_hex(),"sourceUtxos":[{"txId":"44".repeat(32),"outputIndex":0,"satoshis":10100,
   "script":hex::encode(Script::p2pkh(&own).as_bytes()),"scriptSigType":"p2pkh"}],
   "inputs":[[{"outputIndex":0,"scriptSigType":"other","unfinishedScriptSig":base["request"]["sourceUtxos"][0]["unfinishedScriptSig"]}]],
   "outputs":[[{"satoshis":9000,"script":hex::encode(Script::p2pkh(&own).as_bytes())}]]});
  let prepare_parent=json!({"format":"associated","request":request,"publicKey":base["publicKey"],"transactionIndex":0,"previousTransactions":[]});
  let parent_stage=call("prepareReviewedStage",&prepare_parent);let parent_final=sign(&parent_stage);let signed_parent=call("finalizeReviewedStage",&parent_final);
  let prepare_child=json!({"format":"associated","request":request,"publicKey":base["publicKey"],"transactionIndex":1,"previousTransactions":[signed_parent["txraw"]]});
  let child_stage=call("prepareReviewedStage",&prepare_child);let child_final=sign(&child_stage);let signed_child=call("finalizeReviewedStage",&child_final);
  let child=Transaction::from_hex(signed_child["txraw"].as_str().unwrap()).unwrap();let finalized_parent=Transaction::from_hex(signed_parent["txraw"].as_str().unwrap()).unwrap();
  assert_eq!(child.inputs[0].previous_output.txid,finalized_parent.txid());assert_ne!(finalized_parent.txid(),parent.txid());
  assert_eq!(child.lock_time,if claim{0}else{lock});
  assert_eq!(child.inputs[0].sequence,if claim{u32::MAX}else{u32::MAX-1});
  if claim{
   let old:Value=serde_json::from_str(&tbc_wallet_private_core::call("signAssociated",&request.to_string(),&[7;32]).unwrap()).unwrap();
   assert_eq!(old["txraws"],json!([signed_parent["txraw"],signed_child["txraw"]]));
  }else{
   // Finalizer must independently reject lock/sequence tampering after approval.
   for mutation in 0..3{
    let mut bad=child_final.clone();let mut tx=Transaction::from_hex(child_stage["txraw"].as_str().unwrap()).unwrap();
    match mutation{0=>tx.lock_time=lock-1,1=>tx.inputs[0].sequence=u32::MAX,_=>tx.lock_time=if lock<500_000_000{1774427165}else{834801}};
    bad["stage"]["txraw"]=json!(tx.to_hex());
    assert!(tbc_keyless_core::call("finalizeReviewedStage",&bad.to_string()).is_err());
   }
  }
  if std::env::var("HTLC_ASSOCIATED_DUMP_WIRE").as_deref()==Ok("1") {println!("HTLC_ASSOCIATED_CHILD_WIRE:{}",json!({"kind":if claim{"claim"}else{"refund"},"prepareParent":prepare_parent,"parentStage":parent_stage,"parentFinal":parent_final,"signedParent":signed_parent,"prepareChild":prepare_child,"childStage":child_stage,"childFinal":child_final,"signedChild":signed_child}));}
 }
}
