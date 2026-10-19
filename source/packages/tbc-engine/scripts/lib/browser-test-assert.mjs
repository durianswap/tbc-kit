// Acceptance-only assertions. No polyfill is injected into the installed Kit.
function ok(value,message='Expected truthy value'){if(!value)throw Error(message);}
function equal(actual,expected,message='Values differ'){ok(Object.is(actual,expected),message);}
function canonical(value){
 if(Array.isArray(value))return value.map(canonical);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
 return value;
}
function deepEqual(actual,expected,message='Structures differ'){equal(JSON.stringify(canonical(actual)),JSON.stringify(canonical(expected)),message);}
export default Object.assign(ok,{ok,equal,deepEqual});
