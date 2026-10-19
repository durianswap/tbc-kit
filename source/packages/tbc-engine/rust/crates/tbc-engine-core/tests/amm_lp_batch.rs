//! Offline genuine LP splits; public scalar 1, never a wallet/transport.
use std::collections::{BTreeMap,BTreeSet};
use secp256k1::{Message,Secp256k1,SecretKey};
use tbc_sdk::{OutPoint,PublicKey,Transaction,TxOut,script::Script};
use tbc_engine_core::{ErrorCode,protocols::{amm_lp as lp,amm_lp_proof as proof,
    amm_lp_transfer::{self,LpInput,FeeInput,TransferOptions,MinerFeePolicy},
    amm_lp_batch::{BatchOptions,Operation,build_batch_plan}},
    signing::{UnsignedPlan,SignedBundle,ExternalSignature,StageOutcome,begin_signing,finalize_signing_stage}};
fn bytes(h:&str)->Vec<u8>{(0..h.len()).step_by(2).map(|i|u8::from_str_radix(&h[i..i+2],16).unwrap()).collect()}
fn hex(b:&[u8])->String{b.iter().map(|b|format!("{b:02x}")).collect()}
fn controller(key:&PublicKey)->[u8;21]{let mut c=[0;21];c[..20].copy_from_slice(&key.hash160());c}
fn signed(plan:&UnsignedPlan)->SignedBundle{
    let mut scalar=[0;32];scalar[31]=1;let key=SecretKey::from_byte_array(scalar).unwrap();let secp=Secp256k1::new();
    let mut state=begin_signing(plan).unwrap();
    loop{
        let signatures:Vec<_>=state.signing_requests.iter().map(|r|ExternalSignature{session_id:r.session_id.clone(),stage:r.stage,
            stage_commitment:r.stage_commitment.clone(),transaction_id:r.transaction_id.clone(),input_index:r.input_index,
            digest:r.digest.clone(),public_key:r.public_key.clone(),signature:hex(&secp.sign_ecdsa(Message::from_digest(bytes(&r.digest).try_into().unwrap()),&key).serialize_der())}).collect();
        match finalize_signing_stage(plan,state,&signatures).unwrap(){StageOutcome::Complete(b)=>return b,StageOutcome::Pending(n)=>state=n}
    }
}
struct Material{parents:Vec<proof::ParentMaterial>,raws:Vec<Vec<Vec<u8>>>,fee_point:OutPoint,fee_output:TxOut,key:PublicKey,known:BTreeMap<String,Transaction>}
fn fragmented(count:usize,locked:bool)->Material{
    let f:serde_json::Value=serde_json::from_str(include_str!("../../../fixtures/amm-lp-proof.json")).unwrap();
    let id=if locked{"controller-locked-transfer-0"}else{"public-plain-transfer-0"};
    let row=f["vectors"].as_array().unwrap().iter().find(|r|r["id"]==id).unwrap();
    let key=PublicKey::from_slice(&bytes(row["publicKeyHex"].as_str().unwrap())).unwrap();
    let mut known:BTreeMap<_,_>=f["raws"].as_object().unwrap().iter().map(|(id,raw)|(id.clone(),Transaction::from_hex(raw.as_str().unwrap()).unwrap())).collect();
    let current=Transaction::from_hex(row["currentRaw"].as_str().unwrap()).unwrap();
    let mut points=vec![current.inputs[0].previous_output.clone()];let mut fee_point=current.inputs.last().unwrap().previous_output.clone();
    while points.len()<count{
        let selected=points.pop().unwrap();let parent=proof::inspect_parent(&known[&selected.txid.to_string()].serialize(),&selected,None).unwrap();
        let ids:BTreeSet<_>=parent.dependencies().iter().map(|p|p.txid.to_string()).collect();let raws:Vec<_>=ids.iter().map(|id|known[id].serialize()).collect();
        let refs:Vec<_>=raws.iter().map(Vec::as_slice).collect();let inputs=[LpInput{parent:&parent,ancestor_raws:&refs,public_key:&key}];
        let fee=FeeInput{outpoint:fee_point.clone(),output:&known[&fee_point.txid.to_string()].outputs[fee_point.vout as usize],public_key:&key};
        let split=amm_lp_transfer::build_transfer_plan(TransferOptions{inputs:&inputs,fee_input:&fee,expected_identity:parent.identity(),receiver_controller:controller(&key),amount:1000,
            lp_change_controller:Some(controller(&key)),native_change_hash:key.hash160(),lock_time:None,output_lock_time:None,fee_policy:MinerFeePolicy::default(),max_fee:10000}).unwrap();
        let tx=Transaction::from_hex(&signed(&split.unsigned_plan).transactions[0].raw_transaction).unwrap();
        for (vout,o) in tx.outputs.iter().enumerate(){
            if lp::parse_code(o.script_pubkey.as_bytes()).is_ok(){points.push(OutPoint{txid:tx.txid(),vout:vout as u32});}
            else if o.script_pubkey==Script::p2pkh(&key.hash160()){fee_point=OutPoint{txid:tx.txid(),vout:vout as u32};}
        }
        known.insert(tx.txid().to_string(),tx);
    }
    let parents:Vec<_>=points.iter().map(|p|proof::inspect_parent(&known[&p.txid.to_string()].serialize(),p,None).unwrap()).collect();
    let raws=parents.iter().map(|p|p.dependencies().iter().map(|d|d.txid.to_string()).collect::<BTreeSet<_>>().iter().map(|id|known[id].serialize()).collect()).collect();
    let fee_output=known[&fee_point.txid.to_string()].outputs[fee_point.vout as usize].clone();
    Material{parents,raws,fee_point,fee_output,key,known}
}
fn options<'a>(m:&'a Material,inputs:&'a [LpInput<'a>],fee:&'a FeeInput<'a>)->TransferOptions<'a>{
    TransferOptions{inputs,fee_input:fee,expected_identity:m.parents[0].identity(),receiver_controller:controller(&m.key),amount:2500,
        lp_change_controller:Some(controller(&m.key)),native_change_hash:m.key.hash160(),lock_time:None,output_lock_time:None,fee_policy:MinerFeePolicy::default(),max_fee:10000}
}
#[test]
fn lp_many_fragments_use_actual_signed_parents_conserve_value_and_preserve_locks(){
    for (count,locked,op,output_lock) in [(6,false,Operation::Transfer,None),(10,false,Operation::Merge,None),(26,true,Operation::Unlock,None),(6,true,Operation::Transfer,Some(900000))]{
        let m=fragmented(count,locked);let refs:Vec<Vec<_>>=m.raws.iter().map(|r|r.iter().map(Vec::as_slice).collect()).collect();
        let inputs:Vec<_>=m.parents.iter().zip(&refs).map(|(parent,r)|LpInput{parent,ancestor_raws:r,public_key:&m.key}).collect();
        let fee=FeeInput{outpoint:m.fee_point.clone(),output:&m.fee_output,public_key:&m.key};let mut o=options(&m,&inputs,&fee);o.output_lock_time=output_lock;
        let unlock=matches!(op,Operation::Unlock);let batch=build_batch_plan(BatchOptions{transfer:o,max_transactions:32,operation:op}).unwrap_or_else(|e|panic!("count {count}: {e:?}"));
        let bundle=signed(&batch.unsigned_plan);assert_eq!(bundle.transactions.len(),(count-2)/4+1);
        let mut spent=BTreeSet::new();let mut ids=BTreeMap::new();let mut known=m.known.clone();let mut vm=vec![];
        for(index,item)in bundle.transactions.iter().enumerate(){
            let tx=Transaction::from_hex(&item.raw_transaction).unwrap();let p=&batch.unsigned_plan.transactions[index];
            assert_eq!(item.txid,tx.txid().to_string());assert!(tx.serialize().len()<=batch.maximum_signed_bytes[index]);
            let mut input_value=0;
            for (vin,pi) in tx.inputs.iter().zip(&p.inputs){
                assert!(spent.insert((vin.previous_output.txid.to_string(),vin.previous_output.vout)));
                if let Some(actual)=ids.get(&pi.previous_transaction_id){assert_eq!(&vin.previous_output.txid.to_string(),actual);}
                input_value+=known[&vin.previous_output.txid.to_string()].outputs[vin.previous_output.vout as usize].satoshis;
            }
            assert_eq!(input_value-tx.outputs.iter().map(|o|o.satoshis).sum::<u64>(),batch.fees[index]);
            let total:u128=tx.outputs.iter().filter_map(|o|lp::Tape::decode(o.script_pubkey.as_bytes(),locked,None).ok()).map(|t|t.balance().unwrap()).sum();
            let expected:u128=tx.inputs.iter().filter_map(|i|{let parent=&known[&i.previous_output.txid.to_string()];lp::parse_code(parent.outputs[i.previous_output.vout as usize].script_pubkey.as_bytes()).ok()?;Some(lp::Tape::decode(parent.outputs[i.previous_output.vout as usize+1].script_pubkey.as_bytes(),locked,None).unwrap().balance().unwrap())}).sum();
            assert_eq!(total,expected);
            vm.push(serde_json::json!({"raw":item.raw_transaction,"parents":tx.inputs.iter().map(|i|known[&i.previous_output.txid.to_string()].to_hex()).collect::<Vec<_>>()}));
            ids.insert(item.transaction_id.clone(),item.txid.clone());known.insert(item.txid.clone(),tx);
        }
        for p in &m.parents{assert!(spent.contains(&(p.selected().txid.to_string(),p.selected().vout)));}
        let last=Transaction::from_hex(&bundle.transactions.last().unwrap().raw_transaction).unwrap();
        assert_eq!(batch.token_outputs.iter().map(|o|o.amount).sum::<u128>(),100000);
        let tape=lp::Tape::decode(last.outputs[1].script_pubkey.as_bytes(),locked,None).unwrap();
        assert_eq!(tape.lock_time,if unlock{0}else{output_lock.unwrap_or(if locked{829999}else{0})});
        if std::env::var_os("TBC_AMM_LP_BATCH_DUMP").is_some(){println!("LP_BATCH_VM {}",serde_json::json!({"count":count,"transactions":vm}));}
    }
}
#[test]
fn lp_batch_limits_duplicates_and_small_path_stays_identical(){
    let m=fragmented(6,false);let refs:Vec<Vec<_>>=m.raws.iter().map(|r|r.iter().map(Vec::as_slice).collect()).collect();
    let inputs:Vec<_>=m.parents.iter().zip(&refs).map(|(parent,r)|LpInput{parent,ancestor_raws:r,public_key:&m.key}).collect();
    let fee=FeeInput{outpoint:m.fee_point.clone(),output:&m.fee_output,public_key:&m.key};
    let make=|max_transactions|BatchOptions{transfer:options(&m,&inputs,&fee),max_transactions,operation:Operation::Merge};
    assert!(build_batch_plan(make(1)).err().unwrap().message.contains("bundle"));
    let good=build_batch_plan(make(32)).unwrap();let mut cap=make(32);cap.transfer.max_fee=good.fees.iter().sum::<u64>()-1;
    assert_eq!(build_batch_plan(cap).err().unwrap().code,ErrorCode::FeeCapExceeded);
    let mut duplicate=inputs;duplicate.push(LpInput{parent:&m.parents[0],ancestor_raws:&refs[0],public_key:&m.key});
    assert!(build_batch_plan(BatchOptions{transfer:options(&m,&duplicate,&fee),max_transactions:32,operation:Operation::Merge}).err().unwrap().message.contains("repeats"));
    let small=&duplicate[..2];let single=amm_lp_transfer::build_merge_plan(options(&m,small,&fee)).unwrap();
    let batch=build_batch_plan(BatchOptions{transfer:options(&m,small,&fee),max_transactions:1,operation:Operation::Merge}).unwrap();
    assert_eq!(single.unsigned_plan,batch.unsigned_plan);assert_eq!(vec![single.fee],batch.fees);
}

use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use tbc_engine_core::{call_json,EngineMethod};
fn base()->Value{serde_json::from_str(include_str!("../../../fixtures/tbc-transfer.json")).unwrap()}
fn hash(v:&Value)->String{hex(&Sha256::digest(serde_json::to_vec(v).unwrap()))}
fn call(method:EngineMethod,v:&Value)->Value{serde_json::from_str(&call_json(method,&v.to_string())).unwrap()}
fn ok(method:EngineMethod,v:&Value)->Value{
    let r=call(method,v);assert_eq!(r["ok"],true,"{}",r["error"]);
    if std::env::var("LP_DUMP_WIRE").as_deref()==Ok("1"){
        let(a,b)=match method{EngineMethod::NormalizeRequest=>("normalizeRequestParams","normalizeRequestResult"),EngineMethod::Plan=>("planParams","planResult"),EngineMethod::Validate=>("validateParams","validationResult"),EngineMethod::Finalize=>("finalizeParams","finalizeResult")};
        println!("LP_WIRE:{}",json!({"definition":a,"value":v}));println!("LP_WIRE:{}",json!({"definition":b,"value":r["result"]}));
    }r["result"].clone()
}
fn public_input(m:&Material,kind:&str)->Value{
    let f:Value=serde_json::from_str(include_str!("../../../fixtures/amm-lp-proof.json")).unwrap();
    let locked=m.parents[0].code().timelocked;let seq=&f["sequences"][usize::from(locked)];let pool=seq["transactions"][2].as_str().unwrap();
    let mut p=base()["planInput"].clone();
    p["request"]["intent"]=json!({"type":kind,"version":"1.0","poolContractId":pool});
    if kind=="tbc20-lp-transfer"{p["request"]["intent"]["to"]=p["request"]["from"].clone();}
    if matches!(kind,"tbc20-lp-transfer"|"tbc20-lp-lock"){p["request"]["intent"]["amount"]=json!("2500");}
    if kind=="tbc20-lp-lock"{p["request"]["intent"]["lockTime"]=json!("900000");}
    p["request"]["constraints"]["maxFee"]=json!("10000");
    let mut utxos:Vec<_>=m.parents.iter().map(|parent|json!({"txid":parent.selected().txid.to_string(),"vout":parent.selected().vout,
        "satoshis":"500","scriptPubKey":hex(parent.transaction().outputs[parent.selected().vout as usize].script_pubkey.as_bytes()),"classification":"ftlp","contractId":pool,"confirmations":"0"})).collect();
    utxos.push(json!({"txid":m.fee_point.txid.to_string(),"vout":m.fee_point.vout,"satoshis":m.fee_output.satoshis.to_string(),"scriptPubKey":hex(m.fee_output.script_pubkey.as_bytes()),"classification":"native","confirmations":"0"}));
    // Force all supplied fragments for transfer/lock; no silently substituted input.
    p["request"]["constraints"]["inputOutpoints"]=json!(utxos.iter().map(|u|json!({"txid":u["txid"],"vout":u["vout"]})).collect::<Vec<_>>());
    p["snapshot"]["payload"]["utxos"]=json!(utxos);p["snapshot"]["payload"]["block"]["height"]=json!("830000");
    let mut ids=BTreeSet::from([pool.to_owned(),seq["transactions"][1].as_str().unwrap().into(),m.known[pool].inputs[0].previous_output.txid.to_string()]);
    for parent in &m.parents{ids.insert(parent.selected().txid.to_string());for d in parent.dependencies(){ids.insert(d.txid.to_string());}}
    p["snapshot"]["payload"]["parents"]=json!(ids.iter().map(|id|json!({"txid":id,"rawTransaction":m.known[id].to_hex()})).collect::<Vec<_>>());
    p["snapshot"]["payload"]["contracts"]=json!([{"contractId":pool,"family":"pool","protocolVersion":"pool3","standardId":"tbc-amm",
        "templateRevision":if locked{"cf7f95c0483b56ad24825591acbce6e82e37890aa0047fc63183d3fb7a7a4ffc"}else{"c98ecae0a22452ce37bcaf24be0c836521d3de3a75aa8f16cef587b8b6f031b2"},
        "creationTxid":pool,"genesisOutpoint":{"txid":pool,"vout":0},"currentOutpoint":{"txid":pool,"vout":0}}]);
    p["policy"]["payload"]["dustThreshold"]=json!("10");p["policy"]["payload"]["minConfirmations"]=json!("0");
    p["policy"]["payload"]["maxBundleTransactions"]=json!(32);p["policy"]["payload"]["contractPolicies"]=json!([{"family":"pool","allowedVersions":["pool3"]}]);
    let r=ok(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":p["request"]}));p["request"]=r["request"].clone();p["requestHash"]=r["requestHash"].clone();
    p["snapshot"]["snapshotHash"]=json!(hash(&p["snapshot"]["payload"]));p["policy"]["policyHash"]=json!(hash(&p["policy"]["payload"]));p
}
fn public_sign(tasks:&Value)->Value{
    let mut scalar=[0;32];scalar[31]=1;let key=SecretKey::from_byte_array(scalar).unwrap();let secp=Secp256k1::new();
    json!(tasks.as_array().unwrap().iter().map(|t|json!({"taskId":t["taskId"],"signatureEncoding":"compact64",
        "signature":hex(&secp.sign_ecdsa(Message::from_digest(bytes(t["digest"].as_str().unwrap()).try_into().unwrap()),&key).serialize_compact())})).collect::<Vec<_>>())
}
#[test]
fn public_lp_multiround_uses_shared_binding_and_continuations(){
    for(count,locked,kind)in [(6,false,"tbc20-lp-transfer"),(10,false,"tbc20-lp-merge"),(6,true,"tbc20-lp-lock"),(26,true,"tbc20-lp-unlock")]{
        let m=fragmented(count,locked);let p=public_input(&m,kind);let planned=ok(EngineMethod::Plan,&p);
        let mut binding=base()["finalizeInput"]["binding"].clone();binding["payload"]["requestHash"]=p["requestHash"].clone();binding["payload"]["operationHash"]=planned["plan"]["planHash"].clone();
        binding["payload"]["expiresAt"]=planned["plan"]["payload"]["expiresAt"].clone();binding["bindingHash"]=json!(hash(&binding["payload"]));
        let mut approval=base()["finalizeInput"]["approval"].clone();approval["bindingHash"]=binding["bindingHash"].clone();approval["expiresAt"]=binding["payload"]["expiresAt"].clone();
        let mut execution=p.clone();execution["plan"]=planned["plan"].clone();execution["binding"]=binding;execution["approval"]=approval;
        let mut check=execution.clone();check["phase"]=json!("pre-sign");assert_eq!(ok(EngineMethod::Validate,&check)["valid"],true);
        execution["signatures"]=public_sign(&planned["plan"]["payload"]["signingTasks"]);let mut done=ok(EngineMethod::Finalize,&execution);let mut rounds=1;
        while done.get("continuation").is_some(){
            assert_eq!(done["continuation"]["family"],"pool");execution["continuation"]=done["continuation"].clone();execution["signatures"]=public_sign(&done["signingRequests"]);
            done=ok(EngineMethod::Finalize,&execution);rounds+=1;assert!(rounds<=32);
        }
        assert_eq!(rounds,(count-2)/4+1);assert_eq!(done["bundle"]["transactions"].as_array().unwrap().len(),rounds);
        check=execution.clone();check["phase"]=json!("pre-broadcast");check["bundle"]=done["bundle"].clone();let validation=ok(EngineMethod::Validate,&check);assert_eq!(validation["valid"],true,"{validation}");
        let mut wrong=execution.clone();wrong["approval"]["bindingHash"]=json!("00".repeat(32));assert_eq!(call(EngineMethod::Finalize,&wrong)["ok"],false);
    }
}
