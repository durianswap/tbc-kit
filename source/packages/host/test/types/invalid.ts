import type {
  ClockNowResult,
  PortCall,
  SignerSignResult,
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

declare const core: TwsCore;
declare const store: TwsHostStore;
declare const authority: TwsAuthoritySource;
declare const scheduleLeaseHeartbeat: TwsHostLeaseHeartbeatScheduler;
declare const signerCall: PortCall<"signer.sign">;
declare const signerResult: SignerSignResult;
declare const clockResult: ClockNowResult;
declare const ports: TwsHostPorts;

const validSignerOutcome: TwsHostPortOutcome<"signer.sign"> = signerResult;

// @ts-expect-error A clock result cannot satisfy signer.sign.
const wrongSignerOutcome: TwsHostPortOutcome<"signer.sign"> = clockResult;

const extraPort = {
  ...ports,
  // @ts-expect-error Host integrations cannot add private public Ports.
  vault: async () => ({ result: {} }),
} satisfies TwsHostPorts;

const host = createTwsHost({
  core,
  ports,
  store,
  authority,
  ownerId: "owner",
  scheduleLeaseHeartbeat,
});

// @ts-expect-error Durable Hosts require an explicit portable lease scheduler.
createTwsHost({ core, ports, store, authority, ownerId: "missing-scheduler" });

// @ts-expect-error The durable driver never exposes an execute shortcut.
void host.executeTransaction;
// @ts-expect-error The durable driver never exposes sign-and-send.
void host.signAndSend;

// @ts-expect-error Port outcomes require the exact registered result type.
const broadSignerOutcome: TwsHostPortOutcome<"signer.sign"> = {};

void [validSignerOutcome, wrongSignerOutcome, extraPort, broadSignerOutcome];
void signerCall;
