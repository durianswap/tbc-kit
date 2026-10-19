// Frozen BIE1 protocol planning only. Cryptography and private key access stay
// in the native Vault; this module never signs a digest, reads chain data or
// attempts to decrypt/verify a MAC in Dart.
import 'dart:convert';
import 'protocol_codec.dart';

const bie1Algorithm = 'tbc-bie1-secp256k1-aes128-cbc-hmac-sha256-v1';
const cryptoMethods = {'tbc_encrypt', 'tbc_decrypt'};

final class TbcInvalidCryptoRequest extends StateError {
  TbcInvalidCryptoRequest() : super('INVALID_CRYPTO_REQUEST');
}

void _shape(Map value, Set<String> required, Set<String> optional) {
  need(
    required.every(value.containsKey) &&
        value.keys.every((k) => required.contains(k) || optional.contains(k)),
    'CRYPTO_SHAPE',
  );
}

void _message(Object? value) {
  need(value is Map, 'CRYPTO_MESSAGE');
  final message = value as Map;
  _shape(message, {'encoding', 'data'}, {});
  final data = message['data'];
  need(data is String, 'CRYPTO_MESSAGE');
  final text = data as String;
  switch (message['encoding']) {
    case 'utf8':
      scalarString(text);
      need(text.runes.length <= 65536, 'CRYPTO_MESSAGE_SIZE');
      break;
    case 'hex':
      need(
        text.isNotEmpty &&
            text.length <= 131072 &&
            lowerHexText(text),
        'CRYPTO_HEX',
      );
      break;
    case 'base64':
      // Match the frozen protocol grammar, including its padding-bit policy.
      // Do not normalize the original text: it is part of the approval hash.
      need(text.length <= 87384 && base64Text(text), 'CRYPTO_BASE64');
      break;
    default:
      throw StateError('CRYPTO_ENCODING');
  }
}

void _ciphertext(Object? value) {
  need(
    value is String &&
        value.length >= 116 &&
        value.length <= 174848 &&
        base64Text(value),
    'CRYPTO_CIPHERTEXT',
  );
  // This is schema validation, NOT authentication. Header, peer, padding and
  // MAC verification belong to the frozen Rust operation at actual key use.
}

void checkCryptoRequest(String method, Map request) {
  try {
    need(cryptoMethods.contains(method), 'CRYPTO_METHOD');
    _shape(
      request,
      {
        'version',
        'chainId',
        'from',
        'algorithm',
        method == 'tbc_encrypt' ? 'message' : 'ciphertext',
      },
      {'clientRequestId', 'expiresAt'},
    );
    need(
      request['version'] == '1.0' &&
          request['algorithm'] == bie1Algorithm &&
          {'tbc:mainnet', 'tbc:testnet'}.contains(request['chainId']),
      'CRYPTO_IDENTITY',
    );
    // Full address/key/chain correspondence is checked by the shared authority.
    need(
      request['from'] is String && request['from'].isNotEmpty,
      'CRYPTO_ACCOUNT',
    );
    if (request.containsKey('clientRequestId')) {
      final client = request['clientRequestId'];
      need(client is String, 'CRYPTO_CLIENT');
      scalarString(client);
      need(
        client.runes.isNotEmpty && client.runes.length <= 128,
        'CRYPTO_CLIENT',
      );
    }
    if (request.containsKey('expiresAt')) {
      need(request['expiresAt'] is String, 'CRYPTO_EXPIRY');
      protocolTime(request['expiresAt']);
    }
    if (method == 'tbc_encrypt') {
      _message(request['message']);
      // Bound decoded bytes, not characters. Keep the wider historical output
      // grammar below so valid ciphertext created by earlier versions remains
      // decryptable. This runs before approval and never reads chain data.
      final message = request['message'] as Map;
      final data = message['data'] as String;
      final size = switch (message['encoding']) {
        'utf8' => utf8.encode(data).length,
        'hex' => data.length ~/ 2,
        _ => data.length ~/ 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0),
      };
      need(size <= 65536, 'CRYPTO_MESSAGE_SIZE');
    } else {
      _ciphertext(request['ciphertext']);
    }
  } on StateError {
    throw TbcInvalidCryptoRequest();
  } on FormatException {
    throw TbcInvalidCryptoRequest();
  }
}

// Reused at native transport and final-result boundaries, not a second cipher.
void checkCryptoResult(Map task, Map output) {
  final encrypt = task['purpose'] == 'encrypt';
  need(encrypt || task['purpose'] == 'decrypt', 'CRYPTO_PURPOSE');
  _shape(output, {
    'taskId',
    'algorithm',
    encrypt ? 'ciphertext' : 'message',
  }, {});
  need(
    output['taskId'] == task['taskId'] &&
        output['algorithm'] == task['algorithm'] &&
        task['algorithm'] == bie1Algorithm,
    'CRYPTO_RESULT_BINDING',
  );
  if (encrypt) {
    _ciphertext(output['ciphertext']);
  } else {
    _message(output['message']);
  }
}

final class CryptoActionProgram {
  CryptoActionProgram({
    required String method,
    required Map request,
    required Map context,
    required Map account,
    required String expiresAt,
  }) {
    checkCryptoRequest(method, request);
    final encrypt = method == 'tbc_encrypt';
    final purpose = encrypt ? 'encrypt' : 'decrypt';
    final content =
        encrypt
            ? {'message': copied(request['message'])}
            : {'ciphertext': request['ciphertext']};
    final payload = {
      'requestHash': hashJson(request),
      'contextHash': hashJson(context),
      'chainId': account['chainId'],
      'accountId': account['accountId'],
      'expiresAt': expiresAt,
      'task': {
        'taskId': 'crypto-single',
        'purpose': purpose,
        'algorithm': bie1Algorithm,
        'origin': context['origin'],
        'accountId': account['accountId'],
        'publicKey': account['publicKey'],
        ...content,
      },
      'preview': {
        'operationKind': 'crypto',
        'purpose': purpose,
        'algorithm': bie1Algorithm,
        ...content,
        'warnings': <dynamic>[],
      },
    };
    plan =
        frozen({'payload': payload, 'planHash': hashJson(payload)})
            as Map<String, dynamic>;
    _identity =
        frozen({
              'version': '1.0',
              'chainId': account['chainId'],
              'from': request['from'],
              'algorithm': bie1Algorithm,
            })
            as Map<String, dynamic>;
  }
  late final Map<String, dynamic> plan, _identity;
  Map<String, dynamic> get task => plan['payload']['task'];
  Map<String, dynamic> result(Map output) {
    final encrypt = task['purpose'] == 'encrypt';
    checkCryptoResult(task, output);
    // Never take network, origin, account or algorithm identity from the port.
    return {
      ..._identity,
      if (encrypt) 'ciphertext': output['ciphertext'],
      if (!encrypt) 'message': copied(output['message']),
    };
  }

  @override
  String toString() => 'CryptoActionProgram(redacted)';
}
