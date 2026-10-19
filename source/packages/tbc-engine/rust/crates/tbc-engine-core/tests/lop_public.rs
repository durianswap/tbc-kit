//! Public synthetic fixtures only. No wallet keys, HTTP or broadcasts.
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use tbc_sdk::{PrivateKey,Transaction,OutPoint,UtxoInfo,script::Script};
use tbc_engine_core::{call_json,EngineMethod,protocols::{lop::*,lop_transaction,lop_token::{self,TokenProfile,TokenInput,ChainContext,MakeOptions},
    tbc20,coin,tbc20_transfer::FeeInput},signing::{begin_signing,finalize_signing_stage,ExternalSignature,StageOutcome}};
fn base()->Value{serde_json::from_str(include_str!("../../../fixtures/tbc-transfer.json")).unwrap()}
fn hex(v:&[u8])->String{v.iter().map(|b|format!("{b:02x}")).collect()}
fn bytes(s:&str)->Vec<u8>{s.as_bytes().chunks_exact(2).map(|b|u8::from_str_radix(std::str::from_utf8(b).unwrap(),16).unwrap()).collect()}
fn key()->PrivateKey{let mut b=[0;32];b[31]=1;PrivateKey::from_slice(&b).unwrap()}
fn hash(v:&Value)->String{hex(&Sha256::digest(serde_json::to_vec(v).unwrap()))}
fn call(m:EngineMethod,v:&Value)->Value{serde_json::from_str(&call_json(m,&v.to_string())).unwrap()}
fn ok(m:EngineMethod,v:&Value)->Value{let r=call(m,v);assert_eq!(r["ok"],true,"{r}");
    if std::env::var("LOP_PUBLIC_DUMP_WIRE").as_deref()==Ok("1"){
        let(a,b)=match m{EngineMethod::NormalizeRequest=>("normalizeRequestParams","normalizeRequestResult"),EngineMethod::Plan=>("planParams","planResult"),
            EngineMethod::Validate=>("validateParams","validationResult"),EngineMethod::Finalize=>("finalizeParams","finalizeResult")};
        println!("LOP_PUBLIC_WIRE:{}",json!({"definition":a,"value":v}));println!("LOP_PUBLIC_WIRE:{}",json!({"definition":b,"value":r["result"]}));
    }r["result"].clone()}
fn bind(mut p:Value)->Value{let n=ok(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":p["request"]}));p["request"]=n["request"].clone();p["requestHash"]=n["requestHash"].clone();
    p["snapshot"]["snapshotHash"]=json!(hash(&p["snapshot"]["payload"]));p["policy"]["policyHash"]=json!(hash(&p["policy"]["payload"]));p}
fn setup(native:bool,is_coin:bool,pair:bool,buy:bool)->Value{
    setup_volume(native,is_coin,pair,buy,100)
}
fn setup_volume(native:bool,is_coin:bool,pair:bool,buy:bool,volume:u64)->Value{
    setup_owner(native,is_coin,pair,buy,volume,1)
}
fn signed_fixture(plan:&tbc_engine_core::signing::UnsignedPlan,key:&PrivateKey)->Transaction{
    let stage=begin_signing(plan).unwrap();let sig=stage.signing_requests.iter().map(|r|ExternalSignature{session_id:r.session_id.clone(),stage:r.stage,stage_commitment:r.stage_commitment.clone(),
        transaction_id:r.transaction_id.clone(),input_index:r.input_index,digest:r.digest.clone(),public_key:r.public_key.clone(),signature:hex(&key.sign_ecdsa_digest(&bytes(&r.digest).try_into().unwrap()))}).collect::<Vec<_>>();
    let StageOutcome::Complete(bundle)=finalize_signing_stage(plan,stage,&sig).unwrap()else{panic!()};
    Transaction::from_hex(&bundle.transactions[0].raw_transaction).unwrap()
}
fn handoff(parent:&Transaction,vout:usize,ancestors:&[Transaction],is_coin:bool,recipient:&tbc_sdk::PublicKey)->Transaction{
    use tbc_engine_core::protocols::{tbc20_material,coin_proof,tbc20_transfer,coin_transfer};
    let owner=key();let public=owner.public_key();let raw=parent.serialize();let point=OutPoint{txid:parent.txid(),vout:vout as u32};
    let raws:Vec<_>=ancestors.iter().map(Transaction::serialize).collect();let refs:Vec<_>=raws.iter().map(Vec::as_slice).collect();
    let mut receiver=[0;21];receiver[..20].copy_from_slice(&recipient.hash160());let mut change=[0;21];change[..20].copy_from_slice(&public.hash160());
    let fee=FeeInput{outpoint:OutPoint{txid:parent.txid(),vout:(parent.outputs.len()-1)as u32},output:parent.outputs.last().unwrap(),public_key:&public};
    let plan=if is_coin{
        let material=coin_proof::inspect_parent(&raw,&point,None).unwrap();
        coin_transfer::build_transfer_plan(coin_transfer::TransferOptions{inputs:&[coin_transfer::CoinInput{parent:&material,ancestor_raws:&refs,public_key:&public}],fee_input:&fee,
            receivers:&[tbc20_transfer::Receiver{controller:receiver,amount:material.tape().balance}],expected_identity:material.identity(),token_change_controller:change,
            additional_payment:None,additional_info:None,max_fee:10000}).unwrap()
    }else{
        let material=tbc20_material::inspect_parent(&raw,&point,None).unwrap();let linked=tbc20_material::link_ancestors(&material,&refs).unwrap();
        tbc20_transfer::build_transfer_plan(tbc20_transfer::TransferOptions{inputs:&[tbc20_transfer::TokenInput{parent:&material,ancestors:&linked,public_key:&public}],fee_inputs:&[fee],
            receivers:&[tbc20_transfer::Receiver{controller:receiver,amount:material.tape().balance}],expected_identity:material.identity(),token_change_controller:change,native_change_hash:public.hash160(),max_fee:10000}).unwrap()
    };signed_fixture(&plan.unsigned_plan,&owner)
}
fn setup_owner(native:bool,is_coin:bool,pair:bool,buy:bool,volume:u64,owner_byte:u8)->Value{
    setup_owner_tax(native,is_coin,pair,buy,volume,owner_byte,[3;20])
}
fn setup_owner_tax(native:bool,is_coin:bool,pair:bool,buy:bool,volume:u64,owner_byte:u8,tax_hash:[u8;20])->Value{
    let mut scalar=[0;32];scalar[31]=owner_byte;let k=PrivateKey::from_slice(&scalar).unwrap();let public=k.public_key();
    let (mut parent,mut ancestors,mut vout,asset,template)=if is_coin{
        let f:Value=serde_json::from_str(include_str!("../../../fixtures/coin-proof.json")).unwrap();
        let p=Transaction::from_hex(f["vectors"][0]["parentRaw"].as_str().unwrap()).unwrap();let a=Transaction::from_hex(f["vectors"][0]["ancestorsRaw"][0].as_str().unwrap()).unwrap();
        let id=a.txid().to_string();(p,vec![a],3,id,"c686fc271f0ee8116325bf541d87c4d2e6ad839896a9d9dd21dcf2ac847660e3")
    }else{let f:Value=serde_json::from_str(include_str!("../../../fixtures/tbc20-standard-transfer.json")).unwrap();
        let p=Transaction::from_hex(f["stages"][1]["signedRaw"].as_str().unwrap()).unwrap();let id=p.txid().to_string();
        (p,vec![Transaction::from_hex(f["stages"][0]["signedRaw"].as_str().unwrap()).unwrap()],0,id,"0f5db33bb46e4517963cbd383518f74283b5c2c4efb0a733522a1fbc0d4a9f84")};
    let anchors=std::iter::once(parent.clone()).chain(ancestors.iter().cloned()).collect::<Vec<_>>();
    if owner_byte!=1{
        let transferred=handoff(&parent,vout,&ancestors,is_coin,&public);ancestors=vec![parent];parent=transferred;vout=0;
    }
    let script=parent.outputs[vout].script_pubkey.as_bytes();let identity=if is_coin{coin::code_identity(script).unwrap()}else{tbc20::code_identity(script).unwrap()};
    let terms=AssetTerms{partial_hash:identity[..32].try_into().unwrap(),contract_id:bytes(&asset).try_into().unwrap()};
    // The other side is a distinct, genuine issuance fixture, not an alias ID.
    let (other_parent,other_id,other_vout)=if is_coin{
        let f:Value=serde_json::from_str(include_str!("../../../fixtures/tbc20-standard-transfer.json")).unwrap();
        let p=Transaction::from_hex(f["stages"][1]["signedRaw"].as_str().unwrap()).unwrap();let id=p.txid().to_string();(p,id,0)
    }else{
        let f:Value=serde_json::from_str(include_str!("../../../fixtures/coin-proof.json")).unwrap();
        let p=Transaction::from_hex(f["vectors"][0]["parentRaw"].as_str().unwrap()).unwrap();
        let a=Transaction::from_hex(f["vectors"][0]["ancestorsRaw"][0].as_str().unwrap()).unwrap();(p,a.txid().to_string(),3)
    };
    let other_script=other_parent.outputs[other_vout].script_pubkey.as_bytes();
    let other_identity=if is_coin{tbc20::code_identity(other_script).unwrap()}else{coin::code_identity(other_script).unwrap()};
    let other=AssetTerms{partial_hash:other_identity[..32].try_into().unwrap(),contract_id:bytes(&other_id).try_into().unwrap()};
    let code=Code{side:if native||(!buy&&pair){Side::Sell}else{Side::Buy},market:if pair{Market::TokenToken{a:TapeMarker::Modern,b:TapeMarker::Modern}}
        else{Market::NativeToken{token_code_bytes:script.len()as u16,marker:TapeMarker::Modern}},tax_hash,
        terms:Terms{owner_hash:public.hash160(),sale_volume:volume,unit_price:1_000_000,fee_rate:100_000,
            asset_a:if pair&&buy{other.clone()}else{terms.clone()},asset_b:pair.then_some(if buy{terms}else{other})}};
    // Independent synthetic fee stock for each order. No order pair double-spends
    // the holder's funding output; this is still offline material, not a chain claim.
    let funding=Transaction{version:10,lock_time:if native{1}else{2},inputs:vec![],outputs:vec![tbc_sdk::TxOut{satoshis:100000,script_pubkey:Script::p2pkh(&public.hash160())}]};
    let fee=FeeInput{outpoint:OutPoint{txid:funding.txid(),vout:0},output:&funding.outputs[0],public_key:&public};
    let refs:Vec<_>=ancestors.iter().collect();let inputs=[TokenInput{parent:&parent,vout:vout as u32,ancestors:&refs}];
    let built=if native{lop_transaction::build_native_sell_plan(&[UtxoInfo{outpoint:fee.outpoint.clone(),satoshis:fee.output.satoshis,script_pubkey:fee.output.script_pubkey.clone()}],&public,&code,script,10000).unwrap()}
        else{lop_token::build_make_plan(MakeOptions{profile:if is_coin{TokenProfile::Coin}else{TokenProfile::Tbc20},inputs:&inputs,funding:&fee,
            expected_identity:&identity,code:&code,asset_a_code:if pair&&buy{other_script}else{script},asset_b_code:pair.then_some(if buy{script}else{other_script}),chain:ChainContext{height:Some(830000),median_time_past:Some(1774427100)},max_fee:10000}).unwrap()};
    let stage=begin_signing(&built.unsigned_plan).unwrap();let sig=stage.signing_requests.iter().map(|r|ExternalSignature{session_id:r.session_id.clone(),stage:r.stage,stage_commitment:r.stage_commitment.clone(),
        transaction_id:r.transaction_id.clone(),input_index:r.input_index,digest:r.digest.clone(),public_key:r.public_key.clone(),signature:hex(&k.sign_ecdsa_digest(&bytes(&r.digest).try_into().unwrap()))}).collect::<Vec<_>>();
    let StageOutcome::Complete(bundle)=finalize_signing_stage(&built.unsigned_plan,stage,&sig).unwrap()else{panic!()};
    let order=Transaction::from_hex(&bundle.transactions[0].raw_transaction).unwrap();let id=order.txid().to_string();
    let mut p=base()["planInput"].clone();p["request"]["intent"]=json!({"type":"tbc-lop-cancel","version":"1.0","targetOutpoints":[{"txid":id,"vout":0}]});
    p["request"]["constraints"]=json!({"maxFee":"10000"});p["snapshot"]["payload"]["block"]["height"]=json!("830000");
    p["snapshot"]["payload"]["block"]["medianTimePast"]=json!("1774427100");
    let descriptor=|i:usize,kind:&str|json!({"txid":id,"vout":i,"satoshis":order.outputs[i].satoshis.to_string(),"scriptPubKey":hex(order.outputs[i].script_pubkey.as_bytes()),"classification":kind,"confirmations":"6"});
    let family=if is_coin{"stablecoin"}else{"ft"};let mut utxos=vec![descriptor(0,"lop"),descriptor(order.outputs.len()-1,"native")];
    if !native{let mut token=descriptor(1,family);token["contractId"]=json!(asset);utxos.push(token);}
    p["snapshot"]["payload"]["utxos"]=json!(utxos);
    let all:std::collections::BTreeMap<_,_>=std::iter::once(&order).chain(std::iter::once(&parent)).chain(ancestors.iter()).chain(anchors.iter()).map(|t|(t.txid().to_string(),t)).collect();
    p["snapshot"]["payload"]["parents"]=json!(all.into_values().map(|t|json!({"txid":t.txid().to_string(),"rawTransaction":t.to_hex()})).collect::<Vec<_>>());
    p["snapshot"]["payload"]["contracts"]=if native{json!([])}else{json!([{"contractId":asset,"family":family,"protocolVersion":if is_coin{"coin"}else{"tbc20"},"standardId":if is_coin{"tbc20-stablecoin"}else{"tbc20-standard"},
        "templateRevision":template,"creationTxid":asset,"genesisOutpoint":{"txid":asset,"vout":0},"currentOutpoint":{"txid":id,"vout":1}}])};
    p["policy"]["payload"]["dustThreshold"]=json!("42");p["policy"]["payload"]["contractPolicies"]=json!([{"family":family,"allowedVersions":[if is_coin{"coin"}else{"tbc20"}]}]);bind(p)
}
fn approve(p:&Value,plan:&Value)->Value{
    approve_key(p,plan,1)
}
fn setup_create(pair:bool,buy:bool,coin_first:bool)->Value{
    let mut p=base()["planInput"].clone();
    let ft:Value=serde_json::from_str(include_str!("../../../fixtures/tbc20-standard-transfer.json")).unwrap();
    let coin_fixture:Value=serde_json::from_str(include_str!("../../../fixtures/coin-proof.json")).unwrap();
    let ft_parent=Transaction::from_hex(ft["stages"][1]["signedRaw"].as_str().unwrap()).unwrap();
    let ft_source=Transaction::from_hex(ft["stages"][0]["signedRaw"].as_str().unwrap()).unwrap();
    let coin_parent=Transaction::from_hex(coin_fixture["vectors"][0]["parentRaw"].as_str().unwrap()).unwrap();
    let coin_source=Transaction::from_hex(coin_fixture["vectors"][0]["ancestorsRaw"][0].as_str().unwrap()).unwrap();
    let funding=Transaction{version:10,lock_time:1,inputs:vec![],outputs:vec![tbc_sdk::TxOut{satoshis:100000,script_pubkey:Script::p2pkh(&key().public_key().hash160())}]};
    let ft_id=ft_parent.txid().to_string();let coin_id=coin_source.txid().to_string();
    let ft_asset=json!({"standard":"tbc20-standard","contractId":ft_id});
    let coin_asset=json!({"standard":"tbc20-stablecoin","contractId":coin_id});
    let mut order=json!({"side":if buy{"buy"}else{"sell"},"market":if pair{"token-token"}else{"native-token"},
        "assetA":if coin_first{coin_asset.clone()}else{ft_asset.clone()},"saleVolume":"100","unitPrice":"1000000","feeRate":"100000",
        "feeRecipient":tbc_sdk::Address::from_hash160([3;20]).to_string()});
    if pair{order["assetB"]=if coin_first{ft_asset}else{coin_asset};}
    p["request"]["intent"]=json!({"type":"tbc-lop-create","version":"1.0","order":order});
    p["request"]["constraints"]=json!({"maxFee":"10000"});
    p["snapshot"]["payload"]["block"]["height"]=json!("830000");p["snapshot"]["payload"]["block"]["medianTimePast"]=json!("1774427100");
    let row=|tx:&Transaction,vout:usize,family:&str|json!({"txid":tx.txid().to_string(),"vout":vout,"satoshis":tx.outputs[vout].satoshis.to_string(),
        "scriptPubKey":hex(tx.outputs[vout].script_pubkey.as_bytes()),"classification":family,"confirmations":"6"});
    let mut ft_row=row(&ft_parent,0,"ft");ft_row["contractId"]=json!(ft_id);
    let mut coin_row=row(&coin_parent,3,"stablecoin");coin_row["contractId"]=json!(coin_id);
    p["snapshot"]["payload"]["utxos"]=json!([row(&funding,0,"native"),ft_row,coin_row]);
    p["snapshot"]["payload"]["parents"]=json!([&funding,&ft_parent,&ft_source,&coin_parent,&coin_source].iter().map(|tx|json!({"txid":tx.txid().to_string(),"rawTransaction":tx.to_hex()})).collect::<Vec<_>>());
    p["snapshot"]["payload"]["contracts"]=json!([
        {"contractId":ft_id,"family":"ft","protocolVersion":"tbc20","standardId":"tbc20-standard","templateRevision":"0f5db33bb46e4517963cbd383518f74283b5c2c4efb0a733522a1fbc0d4a9f84","creationTxid":ft_id,"genesisOutpoint":{"txid":ft_id,"vout":0},"currentOutpoint":{"txid":ft_id,"vout":0}},
        {"contractId":coin_id,"family":"stablecoin","protocolVersion":"coin","standardId":"tbc20-stablecoin","templateRevision":"c686fc271f0ee8116325bf541d87c4d2e6ad839896a9d9dd21dcf2ac847660e3","creationTxid":coin_id,"genesisOutpoint":{"txid":coin_id,"vout":0},"currentOutpoint":{"txid":coin_parent.txid().to_string(),"vout":3}}
    ]);
    p["policy"]["payload"]["dustThreshold"]=json!("42");
    p["policy"]["payload"]["contractPolicies"]=json!([{"family":"ft","allowedVersions":["tbc20"]},{"family":"stablecoin","allowedVersions":["coin"]}]);
    bind(p)
}
#[test]
fn public_lop_create_uses_shared_bound_signer_and_finalize(){
    for pair in[false,true]{for buy in[false,true]{for coin_first in[false,true]{
        let p=setup_create(pair,buy,coin_first);let plan=ok(EngineMethod::Plan,&p);let signed=approve(&p,&plan);
        let mut validate=signed.clone();validate.as_object_mut().unwrap().remove("signatures");validate["phase"]=json!("pre-sign");
        assert_eq!(ok(EngineMethod::Validate,&validate)["valid"],true);
        let result=ok(EngineMethod::Finalize,&signed);validate=signed.clone();validate["phase"]=json!("pre-broadcast");validate["bundle"]=result["bundle"].clone();
        assert_eq!(ok(EngineMethod::Validate,&validate)["valid"],true);
        let tx=Transaction::from_hex(result["bundle"]["transactions"][0]["rawTransaction"].as_str().unwrap()).unwrap();
        let code=Code::decode(tx.outputs[0].script_pubkey.as_bytes()).unwrap();
        assert_eq!(code.side,if buy{Side::Buy}else{Side::Sell});assert_eq!(code.terms.owner_hash,key().public_key().hash160());
        assert_eq!(code.terms.sale_volume,100);assert_eq!(code.terms.unit_price,1_000_000);assert_eq!(code.terms.fee_rate,100_000);assert_eq!(code.tax_hash,[3;20]);
        assert_eq!(code.terms.asset_a.contract_id,bytes(p["request"]["intent"]["order"]["assetA"]["contractId"].as_str().unwrap()).as_slice());
        assert_eq!(tx.inputs.len(),if !pair&&!buy{1}else{2});
        let mut bad=signed;bad["binding"]["payload"]["operationHash"]=json!("ff".repeat(32));assert_eq!(call(EngineMethod::Finalize,&bad)["ok"],false);
    }}}
}
#[test]
fn public_lop_create_rejects_unbound_terms_and_material(){
    let p=setup_create(true,true,false);
    for change in 0..11{let mut bad=p.clone();match change{
        0=>bad["request"]["intent"]["order"]["feeRecipient"]=json!("invalid"),
        1=>bad["request"]["intent"]["order"]["saleVolume"]=json!("0"),
        2=>bad["request"]["intent"]["order"]["unitPrice"]=json!("1.5"),
        3=>bad["request"]["intent"]["order"]["assetB"]=bad["request"]["intent"]["order"]["assetA"].clone(),
        4=>bad["request"]["intent"]["order"]["ownerHash"]=json!("ff".repeat(20)),
        5=>bad["snapshot"]["payload"]["contracts"][1]["templateRevision"]=json!("ff".repeat(32)),
        6=>bad["snapshot"]["payload"]["parents"]=json!([]),
        7=>bad["snapshot"]["payload"]["utxos"][2]["scriptPubKey"]=json!("51"),
        8=>bad["snapshot"]["payload"]["contracts"][1]["currentOutpoint"]["vout"]=json!(0),
        9=>{bad["snapshot"]["payload"]["utxos"][2]["confirmations"]=json!("0");bad["policy"]["payload"]["minConfirmations"]=json!("1");},
        _=>bad["policy"]["payload"]["amountLimits"]=json!([{"scope":"stablecoin-total","maximum":"1","contractId":p["request"]["intent"]["order"]["assetB"]["contractId"]}]),
    }
        if change<5{assert_eq!(call(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":bad["request"]}))["ok"],false,"case {change}");}
        else{bad=bind(bad);assert_eq!(call(EngineMethod::Plan,&bad)["ok"],false,"case {change}");}
    }
}
#[test]
fn public_lop_create_respects_exact_inputs_policy_and_integer_rounding(){
    // Native sell authenticates its quote asset without needing an owned or
    // spendable quote UTXO. Immutable issuer metadata is not a balance query.
    for is_coin in[false,true]{
        let mut p=setup_create(false,false,is_coin);
        let native=p["snapshot"]["payload"]["utxos"][0].clone();
        p["snapshot"]["payload"]["utxos"]=json!([native]);
        p["request"]["intent"]["order"]["feeRate"]=json!("0");p=bind(p);
        assert_eq!(call(EngineMethod::Plan,&p)["ok"],true);
        let mut bad=p.clone();bad["policy"]["payload"]["contractPolicies"][if is_coin{1}else{0}]["allowedVersions"]=json!(["legacy"]);
        assert_eq!(call(EngineMethod::Plan,&bind(bad))["ok"],false);
    }
    let p=setup_create(true,true,false);
    let fee=&p["snapshot"]["payload"]["utxos"][0];let coin=&p["snapshot"]["payload"]["utxos"][2];
    let mut exact=p.clone();exact["request"]["constraints"]["inputOutpoints"]=json!([
        {"txid":fee["txid"],"vout":fee["vout"]},{"txid":coin["txid"],"vout":coin["vout"]}
    ]);exact=bind(exact);assert_eq!(call(EngineMethod::Plan,&exact)["ok"],true);
    // An explicitly requested unrelated input must not silently disappear.
    let ft=&p["snapshot"]["payload"]["utxos"][1];
    exact["request"]["constraints"]["inputOutpoints"].as_array_mut().unwrap().push(json!({"txid":ft["txid"],"vout":ft["vout"]}));
    assert_eq!(call(EngineMethod::Plan,&bind(exact))["ok"],false);
    let mut rounded=p.clone();rounded["request"]["intent"]["order"]["unitPrice"]=json!("1");
    assert_eq!(call(EngineMethod::Plan,&bind(rounded))["ok"],false);
    let mut over=p;over["request"]["intent"]["order"]["saleVolume"]=json!("9223372036854775808");
    assert_eq!(call(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":over["request"]}))["ok"],false);
}
fn approve_key(p:&Value,plan:&Value,scalar_byte:u8)->Value{
    let mut binding=base()["finalizeInput"]["binding"].clone();binding["payload"]["requestHash"]=p["requestHash"].clone();binding["payload"]["operationHash"]=plan["plan"]["planHash"].clone();
    binding["payload"]["chainId"]=p["request"]["chainId"].clone();binding["payload"]["accountId"]=p["snapshot"]["payload"]["account"]["accountId"].clone();binding["payload"]["expiresAt"]=plan["plan"]["payload"]["expiresAt"].clone();binding["bindingHash"]=json!(hash(&binding["payload"]));
    let mut approval=base()["finalizeInput"]["approval"].clone();approval["bindingHash"]=binding["bindingHash"].clone();approval["expiresAt"]=binding["payload"]["expiresAt"].clone();
    let mut scalar=[0;32];scalar[31]=scalar_byte;let key=secp256k1::SecretKey::from_byte_array(scalar).unwrap();
    let sigs=plan["plan"]["payload"]["signingTasks"].as_array().unwrap().iter().map(|t|json!({"taskId":t["taskId"],"signatureEncoding":"compact64",
        "signature":hex(&secp256k1::Secp256k1::new().sign_ecdsa(secp256k1::Message::from_digest(bytes(t["digest"].as_str().unwrap()).try_into().unwrap()),&key).serialize_compact())})).collect::<Vec<_>>();
    let mut signed=p.clone();signed["plan"]=plan["plan"].clone();signed["binding"]=binding;signed["approval"]=approval;signed["signatures"]=json!(sigs);signed
}
#[test]
fn public_lop_cancel_uses_shared_bound_signer_and_finalize(){
    for(native,coin,pair,buy)in[(true,false,false,false),(false,false,false,true),(false,true,false,true),(false,false,true,false),(false,true,true,false),(false,false,true,true),(false,true,true,true)]{
        let p=setup(native,coin,pair,buy);let plan=ok(EngineMethod::Plan,&p);let signed=approve(&p,&plan);
        let mut validate=signed.clone();validate.as_object_mut().unwrap().remove("signatures");validate["phase"]=json!("pre-sign");let checked=ok(EngineMethod::Validate,&validate);assert_eq!(checked["valid"],true,"{checked}");
        let result=ok(EngineMethod::Finalize,&signed);validate=signed.clone();validate["phase"]=json!("pre-broadcast");validate["bundle"]=result["bundle"].clone();let checked=ok(EngineMethod::Validate,&validate);assert_eq!(checked["valid"],true,"{checked}");
        let tx=Transaction::from_hex(result["bundle"]["transactions"][0]["rawTransaction"].as_str().unwrap()).unwrap();
        assert_eq!(tx.inputs.len(),if native{2}else{3});
        if native{assert_eq!(tx.outputs[0].satoshis,100);assert_eq!(tx.outputs[0].script_pubkey,Script::p2pkh(&key().public_key().hash160()));}
        let mut tampered=signed;tampered["binding"]["payload"]["operationHash"]=json!("ff".repeat(32));assert_eq!(call(EngineMethod::Finalize,&tampered)["ok"],false);
    }
}
#[test]
fn public_lop_cancel_rejects_missing_authority_asset_anchor_and_current_status(){
    for is_coin in[false,true]{let p=setup(false,is_coin,false,true);
        for change in 0..9{let mut bad=p.clone();match change{
            0=>bad["snapshot"]["payload"]["utxos"][0]["satoshis"]=json!("301"),
            1=>bad["snapshot"]["payload"]["utxos"][2]["contractId"]=json!("ff".repeat(32)),
            2=>bad["snapshot"]["payload"]["contracts"][0]["templateRevision"]=json!("ff".repeat(32)),
            3=>bad["snapshot"]["payload"]["parents"]=json!([]),
            4=>{bad["snapshot"]["payload"]["utxos"][0]["confirmations"]=json!("0");bad["policy"]["payload"]["minConfirmations"]=json!("1");},
            5=>bad["snapshot"]["payload"]["utxos"][0]["classification"]=json!("native"),
            6=>bad["policy"]["payload"]["amountLimits"]=json!([{"scope":if is_coin{"stablecoin-total"}else{"ft-total"},"maximum":"1","contractId":p["snapshot"]["payload"]["contracts"][0]["contractId"]}]),
            7=>{let row=bad["snapshot"]["payload"]["utxos"][0].clone();bad["snapshot"]["payload"]["utxos"].as_array_mut().unwrap().push(row);},
            _=>{let mut scalar=[0;32];scalar[31]=2;let other=PrivateKey::from_slice(&scalar).unwrap().public_key();
                bad["request"]["from"]=json!(other.address().to_string());bad["snapshot"]["payload"]["account"]["address"]=bad["request"]["from"].clone();
                bad["snapshot"]["payload"]["account"]["publicKey"]=json!(hex(&other.to_bytes()));},
        }bad=bind(bad);let result=call(EngineMethod::Plan,&bad);assert_eq!(result["ok"],false,"coin={is_coin}, change={change}");
            assert_ne!(result["error"]["code"],"UNSUPPORTED_INTENT");
            if change==6{assert!(result["error"]["message"].as_str().unwrap().contains("amount exceeds"));}
            if change==8{assert!(result["error"]["message"].as_str().unwrap().contains("order owner's account"));}
        }
    }
    let mut p=setup(true,false,false,false);p["request"]["intent"]["to"]=json!(p["request"]["from"]);
    assert_eq!(call(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":p["request"]}))["ok"],false);
}

fn setup_match(pair:bool,quote_coin:bool,buy_volume:u64,sell_volume:u64)->Value{
    setup_match_owner(pair,quote_coin,buy_volume,sell_volume,2)
}
fn setup_match_owner(pair:bool,quote_coin:bool,buy_volume:u64,sell_volume:u64,buyer:u8)->Value{
    setup_match_tax(pair,quote_coin,buy_volume,sell_volume,buyer,[3;20])
}
fn setup_match_tax(pair:bool,quote_coin:bool,buy_volume:u64,sell_volume:u64,buyer:u8,seller_tax:[u8;20])->Value{
    use std::collections::BTreeMap;
    let buy=setup_owner(false,quote_coin,pair,true,buy_volume,buyer);
    let sell=setup_owner_tax(!pair,if pair{!quote_coin}else{quote_coin},pair,false,sell_volume,1,seller_tax);
    let mut scalar=[0;32];scalar[31]=4;let matcher=PrivateKey::from_slice(&scalar).unwrap().public_key();
    let fee=tbc_sdk::Transaction{version:10,lock_time:0,inputs:vec![],outputs:vec![tbc_sdk::TxOut{satoshis:100000,script_pubkey:Script::p2pkh(&matcher.hash160())}]};
    let fee_id=fee.txid().to_string();let mut p=buy.clone();
    p["request"]["from"]=json!(matcher.address().to_string());
    p["snapshot"]["payload"]["account"]["address"]=p["request"]["from"].clone();
    p["snapshot"]["payload"]["account"]["accountId"]=json!(format!("{}:{}",p["request"]["chainId"].as_str().unwrap(),matcher.address()));
    p["snapshot"]["payload"]["account"]["publicKey"]=json!(hex(&matcher.to_bytes()));
    p["request"]["intent"]=json!({"type":"tbc-lop-match","version":"1.0","targetOutpoints":[buy["request"]["intent"]["targetOutpoints"][0],sell["request"]["intent"]["targetOutpoints"][0]]});
    let mut parents=BTreeMap::new();let mut contracts=BTreeMap::new();let mut utxos=vec![];
    for source in [&buy,&sell]{
        for row in source["snapshot"]["payload"]["parents"].as_array().unwrap(){parents.insert(row["txid"].as_str().unwrap().to_owned(),row.clone());}
        for row in source["snapshot"]["payload"]["contracts"].as_array().unwrap(){contracts.insert(row["contractId"].as_str().unwrap().to_owned(),row.clone());}
        for row in source["snapshot"]["payload"]["utxos"].as_array().unwrap(){if row["classification"]!="native"{utxos.push(row.clone());}}
    }
    parents.insert(fee_id.clone(),json!({"txid":fee_id,"rawTransaction":fee.to_hex()}));
    utxos.push(json!({"txid":fee_id,"vout":0,"satoshis":"100000","scriptPubKey":hex(fee.outputs[0].script_pubkey.as_bytes()),"classification":"native","confirmations":"6"}));
    p["snapshot"]["payload"]["parents"]=json!(parents.into_values().collect::<Vec<_>>());
    p["snapshot"]["payload"]["contracts"]=json!(contracts.into_values().collect::<Vec<_>>());
    p["snapshot"]["payload"]["utxos"]=json!(utxos);
    p["policy"]["payload"]["contractPolicies"]=json!([{"family":"ft","allowedVersions":["tbc20"]},{"family":"stablecoin","allowedVersions":["coin"]}]);
    bind(p)
}
#[test]
fn public_lop_match_rejects_distinct_fee_recipients_without_signing_tasks(){
    for pair in [false,true]{for quote_coin in [false,true]{
        let p=setup_match_tax(pair,quote_coin,200,100,2,[8;20]);
        let result=call(EngineMethod::Plan,&p);
        assert_eq!(result["ok"],false);
        assert!(result["error"]["message"].as_str().unwrap().contains("cannot settle"));
        assert!(result.get("result").is_none(),"Rejected plans cannot expose signing tasks");
        if std::env::var_os("LOP_FEE_BOUNDARY_WIRE").is_some(){println!("LOP_FEE_BOUNDARY:{}",json!({"input":p,"result":result}));}
    }}
}
#[test]
fn public_lop_match_uses_shared_bound_signer_and_finalize(){
    for pair in [false,true]{for quote_coin in [false,true]{for (buy,sell)in[(100,100),(200,100),(100,200)]{
        let p=setup_match(pair,quote_coin,buy,sell);let plan=ok(EngineMethod::Plan,&p);
        let tasks=plan["plan"]["payload"]["signingTasks"].as_array().unwrap();
        assert_eq!(tasks.len(),if pair{3}else{2},"Only Token and fee inputs request external signatures");
        let signed=approve_key(&p,&plan,4);let mut validate=signed.clone();validate.as_object_mut().unwrap().remove("signatures");validate["phase"]=json!("pre-sign");
        let checked=ok(EngineMethod::Validate,&validate);assert_eq!(checked["valid"],true,"{checked}");
        let result=ok(EngineMethod::Finalize,&signed);validate=signed.clone();validate["phase"]=json!("pre-broadcast");validate["bundle"]=result["bundle"].clone();
        let checked=ok(EngineMethod::Validate,&validate);assert_eq!(checked["valid"],true,"{checked}");
        let tx=Transaction::from_hex(result["bundle"]["transactions"][0]["rawTransaction"].as_str().unwrap()).unwrap();
        assert_eq!(tx.inputs.len(),if pair{5}else{4});
        let continuation=if pair{9}else{7};
        if buy==sell{assert_eq!(tx.outputs.len(),continuation);}else{let code=Code::decode(tx.outputs[continuation].script_pubkey.as_bytes()).unwrap();assert_eq!(code.terms.sale_volume,100);}
        let mut bad=signed;bad["binding"]["payload"]["operationHash"]=json!("ff".repeat(32));assert_eq!(call(EngineMethod::Finalize,&bad)["ok"],false);
    }}}
}
#[test]
fn public_lop_match_rejects_wrong_order_assets_current_status_and_matcher(){
    for pair in [false,true]{
        let same=setup_match_owner(pair,true,100,100,1);let result=call(EngineMethod::Plan,&same);
        assert_eq!(result["ok"],false);assert!(result["error"]["message"].as_str().unwrap().contains("cannot settle"));
    }
    let p=setup_match(true,true,100,100);
    for change in 0..8{let mut bad=p.clone();match change{
        0=>bad["request"]["intent"]["targetOutpoints"].as_array_mut().unwrap().swap(0,1),
        1=>bad["snapshot"]["payload"]["contracts"][0]["templateRevision"]=json!("ff".repeat(32)),
        2=>bad["snapshot"]["payload"]["utxos"][1]["contractId"]=json!("ff".repeat(32)),
        3=>bad["snapshot"]["payload"]["parents"]=json!([]),
        4=>{bad["snapshot"]["payload"]["utxos"][0]["confirmations"]=json!("0");bad["policy"]["payload"]["minConfirmations"]=json!("1");},
        5=>{
            let public=key().public_key();bad["request"]["from"]=json!(public.address().to_string());bad["snapshot"]["payload"]["account"]["address"]=bad["request"]["from"].clone();bad["snapshot"]["payload"]["account"]["publicKey"]=json!(hex(&public.to_bytes()));
            let old=bad["snapshot"]["payload"]["utxos"].as_array().unwrap().last().unwrap()["txid"].as_str().unwrap().to_owned();
            let parent=bad["snapshot"]["payload"]["parents"].as_array_mut().unwrap().iter_mut().find(|r|r["txid"]==old).unwrap();
            let mut fee=Transaction::from_hex(parent["rawTransaction"].as_str().unwrap()).unwrap();fee.outputs[0].script_pubkey=Script::p2pkh(&public.hash160());
            *parent=json!({"txid":fee.txid().to_string(),"rawTransaction":fee.to_hex()});
            let row=bad["snapshot"]["payload"]["utxos"].as_array_mut().unwrap().last_mut().unwrap();row["txid"]=json!(fee.txid().to_string());row["scriptPubKey"]=json!(hex(fee.outputs[0].script_pubkey.as_bytes()));
        },
        6=>bad["policy"]["payload"]["amountLimits"]=json!([{"scope":"stablecoin-total","maximum":"1"}]),
        _=>{let row=bad["snapshot"]["payload"]["utxos"][0].clone();bad["snapshot"]["payload"]["utxos"].as_array_mut().unwrap().push(row);},
    }bad=bind(bad);let result=call(EngineMethod::Plan,&bad);assert_eq!(result["ok"],false,"change={change}");assert_ne!(result["error"]["code"],"UNSUPPORTED_INTENT");
        if change==5{assert!(result["error"]["message"].as_str().unwrap().contains("conflicts with order owner"));}
    }
    for duplicate in [false,true]{let mut bad=p.clone();
        if duplicate{bad["request"]["intent"]["targetOutpoints"][1]=bad["request"]["intent"]["targetOutpoints"][0].clone();}else{bad["request"]["intent"]["to"]=bad["request"]["from"].clone();}
        assert_eq!(call(EngineMethod::NormalizeRequest,&json!({"version":"1.0","request":bad["request"]}))["ok"],false);
    }
}
