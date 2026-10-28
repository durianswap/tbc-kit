/* This file is generated from the TWS v1 Candidate JSON Schemas. Do not edit by hand. */

type CommonAccountId = (string);

type CommonAddress = (string);

type CommonAtomicAmount = (string);

type CommonBase64 = (string);

type CommonBase64urlNoPadding = (string);

type CommonChainId = (string);

type CommonClientRequestId = (string);

type CommonContractId = CommonHash32;

type CommonDeterministicId = (string);

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

type IntegrationAccountIdentity = ({
  readonly "accountId": CommonAccountId;
  readonly "address": CommonAddress;
  readonly "chainId": CommonChainId;
  readonly "label"?: (string);
  readonly "publicKey": CommonPublicKey;
});

type IntegrationAccountResolutionArtifact = ({
  readonly "params": IntegrationAccountsResolveParams;
  readonly "result": IntegrationAccountsResolveResult;
});

type IntegrationAccountsResolveParams = (unknown) & ({
  readonly "accountIds"?: (readonly (CommonAccountId)[]);
  readonly "chainId": CommonChainId;
  readonly "mode": "available" | "active" | "by-id";
  readonly "version": IntegrationVersion;
});

type IntegrationAccountsResolveResult = ({
  readonly "accounts": (readonly (IntegrationAccountIdentity)[]);
});

type IntegrationAmountLimit = (unknown) & (unknown) & (unknown) & ({
  readonly "contractId"?: CommonContractId;
  readonly "maximum": CommonPositiveAtomicAmount;
  readonly "protocolVersion"?: (string);
  readonly "scope": "native" | "ft-total" | "ft-slot" | "stablecoin-total" | "stablecoin-slot" | "lp-total" | "lp-slot" | "pool-state";
});

type IntegrationApprovalBinding = ({
  readonly "bindingHash": CommonHash32;
  readonly "payload": IntegrationApprovalBindingPayload;
});

type IntegrationApprovalBindingPayload = (unknown) & (unknown) & (unknown) & (unknown) & (unknown) & (unknown) & (unknown) & (unknown) & (unknown) & ({
  readonly "accountId"?: CommonAccountId;
  readonly "chainId"?: CommonChainId;
  readonly "chainIds"?: IntegrationApprovalChainIds;
  readonly "contextHash": CommonHash32;
  readonly "expiresAt": CommonRfc3339;
  readonly "method": IntegrationApprovedProviderMethod;
  readonly "operationHash": CommonHash32;
  readonly "operationKind": IntegrationApprovalOperationKind;
  readonly "origin": (string);
  readonly "requestHash": CommonHash32;
  readonly "sessionId": CommonOpaqueId;
  readonly "version": IntegrationVersion;
});

type IntegrationApprovalChainIds = (readonly (CommonChainId)[]);

type IntegrationApprovalCheckpointData = ({
  readonly "approvalBinding": IntegrationApprovalBinding;
  readonly "approvalPreview": IntegrationApprovalPreview;
});

type IntegrationApprovalOperationKind = "permission" | "switchChain" | "transaction" | "message" | "typedData" | "workflow" | "crypto";

type IntegrationApprovalPreview = (IntegrationTransactionPreview | IntegrationMessagePreview | IntegrationTypedDataPreview | IntegrationPermissionPreview | IntegrationSwitchChainPreview | IntegrationWorkflowPreview | IntegrationCryptoPreview);

type IntegrationApprovalReceipt = ({
  readonly "approvalId": CommonOpaqueId;
  readonly "approvalToken": CommonOpaqueId;
  readonly "approvedAt": CommonRfc3339;
  readonly "bindingHash": CommonHash32;
  readonly "expiresAt": CommonRfc3339;
  readonly "status": "approved";
});

type IntegrationApprovalRejected = ({
  readonly "bindingHash": CommonHash32;
  readonly "rejectedAt": CommonRfc3339;
  readonly "status": "rejected";
});

type IntegrationApprovalRequester = ({
  readonly "frame": "top" | "child";
  readonly "origin": (string);
  readonly "topOrigin": (string);
  readonly "transport": "webview" | "extension" | "remote";
});

type IntegrationApprovalRequestParams = ({
  readonly "binding": IntegrationApprovalBinding;
  readonly "preview": IntegrationApprovalPreview;
  readonly "requester": IntegrationApprovalRequester;
  readonly "version": IntegrationVersion;
});

type IntegrationApprovalRequestResult = (IntegrationApprovalReceipt | IntegrationApprovalRejected);

type IntegrationApprovedProviderMethod = "tbc_signReviewedTransaction" | "tbc_encrypt" | "tbc_decrypt" | "tbc_requestAccounts" | "wallet_requestPermissions" | "tbc_switchChain" | "tbc_signMessage" | "tbc_signTypedData" | "tbc_signTransaction" | "tbc_signPreparedTransaction" | "tbc_sendTransaction" | "tbc_sendPreparedTransaction" | "tbc_signWorkflow" | "tbc_signPreparedWorkflow" | "tbc_sendWorkflow" | "tbc_sendPreparedWorkflow";

type IntegrationAssetFlow = ({
  readonly "amount": CommonAtomicAmount;
  readonly "contractId"?: CommonContractId;
  readonly "direction": "send" | "receive" | "mint" | "create" | "burn" | "lock" | "unlock" | "merge" | "fee" | "contract";
  readonly "from"?: CommonAddress;
  readonly "kind": "native" | "collection" | "ft" | "stablecoin" | "nft" | "lp" | "pool";
  readonly "to"?: CommonAddress;
});

type IntegrationAssetRequirement = ({
  readonly "contractDependency"?: IntegrationContractDependency;
  readonly "contractId"?: CommonContractId;
  readonly "kind": "native" | "collection" | "nft" | "ft" | "stablecoin" | "pool" | "ftlp" | "timelock" | "htlc" | "lop";
  readonly "minimumAmount"?: CommonAtomicAmount;
});

type IntegrationAuthorizingCheckpointData = ({
  readonly "permissionSnapshot": PermissionsPermissionArray;
});

type IntegrationBlockRef = ({
  readonly "hash": CommonHash32;
  readonly "height": CommonUint32String;
  readonly "medianTimePast"?: CommonUint32String;
});

type IntegrationBroadcastAttempt = ({
  readonly "params": IntegrationBroadcastSubmitParams;
  readonly "result"?: IntegrationBroadcastSubmitResult;
});

type IntegrationBroadcastBatchItemResult = ({
  readonly "reason"?: (string);
  readonly "status": "accepted" | "known" | "rejected" | "unknown";
  readonly "txid": CommonTransactionId;
});

type IntegrationBroadcastingCheckpointData = ({
  readonly "finalizedBundle": TransactionSignedTransactionBundle;
});

type IntegrationBroadcastProgress = ({
  readonly "attempts": (readonly (IntegrationBroadcastAttempt)[]);
  readonly "nextTransactionId"?: CommonLocalId;
  readonly "reconciliation"?: IntegrationBroadcastReconcileResult;
  readonly "reconciliationAttempts": (number);
  readonly "submittedTransactionIds": (readonly (CommonTransactionId)[]);
});

type IntegrationBroadcastReconcileParams = ({
  readonly "chainId": CommonChainId;
  readonly "txids": (readonly (CommonTransactionId)[]);
  readonly "version": IntegrationVersion;
});

type IntegrationBroadcastReconcileResult = ({
  readonly "transactions": (readonly (IntegrationBroadcastTransactionStatus)[]);
});

type IntegrationBroadcastSubmitBatchParams = ({
  readonly "chainId": CommonChainId;
  readonly "idempotencyKey": CommonOpaqueId;
  readonly "transactions": (readonly (TransactionSignedTransaction)[]);
  readonly "version": IntegrationVersion;
});

type IntegrationBroadcastSubmitBatchResult = ({
  readonly "transactions": (readonly (IntegrationBroadcastBatchItemResult)[]);
});

type IntegrationBroadcastSubmitParams = ({
  readonly "chainId": CommonChainId;
  readonly "idempotencyKey": CommonOpaqueId;
  readonly "transaction": TransactionSignedTransaction;
  readonly "version": IntegrationVersion;
});

type IntegrationBroadcastSubmitResult = ({
  readonly "reason"?: (string);
  readonly "status": "accepted" | "known" | "rejected";
  readonly "txid": CommonTransactionId;
});

type IntegrationBroadcastTransactionStatus = ({
  readonly "confirmations"?: CommonUint32String;
  readonly "status": "unknown" | "mempool" | "confirmed" | "rejected";
  readonly "txid": CommonTransactionId;
});

type IntegrationCancelInput = (unknown) & ({
  readonly "checkpoint": IntegrationOperationCheckpoint;
  readonly "currentContext"?: IntegrationTrustedContext;
  readonly "currentSession"?: ProviderProviderSessionSnapshot;
  readonly "reason": ProviderCancellationReason;
  readonly "version": IntegrationVersion;
});

type IntegrationCancelledCheckpointData = ({
  readonly "cancellationReason": ProviderCancellationReason;
});

type IntegrationChainDataRequirement = (unknown) & ({
  readonly "assets": (readonly (IntegrationAssetRequirement)[]);
  readonly "certificateOutpoint"?: TransactionCoinTargetOutpoint;
  readonly "collectionSlots"?: (readonly ((number))[]);
  readonly "contractIds"?: (readonly (CommonContractId)[]);
  readonly "includeAncestry": (boolean);
  readonly "inputOutpoints"?: (readonly (({
  readonly "txid": CommonHash32;
  readonly "vout": (number);
}))[]);
  readonly "intentType": IntegrationIntentType;
  readonly "lopAssets"?: (readonly (({
  readonly "contractId": CommonHash32;
  readonly "purpose": "identity" | "escrow";
  readonly "standard": "tbc20-standard" | "tbc20-stablecoin";
}))[]);
  readonly "nativeAmount"?: CommonAtomicAmount;
  readonly "targetOutpoints"?: (readonly (TransactionCoinTargetOutpoint)[]);
});

type IntegrationChainDataResolveParams = (unknown) & ({
  readonly "accountId": CommonAccountId;
  readonly "chainId": CommonChainId;
  readonly "requirement": IntegrationChainDataRequirement;
  readonly "signingAccounts"?: (readonly (IntegrationAccountIdentity)[]);
  readonly "signingRoles"?: (readonly (TransactionSigningRole)[]);
  readonly "version": IntegrationVersion;
  readonly "workflowSteps"?: (readonly (({
  readonly "requirement": IntegrationChainDataRequirement;
  readonly "signingAccounts"?: (readonly (IntegrationAccountIdentity)[]);
  readonly "signingRoles"?: (readonly (TransactionSigningRole)[]);
  readonly "stepId": CommonLocalId;
}))[]);
});

type IntegrationChainDataResolveResult = (IntegrationChainSnapshot | IntegrationWorkflowChainDataResult);

type IntegrationChainSnapshot = ({
  readonly "payload": IntegrationChainSnapshotPayload;
  readonly "snapshotHash": CommonHash32;
});

type IntegrationChainSnapshotPayload = ({
  readonly "account": IntegrationAccountIdentity;
  readonly "block"?: IntegrationBlockRef;
  readonly "capturedAt": CommonRfc3339;
  readonly "chainId": CommonChainId;
  readonly "contracts": (readonly (IntegrationContractRecord)[]);
  readonly "expiresAt": CommonRfc3339;
  readonly "parents": (readonly (IntegrationParentTransaction)[]);
  readonly "signingAccounts"?: (readonly (IntegrationAccountIdentity)[]);
  readonly "snapshotId": CommonOpaqueId;
  readonly "utxos": (readonly (IntegrationUtxo)[]);
  readonly "version": IntegrationVersion;
});

type IntegrationChainSwitchProposal = ({
  readonly "chainSwitchProposalHash": CommonHash32;
  readonly "payload": IntegrationChainSwitchProposalPayload;
});

type IntegrationChainSwitchProposalPayload = ({
  readonly "expectedSessionRevision": IntegrationRevision;
  readonly "expiresAt": CommonRfc3339;
  readonly "fromChainId": CommonChainId;
  readonly "toChainId": CommonChainId;
  readonly "version": IntegrationVersion;
});

type IntegrationClockNowParams = ({
  readonly "version": IntegrationVersion;
});

type IntegrationClockNowResult = ({
  readonly "now": CommonRfc3339;
});

type IntegrationCommitAckInput = ({
  readonly "acknowledgment": ProviderProviderSessionCommitAck;
  readonly "checkpoint": IntegrationOperationCheckpoint;
  readonly "currentContext": IntegrationTrustedContext;
  readonly "currentSession": ProviderProviderSessionSnapshot;
  readonly "version": IntegrationVersion;
});

type IntegrationCommitTransition = ({
  readonly "checkpoint": IntegrationOperationCheckpoint;
  readonly "kind": "commit";
  readonly "mutation": ProviderProviderSessionMutation;
});

type IntegrationCompletedCheckpointData = ({
  readonly "providerCompletion": ProviderProviderCompletion;
});

type IntegrationCompleteFinalizeResult = ({
  readonly "bundle": TransactionSignedTransactionBundle;
  readonly "validation": IntegrationValidationResult;
});

type IntegrationCompleteTransition = ({
  readonly "checkpoint": IntegrationOperationCheckpoint;
  readonly "completion": ProviderProviderCompletion;
  readonly "kind": "complete";
});

type IntegrationContinueTransition = ({
  readonly "checkpoint": (IntegrationOperationCheckpoint) & (({
  readonly "payload": ({
  readonly "pendingCalls": (readonly (unknown)[]);
  readonly "state": "initializing" | "validating" | "authorizing" | "resolving" | "planning" | "approval" | "signing" | "finalizing" | "broadcasting" | "reconciliation" | "committing";
  readonly [key: string]: unknown;
});
  readonly [key: string]: unknown;
}));
  readonly "kind": "continue";
});

type IntegrationContractDependency = ({
  readonly "contractId": CommonContractId;
  readonly "relation": "pool-ft" | "pool-lp";
});

type IntegrationContractExecution = ({
  readonly "businessType": (string);
  readonly "generation": "current" | "historical";
  readonly "implementation": (string);
});

type IntegrationContractPolicy = (unknown) & (unknown) & (unknown) & (unknown) & ({
  readonly "allowedVersions": (readonly ((string))[]);
  readonly "createVersion"?: (string);
  readonly "family": "collection" | "nft" | "ft" | "stablecoin" | "pool";
});

type IntegrationContractRecord = (unknown) & ({
  readonly "contractId": CommonContractId;
  readonly "creationTxid": CommonTransactionId;
  readonly "currentOutpoint": ({
  readonly "txid": CommonTransactionId;
  readonly "vout": (number);
});
  readonly "family": "collection" | "nft" | "ft" | "stablecoin" | "pool";
  readonly "genesisOutpoint"?: ({
  readonly "txid": CommonTransactionId;
  readonly "vout": 0;
});
  readonly "indexedFungible"?: ({
  readonly "codeScript": (string);
  readonly "tapeScript": (string);
  readonly "totalSupply": CommonPositiveAtomicAmount;
});
  readonly "indexedPool"?: ({
  readonly "ftCodeScript": (string);
  readonly "ftTapeScript": (string);
});
  readonly "protocolVersion": (string);
  readonly "standardId"?: "tbc20-standard" | "tbc721-standard" | "tbc20-stablecoin" | "tbc-amm";
  readonly "templateRevision"?: CommonHash32;
});

type IntegrationCoreTransition = (IntegrationContinueTransition | IntegrationWaitingTransition | IntegrationCommitTransition | IntegrationCompleteTransition);

type IntegrationCryptoExecuteParams = ({
  readonly "approval": IntegrationApprovalReceipt;
  readonly "task": IntegrationCryptoTask;
  readonly "version": IntegrationVersion;
});

type IntegrationCryptoExecuteResult = (({
  readonly "algorithm": SigningMessageCryptoAlgorithm;
  readonly "ciphertext": SigningEncryptedMessage;
  readonly "taskId": CommonLocalId;
}) | ({
  readonly "algorithm": SigningMessageCryptoAlgorithm;
  readonly "message": SigningEncodedMessage;
  readonly "taskId": CommonLocalId;
}));

type IntegrationCryptoPreview = (unknown) & ({
  readonly "algorithm": SigningMessageCryptoAlgorithm;
  readonly "ciphertext"?: SigningEncryptedMessage;
  readonly "message"?: SigningEncodedMessage;
  readonly "operationKind": "crypto";
  readonly "purpose": "encrypt" | "decrypt";
  readonly "warnings": (readonly (unknown)[]);
});

type IntegrationCryptoTask = (({
  readonly "accountId": CommonAccountId;
  readonly "algorithm": SigningMessageCryptoAlgorithm;
  readonly "message": SigningEncodedMessage;
  readonly "origin": (string);
  readonly "publicKey": CommonPublicKey;
  readonly "purpose": "encrypt";
  readonly "taskId": CommonLocalId;
}) | ({
  readonly "accountId": CommonAccountId;
  readonly "algorithm": SigningMessageCryptoAlgorithm;
  readonly "ciphertext": SigningEncryptedMessage;
  readonly "origin": (string);
  readonly "publicKey": CommonPublicKey;
  readonly "purpose": "decrypt";
  readonly "taskId": CommonLocalId;
}));

type IntegrationEntropyRandomBytesParams = ({
  readonly "length": (number);
  readonly "version": IntegrationVersion;
});

type IntegrationEntropyRandomBytesResult = ({
  readonly "bytes": CommonBase64urlNoPadding;
});

type IntegrationExecutionPlan = ({
  readonly "payload": IntegrationExecutionPlanPayload;
  readonly "planHash": CommonHash32;
});

type IntegrationExecutionPlanPayload = ({
  readonly "accountId": CommonAccountId;
  readonly "artifacts"?: TransactionArtifacts;
  readonly "chainId": CommonChainId;
  readonly "expiresAt": CommonRfc3339;
  readonly "policyHash": CommonHash32;
  readonly "preview": IntegrationApprovalPreview;
  readonly "requestHash": CommonHash32;
  readonly "signingTasks": (readonly (IntegrationSigningTask)[]);
  readonly "snapshotHash": CommonHash32;
  readonly "transactions": (readonly (IntegrationTransactionTemplate)[]);
  readonly "version": IntegrationVersion;
});

type IntegrationExecutionPolicy = ({
  readonly "payload": IntegrationExecutionPolicyPayload;
  readonly "policyHash": CommonHash32;
});

type IntegrationExecutionPolicyPayload = ({
  readonly "amountLimits": (readonly (IntegrationAmountLimit)[]);
  readonly "chainId": CommonChainId;
  readonly "contractPolicies": (readonly (IntegrationContractPolicy)[]);
  readonly "dustThreshold": CommonAtomicAmount;
  readonly "expiresAt": CommonRfc3339;
  readonly "feeRateSatPerKb": CommonPositiveAtomicAmount;
  readonly "maxBundleTransactions": (number);
  readonly "minConfirmations": CommonUint32String;
  readonly "policyId": CommonOpaqueId;
  readonly "pool"?: IntegrationResolvedPoolPolicy;
  readonly "revision": IntegrationRevision;
  readonly "sighashType": 65;
  readonly "version": IntegrationVersion;
});

type IntegrationFailedCheckpointData = ({
  readonly "providerError": ProviderProviderError;
});

type IntegrationFinalizationStageArtifact = ({
  readonly "continuation": IntegrationFinalizeContinuation;
  readonly "signatureStart": (number);
});

type IntegrationFinalizeContinuation = ({
  readonly "approvalId": CommonOpaqueId;
  readonly "bindingHash": CommonHash32;
  readonly "family": "ft" | "pool" | "stablecoin" | "collection" | "nft";
  readonly "method": "finalize";
  readonly "planHash": CommonHash32;
  readonly "requestHash": CommonHash32;
  readonly "sessionId": (string);
  readonly "signingStage": ({
  readonly [key: string]: unknown;
});
  readonly "stage": (number);
  readonly "stageCommitment": CommonHash32;
  readonly "version": IntegrationVersion;
});

type IntegrationFinalizeParams = ({
  readonly "approval": IntegrationApprovalReceipt;
  readonly "binding": IntegrationApprovalBinding;
  readonly "continuation"?: IntegrationFinalizeContinuation;
  readonly "plan": IntegrationExecutionPlan;
  readonly "policy": IntegrationExecutionPolicy;
  readonly "request": TransactionTransactionRequest;
  readonly "requestHash": CommonHash32;
  readonly "signatures": (readonly (IntegrationSignerSignResult)[]);
  readonly "snapshot": IntegrationChainSnapshot;
  readonly "version": IntegrationVersion;
});

type IntegrationFinalizeResult = (IntegrationCompleteFinalizeResult | IntegrationPendingFinalizeResult);

type IntegrationFinalizingCheckpointData = ({
  readonly "signatures": (readonly (IntegrationSignerSignResult)[]);
});

type IntegrationInitializingCheckpointData = (Record<string, never>);

type IntegrationIntentType = "amm.swap" | "amm.addLiquidity" | "amm.removeLiquidity" | "amm.mergeToken" | "tbc20Lp.transfer" | "tbc20Lp.lock" | "tbc20Lp.unlock" | "tbc20Lp.merge" | "tbc20Lp.burn" | "tbc721.transfer" | "tbc721.batchTransfer" | "tbc20.transfer" | "tbc20.merge" | "tbc20Stablecoin.transfer" | "tbc20Stablecoin.merge" | "tbc.transfer" | "tbc.maintenance.merge" | "tbc.collection.create" | "tbc.nft.mint" | "tbc.nft.transfer" | "tbc.ft.create" | "tbc.ft.transfer" | "tbc.ft.merge" | "tbc20-standard-create" | "tbc20-standard-transfer" | "tbc20-standard-merge" | "tbc20-stablecoin-create" | "tbc20-stablecoin-mint" | "tbc20-stablecoin-freeze" | "tbc20-stablecoin-unfreeze" | "tbc20-stablecoin-transfer" | "tbc20-stablecoin-merge" | "tbc20-lp-transfer" | "tbc20-lp-merge" | "tbc20-lp-lock" | "tbc20-lp-unlock" | "tbc-timelock-lock" | "tbc-timelock-unlock" | "tbc-htlc-lock" | "tbc-htlc-claim" | "tbc-htlc-refund" | "tbc-lop-create" | "tbc-lop-cancel" | "tbc-lop-match" | "tbc-amm-create" | "tbc-amm-add-liquidity" | "tbc-amm-remove-liquidity" | "tbc-amm-swap" | "tbc721-standard-create-collection" | "tbc721-standard-mint" | "tbc721-standard-batch-mint" | "tbc721-standard-transfer" | "tbc.stablecoin.transfer" | "tbc.stablecoin.merge" | "tbc.pool.create" | "tbc.pool.liquidity.add" | "tbc.pool.liquidity.remove" | "tbc.pool.liquidity.close" | "tbc.pool.ft.merge" | "tbc.pool.ftlp.merge" | "tbc.pool.ftlp.burn" | "tbc.pool.swap.exactTbcForToken" | "tbc.pool.swap.exactTokenForTbc";

type IntegrationLopReviewOrders = (({
  readonly "inputs"?: (readonly (unknown)[]);
  readonly [key: string]: unknown;
}) | ({
  readonly "outputs"?: (readonly (unknown)[]);
  readonly [key: string]: unknown;
})) & ({
  readonly "assetIdentityVerified": false;
  readonly "inputs": (readonly (IntegrationLopReviewPosition)[]);
  readonly "outputs": (readonly (IntegrationLopReviewPosition)[]);
  readonly "transactionIndex": (number);
  readonly "verification": "exact-template";
});

type IntegrationLopReviewPosition = ({
  readonly "index": (number);
  readonly "terms": IntegrationLopReviewTerms;
});

type IntegrationLopReviewTerms = (unknown) & ({
  readonly "baseAsset": (({
  readonly "kind": "native";
}) | IntegrationLopReviewToken);
  readonly "feeRate": (string);
  readonly "feeRecipientHash": (string);
  readonly "feeScale": "1000000";
  readonly "market": "native-token" | "token-token";
  readonly "ownerHash": (string);
  readonly "priceScale": "1000000";
  readonly "quoteAsset": IntegrationLopReviewToken;
  readonly "saleVolume": (string);
  readonly "side": "buy" | "sell";
  readonly "standardId": "tbc-lop";
  readonly "unitPrice": (string);
});

type IntegrationLopReviewToken = ({
  readonly "contractId": CommonHash32;
  readonly "kind": "token";
  readonly "partialHash": CommonHash32;
});

type IntegrationMessagePreview = ({
  readonly "digest": CommonHash32;
  readonly "message": SigningEncodedMessage;
  readonly "operationKind": "message";
  readonly "scheme": "tbc-message";
  readonly "signIn"?: SigningSignInDetails;
  readonly "warnings": IntegrationWarningArray;
});

type IntegrationNetworkDisplay = ({
  readonly "name": (string);
  readonly "nativeCurrencySymbol": (string);
});

type IntegrationNormalizeRequestParams = ({
  readonly "request": TransactionTransactionRequest;
  readonly "version": IntegrationVersion;
});

type IntegrationNormalizeRequestResult = ({
  readonly "request": TransactionTransactionRequest;
  readonly "requestHash": CommonHash32;
});

type IntegrationOperationCheckpoint = ({
  readonly "checkpointHash": CommonHash32;
  readonly "payload": IntegrationOperationCheckpointPayload;
});

type IntegrationOperationCheckpointBase = ({
  readonly "context": IntegrationTrustedContext;
  readonly "contextHash": CommonHash32;
  readonly "createdAt"?: CommonRfc3339;
  readonly "data": unknown;
  readonly "expiresAt"?: CommonRfc3339;
  readonly "memory": IntegrationOperationMemory;
  readonly "operation": ProviderNormalizedProviderOperation;
  readonly "operationId": CommonDeterministicId;
  readonly "pendingCalls": (readonly (IntegrationPortCall)[]);
  readonly "previousCheckpointHash"?: CommonHash32;
  readonly "release": IntegrationProtocolRelease;
  readonly "releaseFingerprint": CommonHash32;
  readonly "requestId": ProviderJsonRpcId;
  readonly "revision": IntegrationRevision;
  readonly "session": ProviderProviderSessionSnapshot;
  readonly "state": IntegrationOperationState;
  readonly "updatedAt"?: CommonRfc3339;
  readonly "version": IntegrationVersion;
});

type IntegrationOperationCheckpointPayload = (IntegrationOperationCheckpointBase) & ((({
  readonly "data"?: IntegrationInitializingCheckpointData;
  readonly "pendingCalls"?: (readonly ((IntegrationPortCall) & (({
  readonly "operation"?: "clock.now";
  readonly [key: string]: unknown;
})))[]);
  readonly "previousCheckpointHash"?: never;
  readonly "revision"?: "0";
  readonly "state"?: "initializing";
  readonly [key: string]: unknown;
}) | (IntegrationTrustedCheckpointFields) & ({
  readonly "data"?: IntegrationValidatingCheckpointData;
  readonly "revision"?: (string);
  readonly "state"?: "validating";
  readonly [key: string]: unknown;
}) | (IntegrationTrustedCheckpointFields) & ({
  readonly "data"?: IntegrationAuthorizingCheckpointData;
  readonly "revision"?: (string);
  readonly "state"?: "authorizing";
  readonly [key: string]: unknown;
}) | (IntegrationTrustedCheckpointFields) & ({
  readonly "data"?: IntegrationResolvingCheckpointData;
  readonly "revision"?: (string);
  readonly "state"?: "resolving";
  readonly [key: string]: unknown;
}) | (IntegrationTrustedCheckpointFields) & ({
  readonly "data"?: IntegrationPlanningCheckpointData;
  readonly "revision"?: (string);
  readonly "state"?: "planning";
  readonly [key: string]: unknown;
}) | (IntegrationTrustedCheckpointFields) & ({
  readonly "data"?: IntegrationApprovalCheckpointData;
  readonly "revision"?: (string);
  readonly "state"?: "approval";
  readonly [key: string]: unknown;
}) | (IntegrationTrustedCheckpointFields) & ({
  readonly "data"?: IntegrationSigningCheckpointData;
  readonly "revision"?: (string);
  readonly "state"?: "signing";
  readonly [key: string]: unknown;
}) | (IntegrationTrustedCheckpointFields) & ({
  readonly "data"?: IntegrationFinalizingCheckpointData;
  readonly "revision"?: (string);
  readonly "state"?: "finalizing";
  readonly [key: string]: unknown;
}) | (IntegrationTrustedCheckpointFields) & ({
  readonly "data"?: IntegrationBroadcastingCheckpointData;
  readonly "revision"?: (string);
  readonly "state"?: "broadcasting";
  readonly [key: string]: unknown;
}) | (IntegrationTrustedCheckpointFields) & ({
  readonly "data"?: IntegrationReconciliationCheckpointData;
  readonly "revision"?: (string);
  readonly "state"?: "reconciliation";
  readonly [key: string]: unknown;
}) | (({
  readonly "data"?: IntegrationPermissionStoreCommittingCheckpointData;
  readonly "pendingCalls"?: (readonly ((IntegrationPortCall) & (({
  readonly "operation"?: "clock.now" | "permissionStore.commit";
  readonly [key: string]: unknown;
})))[]);
  readonly [key: string]: unknown;
}) | ({
  readonly "data"?: IntegrationProviderSessionCommittingCheckpointData;
  readonly "pendingCalls"?: (readonly ((IntegrationPortCall) & (({
  readonly "operation"?: "clock.now";
  readonly [key: string]: unknown;
})))[]);
  readonly [key: string]: unknown;
})) & (IntegrationTrustedCheckpointFields) & ({
  readonly "revision"?: (string);
  readonly "state"?: "committing";
  readonly [key: string]: unknown;
}) | (IntegrationTrustedCheckpointFields) & ({
  readonly "data"?: IntegrationCompletedCheckpointData;
  readonly "pendingCalls"?: (readonly (unknown)[]);
  readonly "revision"?: (string);
  readonly "state"?: "completed";
  readonly [key: string]: unknown;
}) | (IntegrationTrustedCheckpointFields) & ({
  readonly "data"?: IntegrationRejectedCheckpointData;
  readonly "pendingCalls"?: (readonly (unknown)[]);
  readonly "revision"?: (string);
  readonly "state"?: "rejected";
  readonly [key: string]: unknown;
}) | (({
  readonly "createdAt"?: never;
  readonly "expiresAt"?: never;
  readonly "memory"?: ({
  readonly [key: string]: unknown;
});
  readonly "revision"?: "1";
  readonly "updatedAt"?: never;
  readonly [key: string]: unknown;
}) | (IntegrationTrustedCheckpointFields) & ({
  readonly "revision"?: (string);
  readonly [key: string]: unknown;
})) & ({
  readonly "data"?: IntegrationFailedCheckpointData;
  readonly "pendingCalls"?: (readonly (unknown)[]);
  readonly "state"?: "failed";
  readonly [key: string]: unknown;
}) | (({
  readonly "createdAt"?: never;
  readonly "expiresAt"?: never;
  readonly "memory"?: ({
  readonly [key: string]: unknown;
});
  readonly "revision"?: "1";
  readonly "updatedAt"?: never;
  readonly [key: string]: unknown;
}) | (IntegrationTrustedCheckpointFields) & ({
  readonly "revision"?: (string);
  readonly [key: string]: unknown;
})) & ({
  readonly "data"?: IntegrationCancelledCheckpointData;
  readonly "pendingCalls"?: (readonly (unknown)[]);
  readonly "state"?: "cancelled";
  readonly [key: string]: unknown;
})));

type IntegrationOperationMemory = ({
  readonly "accountResolutions"?: (readonly (IntegrationAccountResolutionArtifact)[]);
  readonly "approvalBinding"?: IntegrationApprovalBinding;
  readonly "approvalPreview"?: IntegrationApprovalPreview;
  readonly "approvalReceipt"?: IntegrationApprovalReceipt;
  readonly "broadcastProgress"?: IntegrationBroadcastProgress;
  readonly "chainSnapshot"?: IntegrationChainSnapshot;
  readonly "chainSwitchProposal"?: IntegrationChainSwitchProposal;
  readonly "cryptoResults"?: (readonly (IntegrationCryptoExecuteResult)[]);
  readonly "executionPlan"?: IntegrationExecutionPlan;
  readonly "executionPolicy"?: IntegrationExecutionPolicy;
  readonly "finalizationStages"?: (readonly (IntegrationFinalizationStageArtifact)[]);
  readonly "finalizedBundle"?: TransactionSignedTransactionBundle;
  readonly "messageEnvelope"?: SigningMessageEnvelope;
  readonly "normalizedTransaction"?: IntegrationNormalizeRequestResult;
  readonly "permissionCommit"?: IntegrationPermissionCommitArtifact;
  readonly "permissionLoads"?: (readonly (IntegrationPermissionLoadArtifact)[]);
  readonly "permissionProposal"?: IntegrationPermissionProposal;
  readonly "preparedTransaction"?: PreparedTransactionPreparedTransactionRequest;
  readonly "providerCompletion"?: ProviderProviderCompletion;
  readonly "providerSessionCommitAck"?: ProviderProviderSessionCommitAck;
  readonly "providerSessionMutation"?: ProviderProviderSessionMutation;
  readonly "requestHash"?: CommonHash32;
  readonly "reviewedTransactionResults"?: (readonly (IntegrationReviewedTransactionExecuteResult)[]);
  readonly "reviewedTransactionReviews"?: (readonly (IntegrationReviewedTransactionReviewArtifact)[]);
  readonly "signatures"?: (readonly (IntegrationSignerSignResult)[]);
  readonly "signingTasks"?: (readonly (IntegrationSecretTask)[]);
  readonly "trustedTime"?: CommonRfc3339;
  readonly "typedDataEnvelope"?: SigningTypedDataEnvelope;
  readonly "walletActionPlan"?: IntegrationWalletActionPlan;
  readonly "workflowPlan"?: WorkflowWorkflowPlan;
  readonly "workflowPolicies"?: (readonly (({
  readonly "policy": IntegrationExecutionPolicy;
  readonly "stepId": CommonLocalId;
}))[]);
  readonly "workflowProgress"?: WorkflowWorkflowProgress;
  readonly "workflowResult"?: WorkflowResult;
  readonly "workflowSnapshots"?: IntegrationWorkflowChainDataResult;
});

type IntegrationOperationName = "accounts.resolve" | "chainData.resolve" | "policy.resolve" | "permissionStore.load" | "permissionStore.commit" | "approval.request" | "signer.sign" | "crypto.execute" | "reviewedTransaction.review" | "reviewedTransaction.execute" | "broadcast.submit" | "broadcast.submitBatch" | "broadcast.reconcile" | "clock.now" | "entropy.randomBytes";

type IntegrationOperationState = "initializing" | "validating" | "authorizing" | "resolving" | "planning" | "approval" | "signing" | "finalizing" | "broadcasting" | "reconciliation" | "committing" | "completed" | "rejected" | "failed" | "cancelled";

type IntegrationParentTransaction = ({
  readonly "rawTransaction": CommonRawTransaction;
  readonly "txid": CommonTransactionId;
});

type IntegrationPendingFinalizeResult = ({
  readonly "continuation": IntegrationFinalizeContinuation;
  readonly "signingRequests": (readonly (IntegrationTransactionSigningTask)[]);
  readonly "status": "pending";
});

type IntegrationPermissionCommitArtifact = ({
  readonly "params": IntegrationPermissionStoreCommitParams;
  readonly "result"?: IntegrationPermissionStoreCommitResult;
});

type IntegrationPermissionDecision = ({
  readonly "capability": PermissionsPermissionName;
  readonly "reason": (string);
  readonly "status": "granted" | "narrowed" | "rejected";
});

type IntegrationPermissionGrantPreview = ({
  readonly "accountIds": (readonly (CommonAccountId)[]);
  readonly "capability": PermissionsPermissionName;
  readonly "chainId": CommonChainId;
  readonly "expiresAt"?: CommonRfc3339;
  readonly "methods": (readonly (PermissionsPermissionName)[]);
});

type IntegrationPermissionLoadArtifact = ({
  readonly "result": IntegrationPermissionStoreLoadResult;
  readonly "scope": IntegrationPermissionScope;
});

type IntegrationPermissionPreview = ({
  readonly "decisions": (readonly (IntegrationPermissionDecision)[]);
  readonly "granted": (readonly (IntegrationPermissionGrantPreview)[]);
  readonly "operationKind": "permission";
  readonly "requested": PermissionsRequestPermissionsParams;
  readonly "warnings": IntegrationWarningArray;
});

type IntegrationPermissionProposal = ({
  readonly "payload": IntegrationPermissionProposalPayload;
  readonly "permissionProposalHash": CommonHash32;
});

type IntegrationPermissionProposalPayload = ({
  readonly "changes": (readonly (IntegrationPermissionStoreChange)[]);
  readonly "createdAt": CommonRfc3339;
  readonly "decisions": (readonly (IntegrationPermissionDecision)[]);
  readonly "expiresAt": CommonRfc3339;
  readonly "origin": (string);
  readonly "requested": PermissionsRequestPermissionsParams;
  readonly "version": IntegrationVersion;
});

type IntegrationPermissionScope = ({
  readonly "chainId": CommonChainId;
  readonly "origin": (string);
});

type IntegrationPermissionStoreChange = ({
  readonly "expectedRevision": IntegrationRevision;
  readonly "permissions": PermissionsPermissionArray;
  readonly "scope": IntegrationPermissionScope;
});

type IntegrationPermissionStoreCommitParams = ({
  readonly "changes": (readonly (IntegrationPermissionStoreChange)[]);
  readonly "version": IntegrationVersion;
});

type IntegrationPermissionStoreCommitResult = ({
  readonly "revisions": (readonly (IntegrationPermissionStoreRevision)[]);
});

type IntegrationPermissionStoreCommittingCheckpointData = ({
  readonly "kind": "permission-store";
  readonly "permissionCommit": IntegrationPermissionCommitArtifact;
});

type IntegrationPermissionStoreLoadParams = ({
  readonly "scope": IntegrationPermissionScope;
  readonly "version": IntegrationVersion;
});

type IntegrationPermissionStoreLoadResult = ({
  readonly "permissions": PermissionsPermissionArray;
  readonly "revision": IntegrationRevision;
});

type IntegrationPermissionStoreRevision = ({
  readonly "revision": IntegrationRevision;
  readonly "scope": IntegrationPermissionScope;
});

type IntegrationPlanningCheckpointData = ({
  readonly "requestHash": CommonHash32;
});

type IntegrationPlanParams = ({
  readonly "policy": IntegrationExecutionPolicy;
  readonly "request": TransactionTransactionRequest;
  readonly "requestHash": CommonHash32;
  readonly "snapshot": IntegrationChainSnapshot;
  readonly "version": IntegrationVersion;
});

type IntegrationPlanResult = ({
  readonly "plan": IntegrationExecutionPlan;
});

type IntegrationPolicyResolveParams = ({
  readonly "request": TransactionTransactionRequest;
  readonly "requestHash": CommonHash32;
  readonly "snapshotHash": CommonHash32;
  readonly "version": IntegrationVersion;
});

type IntegrationPolicyResolveResult = IntegrationExecutionPolicy;

type IntegrationPortCall = ({
  readonly "callId": CommonDeterministicId;
  readonly "operation": IntegrationOperationName;
  readonly "params": unknown;
  readonly "version": IntegrationVersion;
});

type IntegrationPortError = ({
  readonly "details"?: ({
  readonly [key: string]: unknown;
});
  readonly "message": (string);
  readonly "name": IntegrationPortErrorName;
  readonly "retryable": (boolean);
});

type IntegrationPortErrorName = "INVALID_INPUT" | "UNAVAILABLE" | "NOT_FOUND" | "CONFLICT" | "UNAUTHORIZED" | "REJECTED" | "SIGNATURE_FAILED" | "BROADCAST_REJECTED" | "INTERNAL_ERROR";

type IntegrationPortFailure = ({
  readonly "callId": CommonDeterministicId;
  readonly "error": IntegrationPortError;
  readonly "version": IntegrationVersion;
});

type IntegrationPortResponse = (IntegrationPortSuccess | IntegrationPortFailure);

type IntegrationPortSuccess = ({
  readonly "callId": CommonDeterministicId;
  readonly "result": unknown;
  readonly "version": IntegrationVersion;
});

type IntegrationPreviewWarning = "EXTERNAL_CONTENT" | "NEW_CONTRACT" | "UNVERIFIED_CONTRACT" | "PRICE_IMPACT" | "LOCKED_ASSET" | "IRREVERSIBLE_BURN" | "MULTI_TRANSACTION" | "MAINTENANCE_TRANSACTION" | "PARTIAL_BROADCAST_POSSIBLE" | "MESSAGE_DOMAIN_UNVERIFIED" | "TYPED_DATA_COMPLEX" | "PERMISSION_NARROWED" | "PERMISSION_REJECTED" | "CHAIN_SWITCH" | "DYNAMIC_BINDING" | "FT_MINT_V4" | "HTLC_CLAIM_SIGNED_BYTES_DISCLOSE_PREIMAGE";

type IntegrationProtocolRelease = ({
  readonly "registryBundleSha256": CommonHash32;
  readonly "schemaBundleSha256": CommonHash32;
  readonly "version": (string);
});

type IntegrationProviderSessionCommittingCheckpointData = ({
  readonly "kind": "provider-session";
  readonly "providerSessionMutation": ProviderProviderSessionMutation;
});

type IntegrationReconciliationCheckpointData = ({
  readonly "submittedTransactionIds": (readonly (CommonTransactionId)[]);
});

type IntegrationRecoverableSignatureResult = ({
  readonly "signature": (string);
  readonly "signatureEncoding": "compact65-recoverable";
  readonly "taskId": CommonLocalId;
});

type IntegrationRecoverableSigningTask = ({
  readonly "accountId": CommonAccountId;
  readonly "algorithm": "secp256k1-recoverable-ecdsa-sha256d";
  readonly "digest": CommonHash32;
  readonly "origin": (string);
  readonly "publicKey": CommonPublicKey;
  readonly "purpose": "message" | "typedData";
  readonly "signatureEncoding": "compact65-recoverable";
  readonly "taskId": CommonLocalId;
});

type IntegrationRejectedCheckpointData = ({
  readonly "cancellationReason": "USER_REJECTED";
});

type IntegrationResolvedPoolPolicy = ({
  readonly "lpPlan": (number);
  readonly "serviceFeeRate": (number);
  readonly "serviceProviderTag": (string);
});

type IntegrationResolvedTransactionSigningRoles = (readonly (({
  readonly "account": IntegrationAccountIdentity;
  readonly "role": "pool-controller" | "coin-admin";
}))[]);

type IntegrationResolvingCheckpointData = ({
  readonly "resolvedInputs": ({
  readonly "account"?: IntegrationAccountIdentity;
});
});

type IntegrationResumeInput = (unknown) & ({
  readonly "checkpoint": IntegrationOperationCheckpoint;
  readonly "currentContext": IntegrationTrustedContext;
  readonly "currentSession": ProviderProviderSessionSnapshot;
  readonly "response"?: IntegrationPortResponse;
  readonly "version": IntegrationVersion;
});

type IntegrationReviewedCoinLock = ((({
  readonly "controller"?: never;
  readonly "owner": unknown;
  readonly [key: string]: unknown;
}) | ({
  readonly "controller": unknown;
  readonly "owner"?: never;
  readonly [key: string]: unknown;
}))) & (unknown) & (unknown) & (unknown) & (unknown) & (unknown) & (unknown) & ({
  readonly "amount": CommonAtomicAmount;
  readonly "authorization"?: "administrator";
  readonly "chainMaturityChecked": false;
  readonly "contractId": CommonHash32;
  readonly "controller"?: ({
  readonly "hash": (string);
  readonly "type": "contract";
});
  readonly "domain": "none" | "height" | "timestamp";
  readonly "index": (number);
  readonly "lockTime": (number);
  readonly "owner"?: CommonAddress;
  readonly "position": "input" | "output";
  readonly "scriptLockChecked": (boolean);
  readonly "sequence"?: (number);
  readonly "transactionIndex": (number);
  readonly "transactionLockTime": (number);
});

type IntegrationReviewedHtlcEscrowToken = ({
  readonly "amount": CommonAtomicAmount;
  readonly "coinInputLockChecked"?: (boolean);
  readonly "coinLockTime"?: (number);
  readonly "contractId": CommonHash32;
  readonly "index": (number);
  readonly "standardId": "tbc20-standard" | "tbc20-stablecoin";
});

type IntegrationReviewedHtlcLock = (unknown) & (unknown) & (unknown) & (unknown) & (unknown) & ({
  readonly "amount": CommonAtomicAmount;
  readonly "branch": "unresolved" | "claim" | "refund";
  readonly "chainMaturityChecked": false;
  readonly "domain": "height" | "timestamp";
  readonly "escrowToken"?: IntegrationReviewedHtlcEscrowToken;
  readonly "hashlock": CommonHash32;
  readonly "index": (number);
  readonly "lockTime": (number);
  readonly "position": "input" | "output";
  readonly "preimageVerified": (boolean);
  readonly "receiver": CommonAddress;
  readonly "scriptExecutionVerified": false;
  readonly "sender": CommonAddress;
  readonly "sequence"?: (number);
  readonly "transactionIndex": (number);
  readonly "transactionLockTime": (number);
  readonly "verification": "exact-template";
});

type IntegrationReviewedTimeLock = ({
  readonly "amount": CommonAtomicAmount;
  readonly "chainMaturityChecked": false;
  readonly "domain": "height";
  readonly "index": (number);
  readonly "lockHeight": (number);
  readonly "owner": CommonAddress;
  readonly "position": "input" | "output";
  readonly "scriptExecutionVerified": false;
  readonly "scriptLockChecked": (boolean);
  readonly "sequence"?: (number);
  readonly "transactionIndex": (number);
  readonly "transactionLockTime": (number);
  readonly "verification": "exact-template";
});

type IntegrationReviewedTransactionExecuteParams = ({
  readonly "approval": IntegrationApprovalReceipt;
  readonly "task": IntegrationReviewedTransactionTask;
  readonly "version": IntegrationVersion;
});

type IntegrationReviewedTransactionExecuteResult = ({
  readonly "bundle": TransactionSignedTransactionBundle;
  readonly "reviewHash": CommonHash32;
  readonly "taskId": CommonLocalId;
});

type IntegrationReviewedTransactionPolicyMaterial = ({
  readonly "resolvedOutputs": (readonly (({
  readonly "satoshis": (string);
  readonly "scriptPubKey": (string);
  readonly "txid": CommonHash32;
  readonly "vout": (number);
}))[]);
});

type IntegrationReviewedTransactionReviewArtifact = ({
  readonly "payload": IntegrationReviewedTransactionReviewPayload;
  readonly "reviewHash": CommonHash32;
  readonly "stepId": CommonLocalId;
});

type IntegrationReviewedTransactionReviewParams = ({
  readonly "accountId": CommonAccountId;
  readonly "chainId": CommonChainId;
  readonly "contextHash": CommonHash32;
  readonly "origin": (string);
  readonly "publicKey": CommonPublicKey;
  readonly "request": ReviewedTransactionRequest;
  readonly "requestHash": CommonHash32;
  readonly "sessionId": CommonOpaqueId;
  readonly "signingRoles"?: IntegrationResolvedTransactionSigningRoles;
  readonly "taskId": CommonLocalId;
  readonly "version": IntegrationVersion;
});

type IntegrationReviewedTransactionReviewPayload = ({
  readonly "expiresAt": CommonRfc3339;
  readonly "policyMaterial": IntegrationReviewedTransactionPolicyMaterial;
  readonly "preview": IntegrationTransactionPreview;
  readonly "totalFee": CommonAtomicAmount;
});

type IntegrationReviewedTransactionReviewResult = ({
  readonly "payload": IntegrationReviewedTransactionReviewPayload;
  readonly "reviewHash": CommonHash32;
});

type IntegrationReviewedTransactionTask = ({
  readonly "accountId": CommonAccountId;
  readonly "chainId": CommonChainId;
  readonly "contextHash": CommonHash32;
  readonly "policyMaterial": IntegrationReviewedTransactionPolicyMaterial;
  readonly "publicKey": CommonPublicKey;
  readonly "purpose": "reviewedTransaction";
  readonly "request": ReviewedTransactionRequest;
  readonly "requestHash": CommonHash32;
  readonly "reviewHash": CommonHash32;
  readonly "signingRoles"?: IntegrationResolvedTransactionSigningRoles;
  readonly "taskId": CommonLocalId;
});

type IntegrationRevision = (string);

type IntegrationSecretTask = (IntegrationSigningTask | IntegrationCryptoTask | IntegrationReviewedTransactionTask);

type IntegrationSignerSignParams = ({
  readonly "approval": IntegrationApprovalReceipt;
  readonly "task": IntegrationSigningTask;
  readonly "version": IntegrationVersion;
});

type IntegrationSignerSignResult = (IntegrationTransactionSignatureResult | IntegrationRecoverableSignatureResult);

type IntegrationSigningCheckpointData = ({
  readonly "approvalReceipt": IntegrationApprovalReceipt;
  readonly "signingTask": IntegrationSecretTask;
});

type IntegrationSigningTask = (IntegrationTransactionSigningTask | IntegrationRecoverableSigningTask);

type IntegrationStartInput = ({
  readonly "currentContext": IntegrationTrustedContext;
  readonly "currentSession": ProviderProviderSessionSnapshot;
  readonly "release": IntegrationProtocolRelease;
  readonly "request": ProviderRequest;
  readonly "version": IntegrationVersion;
});

type IntegrationSwitchChainPreview = ({
  readonly "fromChainId": CommonChainId;
  readonly "network": IntegrationNetworkDisplay;
  readonly "operationKind": "switchChain";
  readonly "toChainId": CommonChainId;
  readonly "warnings": IntegrationWarningArray;
});

type IntegrationTransactionOutputReview = ({
  readonly "amountAtomic"?: CommonAtomicAmount;
  readonly "assetIdentity"?: (string);
  readonly "kind": (string);
  readonly "lockTime"?: (number);
  readonly "nativeValueAtomic": CommonAtomicAmount;
  readonly "outputIndices": (readonly ((number))[]);
  readonly "recipient"?: (string);
  readonly "warnings": (readonly ((string))[]);
});

type IntegrationTransactionPreview = (unknown) & (unknown) & ({
  readonly "artifactIds"?: (readonly (CommonHash32)[]);
  readonly "assetFlows": (readonly (IntegrationAssetFlow)[]);
  readonly "coinLocks"?: (readonly (IntegrationReviewedCoinLock)[]);
  readonly "contractExecution"?: IntegrationContractExecution;
  readonly "contractIds"?: (readonly (CommonContractId)[]);
  readonly "htlcLocks"?: (readonly (IntegrationReviewedHtlcLock)[]);
  readonly "irreversible": (boolean);
  readonly "lopOrders"?: (readonly (IntegrationLopReviewOrders)[]);
  readonly "operationKind": "transaction";
  readonly "signingRoles"?: IntegrationResolvedTransactionSigningRoles;
  readonly "signingTaskCount"?: (number);
  readonly "timeLocks"?: (readonly (IntegrationReviewedTimeLock)[]);
  readonly "totalFee": CommonAtomicAmount;
  readonly "transactionCount": (number);
  readonly "warnings": IntegrationWarningArray;
});

type IntegrationTransactionSignatureResult = ({
  readonly "signature": (string);
  readonly "signatureEncoding": "compact64" | "schnorr64";
  readonly "taskId": CommonLocalId;
});

type IntegrationTransactionSigningTask = ((({
  readonly "algorithm"?: "secp256k1-ecdsa-sha256d";
  readonly "publicKey"?: CommonPublicKey;
  readonly "signatureEncoding"?: "compact64";
  readonly [key: string]: unknown;
}) | ({
  readonly "algorithm"?: "secp256k1-schnorr-bip340";
  readonly "publicKey"?: (string);
  readonly "signatureEncoding"?: "schnorr64";
  readonly [key: string]: unknown;
}))) & ({
  readonly "accountId": CommonAccountId;
  readonly "algorithm": "secp256k1-ecdsa-sha256d" | "secp256k1-schnorr-bip340";
  readonly "digest": CommonHash32;
  readonly "inputIndex": (number);
  readonly "publicKey": (string);
  readonly "purpose": "transaction";
  readonly "sighashType": 65;
  readonly "signatureEncoding": "compact64" | "schnorr64";
  readonly "taskId": CommonLocalId;
  readonly "transactionTemplateId": CommonLocalId;
});

type IntegrationTransactionTemplate = ({
  readonly "deferredInputs"?: (readonly (PreparedTransactionDeferredInput)[]);
  readonly "dependsOn": (readonly (CommonLocalId)[]);
  readonly "fee": CommonAtomicAmount;
  readonly "id": CommonLocalId;
  readonly "outputReview"?: (readonly (IntegrationTransactionOutputReview)[]);
  readonly "role": "primary" | "prerequisite" | "maintenance";
  readonly "templateHash": CommonHash32;
  readonly "unsignedTransaction": CommonRawTransaction;
});

type IntegrationTrustedCheckpointFields = ({
  readonly "createdAt": CommonRfc3339;
  readonly "expiresAt": CommonRfc3339;
  readonly "previousCheckpointHash": CommonHash32;
  readonly "updatedAt": CommonRfc3339;
  readonly [key: string]: unknown;
});

type IntegrationTrustedContext = (unknown) & ({
  readonly "createdAt": CommonRfc3339;
  readonly "frame": "top" | "child";
  readonly "navigationId"?: CommonOpaqueId;
  readonly "origin": (string);
  readonly "sessionId": CommonOpaqueId;
  readonly "topOrigin": (string);
  readonly "transport": "webview" | "extension" | "remote";
});

type IntegrationTypedDataPreview = ({
  readonly "digest": CommonHash32;
  readonly "domain": SigningDappTypedDomain;
  readonly "message": SigningTypedMessage;
  readonly "operationKind": "typedData";
  readonly "primaryType": (string);
  readonly "scheme": "tbc-typed-data";
  readonly "types": SigningTypeMap;
  readonly "warnings": IntegrationWarningArray;
});

type IntegrationUtxo = ({
  readonly "classification": "native" | "collection-slot" | "nft" | "ft" | "stablecoin" | "pool" | "pool-ft" | "pool-source" | "ftlp" | "timelock" | "htlc" | "lop";
  readonly "confirmations"?: CommonUint32String;
  readonly "contractId"?: CommonContractId;
  readonly "satoshis": CommonPositiveAtomicAmount;
  readonly "scriptPubKey": CommonRawTransaction;
  readonly "txid": CommonTransactionId;
  readonly "vout": (number);
});

type IntegrationValidateParams = ({
  readonly "approval"?: IntegrationApprovalReceipt;
  readonly "binding"?: IntegrationApprovalBinding;
  readonly "bundle"?: TransactionSignedTransactionBundle;
  readonly "continuation"?: IntegrationFinalizeContinuation;
  readonly "pending"?: IntegrationPendingFinalizeResult;
  readonly "phase": IntegrationValidationPhase;
  readonly "plan": IntegrationExecutionPlan;
  readonly "policy": IntegrationExecutionPolicy;
  readonly "request": TransactionTransactionRequest;
  readonly "requestHash": CommonHash32;
  readonly "signatures"?: (readonly (IntegrationSignerSignResult)[]);
  readonly "snapshot": IntegrationChainSnapshot;
  readonly "version": IntegrationVersion;
});

type IntegrationValidatingCheckpointData = ({
  readonly "trustedTime": CommonRfc3339;
});

type IntegrationValidationPhase = "plan" | "pre-sign" | "finalized" | "pre-broadcast";

type IntegrationValidationResult = (unknown) & ({
  readonly "valid": (boolean);
  readonly "violations": (readonly (IntegrationValidationViolation)[]);
});

type IntegrationValidationViolation = ({
  readonly "code": IntegrationViolationCode;
  readonly "path"?: (string);
  readonly "taskId"?: CommonLocalId;
  readonly "transactionTemplateId"?: CommonLocalId;
});

type IntegrationVersion = "1.0";

type IntegrationViolationCode = "REQUEST_HASH_MISMATCH" | "SNAPSHOT_HASH_MISMATCH" | "POLICY_HASH_MISMATCH" | "PLAN_HASH_MISMATCH" | "APPROVAL_BINDING_MISMATCH" | "PLAN_EXPIRED" | "SNAPSHOT_EXPIRED" | "CHAIN_MISMATCH" | "ACCOUNT_MISMATCH" | "INPUT_NOT_IN_SNAPSHOT" | "INPUT_ALREADY_SPENT" | "ANCESTRY_INVALID" | "UNSUPPORTED_CONTRACT_VERSION" | "AMOUNT_OUT_OF_RANGE" | "BUSINESS_OUTPUT_MISMATCH" | "MINIMUM_OUTPUT_NOT_MET" | "CHANGE_NOT_CONTROLLED" | "FEE_MISMATCH" | "FEE_LIMIT_EXCEEDED" | "DEPENDENCY_INVALID" | "SIGNING_TASK_MISMATCH" | "SIGNATURE_INVALID" | "TXID_MISMATCH" | "ARTIFACT_MISMATCH" | "BUNDLE_LIMIT_EXCEEDED" | "SECRET_FIELD_PRESENT";

type IntegrationWaitingTransition = ({
  readonly "calls": (readonly (IntegrationPortCall)[]);
  readonly "checkpoint": IntegrationOperationCheckpoint;
  readonly "kind": "waiting";
});

type IntegrationWalletActionPlan = ({
  readonly "payload": ({
  readonly "accountId": CommonAccountId;
  readonly "chainId": CommonChainId;
  readonly "contextHash": CommonHash32;
  readonly "expiresAt": CommonRfc3339;
  readonly "preview": (IntegrationCryptoPreview | IntegrationTransactionPreview);
  readonly "requestHash": CommonHash32;
  readonly "review"?: IntegrationReviewedTransactionReviewResult;
  readonly "task": (IntegrationCryptoTask | IntegrationReviewedTransactionTask);
});
  readonly "planHash": CommonHash32;
});

type IntegrationWarningArray = (readonly (IntegrationPreviewWarning)[]);

type IntegrationWorkflowChainDataResult = ({
  readonly "steps": (readonly (({
  readonly "snapshot": IntegrationChainSnapshot;
  readonly "stepId": CommonLocalId;
}))[]);
  readonly "version": IntegrationVersion;
});

type IntegrationWorkflowPreview = ({
  readonly "bindings": (readonly (IntegrationWorkflowPreviewBinding)[]);
  readonly "failureMode": "atomic" | "continue-independent";
  readonly "operationKind": "workflow";
  readonly "signingRoles"?: (readonly (({
  readonly "account": IntegrationAccountIdentity;
  readonly "role": "pool-controller" | "coin-admin";
  readonly "stepId": CommonLocalId;
}))[]);
  readonly "steps": (readonly (IntegrationWorkflowPreviewStep)[]);
  readonly "totalFee": CommonAtomicAmount;
  readonly "warnings": IntegrationWarningArray;
});

type IntegrationWorkflowPreviewBinding = ({
  readonly "sourceOutput": "transactionIds" | "primaryTransactionId" | "artifacts.collectionId" | "artifacts.contractId" | "artifacts.poolContractId";
  readonly "sourceStepId": CommonLocalId;
  readonly "target": (string);
  readonly "targetType": "bytes32" | "bytes32[]" | "json-string-array";
});

type IntegrationWorkflowPreviewStep = ({
  readonly "algorithm"?: SigningMessageCryptoAlgorithm;
  readonly "assetFlows"?: (readonly (IntegrationAssetFlow)[]);
  readonly "ciphertext"?: SigningEncryptedMessage;
  readonly "dependsOn": (readonly (CommonLocalId)[]);
  readonly "id": CommonLocalId;
  readonly "kind": "transaction" | "preparedTransaction" | "reviewedTransaction" | "message" | "typedData" | "encrypt" | "decrypt";
  readonly "message"?: SigningEncodedMessage;
  readonly "reviewedTransactionPreview"?: IntegrationTransactionPreview;
  readonly "typedData"?: SigningTypedData;
});

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

type ProviderCancellationReason = "USER_REJECTED" | "REQUEST_ABORTED" | "REQUEST_EXPIRED" | "SESSION_REVOKED" | "NAVIGATION_CHANGED" | "ORIGIN_CHANGED" | "CHAIN_CHANGED" | "ACCOUNT_CHANGED" | "TRANSPORT_CLOSED" | "SNAPSHOT_INVALIDATED" | "PROTOCOL_RELEASE_CHANGED";

type ProviderErrorResponse = ({
  readonly "error": ProviderProviderError;
  readonly "id": ProviderJsonRpcResponseId;
  readonly "jsonrpc": "2.0";
});

type ProviderJsonRpcId = ((string) | (number));

type ProviderJsonRpcResponseId = (ProviderJsonRpcId | (null));

type ProviderNormalizedProviderOperation = ({
  readonly "method": (string);
  readonly "params": (({
  readonly [key: string]: unknown;
}) | (readonly (unknown)[]));
});

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

type ProviderProviderSessionCommitAck = ({
  readonly "commitId": CommonDeterministicId;
  readonly "revision": (string);
  readonly "status": "committed";
  readonly "version": "1.0";
});

type ProviderProviderSessionMutation = ({
  readonly "commitId": CommonDeterministicId;
  readonly "payload": ProviderProviderSessionMutationPayload;
});

type ProviderProviderSessionMutationPayload = ({
  readonly "events": (readonly (ProviderProviderEvent)[]);
  readonly "expectedRevision": (string);
  readonly "scope": ProviderProviderSessionScope;
  readonly "target": ProviderProviderSessionState;
  readonly "version": "1.0";
});

type ProviderProviderSessionScope = ({
  readonly "sessionId": CommonOpaqueId;
  readonly "walletProfile": (string);
});

type ProviderProviderSessionSnapshot = ({
  readonly "scope": ProviderProviderSessionScope;
  readonly "state": ProviderProviderSessionState;
  readonly "version": "1.0";
});

type ProviderProviderSessionState = ({
  readonly "activeAccountIds": (readonly (CommonAccountId)[]);
  readonly "activeChainId": CommonChainId;
  readonly "connected": (boolean);
  readonly "revision": (string);
  readonly "sessionId": CommonOpaqueId;
  readonly "version": "1.0";
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

type SigningSignInDetails = ({
  readonly "address": CommonAddress;
  readonly "chainId": CommonChainId;
  readonly "domain": (string);
  readonly "expirationTime": CommonRfc3339;
  readonly "issuedAt": CommonRfc3339;
  readonly "nonce": (string);
  readonly "statement"?: (string);
  readonly "uri": (string);
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

type TransactionFtTransferIntent = (({
  readonly "amount": unknown;
  readonly "receivers"?: never;
  readonly "to": unknown;
  readonly [key: string]: unknown;
}) | ({
  readonly "amount"?: never;
  readonly "attachedTbcAmount"?: never;
  readonly "receivers": unknown;
  readonly "to"?: never;
  readonly [key: string]: unknown;
})) & ({
  readonly "amount"?: CommonPositiveAtomicAmount;
  readonly "attachedTbcAmount"?: CommonAtomicAmount;
  readonly "contractId": CommonContractId;
  readonly "receivers"?: (readonly (({
  readonly "amount": CommonPositiveAtomicAmount;
  readonly "to": CommonAddress;
}))[]);
  readonly "to"?: CommonAddress;
  readonly "type": "tbc.ft.transfer";
  readonly "version": "1.0";
});

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
  readonly "payment"?: TransactionNativePayment;
  readonly "receivers"?: (readonly (({
  readonly "amount": (string);
  readonly "to": CommonAddress;
}))[]);
  readonly "to"?: CommonAddress;
  readonly "type": "tbc20-standard-transfer";
  readonly "version": "1.0";
});

type TransactionTbc721Media = (TransactionMedia) & (({
  readonly "data"?: (string);
  readonly [key: string]: unknown;
}));

type TransactionTbc721StandardBatchMintIntent = ({
  readonly "collectionId": CommonContractId;
  readonly "items": (readonly (TransactionTbc721StandardMintItem)[]);
  readonly "type": "tbc721-standard-batch-mint";
  readonly "version": "1.0";
});

type TransactionTbc721StandardCollectionIntent = ({
  readonly "description": (string);
  readonly "media": TransactionTbc721Media;
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
  readonly "media"?: TransactionTbc721Media;
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
  readonly "media"?: TransactionTbc721Media;
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

type TransactionTbcIntent = (TransactionTransferIntent | TransactionTbcMergeIntent | TransactionCollectionCreateIntent | TransactionNftMintIntent | TransactionNftTransferIntent | TransactionTbc721StandardCollectionIntent | TransactionTbc721StandardMintIntent | TransactionTbc721StandardBatchMintIntent | TransactionTbc721StandardTransferIntent | TransactionUnifiedNftTransferIntent | TransactionUnifiedNftBatchTransferIntent | TransactionUnifiedAmmAddIntent | TransactionUnifiedAmmRemoveIntent | TransactionUnifiedAmmSwapIntent | TransactionUnifiedLpTransferIntent | TransactionUnifiedLpLockIntent | TransactionUnifiedPoolMaintenanceIntent | TransactionFtCreateIntent | TransactionFtTransferIntent | TransactionFtMergeIntent | TransactionTbc20StandardCreateIntent | TransactionTbc20StandardTransferIntent | TransactionTbc20StandardMergeIntent | TransactionUnifiedFungibleTransferIntent | TransactionUnifiedFungibleMergeIntent | TransactionCoinCreateIntent | TransactionCoinMintIntent | TransactionCoinFreezeIntent | TransactionCoinUnfreezeIntent | TransactionCoinTransferIntent | TransactionCoinMergeIntent | TransactionLpStandardTransferIntent | TransactionLpStandardLockIntent | TransactionLpStandardMaintenanceIntent | TransactionTimelockLockIntent | TransactionTimelockUnlockIntent | TransactionLopCreateIntent | TransactionLopCancelIntent | TransactionLopMatchIntent | TransactionHtlcLockIntent | TransactionHtlcClaimIntent | TransactionHtlcRefundIntent | TransactionAmmStandardCreateIntent | TransactionAmmStandardAddIntent | TransactionAmmStandardRemoveIntent | TransactionAmmStandardSwapIntent | TransactionStablecoinTransferIntent | TransactionStablecoinMergeIntent | TransactionPoolCreateIntent | TransactionPoolLiquidityAddIntent | TransactionPoolLiquidityRemoveIntent | TransactionPoolLiquidityCloseIntent | TransactionPoolFtMergeIntent | TransactionPoolFtlpMergeIntent | TransactionPoolFtlpBurnIntent | TransactionSwapTbcForTokenIntent | TransactionSwapTokenForTbcIntent);

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

type TransactionUnifiedNftBatchTransferIntent = ({
  readonly "transfers": (readonly (({
  readonly "contractId": CommonContractId;
  readonly "payment"?: TransactionNativePayment;
  readonly "to": CommonAddress;
}))[]);
  readonly "type": "tbc721.batchTransfer";
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

type WorkflowDeferredSigningTask = ({
  readonly "envelopeTemplate": (SigningMessageEnvelope | SigningTypedDataEnvelope);
  readonly "publicKey": CommonPublicKey;
  readonly "purpose": "message" | "typedData";
  readonly "source": WorkflowBindingSource;
  readonly "target": (string);
  readonly "targetStepId": CommonLocalId;
  readonly "targetType": WorkflowDeferredTargetType;
  readonly "taskId": CommonLocalId;
});

type WorkflowDeferredTargetType = "bytes32" | "bytes32[]" | "json-string-array";

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

type WorkflowImmediateSigningTask = ({
  readonly "envelope"?: (SigningMessageEnvelope | SigningTypedDataEnvelope);
  readonly "stepId": CommonLocalId;
  readonly "task": IntegrationSigningTask;
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

type WorkflowResolvedDeferredSigningTask = ({
  readonly "canonical": (string);
  readonly "concreteTask": IntegrationRecoverableSigningTask;
  readonly "digest": CommonHash32;
  readonly "planTaskId": CommonLocalId;
  readonly "purpose": "message" | "typedData";
  readonly "resolvedEnvelope": (SigningMessageEnvelope | SigningTypedDataEnvelope);
  readonly "source": WorkflowBindingSource;
  readonly "sourceValue": (CommonHash32 | (readonly (CommonHash32)[]));
  readonly "target": (string);
  readonly "targetStepId": CommonLocalId;
  readonly "targetType": WorkflowDeferredTargetType;
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

type WorkflowStepResult = (WorkflowTransactionStepResult | WorkflowReviewedTransactionStepResult | WorkflowMessageStepResult | WorkflowCryptoStepResult | WorkflowTypedDataStepResult | WorkflowFailedStepResult);

type WorkflowTransactionStepPlan = ({
  readonly "plan": IntegrationExecutionPlan;
  readonly "stepId": CommonLocalId;
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

type WorkflowWorkflowPlan = ({
  readonly "payload": WorkflowWorkflowPlanPayload;
  readonly "workflowPlanHash": CommonHash32;
});

type WorkflowWorkflowPlanPayload = ({
  readonly "accountId": CommonAccountId;
  readonly "chainId": CommonChainId;
  readonly "cryptoTasks": (readonly (IntegrationCryptoTask)[]);
  readonly "deferredSigningTasks": (readonly (WorkflowDeferredSigningTask)[]);
  readonly "expiresAt": CommonRfc3339;
  readonly "failureMode": "atomic" | "continue-independent";
  readonly "immediateSigningTasks": (readonly (WorkflowImmediateSigningTask)[]);
  readonly "legacyBitcoinMessageStepIds": (readonly (CommonLocalId)[]);
  readonly "maxTotalFee": CommonAtomicAmount;
  readonly "preview": WorkflowWorkflowPreview;
  readonly "requestHash": CommonHash32;
  readonly "reviewedTransactionTasks": (readonly (IntegrationReviewedTransactionTask)[]);
  readonly "stepOrder": (readonly (CommonLocalId)[]);
  readonly "totalFee": CommonAtomicAmount;
  readonly "transactionPlans": (readonly (WorkflowTransactionStepPlan)[]);
  readonly "version": "1.0";
});

type WorkflowWorkflowPreview = IntegrationWorkflowPreview;

type WorkflowWorkflowProgress = ({
  readonly "completedStepIds": (readonly (CommonLocalId)[]);
  readonly "steps": (readonly (WorkflowWorkflowStepProgress)[]);
});

type WorkflowWorkflowStepProgress = ({
  readonly "cryptoResult"?: IntegrationCryptoExecuteResult;
  readonly "error"?: ({
  readonly "code": (string);
  readonly "message": (string);
});
  readonly "finalizationStages"?: (readonly (IntegrationFinalizationStageArtifact)[]);
  readonly "finalizedBundle"?: TransactionSignedTransactionBundle;
  readonly "resolvedDeferredSigningTasks"?: (readonly (WorkflowResolvedDeferredSigningTask)[]);
  readonly "reviewedTransactionResult"?: IntegrationReviewedTransactionExecuteResult;
  readonly "signatures"?: (readonly (IntegrationSignerSignResult)[]);
  readonly "signingTasks"?: (readonly (IntegrationSecretTask)[]);
  readonly "status": WorkflowWorkflowStepStatus;
  readonly "stepId": CommonLocalId;
});

type WorkflowWorkflowStepStatus = "pending" | "signing" | "finalized" | "completed" | "failed" | "skipped";

export interface TwsProtocolSchema {
  readonly "transactionRequest": TransactionTransactionRequest;
  readonly "preparedTransactionRequest": PreparedTransactionPreparedTransactionRequest;
  readonly "preparedWorkflowRequest": PreparedWorkflowRequest;
  readonly "workflowResult": WorkflowResult;
  readonly "workflowSendResult": WorkflowSendResult;
  readonly "signedTransactionBundle": TransactionSignedTransactionBundle;
  readonly "operationCheckpoint": IntegrationOperationCheckpoint;
  readonly "coreTransition": IntegrationCoreTransition;
  readonly "startInput": IntegrationStartInput;
  readonly "resumeInput": IntegrationResumeInput;
  readonly "commitAckInput": IntegrationCommitAckInput;
  readonly "cancelInput": IntegrationCancelInput;
  readonly "portError": IntegrationPortError;
  readonly "normalizeRequestParams": IntegrationNormalizeRequestParams;
  readonly "normalizeRequestResult": IntegrationNormalizeRequestResult;
  readonly "planParams": IntegrationPlanParams;
  readonly "planResult": IntegrationPlanResult;
  readonly "validateParams": IntegrationValidateParams;
  readonly "validationResult": IntegrationValidationResult;
  readonly "finalizeParams": IntegrationFinalizeParams;
  readonly "finalizeResult": IntegrationFinalizeResult;
  readonly "accountsResolveParams": IntegrationAccountsResolveParams;
  readonly "accountsResolveResult": IntegrationAccountsResolveResult;
  readonly "chainDataResolveParams": IntegrationChainDataResolveParams;
  readonly "chainDataResolveResult": IntegrationChainDataResolveResult;
  readonly "policyResolveParams": IntegrationPolicyResolveParams;
  readonly "policyResolveResult": IntegrationPolicyResolveResult;
  readonly "permissionStoreLoadParams": IntegrationPermissionStoreLoadParams;
  readonly "permissionStoreLoadResult": IntegrationPermissionStoreLoadResult;
  readonly "permissionStoreCommitParams": IntegrationPermissionStoreCommitParams;
  readonly "permissionStoreCommitResult": IntegrationPermissionStoreCommitResult;
  readonly "approvalRequestParams": IntegrationApprovalRequestParams;
  readonly "approvalRequestResult": IntegrationApprovalRequestResult;
  readonly "signerSignParams": IntegrationSignerSignParams;
  readonly "signerSignResult": IntegrationSignerSignResult;
  readonly "cryptoExecuteParams": IntegrationCryptoExecuteParams;
  readonly "cryptoExecuteResult": IntegrationCryptoExecuteResult;
  readonly "reviewedTransactionReviewParams": IntegrationReviewedTransactionReviewParams;
  readonly "reviewedTransactionReviewResult": IntegrationReviewedTransactionReviewResult;
  readonly "reviewedTransactionExecuteParams": IntegrationReviewedTransactionExecuteParams;
  readonly "reviewedTransactionExecuteResult": IntegrationReviewedTransactionExecuteResult;
  readonly "broadcastSubmitParams": IntegrationBroadcastSubmitParams;
  readonly "broadcastSubmitResult": IntegrationBroadcastSubmitResult;
  readonly "broadcastSubmitBatchParams": IntegrationBroadcastSubmitBatchParams;
  readonly "broadcastSubmitBatchResult": IntegrationBroadcastSubmitBatchResult;
  readonly "broadcastReconcileParams": IntegrationBroadcastReconcileParams;
  readonly "broadcastReconcileResult": IntegrationBroadcastReconcileResult;
  readonly "clockNowParams": IntegrationClockNowParams;
  readonly "clockNowResult": IntegrationClockNowResult;
  readonly "entropyRandomBytesParams": IntegrationEntropyRandomBytesParams;
  readonly "entropyRandomBytesResult": IntegrationEntropyRandomBytesResult;
}
