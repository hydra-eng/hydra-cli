// tests/plain-smoke.mjs — CI smoke: run hydra's one-shot path (`hydra.mjs "<prompt>"`)
// against an inline OpenAI-compatible mock provider and expect the mock reply echoed back.
import { spawn } from "node:child_process";
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const port = 17431 + Math.floor(Math.random() * 500);
const home = fs.mkdtempSync(path.join(os.tmpdir(), "hydra-smoke-"));
fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
fs.writeFileSync(
  path.join(home, "config.json"),
  JSON.stringify({
    active: "mock",
    providers: { mock: { name: "mock", baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "smoke", model: "smoke-model" } },
  })
);

const server = http.createServer((req, res) => {
  if (req.url.includes("/chat/completions")) {
    console.error("smoke: provider call reached the mock");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "pong-smoke-ok" } }] }));
    return;
  }
  console.error("smoke: hit " + req.url);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ data: [{ id: "smoke-model" }] }));
});

server.unref();
server.listen(port, "127.0.0.1");

const child = spawn(process.execPath, ["hydra.mjs", "reply with exactly: pong-smoke-ok"], {
  cwd: path.join(import.meta.dirname, ".."),
  env: { ...process.env, HYDRA_CFG_DIR: home },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (out += d));
const bail = setTimeout(() => {
  console.log("plain-smoke: FAIL (timeout, no process exit)\n" + out.slice(-1500));
  child.kill("SIGKILL");
  process.exit(1);
}, 30000);
child.on("exit", (code) => {
  clearTimeout(bail);
  server.close();
  const ok = /pong-smoke-ok/.test(out);
  console.log(`plain-smoke: ${ok ? "PASS" : "FAIL"} (exit ${code})`);
  if (!ok) console.log(out.slice(-1500));
  process.exit(ok && code === 0 ? 0 : 1);
});
