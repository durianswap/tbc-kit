import 'host_environment.dart';

/// Private platform boundary data. Only the native WebView adapter may supply
/// these values; a JavaScript body, handler argument or page URL is not proof.
final class TbcWebViewNavigation {
  TbcWebViewNavigation({
    required this.webViewInstanceId,
    required this.sessionId,
    required this.navigationId,
    required this.committedUrl,
    required this.origin,
    required this.createdAt,
  }) {
    final id = RegExp(r'^[A-Za-z0-9._:-]{1,128}$');
    if (![webViewInstanceId, sessionId, navigationId].every(id.hasMatch)) {
      throw const FormatException('Invalid native navigation identity');
    }
    final uri = Uri.tryParse(committedUrl);
    if (uri == null ||
        !['https', 'http'].contains(uri.scheme) ||
        uri.host.isEmpty ||
        uri.userInfo.isNotEmpty ||
        uri.origin != origin) {
      throw const FormatException('Invalid native navigation origin');
    }
    // Preserve the current bound protocol, never truncate an observed record.
    parseTbcProtocolTimestamp(createdAt);
  }
  final String webViewInstanceId, sessionId, navigationId;
  final String committedUrl, origin, createdAt;
  Map<String, Object> toWire() => {
    'webViewInstanceId': webViewInstanceId,
    'sessionId': sessionId,
    'navigationId': navigationId,
    'committedUrl': committedUrl,
    'origin': origin,
    'topOrigin': origin,
    'frame': 'top',
    'createdAt': createdAt,
  };
  bool matches(Object? value) {
    if (value is! Map) return false;
    final expected = toWire();
    return value.length == expected.length &&
        expected.entries.every((e) => value[e.key] == e.value);
  }

  @override
  String toString() => 'TbcWebViewNavigation(redacted)';
}

/// Captured for each native message, not synthesized from the page envelope.
final class TbcWebViewMessageSource {
  const TbcWebViewMessageSource({
    required this.webViewInstanceId,
    required this.sessionId,
    required this.navigationId,
    required this.origin,
    required this.topOrigin,
    required this.isMainFrame,
  });
  final String webViewInstanceId, sessionId, navigationId, origin, topOrigin;
  final bool isMainFrame;
  Map<String, Object> toWire() => {
    'webViewInstanceId': webViewInstanceId,
    'sessionId': sessionId,
    'navigationId': navigationId,
    'origin': origin,
    'topOrigin': topOrigin,
    'isMainFrame': isMainFrame,
  };
  @override
  String toString() => 'TbcWebViewMessageSource(redacted)';
}
