//! Exact upstream JS codec/fee parity. Not script-VM or real-chain acceptance.
use serde_json::{Value,json};
use sha2::{Digest,Sha256};
use tbc_sdk::Address;
use tbc_engine_core::protocols::{amm,amm_code::{self,Authorization},amm_explicit as current,amm_math::{self,State,AddBudget}};
const ADDRESS:&str="13oCEJaqyyiC8iRrfup6PDL2GKZ3xQrsZL";
fn fixture()->Value{serde_json::from_str(include_str!("../../../fixtures/amm-explicit173.json")).unwrap()}
fn bytes(v:&Value)->Vec<u8>{let s=v.as_str().unwrap();(0..s.len()).step_by(2).map(|i|u8::from_str_radix(&s[i..i+2],16).unwrap()).collect()}
fn hex(v:&[u8])->String{v.iter().map(|b|format!("{b:02x}")).collect()}
fn rates(row:&Value)->current::FeeRates{serde_json::from_value(json!({"lpFeeRate":row["lpFeeRate"],"taxFeeRate":row["taxFeeRate"],"serviceProviderFeeRate":row["serviceProviderFeeRate"],"protocolFeeRate":row["protocolFeeRate"]})).unwrap()}
fn tape(row:&Value)->current::Tape {
    current::Tape{ft_lp_partial_hash:[1;32],ft_lp_code_size:2659,ft_a_partial_hash:[2;32],ft_a_code_size:500,
        ft_lp_amount:1_000_000,ft_a_amount:2_000_000,tbc_amount:3_000_000,ft_a_contract_id:[3;32],
        rates:rates(&row["rates"]),fee_pubkey_hash:Address::from_string(ADDRESS).unwrap().hash160(),
        with_swap_hash_lock:row["controlled"].as_bool().unwrap(),with_lp_locktime:row["locked"].as_bool().unwrap(),with_lp_hash_lock:row["controlled"].as_bool().unwrap()}
}
#[test]
fn exact_four_rate_fees_match_upstream_including_rounding_threshold_and_bounds(){
    let f=fixture();assert_eq!(f["upstream"]["version"],"1.7.3");
    for row in f["fees"].as_array().unwrap(){
        let policy=current::FeePolicy::new(rates(&row["input"]),ADDRESS).unwrap();
        assert_eq!(u64::from(policy.total_fee_bps()),row["totalFeeBps"].as_u64().unwrap());
        for expected in row["samples"].as_array().unwrap(){
            let base=expected["baseTbcSat"].as_str().unwrap().parse().unwrap();
            let actual=serde_json::to_value(policy.calculate(base).unwrap()).unwrap();
            for(k,v)in actual.as_object().unwrap(){assert_eq!(v.to_string(),expected[k].as_str().unwrap(),"{k} at {base}");}
        }
    }
    for n in [600,601,9999]{assert!(current::FeePolicy::new(current::FeeRates{lp_fee_rate:n,tax_fee_rate:0,service_provider_fee_rate:0,protocol_fee_rate:0},ADDRESS).is_ok());}
    for r in [[10000,0,0,0],[9999,1,0,0],[65535,65535,65535,65535]] {
        assert!(current::FeePolicy::new(current::FeeRates{lp_fee_rate:r[0],tax_fee_rate:r[1],service_provider_fee_rate:r[2],protocol_fee_rate:r[3]},ADDRESS).is_err());
    }
    for(key,bad)in[("lpFeeRate",json!(-1)),("lpFeeRate",json!(1.1)),("lpFeeRate",json!(65536)),("lpFeeRate",json!("35")),("lpPlan",json!(1))] {
        let mut v=json!({"lpFeeRate":25,"taxFeeRate":0,"serviceProviderFeeRate":10,"protocolFeeRate":0});v[key]=bad;
        assert!(serde_json::from_value::<current::FeeRates>(v).is_err());
    }
    let zero=current::FeeRates{lp_fee_rate:0,tax_fee_rate:0,service_provider_fee_rate:0,protocol_fee_rate:0};
    for address in ["", "bad", "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", " 13oCEJaqyyiC8iRrfup6PDL2GKZ3xQrsZL"] {assert!(current::FeePolicy::new(zero,address).is_err());}
}
#[test]
fn exact_explicit_tapes_preserve_configuration_and_do_not_alias_historical_format(){
    let f=fixture();assert_eq!(f["tapes"].as_array().unwrap().len(),36);
    for row in f["tapes"].as_array().unwrap(){
        let t=tape(row);let raw=bytes(&row["hex"]);assert_eq!(t.encode().unwrap(),raw);assert_eq!(current::Tape::decode(&raw).unwrap(),t);
        assert!(matches!(current::decode_tape(&raw).unwrap(),current::VersionedTape::Explicit(_)));
        assert!(amm::Tape::decode(&raw).is_err());
        let next=t.with_amounts(1,2,3).unwrap();t.same_configuration(&next).unwrap();
        let mut changed=next.clone();changed.rates.protocol_fee_rate+=1;assert!(t.same_configuration(&changed).is_err());
        let mut changed=next.clone();changed.fee_pubkey_hash[0]^=1;assert!(t.same_configuration(&changed).is_err());
        let mut changed=next.clone();changed.ft_a_contract_id[0]^=1;assert!(t.same_configuration(&changed).is_err());
        let mut noncanonical=raw.clone();noncanonical[159]=0x99;
        assert_eq!(current::Tape::decode(&noncanonical).unwrap(),t);assert_eq!(noncanonical[159],0x99,"caller raw evidence stays untouched");
        for i in [0,1,2,3,160,167]{let mut changed=raw.clone();changed[i]^=1;assert!(current::Tape::decode(&changed).is_err());}
        for i in [156,157,158]{let mut changed=raw.clone();changed[i]=2;assert!(current::Tape::decode(&changed).is_err());}
        for len in [0,143,167,169]{let mut bad=raw.clone();bad.resize(len,0);assert!(current::Tape::decode(&bad).is_err());}
        let mut wide=t.clone();wide.ft_lp_amount=amm::MAX_AMOUNT+1;assert!(wide.encode().is_err());
    }
    let old=amm::Tape{ft_lp_partial_hash:[1;32],ft_lp_code_size:2659,ft_a_partial_hash:[2;32],ft_a_code_size:500,
        ft_lp_amount:1,ft_a_amount:2,tbc_amount:3,ft_a_contract_id:[3;32],service_fee_rate:35,lp_plan:1,
        with_swap_hash_lock:false,with_lp_locktime:false,with_lp_hash_lock:false}.encode().unwrap();
    assert!(current::Tape::decode(&old).is_err());assert!(matches!(current::decode_tape(&old).unwrap(),current::VersionedTape::Preset(_)));
}
#[test]
fn exact_templates_match_upstream_and_tag_push_boundaries(){
    let f=fixture();assert_eq!(f["codes"].as_array().unwrap().len(),28);
    for row in f["codes"].as_array().unwrap(){
        let count=row["controllers"].as_u64().unwrap() as u8;
        let authorization=if count==0{Authorization::Public}else{Authorization::Controller((1..=count).map(|n|[n;20]).collect())};
        let c=current::Code{original_utxo:[4;36],fee_script_hash:bytes(&row["feeScriptHash"]).try_into().unwrap(),ft_tape_size:66,
            authorization,service_provider_tag:bytes(&row["tagHex"])};
        let raw=current::instantiate_code(&c).unwrap();assert_eq!(raw,bytes(&row["hex"]));
        assert_eq!(hex(&Sha256::digest(&raw)),row["sha256"].as_str().unwrap());assert_eq!(current::parse_code(&raw).unwrap(),c);
        assert!(amm_code::parse_code(&raw).is_err());
        for i in [0,1,raw.len()-1]{let mut bad=raw.clone();bad[i]^=1;assert!(current::parse_code(&bad).is_err());}
        let mut trailing=raw.clone();trailing.push(0);assert!(current::parse_code(&trailing).is_err());
        for len in [0,20,raw.len()-1]{assert!(current::parse_code(&raw[..len]).is_err());}
        let t=tape(&f["tapes"][0]);assert!(c.fee_policy(&t).is_ok());
        let mut bad=t.clone();bad.fee_pubkey_hash[0]^=1;assert!(c.fee_policy(&bad).is_err());
        let old=amm_code::Code{original_utxo:c.original_utxo,fee_script_hash:c.fee_script_hash,ft_tape_size:c.ft_tape_size,authorization:c.authorization};
        assert!(current::parse_code(&amm_code::instantiate_code(&old).unwrap()).is_err());
    }
    assert!(current::parse_code(b"POOLCODE2").is_err());
}
#[test]
fn explicit_quotes_and_lifecycle_match_unmodified_upstream_including_rejections(){
    fn stringify_numbers(value:Value)->Value{match value {
        Value::Number(n)=>Value::String(n.to_string()),
        Value::Array(a)=>Value::Array(a.into_iter().map(stringify_numbers).collect()),
        Value::Object(m)=>Value::Object(m.into_iter().map(|(k,v)|(k,stringify_numbers(v))).collect()),other=>other,
    }}
    fn n(row:&Value,key:&str)->u64{row[key].as_str().unwrap().parse().unwrap()}
    fn assert_quote<T:serde::Serialize>(actual:Result<T,amm::AmmError>,expected:&Value){
        assert_eq!(actual.is_ok(),expected["ok"].as_bool().unwrap(),"upstream outcome {expected}");
        if let Ok(quote)=actual{assert_eq!(stringify_numbers(serde_json::to_value(quote).unwrap()),expected["quote"]);}
    }
    let f:Value=serde_json::from_str(include_str!("../../../fixtures/amm-explicit173-quotes.json")).unwrap();
    for row in f["swaps"].as_array().unwrap(){
        let policy=current::FeePolicy::new(rates(&row["rates"]),ADDRESS).unwrap();let s=&row["state"];
        let state=State{ft_lp_amount:n(s,"ftLpAmount"),ft_a_amount:n(s,"ftAAmount"),tbc_amount:n(s,"tbcAmount"),pool_value:n(s,"poolValue")};
        if row["direction"]=="buy"{assert_quote(policy.quote_buy(state,n(row,"input"),n(row,"minimum")),row);}
        else{assert_quote(policy.quote_sell(state,n(row,"input"),n(row,"minimum")),row);}
    }
    for row in f["lifecycle"].as_array().unwrap(){
        let policy=current::FeePolicy::new(rates(&row["rates"]),ADDRESS).unwrap();
        let initial=State{ft_lp_amount:0,ft_a_amount:0,tbc_amount:0,pool_value:1500};
        let add=amm_math::quote_add(initial,AddBudget::Tbc{amount:1_000_000,first_ft:Some(1_000_000)}).unwrap();
        assert_eq!(stringify_numbers(serde_json::to_value(&add).unwrap()),row["add"]);
        let buy=policy.quote_buy(add.next_state,10_000,1);assert_quote(buy.clone(),&row["buy"]);let Ok(buy)=buy else{continue;};
        let sell=policy.quote_sell(buy.next_state,buy.ft_out_raw,1);assert_quote(sell.clone(),&row["sell"]);let Ok(sell)=sell else{continue;};
        let remove=amm_math::quote_remove(sell.next_state,sell.next_state.ft_lp_amount).unwrap();assert_eq!(remove.next_state,initial);
        assert_eq!(stringify_numbers(serde_json::to_value(remove).unwrap()),row["remove"]);
        assert_eq!(buy.fees.net_amount_sat+buy.fees.pool_fee_retained_sat+buy.fees.service_fee_paid_sat,10_000);
    }
}
