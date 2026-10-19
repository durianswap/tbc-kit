import 'configuration.dart';
import 'webview_scope.dart';
import 'internal/protocol_codec.dart';

/// Fixed, payload-free user rejection. Safe to preserve across the private
/// worker boundary without exposing native errors or approval material.
final class TbcSigningRejected implements Exception {
  const TbcSigningRejected();
  @override
  String toString() => 'Signing request rejected';
}

/// Wallet/native-owned signing registration. No default implementation, account,
/// private key, grant or automatic approval is installed by the package.
/// [begin] opens an operation, not a permission to sign arbitrary digests.
abstract interface class TbcWalletSigningBackend {
  Future<TbcSigningOperation> begin(TbcSigningRequestScope scope);

  /// Invalidate local work and queue native cancellation. Native-originated
  /// lock/account/navigation/grant changes must fence the actual key executor
  /// before notifying Dart. This callback alone cannot synchronously preempt
  /// an already executing native key operation across a MethodChannel.
  void revokePending(TbcWebViewNavigation navigation);

  /// Invalidate only this operation at the same native custody executor. This
  /// also fences a begin that has not returned yet. Cancelling one page request
  /// must not revoke unrelated requests or grants in the document.
  void revokeOperation(TbcSigningRequestScope scope);
}

final class TbcSigningRequestScope {
  TbcSigningRequestScope({
    required this.operationId,
    required this.method,
    required this.navigation,
    required this.account,
    required this.revision,
  }) {
    if (!RegExp(r'^[A-Za-z0-9._:-]{1,256}$').hasMatch(operationId) ||
        method.isEmpty ||
        revision < 0) {
      throw const FormatException('Invalid signing operation scope');
    }
  }
  final String operationId, method;
  final TbcWebViewNavigation navigation;
  final TbcAccount account;
  final int revision;
  @override
  String toString() => 'TbcSigningRequestScope(redacted)';
}

/// Private, trusted lifecycle callbacks; never register these on a WebView.
/// The backend owns native consent/unlock and atomic permit/task consumption.
/// Before signing it must recheck native scope, grant, unlock, expiry, exact
/// account, binding and unconsumed task. Async Dart checks are not a substitute.
abstract interface class TbcSigningOperation {
  Future<void> requireCurrent();
  Future<bool> requestConsent(TbcBoundedSigningIntent intent);
  Future<TbcSigningReceipt> bind(TbcSigningMaterial material);

  /// Private continuation from the trusted worker, only after Engine's
  /// finalized-pending validation. Preserve the original receipt/fee/plan;
  /// consume the previous stage completely before accepting new tasks. This is
  /// not a page-facing arbitrary digest authorization or a second approval.
  Future<void> advance(
    TbcSigningReceipt receipt,
    TbcSigningContinuation continuation,
  );
  Future<TbcTaskSignature> sign(TbcSigningReceipt receipt, TbcSigningTask task);

  /// Release/revoke only this operation, idempotently, including on rejection.
  /// It must never retry a signature or submit a transaction.
  Future<void> close();
}

/// Optional wallet-owned submit capability on this SAME signing operation.
/// Never expose these callbacks to a page. The native adapter must authorize
/// only a send-method consent, the exact receipt, consumed signing tasks and
/// finalized result. It owns the configured source, stable operation identity,
/// durable submission journal and one-use native dispatch fence. No callback
/// prompts, signs, retries a POST or accepts a page-supplied endpoint.
///
/// Authorization retains one exact bundle privately until close. Subsequent
/// calls select its index (or its entire ordered batch), never replacement raw
/// bytes. A pure signer need not implement this capability or store anything.
abstract interface class TbcBroadcastSigningOperation
    implements TbcSigningOperation {
  Future<void> authorizeBroadcast(
    TbcSigningReceipt receipt,
    TbcBroadcastMaterial material,
  );
  Future<TbcBroadcastResult> submitTransaction(
    TbcSigningReceipt receipt,
    int index,
  );
  Future<TbcBroadcastResult> submitBatch(TbcSigningReceipt receipt);

  /// One read-only reconciliation of the already attempted ordered prefix.
  /// This is not permission to send again or to resume a signing operation.
  Future<TbcBroadcastResult> reconcileSubmitted(
    TbcSigningReceipt receipt,
    List<String> txids,
  );

  /// Attest the exact public result against this operation's submitted bytes
  /// and native journal outcomes. No network, retry, signature or approval.
  /// Close may grant result delivery only after this succeeds.
  Future<void> finishBroadcast(
    TbcSigningReceipt receipt,
    TbcBroadcastResult result,
  );
}

final class TbcBroadcastMaterial {
  TbcBroadcastMaterial({required Map bundle, Map? workflow})
    : bundle = _immutable(bundle),
      workflow = workflow == null ? null : _immutable(workflow);
  final Map<String, dynamic> bundle;
  final Map<String, dynamic>? workflow;
  @override
  String toString() => 'TbcBroadcastMaterial(redacted)';
}

/// Ordered submit/status result or a fixed portError. Arbitrary native/network
/// exceptions and request bytes must not be reflected into this projection.
final class TbcBroadcastResult {
  TbcBroadcastResult(Map value) : wire = _immutable(value);
  final Map<String, dynamic> wire;
  @override
  String toString() => 'TbcBroadcastResult(redacted)';
}

/// Optional native whole-batch custody on the SAME operation/receipt. A backend
/// without this contract cannot execute workflows. Neither callback prompts.
/// Native owns the current step, step-scoped consumed tasks and completed
/// results. It must rederive deferred digests from its own verified completed
/// history, never accept worker/page completion claims as signing authority.
abstract interface class TbcWorkflowSigningOperation
    implements TbcSigningOperation {
  Future<void> enterWorkflowStep(
    TbcSigningReceipt receipt,
    TbcSigningContinuation step,
  );

  /// Validate result against actual native signatures and the approved plan
  /// before recording completion. A failure may close only the active step;
  /// scope/receipt loss still revokes the whole operation, not just this step.
  Future<void> finishWorkflowStep(
    TbcSigningReceipt receipt,
    TbcSigningContinuation outcome,
  );
}

/// Optional BIE1 custody on the same operation and bound receipt. Digest-only
/// signers do not implement this capability. Native must independently derive
/// the crypto task from consent, consume it once, check the live Vault/scope at
/// key use and withhold output after revocation. No private scalar is returned
/// through this interface; malformed ciphertext must fail without plaintext.
abstract interface class TbcCryptoSigningOperation
    implements TbcSigningOperation {
  Future<TbcCryptoResult> executeCrypto(
    TbcSigningReceipt receipt,
    TbcCryptoTask task,
  );
}

final class TbcCryptoTask {
  TbcCryptoTask(Map value) : wire = _immutable(value);
  final Map<String, dynamic> wire;
  String get taskId => wire['taskId'] as String;
  String get purpose => wire['purpose'] as String;
  String get algorithm => wire['algorithm'] as String;
  String get accountId => wire['accountId'] as String;
  String get publicKey => wire['publicKey'] as String;
  @override
  String toString() => 'TbcCryptoTask(redacted)';
}

final class TbcCryptoResult {
  TbcCryptoResult(Map value) : wire = _immutable(value);
  final Map<String, dynamic> wire;
  @override
  String toString() => 'TbcCryptoResult(redacted)';
}

/// Explicit data-free backend failure, never inferred from arbitrary errors.
/// Only this recoverable component failure may continue unrelated steps when
/// the approved request selected continue-independent. No signature is retried.
final class TbcWorkflowStepUnavailable implements Exception {
  const TbcWorkflowStepUnavailable() : operation = 'signer.sign';
  const TbcWorkflowStepUnavailable.crypto() : operation = 'crypto.execute';
  final String operation;
  @override
  String toString() => 'Workflow signing component unavailable';
}

/// Optional wallet-owned role selection for this existing signing operation.
/// Return additional public identities only, excluding the primary account.
/// Resolve exclusively among native wallet-selected accounts already granted
/// this origin, chain and method. Bind the exact request, and recheck role
/// identities/grants at key use and delivery. This never grants permission or
/// signs. A backend without this interface cannot authorize signingRoles.
abstract interface class TbcTransactionSigningRoles {
  Future<List<TbcAccount>> resolveSigningAccounts(
    TbcBoundedSigningIntent intent,
  );
}

/// Intent consent is not a formal approval receipt. Only trusted adapter code
/// receives this object; the wallet renders the package's display projection,
/// never arbitrary raw material or private witnesses. Current executor supports
/// the enabled profiles in the package coverage matrix.
final class TbcBoundedSigningIntent {
  TbcBoundedSigningIntent({
    required this.method,
    required Map request,
    required Map context,
    Map? review,
  }) : request = _immutable(request),
       context = _immutable(context),
       review = review == null ? null : _immutable(review);
  final String method;
  final Map<String, dynamic> request, context;

  /// Trusted, complete review for DApp-built bytes; never a page-provided preview.
  /// Native custody must bind this exact review to the consent and final plan.
  final Map<String, dynamic>? review;
  @override
  String toString() => 'TbcBoundedSigningIntent(redacted)';
}

/// Immutable private approval material produced by the shared executor after
/// Engine validation. Immutability alone is not a cryptographic proof: native
/// custody must independently match its earlier consent and verified task set.
/// No part of this envelope belongs in diagnostics, UI analytics or page APIs.
final class TbcSigningMaterial {
  TbcSigningMaterial({
    required Map binding,
    required Map preview,
    Map? plan,
    Map? envelope,
    Map? reviewed,
  }) : binding = _immutable(binding),
       preview = _immutable(preview),
       plan = plan == null ? null : _immutable(plan),
       envelope = envelope == null ? null : _immutable(envelope),
       reviewed = reviewed == null ? null : _immutable(reviewed);
  final Map<String, dynamic> binding, preview;
  final Map<String, dynamic>? plan, envelope;

  /// Private keyless request/policy/stage, possibly containing HTLC witnesses.
  /// Never display/log this; native independently reconstructs permitted tasks.
  final Map<String, dynamic>? reviewed;
  @override
  String toString() => 'TbcSigningMaterial(redacted)';
}

/// Private receipt; caller must not log or send the token to the page. Engine
/// and shared lifecycle still validate exact binding, timestamps and expiry.
final class TbcSigningReceipt {
  TbcSigningReceipt(Map value) : wire = _immutable(value);
  final Map<String, dynamic> wire;
  @override
  String toString() => 'TbcSigningReceipt(redacted)';
}

/// Engine-validated pending result, kept private like the plan and receipt.
/// Construction is not proof: adapters only accept this from the package's
/// trusted executor and must enforce receipt, stage and task-consumption bounds.
final class TbcSigningContinuation {
  TbcSigningContinuation(Map value) : wire = _immutable(value);
  final Map<String, dynamic> wire;
  @override
  String toString() => 'TbcSigningContinuation(redacted)';
}

final class TbcSigningTask {
  TbcSigningTask(Map value) : wire = _immutable(value);
  final Map<String, dynamic> wire;
  String get taskId => wire['taskId'] as String;
  String get accountId => wire['accountId'] as String;
  String get publicKey => wire['publicKey'] as String;
  String get digest => wire['digest'] as String;
  String get algorithm => wire['algorithm'] as String;
  String get signatureEncoding => wire['signatureEncoding'] as String;
  @override
  String toString() => 'TbcSigningTask(redacted)';
}

final class TbcTaskSignature {
  TbcTaskSignature({
    required this.taskId,
    required this.signatureEncoding,
    required this.signature,
  });
  final String taskId, signatureEncoding, signature;
  Map<String, dynamic> toWire() => {
    'taskId': taskId,
    'signatureEncoding': signatureEncoding,
    'signature': signature,
  };
  @override
  String toString() => 'TbcTaskSignature(redacted)';
}

Map<String, dynamic> _immutable(Map value) =>
    frozen(copied(value)) as Map<String, dynamic>;
