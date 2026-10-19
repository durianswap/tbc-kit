use tbc_engine_core::protocols::{historical_policy::*, historical_pool::*};
use tbc_sdk::{Address, OutPoint, Transaction, TxIn, TxOut, Txid, hash, script::Script,
    contracts::{ft::scripts as ft, nft::{NftData, CollectionData, scripts as nft},
        stable_coin::{CoinNftData, scripts as coin}, pool_nft_v2::{self as pool,
        PoolState, PoolAmounts, PoolCodeParams, FtScriptVersion, FtlpCodeParams, FtlpTapeParams, FtlpTapeLayout}}};

fn owner() -> Address { Address::from_hash160([1; 20]) }
fn native() -> TxOut { TxOut {satoshis: 1_000_000, script_pubkey: owner().script_pubkey()} }
fn parent(outputs: Vec<TxOut>) -> Transaction { let mut tx = Transaction::new(); tx.outputs = outputs; tx }
fn point(tx: &Transaction, vout: u32) -> OutPoint { OutPoint {txid: tx.txid(), vout} }
fn assess(
    before: &Transaction, spent: &[u32], outputs: Vec<TxOut>,
    inputs: &[(OutPoint, HistoricalTemplate)], hints: &[(u32, HistoricalTemplate)],
) -> Result<HistoricalIssuanceAssessment, String> {
    let mut tx = Transaction::new();
    tx.inputs = spent.iter().map(|vout| TxIn::new(point(before, *vout))).collect(); tx.outputs = outputs;
    let resolved: Vec<_> = before.outputs.iter().enumerate().map(|(vout, output)| ResolvedHistoricalOutput {
        outpoint: point(before, vout as u32), output,
    }).collect();
    assess_historical_issuance(&tx, &resolved, HistoricalPolicyTemplates {inputs, outputs: hints})
}
fn permitted(result: Result<HistoricalIssuanceAssessment, String>) -> bool {
    result.and_then(|r| r.require_no_historical_issuance()).is_ok()
}
fn ft_pair(amount: u64) -> Vec<TxOut> {
    let mut raw = [0; 48]; raw[..8].copy_from_slice(&amount.to_le_bytes());
    let tape = ft::mint_tape_script(&raw, 6, "Old", "OLD");
    let code = ft::mint_code_script(&Txid::from_le_bytes([4; 32]).to_string(), 0, &owner(), tape.as_bytes().len()).unwrap();
    vec![TxOut {satoshis: 500, script_pubkey: code}, TxOut {satoshis: 0, script_pubkey: tape}]
}
fn nft_group(token: u32) -> Vec<TxOut> {
    vec![TxOut {satoshis: 200, script_pubkey: nft::code_script(&Txid::from_le_bytes([5; 32]).to_string(), token).unwrap()},
        TxOut {satoshis: 100, script_pubkey: nft::hold_script(&owner())},
        TxOut {satoshis: 0, script_pubkey: nft::tape_script(&NftData {nft_name:"Old".into(), symbol:"OLD".into(), description:"".into(), attributes:"[]".into(), file:None}).unwrap()}]
}
fn certificate(supply: &str) -> Vec<TxOut> {
    let data = CoinNftData {nft_name:"Old Coin".into(), nft_symbol:"OC".into(), description:"".into(), coin_decimal:6, coin_total_supply:supply.into()};
    vec![TxOut {satoshis:200, script_pubkey:coin::coin_nft_code_script(&Txid::from_le_bytes([6;32]).to_string(),0).unwrap()},
        TxOut {satoshis:100, script_pubkey:coin::coin_nft_hold_script_from_hash(&owner().hash160(),&data.nft_name)},
        TxOut {satoshis:0, script_pubkey:coin::coin_nft_tape_script(&data).unwrap()}]
}

#[test]
fn ordinary_native_data_and_mint_source_markers_are_not_asset_issuance() {
    let before = parent(vec![native()]);
    let source = TxOut {satoshis:9900, script_pubkey:ft::mint_source_script(&owner())};
    let data = TxOut {satoshis:0, script_pubkey:Script::op_return(&[b"for ft mint".to_vec()])};
    assert!(permitted(assess(&before, &[0], vec![source, data, native()], &[], &[])));
}

#[test]
fn old_ft_transfer_merge_pass_but_unused_material_cannot_hide_creation() {
    let mut outputs = ft_pair(1000); outputs.extend(ft_pair(1000)); outputs.push(native());
    let before = parent(outputs);
    assert!(permitted(assess(&before, &[0,2,4], ft_pair(2000), &[], &[])));
    let mut split = ft_pair(400); split.extend(ft_pair(600));
    assert!(permitted(assess(&before, &[0,4], split, &[], &[])));
    // Both old FT outputs are present in resolved material but neither is spent.
    let issuance = assess(&before, &[4], ft_pair(1000), &[], &[]).unwrap();
    assert_eq!(issuance.violations[0].family, "fungible");
    assert!(issuance.require_no_historical_issuance().is_err());
    assert!(!permitted(assess(&before, &[0,4], ft_pair(1001), &[], &[])));
    assert!(!permitted(assess(&before, &[0,0], ft_pair(2000), &[], &[])));
}

#[test]
fn nft_transfer_passes_creation_duplicate_and_metadata_change_do_not() {
    let mut previous = nft_group(1); previous.push(native()); let before = parent(previous);
    let mut moved = nft_group(1); moved[1].script_pubkey = nft::hold_script(&Address::from_hash160([9;20]));
    assert!(permitted(assess(&before, &[0,1,3], moved, &[], &[])));
    assert!(!permitted(assess(&before, &[0,1,3], nft_group(2), &[], &[])));
    let mut duplicate = nft_group(1); duplicate.extend(nft_group(1));
    assert!(!permitted(assess(&before, &[0,1,3], duplicate, &[], &[])));
    let mut edited = nft_group(1);
    edited[2].script_pubkey = nft::tape_script(&NftData {nft_name:"Edited".into(), symbol:"OLD".into(), description:"".into(), attributes:"[]".into(), file:None}).unwrap();
    assert!(!permitted(assess(&before, &[0,1,3], edited, &[], &[])));
}

#[test]
fn current_nft_mint_and_transfer_are_not_historical_issuance() {
    use tbc_engine_core::protocols::tbc721::{CodeDescriptor, instantiate_code};
    let mut current = nft_group(1);
    current[0].script_pubkey = Script::from_bytes(instantiate_code(&CodeDescriptor {
        original_outpoint: OutPoint {txid:Txid::from_le_bytes([5;32]),vout:1},
    }));
    let funding = parent(vec![native()]);
    // This classifier is not mint authorization. The planner/VM separately
    // authenticate the collection slot; here the full new Code is not old Code.
    assert!(permitted(assess(&funding, &[0], current.clone(), &[], &[])));
    let mut previous = current.clone(); previous.push(native());
    let previous = parent(previous);
    let mut moved = current.clone();
    moved[1].script_pubkey = nft::hold_script(&Address::from_hash160([9;20]));
    assert!(permitted(assess(&previous, &[0,1,3], moved, &[], &[])));
    // A supported new group must not hide old issuance later in the same tx.
    let mut mixed = current.clone(); mixed.extend(nft_group(2));
    assert!(!permitted(assess(&funding, &[0], mixed, &[], &[])));
    for missing in [1,2] {
        assert!(!permitted(assess(&funding, &[0], current[..missing].to_vec(), &[], &[])));
    }
    for index in 0..3 {
        let mut wrong = current.clone(); wrong[index].satoshis += 1;
        assert!(!permitted(assess(&funding, &[0], wrong, &[], &[])));
    }
    let mut wrong_hold = current.clone(); wrong_hold[1].script_pubkey = owner().script_pubkey();
    assert!(!permitted(assess(&funding, &[0], wrong_hold, &[], &[])));
    let mut wrong_tape = current.clone();
    wrong_tape[2].script_pubkey = Script::op_return(&[b"not NFT metadata".to_vec()]);
    assert!(!permitted(assess(&funding, &[0], wrong_tape, &[], &[])));
    let mut mutated = current;
    let mut bytes = mutated[0].script_pubkey.as_bytes().to_vec(); bytes[0] ^= 1;
    mutated[0].script_pubkey = Script::from_bytes(bytes);
    assert!(!permitted(assess(&funding, &[0], mutated, &[], &[])));
}

#[test]
fn shared_collection_is_allowed_but_old_coin_certificate_issuance_is_detected() {
    let before = parent(vec![native()]);
    let collection = vec![TxOut {satoshis:0, script_pubkey:nft::tape_script(&CollectionData {
        collection_name:"Old".into(), description:"".into(), supply:1, file:"".into()}).unwrap()},
        TxOut {satoshis:100, script_pubkey:nft::mint_script(&owner())}];
    assert!(permitted(assess(&before, &[0], collection, &[], &[])));
    assert_eq!(assess(&before, &[0], certificate("0"), &[], &[]).unwrap().violations[0].family, "stablecoin-certificate");
    let previous = parent(certificate("1000"));
    assert!(permitted(assess(&previous, &[0,1], certificate("1000"), &[], &[])));
    assert!(!permitted(assess(&previous, &[0,1], certificate("1001"), &[], &[])));
}

#[test]
fn current_coin_certificate_is_distinct_from_old_certificate_and_regular_nft() {
    use tbc_engine_core::protocols::tbc721::{CodeDescriptor, instantiate_code};
    let current = |supply: &str| {
        let mut outputs = certificate(supply);
        outputs[0].script_pubkey = Script::from_bytes(instantiate_code(&CodeDescriptor {
            original_outpoint:OutPoint {txid:Txid::from_le_bytes([6;32]),vout:0},
        }));
        outputs
    };
    let before = parent(vec![native()]);
    assert!(permitted(assess(&before, &[0], current("0"), &[], &[])));
    // Current cumulative supply is not bounded by the old certificate's u128
    // policy. Keep its exact decimal representation without a numeric cast.
    assert!(permitted(assess(&before, &[0], current("1000000000000000000000000000000000000000"), &[], &[])));
    let previous = parent(current("1000"));
    assert!(permitted(assess(&previous, &[0,1], current("2000"), &[], &[])));
    let mut mixed = current("0"); mixed.extend(certificate("0"));
    assert!(!permitted(assess(&before, &[0], mixed, &[], &[])));
    for supply in ["", "-1", "1.5", "abc"] {
        assert!(!permitted(assess(&before, &[0], current(supply), &[], &[])));
    }
    for index in 0..3 {
        let mut bad = current("0"); bad[index].satoshis += 1;
        assert!(!permitted(assess(&before, &[0], bad, &[], &[])));
    }
    let mut regular_hold = current("0"); regular_hold[1].script_pubkey=nft::hold_script(&owner());
    assert!(!permitted(assess(&before, &[0], regular_hold, &[], &[])));
    let mut wrong_label = current("0");
    wrong_label[1].script_pubkey=coin::coin_nft_hold_script_from_hash(&owner().hash160(),"Another Coin");
    assert!(!permitted(assess(&before, &[0], wrong_label, &[], &[])));
    let mut wrong_precision = current("0");
    wrong_precision[2].script_pubkey = coin::coin_nft_tape_script(&CoinNftData {
        nft_name:"Old Coin".into(),nft_symbol:"OC".into(),description:"".into(),coin_decimal:19,coin_total_supply:"0".into(),
    }).unwrap();
    assert!(!permitted(assess(&before, &[0], wrong_precision, &[], &[])));
}

#[test]
fn current_amm_and_lp_fixed_vectors_are_not_historical_issuance() {
    use tbc_engine_core::protocols::{amm_code,amm_lp};
    let before=parent(vec![native()]);
    let mut pools=0; let mut lps=0;
    for text in [include_str!("../../../fixtures/amm-pool-proof.json"),
        include_str!("../../../fixtures/amm-lp-proof.json")] {
        let fixture:serde_json::Value=serde_json::from_str(text).unwrap();
        for raw in fixture["raws"].as_object().unwrap().values() {
            let tx=Transaction::from_hex(raw.as_str().unwrap()).unwrap();
            assert!(permitted(assess(&before,&[0],tx.outputs.clone(),&[],&[])),"{}",tx.txid());
            for (index,code) in tx.outputs.iter().enumerate() {
                let pool=amm_code::parse_code(code.script_pubkey.as_bytes()).is_ok();
                let lp=amm_lp::parse_code(code.script_pubkey.as_bytes()).is_ok();
                if !pool && !lp {continue;}
                if pool {pools+=1;} else {lps+=1;}
                let pair=vec![code.clone(),tx.outputs[index+1].clone()];
                let mut wrong_value=pair.clone(); wrong_value[0].satoshis=0;
                assert!(!permitted(assess(&before,&[0],wrong_value,&[],&[])));
                let mut wrong_tape=pair.clone(); wrong_tape[1].script_pubkey=Script::op_return(&[b"invalid".to_vec()]);
                assert!(!permitted(assess(&before,&[0],wrong_tape,&[],&[])));
                assert!(!permitted(assess(&before,&[0],vec![code.clone()],&[],&[])));
                let mut mixed=pair; mixed.extend(ft_pair(100));
                assert!(!permitted(assess(&before,&[0],mixed,&[],&[])));
            }
        }
    }
    assert!(pools>0 && lps>0);
}

#[test]
fn current_special_contract_codes_do_not_hide_historical_asset_issuance() {
    use tbc_engine_core::protocols::{htlc,timelock,lop};
    let mut codes=vec![
        htlc::Code {sender_hash:[1;20],receiver_hash:[2;20],hashlock:[3;32],raw_lock_time:830000}.encode(),
        timelock::height_code([1;20],830000).unwrap(),
    ];
    for side in [lop::Side::Buy,lop::Side::Sell] {
        for pair in [false,true] {
            codes.push(lop::Code {
                side,market:if pair {lop::Market::TokenToken {a:lop::TapeMarker::Modern,b:lop::TapeMarker::Modern}}
                    else {lop::Market::NativeToken {token_code_bytes:1187,marker:lop::TapeMarker::Modern}},
                tax_hash:[9;20],terms:lop::Terms {
                    owner_hash:[1;20],sale_volume:1000,fee_rate:10,unit_price:1000000,
                    asset_a:lop::AssetTerms {partial_hash:[4;32],contract_id:[5;32]},
                    asset_b:pair.then_some(lop::AssetTerms {partial_hash:[6;32],contract_id:[7;32]}),
                },
            }.encode().unwrap());
        }
    }
    let funding=parent(vec![native()]);
    for bytes in codes {
        let output=TxOut {satoshis:1000,script_pubkey:Script::from_bytes(bytes.clone())};
        assert!(permitted(assess(&funding,&[0],vec![output.clone()],&[],&[])));
        let previous=parent(vec![output.clone()]);
        assert!(permitted(assess(&previous,&[0],vec![native()],&[],&[])));
        let mut mixed=vec![output.clone()];mixed.extend(ft_pair(100));
        assert!(!permitted(assess(&funding,&[0],mixed,&[],&[])));
        let mut trailing=bytes;trailing.push(0);
        assert!(!permitted(assess(&funding,&[0],vec![TxOut {
            satoshis:1000,script_pubkey:Script::from_bytes(trailing),
        }],&[],&[])));
    }
}

#[test]
fn unknown_and_missing_evidence_fail_closed_not_false_safe() {
    let before = parent(vec![native()]);
    let unknown = TxOut {satoshis:500, script_pubkey:Script::from_bytes(vec![0x51])};
    let report = assess(&before, &[0], vec![unknown], &[], &[]).unwrap();
    assert_eq!(report.unclassified, vec![PolicyLocation::Output(0)]);
    assert!(report.require_no_historical_issuance().is_err());
    let mut tx = Transaction::new(); tx.inputs.push(TxIn::new(point(&before, 0))); tx.outputs.push(native());
    assert!(assess_historical_issuance(&tx, &[], HistoricalPolicyTemplates::default()).is_err());
    let resolved = ResolvedHistoricalOutput {outpoint:point(&before, 0), output:&before.outputs[0]};
    let duplicate = ResolvedHistoricalOutput {outpoint:point(&before, 0), output:&before.outputs[0]};
    assert!(assess_historical_issuance(&tx, &[resolved,duplicate], HistoricalPolicyTemplates::default()).is_err());
}

#[test]
fn new_tbc20_fixture_create_transfer_merge_remain_available() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!("../../../fixtures/tbc20-standard-transfer.json")).unwrap();
    let transactions: Vec<_> = fixture["stages"].as_array().unwrap().iter()
        .map(|stage| Transaction::from_hex(stage["signedRaw"].as_str().unwrap()).unwrap()).collect();
    for index in 1..transactions.len() {
        let mut resolved = Vec::new();
        for previous in &transactions[..index] {
            for (vout, output) in previous.outputs.iter().enumerate() {
                resolved.push(ResolvedHistoricalOutput {outpoint:point(previous,vout as u32),output});
            }
        }
        let report = assess_historical_issuance(&transactions[index], &resolved, HistoricalPolicyTemplates::default()).unwrap();
        assert!(report.require_no_historical_issuance().is_ok(), "stage {index}: {report:?}");
    }
}

fn batch_permitted(transactions: &[Transaction], before: &Transaction) -> Result<(), String> {
    let material: Vec<_> = before.outputs.iter().enumerate().map(|(vout, output)| ResolvedHistoricalOutput {
        outpoint:point(before, vout as u32), output,
    }).collect();
    let batch: Vec<_> = transactions.iter().map(|transaction| HistoricalPolicyTransaction {
        transaction, templates:HistoricalPolicyTemplates::default(),
    }).collect();
    require_batch_no_historical_issuance(&batch, &material)
}

#[test]
fn batch_reuses_local_parents_and_refuses_later_issuance_before_any_signing() {
    let before = parent(ft_pair(1000));
    let mut first = parent(ft_pair(1000));
    first.inputs.push(TxIn::new(point(&before,0)));
    let mut child = parent(ft_pair(1000));
    child.inputs.push(TxIn::new(point(&first,0)));
    assert!(batch_permitted(&[first.clone(), child.clone()], &before).is_ok());
    child.outputs = ft_pair(1001);
    assert_eq!(batch_permitted(&[first,child], &before).unwrap_err(), "historical asset issuance is disabled");
    let mut source = parent(vec![native()]);
    source.inputs.push(TxIn::new(point(&before,0)));
    let mut mint = parent(ft_pair(1000));
    mint.inputs.push(TxIn::new(point(&source,0)));
    assert_eq!(batch_permitted(&[source,mint], &before).unwrap_err(), "historical asset issuance is disabled");
}

#[test]
fn batch_rejects_shared_input_forward_parent_and_external_parent_spoofing() {
    let before = parent(vec![native()]);
    let mut first = parent(vec![native()]); first.inputs.push(TxIn::new(point(&before,0)));
    let mut duplicate_spend = first.clone(); duplicate_spend.outputs[0].satoshis -= 1;
    assert_eq!(batch_permitted(&[first.clone(),duplicate_spend], &before).unwrap_err(), "historical policy batch spends an input twice");
    assert_eq!(batch_permitted(&[first.clone(),first.clone()], &before).unwrap_err(), "duplicate historical policy transaction");
    let mut child = parent(vec![native()]); child.inputs.push(TxIn::new(point(&first,0)));
    assert!(batch_permitted(&[child.clone(),first.clone()], &before).is_err());
    let inputs = [HistoricalPolicyTransaction {transaction:&first,templates:HistoricalPolicyTemplates::default()},
        HistoricalPolicyTransaction {transaction:&child,templates:HistoricalPolicyTemplates::default()}];
    let shadow = [ResolvedHistoricalOutput {outpoint:point(&first,0),output:&first.outputs[0]}];
    assert_eq!(require_batch_no_historical_issuance(&inputs,&shadow).unwrap_err(), "external policy material shadows a batch transaction");
    assert!(require_batch_no_historical_issuance(&[], &[]).is_err());
}

#[test]
fn new_tbc20_full_batch_reuses_fixed_signed_parent_outputs() {
    let fixture:serde_json::Value = serde_json::from_str(include_str!("../../../fixtures/tbc20-standard-transfer.json")).unwrap();
    let transactions:Vec<_> = fixture["stages"].as_array().unwrap().iter()
        .map(|stage| Transaction::from_hex(stage["signedRaw"].as_str().unwrap()).unwrap()).collect();
    assert!(batch_permitted(&transactions[1..], &transactions[0]).is_ok());
}

fn pool_hint() -> HistoricalPoolTemplate {
    HistoricalPoolTemplate {ft_version:FtScriptVersion::V4, is_coin:false, tag:b"Policy".to_vec(), lock:None}
}
fn lp_pair(amount: u64, pool_hash: [u8;32]) -> (Vec<TxOut>, HistoricalFtlpTemplate) {
    let tape = pool::ftlp_tape(&FtlpTapeParams {amount_raw:amount, layout:FtlpTapeLayout::Standard {decimal:6,name:"LP",symbol:"LP",is_coin:false}}).unwrap();
    let params = FtlpCodeParams::for_tape(&tape,FtScriptVersion::V4,false).unwrap();
    let code = pool::ftlp_code(pool_hash,&owner(),&params).unwrap();
    (vec![TxOut{satoshis:500,script_pubkey:code},TxOut{satoshis:0,script_pubkey:tape}],
        HistoricalFtlpTemplate {pool_code_hash:pool_hash,ft_version:FtScriptVersion::V4,is_coin:false,lock_time_enabled:false})
}
fn pool_pair(lp_supply: u64) -> Vec<TxOut> {
    let template = pool_hint();
    let code = pool::pool_code(OutPoint {txid:Txid::from_le_bytes([7;32]),vout:0},&template.tag,
        &PoolCodeParams {lp_plan:1,ft_version:template.ft_version,is_coin:false}).unwrap();
    let (lp,_) = lp_pair(0,hash::sha256(code.as_bytes()));
    let partial = tbc_sdk::contracts::ft::partial_sha256::calculate_partial_hash(&lp[0].script_pubkey.as_bytes()[..lp[0].script_pubkey.as_bytes().len()-28]);
    let reserve = if lp_supply==0 {0}else{1_000_000};
    let state = PoolState {amounts:PoolAmounts {ft_lp_raw:lp_supply,ft_a_raw:reserve,tbc_sat:reserve},ft_lp_partial_hash:partial.to_vec(),
        ft_a_partial_hash:vec![8;32],ft_a_contract_id:Txid::from_le_bytes([8;32]),service_fee_rate:3,service_provider:"Policy".into(),
        lp_plan:1,public_key_locked:false,ftlp_lock_time_enabled:false};
    vec![TxOut {satoshis:1000+reserve,script_pubkey:code}, TxOut {satoshis:0,script_pubkey:pool::pool_tape(&state).unwrap()}]
}

#[test]
fn pool_creation_initialization_and_unbacked_lp_are_denied_existing_add_preserved() {
    let before = parent(pool_pair(100));
    let hash = hash::sha256(before.outputs[0].script_pubkey.as_bytes());
    let (lp, lp_hint) = lp_pair(10,hash);
    let mut added = pool_pair(110); added.extend(lp);
    let inputs = [(point(&before,0), HistoricalTemplate::Pool(pool_hint()))];
    let outputs = [(0, HistoricalTemplate::Pool(pool_hint())),(2,HistoricalTemplate::Ftlp(lp_hint))];
    assert!(permitted(assess(&before,&[0],added.clone(),&inputs,&outputs)));
    let source = parent(vec![native()]);
    assert!(!permitted(assess(&source,&[0],added.clone(),&[],&outputs)));
    let empty = parent(pool_pair(0));
    let empty_inputs = [(point(&empty,0),HistoricalTemplate::Pool(pool_hint()))];
    assert!(!permitted(assess(&empty,&[0],added,&empty_inputs,&outputs)));
    let (extra,_) = lp_pair(11,hash); let mut wrong=pool_pair(110);wrong.extend(extra);
    assert!(!permitted(assess(&before,&[0],wrong,&inputs,&outputs)));
    assert!(!permitted(assess(&before,&[0],pool_pair(110),&inputs,&outputs[..1])));
    // Merely including Pool material while spending something else grants no LP allowance.
    let (unbacked,lp_hint) = lp_pair(10,hash);
    assert!(!permitted(assess(&source,&[0],unbacked,&[],&[(0,HistoricalTemplate::Ftlp(lp_hint))])));
}

#[test]
fn existing_pool_updates_and_lp_transfer_do_not_require_new_issuance_permission() {
    let before = parent(pool_pair(100));
    let input_hint = [(point(&before,0),HistoricalTemplate::Pool(pool_hint()))];
    let output_hint = [(0,HistoricalTemplate::Pool(pool_hint()))];
    assert!(permitted(assess(&before,&[0],pool_pair(100),&input_hint,&output_hint)));
    assert!(permitted(assess(&before,&[0],pool_pair(90),&input_hint,&output_hint)));
    let hash = hash::sha256(before.outputs[0].script_pubkey.as_bytes());
    let (lp, hint) = lp_pair(10,hash); let before = parent(lp.clone());
    assert!(permitted(assess(&before,&[0],lp,&[(point(&before,0),HistoricalTemplate::Ftlp(hint))],&[(0,HistoricalTemplate::Ftlp(hint))])));
}

#[test]
fn reviewer_material_needs_no_external_pool_or_lp_version_hints() {
    let before=parent(pool_pair(100));
    assert!(permitted(assess(&before,&[0],pool_pair(90),&[],&[])));
    let pool_hash=hash::sha256(before.outputs[0].script_pubkey.as_bytes());
    let (lp,_)=lp_pair(10,pool_hash);let mut added=pool_pair(110);added.extend(lp.clone());
    assert!(permitted(assess(&before,&[0],added,&[],&[])));
    let lp_parent=parent(lp.clone());
    assert!(permitted(assess(&lp_parent,&[0],lp,&[],&[])));
    let fund=parent(vec![native()]);
    assert!(!permitted(assess(&fund,&[0],pool_pair(100),&[],&[])));
    let (new_lp,_)=lp_pair(10,pool_hash);
    assert!(!permitted(assess(&fund,&[0],new_lp,&[],&[])));
}

#[test]
fn lp_allowance_is_same_pool_same_partial_and_can_be_split_without_inflation() {
    let before = parent(pool_pair(100));
    let pool_hash = hash::sha256(before.outputs[0].script_pubkey.as_bytes());
    let inputs = [(point(&before,0),HistoricalTemplate::Pool(pool_hint()))];
    let (foreign, foreign_hint) = lp_pair(10,[9;32]);
    let mut outputs = pool_pair(110); outputs.extend(foreign);
    assert!(!permitted(assess(&before,&[0],outputs,&inputs,
        &[(0,HistoricalTemplate::Pool(pool_hint())),(2,HistoricalTemplate::Ftlp(foreign_hint))])));

    // Same Pool reference but a different genuinely reconstructed LP template
    // must not borrow the allowance authorized for the Pool's actual partial.
    let (mut wrong,mut wrong_hint) = lp_pair(10,pool_hash);
    wrong_hint.ft_version = FtScriptVersion::V3;
    let params = FtlpCodeParams::for_tape(&wrong[1].script_pubkey,FtScriptVersion::V3,false).unwrap();
    wrong[0].script_pubkey = pool::ftlp_code(pool_hash,&owner(),&params).unwrap();
    let mut outputs = pool_pair(110); outputs.extend(wrong);
    assert!(!permitted(assess(&before,&[0],outputs,&inputs,
        &[(0,HistoricalTemplate::Pool(pool_hint())),(2,HistoricalTemplate::Ftlp(wrong_hint))])));

    for (second,expected) in [(6,true),(7,false)] {
        let (first,hint) = lp_pair(4,pool_hash); let (last,_) = lp_pair(second,pool_hash);
        let mut outputs = pool_pair(110); outputs.extend(first); outputs.extend(last);
        let hints = [(0,HistoricalTemplate::Pool(pool_hint())),(2,HistoricalTemplate::Ftlp(hint)),(4,HistoricalTemplate::Ftlp(hint))];
        assert_eq!(permitted(assess(&before,&[0],outputs,&inputs,&hints)),expected);
    }
}
