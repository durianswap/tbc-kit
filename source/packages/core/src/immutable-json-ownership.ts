// Internal JSON ownership, NOT protocol validation or approval authority.
// Only checkpoint.ts adds its own copied, recursively frozen JSON nodes.
// Caller-supplied freeze(), Proxy and deserialized values never qualify.
export const ownedJsonValues = new WeakSet<object>();
