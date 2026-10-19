import '../signing_backend.dart';

/// Private wallet-owned capability, not a Provider endpoint or a second signer.
/// The native implementation owns one bounded consent and attests each child
/// through the ordinary signing/broadcast operation before admitting the next.
abstract interface class TbcMaintenanceBackend {
  Future<void> finishMaintenanceNoop(
    TbcSigningRequestScope scope,
    Map<String, dynamic> consent,
    Map<String, dynamic> result,
  );
  Future<TbcMaintenanceOwner> beginMaintenance(
    TbcSigningRequestScope scope,
    Map<String, dynamic> consent,
  );
}

abstract interface class TbcMaintenanceOwner {
  Map<String, dynamic> get approval;
  Future<TbcSigningOperation> beginStep({
    required TbcSigningRequestScope scope,
    required Map<String, dynamic> step,
    required Map<String, dynamic> request,
    required List<String> selectedInputs,
  });
  Future<void> close();

  /// Native attestation of aggregate child outcomes, not a second send or
  /// permission to resume. Runs before releasing a result to the caller.
  Future<void> finish(Map<String, dynamic> result);
}
