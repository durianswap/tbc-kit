export const SOURCE_COMMIT = "923497e8b2473c0e179fa0b86dbb32a2f188d25a";
export const SOURCE_REPOSITORY = "git@github.com:LoongYearMeta/turing-wallet.git";
export const SOURCE_SUBTREE = "modules/tbc-transaction-engine/rust/vendor/tbc-sdk";
export const SDK_NAME = "tbc-sdk";
export const SDK_VERSION = "0.3.0";
export const SDK_LICENSE = "MIT";
export const SDK_REPOSITORY = "https://github.com/LoongYearMeta/tbc-rust-sdk";
export const SDK_LICENSE_SHA256 = "2b60aa93bf43a4f9a7c0b356f4003679dffe6e89f86570376a343fbdfd52a191";

function source(path, sha256, sourceFunctions, targetFunctions, verification) {
  const mapping = {
    repository: SOURCE_REPOSITORY,
    commit: SOURCE_COMMIT,
    path,
    sha256,
    sourceFunctions,
    targetFunctions,
  };
  if (verification !== undefined) mapping.verification = verification;
  return mapping;
}

export const APPROVED_SOURCE_MAP = [
  {
    target: "packages/tbc-engine/rust/crates/tbc-engine-core/src/families/tbc.rs",
    status: "implemented",
    sources: [
      source(
        "modules/tbc-transaction-engine/rust/src/lib.rs",
        "7ccce0b22cd43094b215d3a046b85ab62e1bb02a600300a6e10846ab47fda4d1",
        ["build_tbc_transaction_json", "plan_asset_funding"],
        ["plan_tbc_transfer", "validate_tbc_transfer"],
      ),
    ],
  },
  {
    target: "packages/tbc-engine/rust/crates/tbc-engine-core/src/families/ft.rs",
    status: "implemented",
    sources: [
      source(
        "hooks/use-ft-transaction.tsx",
        "38181962d1df9b5cd5bc0b95f1bbffee2b126c2ce55ee809db0aaace745c13e3",
        ["buildNativeAssetTransfer"],
        ["plan_transfer"],
      ),
      source(
        "lib/tbc-engine/operations.ts",
        "5b8beb3a3be5794dcff8c6eb43fe961dd69ab4bc69d50658516dae4b40db1aec",
        ["planAssetMergeFunding", "buildMerge", "planFtTransferFunding", "buildFtTransfer"],
        ["plan_transfer", "build_transfer_with_funding"],
      ),
      source(
        "lib/tbc-engine/tbc-selection.ts",
        "d609cdeb91bb47db8a5d785003720159ce641223bb2b337044152cb2ace6c0a1",
        ["selectOptimalUtxoValues"],
        ["plan_transfer"],
      ),
      source(
        "lib/tbc-engine/native-asset-send-limit.ts",
        "a335c383bb580370d298259a4a9e0c14296674daf7b5b2911dae780612c9ab11",
        ["planNativeAssetSendLimit"],
        ["plan_transfer"],
      ),
      source(
        "lib/tbc-engine/tbc-fragment-cleanup.ts",
        "39350cf57e1142a8d0c642a5acf45914c39f0557a78b3f164adbb0fd7735f8dc",
        ["resolveOperationTbcFunding", "consolidateTbcFundingCandidates"],
        ["build_transfer_with_funding"],
      ),
      source(
        "lib/tbc-engine/asset-merge.ts",
        "6f207abfd90752295ae83e33fb5c594e8e75aad12f9f27cda19fce25b29406f4",
        ["executeAssetMergeDag"],
        ["build_transfer_with_funding"],
      ),
      source(
        "lib/tbc-engine/merge-dag.ts",
        "95e0024a6c30d7e09ce4ce477112074a07543435a00cb0a940b659e8be1dcd77",
        ["planMergeDag"],
        ["build_transfer_with_funding"],
      ),
      source(
        "lib/tbc-engine/merge-executor.ts",
        "9cbf7ecc58a5ef5123783dd296ff505d69badc2e31593a7334ef81a34206c983",
        ["executeMergeDag"],
        ["build_transfer_with_funding"],
      ),
      source(
        "lib/tbc-engine/funding-plan.ts",
        "ea1b0bcd97c28a8baf463981dd37fb6bc2baceba2702ed01ad46d6c7b19709af",
        ["requestFundingPlan"],
        ["build_transfer_with_funding"],
      ),
      source(
        "lib/tbc-engine/payloads.ts",
        "7cd09ee4e40d58f8ea97d0650b39f809e87855a7c9b1a291fd7baebdbd494e91",
        ["assetInfoPayload", "assetUtxoPayload", "feeUtxoPayload"],
        ["plan_transfer", "build_transfer_with_funding"],
      ),
      source(
        "modules/tbc-transaction-engine/rust/src/lib.rs",
        "7ccce0b22cd43094b215d3a046b85ab62e1bb02a600300a6e10846ab47fda4d1",
        ["build_ft_transaction_json", "build_merge_batch_json"],
        ["plan_ft"],
      ),
      source(
        "modules/tbc-transaction-engine/rust/vendor/tbc-sdk/src/contracts/ft/builder.rs",
        "23d9aaa831ad8df39434b5d2ffd93a8df6ca4d1b7104f94392ac4059704fd88c",
        ["mint_ft_with_version", "transfer", "batch_transfer", "merge_ft"],
        ["plan_create", "plan_transfer", "build_transfer_with_funding"],
      ),
      source(
        "modules/tbc-transaction-engine/rust/src/asset_ancestry.rs",
        "a0348cc3b766fc169cbf87f35cf7d10f6889108e6e22dff7905c77b680e3cb6c",
        ["prepare_asset_ancestry_json"],
        ["plan_ft"],
      ),
      source(
        "modules/tbc-transaction-engine/rust/src/funding.rs",
        "21cbac4f4e421ae259b78d9a0297b2be6f422b1355b4f5092948671014b2b91a",
        ["required_funding", "signed_transaction_headroom"],
        ["plan_ft"],
      ),
    ],
  },
  {
    target: "packages/tbc-engine/rust/crates/tbc-engine-core/src/ancestry.rs",
    status: "implemented",
    sources: [
      source(
        "modules/tbc-transaction-engine/rust/vendor/tbc-sdk/src/contracts/ft/scripts.rs",
        "8a2b33ac367148a56327eb18ada58afd0e82581afb1d2a53d0765e5c1ff557ee",
        ["mint_code_script_with_version", "mint_source_script", "transfer_code_script"],
        ["authenticate_v4_genesis", "validate_owner"],
      ),
      source(
        "modules/tbc-transaction-engine/rust/src/asset_ancestry.rs",
        "a0348cc3b766fc169cbf87f35cf7d10f6889108e6e22dff7905c77b680e3cb6c",
        ["prepare_asset_ancestry_json"],
        ["prepare_asset_ancestry"],
      ),
      source(
        "modules/tbc-transaction-engine/rust/vendor/tbc-sdk/src/contracts/stable_coin/builder.rs",
        "2af932e784bb34c70b8f252df4091ced4478c27adf83894c0f05b67c08b904f9",
        ["mint_coin_with_version", "transfer", "merge_coin"],
        ["prepare_stablecoin_ancestry", "authenticate_stablecoin_mint_lineage", "validate_stablecoin_mint_transition", "expected_stablecoin_mint_tape", "validate_stablecoin_mint_suffix", "authenticate_stablecoin_holding_lineage"],
      ),
      source(
        "modules/tbc-transaction-engine/rust/vendor/tbc-sdk/src/contracts/stable_coin/scripts.rs",
        "b9cd97c0a90ccf30ff45a5b2c85137870cfb5e6302cc1f5f01ed2b2065af1353",
        ["amount_slot", "coin_tape_script", "get_lock_time_from_tape", "coin_mint_code_script_with_version", "decode_coin_nft_tape_script", "coin_nft_code_script", "coin_nft_hold_script_from_hash"],
        ["authenticate_stablecoin_genesis", "authenticate_stablecoin_mint_lineage", "validate_stablecoin_mint_transition", "expected_stablecoin_mint_tape", "validate_stablecoin_mint_suffix", "authenticate_stablecoin_holding_lineage", "parse_tape"],
      ),
    ],
  },
  {
    target: "packages/tbc-engine/rust/crates/tbc-engine-core/src/funding.rs",
    status: "implemented",
    sources: [
      source(
        "modules/tbc-transaction-engine/rust/src/funding.rs",
        "21cbac4f4e421ae259b78d9a0297b2be6f422b1355b4f5092948671014b2b91a",
        [
          "conservative_chain_fee",
          "conservative_transaction_fee",
          "plan_funding_json",
          "required_funding",
          "signed_transaction_headroom",
        ],
        [
          "conservative_chain_fee",
          "conservative_transaction_fee",
          "required_funding",
          "signed_transaction_headroom",
        ],
      ),
    ],
  },
  {
    target: "packages/tbc-engine/rust/crates/tbc-engine-core/src/families/nft.rs",
    status: "implemented",
    sources: [
      source(
        "modules/tbc-transaction-engine/rust/src/nft.rs",
        "a5e4626cd8774be507b7d862e0b683a685fb220b4b023248ed902c3aaa302699",
        ["build_nft_transaction_json", "plan_nft_funding", "build_legacy_transfer", "legacy_code_script"],
        ["plan_nft", "plan_collection_create", "plan_nft_mint", "plan_nft_transfer", "legacy_code_script", "validate_collection_origin", "authenticate_nft_lineage", "code_origin"],
      ),
      source(
        "modules/tbc-transaction-engine/rust/vendor/tbc-sdk/src/contracts/nft/builder.rs",
        "634064698566eac1b2495587a56b99945cb3f7bbe1f81b6fd33bee0abfa2fd81",
        ["create_collection", "create_nft", "create_nft_with_version", "transfer_nft"],
        ["plan_collection_create", "plan_nft_mint", "plan_nft_transfer", "build_single_nft_plan"],
      ),
      source(
        "modules/tbc-transaction-engine/rust/vendor/tbc-sdk/src/contracts/nft/scripts.rs",
        "5cc9e016bad4dcc71a542ecabb1c9ea9d8d0837f2057a6a3a04d5db4d777dea1",
        ["tape_script", "mint_script", "hold_script", "code_script", "code_script_v1", "nft_version"],
        ["plan_collection_create", "plan_nft_mint", "plan_nft_transfer", "validate_collection_origin", "code_origin"],
      ),
    ],
  },
  {
    target: "packages/tbc-engine/rust/crates/tbc-engine-core/src/families/stablecoin.rs",
    status: "implemented",
    sources: [
      source(
        "modules/tbc-transaction-engine/rust/src/lib.rs",
        "7ccce0b22cd43094b215d3a046b85ab62e1bb02a600300a6e10846ab47fda4d1",
        ["build_merge_batch_json", "build_stablecoin_transaction_json"],
        ["plan_stablecoin_transfer"],
      ),
      source(
        "modules/tbc-transaction-engine/rust/vendor/tbc-sdk/src/contracts/stable_coin/builder.rs",
        "2af932e784bb34c70b8f252df4091ced4478c27adf83894c0f05b67c08b904f9",
        ["transfer", "merge_coin"],
        ["plan_stablecoin_transfer"],
      ),
    ],
  },
  {
    target: "packages/tbc-engine/rust/crates/tbc-engine-core/src/families/pool.rs",
    status: "implemented",
    sources: [
      source(
        "modules/tbc-transaction-engine/rust/src/lib.rs",
        "7ccce0b22cd43094b215d3a046b85ab62e1bb02a600300a6e10846ab47fda4d1",
        ["build_merge_batch_json"],
        ["plan_pool"],
      ),
      source(
        "modules/tbc-transaction-engine/rust/vendor/tbc-sdk/src/contracts/pool_nft_v2/builder.rs",
        "cde898cc395ecc2d08fdf009d1a6c0e5924cb17d21be5a9afe8aacc2de4e6ab2",
        [
          "PoolNftBuilder::init_pool", "PoolNftBuilder::increase_lp_to",
          "PoolNftBuilder::consume_lp_to", "PoolNftBuilder::swap_to_token_to",
          "PoolNftBuilder::swap_to_tbc_to", "PoolNftBuilder::merge_ftlp",
          "PoolNftBuilder::merge_ft_in_pool", "PoolNftBuilder::create_pool_inner",
          "select_ftlp_inputs", "build_standalone_ftlp_tx", "build_merge_pool_ft_round",
          "validate_operation_context", "validate_pool_ft_spend", "validate_ftlp_spend",
          "validate_underlying_ft_binding", "validate_create_common",
          "service_fee_script", "pool_mint_source_script",
        ],
        [
          "plan_pool", "plan_create", "plan_add", "plan_consume", "plan_swap_tbc",
          "plan_swap_ft", "plan_pool_ft_inputs", "select_pool_ft", "pool_ft_candidates",
          "ftlp_candidates", "select_ftlp", "plan_ftlp_input", "build_pool_ft_maintenance",
          "build_ftlp_maintenance", "build_planned_transaction_with_policy",
          "authenticate_pool_asset_candidate", "authenticate_ft_family",
          "ftlp_candidate_eligible", "pool_recipe_after_maintenance_chain",
          "pool_ft_recipe_after_maintenance_chain", "pool_policy", "validate_lock",
          "service_fee_script", "is_pool_source_script",
        ],
      ),
      source(
        "modules/tbc-transaction-engine/rust/vendor/tbc-sdk/src/contracts/pool_nft_v2/math.rs",
        "b89618872f3b0cca4d675c322d70ed1d5f58c509645b5401666626921be60f48",
        ["initial_lp_raw", "increase_lp", "consume_lp", "swap_tbc_to_ft", "swap_ft_to_tbc", "pool_reserve"],
        ["plan_create", "plan_add", "plan_consume", "plan_swap_tbc", "plan_swap_ft"],
      ),
      source(
        "modules/tbc-transaction-engine/rust/vendor/tbc-sdk/src/contracts/pool_nft_v2/scripts.rs",
        "bf4b230385df02fb7ba372dbda9bb7947b16307389fafb836655a158c98a3be0",
        [
          "pool_code", "locked_pool_code", "pool_code_source_outpoint", "pool_tape",
          "pool_held_ft_code", "ftlp_code", "ftlp_lock_time_code",
          "transfer_ftlp_code_script", "ftlp_tape",
        ],
        [
          "plan_create", "plan_add", "plan_consume", "plan_swap_tbc", "plan_swap_ft",
          "build_pool_ft_maintenance", "build_ftlp_maintenance", "live_pool",
        ],
      ),
      source(
        "modules/tbc-transaction-engine/rust/vendor/tbc-sdk/src/contracts/ft/amount.rs",
        "6709fb8c633ccfaaed6d26202398f197d5c711af4db4a59ae60c51411b9bfd0a",
        ["build_tape_amount_with_offset", "encode_slots", "u64_slot"],
        ["build_tape_amount_with_offset", "encode_amount_slots", "amount_slot"],
      ),
    ],
  },
  {
    target: "packages/tbc-engine/rust/crates/tbc-engine-core/src/signing.rs",
    status: "implemented",
    engineSpecificFunctions: [
      "ftlp_maintenance_round",
      "resolve_source_for_plan_validation",
      "ft_script_version",
      "validate_final_pool_consumes",
      "final_ftlp_successor_id",
      "planned_source_identity_and_output",
      "validate_ftlp_recipe_order",
    ],
    sources: [
      source(
        "modules/tbc-transaction-engine/rust/vendor/tbc-sdk/src/address.rs",
        "9cca41d2cee89a2e81ffe40b6b70ba4836acbbb20a2db75e822b539cddb5d2cf",
        ["Address::from_hash160"],
        ["authenticate_released_ftlp_code"],
        "authenticated-vendor",
      ),
      source(
        "modules/tbc-transaction-engine/rust/vendor/tbc-sdk/src/hash.rs",
        "9cb77bfe1b1e7e989d0da551bbc9ae15bf64602e48eecf1274af58014bf3b90b",
        ["sha256", "hash160"],
        ["pool_authority_binding"],
        "authenticated-vendor",
      ),
      source(
        "modules/tbc-transaction-engine/rust/vendor/tbc-sdk/src/keys.rs",
        "8a83d0a2b91af012ce2e947691e5709336df1741039c539e88516cece1893be8",
        ["PublicKey::hash160"],
        ["authenticate_released_ftlp_code", "validate_ftlp_maintenance_topology"],
        "authenticated-vendor",
      ),
      source(
        "modules/tbc-transaction-engine/rust/vendor/tbc-sdk/src/script.rs",
        "f094e63955c1566b9834ed2ef43a29d5dbc1c4f3140e6d98407f93c7268c04ed",
        ["Script::as_bytes", "Script::p2pkh", "Script::sha256"],
        [
          "pool_authority_binding", "authenticate_released_ftlp_code",
          "validate_ftlp_maintenance_topology",
        ],
        "authenticated-vendor",
      ),
      source(
        "modules/tbc-transaction-engine/rust/vendor/tbc-sdk/src/transaction.rs",
        "fe324c52e1160fd77eefa200c479ea3b670bdf4177a0faa0dce3a4fe0c64af26",
        ["Transaction::txid"],
        ["resolve_ftlp_code_tape", "pool_authority_binding", "validate_pool_held_ft_proofs"],
        "authenticated-vendor",
      ),
      source(
        "modules/tbc-transaction-engine/rust/vendor/tbc-sdk/src/contracts/ft/unlock.rs",
        "609e15e9d0f34afe537c65a768cd7554c14c025c801028ed757ef9d321d303c3",
        [
          "classify_ft_script", "pre_pre_tx_data", "pre_pre_tx_data_from_parents",
          "pre_tx_data", "ft_pre_pre_source_indexes",
        ],
        [
          "resolve_source", "validate_evidence_table", "finalize_signing_stage",
          "pool_authority_binding", "tape_source_indexes", "validate_exact_recipe_proof_pairs",
          "resolve_recipe_parent_and_proofs", "validate_pool_held_ft_proofs",
          "validate_planned_ftlp_proofs", "validate_ftlp_maintenance_proofs",
        ],
        "authenticated-vendor",
      ),
      source(
        "modules/tbc-transaction-engine/rust/vendor/tbc-sdk/src/contracts/ft/amount.rs",
        "6709fb8c633ccfaaed6d26202398f197d5c711af4db4a59ae60c51411b9bfd0a",
        ["build_tape_amount", "balance_from_tape"],
        ["resolve_ftlp_code_tape", "pool_authority_binding", "validate_ftlp_maintenance_topology"],
        "authenticated-vendor",
      ),
      source(
        "modules/tbc-transaction-engine/rust/vendor/tbc-sdk/src/contracts/ft/partial_sha256.rs",
        "cdfdbb2c5212267df66b6c2ed16e0a1a9799141da46a8db848c5e2b0a6d2c947",
        ["calculate_partial_hash"],
        ["pool_authority_binding", "authenticate_released_ftlp_code"],
        "authenticated-vendor",
      ),
      source(
        "modules/tbc-transaction-engine/rust/vendor/tbc-sdk/src/contracts/ft/scripts.rs",
        "8a2b33ac367148a56327eb18ada58afd0e82581afb1d2a53d0765e5c1ff557ee",
        ["transfer_tape_script"],
        ["validate_ftlp_maintenance_topology"],
        "authenticated-vendor",
      ),
      source(
        "modules/tbc-transaction-engine/rust/vendor/tbc-sdk/src/contracts/pool_nft_v2/data.rs",
        "267e17854dedb3260eb1123be385c3265c40d7f1554f21eabdedf358f8354186",
        ["PoolState::from_v2_tape"],
        ["pool_authority_binding"],
        "authenticated-vendor",
      ),
      source(
        "modules/tbc-transaction-engine/rust/src/lib.rs",
        "7ccce0b22cd43094b215d3a046b85ab62e1bb02a600300a6e10846ab47fda4d1",
        ["sign_associated_transactions_json", "sign_p2pkh_transactions_json"],
        ["begin_signing", "finalize_signing_stage"],
      ),
      source(
        "modules/tbc-transaction-engine/rust/src/nft.rs",
        "a5e4626cd8774be507b7d862e0b683a685fb220b4b023248ed902c3aaa302699",
        ["sign_legacy_code_input", "legacy_current_tx_data", "legacy_pre_pre_tx_data", "legacy_pre_tx_data"],
        ["nft_unlocking_descriptor", "nft_unlock_suffix", "legacy_current_tx_data", "legacy_pre_pre_tx_data", "legacy_pre_tx_data"],
      ),
      source(
        "modules/tbc-transaction-engine/rust/vendor/tbc-sdk/src/contracts/nft/unlock.rs",
        "b9e64e33c70d1ece21803f348067b96d33b80fa24d6ee49e44c3bac7894d55b2",
        ["current_tx_data", "pre_pre_tx_data", "pre_tx_data"],
        ["nft_unlocking_descriptor", "nft_unlock_suffix"],
      ),
      source(
        "modules/tbc-transaction-engine/rust/vendor/tbc-sdk/src/contracts/pool_nft_v2/unlock.rs",
        "2bc9faddafc99a2d9c3da878bc721db5e15a53c539126997f1a132710a59d81e",
        ["pool_outputs_data", "pool_unlock_requires_signature", "pool_unlock"],
        [
          "input_requires_external_signature", "pool_unlock_script",
          "pool_authority_binding", "validate_ftlp_maintenance_topology",
        ],
        "authenticated-vendor",
      ),
      source(
        "modules/tbc-transaction-engine/rust/vendor/tbc-sdk/src/contracts/ft/builder.rs",
        "23d9aaa831ad8df39434b5d2ffd93a8df6ca4d1b7104f94392ac4059704fd88c",
        ["sign_ft_swap_input", "ft_swap_input_index_tag"],
        ["pool_held_ft_unlock_prefix", "pool_held_ft_unlock_suffix"],
      ),
      source(
        "modules/tbc-transaction-engine/rust/vendor/tbc-sdk/src/contracts/pool_nft_v2/builder.rs",
        "7566b8fa33454897bf38b44547d6b7bf3dc274f424b3d14102a25e3c7d926203",
        [
          "PoolNftV2::for_create", "PoolNftV2::merge_ftlp",
          "ftlp_lock_time_from_tape", "sign_ftlp_input", "build_ftlp_unlock",
        ],
        [
          "pool_authority_binding", "ftlp_unlock_prefix", "ftlp_unlock_suffix", "validate_ftlp_lock",
          "validate_ftlp_maintenance_topology",
        ],
        "authenticated-vendor",
      ),
      source(
        "modules/tbc-transaction-engine/rust/vendor/tbc-sdk/src/contracts/pool_nft_v2/scripts.rs",
        "78c8021defed156559255f4a667a94de727522348ba9e8688b612067ae73f195",
        [
          "FtlpCodeParams::for_tape", "pool_held_ft_code", "ftlp_code",
          "ftlp_lock_time_code", "ftlp_tape",
        ],
        [
          "pool_authority_binding", "authenticate_released_ftlp_code",
          "validate_ftlp_maintenance_topology",
        ],
        "authenticated-vendor",
      ),
      source(
        "modules/tbc-transaction-engine/rust/vendor/tbc-sdk/src/contracts/stable_coin/builder.rs",
        "2af932e784bb34c70b8f252df4091ced4478c27adf83894c0f05b67c08b904f9",
        ["transfer", "merge_coin", "sign_coin_nft_tx", "sign_coin_mint_tx", "admin_sighashes"],
        ["ft_unlock_prefix", "ft_unlock_suffix", "finalize_signing_stage"],
      ),
    ],
  },
];
