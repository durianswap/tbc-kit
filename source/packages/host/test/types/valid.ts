import type {
  PortCall,
  PortOperation,
  PortOperationMap,
  TwsCore,
} from "@tbc-wallet/core";
import {
  createTwsHost,
  type TwsAuthoritySource,
  type TwsHostPortOutcome,
  type TwsHostPorts,
  type TwsHostLeaseHeartbeatScheduler,
  type TwsHostStore,
} from "../../src/index.js";

type ExpectedOperations = {
  readonly [K in PortOperation]: {
    readonly params: PortOperationMap[K]["params"];
    readonly outcome: TwsHostPortOutcome<K>;
  };
};

declare const operationCoverage: ExpectedOperations;
declare const core: TwsCore;
declare const store: TwsHostStore;
declare const authority: TwsAuthoritySource;
declare const scheduleLeaseHeartbeat: TwsHostLeaseHeartbeatScheduler;

declare const result: <K extends PortOperation>(
  call: PortCall<K>,
  value: PortOperationMap[K]["result"],
)=> TwsHostPortOutcome<K>;

declare const unavailable: <K extends PortOperation>(
  _call: PortCall<K>,
)=> TwsHostPortOutcome<K>;

declare const accounts: TwsHostPorts["accounts"];
declare const chainData: TwsHostPorts["chainData"];
declare const policy: TwsHostPorts["policy"];
declare const permissionStore: TwsHostPorts["permissionStore"];
declare const approval: TwsHostPorts["approval"];
declare const signer: TwsHostPorts["signer"];
declare const broadcast: TwsHostPorts["broadcast"];
declare const clock: TwsHostPorts["clock"];
declare const entropy: TwsHostPorts["entropy"];

const ports = {
  accounts,
  chainData,
  policy,
  permissionStore,
  approval,
  signer,
  broadcast,
  clock,
  entropy,
} satisfies TwsHostPorts;

const host = createTwsHost({
  core,
  ports,
  store,
  authority,
  ownerId: "wallet-instance-1",
  scheduleLeaseHeartbeat,
});

void host.startOperation;
void host.resumeOperation;
void host.recoverPendingOperations;
void host.cancelOperation;
void host.inspectOperation;
void operationCoverage;
void result;
void unavailable;
