//! Math/config preparation only: these tests do not prove new covenant support.
use serde_json::{json,Value};
use tbc_engine_core::protocols::{amm_fee_policy::FeePolicy,amm_math::{self,State,AddBudget}};
const ADDRESS:&str="13oCEJaqyyiC8iRrfup6PDL2GKZ3xQrsZL";

#[test]
fn custom_config_validates_boundaries_and_canonical_address(){
    for (total,lp) in [(0,0),(600,0),(600,600),(600,300),(35,25)]{
        let input=json!({"totalFeeBps":total,"lpFeeBps":lp,"serviceFeeAddress":ADDRESS});
        let p:FeePolicy=serde_json::from_value(input.clone()).unwrap();assert_eq!(serde_json::to_value(&p).unwrap(),input);
        assert_eq!(p.service_fee_bps(),total-lp);assert_eq!(p.service_fee_address(),ADDRESS);
    }
    for (field,value) in [("totalFeeBps",json!(601)),("totalFeeBps",json!(-1)),("totalFeeBps",json!(1.5)),("totalFeeBps",json!("35")),
        ("lpFeeBps",json!(36)),("lpFeeBps",json!(-1)),("lpFeeBps",json!(0.1)),("serviceFeeAddress",json!("invalid")),
        ("serviceFeeAddress",json!(format!(" {ADDRESS}"))),("serviceFeeAddress",json!("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy")),("lpPlan",json!(1))]{
        let mut input=json!({"totalFeeBps":35,"lpFeeBps":25,"serviceFeeAddress":ADDRESS});input[field]=value;
        assert!(serde_json::from_value::<FeePolicy>(input).is_err(),"{field}");
    }
    assert!(FeePolicy::new(0,0,"bad").is_err());
    assert!(serde_json::from_value::<FeePolicy>(json!({"totalFeeBps":0,"lpFeeBps":0})).is_err());
}

#[test]
fn six_preset_data_and_small_amount_rounding_keep_original_math(){
    let fixture:Value=serde_json::from_str(include_str!("../../../fixtures/amm-math.json")).unwrap();
    assert_eq!(fixture["policies"].as_array().unwrap().len(),6);
    for row in fixture["policies"].as_array().unwrap(){
        let n=|key:&str|row[key].as_u64().unwrap_or_else(||row[key].as_str().unwrap().parse().unwrap()) as u16;
        let p=FeePolicy::new(n("totalFeeBps"),n("lpFeeBps"),row["serviceFeeAddress"].as_str().unwrap()).unwrap();
        let old=amm_math::fee_policy(n("lpPlan")as u8,None).unwrap();
        assert_eq!((p.total_fee_bps(),p.lp_fee_bps(),p.service_fee_address()),(old.total_fee_bps,old.lp_fee_bps,old.service_fee_address));
        for base in (0..=3000).chain([9999,10000,10001,1_000_000_000]){
            let f=p.calculate(base).unwrap();assert_eq!(f,amm_math::calculate_fees(base,old.lp_plan,None).unwrap());
            assert_eq!(f.service_fee_accrued_sat,base*u64::from(p.total_fee_bps())/10000-base*u64::from(p.lp_fee_bps())/10000);
            assert_eq!(f.service_fee_paid_sat,if f.service_fee_accrued_sat>=10{f.service_fee_accrued_sat}else{0});
            assert_eq!(base,f.net_amount_sat+f.pool_fee_retained_sat+f.service_fee_paid_sat);
        }
        let state=State{ft_lp_amount:1_000_000,ft_a_amount:1_000_000,tbc_amount:1_000_000,pool_value:1_001_500};
        assert_eq!(amm_math::quote_buy_with_fee_policy(state,10000,&p,1).unwrap(),amm_math::quote_buy(state,10000,old.lp_plan,None,1).unwrap());
        assert_eq!(amm_math::quote_sell_with_fee_policy(state,10000,&p,1).unwrap(),amm_math::quote_sell(state,10000,old.lp_plan,None,1).unwrap());
    }
    // floor(total)-floor(LP) differs from floor(total-LP) for this small amount.
    let p=FeePolicy::new(35,25,ADDRESS).unwrap();assert_eq!(p.calculate(286).unwrap().service_fee_accrued_sat,1);
    assert_eq!(286*(35-25)/10000,0);
}

#[test]
fn zero_fees_and_full_service_or_lp_shares_allow_quote_lifecycle(){
    for(total,lp)in[(0,0),(600,0),(600,600),(600,300),(1,0),(1,1)]{
        let p=FeePolicy::new(total,lp,ADDRESS).unwrap();
        let initial=State{ft_lp_amount:0,ft_a_amount:0,tbc_amount:0,pool_value:1500};
        let add=amm_math::quote_add(initial,AddBudget::Tbc{amount:1_000_000,first_ft:Some(1_000_000)}).unwrap();
        let buy=amm_math::quote_buy_with_fee_policy(add.next_state,10000,&p,1).unwrap();
        let sell=amm_math::quote_sell_with_fee_policy(buy.next_state,buy.ft_out_raw,&p,1).unwrap();
        let remove=amm_math::quote_remove(sell.next_state,sell.next_state.ft_lp_amount).unwrap();
        assert_eq!(remove.next_state,initial);
        if lp==total{assert_eq!(buy.fees.service_fee_paid_sat,0);assert_eq!(sell.fees.service_fee_paid_sat,0);}
        if lp==0{assert_eq!(buy.fees.lp_fee_sat,0);assert_eq!(sell.fees.lp_fee_sat,0);}
        if total==0{assert_eq!(buy.effective_tbc_increment_sat,buy.pool_value_increment_sat);assert_eq!(sell.pool_value_decrement_sat,sell.gross_tbc_out_sat);}
    }
}
