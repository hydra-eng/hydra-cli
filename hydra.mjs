#!/usr/bin/env node
// ============================================================
//  HYDRA v2.1.0 - fast local coding agent - opencode-style TUI
//  zero dependencies | ESM | node >= 18
//  NOTE: never put ESC codes inside regex literals; use ANSI_RX
// ============================================================
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { spawnSync } from "node:child_process";

const VERSION = "2.9.1";
const ESC = String.fromCharCode(27);
let CRIMSON = ESC + "[91m";
let CRIMSONBG = ESC + "[0;48;2;220;20;60m";
let DIM = ESC + "[90m";
const BOLD = ESC + "[1m";
const RESET = ESC + "[0m";
// ---- palettes (/theme) â€” the UI reads these each frame, so switching is live
const THEMES = {
  crimson: { hi: "91", bg: "0;48;2;220;20;60", dim: "90" },
  gold:    { hi: "93", bg: "0;48;2;191;144;0", dim: "93" },
  matrix:  { hi: "92", bg: "0;48;2;6;58;22", dim: "32" },
  ice:     { hi: "96", bg: "0;48;2;10;74;98", dim: "36" },
  mono:    { hi: "97", bg: "0;48;2;58;58;58", dim: "37" },
};
function applyTheme(name, persist = true) {
  const t = THEMES[name];
  if (!t) return false;
  CRIMSON = ESC + "[" + t.hi + "m";
  CRIMSONBG = ESC + "[0;" + t.bg + "m";
  DIM = ESC + "[" + t.dim + "m";
  if (CFG && CFG.theme !== name) {
    CFG.theme = name;
    if (persist) { try { saveCfg(); } catch { /* nop */ } }
  }
  return true;
}
function activeTheme() { return (CFG && THEMES[CFG.theme] && CFG.theme) || "crimson"; }
const SPINNER_FRAMES = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];
const ANSI_RX = new RegExp(ESC + "\\[[0-9;]*[a-zA-Z]", "g");
const cc = (style, text) => (style ? style + text + RESET : text);
const stripAnsi = (s) => s.replace(ANSI_RX, "");
const clamp = (n, a, b) => (n < a ? a : n > b ? b : n);

function wrapText(text, width) {
  if (width < 8) return [String(text)];
  const out = [];
  for (const raw of String(text).split("\n")) {
    if (raw === "") { out.push(""); continue; }
    let line = "";
    for (const word of raw.split(" ")) {
      if (line === "") { line = word; }
      else if (stripAnsi(line + " " + word).length <= width) { line += " " + word; }
      else { out.push(line); line = word; }
      while (stripAnsi(line).length > width) {
        const cut = line.slice(0, Math.max(width - 1, 1));
        out.push(cut);
        line = line.slice(cut.length);
        if (line.startsWith(" ")) line = line.slice(1);
      }
    }
    out.push(line);
  }
  return out;
}

// ------------------------------------------------------------
//  config  ( C:\Users\Acer\.hydra\config.json )
// ------------------------------------------------------------
const CFG_DIR = process.env.HYDRA_CFG_DIR ? path.resolve(process.env.HYDRA_CFG_DIR) : path.join(os.homedir(), ".hydra");
const CFG_PATH = path.join(CFG_DIR, "config.json");
let CFG = null;

function defConfig() {
  return {
    active: "ollama",
    providers: {
      ollama: {
        name: "ollama",
        baseURL: "http://localhost:11434/v1",
        apiKey: "",
        model: "llama3:latest",
        keepAlive: "24h",
      },
      zen: {
        name: "zen",
        baseURL: "https://opencode.ai/zen/v1",
        apiKey: "",
        model: "free-model",
        keepAlive: "",
      },
    },
  };
}

function loadCfg() {
  try { CFG = JSON.parse(fs.readFileSync(CFG_PATH, "utf8")) || defConfig(); }
  catch { CFG = defConfig(); }
  if (!CFG.providers || typeof CFG.providers !== "object") CFG.providers = {};
  if (!CFG.mcps || typeof CFG.mcps !== "object") CFG.mcps = {};
  applyTheme(CFG.theme || "crimson", false);
  return CFG;
}
function saveCfg() {
  try { fs.mkdirSync(CFG_DIR, { recursive: true }); } catch { /* nop */ }
  fs.writeFileSync(CFG_PATH, JSON.stringify(CFG, null, 2));
}
function activeProvider() {
  const def = defConfig();
  if (!CFG.providers[CFG.active]) CFG.providers[CFG.active] = def.providers[CFG.active] || def.providers.ollama;
  return CFG.providers[CFG.active];
}


// ------------------------------------------------------------
//  tools ( bash read write edit list glob grep )
// ------------------------------------------------------------
const SKIP_DIRS = ["node_modules", ".git", "dist", "build", "target", ".venv", "__pycache__", ".next"];
let CWD = process.cwd();

function runToolCall(tc) {
  let args = {};
  try { args = JSON.parse(tc.function?.arguments || "{}"); } catch { args = {}; }
  const label = `${tc.function?.name || "?"} ${JSON.stringify(args).slice(0, 90)}`;
  let result = "";
  try {
    if (tc.function?.name === "bash") {
      const sh = process.env.SystemRoot ? process.env.SystemRoot + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" : "powershell.exe";
      const r = spawnSync(sh,
        ["-NoProfile", "-NoLogo", "-ExecutionPolicy", "Bypass", "-Command", String(args.command || "")],
        { cwd: CWD, timeout: 120000, maxBuffer: 1024 * 1024 * 4, encoding: "utf8", windowsHide: true });
      result = ((r.stdout || "") + (r.stderr ? "\n[stderr] " + r.stderr : "")).trim();
      if (r.status) result += `[exit ${r.status}]`;
    } else if (tc.function?.name === "read") {
      result = fs.readFileSync(path.resolve(CWD, args.filePath), "utf8");
    } else if (tc.function?.name === "write") {
      const p = path.resolve(CWD, args.filePath);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, args.content ?? "", "utf8");
      result = "written " + p;
    } else if (tc.function?.name === "edit") {
      const p = path.resolve(CWD, args.filePath);
      const src = fs.readFileSync(p, "utf8");
      if (!src.includes(args.oldString)) throw new Error("oldString not found: " + args.oldString);
      fs.writeFileSync(p, src.replace(args.oldString, args.newString ?? ""), "utf8");
      result = "edited " + p;
    } else if (tc.function?.name === "list") {
      result = fs.readdirSync(args.dirPath ? path.resolve(CWD, args.dirPath) : CWD, { withFileTypes: true })
        .filter((d) => !SKIP_DIRS.includes(d.name))
        .map((d) => d.name + (d.isDirectory() ? "/" : "")).join("\n");
    } else if (tc.function?.name === "glob") {
      const dir = args.dirPath ? path.resolve(CWD, args.dirPath) : CWD;
      const rx = new RegExp("^" + String(args.pattern || "*").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0001").replace(/\*/g, "[^\\\\]*").replace(/\u0001/g, ".*") + "$", "i");
      const found = [];
      const walk = (d, rel) => {
        if (found.length > 200) return;
        let names = [];
        try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of names) {
          if (e.isDirectory() && SKIP_DIRS.includes(e.name)) continue;
          const r = rel ? rel + "\\" + e.name : e.name;
          if (e.isDirectory()) walk(path.join(d, e.name), r);
          else if (rx.test(e.name) || rx.test(r)) found.push(r);
        }
      };
      walk(dir, "");
      result = found.join("\n") || "(no match)";
    } else if (tc.function?.name === "grep") {
      const dir = args.dirPath ? path.resolve(CWD, args.dirPath) : CWD;
      const ext = args.glob ? path.extname(args.glob) || args.glob : null;
      const rx = new RegExp(String(args.pattern || ""), "i");
      const hits = [];
      const walk = (d, rel) => {
        if (hits.length > 100) return;
        let names = [];
        try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of names) {
          if (e.isDirectory()) { if (SKIP_DIRS.includes(e.name)) continue; walk(path.join(d, e.name), rel ? rel + "\\" + e.name : e.name); }
          else {
            if (ext && !e.name.endsWith(ext)) continue;
            try {
              const txt = fs.readFileSync(path.join(d, e.name), "utf8");
              txt.split("\n").forEach((l, i) => { if (rx.test(l) && hits.length < 100) hits.push((rel ? rel + "\\" + e.name : e.name) + ":" + (i + 1) + ": " + l.trim().slice(0, 160)); });
            } catch { /* skip */ }
          }
        }
      };
      walk(dir, "");
      result = hits.join("\n") || "(no match)";
    } else { result = "unknown tool " + tc.function?.name; }
  } catch (e) { result = "ERROR: " + e.message; }
  const rr = String(result || "(empty)");
  if (rr.length > 60000) return { label, result: rr.slice(0, 60000) + "\n...[truncated]" };
  return { label, result: rr };
}

const TOOLS_SCHEMA = [
  { type: "function", function: { name: "bash", description: "Run a PowerShell command in the working dir.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
  { type: "function", function: { name: "read", description: "Read a text file.", parameters: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] } } },
  { type: "function", function: { name: "write", description: "Write/create a file.", parameters: { type: "object", properties: { filePath: { type: "string" }, content: { type: "string" } }, required: ["filePath", "content"] } } },
  { type: "function", function: { name: "edit", description: "Replace oldString with newString in a file.", parameters: { type: "object", properties: { filePath: { type: "string" }, oldString: { type: "string" }, newString: { type: "string" } }, required: ["filePath", "oldString", "newString"] } } },
  { type: "function", function: { name: "list", description: "List a directory.", parameters: { type: "object", properties: { dirPath: { type: "string" } } } } },
  { type: "function", function: { name: "glob", description: "Find files by pattern like *.mjs.", parameters: { type: "object", properties: { pattern: { type: "string" }, dirPath: { type: "string" } }, required: ["pattern"] } } },
  { type: "function", function: { name: "grep", description: "Search file contents.", parameters: { type: "object", properties: { pattern: { type: "string" }, glob: { type: "string" }, dirPath: { type: "string" } }, required: ["pattern"] } } },
];


// ------------------------------------------------------------
//  chat: streaming completion with tool calls + abort
// ------------------------------------------------------------
// hard deadline for model calls so a dead provider server can never hang the app forever
// (tune with env HYDRA_MODEL_TIMEOUT, milliseconds)
const MODEL_TIMEOUT = Math.max(5000, Number(process.env.HYDRA_MODEL_TIMEOUT) || 180000);
const withTimeout = (signal, ms) => AbortSignal.any([signal, AbortSignal.timeout(ms)].filter(Boolean));

async function chatOnce(messages, provider, ondelta, signal, noTools) {
  const body = { model: provider.model, messages, stream: true, tools: noTools ? undefined : TOOLS_SCHEMA, temperature: 0.2 };
  const isOllama = /11434|ollama/i.test(provider.baseURL || "");
  if (isOllama && provider.keepAlive) body.keep_alive = provider.keepAlive;
  const headers = { "Content-Type": "application/json" };
  if (provider.apiKey) headers.Authorization = "Bearer " + provider.apiKey;
  const res = await fetch(provider.baseURL.replace(/\/$/, "") + "/chat/completions", {
    method: "POST", headers, body: JSON.stringify(body), signal: withTimeout(signal, MODEL_TIMEOUT),
  });
  const ct0 = res.headers.get("content-type") || "";
  if (!ct0.includes("text/event-stream")) {
    const j = await res.json();
    if (!res.ok) throw new Error(j.error?.message || j.error || j.message || "HTTP " + res.status);
    const m = j.choices?.[0]?.message || {};
    return { content: m.content || "", tool_calls: m.tool_calls || null };
  }
  const decoder = new TextDecoder();
  let buf = "", content = "", reasonBuf = "";
  const toolCalls = [];
  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n");
    buf = parts.pop() || "";
    for (const line of parts) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (payload === "[DONE]") continue;
      let j; try { j = JSON.parse(payload); } catch { continue; }
      if (j.type === "error") throw new Error(j.error?.message || "provider error");
      const d = j.choices?.[0]?.delta || {};
      if (d.reasoning_content) reasonBuf += d.reasoning_content;
      if (d.content) { content += d.content; if (ondelta) ondelta(d.content); }
      for (const tc of d.tool_calls || []) {
        const idx = tc.index ?? toolCalls.length;
        toolCalls[idx] = toolCalls[idx] || { id: tc.id || "call_" + idx, type: "function", function: { name: "", arguments: "" } };
        if (tc.id) toolCalls[idx].id = tc.id;
        if (tc.function?.name) toolCalls[idx].function.name = (toolCalls[idx].function.name || "") + tc.function.name;
        if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
      }
    }
  }
  if (!content && !toolCalls.length && reasonBuf) content = reasonBuf;
  return {
    content,
    tool_calls: toolCalls.length
      ? toolCalls.filter(Boolean).map((t) => ({ ...t, function: { ...t.function, arguments: t.function.arguments || "{}" } }))
      : null,
  };
}

const MAX_STEPS = 32;
const SESSION_START = Date.now();
let TOOL_CALLS_TOTAL = 0;

function SYS() {
  return [
    "You are HYDRA, a coding agent inside a Windows terminal UI. Version " + VERSION + ".",
    "OS: Windows, PowerShell 5.1 (no apostrophes inside single-quoted PowerShell commands).",
    "Working directory: " + CWD + ".",
    "You have tools: bash, read, write, edit, list, glob, grep.",
    "Rules: act autonomously, do not ask questions. Prefer edit over rewrite.",
    "Use relative paths against the working directory when possible.",
    "Be concise in final answers. If a tool errors, adapt once, then answer.",
  ].join("\n");
}

function runToolLabel(tc) {
  let args = {};
  try { args = JSON.parse(tc.function?.arguments || "{}"); } catch { /* nop */ }
  return `${tc.function?.name || "?"} ${JSON.stringify(args).slice(0, 110)}`;
}

async function agentLoop(question, provider, ondelta, onTool, history, signal, noTools) {
  const sys = SYS() + (noTools ? "\nPLAN MODE: Discuss and advise only. Do NOT call any tools this turn." : "");
  const messages = [{ role: "system", content: sys }, ...(history || []), { role: "user", content: question }];
  let finalText = "";
  for (let step = 0; step < MAX_STEPS; step++) {
    const out = await chatOnce(messages, provider, ondelta, signal, noTools);
    finalText = out.content;
    messages.push({ role: "assistant", content: out.content, ...(out.tool_calls ? { tool_calls: out.tool_calls } : {}) });
    if (!out.tool_calls || signal?.aborted) {
      if (history) {
        history.push({ role: "user", content: question }, { role: "assistant", content: finalText });
        while (history.length > 40) history.shift();
      }
      return finalText;
    }
    for (const tc of out.tool_calls) {
      TOOL_CALLS_TOTAL++;
      if (onTool) onTool(runToolLabel(tc));
      const callRes = runToolCall(tc);
      messages.push({ role: "tool", tool_call_id: tc.id, content: callRes.result });
    }
  }
  return finalText;
}


// ------------------------------------------------------------
//  providers + models + commands ( plain-string API )
// ------------------------------------------------------------
let lastModels = [];

async function fetchModels() {
  const p = activeProvider();
  return fetchModelsFor(p.baseURL, p.apiKey);
}
async function fetchModelsFor(baseURL, apiKey) {
  const headers = {};
  if (apiKey) headers.Authorization = "Bearer " + apiKey;
  const r = await fetch(String(baseURL).replace(/\/$/, "") + "/models", { headers, signal: AbortSignal.timeout(15000) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || j.error);
  lastModels = (j.data || j.models || []).map((m) => m.id || m.name || String(m)).filter(Boolean).sort();
  return lastModels;
}

function providerListLines() {
  loadCfg();
  const out = [" Providers:"];
  for (const [name, p] of Object.entries(CFG.providers)) {
    const mark = name === CFG.active ? "*" : " ";
    out.push(` ${mark} ${cc(CRIMSON + BOLD, name.padEnd(12))} ${cc(DIM, p.model)} `);
  }
  out.push(cc(DIM, " /provider use <name> | add | del"));
  return out;
}
function providerUseLines(name) {
  loadCfg();
  if (!CFG.providers[name]) return [cc("\u001b[31m", ` no provider named '${name}'`)];
  CFG.active = name; saveCfg();
  return [` provider -> ${cc(CRIMSON + BOLD, name)} ${cc(DIM, activeProvider().model)}`];
}
function providerAddLines(name, baseURL, apiKey, model) {
  if (!name || !baseURL || !model) return [cc("\u001b[31m", " usage: /provider add <name> <baseURL> <apiKey> <model>")];
  CFG.providers[name] = { name, baseURL, apiKey: apiKey || "", model, keepAlive: "" };
  CFG.active = name; saveCfg();
  return [` provider added -> ${cc(CRIMSON + BOLD, name)} (${model})`];
}
function providerDelLines(name) {
  if (!CFG.providers[name]) return [cc("\u001b[31m", ` no provider named '${name}'`)];
  delete CFG.providers[name];
  const def = defConfig();
  if (!CFG.providers[CFG.active]) CFG.active = CFG.providers.ollama ? "ollama" : (Object.keys(CFG.providers)[0] || "ollama");
  if (!CFG.providers[CFG.active]) CFG.providers[CFG.active] = def.providers[CFG.active];
  saveCfg();
  return [` provider removed -> active: ${cc(CRIMSON + BOLD, CFG.active)}`];
}

// ---- paste-key connect: one step, any key accepted ( /key <paste> or provider popup )
const KEY_VENDORS = [
  [/^oc_sk_/, { name: "zen", baseURL: "https://opencode.ai/zen/v1" }],
  [/^sk-or-/, { name: "openrouter", baseURL: "https://openrouter.ai/api/v1" }],
  [/^sk-proj-/, { name: "openai", baseURL: "https://api.openai.com/v1" }],
  [/^sk-/, { name: "openai", baseURL: "https://api.openai.com/v1" }],
  [/^gsk_/, { name: "groq", baseURL: "https://api.groq.com/openai/v1" }],
  [/^AIza/, { name: "gemini", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai" }],
  [/^hf_/, { name: "huggingface", baseURL: "https://router.huggingface.co/v1" }],
  [/^nvapi-/, { name: "nvidia", baseURL: "https://integrate.api.nvidia.com/v1" }],
];
function detectVendor(key) {
  for (const [rx, v] of KEY_VENDORS) if (rx.test(key)) return { name: v.name, baseURL: v.baseURL };
  return { name: "openai", baseURL: "https://api.openai.com/v1" };
}
const CHEAP_MODEL_RX = /free|flash|mini|lite|small|nano|-\d+b|\d+b/i;
function keySaveLines(v, key, model) {
  CFG.providers[v.name] = { name: v.name, baseURL: v.baseURL, apiKey: key, model: model || (CFG.providers[v.name] ? CFG.providers[v.name].model : ""), keepAlive: "" };
  CFG.active = v.name; saveCfg();
}
async function keyPasteLines(key) {
  if (!key) return [cc(DIM, " paste a key first \u00b7 /key <your-key>")];
  const v = detectVendor(key);
  startBusy("connecting " + v.name);
  let models = [];
  try { models = await fetchModelsFor(v.baseURL, key); }
  catch (e) {
    stopBusy();
    keySaveLines(v, key, "");
    return [
      cc("\u001b[31m", " couldn't verify " + v.baseURL + " (" + (e.message || e) + ") \u2014 key saved, will retry live on your first turn"),
      cc(DIM, " wrong host for this key? override: /provider add <name> <baseURL> <key> <model> \u00b7 /model to pick"),
    ];
  }
  stopBusy();
  if (!models.length) {
    keySaveLines(v, key, "");
    return [
      cc("\u001b[31m", " no models returned by " + v.baseURL + " \u2014 key saved"),
      cc(DIM, " set one manually: /provider add " + v.name + " " + v.baseURL + " <key> <model>")
    ];
  }
  const pick = models.find((m) => CHEAP_MODEL_RX.test(String(m))) || models[0];
  keySaveLines(v, key, pick);
  return [
    ` \u26a1 ${cc(CRIMSON + BOLD, v.name)} connected -> ${cc(CRIMSON + BOLD, pick)}`,
    cc(DIM, " one step, done \u00b7 /model to switch, /provider for the advanced flow"),
  ];
}

async function modelListLines() {
  loadCfg();
  const p = activeProvider();
  if (!lastModels.length) await fetchModels();
  const lines = [` Models on ${cc(CRIMSON + BOLD, p.name)}: ${cc(DIM, p.baseURL)}`, ""];
  lastModels.forEach((m, i) => {
    const active = m === p.model;
    lines.push(` ${active ? cc(CRIMSON + BOLD, "*") : " "} ${cc(active ? CRIMSON + BOLD : DIM, "" + (i + 1) + ". " + m)}${active ? cc(CRIMSON + BOLD, "   (active)") : ""}`);
  });
  lines.push("", cc(DIM, " switch: /model <number> or /model <partial name>"));
  return lines;
}

async function modelUseLines(arg) {
  arg = String(arg || "").trim();
  if (!arg) return [cc(DIM, " usage: /model <number> or /model <partial name>")];
  loadCfg();
  if (!lastModels.length) {
    try { await fetchModels(); }
    catch (e) {
      if (arg.includes("/")) {
        CFG.providers[CFG.active].model = arg; saveCfg();
        return [` model -> ${cc(CRIMSON + BOLD, arg)} ${cc(DIM, "(forced, list fetch failed)")}`];
      }
      return [cc("\u001b[31m", " error: " + e.message)];
    }
  }
  let pick = null;
  if (/^\d+$/.test(arg)) pick = lastModels[Number(arg) - 1] || null;
  else {
    const low = arg.toLowerCase();
    pick = lastModels.find((m) => m.toLowerCase() === low) || lastModels.find((m) => m.toLowerCase().startsWith(low)) || lastModels.find((m) => m.toLowerCase().includes(low)) || (arg.includes("/") ? arg : null);
  }
  if (!pick) return [cc("\u001b[31m", ` no model matched '${arg}'. type /model for a list.`)];
  CFG.providers[CFG.active].model = pick; saveCfg();
  return [` model -> ${cc(CRIMSON + BOLD, pick)}`];
}

let HISTORY = [];
let RESTORED = 0;
const COMMANDS = [
  { name: "/model", desc: "switch model", hint: " [n|name]" },
  { name: "/provider", desc: "switch provider \u00b7 paste key = one step", hint: "[name]" },
  { name: "/key", desc: "paste api key \u2014 auto-detects vendor, connects", hint: " <key>" },
  { name: "/sessions", desc: "session picker dialog", hint: "" },
  { name: "/export", desc: "export the active chat as markdown", hint: "[file]" },
  { name: "/rename", desc: "rename the active session", hint: "<title>" },
  { name: "/search", desc: "find sessions by words in messages or title", hint: "<words>" },
  { name: "/fork", desc: "branch the chat up to a turn into a new session", hint: "<turn>" },
  { name: "/theme", desc: "swap the whole UI palette, live", hint: "[crimson]" },
  { name: "/resume", desc: "reopen last session", hint: "" },
  { name: "/new", desc: "fresh session", hint: "" },
  { name: "/copylast", desc: "copy last reply", hint: "" },
  { name: "/skills", desc: "inject a skill", hint: "" },
  { name: "/mcp", desc: "list mcp servers", hint: "" },
  { name: "/mode", desc: "build/plan", hint: "" },
  { name: "/cd", desc: "change directory", hint: " [path]" },
  { name: "/clear", desc: "clear conversation", hint: "" },
  { name: "/help", desc: "all commands", hint: "" },
  { name: "/exit", desc: "quit hydra", hint: "" },
];

function helpLines() {
  return [
    "",
    cc(CRIMSON + BOLD, " Commands"),
    cc(DIM, " /model <n|name>      list + switch models"),
    cc(DIM, " /key <key>           paste api key \u2192 vendor auto-detected + connected in one step"),
    cc(CRIMSON + BOLD, "                      zen \u00b7 openai \u00b7 openrouter \u00b7 groq \u00b7 gemini \u00b7 huggingface \u00b7 nvidia"),
    cc(DIM, " /provider <name>     popup: switch \u00b7 \u2795 paste key (one step) \u00b7 \u2795 other = name \u2192 baseURL \u2192 api key"),
    cc(DIM, " /provider add <name> <baseURL> <apiKey> <model>"),
    cc(DIM, " /provider del <name> remove provider"),
    cc(DIM, " /cd <path>           change directory"),
    cc(DIM, " /new                 start a fresh session (context cleared)"),
    cc(DIM, " /sessions            dialog: \u2191\u2193 browse w/ preview \u00b7 enter continue \u00b7 r rename"),
    cc(DIM, "                      d d delete (u undo) \u00b7 1-9 jump \u00b7 mouse click/scroll"),
    cc(DIM, " /sessions <n>        load #n \u00b7 /resume reopen the last one \u00b7 all work mid-turn"),
    cc(DIM, " /export [file]       save the active chat as markdown in " + shortPath(CWD)),
    cc(DIM, " /rename <title>      rename the active session \u00b7 r in /sessions renames any"),
    cc(DIM, " /search <words>      scan all sessions, open hits in the browser dialog"),
    cc(DIM, " /fork <turn>         branch the chat up to that turn into a new session"),
    cc(DIM, " /theme [name]        live palette swap \u00b7 crimson gold matrix ice mono"),
    cc(DIM, " /copylast            copy last reply to clipboard"),
    cc(DIM, " /skills              inject a skill into context"),
    cc(DIM, " /mcp                 list configured mcp servers"),
    cc(DIM, " /clear               reset conversation + screen"),
    cc(DIM, " /exit                quit"),
    cc(DIM, " mouse: wheel scrolls \u00b7 drag text = select+copy \u00b7 pgup/pgdn \u00b7 shift+up/down"),
    cc(DIM, " cli: hydra-cli \"task\" = one-shot | --version"),
    "",
  ];
}


// ------------------------------------------------------------
//  TUI v2.1  ( logo center, slim right panel, composer box )
// ------------------------------------------------------------
const POPUP_RESERVE = 7;
const PANEL_W = 14;
const _inner = 28;
const _t2 = "\u2b22  H  Y  D  R  A  \u2b22"; // 19 cells
const _t3 = "h y d r a  \u00b7  c l i";   // 19 cells
const _pad = Math.floor((_inner - 19) / 2);
const WORDMARK = [
  "\u2554" + "\u2550".repeat(_inner) + "\u2557",
  "\u2551" + " ".repeat(_pad) + _t2 + " ".repeat(_inner - 19 - _pad) + "\u2551",
  "\u2551" + " ".repeat(_pad) + _t3 + " ".repeat(_inner - 19 - _pad) + "\u2551",
  "\u255a" + "\u2550".repeat(_inner) + "\u255d",
];
const HYDRA_MARK = [
  "                                             .....::-----:.....                                        ",
  "                                       .-#%%+-:::-----::-=#@%+.                                      ",
  "                                 ...=@%:.+@@@@@@@@@@@@@@@@@@#:.*@#...                                ",
  "                               ..+@+:*@@@@@@%*+-:....:-=*#@@@@@@%=-##:.                              ",
  "                              .%#:#@@@@@-...              ...:#@@@@@--@=.                            ",
  "                           ..%+-@@@@#:      ..-@@@@@@@@*..      .+@@@@*.@=.                         ",
  "                          .#*-@@@@=.      ..#@@@@@@@@@@@@@-.      .:#@@@*-%:.                        ",
  "                         -@.@@@@-.        .@@@@@@@@@@@@@@@@=.       ..%@@@-+#.                      ",
  "                        +#-@@@*.         .*@@@@@@@@@@@@@@@@@.         ..@@@#-@.                     ",
  "                      .*+=@@@:..=**:..   .+@@@@@@@@@@@@@@@@@.   ...+**:..#@@%.@..                   ",
  "                     .*++@@@.%@@@@@@@@:.  .@@@@@@@@@@@@@@@@*. ..*@@@@%@@@=+@@@.@.                   ",
  "                    .:%-@@@.@%.    .%@@#  .%@@#@@@@@@@@%%@@.  :@@@-.    :@=+@@%-#.                  ",
  "                    .@.@@@:@@..     .%@@@..+%....-@@%....-%. =@@@..     .+@-%@@=*+                  ",
  "                   .++#@@*=@#:.    ..=@@@:-@@@++@@#-@@#=#@@%.=@@@ ...   .=@%:@@@:%.                 ",
  "                   .@.@@@.=@@%*:..%:..@@@+.*@@@@@%..-@@@@@@..@@@- .*-:.**@@@.#@@+*=                 ",
  "                   -%:@@*...*@@@*..   :@@@+-:.-@@@@@@@@#.::-%@@*    .-@@@@-. .@@%=#.                ",
  "                  .=**@@= ..=+#%%%#*=-=..+%@@@:*##@#@@*:#@@@#:.-+-+#%%%#*+:...@@@:%.                ",
  "                  .++%@@= :@@@@@@@@@@@@@@%:-..-%%*:.=%@*...==@@@@@@@@@@@@@@*..@@@:@..               ",
  "                  .++#@@=.*@@@@+..  .=%@@@@@@@@@@#:.+%@@@@@@@@@@#:....-%@@@@..@@@:@..               ",
  "                  .=#+@@+.@@@+.       ...-*@@+:.:@%-@*..=%@@+....       :@@@:.@@@-%.                ",
  "                   :%.@@%.%@@.       .#.  ...+@@@@%-@@@@@...   --        =@@::@@*=#.                ",
  "                   .@.@@@:=@=.       .=#.-%@@@@@@%..+@@@@@@@=:.%.        .@@.%@@=#-                 ",
  "                   .-%=@@#:@@*.      -@.@@@@*=-:..  ...:=*%@@@-+%..     :@@*-@@@-#.                 ",
  "                    .@:#@@+=@@#*....@@-@@%..   ...  ....  ..+@@:@@*...:@%@%.@@@:%-                  ",
  "                    ..@:@@@--@@@@@@@@+*@*.     .%%:.#@:.     :@@.@@@@@@@@#.%@@=*+.                  ",
  "                      :%:@@@:.#@@@@@+=@@..      .@*-@..      .*@%.@@@@@@-.%@@*+*.                   ",
  "                      .-%:@@@+.......@@@-.      .**-@:.      .%@@.......:@@@+=#.                    ",
  "                        :%:%@@@:    .=@@@:.    .-@*-@%..   .:#@@#.    .*@@@-#+.                     ",
  "                         .#*-@@@%..   .#@@@*@%*@@@+.@@@%+@*@@@@.    .=@@@#:@:                       ",
  "                          .:@-+@@@@:.  ..#@@@@@@@*..:@@@@@@@@-.  ..*@@@%:#*..                       ",
  "                            .-@-=@@@@#:   .-#+:...   ..:=#+..  .+@@@@#:##..                         ",
  "                              .-@+.%@@@@@*:....         ....=@@@@@@=:@*.                           ",
  "                                ..+@+:+@@@@@@@@%##***#%@@@@@@@@#--##:.                             ",
  "                                    .-%@+.:+%@@@@@@@@@@@@@*-.-%@+..                                ",
  "                                         .=#%@%*+====+*#@%%+:.                                     ",
  "                                             ............                                         ",
];

const UI = {
  rows: process.stdout.rows || 30,
  cols: process.stdout.columns || 110,
  log: [],
  input: "",
  busy: false,
  busyLabel: "",
  busyStart: 0,
  spinner: 0,
  turn: 0,
  mode: "Build",
  scroll: 0,   // 0 = live (bottom); N = lines scrolled up
  anchorStart: null,   // frozen top offset of the viewport while scrolled up, so new logs do not slide the view away
  anchorScroll: null,  // scroll value at the moment the anchor was frozen (detecting new user scrolls vs new content)
  dialog: null, // { kind:"sessions", sel:0, items:[{value,name,when,turns,whenISO}], file:"", preview:[] }
};

function centerText(text, width) {
  const pad = Math.max(0, Math.floor((width - stripAnsi(text).length) / 2));
  return " ".repeat(pad) + text;
}
function padRow(text, width) {
  const plain = stripAnsi(text);
  if (plain.length > width) return plain.slice(0, width);
  return text + " ".repeat(width - plain.length);
}
function clip(s, n) { const p = stripAnsi(s); return p.length > n ? p.slice(0, Math.max(n - 1, 0)) + "\u2026" : p; }
function fmtDur(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  return Math.floor(s / 60) + "m " + (s % 60) + "s";
}
function shortPath(p) {
  const home = os.homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}
function crashLog(err) {
  try { fs.appendFileSync(path.join(CFG_DIR, "crash.log"), new Date().toISOString() + "\n" + (err.stack || String(err)) + "\n\n"); } catch { /* nop */ }
}
function dbgMark(tag) {
  try { fs.appendFileSync(path.join(CFG_DIR, "last_run.txt"), `${new Date().toISOString()} ${tag} outTTY=${process.stdout.isTTY} inTTY=${process.stdin.isTTY} rows=${process.stdout.rows} cols=${process.stdout.columns}\n`); } catch { /* nop */ }
}

function enterTUI() {
  if (process.stdout.isTTY) {
    try { process.stdin.setRawMode(true); } catch { /* harness */ }
    readline.emitKeypressEvents(process.stdin);
    process.stdin.on("data", () => { });
    try { process.stdin.resume(); } catch { /* nop */ }
    process.stdout.write(ESC + "[?1049h" + ESC + "[?25l" + ESC + "[?1000h" + ESC + "[?1006h");
    process.stdout.on("resize", () => {
      if (process.stdout.rows) UI.rows = process.stdout.rows;
      if (process.stdout.columns) UI.cols = process.stdout.columns;
      UI.log.forEach((e) => { e.cache = null; });
      SELECTION = null;
      scheduleDraw(true);
    });
  }
}
function exitTUI() {
  if (process.stdout.isTTY) {
    process.stdout.write(ESC + "[?25h" + ESC + "[?1000l" + ESC + "[?1006l" + ESC + "[?1049l");
    try { process.stdin.setRawMode(false); } catch { /* nop */ }
  }
}

let drawTimer = null;
let fullDraw = true;
let SPLASH = true;
function scheduleDraw(full) {
  if (SPLASH) { if (full) fullDraw = true; return; }
  if (full) fullDraw = true;
  if (drawTimer) return;
  drawTimer = setTimeout(() => { drawTimer = null; try { drawFrame(); } catch (e) { crashLog(e); } }, 40);
}
function addLog(text) {
  UI.log.push({ text: String(text), cache: null });
  if (UI.log.length > 3000) {
    const dropped = UI.log.splice(0, UI.log.length - 3000);
    let dwl = 0;
    for (const d of dropped) { if (d.cache && Array.isArray(d.cache)) dwl += d.cache.length; d.cache = null; }
    if (dwl && UI.anchorStart != null) UI.anchorStart = Math.max(0, UI.anchorStart - dwl);   // keep the frozen viewport on the same content
  }
  scheduleDraw();
}
function addLogLines(lines) { for (const l of lines || []) addLog(l); }
function setUserInput(v) { UI.input = v; syncSlashPopup(); UI.scroll = 0; scheduleDraw(); }

function nudgeScroll(n) {
  UI.scroll = Math.max(0, UI.scroll + n);
  scheduleDraw();
}

function pasteClipboard() {
  startBusy("pasting");
  try {
    const sh = process.env.SystemRoot ? process.env.SystemRoot + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" : "powershell.exe";
    const r = spawnSync(sh, ["-NoProfile", "-NoLogo", "-Command", "Get-Clipboard -Raw"],
      { timeout: 15000, encoding: "utf8", windowsHide: true });
    if (r.status) { stopBusy(); addLog(cc("\u001b[31m", " paste failed (exit " + r.status + ")")); return; }
    let txt = String(r.stdout || "").replace(/\r/g, "").replace(/\n+/g, " ").trim();
    if (!txt) { stopBusy(); addLog(cc(DIM, " clipboard empty")); return; }
    if (txt.length > 4000) txt = txt.slice(0, 4000);
    setUserInput((UI.input + txt).slice(0, 8000));
    stopBusy();
    addLog(cc(DIM, " pasted " + txt.length + " chars"));
  } catch (e) { stopBusy(); addLog(cc("\u001b[31m", " paste failed: " + (e.message || e))); }
}

function listSessions() {
  try {
    return fs.readdirSync(sessionsDir()).filter((f) => f.endsWith(".json")).sort().reverse()
      .map((f) => {
        let turns = 0, whenISO = "";
        let name = f.replace(/\.json$/, "");
        if (/^\d{4}-\d{2}-\d{2}T/.test(name) && name.length >= 24) {
          name = name[24] === "-" ? name.slice(25) : (name.slice(5, 10) + " " + name.slice(11, 16).replace("-", ":"));
        }
        try {
          let rawN = fs.readFileSync(path.join(sessionsDir(), f), "utf8");
          if (rawN.charCodeAt(0) === 0xFEFF) rawN = rawN.slice(1);
          const j = JSON.parse(rawN);
          turns = (j.history || []).length;
          whenISO = j.when || "";
          if (j.name) return { value: f, name: String(j.name), whenISO, turns };
        } catch { /* unparsable: fall through to filename name */ }
        return { value: f, name: name || "chat", whenISO, turns };
      });
  } catch { return []; }
}

// ---- opencode-style sessions dialog ( list + live preview of what you did )
function relTime(iso) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return "--";
  const d = Math.max(0, Date.now() - t);
  if (d < 60_000) return "now";
  if (d < 3_600_000) return Math.floor(d / 60_000) + "m ago";
  if (d < 86_400_000) return Math.floor(d / 3_600_000) + "h ago";
  return Math.floor(d / 86_400_000) + "d ago";
}
function previewLines(file, prevW) {
  const outp = [];
  try {
    let rawP = fs.readFileSync(path.join(sessionsDir(), String(file)), "utf8");
    if (rawP.charCodeAt(0) === 0xFEFF) rawP = rawP.slice(1);
    const j = JSON.parse(rawP);
    const hist = Array.isArray(j.history) ? j.history : [];
    const umsgs = hist.filter((m) => m.role === "user" && !String(m.content || "").startsWith("[skill"));
    const amsgs = hist.filter((m) => m.role === "assistant");
    outp.push(cc(CRIMSON + BOLD, " " + String(j.name || file)));
    outp.push(cc(DIM, " " + relTime(j.when) + " \u00b7 " + umsgs.length + " prompts \u00b7 " + amsgs.length + " replies"));
    const p = j.provider || j.model ? (j.provider || "") + (j.model ? " \u00b7 " + j.model : "") : "";
    if (p) outp.push(cc(DIM, " " + clip(p, prevW - 2)));
    outp.push("");
    const show = hist.filter((m) => !String(m.content || "").startsWith("[skill")).slice(-14);
    for (const m of show) {
      const c = String(m.content || "").replace(/\s+/g, " ").trim();
      if (!c) continue;
      const title = m.role === "user" ? " " + cc(CRIMSON + BOLD, "\u276f ") : " " + cc(DIM, "\u00b7 ");
      for (const l of wrapText(title + c, prevW)) outp.push(l);
    }
    if (hist.length > show.length) outp.push(cc(DIM, "  (+ " + (hist.length - show.length) + " earlier messages)"));
  } catch (e) {
    outp.push(cc("\u001b[31m", " preview failed: " + (e.message || e)));
  }
  return outp;
}
function openSessionsDialog(items, title) {
  items = items || listSessions();
  UI.dialog = { kind: "sessions", sel: 0, items, file: "", preview: [], previewW: 0, previewFile: "", mode: "", buf: "", armDelete: false, title: title || "sessions" };
  if (!items.length) UI.dialog.items = [];
  SELECTION = null;
  syncDialogPreview();
  setUserInput("");
  scheduleDraw(true);
}
function syncDialogPreview() {
  const d = UI.dialog;
  if (!d) return;
  const prevW = Math.max(18, Math.floor((UI.cols - 2) * 0.40));
  const cur = d.items[d.sel];
  const file = cur ? cur.value : "";
  if (file === d.previewFile && d.previewW === prevW) return;
  d.previewFile = file;
  d.previewW = prevW;
  d.file = file;
  d.preview = file ? previewLines(file, prevW - 2) : [cc(DIM, " (no sessions yet \u00b7 a session is saved after each turn)")];
}
function closeDialog() { UI.dialog = null; scheduleDraw(); }
function dialogActivate() {
  const d = UI.dialog;
  if (!d) return;
  const it = d.items[d.sel];
  closeDialog();
  if (it && it.value) {
    if (String(it.value) === ACTIVE_SESSION_FILE) { addLog(cc(DIM, " (that is already the active session \u00b7 your chat is right here)")); scheduleDraw(true); }
    else loadSessionFile(it.value);   // auto-queues if a turn is busy
  }
}
function injectSkillValue(v) {
  const s = listSkillDirs()[Number(v)];
  try {
    const txt = fs.readFileSync(path.join(s.dir, s.name, "SKILL.md"), "utf8").slice(0, 6000);
    HISTORY.push({ role: "user", content: "[skill guide: " + s.name + "]\n" + txt });
    addLog(cc(DIM, " skill \u201c" + s.name + "\u201d injected into context"));
  } catch { addLog(cc(DIM, " skill \u201c" + s.name + "\u201d has no SKILL.md \u00b7 skipped")); }
  scheduleDraw(true);
}
function popupActivate() {
  const t = UI.popupTitle, it = UI.popupItems[UI.popupSel];
  closePopup(); setUserInput("");
  if (!it) return;
  if (popupKind() === "model") { startBusy("switching model"); ((async () => { try { addLogLines(await modelUseLines(String(Number(it.value) + 1))); } catch (e) { addLog(cc("\u001b[31m", " error: " + (e.message || e))); } stopBusy(); })()); return; }
  if (popupKind() === "provider") { if (it.value === "pastekey") { startPasteKeyCapture(); return; } if (it.value === "other") { startCustomProvider(); return; } addLogLines(providerUseLines(it.value)); return; }
  if (popupKind() === "custom") { providerPickModels(); return; }
  if (popupKind() === "skills") { injectSkillValue(it.value); return; }
  if (popupKind() === "theme") { applyTheme(String(it.value)); addLog(cc(CRIMSON + BOLD, "  palette -> " + it.value + " \u00b7 applies instantly, saved to config")); scheduleDraw(true); return; }
  if (t === "slash") { setUserInput((it.value || stripAnsi(it.label)).trim() + " "); syncSlashPopup(); return; }
}
const TRASH_DIR = () => path.join(sessionsDir(), ".trash");
function trashLast() {
  try {
    const t = TRASH_DIR();
    const files = fs.existsSync(t) ? fs.readdirSync(t).filter((f) => f.endsWith(".json")).sort() : [];
    return files.length ? files[files.length - 1] : null;
  } catch { return null; }
}
function deleteDialogSession() {
  const d = UI.dialog;
  if (!d) return;
  const cur = d.items[d.sel];
  if (!cur || !cur.value) { addLog(cc(DIM, " nothing to delete")); return; }
  try {
    fs.mkdirSync(TRASH_DIR(), { recursive: true });
    const stash = String(Date.now()).padStart(13, "0") + "-" + String(cur.value);
    const dest = path.join(TRASH_DIR(), stash);
    try { fs.renameSync(path.join(sessionsDir(), String(cur.value)), dest); }
    catch (e) { fs.copyFileSync(path.join(sessionsDir(), String(cur.value)), dest); fs.unlinkSync(path.join(sessionsDir(), String(cur.value))); }
    addLog(cc(DIM, " (trash: " + stash + ")"));
  } catch (e) { addLog(cc("\u001b[31m", " delete failed: " + (e.message || e))); return; }
  if (String(cur.value) === ACTIVE_SESSION_FILE) {
    ACTIVE_SESSION_FILE = ""; SESSION_FILE_TS = null; CURRENT_SESSION_TITLE = "";
    addLog(cc(DIM, " (that was the active session \u00b7 next turn saves a fresh file)"));
  }
  addLog(cc(CRIMSON + BOLD, " deleted \u201c" + clip(String(cur.name || cur.value), Math.max(16, UI.cols - PANEL_W - 14)) + "\u201d \u00b7 press u in the dialog to undo"));
  SESSIONS_DIRTY = true;
  d.items = listSessions();
  d.sel = clamp(d.sel, 0, Math.max(0, d.items.length - 1));
  d.previewFile = ""; syncDialogPreview();
  scheduleDraw(true);
}
function undoDialogDelete() {
  const f = trashLast();
  if (!f) { addLog(cc(DIM, " nothing to undo \u00b7 trash empty")); return; }
  const restoreName = /^([0-9]{13})-/.test(f) ? f.replace(/^([0-9]{13})-/, "") : f;
  try {
    const src = path.join(TRASH_DIR(), f);
    const dest = path.join(sessionsDir(), restoreName);
    try { fs.rmSync(dest, { force: true }); } catch { /* nop */ }
    try { fs.renameSync(src, dest); }
    catch (e) { fs.copyFileSync(src, dest); fs.unlinkSync(src); }
    addLog(cc(CRIMSON + BOLD, " restored \u201c" + clip(restoreName, Math.max(16, UI.cols - PANEL_W - 14)) + "\u201d"));
  } catch (e) { addLog(cc("\u001b[31m", " undo failed: " + (e.message || e))); }
  SESSIONS_DIRTY = true;
  const d = UI.dialog;
  if (d) {
    if (restoreName === ACTIVE_SESSION_FILE) ACTIVE_SESSION_FILE = restoreName;
    d.items = listSessions();
    d.sel = clamp(d.items.findIndex((x) => x.value === restoreName), 0, Math.max(0, d.items.length - 1));
    d.previewFile = ""; syncDialogPreview();
    scheduleDraw(true);
  }
}
function startRenameDialog() {
  const d = UI.dialog;
  if (!d) return;
  const cur = d.items[d.sel];
  if (!cur || !cur.value) { addLog(cc(DIM, " nothing to rename")); return; }
  d.mode = "rename";
  d.buf = String(cur.name || "");
  scheduleDraw(true);
}
function commitRenameDialog() {
  const d = UI.dialog;
  if (!d || d.mode !== "rename") return;
  const it = d.items[d.sel];
  const nm = String(d.buf || "").trim().slice(0, 48);
  d.mode = ""; d.buf = "";
  if (!it || !it.value) { scheduleDraw(true); return; }
  if (!nm) { addLog(cc(DIM, " rename cancelled")); scheduleDraw(true); return; }
  try {
    const oldPath = path.join(sessionsDir(), String(it.value));
    const j = JSON.parse(fs.readFileSync(oldPath, "utf8"));
    const wasActive = String(it.value) === ACTIVE_SESSION_FILE;
    j.name = nm;
    const kebab = nm.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "session";
    const ts = (/^([0-9]{4}-[0-9]{2}-[0-9]{2}T[\d-]+Z)/.exec(String(it.value)) || [])[1] || "";
    const newPath = ts ? ts + "-" + kebab + ".json" : String(it.value);
    fs.writeFileSync(path.join(sessionsDir(), newPath), JSON.stringify(j, null, 2));
    if (newPath !== String(it.value)) { try { fs.unlinkSync(oldPath); } catch { /* nop */ } }
    if (wasActive) { ACTIVE_SESSION_FILE = newPath; CURRENT_SESSION_TITLE = nm; }
  } catch (e) { addLog(cc("\u001b[31m", " rename failed: " + (e.message || e))); }
  SESSIONS_DIRTY = true;
  d.items = listSessions();
  d.sel = clamp(d.items.findIndex((x) => x.name === nm), 0, Math.max(0, d.items.length - 1));
  d.previewFile = ""; syncDialogPreview();
  addLog(cc(CRIMSON + BOLD, " renamed to \u201c" + nm + "\u201d"));
  scheduleDraw(true);
}

function panelTexts() {
  const p = activeProvider();
  const W = PANEL_W - 2;
  return [
    cc(CRIMSON + BOLD, clip(p.name, W)),
    cc(CRIMSON, clip(p.model, W)),
    cc(DIM, clip(shortPath(CWD), W)),
    cc(DIM, "-".repeat(Math.max(4, W - 1))),
    cc(CRIMSON + BOLD, UI.mode),
    cc(DIM, "t" + UI.turn + " tools" + TOOL_CALLS_TOTAL + " " + fmtDur(Date.now() - SESSION_START)),
    cc(DIM, "-".repeat(Math.max(4, W - 1))),
    cc(DIM, "sessions " + cachedCount("sessions", sessionCount)),
    cc(DIM, "skills   " + cachedCount("skills", skillsCount)),
    cc(DIM, "mcps     " + cachedCount("mcps", mcpCount)),
    cc(DIM, "-".repeat(Math.max(4, W - 1))),
    cc(DIM, "esc int"),
    cc(DIM, "tab b/p" ),
    cc(DIM, "/ cmds" ),
  ];
}
const _COUNT_CACHE = { sessions: { v: 0, t: 0 }, skills: { v: 0, t: 0 }, mcps: { v: 0, t: 0 } };
function cachedCount(kind, fn) {
  const c = _COUNT_CACHE[kind];
  if (Date.now() - c.t > 4000) { c.v = fn(); c.t = Date.now(); }
  return c.v;
}

function sessionsDir() { return path.join(CFG_DIR, "sessions"); }
function sessionCount() {
  try { return fs.readdirSync(sessionsDir()).filter((f) => f.endsWith(".json")).length; } catch { return 0; }
}
const SKILL_DIRS = [
  path.join(os.homedir(), ".config", "opencode", "skills"),
  path.join(os.homedir(), ".claude", "skills"),
  path.join(os.homedir(), ".agents", "skills"),
];
function listSkillDirs() {
  const out = [];
  for (const d of SKILL_DIRS) {
    let names = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) try { if (fs.statSync(path.join(d, n)).isDirectory()) out.push({ name: n, dir: d }); } catch { /* nop */ }
  }
  return out;
}
function skillsCount() { return listSkillDirs().length; }
function mcpCount() { return CFG.mcps ? Object.keys(CFG.mcps).length : 0; }

function sessionNameText() {
  for (const m of HISTORY) {
    if (m.role !== "user") continue;
    const c = String(m.content || "").trim();
    if (!c || c.startsWith("[skill")) continue;
    const words = c.replace(/\s+/g, " ").split(" ").filter(Boolean).slice(0, 6).join(" ").slice(0, 34).trim();
    return words || "chat";
  }
  return "chat";
}

let ACTIVE_SESSION_FILE = "";
let CURRENT_SESSION_TITLE = "";   // LLM/derived summary name for the active session
let SESSION_FILE_TS = null;       // stable id per session so saves reuse one file
function sessionFileTS() {
  if (!SESSION_FILE_TS) SESSION_FILE_TS = new Date().toISOString().replace(/[:.]/g, "-");
  return SESSION_FILE_TS;
}
function saveSession() {
  try {
    if (!HISTORY.length) return null;
    fs.mkdirSync(sessionsDir(), { recursive: true });
    const when = new Date().toISOString();
    const disp = CURRENT_SESSION_TITLE || sessionNameText();
    const kebab = disp.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "chat";
    const file = sessionFileTS() + "-" + kebab + ".json";
    const full = path.join(sessionsDir(), file);
    fs.writeFileSync(full, JSON.stringify({
      when,
      name: disp,
      provider: activeProvider().name,
      model: activeProvider().model,
      cwd: CWD,
      history: HISTORY,
    }, null, 2));
    if (ACTIVE_SESSION_FILE && ACTIVE_SESSION_FILE !== file) {
      const old = path.join(sessionsDir(), ACTIVE_SESSION_FILE);
      try { fs.unlinkSync(old); } catch { /* nop */ }
    }
    ACTIVE_SESSION_FILE = file;
    SESSIONS_DIRTY = true;
    return file;
  } catch { return null; }
}

async function genSessionTitle() {
  if (CURRENT_SESSION_TITLE) return;
  try {
    const firstUser = (HISTORY.find((m) => m.role === "user" && !String(m.content || "").startsWith("[skill")) || {}).content || "";
    const asst = (HISTORY.filter((m) => m.role === "assistant").slice(-1)[0] || {}).content || "";
    if (!firstUser.trim()) return;
    const p = activeProvider();
    const res = await fetch(p.baseURL.replace(/\/$/, "") + "/chat/completions", {
      method: "POST", signal: AbortSignal.timeout(Math.min(MODEL_TIMEOUT, 45000)),
      headers: { "Content-Type": "application/json", ...(p.apiKey ? { Authorization: "Bearer " + p.apiKey } : {}) },
      body: JSON.stringify({
        model: p.model,
        messages: [
          { role: "system", content: "You label chats. Reply with ONLY a 2-4 word summary title of what the user is working on, Title Case, no punctuation, no quotes." },
          { role: "user", content: "User: " + String(firstUser).slice(0, 300) + "\n\nAssistant: " + String(asst).slice(0, 300) },
        ],
        stream: false, temperature: 0, max_tokens: 200,
      }),
    });
    const j = await res.json();
    const msg = ((j.choices || [])[0] || {}).message || {};
    let t = String(msg.content || "");
    if (!t.trim()) {
      // some reasoning models spend tokens on <think>/reasoning: take the final sentence
      t = String(msg.reasoning || j.reasoning || "").split("\n").filter((s) => s.trim()).slice(-1)[0] || "";
    }
    t = t.replace(/```[\s\S]*?```/g, "").replace(/<think>[\s\S]*?>/g, "").replace(/^[\s\-*\d.]+/, "").replace(/["'`\u201c\u201d]/g, "").split("\n").filter((s) => s.trim()).slice(-1)[0] || "";
    t = t.split(/[.!?:;,]+/)[0].replace(/^[\s\-*\d.]+/, "").trim();
    CURRENT_SESSION_TITLE = clip(t, 40) || "";
    if (!CURRENT_SESSION_TITLE) return;
    saveSession();
    addLog(cc(CRIMSON + BOLD, " session named \u201c" + CURRENT_SESSION_TITLE + "\u201d"));
    scheduleDraw(true);
  } catch { /* naming is best-effort */ }
}

function loadSessionFile(file) {
  if (UI.busy) {
    PENDING = String(file);
    PENDING_NAME = (listSessions().find((x) => x.value === PENDING) || {}).name || PENDING;
    addLog(cc(CRIMSON + BOLD, " \u23f3 queued \u2014 switching to the session as soon as this reply finishes (esc interrupts now)"));
    scheduleDraw(true);
    return;
  }
  try {
    let raw0 = fs.readFileSync(path.join(sessionsDir(), String(file)), "utf8");
    if (raw0.charCodeAt(0) === 0xFEFF) raw0 = raw0.slice(1);   // some editors write a BOM; be tolerant
    const j = JSON.parse(raw0);
    const wasActive = String(file) === ACTIVE_SESSION_FILE;
    HISTORY = Array.isArray(j.history) ? j.history : [];
    ACTIVE_SESSION_FILE = String(file);
    CURRENT_SESSION_TITLE = j.name || "";
    const mt = /^([0-9]{4}-[0-9]{2}-[0-9]{2}T[\d-]+Z)/.exec(String(file));
    SESSION_FILE_TS = mt ? mt[1] : null;
    UI.turn = Math.floor(HISTORY.length / 2);
    UI.scroll = 0;
    const nm = j.name || "unnamed";
    addLog(cc(DIM, "  \u2500\u2500  switched to \u201c" + nm + "\u201d \u00b7 " + HISTORY.length + " messages \u00b7 turn " + UI.turn + "  \u2500\u2500"));
    if (j.cwd && String(j.cwd) !== CWD && fs.existsSync(j.cwd)) {
      try { process.chdir(j.cwd); CWD = j.cwd; addLog(cc(DIM, " \u00b7 moved back to " + shortPath(j.cwd))); } catch { /* nop */ }
    }
    // replay the WHOLE conversation so scrolling can reach the top (previously only the last 12 messages)
    const W = Math.max(40, UI.cols - PANEL_W - 10);
    let shown = 0;
    for (const m of HISTORY) {
      let c = String(m.content || "");
      if (!c.trim() || c.startsWith("[skill")) continue;
      c = c.replace(/[ \t]+/g, " ").trim();
      if (c.length > 2400) c = c.slice(0, 2400) + " \u2026";
      if (m.role === "user") addLog(cc(CRIMSON + BOLD, " \u276f " + c));
      else addLog("  " + c);
      shown++;
    }
    if (HISTORY.length > shown) addLog(cc(DIM, "  (" + (HISTORY.length - shown) + " system/skill messages not shown)"));
    if (wasActive) addLog(cc(DIM, " (that was already the active session \u2014 nothing else changed)"));
  } catch (e) {
    addLog(cc("\u001b[31m", " load failed: " + (e.message || e)));
  }
  scheduleDraw(true);
}


function drawFrame() {
  if (!process.stdout.isTTY) return;
  const cols = UI.cols, rows = UI.rows;
  if (rows < 16 || cols < 56) {
    process.stdout.write(ESC + "[?25l" + ESC + "[2J" + ESC + "[H" + ESC + "[1;1H" + padRow(" terminal too small - need >=56x16 (have " + cols + "x" + rows + ")", cols));
    return;
  }
  loadCfg();
  const BODY = rows - 6;
  const barX = cols - PANEL_W;
  const LW = barX - 1;
  const p0 = activeProvider();
  // -------- brand banner as scrollback head ( opencode style: scrolls up as chat grows )
  const COMBO = (LW >= HYDRA_MARK[0].length + 2)
    ? HYDRA_MARK.concat(WORDMARK)
    : WORDMARK;
  const scroll = [];
  for (const l of COMBO) scroll.push(cc(CRIMSON + BOLD, centerText(l, LW)));
  // -------- compose chat log flat lines into the same scrollback
  for (const e of UI.log) {
    if (!e.cache || e.cacheW !== LW) { e.cache = wrapText(e.text, LW - 1); e.cacheW = LW; }
    for (const l of e.cache) scroll.push(l);
  }
  const maxScroll = Math.max(0, scroll.length - BODY);
  UI.scroll = clamp(UI.scroll, 0, maxScroll);
  let vStart = Math.max(0, scroll.length - BODY - UI.scroll);
  if (UI.scroll > 0) {
    if (UI.anchorScroll === UI.scroll && UI.anchorStart != null) {
      // scroll unchanged -> new content arrived below: freeze the viewport on the same content
      vStart = clamp(Math.min(UI.anchorStart, maxScroll), 0, maxScroll);
    }
    UI.anchorStart = vStart;
    UI.anchorScroll = UI.scroll;
  } else { UI.anchorStart = null; UI.anchorScroll = null; }
  // -------- compose panel flat lines
  const pflat = [];
  for (const t of panelTexts()) { for (const l of wrapText(t, PANEL_W - 2)) pflat.push(l); }
  const out = [ESC + "[?25l"];
  if (fullDraw) { out.push(ESC + "[2J"); fullDraw = false; }
  SCR = new Array(rows).fill("");
  // -------- header
  const head = cc(CRIMSONBG, " HYDRA ") + cc(CRIMSON + BOLD, " v" + VERSION + " ")
    + cc(DIM, "\u2502 provider ") + cc(CRIMSON, p0.name)
    + cc(DIM, "\u2502 model ") + cc(CRIMSON, clip(p0.model, Math.max(20, LW - 30)))
    + cc(DIM, "\u2502 mode ") + cc(CRIMSON + BOLD, UI.mode);
  out.push(ESC + "[1;1H" + padRow(head, cols - 1));
  SCR[0] = plainRow(head, cols - 1);
  // -------- body: scrollback window ( brand head scrolls up with chat )
  for (let i = 0; i < BODY; i++) {
    const t = scroll[vStart + i] ?? "";
    const pl = pflat[i] || "";
    out.push(ESC + "[" + (2 + i) + ";1H"
      + padRow(" " + t + " ", LW)
      + cc(DIM, "\u2502")
      + padRow(pl, PANEL_W));
    SCR[2 + i] = " " + plainRow(t, LW - 1) + " \u2502" + plainRow(pl, PANEL_W);
  }
  // -------- popup overlay ( rows R-11 .. R-5, drawn over the body )
  const popTop = rows - 11;
  if (UI.popupOpen && UI.popupItems.length) {
    const items = UI.popupItems;
    const startSel = clamp(UI.popupSel - 3, 0, Math.max(0, items.length - 4));
    out.push(ESC + "[" + popTop + ";1H" + padRow(cc(DIM, " \u250c\u2500\u2500 " + UI.popupTitle + " "), cols - 1));
    const visible = items.slice(startSel, startSel + 5);
    UI.popupGeo = { top: popTop, startSel, n: visible.length };   // for mouse click
    const labW = Math.max(28, Math.min(66, ...items.map((x) => stripAnsi(x.label).length)));
    let k = 0;
    for (; k < visible.length; k++) {
      const it = visible[k];
      const sel = it === items[UI.popupSel];
      const mark = sel ? cc(CRIMSON + BOLD, " \u276f ") : "   ";
      out.push(ESC + "[" + (popTop + 1 + k) + ";1H" + padRow(mark + padRow(sel ? cc(CRIMSON + BOLD, it.label) : it.label, labW) + " " + cc(DIM, it.desc || ""), cols - 1));
    }
    for (; k < POPUP_RESERVE - 1; k++) out.push(ESC + "[" + (popTop + 1 + k) + ";1H" + padRow("", cols - 1));
  }
  // -------- sessions dialog ( opencode-style: list left, live preview right )
  if (UI.dialog && UI.dialog.kind === "sessions" && SESSIONS_DIRTY) {
    // dialog list was a snapshot at open time; session files changed underneath -> rebuild, keep selection
    SESSIONS_DIRTY = false;
    const pd = UI.dialog;
    const prev = (pd.items[pd.sel] || {}).value;
    pd.items = listSessions();
    pd.sel = clamp(pd.items.findIndex((x) => x.value === prev), 0, Math.max(0, pd.items.length - 1));
    pd.previewFile = "";
    syncDialogPreview();
  }
  if (UI.dialog && UI.dialog.kind === "sessions") {
    syncDialogPreview();
    const d = UI.dialog;
    const dtop = 2, dbot = rows - 6;
    const dh = dbot - dtop + 1;
    const dw = cols - 1;
    const prevW = Math.max(16, Math.floor(dw * 0.40));
    const listW = dw - prevW;
    const items = d.items;
    const visibleCount = Math.max(1, dh - 4);
    const startSel = clamp(d.sel - Math.floor(visibleCount / 2) + (d.sel < Math.floor(visibleCount / 2) ? 1 : 0), 0, Math.max(0, items.length - 1));
    d.geo = { dtop, dbot, listW, prevW, startSel, visibleCount };   // for mouse click-open
    const active = (d.mode === "rename" ? cc(CRIMSON + BOLD, " \u2502 new title: " + d.buf + "\u258c") : UI.busy ? cc(CRIMSON + BOLD, " \u00b7 a turn is running") : "");
    const dT = d.title || "sessions";
    out.push(ESC + "[" + dtop + ";1H" + padRow(cc(CRIMSON + BOLD, " \u250c\u2500\u2500 " + dT + " \u2502 \u2191\u2193 browse \u00b7 enter continue \u00b7 r rename \u00b7 d delete \u00b7 u undo \u00b7 1-9 jump \u00b7 esc close") + active, dw));
    for (let r = dtop; r <= dbot; r++) SCR[r] = plainRow("", dw);
    SCR[dtop] = plainRow(cc(CRIMSON + BOLD, " \u250c\u2500\u2500 " + dT + " \u2502 \u2191\u2193 browse \u00b7 enter continue \u00b7 r rename \u00b7 d delete \u00b7 u undo \u00b7 1-9 jump \u00b7 esc close"), dw);
    let k = 0;
    for (; k < visibleCount; k++) {
      const it = items[startSel + k];
      const r = dtop + 1 + k;
      let line;
      if (!it) {
        if (k === 0 && !items.length) line = cc(DIM, "  (no sessions yet \u00b7 a session is saved after each turn)");
        else if (k === 0 && startSel > 0) line = cc(DIM, "  (end of list)");
        else line = "";
      } else {
        const idx = startSel + k;
        const sel = idx === d.sel;
        const nameTxt = clip(String(it.name || "chat"), Math.max(12, listW - 18));
        const meta = cc(DIM, relTime(it.whenISO) + (it.turns ? " \u00b7 " + it.turns + "m" : ""));
        const gap = Math.max(1, listW - 6 - stripAnsi(nameTxt).length - stripAnsi(meta).length);
        line = (idx < 9 ? cc(DIM, " " + (idx + 1) + " ") : "   ")
          + (sel ? cc(CRIMSON + BOLD, "\u276f " + nameTxt) + " ".repeat(gap) + meta
            : cc(DIM, "\u00b7 ") + cc(it.value === ACTIVE_SESSION_FILE ? CRIMSON : DIM, nameTxt) + " ".repeat(gap) + meta);
      }
      out.push(ESC + "[" + r + ";2H" + padRow(line, listW - 1));
      out.push(ESC + "[" + r + ";" + (listW + 1) + "H" + cc(DIM, "\u2502"));
    }
    const frags = d.preview;
    for (let i = 0; i < dh - 3; i++) {
      const t = frags[i] ?? "";
      out.push(ESC + "[" + (dtop + 1 + i) + ";" + (listW + 3) + "H" + padRow(t + " ", prevW - 2));
    }
    for (let r = dtop + 1 + visibleCount; r <= dbot - 1; r++) {
      out.push(ESC + "[" + r + ";2H" + padRow("", listW - 1));
    }
    out.push(ESC + "[" + dbot + ";1H" + padRow(cc(DIM, " \u2514\u2500\u2500 " + (items.length ? items.length + " sessions \u00b7 " : "") + "cwd, skills and provider are kept when you switch"), dw));
  }
  // -------- composer box ( rows R-4 .. R-2 )
  const BAR = cc(CRIMSON, "\u258C");
  out.push(ESC + "[" + (rows - 4) + ";1H" + ESC + "[K" + BAR + "  " + UI.input);
  SCR[rows - 4] = "\u258c  " + UI.input;
  const modelShort = clip(p0.model, Math.max(14, LW - 34));
  const line2 = BAR + " " + cc(CRIMSON + BOLD, " " + UI.mode) + cc(DIM, " \u00b7 ") + cc(CRIMSON, modelShort) + (p0.apiKey ? "" : cc(DIM, "  (local)"));
  out.push(ESC + "[" + (rows - 3) + ";1H" + padRow(line2, LW) + cc(DIM, "~"));
  SCR[rows - 3] = plainRow(line2, LW) + "~";
  const busy = UI.busy;
  const footL = busy
    ? cc(CRIMSON + BOLD, " " + SPINNER_FRAMES[UI.spinner] + " " + UI.busyLabel) + cc(DIM, " " + fmtDur(Date.now() - UI.busyStart) + " \u00b7 esc interrupt")
    : " " + cc(DIM, CWD);
  let footR = busy ? (PENDING
    ? cc(CRIMSON + BOLD, " \u23f3 switching to \u201c" + clip(PENDING_NAME || "", 26) + "\u201d after this reply ")
    : " ") : (UI.scroll > 0
    ? cc(CRIMSON + BOLD, " \u2191 " + UI.scroll + " (pgup/pgdn ") + cc(DIM, "\u00b7 type to return ")
    : cc(DIM, " / commands \u00b7 enter send \u00b7 turn " + UI.turn + " "));
  out.push(ESC + "[" + (rows - 2) + ";1H" + padRow(footL, barX - stripAnsi(footR).length - 1) + footR);
  SCR[rows - 2] = plainRow(footL, barX - stripAnsi(footR).length - 1) + stripAnsi(footR);
  // -------- input cursor LAST so the caret (only visible cursor) sits in the box
  out.push(ESC + "[" + (rows - 1) + ";1H" + padRow("", cols - 1));
  // -------- drag-selection highlight ( drawn over everything, under the cursor )
  if (SELECTION && SCR.length) {
    const r0 = Math.min(SELECTION.a.r, SELECTION.b.r), r1 = Math.max(SELECTION.a.r, SELECTION.b.r);
    const same = SELECTION.a.r === SELECTION.b.r;
    for (let r = r0; r <= r1 && r < rows - 1; r++) {
      if (r < 0 || !(SCR[r] || "").trim()) continue;
      const line = SCR[r];
      let c0 = 0, c1 = line.length - 1;
      if (same) { c0 = Math.min(SELECTION.a.c, SELECTION.b.c); c1 = Math.max(SELECTION.a.c, SELECTION.b.c); }
      else if (r === r0) { c0 = SELECTION.a.r === r0 ? SELECTION.a.c : SELECTION.b.c; }
      else if (r === r1) { c1 = SELECTION.a.r === r1 ? SELECTION.a.c : SELECTION.b.c; }
      if (c1 < c0) continue;
      const seg = line.slice(c0, c1 + 1).replace(/\s+$/, "");
      if (!seg.trim()) continue;
      out.push(ESC + "[" + (r + 1) + ";" + (c0 + 1) + "H" + ESC + "[7m" + seg + ESC + "[27m");
    }
  }
  const curCol = 5 + stripAnsi(UI.input).length;
  out.push(ESC + "[" + (rows - 4) + ";" + clamp(curCol, 5, cols) + "H" + ESC + "[?25h");
  process.stdout.write(out.join(""));
}


// ------------------------------------------------------------
//  popups + keys + dispatch
// ------------------------------------------------------------
function openPopup(title, items) {
  UI.popupOpen = true; UI.popupTitle = title; UI.popupItems = items; UI.popupSel = 0; SELECTION = null; scheduleDraw();
}
function popupKind() {
  const t = stripAnsi(UI.popupTitle || "");
  return t.startsWith("custom models") ? "custom" : t.split(" ")[0];
}
function closePopup() { UI.popupOpen = false; UI.popupItems = []; UI.popupSel = 0; scheduleDraw(); }

function syncSlashPopup() {
  const q = UI.input;
  if (UI.popupOpen && UI.popupTitle === "slash") {
    if (q !== "/" && !(q.startsWith("/") && !q.includes(" "))) { closePopup(); return; }
  }
  if (!q.startsWith("/") || q.includes(" ")) { if (UI.popupTitle === "slash") closePopup(); return; }
  const frag = q.toLowerCase();
  const items = COMMANDS.filter((c) => c.name.startsWith(frag)).map((c) => ({ label: c.name + c.hint, desc: "  " + c.desc, value: c.name }));
  items.sort((a, b) => {
    const aex = stripAnsi(a.value) === q ? 0 : 1, bex = stripAnsi(b.value) === q ? 0 : 1;
    return aex - bex;
  });
  if (items.length) openPopup("slash", items); else closePopup();
}

async function openModelPopup() {
  closePopup();
  setUserInput("");
  startBusy("fetching models");
  try { if (!lastModels.length) await fetchModels(); }
  catch (e) { stopBusy(); addLog(cc("\u001b[31m", " model fetch failed: " + e.message)); return; }
  stopBusy();
  const p = activeProvider();
  openPopup("model \u2502 /model <n|name>", lastModels.map((m, i) => ({ label: m, desc: m === p.model ? " active" : "", value: i })));
}
async function openProviderPopup() {
  closePopup();
  loadCfg();
  const items = Object.keys(CFG.providers).map((n) => ({ label: n, desc: n === CFG.active ? " active" : "", value: n }));
  items.push({ label: "\u2795 paste api key \u00b7 one step", desc: " detects the vendor, connects", value: "pastekey" });
  items.push({ label: "\u2795 other (custom API)", desc: " name \u00b7 url \u00b7 key \u00b7 models", value: "other" });
  openPopup("provider \u2502 /provider <name>", items);
}

// ---- custom provider capture ( /provider -> other: name -> baseURL -> api key -> fetch models -> use )
let CUSTOM_CAPTURE = null;   // { step:"pastekey"|"name"|"base"|"key", name:"", base:"", mask:"" }
function startPasteKeyCapture() {
  closePopup();
  CUSTOM_CAPTURE = { step: "pastekey", name: "", base: "", mask: "" };
  setUserInput("");
  addLog(cc(CRIMSON + BOLD, " \u2749 paste your api key (input hidden) \u2014 return = connect \u00b7 esc cancels"));
  scheduleDraw(true);
}
function startCustomProvider() {
  closePopup();
  CUSTOM_CAPTURE = { step: "name", name: "", base: "", mask: "" };
  setUserInput("");
  addLog(cc(CRIMSON + BOLD, " custom provider \u2014 type a short name (letters/numbers/_) \u00b7 esc cancels"));
  scheduleDraw(true);
}
function cancelCustomProvider() {
  if (!CUSTOM_CAPTURE) return;
  CUSTOM_CAPTURE = null;
  setUserInput("");
  addLog(cc(DIM, " custom provider setup cancelled"));
  scheduleDraw(true);
}
async function customCaptureStep() {
  const cap = CUSTOM_CAPTURE;
  if (!cap) return;
  const v = UI.input.trim();
  if (cap.step === "pastekey") {
    const key = cap.mask.trim();
    if (!key) { addLog(cc(DIM, " paste the key first \u00b7 esc cancels")); return; }
    CUSTOM_CAPTURE = null; setUserInput("");
    try { addLogLines(await keyPasteLines(key)); } catch (e) { addLog(cc("\u001b[31m", " " + (e.message || e))); }
    scheduleDraw(true);
    return;
  }
  if (cap.step === "name") {
    if (!v || !/^[A-Za-z0-9_-]{1,24}$/.test(v)) { addLog(cc(DIM, " name: short letters/numbers/underscore, e.g. openai, groq, myproxy")); setUserInput(""); return; }
    if (CFG.providers[v]) addLog(cc(DIM, " \u26a0 '" + v + "' exists \u2014 it will be replaced"));
    cap.name = v; cap.step = "base"; setUserInput("");
    addLog(cc(CRIMSON + BOLD, " 2/3 \u2014 baseURL (OpenAI-compatible, ends with /v1 for most):"));
    scheduleDraw(true); return;
  }
  if (cap.step === "base") {
    let b = v.replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(b) || !b.replace(/^https?:\/\//i, "")) { addLog(cc(DIM, " baseURL: e.g. https://api.openai.com/v1 \u00b7 http://192.168.1.5:11434/v1")); setUserInput(""); return; }
    cap.base = b; cap.step = "key"; setUserInput("");
    addLog(cc(CRIMSON + BOLD, " 3/3 \u2014 API key (" + cc(DIM, "input hidden; empty = no key, usually local servers") + "):"));
    scheduleDraw(true); return;
  }
  if (cap.step === "key") {
    const key = cap.mask.trim();
    cap.step = "none"; CUSTOM_CAPTURE = null;
    setUserInput("");
    startBusy("fetching models");
    let models = [];
    try { models = await fetchModelsFor(cap.base, key); }
    catch (e) {
      stopBusy();
      addLog(cc("\u001b[31m", " model fetch failed: " + (e.message || e)));
      addLog(cc(DIM, " check the baseURL/key \u00b7 /provider <name> saves manually \u00b7 try again: /provider"));
      scheduleDraw(true);
      return;
    }
    stopBusy();
    if (!models.length) { addLog(cc("\u001b[31m", " no models returned by " + cap.base)); scheduleDraw(true); return; }
    openPopup("custom models \u2502 " + String(cap.name), models.map((m, i) => ({ label: m, desc: " use", value: i })));
    cap._base = cap.base; cap._key = key;
    CUSTOM_PEND = { name: cap.name, base: cap.base, key };
    scheduleDraw(true);
  }
}
let CUSTOM_PEND = null;   // {name, base, key} waiting for the model pick popup

function providerPickModels() {
  const it = UI.popupItems[UI.popupSel];
  closePopup(); setUserInput("");
  if (!it || !CUSTOM_PEND) return;
  const p = CUSTOM_PEND; CUSTOM_PEND = null;
  const modelObj = lastModels[Number(it.value)];
  if (!modelObj) { addLog(cc("\u001b[31m", " pick failed \u00b7 try again: /provider")); return; }
  addLogLines(providerAddLines(p.name, p.base, p.key, modelObj));
  scheduleDraw(true);
}

function startBusy(label) { UI.busy = true; UI.busyLabel = label || "thinking"; UI.busyStart = Date.now(); UI.busyHint = false; scheduleDraw(); }
function stopBusy() { UI.busy = false; UI.busyLine = ""; UI.busyLabel = ""; scheduleDraw(); }

let ABORT = null;
let PENDING = null;   // session file queued to switch to the moment the running turn ends
let PENDING_NAME = "";
let SESSIONS_DIRTY = false;   // set when session files change on disk; the open dialog refreshes itself on next draw
let PROMPT_HIST = [];
let HIST_IDX = -1;
const spinnerTimer = setInterval(() => { if (UI.busy) { UI.spinner = (UI.spinner + 1) % SPINNER_FRAMES.length; scheduleDraw(); } }, 120);
try { spinnerTimer.unref(); } catch { /* nop */ }
const clockTimer = setInterval(() => { if (UI.busy) scheduleDraw(); }, 1000);
try { clockTimer.unref(); } catch { /* nop */ }

function truncateLine(s, n) { const p = stripAnsi(s); return p.length > n ? p.slice(0, n - 1) + "\u2026" : p; }

async function submitLine() {
  let q = UI.input.trim();
  if (CUSTOM_CAPTURE) {
    if (q) await customCaptureStep();
    return;
  }
  if (!q && UI.input.trim()) q = UI.input.trim();
    if (popupKind() === "custom") { providerPickModels(); return; }
  if (popupKind() === "model") {
    const it = UI.popupItems[UI.popupSel];
    closePopup(); setUserInput("");
    if (it) { startBusy("switching model"); try { addLogLines(await modelUseLines(String(it.value + 1))); } catch (e) { addLog(cc("\u001b[31m", " error: " + e.message)); } stopBusy(); }
    return;
  }
  if (popupKind() === "provider") {
    const it = UI.popupItems[UI.popupSel];
    closePopup(); setUserInput("");
    if (it && it.value === "pastekey") { startPasteKeyCapture(); return; }
    if (it && it.value === "other") { startCustomProvider(); return; }
    if (it) addLogLines(providerUseLines(it.value));
    return;
  }
  if (popupKind() === "skills") {
    const it = UI.popupItems[UI.popupSel];
    closePopup(); setUserInput("");
    if (it) injectSkillValue(it.value);
    return;
  }
  if (UI.popupOpen && UI.popupTitle === "slash") {
    const it = UI.popupItems[UI.popupSel];
    if (it && stripAnsi(it.value) === stripAnsi(q)) { closePopup(); } // exact command -> fall through and execute
    else if (it && stripAnsi(it.label).startsWith(q)) { setUserInput((it.value || stripAnsi(it.label)).trim() + " "); return; }
  }
  if (!q) { closePopup(); return; }
  setUserInput("");
  if (q === "/exit" || q === "/quit") { saveSession(); process.exit(0); }
  if (q === "/mode") { UI.mode = UI.mode === "Build" ? "Plan" : "Build"; addLog(cc(DIM, " mode -> " + UI.mode)); return; }
  if (q.startsWith("/model")) {
    const arg = q.replace("/model", "").trim();
    if (!arg) { await openModelPopup(); return; }
    startBusy("switching model");
    try { addLogLines(await modelUseLines(arg)); } catch (e) { addLog(cc("\u001b[31m", " error: " + e.message)); }
    stopBusy(); return;
  }
  if (q.startsWith("/provider")) {
    const parts = q.replace("/provider", "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) { await openProviderPopup(); return; }
    if (parts[0] === "use" && parts[1]) { addLogLines(providerUseLines(parts[1])); return; }
    if (parts[0] === "add") { addLogLines(providerAddLines(parts[1], parts[2], parts[3], parts[4])); return; }
    if (parts[0] === "del") { addLogLines(providerDelLines(parts[1])); return; }
    addLogLines(providerListLines()); return;
  }
  if (q === "/key") { startPasteKeyCapture(); return; }
  if (q.startsWith("/key ")) {
    const arg = q.replace("/key", "").trim();
    try { addLogLines(await keyPasteLines(arg)); } catch (e) { addLog(cc("\u001b[31m", " error: " + (e.message || e))); }
    scheduleDraw(true); return;
  }
  if (q.startsWith("/cd")) {
    const arg = q.replace("/cd", "").trim();
    try {
      if (!arg) { addLog(cc(DIM, " cwd: " + CWD)); return; }
      process.chdir(path.resolve(CWD, arg));
      CWD = process.cwd();
      scheduleDraw(true);
      addLog(cc(DIM, " cwd -> " + CWD));
    } catch (e) { addLog(cc("\u001b[31m", " " + e.message)); }
    return;
  }
  if (q === "/clear") {
    if (UI.busy) { addLog(cc(DIM, " wait for the reply to finish, or press esc to interrupt first")); return; }
    HISTORY = []; UI.log = []; UI.turn = 0; UI.scroll = 0; SELECTION = null;
    CURRENT_SESSION_TITLE = ""; ACTIVE_SESSION_FILE = ""; SESSION_FILE_TS = null;
    addLog(cc(DIM, " context cleared \u00b7 fresh session file next turn"));
    return;
  }
  if (q.startsWith("/sessions")) {
    const argm = q.replace("/sessions", "").trim();
    const lst = listSessions().filter((x) => x.value);
    if (/^\d+$/.test(argm)) {
      const idx = parseInt(argm, 10) - 1;
      const file = lst[idx] ? lst[idx].value : null;
      if (!file) { addLog(cc("\u001b[31m", " no session #" + argm + " \u00b7 /sessions lists " + lst.length)); return; }
      if (String(file) === ACTIVE_SESSION_FILE) {
        addLog(cc(DIM, " (that is already the active session \u00b7 your chat is right here)"));
        return;
      }
      loadSessionFile(file);
      return;
    }
    openSessionsDialog();
    return;
  }
  if (q === "/resume") {
    const newest = listSessions().find((x) => x.value && x.value !== ACTIVE_SESSION_FILE);
    if (!newest) {
      addLog(cc(DIM, ACTIVE_SESSION_FILE ? " (the active session is already your newest \u00b7 nothing to resume)" : " nothing to resume \u00b7 sessions save after each turn"));
      return;
    }
    loadSessionFile(newest.value);
    return;
  }
  if (q === "/new") {
    saveSession();
    HISTORY = []; UI.turn = 0; UI.scroll = 0;
    CURRENT_SESSION_TITLE = ""; ACTIVE_SESSION_FILE = ""; SESSION_FILE_TS = null;
    addLog(cc(CRIMSON + BOLD, "  + new session \u00b7 context cleared, files untouched"));
    return;
  }
  if (q === "/copylast") {
    const lu = [...HISTORY].reverse().find((m) => m.role === "assistant");
    if (!lu) { addLog(cc(DIM, " nothing to copy yet")); return; }
    try {
      const txt = String(lu.content || "").slice(0, 100000);
      const b64 = Buffer.from(txt, "utf8").toString("base64");
      const ps = spawnSync(process.env.SystemRoot ? process.env.SystemRoot + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" : "powershell.exe",
        ["-NoProfile", "-NoLogo", "-Command", "Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64 + "')))"],
        { windowsHide: true, timeout: 15000 });
      addLog(cc(DIM, ps.status ? " copy failed (exit " + ps.status + ")" : " last reply copied to clipboard (" + txt.length + " chars)"));
    } catch (e) { addLog(cc("\u001b[31m", " copy failed: " + e.message)); }
    return;
  }
  if (q === "/skills") {
    const s = listSkillDirs();
    if (!s.length) { addLog(cc(DIM, " no skills found in " + SKILL_DIRS.join(" "))); return; }
    openPopup("skills \u2502 enter injects", s.slice(0, 40).map((x, i) => ({ label: x.name, desc: " inject", value: i })));
    return;
  }
  if (q === "/mcp") {
    const m = CFG.mcps || {};
    const names = Object.keys(m);
    if (!names.length) { addLog(cc(DIM, " no mcps configured (add mcps in ~/.hydra/config.json)")); return; }
    addLogLines(names.map((n) => cc(DIM, " mcp: " + n + " " + cc(CRIMSON, JSON.stringify(m[n]).slice(0, 60)))));
    return;
  }
  if (q.startsWith("/search")) {
    const words = q.replace("/search", "").trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) { addLog(cc(DIM, " /search <words> \u00b7 find sessions whose messages OR title contain all words \u00b7 the dialog lists them")); return; }
    const hits = [];
    const all = listSessions();
    for (const s of all) {
      try {
        let rawS = fs.readFileSync(path.join(sessionsDir(), s.value), "utf8");
        if (rawS.charCodeAt(0) === 0xFEFF) rawS = rawS.slice(1);
        const j = JSON.parse(rawS);
        const hay = String(j.name || "") + " " + (j.history || []).map((m) => m.content || "").join(" ");
        const low = " " + hay.toLowerCase() + " ";
        if (words.every((w) => low.includes(" " + w) || low.includes(w))) hits.push(s);
      } catch { /* unparsable: skip */ }
    }
    if (!hits.length) { addLog(cc(DIM, '  no sessions match "' + words.join(" ") + '" \u00b7 /sessions lists all ' + all.length)); return; }
    addLog(cc(CRIMSON + BOLD, '  found ' + hits.length + ' of ' + all.length + ' sessions for "' + words.join(" ") + '" \u2014 browse below'));
    openSessionsDialog(hits, "search: " + words.join(" ").slice(0, 20));
    scheduleDraw(true);
    return;
  }
  if (q.startsWith("/fork")) {
    const argm = q.replace("/fork", "").trim();
    if (!HISTORY.length) { addLog(cc(DIM, " nothing to fork \u00b7 the active session has no turns")); return; }
    const n = argm ? parseInt(argm, 10) : UI.turn;
    if (!Number.isFinite(n) || n < 1 || n > UI.turn) { addLog(cc(DIM, " /fork <turn> \u00b7 this session is at turn " + UI.turn + " \u00b7 forks the chat up to that turn into a new session")); return; }
    const hist = HISTORY.slice(0, n * 2);
    const src = CURRENT_SESSION_TITLE || "session";
    const name = "fork-of-" + clip(String(src).replace(/fork-of-/g, ""), 30);
    const kebabN = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "fork";
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const file = ts + "-" + kebabN + ".json";
    try {
      fs.writeFileSync(path.join(sessionsDir(), file), JSON.stringify({
        when: new Date().toISOString(), name, provider: activeProvider().name, model: activeProvider().model, cwd: CWD, history: hist,
      }, null, 2));
      SESSIONS_DIRTY = true;
      loadSessionFile(file);
    } catch (e) { addLog(cc("\u001b[31m", " fork failed: " + (e.message || e))); }
    return;
  }
  if (q.startsWith("/theme")) {
    const argm = q.replace("/theme", "").trim().toLowerCase();
    if (!argm) {
      openPopup("theme \u2502 enter applies", Object.keys(THEMES).map((n) => ({ label: n, desc: n === activeTheme() ? " active" : "", value: n })));
      return;
    }
    if (applyTheme(argm)) { addLog(cc(CRIMSON + BOLD, "  palette -> " + argm + " \u00b7 saved, applies instantly")); scheduleDraw(true); }
    else addLog(cc("\u001b[31m", "  no palette '" + argm + "' \u00b7 options: " + Object.keys(THEMES).join(" ")));
    return;
  }
  if (q === "/help") { addLogLines(helpLines()); return; }
  if (q.startsWith("/export")) {
    if (!HISTORY.length) { addLog(cc(DIM, " nothing to export yet \u00b7 the active session has no turns")); return; }
    const argm = q.replace("/export", "").trim();
    const stem = argm
      ? (path.isAbsolute(argm) ? argm : path.join(CWD, argm.replace(/[\\/:*?"<>|]/g, "-").slice(0, 60)))
      : path.join(CWD, "hydra-export-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
    const dest = /\.md$/i.test(stem) ? stem : stem + ".md";
    try {
      const parts = ["# " + (CURRENT_SESSION_TITLE || "hydra session"), ""];
      parts.push("> provider: " + activeProvider().name + "  \u00b7  model: " + activeProvider().model + "  \u00b7  cwd: " + CWD + "  \u00b7  messages: " + HISTORY.length);
      for (const m of HISTORY) {
        const c = String(m.content || "");
        if (!c.trim() || c.startsWith("[skill")) continue;
        parts.push((m.role === "user" ? "## \u276f user" : "## hydra") + "\n\n" + c.trim());
      }
      fs.writeFileSync(dest, parts.join("\n\n") + "\n");
      addLog(cc(CRIMSON + BOLD, " exported " + HISTORY.length + " messages \u2192 " + shortPath(dest)));
    } catch (e) { addLog(cc("\u001b[31m", " export failed: " + (e.message || e))); }
    return;
  }
  if (q.startsWith("/rename")) {
    const nm = q.replace("/rename", "").trim().slice(0, 48);
    if (!nm) { addLog(cc(DIM, " /rename <title> \u00b7 renames the active session (r inside /sessions renames any)")); return; }
    if (!ACTIVE_SESSION_FILE) { addLog(cc(DIM, " no session file yet \u00b7 a session is saved after the first turn")); return; }
    try {
      const oldPath = path.join(sessionsDir(), String(ACTIVE_SESSION_FILE));
      const j = JSON.parse(fs.readFileSync(oldPath, "utf8"));
      j.name = nm;
      const kebab = nm.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "session";
      const ts = (/^([0-9]{4}-[0-9]{2}-[0-9]{2}T[\d-]+Z)/.exec(String(ACTIVE_SESSION_FILE)) || [])[1] || "";
      const newPath = ts ? ts + "-" + kebab + ".json" : String(ACTIVE_SESSION_FILE);
      fs.writeFileSync(path.join(sessionsDir(), newPath), JSON.stringify(j, null, 2));
      if (newPath !== String(ACTIVE_SESSION_FILE)) { try { fs.unlinkSync(oldPath); } catch { /* nop */ } }
      ACTIVE_SESSION_FILE = newPath; CURRENT_SESSION_TITLE = nm;
      SESSIONS_DIRTY = true;
      addLog(cc(CRIMSON + BOLD, " renamed to \u201c" + nm + "\u201d"));
    } catch (e) { addLog(cc("\u001b[31m", " rename failed: " + (e.message || e))); }
    return;
  }
  if (q.startsWith("!")) {
    const cmd = q.slice(1).trim();
    if (!cmd) { addLog(cc(DIM, " ! <command>  -  run a shell command, e.g. !git status")); return; }
    addLog(cc(CRIMSON + BOLD, "  ! ") + cc(DIM, clip(cmd, Math.max(30, UI.cols - PANEL_W - 6))));
    try {
      const usePS = !process.env.HYDRA_NO_PS;
      const sh = usePS ? (process.env.SystemRoot ? process.env.SystemRoot + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" : "powershell.exe") : (process.env.ComSpec || "cmd.exe");
      const args = usePS ? ["-NoProfile", "-NoLogo", "-ExecutionPolicy", "Bypass", "-Command", cmd] : ["/d", "/c", cmd];
      const r = spawnSync(sh, args,
        { cwd: CWD, timeout: 300000, maxBuffer: 1024 * 1024 * 4, encoding: "utf8", windowsHide: true });
      const outl = ((r.stdout || "") + (r.stderr ? "\n[stderr] " + r.stderr : "")).trim().split(/\r?\n/);
      for (const l of outl.slice(-40)) addLog(cc(DIM, "  " + l));
      if (r.error) addLog(cc("\u001b[31m", "  " + r.error.message));
      else if (r.status) addLog(cc("\u001b[31m", "  exit " + r.status));
    } catch (e) { addLog(cc("\u001b[31m", " " + (e.message || e))); }
    return;
  }
  PROMPT_HIST.push(q); HIST_IDX = -1;
  UI.turn++;
  addLog(cc(CRIMSON + BOLD, " \u276f ") + q);
  await runAgentTurn(q);
}

async function runAgentTurn(q) {
  const provider = activeProvider();
  const plan = UI.mode === "Plan";
  let streamed = "";
  let curLog = null;
  ABORT = new AbortController();
  startBusy(plan ? "Planning" : "Building");
  try {
    await agentLoop(q, provider, (t) => {
      streamed += t;
      const lines = wrapText(streamed, UI.cols - PANEL_W - 3).join("\n");
      if (curLog) { curLog.cache = null; curLog.text = lines; }
      else { addLog(lines); curLog = UI.log[UI.log.length - 1]; }
      scheduleDraw();
    }, (tool) => {
      addLog(cc(CRIMSON, "  > ") + cc(DIM, truncateLine(tool, Math.max(30, UI.cols - PANEL_W - 4))));
      curLog = null; streamed = "";
    }, HISTORY, ABORT.signal, plan);
    if (plan) addLog(cc(DIM, "  (plan mode - no tools were run)"));
    if (!streamed.trim() && ABORT.signal.aborted) addLog(cc(DIM, " interrupted"));
    else if (streamed.trim()) addLog(cc(DIM, "  \u23f1 " + fmtDur(Date.now() - UI.busyStart) + " \u00b7 " + stripAnsi(streamed).length + " chars \u00b7 turn done"));
  } catch (e) {
    const timedOut = e.name === "TimeoutError" || /timed out|aborted due to timeout/.test(e.message || "");
    const msg = e.name === "AbortError" ? "interrupted" : timedOut ? "model timed out after " + Math.round(MODEL_TIMEOUT / 1000) + "s \u00b7 provider \u201c" + provider.name + "\u201d not responding \u00b7 esc interrupts too \u00b7 HYDRA_MODEL_TIMEOUT tunes this" : (e.message || String(e));
    addLog(cc(e.name === "AbortError" ? DIM : timedOut ? "\u001b[33m" : "\u001b[31m", " " + msg));
  }
  stopBusy();
  ABORT = null;
  saveSession();
  genSessionTitle().catch(() => { /* best-effort */ });
  if (PENDING) {
    const f = PENDING;
    PENDING = null; PENDING_NAME = "";
    addLog(cc(CRIMSON + BOLD, " turn finished \u00b7 applying the queued session switch \u2193"));
    loadSessionFile(f);
  }
}
let running = true; void running;


// ------------------------------------------------------------
//  keys + sessions + entry
// ------------------------------------------------------------
let MOUSE_FRAG = false;
let MOUSE_BUF = "";
let CLICK_ROW = null;   // press target while using the mouse in dialogs/popups
let SELECTION = null;   // {a:{r,c}, b:{r,c}} in screen cells while dragging
let SCR = [];           // plain-text snapshot of the last frame (for drag-select copy)

function plainRow(text, width) {
  const p = stripAnsi(text);
  return p.length > width ? p.slice(0, width) : p + " ".repeat(width - p.length);
}
function selectionText(sel) {
  if (!sel) return "";
  const r0 = Math.min(sel.a.r, sel.b.r), r1 = Math.max(sel.a.r, sel.b.r);
  const lines = [];
  for (let r = r0; r <= r1; r++) {
    const line = SCR[r] || "";
    let c0 = 0, c1 = line.length - 1;
    if (sel.a.r === sel.b.r) { c0 = Math.min(sel.a.c, sel.b.c); c1 = Math.max(sel.a.c, sel.b.c); }
    else if (r === r0) { c0 = sel.a.r === r0 ? sel.a.c : sel.b.c; }
    else if (r === r1) { c1 = sel.a.r === r1 ? sel.a.c : sel.b.c; }
    lines.push(line.slice(c0, c1 + 1).replace(/\s+$/, ""));
  }
  return lines.filter((l) => l.length).join("\n");
}
function copyToClipboard(txt) {
  try {
    const b64 = Buffer.from(txt, "utf8").toString("base64");
    process.stdout.write(ESC + "]52;c;" + b64 + ESC + "\\");
    const sh = process.env.SystemRoot ? process.env.SystemRoot + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" : "powershell.exe";
    spawnSync(sh, ["-NoProfile", "-NoLogo", "-Command",
      "Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64 + "')))"],
      { windowsHide: true, timeout: 15000 });
  } catch { /* nop */ }
}
function onKey(str, key) {
  try {
    if (SPLASH) { skipSplash(); return; }
    // SGR mouse bursts arrive fragmented by readline: ESC[< + digits + M/m
    if (key && key.code === "[<") { MOUSE_FRAG = true; MOUSE_BUF = ""; return; }
    if (MOUSE_FRAG) {
      if (/^[0-9;]$/.test(str || "")) { MOUSE_BUF += str; return; }
      if (str === "M" || str === "m") {
        const ps = MOUSE_BUF.split(";").map((n) => parseInt(n, 10) || 0);
        const btn = ps[0] || 0, mx = (ps[1] || 1) - 1, my = (ps[2] || 1) - 1;
        const dlg = UI.dialog, pop = UI.popupOpen && UI.popupItems.length;
        if (btn === 64 || btn === 65) {                       // wheel
          const up = btn === 64;
          if (pop) { UI.popupSel = clamp(UI.popupSel + (up ? -1 : 1), 0, UI.popupItems.length - 1); scheduleDraw(); }
          else if (dlg) { dlg.sel = clamp(dlg.sel + (up ? -1 : 1), 0, Math.max(0, dlg.items.length - 1)); syncDialogPreview(); scheduleDraw(true); }
          else nudgeScroll(up ? 3 : -3);
        } else if (str === "M" && btn === 0) {                 // left press
          if (dlg && dlg.geo) {
            const g = dlg.geo;
            if (my > g.dtop && my <= g.dbot && mx < g.listW) {
              const k = my - (g.dtop + 1);
            if (k >= 0 && k < g.visibleCount && dlg.items[g.startSel + k]) {
              dlg.sel = g.startSel + k; CLICK_ROW = { r: my, inDlg: true }; syncDialogPreview(); scheduleDraw(true);
            }
            }
          } else if (pop && UI.popupGeo) {
            const g = UI.popupGeo;
            if (my > g.top && my <= g.top + g.n) { UI.popupSel = g.startSel + (my - g.top - 1); CLICK_ROW = { r: my, inPop: true }; scheduleDraw(); }
          } else {
            SELECTION = { a: { r: my, c: mx }, b: { r: my, c: mx } }; CLICK_ROW = null;
            fullDraw = true; scheduleDraw(true);
          }
        } else if (str === "M" && btn === 32) {                // drag
          if (CLICK_ROW && CLICK_ROW.inDlg && dlg && dlg.geo) {
            const g = dlg.geo;
            if (my > g.dtop && my <= g.dbot) {
              const k = my - (g.dtop + 1);
              if (k >= 0 && k < g.visibleCount && dlg.items[g.startSel + k] && g.startSel + k !== dlg.sel) {
                dlg.sel = g.startSel + k; syncDialogPreview(); scheduleDraw(true);
              }
            }
            CLICK_ROW = { r: my, inDlg: true };
          } else if (SELECTION) { SELECTION.b = { r: my, c: mx }; scheduleDraw(true); }
        } else if (str === "m" && btn === 0) {                 // release
          if (SELECTION) {
            const sel = SELECTION; SELECTION = null;
            const txt = selectionText(sel);
            if (txt) { copyToClipboard(txt); addLog(cc(CRIMSON + BOLD, " \u2398 copied " + txt.split("\n").length + " lines (" + txt.length + " chars) to clipboard")); }
            fullDraw = true; scheduleDraw(true);
          } else if (CLICK_ROW && CLICK_ROW.inDlg) {
            const same = CLICK_ROW.r === my;
            CLICK_ROW = null;
            if (same) dialogActivate();
          } else if (CLICK_ROW && CLICK_ROW.inPop) {
            const same = CLICK_ROW.r === my;
            CLICK_ROW = null;
            if (same) popupActivate();
          } else CLICK_ROW = null;
        }
        MOUSE_FRAG = false;
      }
      return;
    }
    if (!key) return;
    if (key.ctrl && key.name === "c") { saveSession(); process.exit(0); }
    if (key.ctrl && key.name === "p") { UI.mode = UI.mode === "Build" ? "Plan" : "Build"; addLog(cc(DIM, " mode -> " + UI.mode)); return; }
    // ---- custom provider text capture ( name -> baseURL -> hidden api key ) wins over all modal keys
    if (CUSTOM_CAPTURE) {
      const cap = CUSTOM_CAPTURE;
      if (key.name === "escape") { cancelCustomProvider(); return; }
      if (key.name === "return" || key.name === "enter") { customCaptureStep().catch((e) => { addLog(cc("\u001b[31m", " " + (e.message || e))); scheduleDraw(); }); return; }
      if (key.name === "pageup") { nudgeScroll(Math.max(3, Math.floor(UI.rows / 3))); return; }
      if (key.name === "pagedown") { nudgeScroll(-Math.max(3, Math.floor(UI.rows / 3))); return; }
      if (key.name === "up" || key.name === "down") return;   // no prompt history while capturing
      if (key.name === "backspace") {
        if (cap.step === "key" || cap.step === "pastekey") { cap.mask = cap.mask.slice(0, -1); setUserInput("\u2022".repeat(cap.mask.length)); }
        else setUserInput(UI.input.slice(0, -1));
        return;
      }
      if (str && !key.ctrl && !key.meta && str.length === 1 && stripAnsi(str)) {
        if (cap.step === "key" || cap.step === "pastekey") { cap.mask += str; setUserInput("\u2022".repeat(cap.mask.length)); }
        else setUserInput(UI.input + str);
        scheduleDraw();
        return;
      }
      return;
    }
    // ---- sessions dialog ( modal keys first: browse works even mid-turn )
    if (UI.dialog) {
      const d = UI.dialog;
      if (str !== "d" && !key.ctrl && !key.meta) d.armDelete = false;
      if (d.mode === "rename") {
        if (key.name === "escape") { d.mode = ""; d.buf = ""; scheduleDraw(true); return; }
        if (key.name === "return" || key.name === "enter") { commitRenameDialog(); return; }
        if (key.name === "backspace") { d.buf = d.buf.slice(0, -1); scheduleDraw(); return; }
        if (!key.ctrl && !key.meta && str && str.length === 1 && stripAnsi(str).length) {
          d.buf = (d.buf + str).slice(0, 48);
          scheduleDraw();
          return;
        }
        return;
      }
      if (key.name === "escape") { closeDialog(); return; }
      if (key.name === "up") { d.sel = clamp(d.sel - 1, 0, Math.max(0, d.items.length - 1)); syncDialogPreview(); scheduleDraw(true); return; }
      if (key.name === "down") { d.sel = clamp(d.sel + 1, 0, Math.max(0, d.items.length - 1)); syncDialogPreview(); scheduleDraw(true); return; }
      if (key.name === "pageup") { d.sel = clamp(d.sel - Math.max(3, Math.floor(UI.rows / 3)), 0, Math.max(0, d.items.length - 1)); syncDialogPreview(); scheduleDraw(true); return; }
      if (key.name === "pagedown") { d.sel = clamp(d.sel + Math.max(3, Math.floor(UI.rows / 3)), 0, Math.max(0, d.items.length - 1)); syncDialogPreview(); scheduleDraw(true); return; }
      if (str === "d" && !key.ctrl && !key.meta) {
        if (!d.armDelete) { d.armDelete = true; addLog(cc(CRIMSON + BOLD, " \u26a0 press d again to delete \u201c" + clip(String((d.items[d.sel] || {}).name || (d.items[d.sel] || {}).value || ""), 40) + "\u201d (anything else cancels)")); scheduleDraw(true); return; }
        d.armDelete = false;
        deleteDialogSession();
        return;
      }
      if (str === "u" && !key.ctrl && !key.meta) { undoDialogDelete(); return; }
      if (str === "r" && !key.ctrl && !key.meta) { startRenameDialog(); return; }
      if (!key.ctrl && !key.meta && /^[1-9]$/.test(str || "")) {
        const it = d.items[Number(str) - 1];
        closeDialog();
        if (it && it.value) {
          if (String(it.value) === ACTIVE_SESSION_FILE) { addLog(cc(DIM, " (that is already the active session \u00b7 your chat is right here)")); scheduleDraw(true); }
          else loadSessionFile(it.value);
        }
        return;
      }
      if (key.name === "return" || key.name === "enter") { dialogActivate(); return; }
      return; // modal: other keys are ignored while the dialog is open
    }
    if (UI.busy) {
      if (key.name === "escape") {
        if (UI.popupOpen) { closePopup(); if (UI.input.startsWith("/")) setUserInput(""); }
        else if (ABORT) { try { ABORT.abort(); } catch { /* nop */ } }
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        const cmd = UI.input.trim();
        const pk = popupKind();
        // read-only commands are allowed while a turn runs (sessions browsing must never be blocked)
        if (UI.popupOpen && pk !== "slash" && pk !== "custom" && pk !== "model" && pk !== "provider") { popupActivate(); return; }
        if ((UI.popupOpen && !cmd) || /^(\/(sessions|resume|help|mcp|mcps?|copylast|cd|export|rename|provider|model|fork|search|theme)\b)/.test(cmd)) {
          submitLine().catch((e) => { addLog(cc("\u001b[31m", " " + (e.message || e))); scheduleDraw(); });
          return;
        }
        if (!UI.busyHint) {
          UI.busyHint = true;
          const blocking = cmd.startsWith("/") ? " /" + cmd.slice(1).split(" ")[0] + " can't run while a turn is under way \u00b7 " : "";
          addLog(cc(DIM, " busy (" + UI.busyLabel + ") \u00b7 " + blocking + "esc interrupts \u00b7 try again after the reply finishes"));
          scheduleDraw(true);
        }
        return;
      }
      if (key.name === "pageup") { nudgeScroll(Math.max(3, Math.floor(UI.rows / 3))); return; }
      if (key.name === "pagedown") { nudgeScroll(-Math.max(3, Math.floor(UI.rows / 3))); return; }
      if (!key.ctrl && !key.meta && ["up", "down", "left", "right"].includes(key.name)) {
        if (!UI.busyHint) {
          UI.busyHint = true;
          addLog(cc(DIM, " busy (" + UI.busyLabel + ") \u00b7 esc interrupts \u00b7 try again after the reply finishes"));
          scheduleDraw(true);
        }
        return;
      }
      // everything else (typing, backspace...) falls through: typing works while a turn runs
    }
    if (key.name === "pageup") { nudgeScroll(Math.max(3, Math.floor(UI.rows / 3))); return; }
    if (key.name === "pagedown") { nudgeScroll(-Math.max(3, Math.floor(UI.rows / 3))); return; }
    if ((key.ctrl && key.name === "v") || (key.shift && key.name === "insert")) { pasteClipboard(); return; }
    if (key.name === "escape") {
      if (UI.popupOpen) { closePopup(); if (UI.input.startsWith("/")) setUserInput(""); }
      return;
    }
    if (key.name === "up") {
      if (UI.popupOpen) { UI.popupSel = clamp(UI.popupSel - 1, 0, UI.popupItems.length - 1); scheduleDraw(); return; }
      if (key.shift) { nudgeScroll(1); return; }
      if (PROMPT_HIST.length && !UI.input) { HIST_IDX = Math.min(HIST_IDX + 1, PROMPT_HIST.length - 1); setUserInput(PROMPT_HIST[PROMPT_HIST.length - 1 - HIST_IDX]); }
      return;
    }
    if (key.name === "down") {
      if (UI.popupOpen) { UI.popupSel = clamp(UI.popupSel + 1, 0, UI.popupItems.length - 1); scheduleDraw(); return; }
      if (key.shift) { nudgeScroll(-1); return; }
      if (HIST_IDX >= 0) { HIST_IDX = Math.max(HIST_IDX - 1, -1); setUserInput(HIST_IDX < 0 ? "" : PROMPT_HIST[PROMPT_HIST.length - 1 - HIST_IDX]); }
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      const pk = popupKind();
      if (UI.popupOpen && pk !== "slash" && pk !== "custom" && pk !== "model" && pk !== "provider") { popupActivate(); return; }
      submitLine().catch((e) => { addLog(cc("\u001b[31m", " " + (e.message || e))); scheduleDraw(); });
      return;
    }
    if (key.name === "tab") {
      if (UI.popupOpen && UI.popupItems.length) {
        const it = UI.popupItems[UI.popupSel];
        if (it && UI.popupTitle === "slash") setUserInput((it.value || stripAnsi(it.label)).trim() + " ");
      } else {
        UI.mode = UI.mode === "Build" ? "Plan" : "Build";
        scheduleDraw(true);
      }
      return;
    }
    if (key.name === "backspace") { setUserInput(UI.input.slice(0, -1)); return; }
    if (str && !key.alt && !key.ctrl && key.name !== "return" && key.name !== "enter" && key.name !== "tab" && key.name !== "up" && key.name !== "down" && key.name !== "escape" && key.name !== "backspace") {
      setUserInput(UI.input + str);
    }
  } catch (e) { crashLog(e); }
}

let _splashTimer = null;
let _splashDone = null;
function skipSplash() {
  if (SPLASH && _splashDone) {
    const d = _splashDone; _splashDone = null;
    try { clearTimeout(_splashTimer); } catch { /* nop */ }
    SPLASH = false; d();
  }
}
function showSplash(done) {
  const rows = UI.rows, cols = UI.cols;
  const SW = HYDRA_MARK.concat([" "], WORDMARK);
  const needR = SW.length + 2, needC = HYDRA_MARK[0].length + 4;
  _splashDone = done;
  _splashTimer = setTimeout(() => { _splashDone = null; SPLASH = false; done(); }, 1500);
  if (!rows || !cols || rows < needR || cols < needC) { return; }
  let art = "";
  art += ESC + "[?25l" + ESC + "[2J" + ESC + "[H";
  const top = Math.max(1, Math.floor((rows - SW.length) / 2) + 1);
  for (let i = 0; i < SW.length; i++) {
    const l = SW[i];
    art += ESC + "[" + (top + i) + ";1H" + (l.trim() ? cc(CRIMSON + BOLD, centerStrip(l, cols)) : "");
  }
  art += ESC + "[" + (Math.min(rows, top + SW.length + 1)) + ";1H" + cc(DIM, centerStrip("h y d r a  \u00b7  v" + VERSION, cols));
  process.stdout.write(art);
}
function centerStrip(text, width) {
  const pad = Math.max(0, Math.floor((width - stripAnsi(text).length) / 2));
  return " ".repeat(pad) + text;
}

function splashThenBoot() {
  showSplash(() => { SPLASH = false; bootLog(); fullDraw = true; scheduleDraw(true); });
}

function tuiSession() {
  dbgMark("tuiSession");
  loadCfg();
  activeProvider();
  enterTUI();
  splashThenBoot();
  process.on("exit", () => { try { saveSession(); process.stdout.write(ESC + "[?25h" + ESC + "[?1000l" + ESC + "[?1006l" + ESC + "[?1049l"); } catch { /* nop */ } });
  process.stdin.on("keypress", onKey);
  process.stdin.on("error", () => { /* nop */ });
  process.on("SIGINT", () => process.exit(0));
  fullDraw = true;
  scheduleDraw(true);
}

function plainSession() {
  dbgMark("plainSession");
  loadCfg();
  const p = activeProvider();
  console.log("HYDRA v" + VERSION + " | provider " + p.name + " | model " + p.model + " | plain mode (no tty)");
  console.log("/ for commands | /exit quit");
  if (RESTORED) {
    console.log("continued last session | " + RESTORED + " messages restored");
    const lu = [...HISTORY].reverse().find((m) => m.role === "user" && !String(m.content || "").startsWith("[skill"));
    if (lu) console.log("last topic: " + stripAnsi(String(lu.content).split("\n")[0]).slice(0, 70));
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: cc(CRIMSON + BOLD, "\u276f ") });
  rl.prompt();
  rl.on("line", async (line) => {
    const q = line.trim();
    if (!q) { rl.prompt(); return; }
    try {
      if (q === "/exit" || q === "/quit") { rl.close(); process.exit(0); }
      if (q === "/help") { helpLines().forEach((l) => console.log(stripAnsi(l))); }
      else if (q === "/provider") { providerListLines().forEach((l) => console.log(stripAnsi(l))); }
      else if (q.startsWith("/provider ")) {
        const parts = q.replace("/provider", "").trim().split(/\s+/);
        if (parts[0] === "use" && parts[1]) providerUseLines(parts[1]).forEach((l) => console.log(stripAnsi(l)));
        else if (parts[0] === "add") providerAddLines(parts[1], parts[2], parts[3], parts[4]).forEach((l) => console.log(stripAnsi(l)));
        else if (parts[0] === "del") providerDelLines(parts[1]).forEach((l) => console.log(stripAnsi(l)));
        else providerListLines().forEach((l) => console.log(stripAnsi(l)));
      } else if (q === "/key" || q.startsWith("/key ")) {
        (await keyPasteLines(q.replace("/key", "").trim())).forEach((l) => console.log(stripAnsi(l)));
      } else if (q === "/model") { (await modelListLines()).forEach((l) => console.log(stripAnsi(l))); }
      else if (q.startsWith("/model ")) {
        if (!lastModels.length) { try { await fetchModels(); } catch (e) { console.log("fetch failed: " + e.message); } }
        (await modelUseLines(q.replace("/model", "").trim())).forEach((l) => console.log(stripAnsi(l)));
      } else if (q.startsWith("/cd")) {
        const arg = q.replace("/cd", "").trim();
        if (arg) { process.chdir(path.resolve(CWD, arg)); CWD = process.cwd(); console.log("cwd -> " + CWD); }
        else console.log("cwd: " + CWD);
      } else if (q === "/mode") { UI.mode = UI.mode === "Build" ? "Plan" : "Build"; console.log("mode -> " + UI.mode); }
      else if (q === "/clear") { HISTORY = []; console.log("context cleared"); }
      else if (q.startsWith("!")) {
        const cmd = q.slice(1).trim();
        try {
          const sh = process.env.SystemRoot ? process.env.SystemRoot + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" : "powershell.exe";
          const r = spawnSync(sh,
            ["-NoProfile", "-NoLogo", "-ExecutionPolicy", "Bypass", "-Command", cmd],
            { cwd: CWD, timeout: 300000, maxBuffer: 1024 * 1024 * 4, encoding: "utf8", windowsHide: true });
          console.log((r.stdout || "") + (r.stderr ? "[stderr] " + r.stderr : ""));
          if (r.status) console.log("exit " + r.status);
        } catch (e) { console.log("error: " + (e.message || e)); }
      }
      else {
        await agentLoop(q, activeProvider(), (t) => { process.stdout.write(t); },
          (tool) => { process.stdout.write("\n  > " + tool + "\n"); }, HISTORY, undefined, UI.mode === "Plan");
        console.log("");
      }
    } catch (e) { console.log("\u001b[31merror: " + (e.message || e) + "\u001b[0m"); }
    rl.prompt();
  }).on("close", () => { saveSession(); process.exit(0); });
}

function usage() {
  console.log("");
  console.log("  hydra-cli v" + VERSION);
  console.log("  hydra-cli                full TUI session");
  console.log('  hydra-cli "<prompt>"     run one task now');
  console.log("  hydra-cli --help         this text");
  console.log("  hydra-cli --version      version");
  console.log("  commands: /model /provider /mode /cd /clear /help /exit");
  console.log("");
}

let BOOTED = false;
function bootLog() {
  if (BOOTED) return;
  BOOTED = true;
  if (RESTORED) addLog(cc(DIM, centerText("continued last session \u00b7 " + RESTORED + " messages restored", UI.cols - 2)));
}


async function main() {
  process.on("unhandledRejection", (e) => { crashLog(e); console.error("unhandled: " + (e && (e.message || e))); });
  process.on("uncaughtException", (e) => {
    crashLog(e);
    try { process.stdout.write(ESC + "[?25h" + ESC + "[?1049l"); } catch { /* nop */ }
    console.error("crash: " + (e && (e.stack || e.message || e)));
    process.exit(1);
  });
  loadCfg();
  const args = process.argv.slice(2);
  dbgMark("main:args=" + JSON.stringify(args));
  if (args.includes("--help") || args.includes("-h")) { usage(); return; }
  if (args.includes("--version") || args.includes("-v")) { console.log("hydra-cli v" + VERSION); return; }
  let restore = null;
  if (args.includes("--continue") || args.includes("-c")) {
    try {
      const files = fs.readdirSync(sessionsDir()).filter((f) => f.endsWith(".json")).sort().reverse();
      if (files.length) {
        let raw = fs.readFileSync(path.join(sessionsDir(), files[0]), "utf8");
        if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
        restore = JSON.parse(raw);
      }
    } catch { /* nop */ }
    if (restore && Array.isArray(restore.history)) {
      HISTORY = restore.history;
      RESTORED = HISTORY.length;
      if (restore.cwd && fs.existsSync(restore.cwd)) { try { process.chdir(restore.cwd); } catch { /* nop */ } }
    }
  }
  const prompt = args.filter((a) => a !== "--continue" && a !== "-c").join(" ").trim();
  if (process.env.HYDRA_TEST === "3") {
    tuiSession();
    const send = (s, k) => process.stdin.emit("keypress", s, k || { name: s });
    const burst = (s) => {
      process.stdin.emit("keypress", "", { code: "[<", sequence: "\x1b[<" });
      s.split("").forEach((ch) => process.stdin.emit("keypress", ch, { name: ch }));
    };
    setTimeout(() => { "hi: reply with just pong".split("").forEach((c) => send(c)); }, 2600);
    setTimeout(() => send("", { name: "return" }), 3000);       // turn A
    setTimeout(() => { "/new".split("").forEach((c) => send(c)); }, 12000);
    setTimeout(() => send("", { name: "return" }), 12400);
    setTimeout(() => { "tell me a very short joke".split("").forEach((c) => send(c)); }, 14000);
    setTimeout(() => send("", { name: "return" }), 14400);      // turn B
    setTimeout(() => { "/sessions".split("").forEach((c) => send(c)); }, 26000);
    setTimeout(() => send("", { name: "return" }), 26400);      // dialog
    setTimeout(() => burst("0;45;5M"), 30000);                  // press row 5 (session #2)
    setTimeout(() => burst("0;45;5m"), 30300);                  // release same row -> OPEN
    setTimeout(() => { "/sessions".split("").forEach((c) => send(c)); }, 36000);
    setTimeout(() => send("", { name: "return" }), 36400);      // dialog again
    setTimeout(() => burst("0;45;5M"), 40000);                  // press row 5...
    setTimeout(() => burst("0;45;7m"), 40300);                  // release row 7 -> drag = move sel only
    setTimeout(() => burst("0;45;6M"), 44000);                  // press row 6
    setTimeout(() => burst("0;45;6m"), 44300);                  // release same -> open hovered
    setTimeout(() => send("", { name: "escape" }), 48000);
    setTimeout(() => process.exit(0), 50000);
    return;
  }
  if (process.env.HYDRA_TEST === "2") {
    tuiSession();
    const send = (s, k) => process.stdin.emit("keypress", s, k || { name: s });
    setTimeout(() => { "hi: reply with just pong".split("").forEach((c) => send(c)); }, 2600);
    setTimeout(() => send("", { name: "return" }), 3000);       // turn A
    setTimeout(() => { "/new".split("").forEach((c) => send(c)); }, 12000);
    setTimeout(() => send("", { name: "return" }), 12400);
    setTimeout(() => { "tell me a very short joke".split("").forEach((c) => send(c)); }, 14000);
    setTimeout(() => send("", { name: "return" }), 14400);      // turn B
    setTimeout(() => { "/sessions".split("").forEach((c) => send(c)); }, 26000);
    setTimeout(() => send("", { name: "return" }), 26400);      // dialog opens
    setTimeout(() => send("", { name: "down" }), 28500);        // -> #2
    const burst = (s) => {
      process.stdin.emit("keypress", "", { code: "[<", sequence: "\x1b[<" });
      s.split("").forEach((ch) => process.stdin.emit("keypress", ch, { name: ch }));
    };
    setTimeout(() => burst("64;40;10M"), 30500);  // wheel up -> #1
    setTimeout(() => burst("64;40;10M"), 31500);
    setTimeout(() => burst("65;40;10M"), 32500);  // wheel down -> #2
    setTimeout(() => send("r"), 34000);           // rename mode
    setTimeout(() => {
      "Nuke Game Builder".split("").forEach((c) => send(c));
    }, 34500);
    setTimeout(() => send("", { name: "return" }), 36000);      // commits rename
    setTimeout(() => send("d"), 40000);           // arm delete
    setTimeout(() => send("d"), 40200);           // confirm -> soft-delete (trash)
    setTimeout(() => send("u"), 42000);           // undo restore
    setTimeout(() => send("", { name: "escape" }), 44000);
    setTimeout(() => { "/resume".split("").forEach((c) => send(c)); }, 46000);
    setTimeout(() => send("", { name: "return" }), 46400);      // reopen newest non-active
    setTimeout(() => process.exit(0), 50000);
    return;
  }
  if (process.env.HYDRA_TEST === "4") {
    tuiSession();
    const send = (s, k) => process.stdin.emit("keypress", s, k || { name: s });
    // turn hangs on purpose (dead provider) -> dialog opens MID-TURN -> select -> queue -> auto-apply after the timed-out turn
    setTimeout(() => { "hi: reply with just pong".split("").forEach((c) => send(c)); }, 2600);
    setTimeout(() => send("", { name: "return" }), 3000);            // turn A starts (will time out)
    setTimeout(() => { "/sessions".split("").forEach((c) => send(c)); }, 5500);   // typed MID-TURN
    setTimeout(() => send("", { name: "return" }), 5800);            // dialog opens DURING the turn
    setTimeout(() => send("", { name: "down" }), 6000);              // hover
    setTimeout(() => send("", { name: "return" }), 6200);            // queue the switch while busy
    setTimeout(() => process.exit(0), MODEL_TIMEOUT + 4500);         // after timeout -> flush -> switched divider
    return;
  }
  if (process.env.HYDRA_TEST === "5") {
    tuiSession();
    const send = (s, k) => process.stdin.emit("keypress", s, k || { name: s });
    // load a deep fake session -> FULL history renders -> page to the very top -> export it as markdown
    setTimeout(() => { "/sessions".split("").forEach((c) => send(c)); }, 2200);
    setTimeout(() => send("", { name: "return" }), 2500);
    setTimeout(() => send("1"), 3000);                            // newest fake first
    for (let i = 0; i < 24; i++) setTimeout(() => send("", { name: "pageup" }), 3800 + i * 200);
    setTimeout(() => { "/export deep-rep".split("").forEach((c) => send(c)); }, 9600);
    setTimeout(() => send("", { name: "return" }), 9900);
    setTimeout(() => process.exit(0), 12800);
    return;
  }
  if (process.env.HYDRA_TEST === "6") {
    tuiSession();
    const send = (s, k) => process.stdin.emit("keypress", s, k || { name: s });
    // /rename rewrites the active file on disk; reopening /sessions must list the new name
    setTimeout(() => { "/resume".split("").forEach((c) => send(c)); }, 2200);
    setTimeout(() => send("", { name: "return" }), 2500);
    setTimeout(() => { "/rename Snap Test".split("").forEach((c) => send(c)); }, 4400);
    setTimeout(() => send("", { name: "return" }), 4700);
    setTimeout(() => { "/sessions".split("").forEach((c) => send(c)); }, 6800);
    setTimeout(() => send("", { name: "return" }), 7100);
    setTimeout(() => process.exit(0), 10200);
    return;
  }
  if (process.env.HYDRA_TEST === "7") {
    tuiSession();
    const send = (s, k) => process.stdin.emit("keypress", s, k || { name: s });
    // '/provider' -> other -> name -> baseURL -> api key -> live /models fetch from a local mock -> pick -> saved as active
    const httpm = await import("node:http");
    let MOCK_OK = false;
    let mock;
    try {
      mock = httpm.createServer((req, res) => {
        const auth = req.headers.authorization || "";
        const body = auth === "Bearer sekrit-test-123"
          ? JSON.stringify({ data: [{ id: "mock-alpha" }, { id: "mock-beta" }] })
          : JSON.stringify({ error: { message: "bad api key" } });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(body);
      });
      await new Promise((ok) => mock.listen(7077, "127.0.0.1", ok));
      mock.unref?.();
      MOCK_OK = true;
    } catch (e) { console.error("mock server failed: " + e.message); }
    if (!MOCK_OK) return;

  loadCfg();

    CFG.providers["mock-old"] = { name: "mock-old", baseURL: "http://127.0.0.1:7077/v1", apiKey: "sekrit-test-123", model: "mock-alpha" };
    saveCfg();
    setTimeout(() => { "/provider".split("").forEach((c) => send(c)); }, 2200);
    setTimeout(() => send("", { name: "return" }), 2600);          // provider popup
    setTimeout(() => send("", { name: "down" }), 2900);            // hover past configured providers
    setTimeout(() => send("", { name: "down" }), 3000);            // hover the paste-key entry
    setTimeout(() => send("", { name: "down" }), 3100);            // hover the Other entry (last)
    setTimeout(() => send("", { name: "return" }), 3200);          // start capture: name
    "myprov".split("").forEach((c, i) => setTimeout(() => send(c), 3300 + i * 60));   // name
    setTimeout(() => send("", { name: "return" }), 4200);          // -> baseURL step
    "http://127.0.0.1:7077/v1".split("").forEach((c, i) => setTimeout(() => send(c), 4400 + i * 40)); // baseURL
    setTimeout(() => send("", { name: "return" }), 6600);          // -> api key step (hidden)
    "sekrit-test-123".split("").forEach((c, i) => setTimeout(() => send(c), 6800 + i * 40)); // key
    setTimeout(() => send("", { name: "return" }), 8700);          // fetch /models from the mock
    setTimeout(() => send("", { name: "down" }), 10600);           // mock-beta in the models popup
    setTimeout(() => send("", { name: "return" }), 10800);         // save + activate
    setTimeout(() => process.exit(0), 12800);
    return;
  }
  if (process.env.HYDRA_TEST === "10") {
    tuiSession();
    const send = (s, k) => process.stdin.emit("keypress", s, k || { name: s });
    // paste-key one-step flow: provider popup -> paste key (hidden input) -> vendor detected -> saved whatever the live fetch says
    setTimeout(() => { "/provider".split("").forEach((c) => send(c)); }, 2200);
    setTimeout(() => send("", { name: "return" }), 2600);          // provider popup
    setTimeout(() => send("", { name: "down" }), 2900);            // hover the paste-key entry (1 provider above)
    setTimeout(() => send("", { name: "return" }), 3100);          // hidden capture opens
    "oc_sk_test-key-0000-sk".split("").forEach((c, i) => setTimeout(() => send(c), 3400 + i * 40));  // the key
    setTimeout(() => send("", { name: "return" }), 6200);          // connect attempt against the real vendor base
    setTimeout(() => process.exit(0), 14500);
    return;
  }
  if (process.env.HYDRA_TEST === "8") {
    tuiSession();
    const send = (s, k) => process.stdin.emit("keypress", s, k || { name: s });
    // /theme popup -> apply matrix -> /search finds the seeded deep session -> /fork branches it
    const S8S = parseInt(process.env.S8S || "3", 10);
    let tEnd = 5200;
    if (S8S >= 1) {
      setTimeout(() => { "/theme".split("").forEach((c) => send(c)); }, 2200);
      setTimeout(() => send("", { name: "return" }), 2600);        // theme popup
      setTimeout(() => send("", { name: "down" }), 2900);          // gold
      setTimeout(() => send("", { name: "down" }), 3000);          // matrix (third)
      setTimeout(() => send("", { name: "return" }), 3100);        // apply + save
      tEnd = 5600;
    }
    if (S8S >= 2) {
      setTimeout(() => { "/resume".split("").forEach((c) => send(c)); }, 4200);
      setTimeout(() => send("", { name: "return" }), 4500);        // load the deep session (fork needs history)
      tEnd = 6200;
    }
    if (S8S >= 3) {
      setTimeout(() => { "/search deepmark".split("").forEach((c) => send(c)); }, 6400);
      setTimeout(() => send("", { name: "return" }), 6700);        // filtered dialog listing hits
      setTimeout(() => send("", { name: "escape" }), 8000);        // close
      setTimeout(() => { "/fork 30".split("").forEach((c) => send(c)); }, 9200);
      setTimeout(() => send("", { name: "return" }), 9700);        // submit /fork 30
      tEnd = 12800;
    }
    setTimeout(() => process.exit(0), tEnd);
    return;
  }
  if (process.env.HYDRA_TEST === "9") {
    tuiSession();
    const send = (s, k) => process.stdin.emit("keypress", s, k || { name: s });
    // screenshot drive: 1 = chat after a turn, 2 = sessions dialog w/ preview, 3 = models popup on top
    const shot = parseInt(process.env.HYDRA_SHOT || "2", 10);
    setTimeout(() => { "hi: reply with just pong (shot run)".split("").forEach((c) => send(c)); }, 2700);
    setTimeout(() => send("", { name: "return" }), 3000);
    if (shot >= 2) {
      setTimeout(() => { "/sessions".split("").forEach((c) => send(c)); }, 15000);
      setTimeout(() => send("", { name: "return" }), 15400);
    }
    if (shot >= 3) {
      setTimeout(() => send("", { name: "escape" }), 18200);
      setTimeout(() => { "/provider".split("").forEach((c) => send(c)); }, 18800);
      setTimeout(() => send("", { name: "return" }), 19100);
      setTimeout(() => { "/model".split("").forEach((c) => send(c)); }, 19800);
      setTimeout(() => send("", { name: "return" }), 20100);
    }
    setTimeout(() => process.exit(0), shot === 1 ? 14700 : shot === 2 ? 18400 : 24500);
    return;
  }
  if (process.env.HYDRA_TEST) {
    tuiSession();
    const send = (s, k) => process.stdin.emit("keypress", s, k || { name: s });
    setTimeout(() => { "hi: reply with just pong".split("").forEach((c) => send(c)); }, 2600);
    setTimeout(() => send("", { name: "return" }), 3000);      // turn A -> LLM titles it
    setTimeout(() => { "/new".split("").forEach((c) => send(c)); }, 20000);
    setTimeout(() => send("", { name: "return" }), 20400);      // fresh context
    setTimeout(() => { "tell me a very short joke".split("").forEach((c) => send(c)); }, 22000);
    setTimeout(() => send("", { name: "return" }), 22400);      // turn B -> titled
    setTimeout(() => { "/sessions 2".split("").forEach((c) => send(c)); }, 32000);
    setTimeout(() => { "/sessions".split("").forEach((c) => send(c)); }, 34000);
    setTimeout(() => send("", { name: "return" }), 34400);      // popup: named rows
    setTimeout(() => send("", { name: "down" }), 36500);        // hover older
    setTimeout(() => send("", { name: "return" }), 37000);      // switch (visible)
    setTimeout(() => { "/sessions".split("").forEach((c) => send(c)); }, 40000);
    setTimeout(() => send("", { name: "return" }), 40400);
    setTimeout(() => send("d"), 41500);                          // arm delete hovered
    setTimeout(() => send("d"), 41700);                          // confirm
    setTimeout(() => send("", { name: "escape" }), 43000);
    setTimeout(() => process.exit(0), 46000);
    return;
  }
  if (prompt) {
    try {
      await agentLoop(prompt, activeProvider(), (t) => { process.stdout.write(t); },
        (tool) => { process.stdout.write("\n  > " + tool + "\n"); }, HISTORY, undefined, false);
    } catch (e) { console.log("\u001b[31merror: " + (e.message || e) + "\u001b[0m"); }
    console.log("");
    return;
  }
  if (process.stdout.isTTY && process.stdin.isTTY) tuiSession();
  else plainSession();
}

main().catch((e) => {
  crashLog({ stack: "mainPromise: " + ((e && e.stack) || e) });
  try { process.stdout.write(ESC + "[?25h" + ESC + "[?1049l"); } catch { /* nop */ }
  console.error("fatal: " + (e.message || e));
  process.exit(1);
});

