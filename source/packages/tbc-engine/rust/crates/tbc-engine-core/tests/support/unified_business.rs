use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use secp256k1::{Keypair, Message, Secp256k1, SecretKey};
use tbc_engine_core::{call_json, EngineMethod};

fn hash(value: &Value) -> String { hex(&Sha256::digest(serde_json::to_vec(value).unwrap())) }
fn hex(bytes: &[u8]) -> String { bytes.iter().map(|b| format!("{b:02x}")).collect() }
fn call(method: EngineMethod, input: &Value) -> Value {
    let result: Value = serde_json::from_str(&call_json(method, &input.to_string())).unwrap();
    assert_eq!(result["ok"], true, "unified fixture call failed: {:?}", result["error"]);
    if std::env::var_os("UNIFIED_BUSINESS_DUMP_WIRE").is_some() {
        let method = match method { EngineMethod::NormalizeRequest=>"normalizeRequest", EngineMethod::Plan=>"plan",
            EngineMethod::Validate=>"validate", EngineMethod::Finalize=>"finalize" };
        println!("UNIFIED_BUSINESS_WIRE:{}", json!({"method":method,"input":input,"result":result}));
    }
    result["result"].clone()
}
fn signatures(tasks: &Value) -> Value {
    // Public synthetic scalars 1/2, never wallet credentials. Assert task keys
    // so an unrelated role cannot accidentally be signed by the fixture.
    let secp = Secp256k1::new();
    json!(tasks.as_array().unwrap().iter().map(|task| {
        let key = (1..=2).map(|n| {let mut scalar=[0;32];scalar[31]=n;SecretKey::from_byte_array(scalar).unwrap()})
            .find(|key|task["publicKey"]==hex(&secp256k1::PublicKey::from_secret_key(&secp,key).serialize())).expect("known public fixture key");
        let pair = Keypair::from_secret_key(&secp, &key);
        let h = task["digest"].as_str().unwrap();
        let bytes: Vec<u8> = (0..h.len()).step_by(2).map(|i| u8::from_str_radix(&h[i..i+2],16).unwrap()).collect();
        let digest: [u8;32] = bytes.try_into().unwrap();
        let signature = match task["signatureEncoding"].as_str().unwrap() {
            "compact64" => hex(&secp.sign_ecdsa(Message::from_digest(digest), &key).serialize_compact()),
            "schnorr64" => hex(secp.sign_schnorr_no_aux_rand(&digest, &pair).as_ref()),
            _ => panic!("unexpected fixture signing encoding"),
        };
        json!({"taskId":task["taskId"],"signatureEncoding":task["signatureEncoding"],"signature":signature})
    }).collect::<Vec<_>>())
}
fn complete(input: &Value, planned: &Value) -> Value {
    if planned["plan"]["payload"]["preview"].get("contractExecution").is_some() {
        let mut forged=planned["plan"].clone();
        let generation=&mut forged["payload"]["preview"]["contractExecution"]["generation"];
        *generation=json!(if generation=="current" {"historical"}else{"current"});
        forged["planHash"]=json!(hash(&forged["payload"]));
        let mut check=input.clone();check["phase"]=json!("plan");check["plan"]=forged;
        let rejected:Value=serde_json::from_str(&call_json(EngineMethod::Validate,&check.to_string())).unwrap();
        assert_eq!(rejected["ok"],true);
        assert_eq!(rejected["result"]["valid"],false,"rehashing false implementation evidence must not authorize it");
    }
    let base: Value = serde_json::from_str(include_str!("../../../../fixtures/tbc-transfer.json")).unwrap();
    let mut binding = base["finalizeInput"]["binding"].clone();
    binding["payload"]["requestHash"] = input["requestHash"].clone();
    binding["payload"]["operationHash"] = planned["plan"]["planHash"].clone();
    binding["payload"]["expiresAt"] = planned["plan"]["payload"]["expiresAt"].clone();
    binding["bindingHash"] = json!(hash(&binding["payload"]));
    let mut approval = base["finalizeInput"]["approval"].clone();
    approval["bindingHash"] = binding["bindingHash"].clone(); approval["expiresAt"] = binding["payload"]["expiresAt"].clone();
    let mut params = input.clone();params["plan"] = planned["plan"].clone(); params["binding"] = binding; params["approval"] = approval;
    for phase in ["plan","pre-sign"] {
        let mut check = params.clone(); check["phase"] = json!(phase);
        if phase == "plan" { check.as_object_mut().unwrap().remove("binding"); check.as_object_mut().unwrap().remove("approval"); }
        let validation = call(EngineMethod::Validate, &check);
        assert_eq!(validation["valid"], true, "{phase}: {validation}");
    }
    params["signatures"] = signatures(&planned["plan"]["payload"]["signingTasks"]);
    for _ in 0..8 {
        let result = call(EngineMethod::Finalize, &params);
        if result.get("bundle").is_some() {
            for phase in ["finalized","pre-broadcast"] {
                let mut check = params.clone();check["phase"] = json!(phase);check["bundle"] = result["bundle"].clone();
                let validation = call(EngineMethod::Validate, &check);
                assert_eq!(validation["valid"], true, "{phase}: {validation}");
            }
            let mut wrong = params.clone();wrong["approval"]["bindingHash"] = json!("00".repeat(32));
            let rejected: Value = serde_json::from_str(&call_json(EngineMethod::Finalize, &wrong.to_string())).unwrap();
            assert_eq!(rejected["ok"], false);
            return result["bundle"]["transactions"].clone();
        }
        params["continuation"] = result["continuation"].clone(); params["signatures"] = signatures(&result["signingRequests"]);
    }
    panic!("fixture exceeded bounded signing rounds");
}
pub fn reject_unsupported_pool_operations(concrete: Value, current: bool) {
    let id = concrete["request"]["intent"]["poolContractId"].clone();
    let operations: &[&str] = if current { &["tbc20Lp.burn", "amm.mergeToken"] }
        else { &["tbc20Lp.transfer", "tbc20Lp.lock", "tbc20Lp.unlock"] };
    for kind in operations {
        let mut input = concrete.clone();
        input["request"]["intent"] = json!({"type":kind,"version":"1.0","poolContractId":id});
        if *kind == "tbc20Lp.transfer" {
            input["request"]["intent"]["to"] = input["request"]["from"].clone();
            input["request"]["intent"]["amount"] = json!("1");
        } else if *kind == "tbc20Lp.lock" {
            input["request"]["intent"]["amount"] = json!("1");
            input["request"]["intent"]["lockTime"] = json!("900000");
        }
        // The LP fixture deliberately has no mutable Pool state. Supply an
        // authenticated Pool Code target for this unsupported pool operation,
        // so missing material cannot masquerade as a capability rejection.
        if *kind == "amm.mergeToken" {
            let record = input["snapshot"]["payload"]["contracts"].as_array_mut().unwrap()
                .iter_mut().find(|r|r["contractId"]==id).unwrap();
            record["currentOutpoint"] = json!({"txid":id,"vout":0});
            input["snapshot"]["snapshotHash"] = json!(hash(&input["snapshot"]["payload"]));
        }
        let normalized: Value = serde_json::from_str(&call_json(EngineMethod::NormalizeRequest,
            &json!({"version":"1.0","request":input["request"]}).to_string())).unwrap();
        assert_eq!(normalized["ok"],true,"operation shape must be valid before template selection: {normalized}");
        input["requestHash"] = normalized["result"]["requestHash"].clone();
        let result: Value = serde_json::from_str(&call_json(EngineMethod::Plan,&input.to_string())).unwrap();
        assert_eq!(result["ok"],false);
        assert_eq!(result["error"]["code"],"UNSUPPORTED_INTENT","wrong failure for {kind}: {result}");
        assert_eq!(result["error"]["message"],"operation is not supported for the authenticated Pool template");
        assert!(result.get("result").is_none(),"unsupported operation must not expose a fallback plan");
    }
}
pub fn exercise_pool(mut concrete: Value) {
    use tbc_engine_core::protocols::pool_origin::{inspect_pool_origin, PoolProfile};
    let id = concrete["request"]["intent"]["poolContractId"].as_str().unwrap();
    let parent = concrete["snapshot"]["payload"]["parents"].as_array().unwrap().iter()
        .find(|p|p["txid"]==id).expect("Pool creation is mandatory material");
    let raw = parent["rawTransaction"].as_str().unwrap();
    let tx = tbc_sdk::Transaction::from_hex(raw).unwrap();
    let profile = inspect_pool_origin(&id.parse().unwrap(), &tx.serialize()).unwrap();
    let concrete_kind=concrete["request"]["intent"]["type"].as_str().unwrap();
    let current = concrete_kind.starts_with("tbc-amm-") || concrete_kind.starts_with("tbc20-lp-");
    assert_eq!(profile, if current {PoolProfile::Current}else{PoolProfile::Historical});
    assert!(inspect_pool_origin(&"00".repeat(32).parse().unwrap(), &tx.serialize()).is_err());
    if std::env::var_os("UNIFIED_BUSINESS_DUMP_WIRE").is_some() {
        println!("UNIFIED_POOL_ORIGIN_WIRE:{}", json!({"input":{"phase":"identifyPoolOrigin","pool":{"txid":id,"rawTransaction":raw}},
            "result":{"family":"amm","generation":if current{"current"}else{"historical"},"verification":"origin-template","assetIdentityVerified":false}}));
    }
    if concrete["policy"]["payload"]["amountLimits"].as_array().is_some_and(Vec::is_empty) {
        concrete["policy"]["payload"]["amountLimits"] = json!([{"scope":"native","maximum":"2100000000000000"}]);
        concrete["policy"]["policyHash"] = json!(hash(&concrete["policy"]["payload"]));
    }
    let before = call(EngineMethod::Plan, &concrete);
    let mut unified = concrete.clone();
    let i = unified["request"]["intent"].as_object_mut().unwrap();
    let kind = i["type"].as_str().unwrap().to_owned();
    let public = match kind.as_str() {
        "tbc20-lp-transfer" => "tbc20Lp.transfer",
        "tbc20-lp-lock" => "tbc20Lp.lock",
        "tbc20-lp-unlock" => "tbc20Lp.unlock",
        "tbc20-lp-merge" | "tbc.pool.ftlp.merge" => "tbc20Lp.merge",
        "tbc.pool.ftlp.burn" => "tbc20Lp.burn",
        "tbc.pool.ft.merge" => "amm.mergeToken",
        "tbc-amm-swap" => "amm.swap",
        "tbc-amm-add-liquidity" => "amm.addLiquidity",
        "tbc-amm-remove-liquidity" | "tbc.pool.liquidity.remove" => "amm.removeLiquidity",
        "tbc.pool.liquidity.add" => {
            let amount = i.remove("tbcAmount").unwrap();i.insert("amount".into(), amount);i.insert("budgetAsset".into(), json!("tbc"));
            if let Some(lock) = i.remove("lockUntilHeight") {i.insert("lockTime".into(), lock);}
            "amm.addLiquidity"
        },
        "tbc.pool.swap.exactTbcForToken" | "tbc.pool.swap.exactTokenForTbc" => {
            let buy = kind == "tbc.pool.swap.exactTbcForToken";
            let amount = i.remove(if buy {"tbcAmount"} else {"ftAmount"}).unwrap();
            let minimum = i.remove(if buy {"minimumFtAmount"} else {"minimumTbcAmount"}).unwrap();
            i.insert("amount".into(), amount);i.insert("minimumOutput".into(), minimum);
            i.insert("direction".into(), json!(if buy {"tbc-to-ft"} else {"ft-to-tbc"}));"amm.swap"
        },
        _ => panic!("unsupported Pool comparison"),
    };
    i.insert("type".into(), json!(public));
    let normalized = call(EngineMethod::NormalizeRequest, &json!({"version":"1.0","request":unified["request"]}));
    assert_eq!(normalized["request"], unified["request"]);
    unified["requestHash"] = normalized["requestHash"].clone();
    let after = call(EngineMethod::Plan, &unified);
    assert_eq!(after["plan"]["payload"]["requestHash"], unified["requestHash"]);
    assert_eq!(after["plan"]["payload"]["preview"]["contractExecution"],json!({
        "businessType":public,"implementation":kind,"generation":if current {"current"}else{"historical"}
    }),"formal approval must carry the actually selected implementation");
    assert_eq!(after["plan"]["payload"]["transactions"], before["plan"]["payload"]["transactions"]);
    assert_eq!(after["plan"]["payload"]["signingTasks"], before["plan"]["payload"]["signingTasks"]);
    assert_eq!(complete(&unified, &after), complete(&concrete, &before));
    let mut bad = unified.clone();bad["phase"] = json!("plan");bad["plan"] = before["plan"].clone();
    assert_eq!(call(EngineMethod::Validate, &bad)["valid"], false);
    // No classifier may trust a record label or choose a second builder after
    // the selected one rejects authenticated material.
    let id = unified["request"]["intent"]["poolContractId"].clone();
    let mut tampered = unified.clone();
    let record = tampered["snapshot"]["payload"]["contracts"].as_array_mut().unwrap().iter_mut().find(|r|r["contractId"]==id).unwrap();
    let previous = if public.starts_with("tbc20Lp.") {id.clone()} else {record["currentOutpoint"]["txid"].clone()};
    let row = tampered["snapshot"]["payload"]["parents"].as_array_mut().unwrap().iter_mut().find(|p|p["txid"]==previous).unwrap();
    let mut tx = tbc_sdk::Transaction::from_hex(row["rawTransaction"].as_str().unwrap()).unwrap();
    let mut code = tx.outputs[0].script_pubkey.as_bytes().to_vec();code[0]^=1;
    tx.outputs[0].script_pubkey = tbc_sdk::script::Script::from_bytes(code);
    let changed = json!(tx.txid().to_string());row["txid"]=changed.clone();row["rawTransaction"]=json!(tx.to_hex());
    tampered["snapshot"]["payload"]["contracts"].as_array_mut().unwrap().iter_mut().find(|r|r["contractId"]==id).unwrap()["currentOutpoint"]["txid"] = changed.clone();
    for u in tampered["snapshot"]["payload"]["utxos"].as_array_mut().unwrap() {
        if u["txid"] == previous {u["txid"]=changed.clone();if u["vout"]==0 {u["scriptPubKey"]=json!(hex(tx.outputs[0].script_pubkey.as_bytes()));}}
    }
    tampered["snapshot"]["snapshotHash"]=json!(hash(&tampered["snapshot"]["payload"]));
    let rejected:Value=serde_json::from_str(&call_json(EngineMethod::Plan,&tampered.to_string())).unwrap();
    assert_eq!(rejected["ok"],false);
    assert!(rejected["error"]["message"].as_str().unwrap().starts_with("unified"),"modified Code with unchanged suffix must fail exact recognition: {rejected}");
    for field in ["family", "protocolVersion"] {
        let mut bad = unified.clone();
        let record = bad["snapshot"]["payload"]["contracts"].as_array_mut().unwrap().iter_mut().find(|r|r["contractId"]==id).unwrap();
        record[field] = json!("fictional");
        bad["snapshot"]["snapshotHash"] = json!(hash(&bad["snapshot"]["payload"]));
        let result:Value = serde_json::from_str(&call_json(EngineMethod::Plan, &bad.to_string())).unwrap();assert_eq!(result["ok"], false);
    }
    if kind.starts_with("tbc.pool.") {
        let mut bad = unified.clone();bad["request"]["intent"]["poolStateHash"] = json!("00".repeat(32));
        bad["requestHash"] = json!(hash(&bad["request"]));
        let result:Value = serde_json::from_str(&call_json(EngineMethod::Plan, &bad.to_string())).unwrap();
        assert_eq!(result["ok"], false, "a new-only state commitment must not be silently discarded");
        if public == "amm.addLiquidity" {
            for (field,value) in [("budgetAsset",json!("ft")),("initialFtAmount",json!("1")),
                ("maximumTbcAmount",json!("1")),("maximumFtAmount",json!("1")),("lockTime",json!("500000000"))] {
                let mut bad=unified.clone();bad["request"]["intent"][field]=value;bad["requestHash"]=json!(hash(&bad["request"]));
                let result:Value=serde_json::from_str(&call_json(EngineMethod::Plan,&bad.to_string())).unwrap();assert_eq!(result["ok"],false,"unsupported historical option {field}");
            }
        }
    }
}
pub fn exercise(mut concrete: Value, unified_type: &str) {
    // Historical Engine-only fixtures allow empty limits internally. The public
    // integration policy requires a nonempty bound: exercise both routes with
    // the same valid native limit, without weakening the production schema.
    if concrete["policy"]["payload"]["amountLimits"].as_array().is_some_and(|limits| limits.is_empty()) {
        concrete["policy"]["payload"]["amountLimits"] = json!([{"scope":"native","maximum":"2100000000000000"}]);
        concrete["policy"]["policyHash"] = json!(hash(&concrete["policy"]["payload"]));
    }
    let before = call(EngineMethod::Plan, &concrete);
    if unified_type != "tbc721.transfer" {
    let asset_id = concrete["request"]["intent"]["contractId"].as_str().unwrap();
    let origin = concrete["snapshot"]["payload"]["parents"].as_array().unwrap().iter()
        .find(|p| p["txid"] == asset_id).expect("required immutable origin");
    let encoded = origin["rawTransaction"].as_str().unwrap();
    let raw: Vec<u8> = (0..encoded.len()).step_by(2).map(|i| u8::from_str_radix(&encoded[i..i+2],16).unwrap()).collect();
    use tbc_engine_core::protocols::fungible_origin::{inspect_fungible_origin, FungibleOriginProfile as Profile};
    let profile = inspect_fungible_origin(&asset_id.parse().unwrap(), &raw).unwrap();
    let expected = match concrete["request"]["intent"]["type"].as_str().unwrap() {
        "tbc20-standard-transfer" | "tbc20-standard-merge" => Profile::Tbc20,
        "tbc20-stablecoin-transfer" | "tbc20-stablecoin-merge" => Profile::Coin,
        "tbc.ft.transfer" | "tbc.ft.merge" => Profile::HistoricalFt,
        _ => Profile::HistoricalStablecoin,
    };
    assert_eq!(profile, expected, "origin selection must agree with authenticated holder builders");
    assert!(inspect_fungible_origin(&"00".repeat(32).parse().unwrap(), &raw).is_err());
    let mut changed = tbc_sdk::Transaction::from_bytes(&raw).unwrap();
    let mut bytes = changed.outputs[0].script_pubkey.as_bytes().to_vec(); bytes[0] ^= 1;
    changed.outputs[0].script_pubkey = tbc_sdk::script::Script::from_bytes(bytes);
    assert!(inspect_fungible_origin(&changed.txid(), &changed.serialize()).is_err(), "unknown Code cannot select another profile");
    if std::env::var_os("UNIFIED_BUSINESS_DUMP_WIRE").is_some() {
        let (family,generation) = match profile {
            Profile::Tbc20 => ("tbc20","current"), Profile::Coin => ("tbc20Stablecoin","current"),
            Profile::HistoricalFt => ("tbc20","historical"), Profile::HistoricalStablecoin => ("tbc20Stablecoin","historical"),
        };
        println!("UNIFIED_ORIGIN_WIRE:{}", json!({"input":{"phase":"identifyOrigin","contractId":asset_id,"rawTransaction":encoded},
            "result":{"family":family,"generation":generation,"verification":"origin-template","assetIdentityVerified":false}}));
    }
    }
    let mut unified = concrete.clone(); unified["request"]["intent"]["type"] = json!(unified_type);
    if let Some(attached) = unified["request"]["intent"].as_object_mut().unwrap().remove("attachedTbcAmount") {
        if attached != "0" { unified["request"]["intent"]["payment"] = json!({"to":unified["request"]["intent"]["to"],"amount":attached}); }
    }
    let normalized = call(EngineMethod::NormalizeRequest, &json!({"version":"1.0","request":unified["request"]}));
    assert_eq!(normalized["request"], unified["request"], "normalization cannot relabel a unified request");
    unified["requestHash"] = normalized["requestHash"].clone();
    let after = call(EngineMethod::Plan, &unified);
    assert_eq!(after["plan"]["payload"]["requestHash"], unified["requestHash"]);
    let implementation=concrete["request"]["intent"]["type"].as_str().unwrap();
    assert_eq!(after["plan"]["payload"]["preview"]["contractExecution"],json!({
        "businessType":unified_type,"implementation":implementation,
        "generation":if implementation.starts_with("tbc.") {"historical"}else{"current"}
    }));
    assert_ne!(after["plan"]["payload"]["requestHash"], before["plan"]["payload"]["requestHash"]);
    assert_eq!(after["plan"]["payload"]["transactions"], before["plan"]["payload"]["transactions"]);
    assert_eq!(after["plan"]["payload"]["signingTasks"], before["plan"]["payload"]["signingTasks"]);
    let mut rebound = unified.clone(); rebound["phase"] = json!("plan");rebound["plan"] = before["plan"].clone();
    assert_eq!(call(EngineMethod::Validate, &rebound)["valid"], false, "concrete plan cannot authorize the unified request");
    for mutation in ["duplicate", "label", "parent", "family"] {
        let mut bad = unified.clone();
        match mutation {
            "duplicate" => { let row = bad["snapshot"]["payload"]["contracts"][0].clone();
                bad["snapshot"]["payload"]["contracts"].as_array_mut().unwrap().push(row); },
            "label" => bad["snapshot"]["payload"]["contracts"][0]["protocolVersion"] = json!("fictional-version"),
            "parent" => bad["snapshot"]["payload"]["contracts"][0]["currentOutpoint"]["txid"] = json!("00".repeat(32)),
            "family" => bad["snapshot"]["payload"]["contracts"][0]["family"] = json!(if unified_type == "tbc721.transfer" {"ft"} else {"nft"}),
            _ => unreachable!(),
        }
        bad["snapshot"]["snapshotHash"] = json!(hash(&bad["snapshot"]["payload"]));
        let rejected: Value = serde_json::from_str(&call_json(EngineMethod::Plan, &bad.to_string())).unwrap();
        assert_eq!(rejected["ok"], false, "unified material {mutation} must fail, without alternate-builder fallback");
    }
    if unified_type == "tbc721.transfer" {
        use tbc_engine_core::protocols::nft_origin::{inspect_nft_origin,NftOriginProfile};
        let id=unified["request"]["intent"]["contractId"].as_str().unwrap();
        let origin=unified["snapshot"]["payload"]["parents"].as_array().unwrap().iter().find(|p|p["txid"]==id).unwrap();
        let raw=origin["rawTransaction"].as_str().unwrap();
        let tx=tbc_sdk::Transaction::from_hex(raw).unwrap();
        let expected=if concrete["request"]["intent"]["type"]=="tbc.nft.transfer" {NftOriginProfile::Historical} else {NftOriginProfile::Current};
        assert_eq!(inspect_nft_origin(&id.parse().unwrap(),&tx.serialize()).unwrap(),expected);
        assert!(inspect_nft_origin(&"00".repeat(32).parse().unwrap(),&tx.serialize()).is_err());
        let mut wrong_hold=tx.clone();wrong_hold.outputs[1].script_pubkey=tbc_sdk::script::Script::from_bytes(vec![0x51]);
        assert!(inspect_nft_origin(&wrong_hold.txid(),&wrong_hold.serialize()).is_err());
        let coin:Value=serde_json::from_str(include_str!("../../../../fixtures/coin-proof.json")).unwrap();
        let issuer=tbc_sdk::Transaction::from_hex(coin["vectors"][0]["ancestorsRaw"][0].as_str().unwrap()).unwrap();
        assert!(inspect_nft_origin(&issuer.txid(),&issuer.serialize()).is_err(),"Coin certificate is not an ordinary NFT");
        if std::env::var_os("UNIFIED_BUSINESS_DUMP_WIRE").is_some() {
            println!("UNIFIED_NFT_ORIGIN_WIRE:{}",json!({"input":{"phase":"identifyNftOrigin","contractId":id,"rawTransaction":raw},
                "result":{"family":"tbc721","generation":if expected==NftOriginProfile::Current {"current"} else {"historical"},"verification":"origin-template","assetIdentityVerified":false}}));
        }
        // Keep the apparent version suffix and recompute actual txid/snapshot
        // bindings. Only full-template recognition can reject this mutation.
        let mut bad = unified.clone();
        let previous = bad["snapshot"]["payload"]["contracts"][0]["currentOutpoint"]["txid"].as_str().unwrap().to_owned();
        let parents = bad["snapshot"]["payload"]["parents"].as_array_mut().unwrap();
        let row = parents.iter_mut().find(|p|p["txid"]==previous).unwrap();
        let mut tx = tbc_sdk::Transaction::from_hex(row["rawTransaction"].as_str().unwrap()).unwrap();
        let mut code = tx.outputs[0].script_pubkey.as_bytes().to_vec();code[0]^=1;
        tx.outputs[0].script_pubkey=tbc_sdk::script::Script::from_bytes(code);
        let changed_id=tx.txid().to_string();
        row["txid"]=json!(changed_id);row["rawTransaction"]=json!(tx.to_hex());
        bad["snapshot"]["payload"]["contracts"][0]["currentOutpoint"]["txid"]=json!(changed_id);
        for u in bad["snapshot"]["payload"]["utxos"].as_array_mut().unwrap() {
            if u["txid"]==previous {
                u["txid"]=json!(changed_id);
                if u["vout"]==0 {u["scriptPubKey"]=json!(hex(tx.outputs[0].script_pubkey.as_bytes()));}
            }
        }
        bad["snapshot"]["snapshotHash"]=json!(hash(&bad["snapshot"]["payload"]));
        let rejected:Value=serde_json::from_str(&call_json(EngineMethod::Plan,&bad.to_string())).unwrap();
        assert_eq!(rejected["ok"],false);
        assert!(rejected["error"]["message"].as_str().unwrap().starts_with("unified NFT template"));
        if concrete["request"]["intent"]["type"]=="tbc.nft.transfer" {
            let mut unsupported=unified.clone();
            unsupported["request"]["intent"]["payment"]=json!({"to":unsupported["request"]["intent"]["to"],"amount":"24"});
            unsupported["requestHash"]=json!(hash(&unsupported["request"]));
            let rejected:Value=serde_json::from_str(&call_json(EngineMethod::Plan,&unsupported.to_string())).unwrap();
            assert_eq!(rejected["ok"],false);
            assert_eq!(rejected["error"]["code"],"INVALID_INPUT");
        }
    }
    assert_eq!(complete(&unified, &after), complete(&concrete, &before), "unified routing must preserve signed bytes/fees");
}
