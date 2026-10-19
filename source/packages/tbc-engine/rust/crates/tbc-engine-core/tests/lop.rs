use tbc_engine_core::protocols::{lop::*,tbc20};
fn hex(b:&[u8])->String {b.iter().map(|v|format!("{v:02x}")).collect()}
fn code(side:Side,market:Market)->Code {
    Code{side,market,tax_hash:[0x22;20],terms:Terms{owner_hash:[0x11;20],sale_volume:1_234_567,
        fee_rate:100,unit_price:2_300_000,asset_a:AssetTerms{partial_hash:[0x33;32],contract_id:[0x44;32]},
        asset_b:matches!(market,Market::TokenToken{..}).then_some(AssetTerms{partial_hash:[0x55;32],contract_id:[0x66;32]})}}
}
fn markets()->Vec<Market>{
    let size=tbc20::instantiate_code(&tbc20::CodeDescriptor{original_outpoint:[0;36],tape_size:61,controller:[0;21]}).unwrap().len() as u16;
    let mut all=vec![Market::NativeToken{token_code_bytes:1884,marker:TapeMarker::Legacy},
        Market::NativeToken{token_code_bytes:2012,marker:TapeMarker::Legacy},
        Market::NativeToken{token_code_bytes:size,marker:TapeMarker::Modern},
        Market::NativeToken{token_code_bytes:2981,marker:TapeMarker::Modern}];
    for a in [TapeMarker::Legacy,TapeMarker::Modern]{for b in [TapeMarker::Legacy,TapeMarker::Modern]{all.push(Market::TokenToken{a,b});}}
    all
}
#[test]
fn pinned_lop_roundtrip_and_continuations(){
    for market in markets(){for side in [Side::Sell,Side::Buy]{
        let code=code(side,market);let bytes=code.encode().unwrap();
        assert_eq!(Code::decode(&bytes).unwrap(),code);code.terms.validate_new_order().unwrap();
        if matches!(market,Market::TokenToken{..}){assert_eq!(bytes.len(),TOKEN_CODE_BYTES);}
        let next=code.with_sale_volume(1);assert_eq!(next.terms.asset_a,code.terms.asset_a);assert_eq!(next.terms.asset_b,code.terms.asset_b);
        assert_eq!(Code::decode(&next.encode().unwrap()).unwrap(),next);assert_ne!(next.token_controller().unwrap(),code.token_controller().unwrap());
        if std::env::var("LOP_DUMP_WIRE").as_deref()==Ok("1"){
            let (pair,token_bytes,a_modern,b_modern)=match market{
                Market::NativeToken{token_code_bytes,marker}=>(false,token_code_bytes,marker==TapeMarker::Modern,false),
                Market::TokenToken{a,b}=>(true,0,a==TapeMarker::Modern,b==TapeMarker::Modern)};
            println!("LOP_WIRE:{}",serde_json::json!({"pair":pair,"sell":side==Side::Sell,"tokenBytes":token_bytes,"aModern":a_modern,"bModern":b_modern,
                "owner":hex(&code.terms.owner_hash),"tax":hex(&code.tax_hash),"volume":code.terms.sale_volume.to_string(),
                "fee":code.terms.fee_rate.to_string(),"price":code.terms.unit_price.to_string(),"aHash":hex(&code.terms.asset_a.partial_hash),
                "aId":hex(&code.terms.asset_a.contract_id),"bHash":code.terms.asset_b.as_ref().map(|a|hex(&a.partial_hash)),
                "bId":code.terms.asset_b.as_ref().map(|a|hex(&a.contract_id)),"script":hex(&bytes),"continuation":hex(&next.encode().unwrap()),
                "controller":hex(&code.token_controller().unwrap())}));
        }
    }}
}
#[test]
fn exact_lop_templates_bind_repeated_owner_tax_marker_and_pushes(){
    for market in markets(){for side in [Side::Sell,Side::Buy]{
        let code=code(side,market);let raw=code.encode().unwrap();let data=if code.terms.asset_b.is_some(){TOKEN_DATA_BYTES}else{NATIVE_DATA_BYTES};
        for at in [0,1,10,raw.len()-data,raw.len()-data+1,raw.len()-data+21]{
            let mut wrong=raw.clone();wrong[at]^=1;assert!(Code::decode(&wrong).is_err(),"offset {at}");
        }
        let mut wrong=raw.clone();let tax=wrong.windows(20).position(|b|b==code.tax_hash).unwrap();wrong[tax]^=1;
        assert!(Code::decode(&wrong).is_err(),"fee recipient copies must match");
        let mut extra=raw.clone();extra.push(0);assert!(Code::decode(&extra).is_err());
        assert!(Code::decode(&raw[..raw.len()-1]).is_err());
        if let Market::TokenToken{..}=market{
            let mut wrong=code.clone();wrong.terms.asset_b=None;assert!(wrong.encode().is_err());
        }else{let mut wrong=code.clone();wrong.terms.asset_b=Some(code.terms.asset_a.clone());assert!(wrong.encode().is_err());}
    }}
}
#[test]
fn codec_preserves_wire_terms_but_builders_must_validate_signed_numeric_domain(){
    let baseline=code(Side::Sell,Market::TokenToken{a:TapeMarker::Modern,b:TapeMarker::Modern});
    for amount in [0,1,i64::MAX as u64,i64::MAX as u64+1,u64::MAX]{
        let changed=baseline.with_sale_volume(amount);assert_eq!(Code::decode(&changed.encode().unwrap()).unwrap(),changed);
        assert_eq!(changed.terms.validate_new_order().is_ok(),amount>0&&amount<=i64::MAX as u64);
    }
    for field in ["fee","price"]{let mut changed=baseline.clone();if field=="fee"{changed.terms.fee_rate=u64::MAX;}else{changed.terms.unit_price=0;}
        assert!(changed.terms.validate_new_order().is_err());}
}
