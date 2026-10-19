import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const files = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/wallet-standard-core.js", ["wallet-standard-core.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
  ["/build-identity.json", ["build-identity.json", "application/json"]],
]);
const port = Number(process.env.TBC_DAPP_PORT ?? 43170);
const host = process.env.TBC_DAPP_HOST ?? "127.0.0.1";
createServer(async (req, res) => {
  const item = files.get(new URL(req.url, "http://localhost").pathname);
  if (!item || !["GET", "HEAD"].includes(req.method)) { res.writeHead(404); res.end(); return; }
  try {
    const bytes = await readFile(new URL(`dist/${item[0]}`, import.meta.url));
    res.writeHead(200, { "Content-Type": item[1], "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(req.method === "HEAD" ? undefined : bytes);
  } catch { res.writeHead(500); res.end("Build the DApp before starting."); }
}).listen(port, host, () => console.log(`Standard DApp: http://${host}:${port}`));
