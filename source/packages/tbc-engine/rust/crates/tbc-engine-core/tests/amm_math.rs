use tbc_engine_core::protocols::{amm::{Tape,Variant,MAX_AMOUNT},amm_math::*};
use serde_json::{Value,json};
fn n(v:&Value)->u64{v.as_str().map(|s|s.parse().unwrap()).unwrap_or_else(||v.as_u64().unwrap())}
fn state(v:&Value)->State{State{ft_lp_amount:n(&v["ftLpAmount"]),ft_a_amount:n(&v["ftAAmount"]),tbc_amount:n(&v["tbcAmount"]),pool_value:n(&v["poolValue"])}}
fn canonical(v:Value)->Value{match v{Value::Number(n)=>Value::String(n.to_string()),Value::Array(a)=>Value::Array(a.into_iter().map(canonical).collect()),Value::Object(o)=>Value::Object(o.into_iter().map(|(k,v)|(k,canonical(v))).collect()),v=>v}}
fn bytes(hex:&str)->Vec<u8>{(0..hex.len()).step_by(2).map(|i|u8::from_str_radix(&hex[i..i+2],16).unwrap()).collect()}

#[test]
fn amm_matches_pinned_sdk_quote_and_fee_vectors(){
    let fixture:Value=serde_json::from_str(include_str!("../../../fixtures/amm-math.json")).unwrap();
    for row in fixture["policies"].as_array().unwrap(){
        let p=fee_policy(n(&row["lpPlan"]) as u8,Some(n(&row["totalFeeBps"]) as u16)).unwrap();
        assert_eq!(p.lp_fee_bps as u64,n(&row["lpFeeBps"]));
        assert_eq!(p.service_fee_address,row["serviceFeeAddress"].as_str().unwrap());
        assert_eq!(n(&row["servicePayoutThresholdSat"]),10);
    }
    for (index,row) in fixture["cases"].as_array().unwrap().iter().enumerate(){
        let i=&row["input"];let plan=i["plan"].as_u64().unwrap_or(1) as u8;let rate=i.get("rate").map(|r|n(r) as u16);
        let result=match row["op"].as_str().unwrap(){
            "fees"=>calculate_fees(n(&i["amount"]),plan,rate).map(|v|json!(v)),
            "add"=>{let b=&i["budget"];let budget=if let Some(a)=b.get("incrementSat"){AddBudget::Tbc{amount:n(a),first_ft:b.get("firstFtAmountRaw").map(n)}}else{AddBudget::Ft(n(&b["incrementFtRaw"]))};quote_add(state(&i["state"]),budget).map(|v|json!(v))},
            "remove"=>quote_remove(state(&i["state"]),n(&i["amount"])).map(|v|json!(v)),
            "buy"=>quote_buy(state(&i["state"]),n(&i["amount"]),plan,rate,n(&i["minimum"])).map(|v|json!(v)),
            "sell"=>quote_sell(state(&i["state"]),n(&i["amount"]),plan,rate,n(&i["minimum"])).map(|v|json!(v)),
            _=>panic!("unknown fixture operation"),
        };
        let actual=match result{Ok(value)=>json!({"ok":true,"value":value}),Err(_)=>json!({"ok":false})};
        assert_eq!(canonical(actual),canonical(row["expected"].clone()),"SDK vector {index}: {}",row["op"]);
    }
}
#[test]
fn amm_tape_exact_four_variants_and_configuration_preservation(){
    let fixture:Value=serde_json::from_str(include_str!("../../../fixtures/amm-math.json")).unwrap();
    for row in fixture["tapes"].as_array().unwrap(){
        let raw=bytes(row["hex"].as_str().unwrap());let tape=Tape::decode(&raw).unwrap();assert_eq!(tape.encode().unwrap(),raw);
        assert_eq!(tape.ft_a_contract_id,std::array::from_fn(|i|i as u8));
        assert_eq!(tape.ft_lp_amount,MAX_AMOUNT);
        let variant=match tape.variant().unwrap(){Variant::Public=>"public",Variant::PublicTimelocked=>"public-timelocked",Variant::Controller=>"controller",Variant::ControllerTimelocked=>"controller-timelocked"};
        assert_eq!(variant,row["variant"].as_str().unwrap());
        let changed=tape.with_amounts(1,2,3).unwrap();tape.same_configuration(&changed).unwrap();
        assert_eq!(changed.encode().unwrap(),bytes(row["changedHex"].as_str().unwrap()));
        let mut wrong=changed.clone();wrong.ft_a_contract_id[0]^=1;assert!(tape.same_configuration(&wrong).is_err());
    }
}
#[test]
fn amm_tape_rejects_noncanonical_framing_ranges_and_flags(){
    let fixture:Value=serde_json::from_str(include_str!("../../../fixtures/amm-math.json")).unwrap();let raw=bytes(fixture["tapes"][0]["hex"].as_str().unwrap());
    for len in [0,3,142,144]{let mut b=raw.clone();b.resize(len,0);assert!(Tape::decode(&b).is_err());}
    for offset in [0,1,2,3,134,142]{let mut b=raw.clone();b[offset]^=1;assert!(Tape::decode(&b).is_err());}
    for offset in [131,132,133]{let mut b=raw.clone();b[offset]=2;assert!(Tape::decode(&b).is_err());}
    let mut b=raw.clone();b[131]=1;assert!(Tape::decode(&b).is_err());
    for offset in [36,70]{let mut b=raw.clone();b[offset..offset+2].copy_from_slice(&127u16.to_le_bytes());assert!(Tape::decode(&b).is_err());}
    for offset in [72,80,88]{let mut b=raw.clone();b[offset..offset+8].copy_from_slice(&(MAX_AMOUNT+1).to_le_bytes());assert!(Tape::decode(&b).is_err());}
}
