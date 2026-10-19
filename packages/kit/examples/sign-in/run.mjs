import { fork } from "node:child_process";
import { runFrontend } from "./frontend.mjs";

const backendProcess = fork(new URL("./backend.mjs", import.meta.url), [], {
  stdio: ["ignore", "inherit", "inherit", "ipc"],
  env: {
    ...process.env,
    TBC_SIGN_IN_EXAMPLE_NOW: "2026-09-17T01:00:02Z",
  },
});

let nextId = 0;
const pending = new Map();
backendProcess.on("message", (message) => {
  const request = pending.get(message.id);
  if (request === undefined) return;
  pending.delete(message.id);
  if (message.ok) request.resolve(message.value);
  else request.reject(new Error(message.error));
});

function backend(action, input) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    backendProcess.send({ id, action, input });
  });
}

try {
  const result = await runFrontend(backend);
  process.stdout.write(`${JSON.stringify({ status: "pass", ...result })}\n`);
} finally {
  backendProcess.disconnect();
}
