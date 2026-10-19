mod asset_ancestry;
mod pool_nft;
mod token_receipt;
mod token_material;
mod issuance_policy;
mod reviewed;
mod amm_material;
mod lop_material;
mod multisig;

pub const OPERATIONS: &[&str] = &[
    "preparePoolNft",
    "prepareAssetAncestry",
    "legacyPoolPreview",
    "inspectTokenReceipt",
    "inspectNftReceipt",
    "prepareReviewedStage",
    "finalizeReviewedStage",
    "inspectAmmMaterial",
    "inspectLopMaterial",
    "inspectTokenMaterial",
    "describeMultisig",
    "decodeMultisigAddress",
    "prepareMultisig",
    "inspectMultisig",
    "verifyMultisigSignatures",
    "finalizeMultisig",
];

pub fn call(operation: &str, request: &str) -> Result<String, String> {
    match operation {
        "preparePoolNft" => pool_nft::prepare_pool_nft_json(request),
        "prepareAssetAncestry" => asset_ancestry::prepare_asset_ancestry_json(request),
        "legacyPoolPreview" => pool_nft::legacy_pool_preview_json(request),
        "inspectTokenReceipt" => token_receipt::inspect_token_receipt_json(request),
        "inspectNftReceipt" => token_receipt::inspect_nft_receipt_json(request),
        "prepareReviewedStage" => reviewed::prepare(request),
        "finalizeReviewedStage" => reviewed::finalize(request),
        "inspectAmmMaterial" => amm_material::inspect(request),
        "inspectLopMaterial" => lop_material::inspect(request),
        "inspectTokenMaterial" => token_material::inspect(request),
        "describeMultisig" => multisig::describe(request),
        "decodeMultisigAddress" => multisig::decode_address(request),
        "prepareMultisig" => multisig::prepare(request),
        "inspectMultisig" => multisig::inspect(request),
        "verifyMultisigSignatures" => multisig::combine(request, false),
        "finalizeMultisig" => multisig::combine(request, true),
        _ => Err("KEYLESS_OPERATION_UNAVAILABLE".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    #[test]
    fn publishes_only_keyless_operations() {
        assert_eq!(
            OPERATIONS,
            [
                "preparePoolNft",
                "prepareAssetAncestry",
                "legacyPoolPreview",
                "inspectTokenReceipt",
                "inspectNftReceipt",
                "prepareReviewedStage",
                "finalizeReviewedStage",
                "inspectAmmMaterial",
                "inspectLopMaterial",
                "inspectTokenMaterial",
                "describeMultisig", "decodeMultisigAddress", "prepareMultisig", "inspectMultisig",
                "verifyMultisigSignatures", "finalizeMultisig"
            ]
        );
        assert_eq!(call("sign", "{}").unwrap_err(), "KEYLESS_OPERATION_UNAVAILABLE");
    }

    #[test]
    fn legacy_preview_matches_the_mobile_reference_vector() {
        let response: Value = serde_json::from_str(
            &call(
                "legacyPoolPreview",
                &json!({
                    "operation": "increaseLp",
                    "ftContractId": "22".repeat(32),
                    "ftDecimal": 6,
                    "amount": "0.001",
                    "lockTime": 0,
                    "pool": {
                        "ftLpRaw": "10000",
                        "ftARaw": "5000",
                        "tbcSat": "10000",
                        "poolValueSat": "11000",
                        "publicKeyLocked": false
                    }
                })
                .to_string(),
            )
            .expect("keyless preview"),
        )
        .expect("preview JSON");
        assert_eq!(response["ftRequiredRaw"], "500");
        assert_eq!(response["ftlpMintedRaw"], "1000");
        assert_eq!(response["after"]["poolValueSat"], "12000");
    }
}
