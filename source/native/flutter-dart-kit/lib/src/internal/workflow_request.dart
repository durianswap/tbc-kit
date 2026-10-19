// Private generic workflow projection. No permission, approval or signing
// authority is created here; child operations still use their shared modules.
import 'dart:convert';
import 'protocol_codec.dart';
import 'prepared_proposal.dart';
import 'reviewed_material.dart';
import 'typed_signing.dart';

const workflowMethods = {
  'tbc_signWorkflow',
  'tbc_signPreparedWorkflow',
  'tbc_sendWorkflow',
  'tbc_sendPreparedWorkflow',
};
const workflowCryptoAlgorithm = 'tbc-bie1-secp256k1-aes128-cbc-hmac-sha256-v1';
const _unsafeKeys = {'__proto__', 'constructor', 'prototype'};
final _id = RegExp(r'^[A-Za-z][A-Za-z0-9._-]{0,63}$');
final _field = RegExp(r'^[A-Za-z][A-Za-z0-9_]{0,63}$');

bool workflowTransaction(Map step) =>
    step['kind'] == 'transaction' || step['kind'] == 'preparedTransaction';

void _shape(
  Map value,
  Set<String> required, [
  Set<String> optional = const {},
]) {
  need(
    required.every(value.containsKey) &&
        value.values.every((v) => v != null) &&
        value.keys.every((k) => required.contains(k) || optional.contains(k)),
    'WORKFLOW_SHAPE',
  );
}

Map<String, dynamic> workflowTransactionRequest(Map request, Map step) => {
  'version': '1.0',
  'chainId': request['chainId'],
  'from': request['from'],
  'intent': step['intent'],
  if (step.containsKey('constraints')) 'constraints': step['constraints'],
  if (step.containsKey('signingRoles')) 'signingRoles': step['signingRoles'],
};

Map<String, dynamic> workflowTypedEnvelope(
  Map request,
  Map step,
  String origin,
) => typedDataEnvelope({
  'version': '1.0',
  'chainId': request['chainId'],
  'from': request['from'],
  'data': step['data'],
}, origin);

Map<String, dynamic> workflowMessageEnvelope(Map step) => {
  'type': 'tbc.message',
  'version': '1.0',
  'message': step['message'],
};

/// Required primary-account grants, not granted permissions. Controller grants
/// are resolved separately: they do not authorize messages for the primary.
Set<String> workflowRequiredPermissions(Map request, {String? method}) => {
  'tbc_signWorkflow',
  if (method == 'tbc_sendWorkflow' || method == 'tbc_sendPreparedWorkflow')
    'tbc_sendTransaction',
  for (final step in request['steps'] as List)
    if (workflowTransaction(step) || step['kind'] == 'reviewedTransaction')
      'tbc_signTransaction'
    else if (step['kind'] == 'message')
      'tbc_signMessage'
    else if (step['kind'] == 'typedData')
      'tbc_signTypedData'
    else
      'tbc_crypto',
};

List<Map<String, dynamic>> workflowBindings(Map step) =>
    ((step['bindings'] ?? []) as List).cast<Map<String, dynamic>>();

String workflowTargetType(Map step, Map binding) {
  if (step['kind'] == 'message') return 'json-string-array';
  final target = binding['target'] as String;
  final fields = step['data']['types'][step['data']['primaryType']] as List?;
  final matching = fields?.where((f) => f['name'] == target.substring(9));
  final field = matching == null || matching.isEmpty ? null : matching.first;
  need(
    field != null && {'bytes32', 'bytes32[]'}.contains(field['type']),
    'WORKFLOW_BINDING_TYPE',
  );
  return field['type'];
}

/// Validate the whole graph before material callbacks. Transaction intent and
/// constraint semantics are then checked by the unchanged Rust normalizer.
Map<String, dynamic> checkedWorkflowRequest({
  required String method,
  required Map input,
  required String origin,
  required DateTime now,
}) {
  need(workflowMethods.contains(method), 'WORKFLOW_METHOD');
  final request = copied(input);
  _shape(
    request,
    {'version', 'chainId', 'from', 'steps'},
    {'clientRequestId', 'expiresAt', 'maxTotalFee', 'failureMode'},
  );
  need(
    request['version'] == '1.0' &&
        {'tbc:mainnet', 'tbc:testnet'}.contains(request['chainId']) &&
        request['from'] is String,
    'WORKFLOW_IDENTITY',
  );
  final client = request['clientRequestId'];
  if (client != null) {
    need(
      client is String && client.isNotEmpty && client.length <= 128,
      'WORKFLOW_CLIENT_ID',
    );
    // Legacy Bitcoin framing requires a trusted adapter, never a page selector.
    need(!client.startsWith('legacy-bitcoin:'), 'LEGACY_PROFILE_NOT_INSTALLED');
  }
  if (request.containsKey('expiresAt')) {
    need(
      request['expiresAt'] is String &&
          now.isBefore(protocolTime(request['expiresAt'])),
      'WORKFLOW_EXPIRED',
    );
  }
  if (request.containsKey('maxTotalFee')) {
    final fee = request['maxTotalFee'];
    need(
      fee is String && RegExp(r'^(0|[1-9][0-9]*)$').hasMatch(fee),
      'WORKFLOW_FEE',
    );
  }
  need(
    {
      'atomic',
      'continue-independent',
    }.contains(request['failureMode'] ?? 'atomic'),
    'WORKFLOW_FAILURE_MODE',
  );
  final steps = request['steps'];
  need(
    steps is List && steps.isNotEmpty && steps.length <= 5,
    'WORKFLOW_COUNT',
  );
  final prior = <String, Map>{};
  for (final step in steps as List) {
    need(step is Map, 'WORKFLOW_STEP');
    final s = step as Map, id = s['id'], kind = s['kind'];
    need(
      id is String && _id.hasMatch(id) && !prior.containsKey(id),
      'WORKFLOW_STEP_ID',
    );
    final depends = s['dependsOn'];
    need(
      depends is List &&
          depends.length <= 4 &&
          depends.toSet().length == depends.length &&
          depends.every((id) => id is String && prior.containsKey(id)),
      'WORKFLOW_TOPOLOGY',
    );
    const common = {'id', 'kind', 'dependsOn'};
    if (workflowTransaction(s)) {
      final prepared = method.contains('Prepared');
      need(
        kind == (prepared ? 'preparedTransaction' : 'transaction'),
        'WORKFLOW_METHOD_KIND',
      );
      _shape(
        s,
        {...common, 'intent', if (prepared) 'proposal'},
        {'constraints', 'signingRoles'},
      );
      need(s['intent'] is Map, 'WORKFLOW_INTENT');
      if (prepared)
        checkedPreparedRequest({
          ...workflowTransactionRequest(request, s),
          'proposal': s['proposal'],
        }, now);
    } else if (kind == 'reviewedTransaction') {
      _shape(s, {...common, 'request'}, {'signingRoles'});
      need(s['signingRoles'] == null, 'REVIEWED_ADMIN_OUTSIDE_SCOPE');
      normalizeReviewedMaterial(s['request']);
    } else if (kind == 'message' || kind == 'encrypt') {
      _shape(
        s,
        {...common, 'message', if (kind == 'encrypt') 'algorithm'},
        {if (kind == 'message') 'bindings'},
      );
      need(s['message'] is Map, 'WORKFLOW_MESSAGE');
      _shape(s['message'], {'encoding', 'data'});
      final bytes = messageBytes(s['message']);
      need(
        s['message']['encoding'] != 'hex' || bytes.isNotEmpty,
        'WORKFLOW_EMPTY_HEX',
      );
      need(bytes.length <= 65536, 'MESSAGE_TOO_LARGE');
      if (kind == 'message') {
        need(
          !utf8
              .decode(bytes, allowMalformed: true)
              .contains('wants you to sign in'),
          'SIGN_IN_PROFILE_NOT_INSTALLED',
        );
      } else {
        need(s['algorithm'] == workflowCryptoAlgorithm, 'WORKFLOW_CRYPTO');
      }
    } else if (kind == 'decrypt') {
      _shape(s, {...common, 'algorithm', 'ciphertext'});
      need(s['algorithm'] == workflowCryptoAlgorithm, 'WORKFLOW_CRYPTO');
      final text = s['ciphertext'];
      need(
        text is String &&
            text.length >= 116 &&
            text.length <= 174848 &&
            base64Text(text),
        'WORKFLOW_CIPHERTEXT',
      );
      need(base64Encode(base64Decode(text)) == text, 'NONCANONICAL_BASE64');
    } else if (kind == 'typedData') {
      _shape(s, {...common, 'data', 'bindings'});
      workflowTypedEnvelope(request, s, origin);
    } else {
      throw StateError('WORKFLOW_KIND');
    }
    if (kind == 'message' || kind == 'typedData') {
      final bindings = s['bindings'] ?? [];
      need(bindings is List && bindings.length <= 1, 'WORKFLOW_BINDINGS');
      for (final b in bindings as List) {
        need(b is Map && b['source'] is Map, 'WORKFLOW_BINDING');
        _shape(b, {'target', 'source'});
        final source = b['source'] as Map;
        _shape(source, {'stepId', 'output'});
        final parent = prior[source['stepId']];
        need(
          parent != null &&
              (depends as List).contains(source['stepId']) &&
              (workflowTransaction(parent) ||
                  (kind == 'message' &&
                      parent['kind'] == 'reviewedTransaction')),
          'WORKFLOW_BINDING_SOURCE',
        );
        final target = b['target'];
        if (kind == 'message') {
          need(
            source['output'] == 'transactionIds' &&
                target is String &&
                _field.hasMatch(target) &&
                !_unsafeKeys.contains(target) &&
                s['message']['encoding'] == 'utf8',
            'WORKFLOW_JSON_BINDING',
          );
          final parsed = jsonDecode(s['message']['data']);
          need(
            parsed is Map &&
                !parsed.keys.any(_unsafeKeys.contains) &&
                (!parsed.containsKey(target) || parsed[target] is List),
            'WORKFLOW_JSON_TARGET',
          );
        } else {
          need(
            target is String &&
                target.startsWith('/message/') &&
                _field.hasMatch(target.substring(9)),
            'WORKFLOW_TYPED_TARGET',
          );
          need(
            {
              'transactionIds',
              'primaryTransactionId',
              'artifacts.collectionId',
              'artifacts.contractId',
              'artifacts.poolContractId',
            }.contains(source['output']),
            'WORKFLOW_SOURCE_OUTPUT',
          );
          need(
            workflowTargetType(s, b) ==
                (source['output'] == 'transactionIds'
                    ? 'bytes32[]'
                    : 'bytes32'),
            'WORKFLOW_BINDING_TYPE',
          );
          need(
            canonical(s['data']['message'][target.substring(9)]) ==
                canonical({r'$tbcBinding': 'unresolved'}),
            'WORKFLOW_PLACEHOLDER',
          );
        }
      }
    }
    prior[id] = s;
  }
  return frozen(request) as Map<String, dynamic>;
}
