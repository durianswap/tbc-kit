// The build installs the locked parser into dist/*/vendor after TypeScript runs.
// Describe that private runtime using its real upstream export, without loading
// the upstream package at runtime or replacing its signature with `any`.
export { decodeTxRaw } from "tbc-tx-parser";
