// Compile-time bridge only. The Kit build replaces this declaration facade
// with the exact same-release Core declaration closure inside the Kit tarball.
export type {
  CommitAckInput,
  PortCall,
  PortOperation,
  PortResponse,
  SchemaCoreTransition,
  StartInput,
  TransactionEngine,
} from "@tbc-wallet/core";
