import '../../flutter/runtime/webview-page-compat.mjs';
import {installFlutterWebViewPage} from '../../flutter/runtime/webview-page.mjs';
import {createLegacyPage} from './legacy-page.mjs';

// Reuse the established Standard Provider/discovery bridge. Only the Legacy
// page DTO lane differs; no privileged runtime or business logic is bundled.
if(window.top===window&&!Object.hasOwn(window,Symbol.for('org.tbc.flutter.page-transport'))){
  const wk=window.webkit?.messageHandlers?.tbcKitNative,android=window.tbcKitNative;
  const native=wk&&android?undefined:wk??android;
  let post=typeof native?.postMessage==='function'?native.postMessage.bind(native):undefined;
  if(!post){
    const acceptPort=event=>{
      const value=event.data;
      if(typeof value!=='string'||!/^tbc-native-port:[A-Za-z0-9_-]{1,128}$/.test(value)||
        event.ports?.length!==1||typeof event.ports[0]?.postMessage!=='function')return;
      const port=event.ports[0];
      try{port.postMessage(`tbc-native-port-ack:${value.slice('tbc-native-port:'.length)}`);}catch{return;}
      post=port.postMessage.bind(port);window.removeEventListener('message',acceptPort);
    };window.addEventListener('message',acceptPort);
  }
  const bridge=installFlutterWebViewPage({target:window,legacyFactory:createLegacyPage,nativePost(serialized){
    if(!post)throw Error('Native WebView unavailable');post(serialized);
  }});
  Object.defineProperty(window,'__tbcFlutterPage',{value:bridge,writable:false,configurable:false});
}
