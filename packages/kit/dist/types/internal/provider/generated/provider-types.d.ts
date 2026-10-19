type CommonAccountId = (string);
type CommonAddress = (string);
type CommonAtomicAmount = (string);
type CommonBase64 = (string);
type CommonChainId = (string);
type CommonClientRequestId = (string);
type CommonContractId = CommonHash32;
type CommonHash32 = (string);
type CommonLocalId = (string);
type CommonOpaqueId = (string);
type CommonPositiveAtomicAmount = (string);
type CommonPublicKey = (string);
type CommonRawTransaction = (string);
type CommonRfc3339 = (string);
type CommonSafeInteger = (number);
type CommonTransactionId = CommonHash32;
type CommonUint32String = (string);
type IntegrationCryptoExecuteResult = (({
    readonly "algorithm": SigningMessageCryptoAlgorithm;
    readonly "ciphertext": SigningEncryptedMessage;
    readonly "taskId": CommonLocalId;
}) | ({
    readonly "algorithm": SigningMessageCryptoAlgorithm;
    readonly "message": SigningEncodedMessage;
    readonly "taskId": CommonLocalId;
}));
type PermissionsAccountsRequest = ({
    readonly "chains": (readonly (CommonChainId)[]);
    readonly "maxAccounts"?: (number);
});
type PermissionsCaveat = (PermissionsRestrictChains | PermissionsRestrictAccounts | PermissionsRestrictMethods | PermissionsExpiresAt);
type PermissionsExpiresAt = ({
    readonly "type": "expiresAt";
    readonly "value": CommonRfc3339;
});
type PermissionsMethodRequest = ({
    readonly "chains": (readonly (CommonChainId)[]);
});
type PermissionsNonEmptyPermissionArray = (readonly (PermissionsPermission)[]);
type PermissionsPermission = ({
    readonly "caveats": (unknown) & (unknown) & (unknown) & (unknown) & (readonly (PermissionsCaveat)[]);
    readonly "date": (number);
    readonly "id": CommonOpaqueId;
    readonly "invoker": (string);
    readonly "parentCapability": PermissionsPermissionName;
});
type PermissionsPermissionArray = (readonly (PermissionsPermission)[]);
type PermissionsPermissionName = "tbc_accounts" | "tbc_accountMetadata" | "tbc_switchChain" | "tbc_signMessage" | "tbc_signTypedData" | "tbc_crypto" | "tbc_signTransaction" | "tbc_sendTransaction" | "tbc_signWorkflow";
type PermissionsRequestedPermissions = ({
    readonly "tbc_accountMetadata"?: PermissionsMethodRequest;
    readonly "tbc_accounts"?: PermissionsAccountsRequest;
    readonly "tbc_crypto"?: PermissionsMethodRequest;
    readonly "tbc_sendTransaction"?: PermissionsMethodRequest;
    readonly "tbc_signMessage"?: PermissionsMethodRequest;
    readonly "tbc_signTransaction"?: PermissionsMethodRequest;
    readonly "tbc_signTypedData"?: PermissionsMethodRequest;
    readonly "tbc_signWorkflow"?: PermissionsMethodRequest;
    readonly "tbc_switchChain"?: PermissionsMethodRequest;
});
type PermissionsRequestPermissionsParams = (readonly [PermissionsRequestedPermissions]);
type PermissionsRestrictAccounts = ({
    readonly "type": "restrictAccounts";
    readonly "value": (readonly (CommonAccountId)[]);
});
type PermissionsRestrictChains = ({
    readonly "type": "restrictChains";
    readonly "value": (readonly (CommonChainId)[]);
});
type PermissionsRestrictMethods = ({
    readonly "type": "restrictMethods";
    readonly "value": (readonly (PermissionsPermissionName)[]);
});
type PreparedTransactionContractEvidence = (unknown) & ({
    readonly "contractId": CommonContractId;
    readonly "family": "collection" | "nft" | "ft" | "stablecoin" | "pool";
    readonly "genesisOutpoint"?: ({
        readonly "txid": CommonTransactionId;
        readonly "vout": 0;
    });
    readonly "protocolVersion"?: "tbc20" | "tbc721" | "coin" | "pool3";
    readonly "sourceTransactionId": CommonTransactionId;
    readonly "standardId"?: "tbc20-standard" | "tbc721-standard" | "tbc20-stablecoin" | "tbc-amm";
    readonly "templateRevision"?: CommonHash32;
});
type PreparedTransactionDeferredInput = ({
    readonly "inputIndex": (number);
    readonly "sourceOutputIndex": (number);
    readonly "sourceTransactionId": CommonLocalId;
});
type PreparedTransactionDeferredProposedTransaction = ({
    readonly "deferredInputs": (readonly (PreparedTransactionDeferredInput)[]);
    readonly "dependsOn": PreparedTransactionDependsOn;
    readonly "fee": CommonAtomicAmount;
    readonly "id": CommonLocalId;
    readonly "kind": "deferred";
    readonly "role": (string);
    readonly "unsignedTransactionTemplate": CommonRawTransaction;
});
type PreparedTransactionDependsOn = (readonly (CommonLocalId)[]);
type PreparedTransactionFixedProposedTransaction = ({
    readonly "dependsOn": PreparedTransactionDependsOn;
    readonly "fee": CommonAtomicAmount;
    readonly "id": CommonLocalId;
    readonly "kind": "fixed";
    readonly "role": (string);
    readonly "unsignedTransaction": CommonRawTransaction;
});
type PreparedTransactionParentTransactionEvidence = ({
    readonly "rawTransaction": CommonRawTransaction;
    readonly "txid": CommonTransactionId;
});
type PreparedTransactionPreparedTransactionRequest = (TransactionSigningRoleIntentScope) & ({
    readonly "chainId": CommonChainId;
    readonly "clientRequestId"?: CommonClientRequestId;
    readonly "constraints"?: TransactionConstraints;
    readonly "from": CommonAddress;
    readonly "intent": TransactionTbcIntent;
    readonly "proposal": PreparedTransactionTransactionProposal;
    readonly "signingRoles"?: (readonly (TransactionSigningRole)[]);
    readonly "version": "1.0";
});
type PreparedTransactionProposalEvidence = ({
    readonly "contracts": (readonly (PreparedTransactionContractEvidence)[]);
    readonly "observedAt": CommonRfc3339;
    readonly "parentTransactions": (readonly (PreparedTransactionParentTransactionEvidence)[]);
});
type PreparedTransactionProposedTransaction = (PreparedTransactionFixedProposedTransaction | PreparedTransactionDeferredProposedTransaction);
type PreparedTransactionTransactionProposal = ({
    readonly "payload": PreparedTransactionTransactionProposalPayload;
    readonly "proposalHash": CommonHash32;
});
type PreparedTransactionTransactionProposalPayload = ({
    readonly "createdAt": CommonRfc3339;
    readonly "engineProfile": (string);
    readonly "estimatedTotalFee": CommonAtomicAmount;
    readonly "evidence": PreparedTransactionProposalEvidence;
    readonly "expiresAt": CommonRfc3339;
    readonly "intentHash": CommonHash32;
    readonly "transactions": (readonly (PreparedTransactionProposedTransaction)[]);
    readonly "version": "1.0";
});
type PreparedWorkflowDependsOn = (readonly (CommonLocalId)[]);
type PreparedWorkflowPreparedTransactionStep = (TransactionSigningRoleIntentScope) & ({
    readonly "constraints"?: TransactionConstraints;
    readonly "dependsOn": PreparedWorkflowDependsOn;
    readonly "id": CommonLocalId;
    readonly "intent": TransactionTbcIntent;
    readonly "kind": "preparedTransaction";
    readonly "proposal": PreparedTransactionTransactionProposal;
    readonly "signingRoles"?: (readonly (TransactionSigningRole)[]);
});
type PreparedWorkflowRequest = ({
    readonly "chainId": CommonChainId;
    readonly "clientRequestId"?: CommonClientRequestId;
    readonly "expiresAt"?: CommonRfc3339;
    readonly "failureMode"?: "atomic" | "continue-independent";
    readonly "from": CommonAddress;
    readonly "maxTotalFee"?: CommonAtomicAmount;
    readonly "steps": (readonly (PreparedWorkflowStep)[]);
    readonly "version": "1.0";
});
type PreparedWorkflowStep = (PreparedWorkflowPreparedTransactionStep | WorkflowReviewedTransactionStep | WorkflowMessageStep | WorkflowEncryptStep | WorkflowDecryptStep | WorkflowTypedDataStep);
type ProviderAccount = ({
    readonly "accountId": CommonAccountId;
    readonly "address": CommonAddress;
    readonly "chainId": CommonChainId;
    readonly "features": (readonly ((string))[]);
    readonly "label"?: (string);
    readonly "publicKey": CommonPublicKey;
});
type ProviderAddressArray = (readonly (CommonAddress)[]);
type ProviderCancellationReason = "USER_REJECTED" | "REQUEST_ABORTED" | "REQUEST_EXPIRED" | "SESSION_REVOKED" | "NAVIGATION_CHANGED" | "ORIGIN_CHANGED" | "CHAIN_CHANGED" | "ACCOUNT_CHANGED" | "TRANSPORT_CLOSED" | "SNAPSHOT_INVALIDATED" | "PROTOCOL_RELEASE_CHANGED";
type ProviderCapabilities = ({
    readonly "chainId": CommonChainId;
    readonly "intents": ({
        readonly [key: string]: (readonly ((string))[]);
    });
    readonly "limits": ({
        readonly "transactionBundleSize": (number);
        readonly "workflowSteps": (number);
    });
    readonly "methods": ({
        readonly [key: string]: (string);
    });
    readonly "profiles": (readonly ("core" | "assets" | "defi" | "transport:webview" | "transport:extension" | "transport:remote")[]);
    readonly "provider": (string);
    readonly "standard": (string);
});
type ProviderConnectInfo = ({
    readonly "chainId": CommonChainId;
});
type ProviderDisconnectError = ({
    readonly "code": 4900;
    readonly "data"?: unknown;
    readonly "message": (string);
});
type ProviderErrorResponse = ({
    readonly "error": ProviderProviderError;
    readonly "id": ProviderJsonRpcResponseId;
    readonly "jsonrpc": "2.0";
});
type ProviderGetAccountParams = ({
    readonly "address"?: CommonAddress;
});
type ProviderGetCapabilitiesParams = ({
    readonly "address"?: CommonAddress;
    readonly "chainId"?: CommonChainId;
});
type ProviderJsonRpcId = ((string) | (number));
type ProviderJsonRpcResponseId = (ProviderJsonRpcId | (null));
type ProviderNonEmptyAddressArray = (readonly (CommonAddress)[]);
type ProviderNullResult = (null);
type ProviderProviderCompletion = (ProviderProviderCompletionRespond | ProviderProviderCompletionSuppress);
type ProviderProviderCompletionRespond = ({
    readonly "delivery": "respond";
    readonly "events": (readonly (ProviderProviderEvent)[]);
    readonly "response": ProviderResponse;
});
type ProviderProviderCompletionSuppress = ({
    readonly "cancellationReason": ProviderCancellationReason;
    readonly "delivery": "suppress";
});
type ProviderProviderError = (unknown) & ({
    readonly "code": ProviderStandardErrorCode;
    readonly "data"?: unknown;
    readonly "message": (string);
});
type ProviderProviderEvent = ({
    readonly "name": "connect" | "disconnect" | "chainChanged" | "accountsChanged" | "permissionsChanged" | "capabilitiesChanged";
    readonly "payload": unknown;
});
type ProviderRequest = ({
    readonly "id": ProviderJsonRpcId;
    readonly "jsonrpc": "2.0";
    readonly "method": (string);
    readonly "params"?: (({
        readonly [key: string]: unknown;
    }) | (readonly (unknown)[]));
});
type ProviderResponse = (ProviderSuccessResponse | ProviderErrorResponse);
type ProviderStandardErrorCode = 4001 | 4100 | 4200 | 4900 | 4901 | -32700 | -32600 | -32601 | -32602 | -32603 | -32000;
type ProviderSuccessResponse = ({
    readonly "id": ProviderJsonRpcId;
    readonly "jsonrpc": "2.0";
    readonly "result": unknown;
});
type ProviderSwitchChainParams = ({
    readonly "chainId": CommonChainId;
});
type ReviewedTransactionAssociatedChild = ({
    readonly "inputs": (readonly (ReviewedTransactionAssociatedInput)[]);
    readonly "outputs": (readonly (ReviewedTransactionAssociatedOutput)[]);
});
type ReviewedTransactionAssociatedInput = (unknown) & (unknown) & ({
    readonly "ancestorTransactions"?: (readonly (CommonRawTransaction & (string))[]);
    readonly "contractTransaction"?: CommonRawTransaction;
    readonly "contractVersion"?: (number);
    readonly "outputIndex": (number);
    readonly "previousOutputContext"?: CommonRawTransaction;
    readonly "previousTransaction"?: CommonRawTransaction;
    readonly "satoshis"?: CommonAtomicAmount;
    readonly "scriptPubKey"?: CommonRawTransaction;
    readonly "signingProfile": ReviewedTransactionAssociatedSigningProfile;
    readonly "signingRole"?: "coin-admin";
    readonly "txid"?: CommonTransactionId;
    readonly "unlockingScriptTemplate"?: CommonRawTransaction;
});
type ReviewedTransactionAssociatedOutput = ({
    readonly "satoshis": CommonAtomicAmount;
    readonly "scriptPubKey": CommonRawTransaction;
});
type ReviewedTransactionAssociatedPayload = ({
    readonly "children": (readonly (ReviewedTransactionAssociatedChild)[]);
    readonly "format": "associated";
    readonly "sourceInputs": (readonly (ReviewedTransactionAssociatedInput)[]);
    readonly "sourceTransaction": CommonRawTransaction;
});
type ReviewedTransactionAssociatedSigningProfile = "p2pkh" | "ft" | "ft-contract" | "contract-template" | "tbc-lop-match" | "tbc20-standard" | "tbc20-stablecoin";
type ReviewedTransactionInputMaterial = ({
    readonly "satoshis": CommonAtomicAmount;
    readonly "scriptPubKey": CommonRawTransaction;
    readonly "signingRole"?: "coin-admin";
});
type ReviewedTransactionPayload = (ReviewedTransactionRawPayload | ReviewedTransactionAssociatedPayload);
type ReviewedTransactionRawPayload = ({
    readonly "format": "raw";
    readonly "transactions": (readonly (({
        readonly "inputs": (readonly (ReviewedTransactionInputMaterial)[]);
        readonly "rawTransaction": CommonRawTransaction;
    }))[]);
});
type ReviewedTransactionRequest = ({
    readonly "payload": ReviewedTransactionPayload;
});
type ReviewedTransactionSigningRoles = (readonly (({
    readonly "accountId": CommonAccountId;
    readonly "role": "coin-admin";
}))[]);
type SigningBase64Message = ({
    readonly "data": CommonBase64 & (string);
    readonly "encoding": "base64";
});
type SigningDappTypedDomain = ({
    readonly "chainId": CommonChainId;
    readonly "name": (string);
    readonly "origin"?: (string);
    readonly "salt"?: CommonHash32;
    readonly "verifyingContract"?: CommonContractId;
    readonly "version"?: (string);
});
type SigningEncodedMessage = (SigningUtf8Message | SigningHexMessage | SigningBase64Message);
type SigningEncryptedMessage = CommonBase64 & (string);
type SigningHexMessage = ({
    readonly "data": (string);
    readonly "encoding": "hex";
});
type SigningMessageCryptoAlgorithm = "tbc-bie1-secp256k1-aes128-cbc-hmac-sha256-v1";
type SigningMessageEnvelope = ({
    readonly "message": SigningEncodedMessage;
    readonly "type": "tbc.message";
    readonly "version": "1.0";
});
type SigningMessageRequest = ({
    readonly "chainId": CommonChainId;
    readonly "clientRequestId"?: CommonClientRequestId;
    readonly "from": CommonAddress;
    readonly "message": SigningEncodedMessage;
    readonly "version": "1.0";
});
type SigningMessageSignature = (SigningSignatureResultBase) & ((({
    readonly "scheme": "tbc-message";
    readonly "signingPayload": unknown;
    readonly [key: string]: unknown;
}) | ({
    readonly "scheme": "legacy-bitcoin-message";
    readonly "signingPayload"?: never;
    readonly [key: string]: unknown;
})) & ({
    readonly "accountId"?: unknown;
    readonly "address"?: unknown;
    readonly "algorithm"?: unknown;
    readonly "canonical"?: unknown;
    readonly "digest"?: unknown;
    readonly "envelope"?: SigningMessageEnvelope;
    readonly "publicKey"?: unknown;
    readonly "scheme"?: "tbc-message" | "legacy-bitcoin-message";
    readonly "signature"?: unknown;
    readonly "signingPayload"?: unknown;
    readonly "version"?: unknown;
}));
type SigningSignatureResultBase = ({
    readonly "accountId": CommonAccountId;
    readonly "address": CommonAddress;
    readonly "algorithm": "secp256k1-recoverable-ecdsa-sha256d";
    readonly "canonical": (string);
    readonly "digest": CommonHash32;
    readonly "envelope": ({
        readonly [key: string]: unknown;
    });
    readonly "publicKey": CommonPublicKey;
    readonly "scheme": "tbc-message" | "tbc-typed-data" | "legacy-bitcoin-message";
    readonly "signature": CommonBase64;
    readonly "signingPayload"?: CommonBase64;
    readonly "version": "1.0";
    readonly [key: string]: unknown;
});
type SigningTypedData = ({
    readonly "domain": SigningDappTypedDomain;
    readonly "message": SigningTypedMessage;
    readonly "primaryType": (string);
    readonly "types": SigningTypeMap;
});
type SigningTypedDataEnvelope = ({
    readonly "domain": SigningDappTypedDomain;
    readonly "message": SigningTypedMessage;
    readonly "primaryType": (string);
    readonly "type": "tbc.typedData";
    readonly "types": SigningTypeMap;
    readonly "version": "1.0";
});
type SigningTypedDataRequest = ({
    readonly "chainId": CommonChainId;
    readonly "clientRequestId"?: CommonClientRequestId;
    readonly "data": SigningTypedData;
    readonly "from": CommonAddress;
    readonly "version": "1.0";
});
type SigningTypedDataSignature = (SigningSignatureResultBase) & (({
    readonly "accountId"?: unknown;
    readonly "address"?: unknown;
    readonly "algorithm"?: unknown;
    readonly "canonical"?: unknown;
    readonly "digest"?: unknown;
    readonly "envelope"?: SigningTypedDataEnvelope;
    readonly "publicKey"?: unknown;
    readonly "scheme": "tbc-typed-data";
    readonly "signature"?: unknown;
    readonly "signingPayload": CommonBase64;
    readonly "version"?: unknown;
}));
type SigningTypedJsonValue = ((string) | (boolean) | (readonly (SigningTypedJsonValue)[]) | ({
    readonly [key: string]: SigningTypedJsonValue;
}));
type SigningTypedMessage = ({
    readonly [key: string]: SigningTypedJsonValue;
});
type SigningTypeField = ({
    readonly "name": (string);
    readonly "type": (string);
});
type SigningTypeMap = ({
    readonly [key: string]: (readonly (SigningTypeField)[]);
});
type SigningUtf8Message = ({
    readonly "data": (string);
    readonly "encoding": "utf8";
});
type TransactionAmmFeePolicy = ({
    readonly "feeAddress": CommonAddress;
    readonly "lpFeeRate": (number);
    readonly "protocolFeeRate": (number);
    readonly "serviceProviderFeeRate": (number);
    readonly "taxFeeRate": (number);
});
type TransactionAmmStandardAddIntent = (unknown) & ({
    readonly "amount": (string);
    readonly "budgetAsset": "tbc" | "ft";
    readonly "initialFtAmount"?: (string);
    readonly "lockTime"?: (string);
    readonly "maximumFtAmount"?: (string);
    readonly "maximumTbcAmount"?: (string);
    readonly "minimumLpAmount": (string);
    readonly "poolContractId": CommonHash32;
    readonly "poolStateHash"?: CommonHash32;
    readonly "receiver"?: CommonAddress;
    readonly "type": "tbc-amm-add-liquidity";
    readonly "version": "1.0";
});
type TransactionAmmStandardCreateIntent = ({
    readonly "controllers"?: (readonly ((string))[]);
    readonly "feePolicy": TransactionAmmFeePolicy;
    readonly "ftContractId": CommonHash32;
    readonly "lpTimelock": (boolean);
    readonly "serviceProviderTag"?: (string);
    readonly "type": "tbc-amm-create";
    readonly "version": "1.0";
});
type TransactionAmmStandardRemoveIntent = ({
    readonly "lpAmount": (string);
    readonly "minimumFtAmount": (string);
    readonly "minimumTbcAmount": (string);
    readonly "poolContractId": CommonHash32;
    readonly "poolStateHash"?: CommonHash32;
    readonly "receiver"?: CommonAddress;
    readonly "type": "tbc-amm-remove-liquidity";
    readonly "version": "1.0";
});
type TransactionAmmStandardSwapIntent = ({
    readonly "amount": (string);
    readonly "direction": "tbc-to-ft" | "ft-to-tbc";
    readonly "minimumOutput": (string);
    readonly "poolContractId": CommonHash32;
    readonly "poolStateHash"?: CommonHash32;
    readonly "receiver"?: CommonAddress;
    readonly "type": "tbc-amm-swap";
    readonly "version": "1.0";
});
type TransactionArtifacts = ({
    readonly "collectionId"?: CommonContractId;
    readonly "contractId"?: CommonContractId;
    readonly "poolContractId"?: CommonContractId;
});
type TransactionAttribute = ({
    readonly "traitType": (string);
    readonly "value": ((string) | (boolean) | CommonSafeInteger);
});
type TransactionBase64Media = ({
    readonly "data": CommonBase64 & (string);
    readonly "kind": "base64";
    readonly "mediaType": (string);
    readonly "sha256": CommonHash32;
});
type TransactionBundleBase = ({
    readonly "approvalId": CommonOpaqueId;
    readonly "artifacts"?: TransactionArtifacts;
    readonly "chainId": CommonChainId;
    readonly "detachedSignatures"?: TransactionDetachedSignatures;
    readonly "from": CommonAddress;
    readonly "requestHash": CommonHash32;
    readonly "totalFee": CommonAtomicAmount;
    readonly "transactions": (readonly (unknown)[]);
    readonly "version": "1.0";
    readonly [key: string]: unknown;
});
type TransactionCoinCreateIntent = ({
    readonly "decimals": (number);
    readonly "initialSupply": (string);
    readonly "name": (string);
    readonly "symbol": (string);
    readonly "to"?: CommonAddress;
    readonly "type": "tbc20-stablecoin-create";
    readonly "version": "1.0";
});
type TransactionCoinFreezeIntent = ({
    readonly "contractId": CommonContractId;
    readonly "lockTime": (string);
    readonly "targetOutpoints": (readonly (TransactionCoinTargetOutpoint)[]);
    readonly "type": "tbc20-stablecoin-freeze";
    readonly "version": "1.0";
});
type TransactionCoinMergeIntent = ({
    readonly "contractId": CommonContractId;
    readonly "type": "tbc20-stablecoin-merge";
    readonly "version": "1.0";
});
type TransactionCoinMintIntent = ({
    readonly "amount": (string);
    readonly "certificateOutpoint"?: ({
        readonly "txid": CommonHash32;
        readonly "vout": 0;
    });
    readonly "contractId": CommonContractId;
    readonly "to": CommonAddress;
    readonly "type": "tbc20-stablecoin-mint";
    readonly "version": "1.0";
});
type TransactionCoinTargetOutpoint = ({
    readonly "txid": CommonHash32;
    readonly "vout": (number);
});
type TransactionCoinTransferIntent = (({
    readonly "amount": unknown;
    readonly "receivers"?: never;
    readonly "to": unknown;
    readonly [key: string]: unknown;
}) | ({
    readonly "amount"?: never;
    readonly "receivers": unknown;
    readonly "to"?: never;
    readonly [key: string]: unknown;
})) & ({
    readonly "amount"?: (string);
    readonly "contractId": CommonContractId;
    readonly "payment"?: TransactionNativePayment;
    readonly "receivers"?: (readonly (({
        readonly "amount": (string);
        readonly "to": CommonAddress;
    }))[]);
    readonly "to"?: CommonAddress;
    readonly "type": "tbc20-stablecoin-transfer";
    readonly "version": "1.0";
});
type TransactionCoinUnfreezeIntent = ({
    readonly "contractId": CommonContractId;
    readonly "targetOutpoints": (readonly (TransactionCoinTargetOutpoint)[]);
    readonly "type": "tbc20-stablecoin-unfreeze";
    readonly "version": "1.0";
});
type TransactionCollectionCreateIntent = ({
    readonly "description": (string);
    readonly "media": TransactionMedia;
    readonly "name": (string);
    readonly "supply": (string);
    readonly "type": "tbc.collection.create";
    readonly "version": "1.0";
});
type TransactionConstraints = ({
    readonly "expiresAt"?: CommonRfc3339;
    readonly "feePreference"?: "economy" | "standard" | "priority";
    readonly "inputOutpoints"?: (readonly (({
        readonly "txid": CommonHash32;
        readonly "vout": (number);
    }))[]);
    readonly "maxFee"?: CommonAtomicAmount;
});
type TransactionDetachedSignatures = (readonly ((readonly ((string))[]))[]);
type TransactionFtCreateIntent = ({
    readonly "decimals": (number);
    readonly "initialSupply": CommonPositiveAtomicAmount;
    readonly "name": (string);
    readonly "symbol": (string);
    readonly "type": "tbc.ft.create";
    readonly "version": "1.0";
});
type TransactionFtMergeIntent = ({
    readonly "contractId": CommonContractId;
    readonly "type": "tbc.ft.merge";
    readonly "version": "1.0";
});
type TransactionFtTransferIntent = (TransactionFungibleTransferFields) & (({
    readonly "amount"?: unknown;
    readonly "attachedTbcAmount"?: unknown;
    readonly "contractId"?: unknown;
    readonly "to"?: unknown;
    readonly "type"?: "tbc.ft.transfer";
    readonly "version"?: unknown;
}));
type TransactionFungibleTransferFields = ({
    readonly "amount": CommonPositiveAtomicAmount;
    readonly "attachedTbcAmount"?: CommonAtomicAmount;
    readonly "contractId": CommonContractId;
    readonly "to": CommonAddress;
    readonly "type": "tbc.ft.transfer" | "tbc.stablecoin.transfer";
    readonly "version": "1.0";
    readonly [key: string]: unknown;
});
type TransactionHtlcClaimIntent = ({
    readonly "assetStandard"?: "tbc20-standard" | "tbc20-stablecoin";
    readonly "contractId"?: CommonHash32;
    readonly "preimage": (string);
    readonly "targetOutpoints"?: (readonly (TransactionHtlcTokenTarget)[]);
    readonly "type": "tbc-htlc-claim";
    readonly "version": "1.0";
});
type TransactionHtlcLockIntent = ({
    readonly "amount": CommonPositiveAtomicAmount;
    readonly "assetStandard"?: "tbc20-standard" | "tbc20-stablecoin";
    readonly "contractId"?: CommonHash32;
    readonly "hashlock": (string);
    readonly "lockTime": (string);
    readonly "to": CommonAddress;
    readonly "type": "tbc-htlc-lock";
    readonly "version": "1.0";
});
type TransactionHtlcRefundIntent = ({
    readonly "assetStandard"?: "tbc20-standard" | "tbc20-stablecoin";
    readonly "contractId"?: CommonHash32;
    readonly "targetOutpoints"?: (readonly (TransactionHtlcTokenTarget)[]);
    readonly "type": "tbc-htlc-refund";
    readonly "version": "1.0";
});
type TransactionHtlcTokenTarget = ({
    readonly "txid": CommonHash32;
    readonly "vout": 1;
});
type TransactionLopAsset = ({
    readonly "contractId": CommonHash32;
    readonly "standard": "tbc20-standard" | "tbc20-stablecoin";
});
type TransactionLopCancelIntent = ({
    readonly "targetOutpoints": (readonly (({
        readonly "txid": CommonHash32;
        readonly "vout": (number);
    }))[]);
    readonly "type": "tbc-lop-cancel";
    readonly "version": "1.0";
});
type TransactionLopCreateIntent = ({
    readonly "order": (unknown) & ({
        readonly "assetA": TransactionLopAsset;
        readonly "assetB"?: TransactionLopAsset;
        readonly "feeRate": (string);
        readonly "feeRecipient": CommonAddress;
        readonly "market": "native-token" | "token-token";
        readonly "saleVolume": (string);
        readonly "side": "buy" | "sell";
        readonly "unitPrice": (string);
    });
    readonly "type": "tbc-lop-create";
    readonly "version": "1.0";
});
type TransactionLopMatchIntent = ({
    readonly "targetOutpoints": (readonly (({
        readonly "txid": CommonHash32;
        readonly "vout": (number);
    }))[]);
    readonly "type": "tbc-lop-match";
    readonly "version": "1.0";
});
type TransactionLpStandardLockIntent = ({
    readonly "amount": (string);
    readonly "lockTime": (string);
    readonly "poolContractId": CommonHash32;
    readonly "type": "tbc20-lp-lock";
    readonly "version": "1.0";
});
type TransactionLpStandardMaintenanceIntent = ({
    readonly "poolContractId": CommonHash32;
    readonly "type": "tbc20-lp-merge" | "tbc20-lp-unlock";
    readonly "version": "1.0";
});
type TransactionLpStandardTransferIntent = ({
    readonly "amount": (string);
    readonly "poolContractId": CommonHash32;
    readonly "to": CommonAddress;
    readonly "type": "tbc20-lp-transfer";
    readonly "version": "1.0";
});
type TransactionMedia = (TransactionUriMedia | TransactionBase64Media);
type TransactionNativePayment = ({
    readonly "amount": CommonPositiveAtomicAmount;
    readonly "to": CommonAddress;
});
type TransactionNftMintIntent = ({
    readonly "attributes": (readonly (TransactionAttribute)[]);
    readonly "collectionId": CommonContractId;
    readonly "description": (string);
    readonly "media"?: TransactionMedia;
    readonly "name": (string);
    readonly "symbol": (string);
    readonly "type": "tbc.nft.mint";
    readonly "version": "1.0";
});
type TransactionNftTransferIntent = ({
    readonly "contractId": CommonContractId;
    readonly "to": CommonAddress;
    readonly "type": "tbc.nft.transfer";
    readonly "version": "1.0";
});
type TransactionPoolCreateIntent = (({
    readonly "ftContractId": CommonContractId;
    readonly "initialLiquidity": TransactionPoolInitialLiquidity;
    readonly "lock"?: TransactionPoolLock;
    readonly "lpPlan": (number);
    readonly "serviceProviderTag"?: (string);
    readonly "type": "tbc.pool.create";
    readonly "version": "1.0";
}) | ({
    readonly "ftContractId": CommonContractId;
    readonly "lock"?: TransactionPoolLock;
    readonly "lpPlan": (number);
    readonly "serviceProviderTag"?: (string);
    readonly "stage": "mint";
    readonly "type": "tbc.pool.create";
    readonly "version": "1.0";
}) | ({
    readonly "initialLiquidity": TransactionPoolInitialLiquidity;
    readonly "poolContractId": CommonContractId;
    readonly "stage": "initialize";
    readonly "type": "tbc.pool.create";
    readonly "version": "1.0";
}));
type TransactionPoolFtlpBurnIntent = ({
    readonly "poolContractId": CommonContractId;
    readonly "type": "tbc.pool.ftlp.burn";
    readonly "version": "1.0";
});
type TransactionPoolFtlpMergeIntent = ({
    readonly "poolContractId": CommonContractId;
    readonly "type": "tbc.pool.ftlp.merge";
    readonly "version": "1.0";
});
type TransactionPoolFtMergeIntent = ({
    readonly "poolContractId": CommonContractId;
    readonly "type": "tbc.pool.ft.merge";
    readonly "version": "1.0";
});
type TransactionPoolInitialLiquidity = ({
    readonly "ftAmount": CommonPositiveAtomicAmount;
    readonly "receiver": CommonAddress;
    readonly "tbcAmount": CommonPositiveAtomicAmount;
});
type TransactionPoolLiquidityAddIntent = ({
    readonly "lockUntilHeight"?: CommonUint32String;
    readonly "minimumLpAmount": CommonPositiveAtomicAmount;
    readonly "poolContractId": CommonContractId;
    readonly "receiver": CommonAddress;
    readonly "tbcAmount": CommonPositiveAtomicAmount;
    readonly "type": "tbc.pool.liquidity.add";
    readonly "version": "1.0";
});
type TransactionPoolLiquidityCloseIntent = ({
    readonly "poolContractId": CommonContractId;
    readonly "type": "tbc.pool.liquidity.close";
    readonly "version": "1.0";
});
type TransactionPoolLiquidityRemoveIntent = ({
    readonly "lpAmount": CommonPositiveAtomicAmount;
    readonly "minimumFtAmount": CommonPositiveAtomicAmount;
    readonly "minimumTbcAmount": CommonPositiveAtomicAmount;
    readonly "poolContractId": CommonContractId;
    readonly "receiver": CommonAddress;
    readonly "type": "tbc.pool.liquidity.remove";
    readonly "version": "1.0";
});
type TransactionPoolLock = ({
    readonly "costAmount": CommonPositiveAtomicAmount;
    readonly "costRecipient": CommonAddress;
    readonly "publicKeys": (readonly (CommonPublicKey)[]);
    readonly "untilHeight"?: CommonUint32String;
});
type TransactionSignedTransaction = ({
    readonly "dependsOn": (readonly (CommonLocalId)[]);
    readonly "id": CommonLocalId;
    readonly "rawTransaction": CommonRawTransaction;
    readonly "role": "primary" | "prerequisite" | "maintenance";
    readonly "txid": CommonTransactionId;
});
type TransactionSignedTransactionBundle = (TransactionBundleBase) & (({
    readonly "approvalId"?: unknown;
    readonly "artifacts"?: unknown;
    readonly "chainId"?: unknown;
    readonly "detachedSignatures"?: unknown;
    readonly "from"?: unknown;
    readonly "requestHash"?: unknown;
    readonly "totalFee"?: unknown;
    readonly "transactions"?: (readonly (TransactionSignedTransaction)[]);
    readonly "version"?: unknown;
}));
type TransactionSigningRole = ({
    readonly "accountId": CommonAccountId;
    readonly "role": "pool-controller" | "coin-admin";
});
type TransactionSigningRoleIntentScope = unknown;
type TransactionStablecoinMergeIntent = ({
    readonly "contractId": CommonContractId;
    readonly "type": "tbc.stablecoin.merge";
    readonly "version": "1.0";
});
type TransactionStablecoinTransferIntent = (TransactionFungibleTransferFields) & (({
    readonly "amount"?: unknown;
    readonly "attachedTbcAmount"?: unknown;
    readonly "contractId"?: unknown;
    readonly "to"?: unknown;
    readonly "type"?: "tbc.stablecoin.transfer";
    readonly "version"?: unknown;
}));
type TransactionSubmittedTransaction = ({
    readonly "dependsOn": (readonly (CommonLocalId)[]);
    readonly "id": CommonLocalId;
    readonly "role": "primary" | "prerequisite" | "maintenance";
    readonly "status": "submitted";
    readonly "txid": CommonTransactionId;
});
type TransactionSubmittedTransactionBundle = (TransactionBundleBase) & (({
    readonly "approvalId"?: unknown;
    readonly "artifacts"?: unknown;
    readonly "chainId"?: unknown;
    readonly "from"?: unknown;
    readonly "requestHash"?: unknown;
    readonly "totalFee"?: unknown;
    readonly "transactions"?: (readonly (TransactionSubmittedTransaction)[]);
    readonly "version"?: unknown;
}));
type TransactionSwapTbcForTokenIntent = ({
    readonly "minimumFtAmount": CommonPositiveAtomicAmount;
    readonly "poolContractId": CommonContractId;
    readonly "receiver": CommonAddress;
    readonly "tbcAmount": CommonPositiveAtomicAmount;
    readonly "type": "tbc.pool.swap.exactTbcForToken";
    readonly "version": "1.0";
});
type TransactionSwapTokenForTbcIntent = ({
    readonly "ftAmount": CommonPositiveAtomicAmount;
    readonly "minimumTbcAmount": CommonPositiveAtomicAmount;
    readonly "poolContractId": CommonContractId;
    readonly "receiver": CommonAddress;
    readonly "type": "tbc.pool.swap.exactTokenForTbc";
    readonly "version": "1.0";
});
type TransactionTbc20StandardCreateIntent = ({
    readonly "decimals": (number);
    readonly "initialSupply": (string);
    readonly "name": (string);
    readonly "symbol": (string);
    readonly "to"?: CommonAddress;
    readonly "type": "tbc20-standard-create";
    readonly "version": "1.0";
});
type TransactionTbc20StandardMergeIntent = ({
    readonly "contractId": CommonContractId;
    readonly "type": "tbc20-standard-merge";
    readonly "version": "1.0";
});
type TransactionTbc20StandardTransferIntent = (({
    readonly "amount": unknown;
    readonly "receivers"?: never;
    readonly "to": unknown;
    readonly [key: string]: unknown;
}) | ({
    readonly "amount"?: never;
    readonly "receivers": unknown;
    readonly "to"?: never;
    readonly [key: string]: unknown;
})) & ({
    readonly "amount"?: (string);
    readonly "contractId": CommonContractId;
    readonly "receivers"?: (readonly (({
        readonly "amount": (string);
        readonly "to": CommonAddress;
    }))[]);
    readonly "to"?: CommonAddress;
    readonly "type": "tbc20-standard-transfer";
    readonly "version": "1.0";
});
type TransactionTbc721StandardBatchMintIntent = ({
    readonly "collectionId": CommonContractId;
    readonly "items": (readonly (TransactionTbc721StandardMintItem)[]);
    readonly "type": "tbc721-standard-batch-mint";
    readonly "version": "1.0";
});
type TransactionTbc721StandardCollectionIntent = ({
    readonly "description": (string);
    readonly "media": TransactionMedia;
    readonly "name": (string);
    readonly "supply": (string);
    readonly "to"?: CommonAddress;
    readonly "type": "tbc721-standard-create-collection";
    readonly "version": "1.0";
});
type TransactionTbc721StandardMintIntent = ({
    readonly "attributes": (readonly (TransactionAttribute)[]);
    readonly "collectionId": CommonContractId;
    readonly "description": (string);
    readonly "media"?: TransactionMedia;
    readonly "name": (string);
    readonly "slot": (number);
    readonly "symbol": (string);
    readonly "to"?: CommonAddress;
    readonly "type": "tbc721-standard-mint";
    readonly "version": "1.0";
});
type TransactionTbc721StandardMintItem = ({
    readonly "attributes": (readonly (TransactionAttribute)[]);
    readonly "description": (string);
    readonly "media"?: TransactionMedia;
    readonly "name": (string);
    readonly "slot": (number);
    readonly "symbol": (string);
    readonly "to"?: CommonAddress;
});
type TransactionTbc721StandardTransferIntent = ({
    readonly "contractId": CommonContractId;
    readonly "payment"?: TransactionNativePayment;
    readonly "to": CommonAddress;
    readonly "type": "tbc721-standard-transfer";
    readonly "version": "1.0";
});
type TransactionTbcIntent = (TransactionTransferIntent | TransactionTbcMergeIntent | TransactionCollectionCreateIntent | TransactionNftMintIntent | TransactionNftTransferIntent | TransactionTbc721StandardCollectionIntent | TransactionTbc721StandardMintIntent | TransactionTbc721StandardBatchMintIntent | TransactionTbc721StandardTransferIntent | TransactionUnifiedNftTransferIntent | TransactionUnifiedAmmAddIntent | TransactionUnifiedAmmRemoveIntent | TransactionUnifiedAmmSwapIntent | TransactionUnifiedLpTransferIntent | TransactionUnifiedLpLockIntent | TransactionUnifiedPoolMaintenanceIntent | TransactionFtCreateIntent | TransactionFtTransferIntent | TransactionFtMergeIntent | TransactionTbc20StandardCreateIntent | TransactionTbc20StandardTransferIntent | TransactionTbc20StandardMergeIntent | TransactionUnifiedFungibleTransferIntent | TransactionUnifiedFungibleMergeIntent | TransactionCoinCreateIntent | TransactionCoinMintIntent | TransactionCoinFreezeIntent | TransactionCoinUnfreezeIntent | TransactionCoinTransferIntent | TransactionCoinMergeIntent | TransactionLpStandardTransferIntent | TransactionLpStandardLockIntent | TransactionLpStandardMaintenanceIntent | TransactionTimelockLockIntent | TransactionTimelockUnlockIntent | TransactionLopCreateIntent | TransactionLopCancelIntent | TransactionLopMatchIntent | TransactionHtlcLockIntent | TransactionHtlcClaimIntent | TransactionHtlcRefundIntent | TransactionAmmStandardCreateIntent | TransactionAmmStandardAddIntent | TransactionAmmStandardRemoveIntent | TransactionAmmStandardSwapIntent | TransactionStablecoinTransferIntent | TransactionStablecoinMergeIntent | TransactionPoolCreateIntent | TransactionPoolLiquidityAddIntent | TransactionPoolLiquidityRemoveIntent | TransactionPoolLiquidityCloseIntent | TransactionPoolFtMergeIntent | TransactionPoolFtlpMergeIntent | TransactionPoolFtlpBurnIntent | TransactionSwapTbcForTokenIntent | TransactionSwapTokenForTbcIntent);
type TransactionTbcMergeIntent = ({
    readonly "type": "tbc.maintenance.merge";
    readonly "version": "1.0";
});
type TransactionTimelockLockIntent = ({
    readonly "amount": CommonPositiveAtomicAmount;
    readonly "lockTime": (string);
    readonly "type": "tbc-timelock-lock";
    readonly "version": "1.0";
});
type TransactionTimelockUnlockIntent = ({
    readonly "type": "tbc-timelock-unlock";
    readonly "version": "1.0";
});
type TransactionTransactionRequest = (TransactionSigningRoleIntentScope) & (unknown) & (unknown) & ({
    readonly "chainId": CommonChainId;
    readonly "clientRequestId"?: CommonClientRequestId;
    readonly "constraints"?: TransactionConstraints;
    readonly "from": CommonAddress;
    readonly "intent": TransactionTbcIntent;
    readonly "signingRoles"?: (readonly (TransactionSigningRole)[]);
    readonly "version": "1.0";
});
type TransactionTransferIntent = ({
    readonly "amount": CommonPositiveAtomicAmount;
    readonly "to": CommonAddress;
    readonly "type": "tbc.transfer";
    readonly "version": "1.0";
});
type TransactionUnifiedAmmAddIntent = (unknown) & ({
    readonly "amount": (string);
    readonly "budgetAsset": "tbc" | "ft";
    readonly "initialFtAmount"?: (string);
    readonly "lockTime"?: (string);
    readonly "maximumFtAmount"?: (string);
    readonly "maximumTbcAmount"?: (string);
    readonly "minimumLpAmount": (string);
    readonly "poolContractId": CommonHash32;
    readonly "poolStateHash"?: CommonHash32;
    readonly "receiver"?: CommonAddress;
    readonly "type": "amm.addLiquidity";
    readonly "version": "1.0";
});
type TransactionUnifiedAmmRemoveIntent = ({
    readonly "lpAmount": (string);
    readonly "minimumFtAmount": (string);
    readonly "minimumTbcAmount": (string);
    readonly "poolContractId": CommonHash32;
    readonly "poolStateHash"?: CommonHash32;
    readonly "receiver"?: CommonAddress;
    readonly "type": "amm.removeLiquidity";
    readonly "version": "1.0";
});
type TransactionUnifiedAmmSwapIntent = ({
    readonly "amount": (string);
    readonly "direction": "tbc-to-ft" | "ft-to-tbc";
    readonly "minimumOutput": (string);
    readonly "poolContractId": CommonHash32;
    readonly "poolStateHash"?: CommonHash32;
    readonly "receiver"?: CommonAddress;
    readonly "type": "amm.swap";
    readonly "version": "1.0";
});
type TransactionUnifiedFungibleMergeIntent = ({
    readonly "contractId": CommonContractId;
    readonly "type": "tbc20.merge" | "tbc20Stablecoin.merge";
    readonly "version": "1.0";
});
type TransactionUnifiedFungibleTransferIntent = (({
    readonly "amount": unknown;
    readonly "receivers"?: never;
    readonly "to": unknown;
    readonly [key: string]: unknown;
}) | ({
    readonly "amount"?: never;
    readonly "receivers": unknown;
    readonly "to"?: never;
    readonly [key: string]: unknown;
})) & (unknown) & ({
    readonly "amount"?: (string);
    readonly "contractId": CommonContractId;
    readonly "payment"?: TransactionNativePayment;
    readonly "receivers"?: (readonly (({
        readonly "amount": (string);
        readonly "to": CommonAddress;
    }))[]);
    readonly "to"?: CommonAddress;
    readonly "type": "tbc20.transfer" | "tbc20Stablecoin.transfer";
    readonly "version": "1.0";
});
type TransactionUnifiedLpLockIntent = ({
    readonly "amount": (string);
    readonly "lockTime": (string);
    readonly "poolContractId": CommonHash32;
    readonly "type": "tbc20Lp.lock";
    readonly "version": "1.0";
});
type TransactionUnifiedLpTransferIntent = ({
    readonly "amount": (string);
    readonly "poolContractId": CommonHash32;
    readonly "to": CommonAddress;
    readonly "type": "tbc20Lp.transfer";
    readonly "version": "1.0";
});
type TransactionUnifiedNftTransferIntent = ({
    readonly "contractId": CommonContractId;
    readonly "payment"?: TransactionNativePayment;
    readonly "to": CommonAddress;
    readonly "type": "tbc721.transfer";
    readonly "version": "1.0";
});
type TransactionUnifiedPoolMaintenanceIntent = ({
    readonly "poolContractId": CommonHash32;
    readonly "type": "tbc20Lp.merge" | "tbc20Lp.unlock" | "tbc20Lp.burn" | "amm.mergeToken";
    readonly "version": "1.0";
});
type TransactionUriMedia = ({
    readonly "kind": "uri";
    readonly "sha256"?: CommonHash32;
    readonly "uri": (string);
});
type WalletActionsDecryptRequest = ({
    readonly "algorithm": SigningMessageCryptoAlgorithm;
    readonly "chainId": CommonChainId;
    readonly "ciphertext": SigningEncryptedMessage;
    readonly "clientRequestId"?: CommonClientRequestId;
    readonly "expiresAt"?: CommonRfc3339;
    readonly "from": CommonAddress;
    readonly "version": "1.0";
});
type WalletActionsDecryptResult = ({
    readonly "algorithm": SigningMessageCryptoAlgorithm;
    readonly "chainId": CommonChainId;
    readonly "from": CommonAddress;
    readonly "message": SigningEncodedMessage;
    readonly "version": "1.0";
});
type WalletActionsEncryptRequest = ({
    readonly "algorithm": SigningMessageCryptoAlgorithm;
    readonly "chainId": CommonChainId;
    readonly "clientRequestId"?: CommonClientRequestId;
    readonly "expiresAt"?: CommonRfc3339;
    readonly "from": CommonAddress;
    readonly "message": SigningEncodedMessage;
    readonly "version": "1.0";
});
type WalletActionsEncryptResult = ({
    readonly "algorithm": SigningMessageCryptoAlgorithm;
    readonly "chainId": CommonChainId;
    readonly "ciphertext": SigningEncryptedMessage;
    readonly "from": CommonAddress;
    readonly "version": "1.0";
});
type WalletActionsSignReviewedTransactionRequest = ({
    readonly "chainId": CommonChainId;
    readonly "clientRequestId"?: CommonClientRequestId;
    readonly "expiresAt"?: CommonRfc3339;
    readonly "from": CommonAddress;
    readonly "maxFee"?: CommonAtomicAmount;
    readonly "request": ReviewedTransactionRequest;
    readonly "signingRoles"?: ReviewedTransactionSigningRoles;
    readonly "version": "1.0";
});
type WorkflowBatchItemResult = ({
    readonly "reason"?: (string);
    readonly "status": "accepted" | "known" | "rejected" | "unknown";
    readonly "txid": CommonTransactionId;
});
type WorkflowBinding = ({
    readonly "source": WorkflowBindingSource;
    readonly "target": (string);
});
type WorkflowBindingSource = ({
    readonly "output": "transactionIds" | "primaryTransactionId" | "artifacts.collectionId" | "artifacts.contractId" | "artifacts.poolContractId";
    readonly "stepId": CommonLocalId;
});
type WorkflowCryptoStepResult = ({
    readonly "id": CommonLocalId;
    readonly "kind": "encrypt" | "decrypt";
    readonly "result": IntegrationCryptoExecuteResult;
});
type WorkflowDecryptStep = ({
    readonly "algorithm": SigningMessageCryptoAlgorithm;
    readonly "ciphertext": SigningEncryptedMessage;
    readonly "dependsOn": WorkflowDependsOn;
    readonly "id": CommonLocalId;
    readonly "kind": "decrypt";
});
type WorkflowDependsOn = (readonly (CommonLocalId)[]);
type WorkflowEncryptStep = ({
    readonly "algorithm": SigningMessageCryptoAlgorithm;
    readonly "dependsOn": WorkflowDependsOn;
    readonly "id": CommonLocalId;
    readonly "kind": "encrypt";
    readonly "message": SigningEncodedMessage;
});
type WorkflowFailedStepResult = ({
    readonly "error": ({
        readonly "code": (string);
        readonly "message": (string);
    });
    readonly "id": CommonLocalId;
    readonly "kind": "transaction" | "preparedTransaction" | "reviewedTransaction" | "message" | "typedData" | "encrypt" | "decrypt";
    readonly "status": "failed" | "skipped";
});
type WorkflowMessageBinding = ({
    readonly "source": WorkflowBindingSource;
    readonly "target": (string);
});
type WorkflowMessageStep = ({
    readonly "bindings"?: (readonly (WorkflowMessageBinding)[]);
    readonly "dependsOn": WorkflowDependsOn;
    readonly "id": CommonLocalId;
    readonly "kind": "message";
    readonly "message": SigningEncodedMessage;
});
type WorkflowMessageStepResult = ({
    readonly "id": CommonLocalId;
    readonly "kind": "message";
    readonly "result": SigningMessageSignature;
});
type WorkflowRequest = ({
    readonly "chainId": CommonChainId;
    readonly "clientRequestId"?: CommonClientRequestId;
    readonly "expiresAt"?: CommonRfc3339;
    readonly "failureMode"?: "atomic" | "continue-independent";
    readonly "from": CommonAddress;
    readonly "maxTotalFee"?: CommonAtomicAmount;
    readonly "steps": (readonly (WorkflowStep)[]);
    readonly "version": "1.0";
});
type WorkflowResult = ({
    readonly "approvalId": CommonOpaqueId;
    readonly "chainId": CommonChainId;
    readonly "failureMode": "atomic" | "continue-independent";
    readonly "from": CommonAddress;
    readonly "requestHash": CommonHash32;
    readonly "steps": (readonly (WorkflowStepResult)[]);
    readonly "totalFee": CommonAtomicAmount;
    readonly "version": "1.0";
    readonly "workflowPlanHash": CommonHash32;
});
type WorkflowReviewedTransactionStep = ({
    readonly "dependsOn": WorkflowDependsOn;
    readonly "id": CommonLocalId;
    readonly "kind": "reviewedTransaction";
    readonly "request": ReviewedTransactionRequest;
    readonly "signingRoles"?: ReviewedTransactionSigningRoles;
});
type WorkflowReviewedTransactionStepResult = ({
    readonly "id": CommonLocalId;
    readonly "kind": "reviewedTransaction";
    readonly "result": TransactionSignedTransactionBundle;
});
type WorkflowSendResult = ({
    readonly "status": "complete" | "partial" | "rejected" | "unknown";
    readonly "transactions": (readonly (WorkflowBatchItemResult)[]);
    readonly "version": "1.0";
    readonly "workflow": WorkflowResult;
});
type WorkflowStep = (WorkflowTransactionStep | WorkflowReviewedTransactionStep | WorkflowMessageStep | WorkflowEncryptStep | WorkflowDecryptStep | WorkflowTypedDataStep);
type WorkflowStepResult = (WorkflowTransactionStepResult | WorkflowReviewedTransactionStepResult | WorkflowMessageStepResult | WorkflowCryptoStepResult | WorkflowTypedDataStepResult | WorkflowFailedStepResult);
type WorkflowTransactionStep = (TransactionSigningRoleIntentScope) & ({
    readonly "constraints"?: TransactionConstraints;
    readonly "dependsOn": WorkflowDependsOn;
    readonly "id": CommonLocalId;
    readonly "intent": TransactionTbcIntent;
    readonly "kind": "transaction";
    readonly "signingRoles"?: (readonly (TransactionSigningRole)[]);
});
type WorkflowTransactionStepResult = ({
    readonly "id": CommonLocalId;
    readonly "kind": "transaction" | "preparedTransaction";
    readonly "result": TransactionSignedTransactionBundle;
});
type WorkflowTypedDataStep = ({
    readonly "bindings": (readonly (WorkflowBinding)[]);
    readonly "data": SigningTypedData;
    readonly "dependsOn": WorkflowDependsOn;
    readonly "id": CommonLocalId;
    readonly "kind": "typedData";
});
type WorkflowTypedDataStepResult = ({
    readonly "id": CommonLocalId;
    readonly "kind": "typedData";
    readonly "result": SigningTypedDataSignature;
});
export interface TwsProviderSchema {
    readonly "signReviewedTransactionRequest": WalletActionsSignReviewedTransactionRequest;
    readonly "encryptRequest": WalletActionsEncryptRequest;
    readonly "decryptRequest": WalletActionsDecryptRequest;
    readonly "encryptResult": WalletActionsEncryptResult;
    readonly "decryptResult": WalletActionsDecryptResult;
    readonly "jsonRpcId": ProviderJsonRpcId;
    readonly "request": ProviderRequest;
    readonly "response": ProviderResponse;
    readonly "providerError": ProviderProviderError;
    readonly "providerEvent": ProviderProviderEvent;
    readonly "providerCompletion": ProviderProviderCompletion;
    readonly "cancellationReason": ProviderCancellationReason;
    readonly "chainIdResult": CommonChainId;
    readonly "accountsResult": ProviderAddressArray;
    readonly "requestAccountsResult": ProviderNonEmptyAddressArray;
    readonly "getAccountParams": ProviderGetAccountParams;
    readonly "getAccountResult": ProviderAccount;
    readonly "getCapabilitiesParams": ProviderGetCapabilitiesParams;
    readonly "getCapabilitiesResult": ProviderCapabilities;
    readonly "switchChainParams": ProviderSwitchChainParams;
    readonly "nullResult": ProviderNullResult;
    readonly "messageRequest": SigningMessageRequest;
    readonly "messageSignature": SigningMessageSignature;
    readonly "typedDataRequest": SigningTypedDataRequest;
    readonly "typedDataSignature": SigningTypedDataSignature;
    readonly "transactionRequest": TransactionTransactionRequest;
    readonly "preparedTransactionRequest": PreparedTransactionPreparedTransactionRequest;
    readonly "signedTransactionBundle": TransactionSignedTransactionBundle;
    readonly "submittedTransactionBundle": TransactionSubmittedTransactionBundle;
    readonly "workflowRequest": WorkflowRequest;
    readonly "preparedWorkflowRequest": PreparedWorkflowRequest;
    readonly "workflowResult": WorkflowResult;
    readonly "workflowSendResult": WorkflowSendResult;
    readonly "permissionArray": PermissionsPermissionArray;
    readonly "nonEmptyPermissionArray": PermissionsNonEmptyPermissionArray;
    readonly "requestPermissionsParams": PermissionsRequestPermissionsParams;
    readonly "connectEvent": ProviderConnectInfo;
    readonly "disconnectEvent": ProviderDisconnectError;
    readonly "chainChangedEvent": CommonChainId;
    readonly "accountsChangedEvent": ProviderAddressArray;
    readonly "permissionsChangedEvent": PermissionsPermissionArray;
    readonly "capabilitiesChangedEvent": ProviderCapabilities;
}
export {};
