// OPTIONAL wallet-private module. Never expose this object to a DApp.
// Custody must authenticate the approved task binding before begin/sign and
// cancel sessions on revoke/navigation. The kernel is not an approval verifier.
export async function createWasmMuSigSigner(source, {crypto = globalThis.crypto, clock = () => globalThis.performance.now()} = {}) {
  if (typeof crypto?.getRandomValues !== 'function' || typeof clock !== 'function') throw new Error('Secure platform services required');
  const loaded = await WebAssembly.instantiate(source, {});
  const api = (loaded instanceof WebAssembly.Instance ? loaded : loaded.instance).exports;
  if (api.tbc_signer_musig_version?.() !== 1) throw new Error('MuSig Signer unavailable');
  const offsets = {keys:0,aggregate:1056,digest:1088,binding:1120,scalar:1152,entropy:1184,handle:1216,nonce:1248,nonces:1314,shares:3426,signature:4450};
  const validHex = (value, bytes) => typeof value === 'string' && value.length === bytes * 2 && /^[0-9a-f]+$/.test(value);
  const hex = (value, bytes) => {
    if (!validHex(value, bytes)) throw new Error('Invalid MuSig input');
    return Uint8Array.from(value.match(/../g), x => Number.parseInt(x, 16));
  };
  const checkKeys = keys => {if (!Array.isArray(keys) || keys.length < 2 || keys.length > 32) throw new Error('Invalid MuSig group');return keys.map(k => hex(k,33));};
  const checkScalar = scalar => {if (!(scalar instanceof Uint8Array) || scalar.length !== 32) throw new Error('Invalid signing input');return scalar;};
  const time = value => {if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid monotonic time');return BigInt(value);};
  const now = () => time(Math.floor(clock()));
  const status = value => {if (value !== 0) throw new Error(`MuSig rejected (${value})`);};
  function buffer(fn) {
    const base = api.tbc_signer_musig_buffer_new();
    if (!base) throw new Error('Signer allocation failed');
    const at = name => base + offsets[name];
    const put = (name, data) => new Uint8Array(api.memory.buffer, at(name), data.length).set(data);
    const list = (name, values, width) => values.forEach((value,index) => new Uint8Array(api.memory.buffer, at(name)+index*width,width).set(value));
    const get = (name,len) => Array.from(new Uint8Array(api.memory.buffer,at(name),len),x=>x.toString(16).padStart(2,'0')).join('');
    try {return fn({at,put,list,get});}
    finally {new Uint8Array(api.memory.buffer,base,8192).fill(0);api.tbc_signer_musig_buffer_free(base);}
  }
  function cancel(handle) {const decoded=hex(handle,32);buffer(({put,at})=>{put('handle',decoded);api.tbc_signer_musig_cancel(at('handle'));});}
  return Object.freeze({
    aggregateKey(publicKeys) {
      const keys=checkKeys(publicKeys);
      if(typeof api.tbc_signer_musig_aggregate_key!=='function')throw new Error('MuSig group derivation requires matching local5 artifact');
      return buffer(({at,list,get})=>{
        list('keys',keys,33);status(api.tbc_signer_musig_aggregate_key(at('keys'),keys.length,at('aggregate')));
        return get('aggregate',32);
      });
    },
    begin({publicKeys,aggregateKey,digest,binding,scalar,expiresAt}) {
      const keys=checkKeys(publicKeys),aggregate=hex(aggregateKey,32),msg=hex(digest,32),bound=hex(binding,32),key=checkScalar(scalar);
      const current=now(),deadline=time(expiresAt);
      return buffer(({at,put,list,get})=>{
        list('keys',keys,33);put('aggregate',aggregate);put('digest',msg);put('binding',bound);put('scalar',key);
        const entropy=new Uint8Array(32);
        try {crypto.getRandomValues(entropy);put('entropy',entropy);}
        finally {entropy.fill(0);}
        status(api.tbc_signer_musig_begin(at('keys'),keys.length,at('aggregate'),at('digest'),at('binding'),at('scalar'),at('entropy'),current,deadline,at('handle'),at('nonce')));
        return Object.freeze({handle:get('handle',32),publicNonce:get('nonce',66)});
      });
    },
    sign({handle,binding,digest,scalar,publicNonces}) {
      try {
        const id=hex(handle,32),bound=hex(binding,32),msg=hex(digest,32),key=checkScalar(scalar);
        if (!Array.isArray(publicNonces)||publicNonces.length<2||publicNonces.length>32) throw new Error('Invalid MuSig nonces');
        const nonces=publicNonces.map(n=>hex(n,66)),current=now();
        return buffer(({at,put,list,get})=>{
          put('handle',id);put('binding',bound);put('digest',msg);put('scalar',key);list('nonces',nonces,66);
          status(api.tbc_signer_musig_sign(at('handle'),at('binding'),at('digest'),at('scalar'),at('nonces'),nonces.length,current,at('signature')));
          return get('signature',32);
        });
      } catch(error) {if(validHex(handle,32))cancel(handle);throw error;}
    },
    combine({publicKeys,aggregateKey,digest,publicNonces,partialSignatures}) {
      const keys=checkKeys(publicKeys),aggregate=hex(aggregateKey,32),msg=hex(digest,32);
      if (!Array.isArray(publicNonces)||!Array.isArray(partialSignatures)||publicNonces.length!==keys.length||partialSignatures.length!==keys.length) throw new Error('Incomplete MuSig transcript');
      const nonces=publicNonces.map(n=>hex(n,66)),shares=partialSignatures.map(s=>hex(s,32));
      return buffer(({at,put,list,get})=>{
        list('keys',keys,33);put('aggregate',aggregate);put('digest',msg);list('nonces',nonces,66);list('shares',shares,32);
        status(api.tbc_signer_musig_combine(at('keys'),keys.length,at('aggregate'),at('digest'),at('nonces'),at('shares'),at('signature')));
        return get('signature',64);
      });
    },
    cancel,
    cancelAll(){api.tbc_signer_musig_cancel_all();},
  });
}
