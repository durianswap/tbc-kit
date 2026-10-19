import 'dart:async';
import 'dart:convert';
import 'package:flutter/services.dart';
import '../internal/wire_session.dart';

import '../webview_scope.dart';

/// Private platform-channel transport. The page never supplies navigation or
/// message source metadata. Register one native host for this Flutter engine.
final class TbcWebViewPlatform implements TbcDocumentDelivery {
  TbcWebViewPlatform._(
    this._hub,
    this.ownerId,
    this.webViewInstanceId,
    this.markerSource,
    this.legacyBootstrapSource,
    this.supportsLegacyPage,
    this._onNavigation,
    this._onMessage,
    this._onInvalidated,
  );
  static const _defaultChannel = MethodChannel(
    'io.tbc.kit.dart/private-webview',
  );
  static final _hubs = <MethodChannel, _WebViewHub>{};
  final _WebViewHub _hub;
  final String ownerId, webViewInstanceId, markerSource;

  /// Private page-only script for WebViews without native document-start APIs.
  /// The native owner supplies and hashes it; this is never a custody script.
  final String? legacyBootstrapSource;
  final bool supportsLegacyPage;
  final void Function(TbcWebViewNavigation) _onNavigation;
  final void Function(String, TbcWebViewMessageSource) _onMessage;
  final void Function() _onInvalidated;
  bool _disposed = false;
  TbcWebViewNavigation? _navigation;

  static Future<TbcWebViewPlatform> create({
    required void Function(TbcWebViewNavigation) onNavigation,
    required void Function(String, TbcWebViewMessageSource) onMessage,
    required void Function() onInvalidated,
    MethodChannel? channel,
  }) async {
    final bridge = channel ?? _defaultChannel;
    final hub = _hubs.putIfAbsent(bridge, () => _WebViewHub(bridge));
    final value = await bridge.invokeMapMethod<String, Object?>('create', {});
    final id = value?['ownerId'], view = value?['webViewInstanceId'];
    final marker = value?['markerSource'];
    final legacySource = value?['legacyBootstrapSource'];
    final supportsLegacyPage = value?['legacyPageSupported'];
    final valid = RegExp(r'^[A-Za-z0-9_-]{1,128}$');
    if (id is! String ||
        view is! String ||
        !valid.hasMatch(id) ||
        !valid.hasMatch(view) ||
        marker != '/* tbc-native-view:$view */' ||
        (legacySource != null &&
            (legacySource is! String ||
                legacySource.isEmpty ||
                utf8.encode(legacySource).length > 2 * 1024 * 1024)) ||
        (supportsLegacyPage != null && supportsLegacyPage is! bool) ||
        value!.length !=
            (legacySource == null ? 3 : 4) +
                (supportsLegacyPage == null ? 0 : 1) ||
        hub.owners.containsKey(id)) {
      throw StateError('WEBVIEW_INVALID_OWNER');
    }
    final result = TbcWebViewPlatform._(
      hub,
      id,
      view,
      marker as String,
      legacySource as String?,
      supportsLegacyPage == true,
      onNavigation,
      onMessage,
      onInvalidated,
    );
    hub.owners[id] = result;
    return result;
  }

  /// Mount a blank view with markerSource as its sole native owner marker first.
  /// false means it has not mounted; caller may retry attachment, never requests.
  /// Android supplies the trusted controller's platform view ID; iOS uses the
  /// native user-script marker. A DApp must never select this ID.
  Future<bool> attach({int? platformViewId}) async {
    if (_disposed) throw StateError('WEBVIEW_SCOPE_CLOSED');
    if (platformViewId != null &&
        (platformViewId < 0 || platformViewId > 0x7fffffff)) {
      throw ArgumentError.value(platformViewId, 'platformViewId');
    }
    bool? result;
    try {
      result = await _hub.channel.invokeMethod<bool>('attach', {
        'ownerId': ownerId,
        if (platformViewId != null) 'platformViewId': platformViewId,
      });
    } on PlatformException catch (error) {
      if (error.code == 'WEBVIEW_REQUIRED_FEATURE_UNAVAILABLE') {
        throw StateError('WEBVIEW_REQUIRED_FEATURE_UNAVAILABLE');
      }
      rethrow;
    }
    if (_disposed) throw StateError('WEBVIEW_SCOPE_CLOSED');
    return result == true;
  }

  bool _current(TbcWebViewNavigation expected) =>
      !_disposed && _navigation?.matches(expected.toWire()) == true;
  @override
  Future<bool> deliver(String serialized, TbcWebViewNavigation expected) async {
    return _deliver('deliver', serialized, expected);
  }

  /// The lane is selected by this package-owned delivery adapter, not a page
  /// field. Native checks its separately registered Legacy custody at emission.
  TbcDocumentDelivery get legacyDelivery => _LegacyDelivery(this);
  Future<bool> _deliver(
    String method,
    String serialized,
    TbcWebViewNavigation expected,
  ) async {
    if (!_current(expected)) return false;
    final ok = await _hub.channel.invokeMethod<bool>(method, {
      'ownerId': ownerId,
      'expected': expected.toWire(),
      'serialized': serialized,
    });
    return ok == true && _current(expected);
  }

  @override
  Future<bool> describe(
    Map<String, Object?> descriptor,
    TbcWebViewNavigation expected,
  ) async {
    if (!_current(expected)) return false;
    final ok = await _hub.channel.invokeMethod<bool>('describe', {
      'ownerId': ownerId,
      'expected': expected.toWire(),
      'descriptor': descriptor,
    });
    return ok == true && _current(expected);
  }

  @override
  Future<void> close(TbcWebViewNavigation expected) async {
    if (!_current(expected)) return;
    _navigation = null;
    await _hub.channel.invokeMethod<bool>('close', {
      'ownerId': ownerId,
      'expected': expected.toWire(),
    });
  }

  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    _navigation = null;
    _hub.owners.remove(ownerId);
    try {
      _onInvalidated();
    } finally {
      await _hub.channel.invokeMethod<void>('dispose', {'ownerId': ownerId});
    }
  }

  void _event(String type, Map body) {
    if (_disposed) return;
    switch (type) {
      case 'navigation':
        final n = TbcWebViewNavigation(
          webViewInstanceId: body['webViewInstanceId'] as String,
          sessionId: body['sessionId'] as String,
          navigationId: body['navigationId'] as String,
          committedUrl: body['committedUrl'] as String,
          origin: body['origin'] as String,
          createdAt: body['createdAt'] as String,
        );
        if (n.webViewInstanceId != webViewInstanceId || !n.matches(body)) {
          throw const FormatException('Invalid native navigation');
        }
        // Native normally invalidates first; also fence a replacement locally.
        if (_navigation != null) {
          _navigation = null;
          _onInvalidated();
        }
        if (_disposed) return;
        _navigation = n;
        _onNavigation(n);
      case 'invalidated':
        if (body.length != 1 || !body.containsKey('navigation')) {
          throw const FormatException('Invalid native invalidation');
        }
        final old = body['navigation'];
        // An older document's cleanup notification cannot revoke a successor.
        if (old != null && _navigation != null && !_navigation!.matches(old))
          return;
        _navigation = null;
        _onInvalidated();
      case 'message':
        final n = _navigation,
            source = body['source'],
            text = body['serialized'];
        if (n == null) return;
        if (body.length != 2 ||
            source is! Map ||
            source.length != 6 ||
            text is! String ||
            text.length > 4 * 1024 * 1024) {
          throw const FormatException('Invalid native message');
        }
        if (source['webViewInstanceId'] != webViewInstanceId ||
            source['sessionId'] != n.sessionId ||
            source['navigationId'] != n.navigationId ||
            source['origin'] != n.origin ||
            source['topOrigin'] != n.origin ||
            source['isMainFrame'] != true)
          return;
        _onMessage(
          text,
          TbcWebViewMessageSource(
            webViewInstanceId: webViewInstanceId,
            sessionId: n.sessionId,
            navigationId: n.navigationId,
            origin: n.origin,
            topOrigin: n.origin,
            isMainFrame: true,
          ),
        );
      default:
        throw const FormatException('Unknown native event');
    }
  }
}

final class _LegacyDelivery implements TbcDocumentDelivery {
  const _LegacyDelivery(this.owner);
  final TbcWebViewPlatform owner;
  @override
  Future<bool> deliver(String text, TbcWebViewNavigation expected) =>
      owner._deliver('deliverLegacy', text, expected);
  @override
  Future<bool> describe(
    Map<String, Object?> value,
    TbcWebViewNavigation expected,
  ) async => false;
  @override
  Future<void> close(TbcWebViewNavigation expected) => owner.close(expected);
}

final class _WebViewHub {
  _WebViewHub(this.channel) {
    channel.setMethodCallHandler(_event);
  }
  final MethodChannel channel;
  final owners = <String, TbcWebViewPlatform>{};
  Future<void> _event(MethodCall call) async {
    final value = call.arguments;
    if (call.method != 'event' || value is! Map) return;
    final owner = owners[value['ownerId']];
    if (owner == null) return;
    try {
      if (value.length != 3 ||
          value['type'] is! String ||
          value['body'] is! Map) {
        throw const FormatException('Invalid native event');
      }
      owner._event(value['type'] as String, value['body'] as Map);
    } catch (_) {
      // Invalidate synchronously. Do not wait for platform disposal in the event
      // handler: native close can emit another event on this same channel.
      unawaited(owner.dispose().catchError((Object _) {}));
    }
  }
}
