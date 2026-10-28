// Use with Kit's existing configureTbcKitSha256Backend at private VM bootstrap.
// Kit checks independent portable startup vectors before accepting the backend.
export function createNativeSha256Backend(nativeSha256) {
  if(typeof nativeSha256 !== 'function')throw new TypeError('Native SHA-256 required');
  return bytes=>{
    if(!(bytes instanceof Uint8Array))throw new TypeError('SHA-256 bytes required');
    const result=nativeSha256(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    if(!(result instanceof Uint8Array)||result.length!==32)throw new TypeError('Invalid native SHA-256 output');
    return result;
  };
}
