use tbc_engine_core::protocols::{lop::{Code,Terms,AssetTerms,Market,Side,TapeMarker},lop_settlement::{quote_match,validate_match_receivers}};
fn orders(native:bool)->(Code,Code){
    let b=Code{side:Side::Buy,market:if native{Market::NativeToken{token_code_bytes:2981,marker:TapeMarker::Modern}}else{Market::TokenToken{a:TapeMarker::Modern,b:TapeMarker::Modern}},
        tax_hash:[3;20],terms:Terms{owner_hash:[1;20],sale_volume:300,unit_price:1_100_000,fee_rate:100_000,
            asset_a:AssetTerms{partial_hash:[4;32],contract_id:[5;32]},asset_b:(!native).then_some(AssetTerms{partial_hash:[6;32],contract_id:[7;32]})}};
    let mut s=b.clone();s.side=Side::Sell;s.terms.owner_hash=[2;20];s.terms.sale_volume=200;(b,s)
}
#[test]
fn integer_settlement_and_continuation_preserve_terms(){
    for native in[false,true]{
        let(b,s)=orders(native);let q=quote_match(&b,&s,200,330).unwrap();
        assert_eq!((q.matched_a,q.a_to_buyer,q.a_tax,q.paid_b,q.b_to_seller,q.b_tax),(200,180,20,220,198,22));
        assert_eq!((q.sell_remaining,q.buy_remaining,q.a_escrow_change,q.b_escrow_change),(0,100,0,110));
        let next=q.continuation(&b,&s).unwrap().unwrap();assert_eq!(next,b.with_sale_volume(100));
        assert_eq!(Code::decode(&next.encode().unwrap()).unwrap(),next);
        let mut b=b;b.terms.sale_volume=100;let q=quote_match(&b,&s,200,110).unwrap();
        assert_eq!(q.continuation(&b,&s).unwrap(),Some(s.with_sale_volume(100)));
        b.terms.sale_volume=200;assert!(quote_match(&b,&s,200,220).unwrap().continuation(&b,&s).unwrap().is_none());
    }
}
#[test]
fn match_rejects_different_committed_fee_recipients_before_signing(){
    for native in [false,true] { for zero_fee in [false,true] {
        let(mut b,mut s)=orders(native);s.tax_hash=[8;20];
        if zero_fee {b.terms.fee_rate=0;s.terms.fee_rate=0;}
        assert!(quote_match(&b,&s,200,330).unwrap_err().0.contains("fee recipients must match"));
    }}
}
#[test]
fn settlement_rejects_roles_assets_amounts_and_dust_without_silent_rounding(){
    let(b,s)=orders(false);
    assert!(validate_match_receivers(&b,&s,[4;20],[3;20],[3;20]).is_ok());
    for owner in[b.terms.owner_hash,s.terms.owner_hash]{assert!(validate_match_receivers(&b,&s,owner,[3;20],[3;20]).is_err());}
    assert!(validate_match_receivers(&b,&s,[4;20],[5;20],[3;20]).is_err());
    assert!(validate_match_receivers(&b,&s,[4;20],[3;20],[5;20]).is_err());
    let mut wrong=b.clone();wrong.terms.owner_hash=s.terms.owner_hash;
    assert!(quote_match(&wrong,&s,200,330).unwrap_err().0.contains("owners must differ"));
    let mut wrong=b.clone();wrong.terms.asset_a.contract_id[0]^=1;assert!(quote_match(&wrong,&s,200,330).is_err());
    let mut wrong=b.clone();wrong.terms.unit_price+=1;assert!(quote_match(&wrong,&s,200,330).is_err());
    assert!(quote_match(&s,&b,200,330).is_err());assert!(quote_match(&b,&s,199,330).is_err());
    assert!(quote_match(&b,&s,200,219).is_err());assert!(quote_match(&b,&s,u64::MAX,330).is_err());
    let mut wrong=b.clone();wrong.terms.fee_rate=1_000_000;assert!(quote_match(&wrong,&s,200,330).is_err());
    let(mut b,mut s)=orders(true);b.terms.fee_rate=1;assert!(quote_match(&b,&s,200,330).is_err());
    b.terms.fee_rate=0;assert!(quote_match(&b,&s,200,330).unwrap().native_zero_tax_placeholder);
    assert!(quote_match(&b,&s,201,330).is_err());
    b.terms.unit_price=1;s.terms.unit_price=1;assert!(quote_match(&b,&s,200,330).is_err());
}
#[test]
fn partial_fill_retains_actual_rounding_residue_and_never_discards_assets(){
    let(mut b,mut s)=orders(false);b.terms.fee_rate=0;s.terms.fee_rate=0;
    b.terms.unit_price=1_500_000;s.terms.unit_price=1_500_000;b.terms.sale_volume=3;s.terms.sale_volume=1;
    // After the second one-unit fill retained escrow is 2, not floor(1*1.5)=1.
    let first=quote_match(&b,&s,1,4).unwrap();assert_eq!(first.b_escrow_change,3);
    b=first.continuation(&b,&s).unwrap().unwrap();let second=quote_match(&b,&s,1,3).unwrap();assert_eq!(second.b_escrow_change,2);
    b=second.continuation(&b,&s).unwrap().unwrap();let last=quote_match(&b,&s,1,2).unwrap();assert_eq!(last.b_escrow_change,1);
    assert!(last.require_conserving_layout().is_err());assert!(last.continuation(&b,&s).is_err());
    // Overfunding an exhausted sell also cannot silently become matcher income.
    assert!(quote_match(&b,&s,2,1).unwrap().require_conserving_layout().is_err());
}
#[test]
fn native_buy_continuation_rejects_non_distributive_rounding_without_losing_quote(){
    let(mut b,mut s)=orders(true);b.terms.fee_rate=0;s.terms.fee_rate=0;
    b.terms.unit_price=1_500_000;s.terms.unit_price=1_500_000;b.terms.sale_volume=303;s.terms.sale_volume=101;
    let first=quote_match(&b,&s,101,454).unwrap();assert_eq!(first.b_escrow_change,303);
    b=first.continuation(&b,&s).unwrap().unwrap();
    let second=quote_match(&b,&s,101,303).unwrap();assert_eq!(second.b_escrow_change,152);
    assert!(second.continuation(&b,&s).unwrap_err().0.contains("native buy continuation"));
    // A compatible fill exhausts this remaining order without dropping value.
    s.terms.sale_volume=202;let rest=quote_match(&b,&s,202,303).unwrap();
    assert_eq!(rest.b_escrow_change,0);assert!(rest.continuation(&b,&s).unwrap().is_none());
}
