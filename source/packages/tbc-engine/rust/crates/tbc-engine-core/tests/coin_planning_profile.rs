//! Replays frozen public-only RC.17 vectors. Never fetches, signs, or broadcasts.
use serde_json::{json, Value};
use std::{hint::black_box, time::Instant};
#[test]
#[ignore = "explicit local performance comparison"]
fn replay_frozen_coin_vectors() {
    let path=std::env::var("COIN_PROFILE_VECTORS").expect("frozen public vector file required");
    let vectors:Vec<Value>=serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let iterations:usize=std::env::var("COIN_PROFILE_ITERATIONS").unwrap_or("31".into()).parse().unwrap();
    for (index,v) in vectors.iter().enumerate() {
        let method=v["method"].as_str().unwrap();
        let input=v["input"].as_str().unwrap().to_owned();
        let parsed_input:Value=serde_json::from_str(&input).unwrap();
        let expected:Value=serde_json::from_str(v["expected"].as_str().unwrap()).unwrap();
        for _ in 0..3 {
            let result:Value=serde_json::from_str(&tbc_engine_core::call_json_name(method,&input)).unwrap();
            assert_eq!(result,expected,"frozen vector {index}");
        }
        let mut samples=Vec::new();
        for _ in 0..iterations {
            #[cfg(feature="coin-planning-profile")]
            let _=tbc_engine_core::planning_profile::take();
            let start=Instant::now();
            let output=tbc_engine_core::call_json_name(method,black_box(&input));
            let elapsed=start.elapsed().as_nanos();
            #[cfg(feature="coin-planning-profile")]
            let stages=tbc_engine_core::planning_profile::take();
            #[cfg(not(feature="coin-planning-profile"))]
            let stages=json!({});
            let result:Value=serde_json::from_str(&output).unwrap();
            assert_eq!(result,expected,"frozen vector {index}");
            samples.push(json!({"nanos":elapsed,"stages":stages}));
        }
        println!("COIN_PROFILE:{}",json!({"index":index,"method":method,
            "assetInputs":parsed_input["snapshot"]["payload"]["utxos"].as_array().map(|a|a.iter().filter(|u|u["classification"]=="stablecoin").count()),
            "nativeInputs":parsed_input["snapshot"]["payload"]["utxos"].as_array().map(|a|a.iter().filter(|u|u["classification"]=="native").count()),
            "samples":samples}));
    }
}
