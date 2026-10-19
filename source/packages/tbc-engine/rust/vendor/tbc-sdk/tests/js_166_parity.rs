use serde_json::Value;

#[test]
fn js_166_fixture_contains_every_required_family() {
    let value: Value = serde_json::from_str(include_str!("fixtures/js-166/scripts.json")).unwrap();
    for key in [
        "ftV4Mint",
        "stableCoinV4Mint",
        "nftV2Code",
        "nftV1Code",
        "poolPlan6V4",
        "ftlpV4",
        "sellOrderV4",
        "buyOrderV4",
        "tbc20Code",
        "tbc20Tape",
    ] {
        assert!(value.get(key).is_some(), "missing {key}");
    }

    let tbc20: Value = serde_json::from_str(include_str!("fixtures/js-166/tbc20.json")).unwrap();
    assert_eq!(tbc20["codeBytes"], 2_396);
    assert_eq!(tbc20["partialOffset"], 2_368);

    let validator: Value =
        serde_json::from_str(include_str!("fixtures/js-166/validator.json")).unwrap();
    for key in [
        "invalidPolicy",
        "invalidRoot",
        "validTransfer",
        "validMerge",
    ] {
        assert!(
            validator.get(key).is_some(),
            "missing validator fixture {key}"
        );
    }
}
