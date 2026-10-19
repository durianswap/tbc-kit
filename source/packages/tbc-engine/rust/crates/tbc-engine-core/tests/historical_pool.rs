use serde_json::Value;
use tbc_engine_core::protocols::historical_pool::*;
use tbc_sdk::{Address, OutPoint, PublicKey, TxOut, hash, script::Script};
use tbc_sdk::contracts::{ft::scripts::transfer_tape_script, pool_nft_v2::{
    PoolState, PoolCodeParams, LockedPoolCodeParams, FtScriptVersion, FtlpCodeParams,
    FtlpTapeParams, FtlpTapeLayout, pool_code, locked_pool_code, pool_tape,
    ftlp_code, ftlp_lock_time_code, ftlp_tape, scripts::transfer_ftlp_code_script,
}};

fn fixture() -> Value {
    serde_json::from_str(include_str!("../../../vendor/tbc-sdk/tests/fixtures/pool-v2-js-165.json")).unwrap()
}
fn decode(value: &str) -> Vec<u8> {
    assert_eq!(value.len() % 2, 0);
    value.as_bytes().chunks_exact(2).map(|pair| {
        u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap()
    }).collect()
}
fn script(f: &Value, name: &str) -> Script {
    Script::from_bytes(decode(f["scripts"][name]["hex"].as_str().unwrap()))
}
fn hash32(f: &Value, name: &str) -> [u8;32] {
    decode(f[name].as_str().unwrap()).try_into().unwrap()
}
fn pool_pair(keys: usize) -> (TxOut, TxOut, HistoricalPoolTemplate) {
    let f = fixture();
    let source = OutPoint { txid: f["sourceTxid"].as_str().unwrap().parse().unwrap(), vout: f["sourceVout"].as_u64().unwrap() as u32 };
    let mut state = PoolState::from_v2_tape(&script(&f, "poolTape"), String::new()).unwrap();
    state.public_key_locked = keys > 0;
    let template = HistoricalPoolTemplate {
        ft_version: FtScriptVersion::V3, is_coin: false,
        tag: decode(f["tagHex"].as_str().unwrap()),
        lock: (keys > 0).then(|| HistoricalPoolLockTemplate {
            public_keys: f["publicKeys"].as_array().unwrap()[..keys].iter()
                .map(|key| PublicKey::from_slice(&decode(key.as_str().unwrap())).unwrap()).collect(),
            lp_cost_address: Address::from_hash160(decode(f["lpCostHash160"].as_str().unwrap()).try_into().unwrap()),
            lp_cost_sat: f["lpCostSat"].as_u64().unwrap(),
        }),
    };
    let params = PoolCodeParams { ft_version: template.ft_version, is_coin: template.is_coin, lp_plan: state.lp_plan };
    let code = if let Some(lock) = &template.lock {
        locked_pool_code(source, &template.tag, &lock.public_keys, &LockedPoolCodeParams {
            pool: params, lp_cost_address: lock.lp_cost_address.clone(), lp_cost_sat: lock.lp_cost_sat,
        }).unwrap()
    } else { pool_code(source, &template.tag, &params).unwrap() };
    (TxOut {satoshis: 30_001_000, script_pubkey: code}, TxOut {satoshis:0, script_pubkey:pool_tape(&state).unwrap()}, template)
}

#[test]
fn pool_origin_recognition_needs_no_index_tag_or_ft_version_claim() {
    use tbc_engine_core::protocols::pool_origin::{inspect_pool_origin,inspect_pool_profile,PoolProfile};
    use tbc_sdk::{Transaction,TxIn};
    for keys in [0,1,3,10] {for version in [FtScriptVersion::V1,FtScriptVersion::V2,FtScriptVersion::V3,FtScriptVersion::V4] {for coin in [false,true] {
        let (mut code,tape,template)=pool_pair(keys);
        let source=tbc_sdk::contracts::pool_nft_v2::scripts::pool_code_source_outpoint(&code.script_pubkey).unwrap();
        let state=PoolState::from_v2_tape(&tape.script_pubkey,String::new()).unwrap();
        let params=PoolCodeParams {lp_plan:state.lp_plan,ft_version:version,is_coin:coin};
        code.script_pubkey=if let Some(lock)=&template.lock {
            locked_pool_code(source.clone(),&template.tag,&lock.public_keys,&LockedPoolCodeParams {pool:params,lp_cost_address:lock.lp_cost_address.clone(),lp_cost_sat:lock.lp_cost_sat}).unwrap()
        }else{pool_code(source.clone(),&template.tag,&params).unwrap()};
        code.satoshis=1_000;
        let tx=Transaction {version:10,inputs:vec![TxIn::new(source)],outputs:vec![code,tape],lock_time:0};
        assert_eq!(inspect_pool_origin(&tx.txid(),&tx.serialize()).unwrap(),PoolProfile::Historical);
        assert_eq!(inspect_pool_profile(&tx).unwrap(),PoolProfile::Historical);
        let mut wrong=tx.clone();let mut bytes=wrong.outputs[0].script_pubkey.as_bytes().to_vec();bytes[0]^=1;
        wrong.outputs[0].script_pubkey=Script::from_bytes(bytes);
        assert!(inspect_pool_origin(&wrong.txid(),&wrong.serialize()).is_err());
        let mut wrong=tx.clone();wrong.inputs[0].previous_output.vout+=1;
        assert!(inspect_pool_origin(&wrong.txid(),&wrong.serialize()).is_err());
    }}}
}

#[test]
fn ordinary_and_locked_pool_identity_ignores_balances_not_code_rules() {
    for keys in [0, 1, 3, 10] {
        let (code,tape,template) = pool_pair(keys);
        let before = inspect_historical_pool(&code,Some(&tape),Some(&template)).unwrap().unwrap();
        assert_eq!(inspect_historical_pool_auto(&code,Some(&tape)).unwrap().unwrap().identity,before.identity);
        assert_eq!(before.identity.source.vout,7);
        assert_eq!(before.identity.code_hash,hash::sha256(code.script_pubkey.as_bytes()));
        assert_eq!(before.state.public_key_locked,keys>0);
        let mut next_state = before.state.clone();
        next_state.amounts.ft_lp_raw += 1; next_state.amounts.tbc_sat += 2;
        let next_tape = TxOut {satoshis:0,script_pubkey:pool_tape(&next_state).unwrap()};
        let next = inspect_historical_pool(&code,Some(&next_tape),Some(&template)).unwrap().unwrap();
        assert_eq!(before.identity,next.identity);
        assert_ne!(before.state.amounts,next.state.amounts);
        let mut wrong = template.clone(); wrong.tag = b"other".to_vec();
        assert!(inspect_historical_pool(&code,Some(&tape),Some(&wrong)).is_err());
        if let Some(lock) = &mut wrong.lock { lock.lp_cost_sat += 1; wrong.tag = template.tag.clone();
            assert!(inspect_historical_pool(&code,Some(&tape),Some(&wrong)).is_err()); }
    }
}

#[test]
fn pool_suffix_and_source_are_not_a_template_proof() {
    let (code,tape,template) = pool_pair(1);
    assert!(inspect_historical_pool(&code,None,Some(&template)).is_err());
    assert!(inspect_historical_pool(&code,Some(&tape),None).is_err());
    let mut bad = code.clone(); let mut raw=bad.script_pubkey.as_bytes().to_vec(); raw[0]^=1;
    bad.script_pubkey=Script::from_bytes(raw);
    assert!(inspect_historical_pool(&bad,Some(&tape),Some(&template)).is_err());
    let mut bad_tape = tape.clone(); bad_tape.satoshis=1;
    assert!(inspect_historical_pool(&code,Some(&bad_tape),Some(&template)).is_err());
    let mut state = PoolState::from_v2_tape(&tape.script_pubkey,String::new()).unwrap(); state.public_key_locked=false;
    bad_tape.satoshis=0; bad_tape.script_pubkey=pool_tape(&state).unwrap();
    assert!(inspect_historical_pool(&code,Some(&bad_tape),Some(&template)).is_err());
    let unknown=TxOut {satoshis:1000,script_pubkey:Address::from_hash160([1;20]).script_pubkey()};
    assert!(inspect_historical_pool(&unknown,None,None).unwrap().is_none());
}

#[test]
fn fixed_ftlp_fixtures_cover_current_legacy_and_locked_code() {
    let f=fixture();
    for (name,tape_name,version,locked) in [
        ("currentFtlp","ftlpTape",FtScriptVersion::V3,false),
        ("lockTimeFtlp","ftlpLockTimeTape",FtScriptVersion::V3,true),
        ("legacyV2Ftlp","ftlpTape",FtScriptVersion::V2,false),
        ("legacyV2LockTimeFtlp","ftlpLockTimeTape",FtScriptVersion::V2,true),
    ] {
        let code=TxOut {satoshis:500,script_pubkey:script(&f,name)};
        let tape=TxOut {satoshis:0,script_pubkey:script(&f,tape_name)};
        let template=HistoricalFtlpTemplate {pool_code_hash:hash32(&f,"poolCodeHash"),ft_version:version,is_coin:false,lock_time_enabled:locked};
        let found=inspect_historical_ftlp(&code,Some(&tape),Some(&template)).unwrap().unwrap();
        assert_eq!(inspect_historical_ftlp_auto(&code,Some(&tape)).unwrap().unwrap(),found);
        assert_eq!(found.identity.pool_code_hash,template.pool_code_hash);
        assert_eq!(found.identity.partial_hash,tbc_sdk::contracts::ft::partial_sha256::calculate_partial_hash(
            &code.script_pubkey.as_bytes()[..1856]));
        assert_eq!(&found.controller[..20],decode(f["ownerHash160"].as_str().unwrap()));
        assert_eq!(found.lock_time.is_some(),locked); assert!(found.amount>0);
        let moved=TxOut {satoshis:500,script_pubkey:transfer_ftlp_code_script(&code.script_pubkey,&Address::from_hash160([2;20])).unwrap()};
        let moved=inspect_historical_ftlp(&moved,Some(&tape),Some(&template)).unwrap().unwrap();
        assert_eq!(moved.identity,found.identity); assert_ne!(moved.controller,found.controller);
        let wrong=HistoricalFtlpTemplate {pool_code_hash:[9;32],..template};
        assert!(inspect_historical_ftlp(&code,Some(&tape),Some(&wrong)).is_err());
    }
}

#[test]
fn ftlp_all_six_slots_and_lock_deadline_are_state_not_identity() {
    let owner=Address::from_hash160([1;20]);
    for (version,coin) in [FtScriptVersion::V1,FtScriptVersion::V2,FtScriptVersion::V3,FtScriptVersion::V4].into_iter().flat_map(|v|[(v,false),(v,true)]) {
        for locked in [false,true] {
            let base=ftlp_tape(&FtlpTapeParams {amount_raw:0,layout:if locked {
                FtlpTapeLayout::LockTime {lock_time:824200,source_ft_tape_size:69}
            } else {FtlpTapeLayout::Standard {decimal:8,name:"TokenLP",symbol:"TLP",is_coin:coin}}}).unwrap();
            let mut slots=[0u8;48]; slots[..8].copy_from_slice(&u64::MAX.to_le_bytes()); slots[40..].copy_from_slice(&u64::MAX.to_le_bytes());
            let tape=TxOut {satoshis:0,script_pubkey:transfer_tape_script(&base,&slots).unwrap()};
            let params=FtlpCodeParams::for_tape(&tape.script_pubkey,version,coin).unwrap();
            let template=HistoricalFtlpTemplate {pool_code_hash:[7;32],ft_version:version,is_coin:coin,lock_time_enabled:locked};
            let code=TxOut {satoshis:500,script_pubkey:if locked {ftlp_lock_time_code([7;32],&owner,&params)} else {ftlp_code([7;32],&owner,&params)}.unwrap()};
            let found=inspect_historical_ftlp(&code,Some(&tape),Some(&template)).unwrap().unwrap();
            assert_eq!(inspect_historical_ftlp_auto(&code,Some(&tape)).unwrap().unwrap(),found);
            assert_eq!(found.amount,2*u128::from(u64::MAX));
            if locked {
                let later=TxOut {satoshis:0,script_pubkey:ftlp_tape(&FtlpTapeParams {amount_raw:1,layout:FtlpTapeLayout::LockTime {lock_time:824300,source_ft_tape_size:69}}).unwrap()};
                let later=inspect_historical_ftlp(&code,Some(&later),Some(&template)).unwrap().unwrap();
                assert_eq!(later.identity,found.identity); assert_ne!(later.lock_time,found.lock_time);
            }
            let mut bad=code.clone();let mut bytes=bad.script_pubkey.as_bytes().to_vec();bytes[0]^=1;bad.script_pubkey=Script::from_bytes(bytes);
            assert!(inspect_historical_ftlp(&bad,Some(&tape),Some(&template)).is_err());
            assert!(inspect_historical_ftlp_auto(&bad,Some(&tape)).is_err());
            assert!(inspect_historical_ftlp(&code,None,Some(&template)).is_err());
            assert!(inspect_historical_ftlp(&code,Some(&tape),None).is_err());
            let mut bad=tape.clone();bad.satoshis=1;
            assert!(inspect_historical_ftlp(&code,Some(&bad),Some(&template)).is_err());
        }
    }
}
