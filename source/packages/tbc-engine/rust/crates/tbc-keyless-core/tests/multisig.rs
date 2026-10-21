//! Fixed public test keys only. Offline transactions never submitted.
use serde_json::{Value, json};
use tbc_sdk::{
    Ft, MultiSig, MultiSigDestination, MultiSigUnsignedTx, MultiSigUtxo, OutPoint, PrivateKey,
    Transaction, TxOut, Utxo, script::Script,
};

fn call(op: &str, v: &Value) -> Value {
    serde_json::from_str(&tbc_keyless_core::call(op, &v.to_string()).unwrap()).unwrap()
}
fn bad(op: &str, v: &Value) {
    assert!(
        tbc_keyless_core::call(op, &v.to_string()).is_err(),
        "{op} should fail"
    );
}
fn keys() -> Vec<PrivateKey> {
    let mut k = (1..=3)
        .map(|n| PrivateKey::from_slice(&[n; 32]).unwrap())
        .collect::<Vec<_>>();
    k.sort_by_key(|k| k.public_key().to_bytes());
    k
}
fn pubkey(k: &PrivateKey) -> String {
    hex::encode(k.public_key().to_bytes())
}
fn group(ks: &[PrivateKey], m: u8) -> Value {
    json!({"publicKeys":ks.iter().map(pubkey).collect::<Vec<_>>(),"requiredSignatures":m})
}
fn address(ks: &[PrivateKey]) -> String {
    MultiSig::address(&ks.iter().map(|k| k.public_key()).collect::<Vec<_>>(), 2).unwrap()
}
fn input(tx: &Transaction, vout: usize) -> Value {
    let o = &tx.outputs[vout];
    json!({"txid":tx.txid().to_string(),"vout":vout,"satoshis":o.satoshis.to_string(),"scriptPubKey":hex::encode(o.script_pubkey.as_bytes()),"parentTxraw":tx.to_hex()})
}
fn funding(script: Script, n: u64) -> Transaction {
    let mut tx = Transaction::new();
    tx.outputs.push(TxOut {
        satoshis: n,
        script_pubkey: script,
    });
    tx
}
fn request(g: Value, action: Value) -> Value {
    json!({"chainId":"tbc:testnet","group":g,"action":action,"maxFee":"50000"})
}
fn sign(p: &Value, ks: &[PrivateKey]) -> Vec<Value> {
    let mut sigs = Vec::new();
    for task in p["tasks"].as_array().unwrap() {
        for k in ks {
            let public = pubkey(k);
            if !task["publicKeys"]
                .as_array()
                .unwrap()
                .contains(&json!(public))
            {
                continue;
            }
            let d: [u8; 32] = hex::decode(task["digest"].as_str().unwrap())
                .unwrap()
                .try_into()
                .unwrap();
            let mut s = k.sign_ecdsa_digest(&d);
            s.push(0x41);
            sigs.push(json!({"proposalId":p["proposalId"],"inputIndex":task["inputIndex"],"publicKey":public,"signature":hex::encode(s)}));
        }
    }
    sigs
}
fn finish(p: &Value, ks: &[PrivateKey]) -> (Value, Transaction) {
    let r = call(
        "finalizeMultisig",
        &json!({"proposal":p,"signatures":sign(p,ks)}),
    );
    let tx = Transaction::from_hex(r["txraw"].as_str().unwrap()).unwrap();
    (r, tx)
}
fn record(cases: &mut Vec<Value>, name: &str, p: &Value, r: &Value, inputs: Vec<Value>) {
    let checked = call("reviewMultisig", p);
    assert_eq!(checked["proposal"], *p, "review must not alter transaction or digest");
    let review = &checked["review"];
    assert_eq!(review["proposalId"], p["proposalId"]);
    assert_eq!(review["feeAtomic"], p["fee"]);
    let tx = Transaction::from_hex(p["unsignedTxraw"].as_str().unwrap()).unwrap();
    let mut covered = Vec::new();
    let mut native_total = 0u64;
    for row in review["outputs"].as_array().unwrap() {
        let vouts = row["vouts"].as_array().unwrap();
        covered.extend(vouts.iter().map(|v| v.as_u64().unwrap() as usize));
        let first = vouts[0].as_u64().unwrap() as usize;
        assert_eq!(row["nativeValueAtomic"], tx.outputs[first].satoshis.to_string());
        native_total += row["nativeValueAtomic"].as_str().unwrap().parse::<u64>().unwrap();
        if row["kind"] != "metadata" { assert!(!row["recipient"].as_str().unwrap().is_empty()); }
        if row["kind"] == "token" {
            assert!(!row["assetIdentity"].as_str().unwrap().is_empty());
            assert!(row["assetFamily"] == "FT" || row["assetFamily"] == "STABLE_COIN");
            assert_eq!(vouts.len(), 2);
        }
    }
    assert_eq!(covered, (0..tx.outputs.len()).collect::<Vec<_>>(), "every output exactly once");
    assert_eq!(native_total, tx.outputs.iter().map(|o| o.satoshis).sum::<u64>());
    cases.push(json!({"name":name,"proposal":p,"result":r,"inputs":inputs}));
}

#[test]
fn review_rejects_replaced_payment_and_digest() {
    let ks = keys();
    let f = funding(MultiSig::lock_script(&address(&ks)).unwrap(), 1000000);
    let p = call("prepareMultisig", &request(group(&ks,2),
        json!({"type":"transferTbc","destination":ks[2].address().to_string(),"amount":"500000","inputs":[input(&f,0)]})));
    let original_signatures = sign(&p, &ks[..2]);
    for field in ["amount", "destination"] {
        let mut bad_p = p.clone();
        bad_p["request"]["action"][field] = if field == "amount" {json!("400000")} else {json!(ks[1].address().to_string())};
        bad("reviewMultisig", &bad_p);
        // Even a valid replacement with its own new ID cannot use old signatures.
        let replacement = call("prepareMultisig", &bad_p["request"]);
        bad("finalizeMultisig", &json!({"proposal":replacement,"signatures":original_signatures}));
    }
    let mut bad_p = p.clone(); bad_p["tasks"][0]["digest"] = json!("00".repeat(32)); bad("reviewMultisig", &bad_p);
    let mut bad_p = p.clone(); bad_p["fee"] = json!("0"); bad("reviewMultisig", &bad_p);
    let mut bad_p = p.clone(); bad_p["request"]["chainId"] = json!("tbc:mainnet"); bad("reviewMultisig", &bad_p);
}

#[test]
fn tbc_create_deposit_spend_merge_and_sdk_interop() {
    let ks = keys();
    let g = group(&ks, 2);
    let d = call("describeMultisig", &g);
    assert_eq!(d["address"], address(&ks));
    let coin = funding(ks[0].address().script_pubkey(), 1000000);
    let mut cases = Vec::new();
    for typ in ["create", "depositTbc"] {
        let p = call(
            "prepareMultisig",
            &request(
                g.clone(),
                json!({"type":typ,"publicKey":pubkey(&ks[0]),"amount":"500000","inputs":[input(&coin,0)]}),
            ),
        );
        let (r, tx) = finish(&p, &ks[..1]);
        assert_eq!(
            tx.outputs[0].script_pubkey,
            MultiSig::lock_script(&address(&ks)).unwrap()
        );
        if typ == "create" {
            assert_eq!(tx.outputs.len(), 6);
            assert!(hex::encode(tx.outputs[4].script_pubkey.as_bytes()).ends_with("054d54617065"));
        }
        record(&mut cases, typ, &p, &r, vec![input(&coin, 0)]);
    }
    let f = funding(MultiSig::lock_script(&address(&ks)).unwrap(), 1000000);
    for dest in [ks[2].address().to_string(), address(&ks)] {
        let p = call(
            "prepareMultisig",
            &request(
                g.clone(),
                json!({"type":"transferTbc","destination":dest,"amount":"500000","inputs":[input(&f,0)]}),
            ),
        );
        let (r, tx) = finish(&p, &ks[..2]);
        let sdk_plan = MultiSig::build_tbc_transaction(
            &address(&ks),
            if MultiSig::validate_address(&dest) {
                MultiSigDestination::MultiSig(dest)
            } else {
                MultiSigDestination::P2pkh(ks[2].address())
            },
            500000,
            vec![MultiSigUtxo {
                outpoint: OutPoint {
                    txid: f.txid(),
                    vout: 0,
                },
                satoshis: 1000000,
                locking_script: f.outputs[0].script_pubkey.clone(),
            }],
        )
        .unwrap();
        assert_eq!(sdk_plan.transaction.to_hex(), p["unsignedTxraw"]);
        let sigs = ks[..2]
            .iter()
            .map(|k| {
                MultiSig::sign_tbc_transaction(&address(&ks), &sdk_plan, k).unwrap()[0].clone()
            })
            .collect::<Vec<_>>();
        assert_eq!(
            MultiSig::finish_tbc_transaction(
                &sdk_plan,
                &vec![sigs],
                &ks.iter().map(|k| k.public_key()).collect::<Vec<_>>()
            )
            .unwrap()
            .to_hex(),
            tx.to_hex()
        );
        record(&mut cases, "transferTbc", &p, &r, vec![input(&f, 0)]);
    }
    let f2 = funding(f.outputs[0].script_pubkey.clone(), 200000);
    let p = call(
        "prepareMultisig",
        &request(
            g.clone(),
            json!({"type":"mergeTbc","inputs":[input(&f,0),input(&f2,0)]}),
        ),
    );
    let (r, tx) = finish(&p, &ks[..2]);
    assert_eq!(tx.outputs.len(), 1);
    assert_eq!(tx.outputs[0].satoshis, 1199000);
    record(
        &mut cases,
        "mergeTbc",
        &p,
        &r,
        vec![input(&f, 0), input(&f2, 0)],
    );
    if let Ok(out) = std::env::var("TBC_MULTISIG_FIXTURE_DIR") {
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(
            format!("{out}/native.json"),
            serde_json::to_vec_pretty(&cases).unwrap(),
        )
        .unwrap();
    }
}

#[test]
fn proposal_signatures_are_bound_and_threshold_checked() {
    let ks = keys();
    let g = group(&ks, 2);
    let f = funding(MultiSig::lock_script(&address(&ks)).unwrap(), 100000);
    let req = request(
        g,
        json!({"type":"transferTbc","destination":ks[0].address().to_string(),"amount":"5000","inputs":[input(&f,0)]}),
    );
    let p = call("prepareMultisig", &req);
    let sigs = sign(&p, &ks[..2]);
    assert_eq!(
        call(
            "verifyMultisigSignatures",
            &json!({"proposal":p,"signatures":sigs[..1]})
        )["complete"],
        false
    );
    bad(
        "finalizeMultisig",
        &json!({"proposal":p,"signatures":sigs[..1]}),
    );
    for field in ["proposalId", "unsignedTxraw", "fee", "address"] {
        let mut q = p.clone();
        q[field] = json!("00");
        bad("inspectMultisig", &q);
    }
    let mut q = p.clone();
    q["request"]["chainId"] = json!("tbc:mainnet");
    bad("inspectMultisig", &q);
    let mut q = p.clone();
    q["tasks"][0]["digest"] = json!("00".repeat(32));
    bad("inspectMultisig", &q);
    let mut duplicates = sigs.clone();
    duplicates.push(sigs[0].clone());
    bad(
        "finalizeMultisig",
        &json!({"proposal":p,"signatures":duplicates}),
    );
    for field in ["proposalId", "publicKey", "signature"] {
        let mut s = sigs.clone();
        s[0][field] = json!("00");
        bad("finalizeMultisig", &json!({"proposal":p,"signatures":s}));
    }
    let mut q = req.clone();
    q["privateKey"] = json!("not accepted");
    bad("prepareMultisig", &q);
    let mut q = req.clone();
    q["action"]["inputs"][0]["satoshis"] = json!("100001");
    bad("prepareMultisig", &q);
    let mut q = req.clone();
    q["maxFee"] = json!("999");
    bad("prepareMultisig", &q);
    let mut q = req.clone();
    q["action"]["inputs"]
        .as_array_mut()
        .unwrap()
        .push(input(&f, 0));
    bad("prepareMultisig", &q);
    for count in [1, 3, 6] {
        let ks = (1..=10)
            .map(|n| PrivateKey::from_slice(&[n; 32]).unwrap())
            .collect::<Vec<_>>();
        let d = call("describeMultisig", &group(&ks, count));
        assert!(MultiSig::validate_address(d["address"].as_str().unwrap()));
    }
    for m in [0, 7] {
        bad("describeMultisig", &group(&ks, m));
    }
    bad("describeMultisig", &group(&ks[..2], 2));
}

fn token_item(tx: &Transaction, index: usize, balance: u64, ancestors: &[&Transaction]) -> Value {
    json!({"input":input(tx,index),"balance":balance.to_string(),"ancestors":ancestors.iter().map(|t|t.to_hex()).collect::<Vec<_>>()})
}
#[test]
fn ft_deposit_transfer_and_merge_release_witnesses_without_private_keys() {
    use tbc_sdk::contracts::ft::scripts::FtMintVersion;
    let ks = keys();
    let g = group(&ks, 2);
    let a = address(&ks);
    let mut cases = Vec::new();
    // Real released templates, not NOP-only synthetic FT scripts. Historical
    // mint is fixture construction only, never exposed by the new API.
    for (label, version) in [("v3", FtMintVersion::V3), ("v4", FtMintVersion::V4)] {
        let fund = funding(ks[0].address().script_pubkey(), 1000000);
        let mut ft = Ft::new("Offline Multi".into(), "MS".into(), 1000, 0).unwrap();
        let minted = ft
            .mint_ft_with_version(
                ks[0].clone(),
                ks[0].address(),
                Utxo {
                    outpoint: OutPoint {
                        txid: fund.txid(),
                        vout: 0,
                    },
                    satoshis: 1000000,
                    script_pubkey: fund.outputs[0].script_pubkey.clone(),
                    private_key: ks[0].clone(),
                },
                version,
            )
            .unwrap();
        let fee = funding(ks[0].address().script_pubkey(), 300000);
        let token = json!({"code":ft.code_script,"tape":ft.tape_script,"inputs":[token_item(&minted.mint,0,1000,&[&minted.source])]});
        let req = request(
            g.clone(),
            json!({"type":"depositFt","publicKey":pubkey(&ks[0]),"amount":"400","funding":input(&fee,0),"token":token,"tbcAmount":"200000"}),
        );
        let p = call("prepareMultisig", &req);
        let (r, deposit) = finish(&p, &ks[..1]);
        // The explicit MultiSig profile must not relax ordinary FT validation.
        assert!(
            tbc_sdk::validator::inspect_multisig_token_pair(
                &deposit.outputs[1],
                Some(&deposit.outputs[2])
            )
            .unwrap()
            .is_some()
        );
        assert!(
            tbc_sdk::validator::inspect_published_token_pair(
                &deposit.outputs[1],
                Some(&deposit.outputs[2])
            )
            .is_err()
        );
        for value in [499, 501, 1999, 2001] {
            let mut code = deposit.outputs[1].clone();
            code.satoshis = value;
            assert!(
                tbc_sdk::validator::inspect_multisig_token_pair(&code, Some(&deposit.outputs[2]))
                    .is_err()
            );
        }
        record(
            &mut cases,
            &format!("depositFt-{label}"),
            &p,
            &r,
            vec![input(&minted.mint, 0), input(&fee, 0)],
        );
        let mut wrong = req.clone();
        wrong["action"]["token"]["inputs"][0]["balance"] = json!("1001");
        bad("prepareMultisig", &wrong);
        // Group funding is output 0; transferred FT lives at Code/Tape 1/2.
        let token = json!({"code":ft.code_script,"tape":ft.tape_script,"inputs":[token_item(&deposit,1,400,&[&minted.mint])]});
        let p = call(
            "prepareMultisig",
            &request(
                g.clone(),
                json!({"type":"transferFt","publicKey":pubkey(&ks[0]),"destination":ks[2].address().to_string(),"amount":"150","funding":input(&deposit,0),"token":token}),
            ),
        );
        let (r, spend) = finish(&p, &ks[..2]);
        record(
            &mut cases,
            &format!("transferFt-{label}"),
            &p,
            &r,
            vec![input(&deposit, 0), input(&deposit, 1)],
        );
        // Two distinct FT UTXOs under the same group; merge preserves all units.
        let mut p2 = req.clone();
        p2["action"]["amount"] = json!("200");
        p2["action"]["tbcAmount"] = json!("10000");
        p2["action"]["funding"] = input(&deposit, 5);
        p2["action"]["token"]["inputs"] = json!([token_item(&deposit, 3, 600, &[&minted.mint])]);
        let p2 = call("prepareMultisig", &p2);
        let (_, deposit2) = finish(&p2, &ks[..1]);
        let token = json!({"code":ft.code_script,"tape":ft.tape_script,"inputs":[token_item(&spend,3,250,&[&deposit]),token_item(&deposit2,1,200,&[&deposit])]});
        let p = call(
            "prepareMultisig",
            &request(
                g.clone(),
                json!({"type":"mergeFt","publicKey":pubkey(&ks[0]),"funding":input(&spend,0),"token":token}),
            ),
        );
        let (r, merged) = finish(&p, &ks[..2]);
        assert_eq!(merged.outputs.len(), 3);
        assert_eq!(
            tbc_sdk::contracts::ft::amount::balance_from_tape(&merged.outputs[2].script_pubkey)
                .unwrap(),
            450
        );
        record(
            &mut cases,
            &format!("mergeFt-{label}"),
            &p,
            &r,
            vec![input(&spend, 0), input(&spend, 3), input(&deposit2, 1)],
        );
        let unsigned = MultiSigUnsignedTx::from_ft_parts(
            {
                let mut tx = spend.clone();
                tx.inputs[0].script_sig = Script::empty();
                tx
            },
            vec![deposit.clone(), deposit.clone()],
            a.clone(),
        )
        .unwrap();
        let sigs = ks[..2]
            .iter()
            .map(|k| MultiSig::sign_ft_transaction(&a, &unsigned, k).unwrap()[0].clone())
            .collect::<Vec<_>>();
        assert_eq!(
            MultiSig::finish_ft_transaction(
                &unsigned,
                &vec![sigs],
                &ks.iter().map(|k| k.public_key()).collect::<Vec<_>>()
            )
            .unwrap()
            .to_hex(),
            spend.to_hex()
        );
    }
    if let Ok(out) = std::env::var("TBC_MULTISIG_FIXTURE_DIR") {
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(
            format!("{out}/token.json"),
            serde_json::to_vec_pretty(&cases).unwrap(),
        )
        .unwrap();
    }
}

#[test]
fn legacy_coin_multisig_uses_holder_path_not_administrator_and_preserves_locktime() {
    use tbc_sdk::StableCoin;
    let ks = keys();
    let g = group(&ks, 2);
    let fund = funding(ks[0].address().script_pubkey(), 1000000);
    let mut coin = StableCoin::new("Public Coin".into(), "PC".into(), 1000, 0).unwrap();
    let plan = coin
        .create_coin(
            ks[1].x_only_public_key(),
            ks[0].clone(),
            ks[0].address(),
            Utxo {
                outpoint: OutPoint {
                    txid: fund.txid(),
                    vout: 0,
                },
                satoshis: 1000000,
                script_pubkey: fund.outputs[0].script_pubkey.clone(),
                private_key: ks[0].clone(),
            },
            fund.clone(),
            None,
        )
        .unwrap();
    let minted = plan.finalize_with_admin_key(&ks[1]).unwrap();
    let fee = funding(ks[0].address().script_pubkey(), 300000);
    let token = json!({"code":coin.code_script,"tape":coin.tape_script,"inputs":[token_item(&minted.mint,3,1000,&[&minted.coin_nft])]});
    let p = call(
        "prepareMultisig",
        &request(
            g.clone(),
            json!({"type":"depositFt","publicKey":pubkey(&ks[0]),"amount":"400","funding":input(&fee,0),"token":token,"tbcAmount":"200000"}),
        ),
    );
    let (r, deposit) = finish(&p, &ks[..1]);
    let mut cases = Vec::new();
    record(
        &mut cases,
        "coin-deposit",
        &p,
        &r,
        vec![input(&minted.mint, 3), input(&fee, 0)],
    );
    let token = json!({"code":coin.code_script,"tape":coin.tape_script,"inputs":[token_item(&deposit,1,400,&[&minted.mint])]});
    let p = call(
        "prepareMultisig",
        &request(
            g,
            json!({"type":"transferFt","publicKey":pubkey(&ks[0]),"destination":ks[2].address().to_string(),"amount":"150","funding":input(&deposit,0),"token":token}),
        ),
    );
    let (r, spend) = finish(&p, &ks[..2]);
    assert_eq!(spend.inputs[1].sequence, u32::MAX - 1);
    record(
        &mut cases,
        "coin-transfer",
        &p,
        &r,
        vec![input(&deposit, 0), input(&deposit, 1)],
    );
    if let Ok(out) = std::env::var("TBC_MULTISIG_FIXTURE_DIR") {
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(
            format!("{out}/coin.json"),
            serde_json::to_vec_pretty(&cases).unwrap(),
        )
        .unwrap();
    }
}
