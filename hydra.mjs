#!/usr/bin/env node
// ============================================================
//  HYDRA v3.1.0 - fast local coding agent - opencode-style TUI
//  zero dependencies | ESM | node >= 18
//  hermes-grade: skills (SKILL.md, /learn, /hub) + memory +
//  self-improvement loop + sandbox (y/n gating) + deep terminal
//  NOTE: never put ESC codes inside regex literals; use ANSI_RX
// ============================================================
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";

const VERSION = "3.1.0";
const ESC = String.fromCharCode(27);
let CRIMSON = ESC + "[91m";
let CRIMSONBG = ESC + "[0;48;2;220;20;60m";
let DIM = ESC + "[90m";
const BOLD = ESC + "[1m";
const RESET = ESC + "[0m";
// ---- palettes (/theme) â€” the UI reads these each frame, so switching is live
const THEMES = {
  orng:    { hi: "38;5;208", bg: "0;48;2;236;91;43", dim: "90" },   // opencode's signature orange on near-ink grays
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
function activeTheme() { return (CFG && THEMES[CFG.theme] && CFG.theme) || "orng"; }
// the work LED: one dot in the footer. While the app is actually working ( streaming a reply,
// running a tool... ) it pulses — bright core on an accent-glow backplate, lit, dimmed — so a
// live glance tells "busy for real" apart from a stuck screen; when idle it sits as a dark dot.
// the spinner tick redraws the footer every ~110ms while busy, which is what animates it.
function ledOnStyles() {
  const t = THEMES[activeTheme()] || THEMES.orng;
  const f = Math.floor(Date.now() / 230) % 3;
  return f === 0 ? ESC + "[0;" + t.bg + ";38;5;250m" + " \u25cf" + RESET
    : f === 1 ? ESC + "[1;" + t.hi + "m" + " \u25cf" + RESET
    : ESC + "[2;" + t.hi + "m" + " \u25cf" + RESET;
}
const ledOff = ESC + "[90m \u25cf" + RESET;   // idle: dark, quiet
const SPINNER_FRAMES = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];
const ANSI_RX = new RegExp(ESC + "\\[[0-9;]*[a-zA-Z]", "g");
const cc = (style, text) => (style ? style + text + RESET : text);
const stripAnsi = (s) => s.replace(ANSI_RX, "");
const clamp = (n, a, b) => (n < a ? a : n > b ? b : n);

function wrapText(text, width, overhang) {
  if (width < 8) return [String(text)];
  const ow = Math.max(0, overhang || 0);
  const out = [];
  for (const raw of String(text).split("\n")) {
    if (raw === "") { out.push(""); continue; }
    let line = "", budget = width - ow;
    for (const word of raw.split(" ")) {
      if (line === "") { line = word; }
      else if (stripAnsi(line + " " + word).length <= budget) { line += " " + word; }
      else { out.push(line); line = word; budget = width; }
      while (stripAnsi(line).length > width) {
        const hunk = ansiSplit(line, Math.max(width - 1, 1));
        out.push(hunk[0]);
        line = hunk[1];
        if (line.startsWith(" ")) line = line.slice(1);
      }
    }
    out.push(line);
  }
  return out;
}
// ansi-aware split: [preview with the first `keep` visible chars, rest]; styles never bleed or get mangled
function ansiSplit(text, keep) {
  let shown = 0, pre = "", post = "", sepd = false;
  for (let i = 0; i < text.length; ) {
    if (text.startsWith(ESC + "[", i)) {
      const m = /^\u001b\[[0-9;]*[A-Za-z]/.exec(text.slice(i));
      if (m) { if (sepd) post += m[0]; else pre += m[0]; i += m[0].length; continue; }
    }
    if (!sepd && shown >= keep) { sepd = true; post += (pre.includes(ESC) && !pre.endsWith(RESET) ? RESET : ""); }
    if (sepd) post += text[i];
    else { pre += text[i]; shown++; }
    i++;
  }
  return [pre, post];
}

// ------------------------------------------------------------
//  markdown → ANSI for the chat log: real tables drawn with box rules,
//  headings, lists, code fences and inline **bold** *italic* `code` links
// ------------------------------------------------------------
const ITAL = ESC + "[3m";
const STRIKE = ESC + "[9m";

function mdInline(s) {
  const segs = String(s).split("`");
  let out = "";
  for (let i = 0; i < segs.length; i++) {
    if (i % 2 === 1) { out += segs[i] ? cc(CRIMSON, segs[i]) : "`"; continue; }
    let seg = segs[i];
    seg = seg.replace(/\[([^\]\n]{1,160})\]\((https?:[^)\s]{1,300})\)/g, (m, label) => cc(CRIMSON, label) + cc(DIM, "\u21a6"));
    seg = seg.replace(/\*\*([^*\n]{1,400}?)\*\*/g, (m, x) => cc(BOLD, x));
    seg = seg.replace(/__([^_\n]{1,400}?)__/g, (m, x) => cc(BOLD, x));
    seg = seg.replace(/~~([^~\n]{1,300}?)~~/g, (m, x) => cc(STRIKE, x));
    seg = seg.replace(/(^|\s)\*([^*\n]{1,300}?)\*(?=$|\s|[.,!?:;)\]])/g, (m, pre, x) => pre + cc(ITAL, x));
    seg = seg.replace(/(^|\s)_([^_\n]{1,300}?)_(?=$|\s|[.,!?:;)\]])/g, (m, pre, x) => /^\s*$|^\w+$/.test(x) ? m : pre + cc(ITAL, x));
    out += seg;
  }
  return out;
}

const padVis = (s, w) => { const n = stripAnsi(s).length; return n >= w ? s : s + " ".repeat(w - n); };

function mdTable(block, W) {
  if (block.length < 2) return null;
  const parsed = [];
  for (const l of block) {
    const t = String(l).trim();
    if (/^\s*```/.test(t)) return null;
    if (!t.includes("|")) return null;
    if (/^\s*\|?[\s:|-]+\|?\s*$/.test(t) && t.includes("-")) { parsed.push(null); continue; }
    const parts = t.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
    if (parts.length < 2 || parts.length > 8) return null;
    parsed.push(parts);
  }
  if (!parsed[0]) return null;
  if (parsed[1] !== null) return null;             // need the classic header + separator shape
  const body = parsed.slice(2);
  if (body.some((r) => r === null)) return null;   // a second separator inside -> not a clean table
  const NC = parsed[0].length;
  for (const r of body) if (r.length > NC) return null;
  const all = [parsed[0], ...body];
  const colW = [];
  for (let c = 0; c < NC; c++) {
    let w = 4;
    for (const r of all) w = Math.max(w, stripAnsi(mdInline(r[c] ?? "")).length);
    colW.push(w);
  }
  const fixed = 3 + 3 * NC;   // indent + leading border + each cell's " sep " + trailing border
  let budget = Math.max(10, W - fixed);
  while (colW.reduce((a, b) => a + b, 0) > budget) {
    let mi = 0;
    for (let c = 1; c < NC; c++) if (colW[c] > colW[mi]) mi = c;
    if (colW[mi] <= 8) break;
    colW[mi]--;
  }
  if (colW.reduce((a, b) => a + b, 0) > budget) return null;   // still too wide -> leave raw
  const wrapCell = (cell, w) => {
    const ls = wrapText(mdInline(String(cell ?? "")), w).map((s) => s.replace(/\s+$/, ""));
    return ls.length ? ls : [""];
  };
  const grid = all.map((r) => {
    const arr = [];
    for (let c = 0; c < NC; c++) arr.push(wrapCell(r[c] ?? "", colW[c]));
    return arr;
  });
  const rule = (L, M, R) => cc(DIM, "  " + L + colW.map((w) => "\u2500".repeat(w + 2)).join(M) + R);
  const out = [];
  out.push(rule("\u250c", "\u252c", "\u2510"));
  grid.forEach((row, ri) => {
    const head = ri === 0;
    const subMax = Math.max(1, ...row.map((a) => a.length));
    for (let s = 0; s < subMax; s++) {
      let ln = "  " + cc(DIM, "\u2502");
      row.forEach((arr, c) => {
        const v = arr[s] ?? "";
        const cell = head && s === 0 ? cc(CRIMSON + BOLD, v) : v;
        ln += " " + padVis(cell, colW[c]) + " " + cc(DIM, "\u2502");
      });
      out.push(ln);
    }
    if (head) out.push(rule("\u251c", "\u253c", "\u2524"));
  });
  out.push(rule("\u2514", "\u2534", "\u2518"));
  return out;
}

function mdRender(text, width) {
  const W = Math.max(24, width | 0);
  const lines = String(text).split("\n");
  const out = [];
  let i = 0, fence = false;
  while (i < lines.length) {
    const line = lines[i];
    if (fence) {
      if (/^\s*```/.test(line)) { fence = false; out.push(cc(DIM, "  \u2570\u2500\u2500")); i++; continue; }
      out.push(cc(DIM, "  \u2502 ") + line);
      i++; continue;
    }
    if (/^\s*```/.test(line)) { fence = true; out.push(cc(DIM, "  \u250c\u2500\u2500 code")); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && lines[i + 1].includes("|")
      && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1])) {
      const blk = [];
      let j = i;
      while (j < lines.length && lines[j].includes("|") && lines[j].trim() !== "" && !/^\s*```/.test(lines[j])) { blk.push(lines[j]); j++; }
      const rendered = mdTable(blk, W);
      if (rendered) {
        if (out.length && out[out.length - 1].trim() !== "") out.push("");
        out.push(...rendered);
        out.push("");
        i = j; continue;
      }
    }
    const hm = /^\s*(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (hm) { out.push(cc(hm[1].length <= 2 ? CRIMSON + BOLD : CRIMSON, mdInline(hm[2]))); i++; continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push(cc(DIM, "\u2500".repeat(Math.min(W, 48)))); i++; continue; }
    const bm = /^(\s*)[-*]\s+(.*)$/.exec(line);
    if (bm) { out.push(cc(CRIMSON + BOLD, bm[1] + "\u2022 ") + mdInline(bm[2])); i++; continue; }
    const nm = /^(\s*)(\d{1,3})[.)]\s+(.*)$/.exec(line);
    if (nm) { out.push(cc(CRIMSON + BOLD, nm[1] + nm[2] + ". ") + mdInline(nm[3])); i++; continue; }
    const qm = /^\s*>\s?(.*)$/.exec(line);
    if (qm) { out.push(cc(DIM, "\u258f ") + cc(DIM, mdInline(qm[1]))); i++; continue; }
    out.push(mdInline(line));
    i++;
  }
  return out.join("\n");
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
  applyTheme(CFG.theme || "orng", false);
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

async function runToolCall(tc, signal) {
  let args = {};
  try { args = JSON.parse(tc.function?.arguments || "{}"); } catch { args = {}; }
  const label = `${tc.function?.name || "?"} ${JSON.stringify(args).slice(0, 90)}`;
  let result = "";
  try {
    if (tc.function?.name === "bash") {
      let cmd = String(args.command || "");
      const zone = ruleZone(cmd);
      if (zone === "deny") {
        result = "BLOCKED by zone rules (deny) - the command was NOT run. /rules lists the active zones; ask the user to allow it in .agentrules.";
        addLog(cc(CRIMSON + BOLD, " \u26d4 zone deny: ") + cc(DIM, clip(cmd, 60)));
      } else if (zone === "ask") {
        const ok = await askUserConfirm(" zone ask: " + clip(cmd, 90), 120000);
        if (!ok) {
          result = "The command was NOT run - zone rules asked the user and they said no.";
          addLog(cc(CRIMSON + BOLD, " \u26d4 zone said no") + cc(DIM, " (y in .agentrules to auto-allow)"));
        }
      } else {
        if (zone === "allow") addLog(cc(DIM, " \u2705 zone allow"));
        const r = await runBash(cmd, TOOL_TIMEOUT, signal);
        if (r.failed === "denied") {
          result = "BLOCKED by hydra sandbox (mode " + SANDBOX_MODE() + ") - the command was NOT run. Use a safer approach, or tell the user they can approve it by running it with ! themselves.";
        } else {
          const code = r.status !== undefined ? r.status : r.code;
          result = ((r.out !== undefined ? r.out : r.stdout || "") + ((r.err !== undefined ? r.err : r.stderr) ? "\n[stderr] " + (r.err !== undefined ? r.err : r.stderr) : "")).trim();
          diagProbe(cmd, result, code);   // failing output becomes a diagnostic card ( /diag, /fix )
          if (code) result += `[exit ${code}]`;
        }
      }
    } else if (tc.function?.name === "skill_load") {
      const body = readSkillBody(args.name, 8000);
      result = body ? "[skill guide: " + args.name + "]\n" + body : "unknown skill: " + String(args.name || "") + " (call list via context: skill names are in the system prompt)";
    } else if (tc.function?.name === "skill_write") {
      if (CFG.skills_safe) { result = "BLOCKED - skills_safe is on. The user reviews every skill write; ask them to run /skills-safe to allow it."; }
      else {
        const slug = safeSkillName(args.name);
        if (!slug) result = "bad skill name (letters/numbers/dashes, <=40 chars)";
        else {
          const desc = String(args.description || "").replace(/[\r\n]+/g, " ").slice(0, 200);
          const body = String(args.body || "").slice(0, 20000);
          const file = skillFile(slug);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          atomicWrite(file, "---\nname: " + slug + "\ndescription: " + (desc || slug) + "\n---\n\n" + body + "\n");
          result = "skill saved: " + slug + " (lives in " + shortPath(path.dirname(file)) + " \u00b7 its description is now in every session; the body loads on demand via skill_load or when the user starts a message with the skill name)";
          addLog(cc(CRIMSON + BOLD, " \u2726 skill saved: ") + slug + cc(DIM, " \u00b7 triggers by name: " + slug + " <task>"));
        }
      }
    } else if (tc.function?.name === "memory_write") {
      const ok = memoryAppend(args.content || args.fact || "");
      result = ok ? "remembered (memory.md, stays in every session)" : "not saved (duplicate or empty)";
      if (ok) addLog(cc(CRIMSON + BOLD, " \u2726 remembered: ") + cc(DIM, String(args.content || args.fact || "").slice(0, 90)));
    } else if (tc.function?.name === "read") {
      result = fs.readFileSync(path.resolve(CWD, args.filePath), "utf8");
    } else if (tc.function?.name === "write") {
      const p = path.resolve(CWD, args.filePath);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, args.content ?? "", "utf8");
      result = "written " + p;
      const bodyLines = String(args.content ?? "").split("\n").filter((l) => l.trim()).length;
      const headLines = String(args.content ?? "").split("\n").filter(Boolean).slice(0, 2);
      addLog(cc(DIM, " write " + shortPath(p) + " \u00b7 " + bodyLines + " lines"));
      for (const l of headLines) addLog(cc(DIM, "   + " + clip(l, 78)));
      radarScan(p);   // dependency radar: who else points at this file
    } else if (tc.function?.name === "edit") {
      const p = path.resolve(CWD, args.filePath);
      const src = fs.readFileSync(p, "utf8");
      if (!src.includes(args.oldString)) throw new Error("oldString not found: " + args.oldString);
      fs.writeFileSync(p, src.replace(args.oldString, args.newString ?? ""), "utf8");
      result = "edited " + p;
      addLog(cc(DIM, " edit " + shortPath(p) + " (" + String(args.oldString || "").split("\n").length + "- \u2192 " + String(args.newString ?? "").split("\n").length + "+ lines)"));
      for (const d of String(args.oldString || "").split("\n").slice(0, 4)) addLog(cc(DIM, "   - " + clip(d, 78)));
      for (const s of String(args.newString ?? "").split("\n").slice(0, 4)) addLog(cc(CRIMSON, "   + " + clip(s, 78)));
      radarScan(p);
    } else if (tc.function?.name === "todo_write") {
      const arr = Array.isArray(args.items) ? args.items.slice(0, 12) : [];
      UI.TODOS = arr.map((x) => ({ text: String((x && x.text) || "").slice(0, 120), done: !!((x && x.done)) }));
      const open = UI.TODOS.filter((t) => !t.done).length;
      result = "todo list updated \u00b7 " + open + " open / " + UI.TODOS.length + " total";
      addLog(cc(CRIMSON + BOLD, " \u2713 todos:"));
      for (const t of UI.TODOS.slice(0, 6)) addLog(cc(t.done ? DIM : CRIMSON + BOLD, "   " + (t.done ? "\u2611" : "\u2610") + " " + clip(t.text, 78)));
      scheduleDraw(true);
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
  { type: "function", function: { name: "skill_load", description: "Load the full body of an installed skill before doing that task.", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } },
  { type: "function", function: { name: "skill_write", description: "Save a reusable workflow as a skill (SKILL.md) for future sessions. name: kebab-case slug.", parameters: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, body: { type: "string" } }, required: ["name", "description", "body"] } } },
  { type: "function", function: { name: "memory_write", description: "Persist one durable fact the user taught you (one short line).", parameters: { type: "object", properties: { content: { type: "string" } }, required: ["content"] } } },
  { type: "function", function: { name: "todo_write", description: "Set/track your visible working checklist for multi-step work (shown in the UI). Call before starting, update as steps finish.", parameters: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { text: { type: "string" }, done: { type: "boolean" } }, required: ["text"] } } }, required: ["items"] } } },
];


// ------------------------------------------------------------
//  chat: streaming completion with tool calls + abort
// ------------------------------------------------------------
// hard deadline for model calls so a dead provider server can never hang the app forever
// the killer watches STREAM IDLE, not total wall clock: while tokens keep flowing a reply can run as long as it needs.
// no-data-only aborts: a slow pause between tokens on a cold local model no longer kills the turn mid-sentence.
// tune the pause window with env HYDRA_MODEL_IDLE, ms (HYDRA_MODEL_TIMEOUT still sets it, for test rigs);
// a total cap still exists via HYDRA_MODEL_TIMEOUT for non-streaming JSON endpoints.
const MODEL_TIMEOUT = Math.max(5000, Number(process.env.HYDRA_MODEL_TIMEOUT) || 180000);
const withTimeout = (signal, ms) => AbortSignal.any([signal, AbortSignal.timeout(ms)].filter(Boolean));
// never stars the stream: re-armed on every chunk inside chatOnce (TTFB + each decode window)
// 0 = never stop: the stream claims silence-forever without aborting, esc stays the only interrupt.
// auto never-stop for the ollama/LAN family (11434, ollama, qwen) — local models stream slowly and
// think long between tokens; killing their replies beats the point. Set [provider].neverStop=true in
// config.json to opt any other provider in; envs still win for test rigs.
const MODEL_IDLE = Math.max(5000,
  Number(process.env.HYDRA_MODEL_IDLE)
  || (Number(process.env.HYDRA_MODEL_TIMEOUT) ? Math.min(Number(process.env.HYDRA_MODEL_TIMEOUT), MODEL_TIMEOUT) : 90000));
function chatIdleMs(provider) {
  if (process.env.HYDRA_MODEL_IDLE) return Math.max(5000, Number(process.env.HYDRA_MODEL_IDLE) || 90000);
  if (process.env.HYDRA_MODEL_TIMEOUT) return Math.min(Number(process.env.HYDRA_MODEL_TIMEOUT), MODEL_TIMEOUT);
  if (provider && provider.neverStop === true) return 0;
  const hay = String((provider && provider.baseURL) || "") + " " + String((provider && provider.model) || "");
  if (/11434|ollama|qwen/i.test(hay)) return 0;
  return MODEL_IDLE;
}
const TOOL_TIMEOUT = Math.max(15000, Number(process.env.HYDRA_TOOL_TIMEOUT) || 300000);

function runShellAsync(command, cwd, timeoutMs, signal) {
  return new Promise((resolve) => {
    let done = false, out = "", err = "", ch = null;
    const finish = (status, extra) => {
      if (done) return; done = true;
      try { clearTimeout(t); } catch { /* nop */ }
      try { if (signal) signal.removeEventListener("abort", killChild); } catch { /* nop */ }
      resolve({ status, stdout: out, stderr: err + (extra || "") });
    };
      const t = setTimeout(() => {
      try { ch.kill(); } catch { /* nop */ }
      finish(null, `\n[stopped after ${Math.round(timeoutMs / 1000)}s \u00b7 HYDRA_TOOL_TIMEOUT tunes this \u00b7 esc interrupts too]`);
    }, timeoutMs);
    const killChild = () => { try { ch.kill(); } catch { /* nop */ } finish(null, "\n[interrupted by esc]"); };
    if (signal) { try { signal.addEventListener("abort", killChild, { once: true }); } catch { /* nop */ } }
    try {
      const sh = process.env.SystemRoot ? process.env.SystemRoot + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" : "powershell.exe";
      ch = spawn(sh, ["-NoProfile", "-NoLogo", "-ExecutionPolicy", "Bypass", "-Command", String(command || "")],
        { cwd, windowsHide: true });
    } catch (e) { finish(null, String(e.message || e)); return; }
    ch.stdout?.on("data", (d) => { out += d; });
    ch.stderr?.on("data", (d) => { err += d; });
    ch.on("error", (e) => finish(null, String(e.message || e)));
    ch.on("close", (code, sig) => finish(code, sig && !done ? `\n[terminated ${sig}]` : ""));
  });
}


async function chatOnce(messages, provider, ondelta, signal, noTools) {
  const body = { model: provider.model, messages, stream: true, tools: noTools ? undefined : TOOLS_SCHEMA, temperature: 0.2 };
  const isOllama = /11434|ollama/i.test(provider.baseURL || "");
  if (isOllama && provider.keepAlive) body.keep_alive = provider.keepAlive;
  const headers = { "Content-Type": "application/json" };
  if (provider.apiKey) headers.Authorization = "Bearer " + provider.apiKey;
  // idle guard ( re-armed on every chunk ): while data arrives the turn can run forever,
  // as soon as the provider goes silent for MODEL_IDLE it aborts and the turn reports "model timed out"
  const ctl = new AbortController();
  let idleT = null;
  let idleErr = null;
  const IDLE_MS = chatIdleMs(provider);
  const armIdle = () => {
    if (!IDLE_MS) return;   // never-stop provider: no pause window at all, the reply stays alive until it finishes or esc
    try { if (idleT) clearTimeout(idleT); } catch { /* nop */ }
    idleT = setTimeout(() => {
      idleErr = new Error("model timed out \u00b7 " + Math.round(IDLE_MS / 1000) + "s with no stream data");
      try { ctl.abort(idleErr); } catch { /* nop */ }
    }, IDLE_MS);
  };
  const onOuter = () => { try { ctl.abort(); } catch { /* nop */ } };
  if (signal) { if (signal.aborted) onOuter(); else signal.addEventListener("abort", onOuter, { once: true }); }
  armIdle();   // arms the connect + first-token window too
  try {
    const res = await fetch(provider.baseURL.replace(/\/$/, "") + "/chat/completions", {
      method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.any([signal, ctl.signal].filter(Boolean)),
    });
    const ct0 = res.headers.get("content-type") || "";
    if (!ct0.includes("text/event-stream")) {
      const j = await res.json();   // non-streaming JSON endpoints still ride the idle guard
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
      armIdle();   // every token resets the pause window, so long thinking periods only kill if truly silent
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
  } finally {
    try { if (idleT) clearTimeout(idleT); } catch { /* nop */ }
    if (signal) { try { signal.removeEventListener("abort", onOuter); } catch { /* nop */ } }
  }
}

// agent-loop step budget: how many model/tool rounds one turn may run before it pauses for the
// user instead of silently dying mid-work ( the old fixed 32 fell off a long mission without a word ).
// env HYDRA_MAX_STEPS tunes it.
const MAX_STEPS = Math.max(1, Number(process.env.HYDRA_MAX_STEPS) || 100);
// how many of the OLDEST kept-history messages the provider actually sees: the session file and the
// in-memory history keep the TOTAL ( previously the saved history itself was hard-capped at 40
// messages and older work was silently deleted on every turn ), only the model window is trimmed.
// env HYDRA_KEEP_MSGS tunes it.
const MODEL_KEEP = Math.max(2, Number(process.env.HYDRA_KEEP_MSGS) || 120);
const SESSION_START = Date.now();
let TOOL_CALLS_TOTAL = 0;

function SYS() {
  const parts = [
    "You are HYDRA, a coding agent inside a Windows terminal UI. Version " + VERSION + ".",
    "OS: Windows, PowerShell 5.1 (no apostrophes inside single-quoted PowerShell commands).",
    "Working directory: " + CWD + ".",
    "You have tools: bash, read, write, edit, list, glob, grep, skill_load, skill_write, memory_write, todo_write.",
    "Rules: act autonomously, do not ask questions. Prefer edit over rewrite.",
    "Use relative paths against the working directory when possible.",
    "Be concise in final answers. If a tool errors, adapt once, then answer.",
    "For multi-step work (3+ steps), set a checklist with todo_write right away and update it after each step.",
  ];
  const skills = listSkillDirs().slice(0, 40);
  if (skills.length) {
    parts.push("Installed skills (procedures you can follow). Load one with skill_load BEFORE doing a matching task; the user may also start a message with the skill name and then it is already loaded:");
    let acc = 0;
    for (const s of skills) { if (acc > 4200) break; const d = s.description || "(read with skill_load)"; acc += d.length; parts.push("  - " + s.name + ": " + d); }
  }
  const mem = readMemoryLines(12);
  if (mem.length) {
    parts.push("Durable memory the user taught you (keep honoring these):");
    for (const l of mem) parts.push("  - " + l);
  }
  const lessons = readLessons(5).map((l) => { try { const j = JSON.parse(l); return j.topic + (j.outcome ? " \u2192 " + j.outcome : ""); } catch { return l.slice(0, 150); } }).filter(Boolean);
  if (lessons.length) {
    parts.push("Recent lessons from past sessions (what was tried and how it ended):");
    for (const l of lessons) parts.push("  - " + l);
  }
  parts.push("Procedural memory: when you just worked out a non-trivial multi-step workflow that is likely reusable, save it with skill_write (name: kebab-case, description: one line, body: markdown steps). When the user states a durable preference or fact, save it with memory_write (one short line). Both persist across sessions.");
  return parts.join("\n");
}

function runToolLabel(tc) {
  let args = {};
  try { args = JSON.parse(tc.function?.arguments || "{}"); } catch { /* nop */ }
  const n = tc.function?.name;
  if (n === "skill_load")
    return "skill load: " + clip(String(args.name || ""), 60);
  if (n === "skill_write")
    return "skill write: " + clip(String(args.name || ""), 60);
  if (n === "memory_write")
    return "memory write: " + clip(String(args.content || args.fact || ""), 52);
  return `${n || "?"} ${JSON.stringify(args).slice(0, 110)}`;
}

// ---- @mention attachments: "@path" tokens glue the file's contents into the message (ai-cli style)
function inlineAttach(q) {
  let out = String(q || ""), n = 0;
  const seen = [];
  for (const m of out.matchAll(/(?:^|[\s(])@([A-Za-z0-9_\-.][A-Za-z0-9_\-.\/\\~]{0,200})/g)) {
    if (n >= 4) break;
    const tok = "@" + m[1].trim();
    let p = null, kb = 0;
    try {
      p = path.resolve(CWD, tok.slice(1).replace(/^~/, os.homedir()));   // for the FS the @ is a sigil, not path text
      const st = fs.statSync(p);
      if (!st.isFile() || st.size > 262144) { p = null; continue; }
      kb = Math.max(1, Math.round(st.size / 1024));
    } catch { continue; }
    if (seen.includes(p)) continue;
    seen.push(p);
    try {
      const c = fs.readFileSync(p, "utf8").slice(0, 24000);
      out = out.split(tok).join("\n[attached file: " + shortPath(p) + "]\n" + c);
      addLog(cc(DIM, " \u2398 attached: " + shortPath(p) + " (" + kb + " KB)"));
      n++;
    } catch { /* unreadable -> skip */ }
  }
  return out;
}

async function agentLoop(question, provider, ondelta, onTool, history, signal, noTools, extraSystem) {
  const sys = SYS() + (noTools ? "\nPLAN MODE: Discuss and advise only. Do NOT call any tools this turn." : "") + (extraSystem ? "\n\n" + extraSystem : "");
  const hist = history || [];
  const b = budgetFace(hist === HISTORY ? null : hist);   // parked turns (/ctx) are skipped + a token cap trims the window; full history stays in the session file
  const messages = [
    { role: "system", content: sys },
    ...(b.dropped.trim ? [{ role: "user", content: "[context: " + b.dropped.trim + " older message" + (b.dropped.trim === 1 ? "" : "s") + " trimmed to fit the budget \u00b7 titled turns are in /time]" }] : []),
    ...b.face,
    ...(b.dropped.park ? [{ role: "user", content: "[context: " + b.dropped.park + " earlier turn" + (b.dropped.park === 1 ? "" : "s") + " parked out of context by the user \u00b7 /ctx brings them back]" }] : []),
    { role: "user", content: question },
  ];
  let finalText = "";
  let exhausted = true;
  const receipts = [];   // what this turn's tools actually did — folded into the saved reply so a fresh turn ( or resume ) keeps the receipts
  for (let step = 0; step < MAX_STEPS; step++) {
    // transient network hiccups ( LAN blips, ECONNRESET mid-stream, keep-alive/pend drops ) retry
    // per round instead of ending the turn as "turn error" — the old behaviour stopped the work
    // halfway for a failure the next second would have survived. aborts (esc) never retry, and
    // "model timed out" stays surfaced ( a silent provider is a judgement call, not a blip ).
    let out = null;
    for (let att = 0; ; att++) {
      try { out = await chatOnce(messages, provider, ondelta, signal, noTools); break; }
      catch (e) {
        if (signal?.aborted || e.name === "TimeoutError" || att >= 2) throw e;
        const hay = (e.message || "") + " " + ((e.cause && (e.cause.message || e.cause.code)) || "");
        if (!/terminated|fetch failed|econnreset|econnrefused|socket hang up|epipe|other side closed|network|underlying socket/i.test(hay)) throw e;
        addLog(cc(DIM, " stream hiccup and retry " + (att + 1) + " of 2 { " + clip(String(e.message || e), 60) + "}"));
        await new Promise((r) => setTimeout(r, 900 * (att + 1)));
      }
    }
    finalText = out.content;
    if (out.content) UI.TOKENS += Math.max(1, Math.round(String(out.content).length / 4));   // approx reply tokens this session ( footer "tok" )
    messages.push({ role: "assistant", content: out.content, ...(out.tool_calls ? { tool_calls: out.tool_calls } : {}) });
    if (!out.tool_calls || signal?.aborted) {
      // the empty-reply glitch: an oversight return with no text used to save a [user, ""] pair that
      // polluted the transcript and confused resumes — the question is kept in /regen instead
      if (history && String(finalText).trim()) {
        const fin = receipts.length ? finalText + "\n\n[work log]\n" + receipts.slice(-10).map((s) => "- " + s).join("\n") + "\n(folded so the next turn keeps the receipts; older logs live in /time)" : finalText;
        history.push({ role: "user", content: question }, { role: "assistant", content: fin });
      }
      if (receipts.length) addLog(cc(DIM, " \u234b work log folded into the reply \u00b7 " + receipts.length + " step" + (receipts.length === 1 ? "" : "s") + " recorded"));
      return finalText;
    }
    for (const tc of out.tool_calls) {
      TOOL_CALLS_TOTAL++;
      if (onTool) onTool(runToolLabel(tc));
      const callRes = await runToolCall(tc, signal);
      const rv = String(callRes.result || "");
      const rvTag = rv.length > 8000 ? rv.slice(0, 8000) + "\n\u2026(window-clipped \u00b7 rerun for more)" : rv;
      messages.push({ role: "tool", tool_call_id: tc.id, content: rvTag });
      receipts.push(clip(runToolLabel(tc), 46) + " -> " + clip(rv.replace(/\s+/g, " ").trim() || "done", 60));
      try { saveSession(); } catch { /* durability between tool steps */ }
      if (signal?.aborted) return finalText;
    }
  }
  // the step budget ran out while the model still wanted to work: say so LOUDLY even when the
  // last round streamed only tool calls (no reply text to save) — silence here is how turns "stopped
  // in between" without a trace; the receipts still fold into whatever text came out
  if (!signal?.aborted) {
    if (history && String(finalText).trim()) {
      const fin = receipts.length ? finalText + "\n\n[work log]\n" + receipts.slice(-10).map((s) => "- " + s).join("\n") + "\n(stopped mid-work \u00b7 folded so the next turn keeps the receipts)" : finalText;
      history.push({ role: "user", content: question }, { role: "assistant", content: fin });
    }
    if (receipts.length) addLog(cc(DIM, " \u234b work log folded into the reply \u00b7 " + receipts.length + " step" + (receipts.length === 1 ? "" : "s") + " recorded"));
    addLog(cc("\u001b[33m", " \u23f3 step budget reached after " + MAX_STEPS + " tool rounds \u00b7 the turn stopped mid-work \u00b7 say \"continue\" to keep going \u00b7 HYDRA_MAX_STEPS tunes this"));
    scheduleDraw(true);
  }
  return finalText;
}


// ------------------------------------------------------------
//  providers + models + commands ( plain-string API )
// ------------------------------------------------------------
let lastModels = [];

async function fetchModels(timeoutMs) {
  const p = activeProvider();
  return fetchModelsFor(p.baseURL, p.apiKey, timeoutMs);
}
async function fetchModelsFor(baseURL, apiKey, timeoutMs) {
  const headers = {};
  if (apiKey) headers.Authorization = "Bearer " + apiKey;
  const r = await fetch(String(baseURL).replace(/\/$/, "") + "/models", { headers, signal: AbortSignal.timeout(timeoutMs || 15000) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || j.error);
  lastModels = (j.data || j.models || []).map((m) => String(m.id || m.name || m).replace(/^models\//, "")).filter(Boolean).sort();
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
  CFG.active = name; lastModels = []; saveCfg();
  return [` provider -> ${cc(CRIMSON + BOLD, name)} ${cc(DIM, activeProvider().model)}`];
}
function providerAddLines(name, baseURL, apiKey, model) {
  model = String(model || "").trim().replace(/^["']+|["']+$/g, "");
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
  [/^AQ\./, { name: "gemini", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai" }],
  [/^hf_/, { name: "huggingface", baseURL: "https://router.huggingface.co/v1" }],
  [/^nvapi-/, { name: "nvidia", baseURL: "https://integrate.api.nvidia.com/v1" }],
  [/^xpl_/, { name: "explabs", baseURL: "https://api.experientiallabs.ai/v1" }],
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
  const hadBusy = UI.busy; if (!hadBusy) startBusy("connecting " + v.name);
  let models = [];
  try { models = await fetchModelsFor(v.baseURL, key); }
  catch (e) {
    if (!hadBusy) stopBusy();
    keySaveLines(v, key, "");
    return [
      cc("\u001b[31m", " couldn't verify " + v.baseURL + " (" + (e.message || e) + ") \u2014 key saved, will retry live on your first turn"),
      cc(DIM, " wrong host for this key? override: /provider add <name> <baseURL> <key> <model> \u00b7 /model to pick"),
    ];
  }
  if (!hadBusy) stopBusy();
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
  try { await fetchModels(6000); } catch { lastModels = []; }
  const lines = [` Models on ${cc(CRIMSON + BOLD, p.name)}: ${cc(DIM, p.baseURL)}`, ""];
  lastModels.forEach((m, i) => {
    const active = m === p.model;
    lines.push(` ${active ? cc(CRIMSON + BOLD, "*") : " "} ${cc(active ? CRIMSON + BOLD : DIM, "" + (i + 1) + ". " + m)}${active ? cc(CRIMSON + BOLD, "   (active)") : ""}`);
  });
  lines.push("", cc(DIM, " switch: /model <number> or /model <partial name>"));
  return lines;
}

async function modelUseLines(arg) {
  arg = String(arg || "").trim().replace(/^["']+|["']+$/g, "");
  if (!arg) return [cc(DIM, " usage: /model <number> or /model <partial name>")];
  loadCfg();
  try { await fetchModels(6000); }
  catch (e) {
    if (arg.includes("/")) {
      CFG.providers[CFG.active].model = arg; saveCfg();
      return [` model -> ${cc(CRIMSON + BOLD, arg)} ${cc(DIM, "(forced, list fetch failed)")}`];
    }
    return [cc("\u001b[31m", " error: " + e.message)];
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
  { name: "/regen", desc: "regenerate the last reply from scratch", hint: "" },
  { name: "/undo", desc: "remove the last exchange from the session", hint: "" },
  { name: "/web", desc: "fetch a page and put it into context", hint: " <url>" },
  { name: "/stats", desc: "turns, tokens, session + model info", hint: "" },
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
  { name: "/learn", desc: "distill material into a skill", hint: " <text|url|path>" },
  { name: "/hub", desc: "browse + install hub skills", hint: "" },
  { name: "/memory", desc: "show/clear durable memory", hint: " [clear]" },
  { name: "/sandbox", desc: "ask|strict|open command gating", hint: "" },
  { name: "/ctx", desc: "park/restore turns (ctrl+g)", hint: "" },
  { name: "/purge", desc: "compact stale exchanges", hint: " [keep]" },
  { name: "/time", desc: "checkpoint rewind dialog", hint: "" },
  { name: "/rec", desc: "start/stop macro recording (ctrl+r)", hint: " [name]" },
  { name: "/macro", desc: "replay a recorded macro skill", hint: " <name>" },
  { name: "/zone", desc: "permission zones (.agentrules)", hint: "" },
  { name: "/diag", desc: "diagnostic cards from failures", hint: "" },
  { name: "/fix", desc: "auto-fix the first diag card", hint: "" },
  { name: "/lane", desc: "split-agent lane B (grid)", hint: " start|stop" },
  { name: "/skills-safe", desc: "gate agent skill writes", hint: "" },
  { name: "/skill-del", desc: "stash a hydra skill", hint: " <name>" },
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
    cc(DIM, " /theme [name]        live palette swap \u00b7 orng (opencode orange) crimson gold matrix ice mono"),
    cc(DIM, " /regen               regenerate the last reply \u00b7 /undo removes the last exchange"),
    cc(DIM, " /web <url>           fetch a web page into the conversation context"),
    cc(DIM, " /stats               turns \u00b7 approx tokens \u00b7 session/model/provider info"),
    cc(DIM, " /copylast            copy last reply ( same as alt+c )"),
    "",
    cc(CRIMSON + BOLD, " agent loop \u00b7 hermes-grade"),
    cc(DIM, " <skill> <task>       start a message with a skill name: its guide auto-loads"),
    cc(DIM, " @file.md             attach a file to your message (\u22644 files \u00b7 \u2264240 KB each)"),
    cc(DIM, " \u23f3 queueing           type + enter while a turn runs: your prompt waits, then runs"),
    cc(DIM, " todo tool            the model keeps a visible checklist for multi-step work"),
    cc(DIM, " \u2398 copy / paste       drag to select (highlight stays) \u00b7 ctrl+shift+c copies it, browser-style"),
    cc(DIM, " ctrl+c               first press clears the prompt \u00b7 again exits \u00b7 esc clears a selection"),
    cc(DIM, " alt+c                copy the entire last reply (raw markdown) \u00b7 ctrl+a copy whole screen"),
    cc(DIM, " ctrl+v / shift+ins   paste the clipboard into the prompt (multi-line safe)"),
    cc(DIM, " /skills              list installed skills (agent + opencode/claude dirs)"),
    cc(DIM, " /learn <src>         distill text/url/file into a NEW skill (agent writes it)"),
    cc(DIM, " /hub                 browse + install community skills (secret scan at install)"),
    cc(DIM, " /memory              show what the agent remembered \u00b7 /memory clear wipes it"),
    cc(DIM, " /sandbox ask|strict|open  gate risky commands behind y/n (default ask)"),
    cc(DIM, " /zone /rules        workspace permission zones \u00b7 .agentrules: deny/ask/allow <pattern>"),
    cc(DIM, " ctrl+p govern       context picker: park turns \u00b7 purge stale \u00b7 time travel \u00b7 diag"),
    cc(DIM, " /ctx / ctrl+g       park or restore whole turns from the model window"),
    cc(DIM, " /purge [keep]       compact stale exchanges (checkpoints keep it reversible via /time)"),
    cc(DIM, " /time               checkpoint rewind dialog \u2009\u00b7\u2009enter rewinds history to that point"),
    cc(DIM, " ctrl+r \u00b7 /rec       record the agent's shell steps as a macro skill \u00b7 /macro <name> replays"),
    cc(DIM, " /diag \u00b7 /fix        failing tool output becomes a diagnostic card \u00b7 /fix runs a heuristic"),
    cc(DIM, " /lane start <task>  split-agent grid: the second lane streams into the same body \u00b7 esc stops"),
    cc(DIM, " /skills-safe on|off  require your approval for agent skill writes"),
    cc(DIM, " /skill-del <name>    stash a hydra skill (u-restorable pattern in .trash)"),
    "",
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
const PANEL_W = 22;
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
  QUEUE: [],    // typed-during-a-turn prompts, flushed at the turn's end (opencode/Claude-style queueing)
  TODOS: [],    // the model's visible checklist (todo_write tool), {text, done}
  TOAST: null,  // { text, until } — short notification card shown above the composer
  CC_TS: 0,     // last ctrl+c timestamp (double-press to exit, claude-code style)
  GHOST: "",    // ghost-write completion shown after the caret; tab accepts
  TOKENS: 0,    // approx cumulative reply tokens this session ( telemetry footer )
  TPS: null,    // streaming speed telemetry { c, t, t0 } while a reply streams
  REC: { on: false, last: null },   // macro recording ( ctrl+r ), command steps captured while on
  RADAR: null,  // dependency fan-out radar for the last edited/written file
  LANES: { abort: null },   // split-agent grid: second lane ( /lane start )
};

function centerText(text, width) {
  const pad = Math.max(0, Math.floor((width - stripAnsi(text).length) / 2));
  return " ".repeat(pad) + text;
}
function padRow(text, width) {
  const plain = stripAnsi(text);
  if (plain.length > width) return ansiSplit(text, width)[0];
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
// atomic-ish session save: write to a temp sibling then rename, so a crash can never leave a half-written session
function atomicWrite(file, data) {
  const tmp = file + ".tmp" + String(process.pid);
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      lastErr = e;
      if (!/(EPERM|EACCES|EBUSY|EISDIR|ENOENT)/i.test(String(e.code || e.message || ""))) throw e;
      try { fs.unlinkSync(tmp); } catch { /* nop */ }
      const spin = Date.now() + 40 + 120 * i;
      while (Date.now() < spin) { }   // defender file locks clear in tens of ms; backoff beats a hard throw
    }
  }
  try {   // last resort: direct write ( never atomic, better than losing the session )
    fs.writeFileSync(file, data);
    try { fs.unlinkSync(tmp); } catch { /* nop */ }
  } catch (e2) { throw lastErr || e2; }
}

// production watchdog: every 1s record loop lag + state into ~/.hydra/heartbeat.txt,
// so a frozen session can always be diagnosed after the fact (which second it stalled, in which tool)
{
  const HB = path.join(CFG_DIR, "heartbeat.txt");
  let hbNext = Date.now() + 1000;
  setInterval(() => {
    const now = Date.now();
    const lag = Math.max(0, now - hbNext);
    hbNext = now + 1000;
    const line = new Date(now).toISOString() + " lag=" + lag + "ms"
      + (UI.busy ? " busy=" + (UI.busyLabel || "?") : " idle")
      + " turn=" + UI.turn + " tools=" + TOOL_CALLS_TOTAL
      + " outKB=" + Math.round((process.stdout.writableLength || 0) / 1024) + "\n";
    try {
      const st = fs.statSync(HB);
      if (st.size > 262144) { fs.writeFileSync(HB, line); return; }   // rotate: keep the most recent stretch only
    } catch { /* first write */ }
    try { fs.appendFileSync(HB, line); } catch { /* nop */ }
  }, 1000).unref();
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
    // ?1002 ( button-motion tracking ) is what makes real drag-select work in a live terminal:
    // without it a terminal reports only clicks, so painting a drag selection was impossible
    process.stdout.write(ESC + "[?1049h" + ESC + "[?25l" + ESC + "[?1000h" + ESC + "[?1002h" + ESC + "[?1006h" + ESC + "[?2004h");
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
    process.stdout.write(ESC + "[?25h" + ESC + "[?1000l" + ESC + "[?1002l" + ESC + "[?1006l" + ESC + "[?2004l" + ESC + "[?1049l");
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
  UI.log.push({ text: String(text), cache: null, t: Date.now() });
  if (UI.log.length > 3000) {
    const dropped = UI.log.splice(0, UI.log.length - 3000);
    let dwl = 0;
    for (const d of dropped) { if (d.cache && Array.isArray(d.cache)) dwl += d.cache.length; d.cache = null; }
    if (dwl && UI.anchorStart != null) UI.anchorStart = Math.max(0, UI.anchorStart - dwl);   // keep the frozen viewport on the same content
  }
  scheduleDraw();
}
function toast(text, ms) { UI.TOAST = { text: String(text || ""), until: Date.now() + (ms || 2600) }; scheduleDraw(); }
function addLogLines(lines) { for (const l of lines || []) addLog(l); }
// ---- ghost-write completion: the newest prompt-history (or chat-history) continuation shown after the caret, tab accepts
function updateGhost() {
  const q = UI.input;
  let g = "";
  const ql = String(q || "").toLowerCase();
  if (ql.length >= 2 && !q.startsWith("/") && !q.includes("\n")) {
    for (let i = PROMPT_HIST.length - 1; i >= 0; i--) {
      const h = String(PROMPT_HIST[i] || "");
      if (h.toLowerCase().startsWith(ql) && h.length > q.length) { g = h.slice(q.length); break; }
    }
    if (!g) {
      for (const m of HISTORY) {
        if (m.role !== "user") continue;
        const c = String(m.content || "");
        if (c.startsWith("[skill") || c.startsWith("[web:") || c.startsWith("[attached") || c.startsWith("[context")) continue;
        if (c.toLowerCase().startsWith(ql) && c.length > q.length && c.length < 2400) { g = c.slice(q.length); break; }
      }
    }
  }
  UI.GHOST = String(g || "").replace(/\n+/g, " ").replace(/\s+/g, " ").slice(0, 300);
}
function setUserInput(v) { UI.input = v; updateGhost(); syncSlashPopup(); UI.scroll = 0; scheduleDraw(); }

function nudgeScroll(n) {
  UI.scroll = Math.max(0, UI.scroll + n);
  scheduleDraw();
}

async function pasteClipboard() {
  // async spawn with a tight cap: a clipboard held by another process used to brick the UI for up to 15s
  startBusy("pasting");
  try {
    if (process.env.HYDRA_TEST) { stopBusy(); addLog(cc(DIM, " (test rig: real clipboard reads disabled)")); return; }
    const r = await runShellAsync("Get-Clipboard -Raw", CWD, 3000).catch(() => null);
    let txt = String(((r && r.status === 0) ? r.stdout : "") || "").replace(/\r/g, "").replace(/\n+/g, " ").trim();
    if (!txt && !(r && r.status === 0)) { stopBusy(); addLog(cc("\u001b[31m", " paste failed (clipboard busy or unavailable)")); return; }
    if (!txt) { stopBusy(); addLog(cc(DIM, " clipboard empty")); return; }
    if (txt.length > 4000) txt = txt.slice(0, 4000);
    setUserInput((UI.input + txt).slice(0, 8000));
    stopBusy();
    addLog(cc(DIM, " pasted " + txt.length + " chars"));
  } catch (e) { stopBusy(); addLog(cc("\u001b[31m", " paste failed: " + (e.message || e))); }
}

function listSessions() {
  try {
    return fs.readdirSync(sessionsDir()).filter((f) => f.endsWith(".json")).sort().reverse().slice(0, 400)
      .map((f) => {
        let turns = 0, whenISO = "";
        let name = f.replace(/\.json$/, "");
        if (/^\d{4}-\d{2}-\d{2}T/.test(name) && name.length >= 24) {
          name = name[24] === "-" ? name.slice(25) : (name.slice(5, 10) + " " + name.slice(11, 16).replace("-", ":"));
        }
        // head-slice read (max ~600B): session schema stores when/name first, history last -
        // opening the dialog over a huge store then costs O(600B x N) instead of full-file reads
        try {
          let rawN = "";
          const fd = fs.openSync(path.join(sessionsDir(), f), "r");
          try { const b = Buffer.alloc(600); const n = fs.readSync(fd, b, 0, 600, 0); rawN = b.toString("utf8", 0, Math.max(0, n)); }
          finally { try { fs.closeSync(fd); } catch { /* nop */ } }
          if (rawN.charCodeAt(0) === 0xFEFF) rawN = rawN.slice(1);
          let j = null;
          try { j = JSON.parse(rawN); } catch { /* truncated is expected; regex below */ }
          if (!j) {
            const mn = /"name"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(rawN);
            const mw = /"when"\s*:\s*"([^"]*)"/.exec(rawN);
            if (mn || mw) {
              try { j = { name: mn ? JSON.parse('"' + mn[1] + '"') : null, when: mw ? mw[1] : "", history: rawN.includes('"history"') ? undefined : [] }; } catch { j = null; }
            }
          }
          if (j) {
            turns = j.history && Array.isArray(j.history) ? j.history.length : turns;
            whenISO = j.when || "";
            if (j.name) return { value: f, name: String(j.name), whenISO, turns };
          }
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
    const isTime = UI.dialog && UI.dialog.isTime;
    let rawP = fs.readFileSync(path.join(isTime ? CHK_DIR() : sessionsDir(), String(file)), "utf8");
    if (rawP.charCodeAt(0) === 0xFEFF) rawP = rawP.slice(1);
    const j = JSON.parse(rawP);
    const hist = Array.isArray(j.history) ? j.history : [];
    const umsgs = hist.filter((m) => m.role === "user" && !String(m.content || "").startsWith("[skill"));
    const amsgs = hist.filter((m) => m.role === "assistant");
    outp.push(cc(CRIMSON + BOLD, " " + String(j.name || file)));
    outp.push(cc(DIM, " " + relTime(j.when) + " \u00b7 " + umsgs.length + " prompts \u00b7 " + amsgs.length + " replies"));
    const p = j.provider || j.model ? (j.provider || "") + (j.model ? " \u00b7 " + j.model : "") : "";
    if (p) outp.push(cc(DIM, " " + clip(p, prevW - 2)));
    if (isTime) outp.push(cc(DIM, " checkpoint \u00b7 enter rewinds history to this point"));
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
    if (d.isTime) { restoreCheckpoint(it.value); return; }   // time travel rewinds straight from the dialog
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

// ---- turn surgery + extras ( /undo /regen /web /stats )
function undoTurn() {
  if (UI.busy) { addLog(cc(DIM, " wait for the turn to finish (or hit esc) \u00b7 then /undo")); return; }
  if (!HISTORY.length) { addLog(cc(DIM, " nothing to undo \u00b7 the session has no turns")); return; }
  const before = HISTORY.length;
  while (HISTORY.length && HISTORY[HISTORY.length - 1].role !== "user") HISTORY.pop();
  if (HISTORY.length) HISTORY.pop();
  const n = before - HISTORY.length;
  if (!n) { addLog(cc(DIM, " nothing to undo")); return; }
  saveSession();
  addLog(cc(DIM, " \u21a9 removed the last exchange (" + n + " messages) \u00b7 /regen retries it"));
  scheduleDraw(true);
}
async function regenLast() {
  if (UI.busy) { addLog(cc(DIM, " wait for the turn to finish (or hit esc) \u00b7 then /regen")); return; }
  if (!HISTORY.length) { addLog(cc(DIM, " nothing to regen \u00b7 the session is empty")); return; }
  const lu = [...HISTORY].reverse().find((m) => m.role === "user" && !String(m.content || "").startsWith("[skill"));
  if (!lu) { addLog(cc(DIM, " no user turn to regen")); return; }
  const q = String(lu.content || "");
  while (HISTORY.length && HISTORY[HISTORY.length - 1].role !== "user") HISTORY.pop();
  if (HISTORY.length) HISTORY.pop();
  addLog(cc(CRIMSON + BOLD, " \u21ba regen \u2193"));
  await runAgentTurn(q);
}
async function webInjectLines(url) {
  url = String(url || "").trim();
  if (!/^https?:\/\//i.test(url)) return [cc(DIM, " usage: /web <https url>")];
  startBusy("fetching page");
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { "User-Agent": "Mozilla/5.0 hydra-cli" } });
    let t = await r.text();
    if (!r.ok) return [cc("\u001b[31m", " http " + r.status + " for " + url)];
    t = t.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#0?39;/gi, "'").replace(/\s+/g, " ").trim();
    if (!t) return [cc("\u001b[31m", " no readable text at " + url)];
    const body = t.slice(0, 6000);
    HISTORY.push({ role: "user", content: "[web: " + url + "]\n" + body });
    return [" \ud83c\udf10 fetched " + cc(CRIMSON + BOLD, truncateLine(url, 42)) + cc(DIM, " \u00b7 " + body.length + " chars into context \u00b7 persisted next turn")];
  } catch (e) {
    return [cc("\u001b[31m", " fetch failed: " + (e.message || e))];
  } finally {
    stopBusy();
  }
}
function statsLines() {
  loadCfg();
  const users = HISTORY.filter((m) => m.role === "user" && !String(m.content || "").startsWith("[skill")).length;
  const asst = HISTORY.filter((m) => m.role === "assistant").length;
  const chars = HISTORY.reduce((a, m) => a + String(m.content || "").length, 0);
  const p = activeProvider();
  return [
    cc(CRIMSON + BOLD, " \u2500\u2500 session stats"),
    cc(DIM, " turns: ") + cc(CRIMSON + BOLD, "" + users) + cc(DIM, " \u00b7 user msg: " + users + " \u00b7 replies: " + asst + " \u00b7 in history: " + HISTORY.length),
    cc(DIM, " approx tokens: ") + cc(CRIMSON + BOLD, "~" + Math.round(chars / 4)) + cc(DIM, " (" + chars + " chars)"),
    cc(DIM, " session: ") + (ACTIVE_SESSION_FILE || cc(DIM, "not saved yet")) + cc(DIM, " \u00b7 cwd: " + shortPath(CWD)),
    cc(DIM, " model: ") + cc(CRIMSON + BOLD, p.model) + cc(DIM, " \u00b7 provider: " + p.name + " \u00b7 palette: " + activeTheme() + " \u00b7 mode: " + UI.mode),
    cc(DIM, " agent loop: ") + cc(CRIMSON + BOLD, skillsCount() + " skills") + cc(DIM, " \u00b7 " + readMemoryLines(200).length + " memory facts \u00b7 " + readLessons(999).length + " lessons \u00b7 sandbox " + SANDBOX_MODE() + (DEEP_SHELL.child ? " \u00b7 deep terminal live" : "")),
  ];
}
function popupActivate() {
  if (!UI.popupOpen) return;
  const t = UI.popupTitle, it = UI.popupItems[UI.popupSel], kind = popupKind();
  closePopup(); setUserInput("");
  if (!it) return;
  if (kind === "model") { const hadBusy = UI.busy; if (!hadBusy) startBusy("switching model"); ((async () => { try { addLogLines(await modelUseLines(String(Number(it.value) + 1))); } catch (e) { addLog(cc("\u001b[31m", " error: " + (e.message || e))); } if (!hadBusy) stopBusy(); })()); return; }
  if (kind === "provider") { if (it.value === "pastekey") { startPasteKeyCapture(); return; } if (it.value === "other") { startCustomProvider(); return; } addLogLines(providerUseLines(it.value)); return; }
  if (kind === "custom") { providerPickModels(); return; }
  if (kind === "skills") { injectSkillValue(it.value); return; }
  if (kind === "hub") { hubInstall(Number(it.value)); return; }
  if (kind === "theme") { applyTheme(String(it.value)); addLog(cc(CRIMSON + BOLD, "  palette -> " + it.value + " \u00b7 applies instantly, saved to config")); scheduleDraw(true); return; }
  if (kind === "ctx") {
    const i = Number(it.value) || 0;
    if (CTX.excl.has(i)) {
      CTX.excl.delete(i); CTX.excl.delete(i + 1);
      addLog(cc(CRIMSON + BOLD, " \u21a9 turn " + (i / 2 + 1) + " back in context"));
    } else {
      CTX.excl.add(i); CTX.excl.add(i + 1);
      addLog(cc(CRIMSON + BOLD, " \u21dd turn " + (i / 2 + 1) + " parked") + cc(DIM, " \u00b7 prompts get slimmer \u00b7 enter again brings it back"));
      saveSession();
    }
    scheduleDraw(true);
    return;
  }
  if (kind === "govern") {
    if (it.value === "ctx") { openCtxPicker(); return; }
    if (it.value === "purge") { purgeStale(""); return; }
    if (it.value === "time") { openTimeDialog(); return; }
    if (it.value === "stats") addLogLines(statsLines());
    if (it.value === "diag") addLogLines(diagLines());
    return;
  }
  if (t === "slash") { setUserInput((it.value || stripAnsi(it.label)).trim() + " "); syncSlashPopup(); return; }
}
const TRASH_DIR = () => path.join(sessionsDir(), ".trash");
function stashReplace(oldFile) {
  const oldPath = path.join(sessionsDir(), String(oldFile));
  try {
    if (!fs.existsSync(oldPath)) return;
    fs.mkdirSync(TRASH_DIR(), { recursive: true });
    const stash = String(Date.now()).padStart(13, "0") + "-" + String(oldFile);
    try { fs.renameSync(oldPath, path.join(TRASH_DIR(), stash)); }
    catch { fs.copyFileSync(oldPath, path.join(TRASH_DIR(), stash)); fs.unlinkSync(oldPath); }
  } catch { try { fs.unlinkSync(oldPath); } catch { /* last resort */ } }
}
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
    atomicWrite(path.join(sessionsDir(), newPath), JSON.stringify(j, null, 2));
    if (newPath !== String(it.value)) stashReplace(it.value);   // pre-rename copy lands in .trash
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
    cc(DIM, "turns " + UI.turn + " \u00b7 tools " + Math.min(999, TOOL_CALLS_TOTAL)),
    cc(DIM, fmtDur(Date.now() - SESSION_START) + " session"),
    cc(DIM, "-".repeat(Math.max(4, W - 1))),
    cc(DIM, "sessions " + cachedCount("sessions", sessionCount)),
    cc(DIM, "skills   " + cachedCount("skills", skillsCount)),
    cc(DIM, "mcps     " + cachedCount("mcps", mcpCount)),
    cc(DIM, "-".repeat(Math.max(4, W - 1))),
    cc(DIM, "sandbox " + SANDBOX_MODE()),
    cc(DIM, "deep    " + (DEEP_SHELL.child ? "live" : "off")),
    cc(DIM, "memory  " + cachedCount("memory", memoryFactsCount)),
    cc(DIM, "lessons " + cachedCount("lessons", lessonCount)),
    cc(DIM, "ctx     " + ctxK() + (CTX.excl.size ? "*" : "")),
    ...(UI.RADAR ? [
      cc(DIM, "radar   " + UI.RADAR.n + (UI.RADAR.n ? " hits" : " 0")),
      ...(UI.RADAR.n ? [cc(CRIMSON, " fan-out " + clip(UI.RADAR.file || "", 14))] : []),
    ] : []),
    ...(UI.TOKENS ? [cc(DIM, "tok     " + Math.min(999999, UI.TOKENS))] : []),
    ...(UI.REC.on ? [cc("\u001b[31m", "rec     ON")] : []),
    ...(UI.TODOS.length ? [
      cc(UI.TODOS.some((t) => !t.done) ? CRIMSON + BOLD : DIM, "todo    " + UI.TODOS.filter((t) => !t.done).length + "/" + UI.TODOS.length),
      // opencode-style checklist on the rail: pending bold, the first open one is the current task, done dims out
      ...UI.TODOS.slice(0, 12).map((t) => cc(t.done ? DIM : (UI.TODOS.findIndex((x) => !x.done) === UI.TODOS.indexOf(t) ? CRIMSON + BOLD : CRIMSON), (t.done ? "\u2611 " : "\u2610 ") + clip(t.text, PANEL_W - 5))),
    ] : []),
    cc(DIM, "-".repeat(Math.max(4, W - 1))),
    cc(DIM, "say <skill>"),
    cc(DIM, "esc int"),
    cc(DIM, "tab b/p" ),
    cc(DIM, "/ cmds" ),
  ];
}
const _COUNT_CACHE = { sessions: { v: 0, t: 0 }, skills: { v: 0, t: 0 }, mcps: { v: 0, t: 0 }, memory: { v: 0, t: 0 }, lessons: { v: 0, t: 0 } };
// ---- context governance: budget meter, parked turns ( ctrl+p /govern picker ), /purge gc ----
const CTX = { excl: new Set(), maxK: 0, last: null };   // excl = HISTORY indexes of parked (user+assistant) pairs
function ctxFaceLive() {
  const h = HISTORY, out = [];
  for (let i = 0; i < h.length; i++) if (!CTX.excl.has(i)) out.push(h[i]);
  return out;
}
function faceTokens(f) {
  let c = 0;
  for (const m of f) c += String((m && m.content) || "").length;
  return Math.round(c / 4);
}
function budgetFace(history) {
  const hist = history || HISTORY;
  const live = [];
  for (let i = 0; i < hist.length; i++) if (!(history ? false : CTX.excl.has(i))) live.push(hist[i]);
  let face = live.length > MODEL_KEEP ? live.slice(-MODEL_KEEP) : live;
  const dropped = { trim: live.length - face.length, park: history ? 0 : Math.floor(CTX.excl.size / 2) };
  let tok = faceTokens(face);
  const cap = Math.max(2000, (Number(process.env.HYDRA_CTX_MAX) || 0) || ((CTX.maxK || 0) * 1000) || 24000);
  while (face.length > 2 && tok > cap) {
    const gone = face.shift();
    tok = Math.max(0, Math.round(tok - String((gone && gone.content) || "").length / 4));
    dropped.trim++;
  }
  const out = { face, tok, cap, dropped };
  if (!history) CTX.last = out;
  return out;
}
// rough context-size gauge (chars/4 ≈ tokens) over the live model window — ai-cli style "ctx" readout
function ctxTokens() {
  const b = budgetFace();
  return b ? b.tok : 0;
}
function ctxK() {
  const tk = ctxTokens() / 1000;
  return tk >= 1000 ? (tk / 1000).toFixed(1) + "m" : Math.round(tk) + "k";
}
// /purge: keep the head + tail of stale exchanges, replace the middle with a marker ( tokens are reclaimed, the gist stays )
function purgeKeepHeadTail(i, head, tail) {
  if (HISTORY[i] && HISTORY[i].content) HISTORY[i].content = String(HISTORY[i].content).slice(0, head) + (tail ? "```+ " + String(HISTORY[i].content).slice(-tail) : "") + " … [head/tail kept by /purge]";
  if (HISTORY[i + 1] && HISTORY[i + 1].content) HISTORY[i + 1].content = String(HISTORY[i + 1].content).slice(0, head) + " … [head kept by /purge]";
}
function boardExchanges() {   // exchanges (index i => HISTORY[i], i+1) with sizes + staleness, oldest first
  const out = [];
  for (let i = 0; i < HISTORY.length; i += 2) {
    const u = String((HISTORY[i] || {}).content || "");
    const a = String((HISTORY[i + 1] || {}).content || "");
    out.push({ i, turn: i / 2 + 1, size: u.length + a.length, head: clip(u.replace(/\s+/g, " ").trim(), 60), parked: CTX.excl.has(i) });
  }
  return out;
}
// /purge [keep]: compacts stale exchanges ( everything older than the last 3 turns ) to their heads — a checkpoint first, so it is reversible via /time
function purgeStale(argn) {
  if (UI.busy) { addLog(cc(DIM, " wait for the turn to finish (or esc) \u00b7 then /purge")); return; }
  const keep = Math.max(80, parseInt(argn, 10) || 300);
  let done = 0, before = 0;
  const cutoff = Math.max(0, HISTORY.length - 6);   // the last 3 exchanges always stay whole
  const bodied = boardExchanges().filter((x) => x.i + 2 <= cutoff && !x.parked && x.size >= 800);
  if (!bodied.length) { addLog(cc(DIM, " nothing stale to purge \u00b7 the last 3 turns always stay whole \u00b7 a /time checkpoint covers the purge")); return; }
  saveCheckpoint(false);
  before = HISTORY.reduce((a, m) => a + String((m && m.content) || "").length, 0);
  for (const x of bodied) purgeKeepHeadTail(x.i, keep, Math.max(0, keep - 60));
  const after = HISTORY.reduce((a, m) => a + String((m && m.content) || "").length, 0);
  addLog(cc(CRIMSON + BOLD, " \u25bd purged " + bodied.length + " stale exchanges") + cc(DIM, " \u00b7 " + Math.round(before / 4) + " \u2192 " + Math.round(after / 4) + " tokens \u00b7 full text is one \u21bb in /time away"));
  scheduleDraw(true);
}
// ctrl+p /govern picker: the context-control surface ( fig 5 ) on a popup
function openGovernPicker() {
  const b = budgetFace();
  const items = [
    { label: "park turns " + cc(DIM, "\u00b7 slim prompts"), desc: " /ctx picker \u00b7 " + Math.floor(CTX.excl.size / 2) + " parked now", value: "ctx" },
    { label: "purge stale " + cc(DIM, "\u00b7 reclaim"), desc: " /purge \u00b7 " + b.tok + "/1000 tok in the window", value: "purge" },
    { label: "time travel " + cc(DIM, "\u00b7 rewind"), desc: " /time \u00b7 checkpoints dir", value: "time" },
    { label: "stats " + cc(DIM, "\u00b7 usage"), desc: " /stats \u00b7 session tokens", value: "stats" },
    { label: "diag " + cc(DIM, "\u00b7 failures"), desc: " /diag \u00b7 " + (DIAG.length ? "cards open ( /fix runs a heuristic )" : "no cards"), value: "diag" },
  ];
  openPopup("govern \u2502 enter opens the tool \u00b7 esc close", items);
}
function cachedCount(kind, fn) {
  const c = _COUNT_CACHE[kind];
  if (Date.now() - c.t > 4000) { c.v = fn(); c.t = Date.now(); }
  return c.v;
}
function memoryFactsCount() { return readMemoryLines(200).length; }
function lessonCount() { return readLessons(999).length; }

function sessionsDir() { return path.join(CFG_DIR, "sessions"); }
function sessionCount() {
  try { return fs.readdirSync(sessionsDir()).filter((f) => f.endsWith(".json")).length; } catch { return 0; }
}
const SKILL_DIRS = [
  path.join(CFG_DIR, "skills"),                                          // hydra-native skills (agent can write here)
  path.join(os.homedir(), ".config", "opencode", "skills"),
  path.join(os.homedir(), ".claude", "skills"),
  path.join(os.homedir(), ".agents", "skills"),
];
function skillDirsLL() { return SKILL_DIRS; }
const SKILL_TRASH = () => path.join(CFG_DIR, "skills", ".trash");
function safeSkillName(n) {
  const s = String(n || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return s && s !== ".trash" && !s.startsWith(".") ? s : "";
}
function skillFile(sname) { return path.join(CFG_DIR, "skills", sname, "SKILL.md"); }
function readSkillBody(sname, cap) {
  const s = safeSkillName(sname);
  if (!s) return "";
  try { return fs.readFileSync(skillFile(s), "utf8").slice(0, cap || 8000); } catch { /* fall through */ }
  const found = listSkillDirs().find((x) => x.name.toLowerCase() === String(sname).toLowerCase());
  if (!found) return "";
  try { return fs.readFileSync(path.join(found.dir, found.name, "SKILL.md"), "utf8").slice(0, cap || 8000); } catch { return ""; }
}
function listSkillDirs() {
  const out = [];
  const seen = new Set();
  for (const d of SKILL_DIRS) {
    let names = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (out.length >= 220) return out;
      try {
        if (!fs.statSync(path.join(d, n)).isDirectory()) continue;
        if (seen.has(n.toLowerCase())) continue;
        seen.add(n.toLowerCase());
        let description = "";
        try {
          const head = fs.readFileSync(path.join(d, n, "SKILL.md"), "utf8").slice(0, 900);
          const fm = head.match(/^description[ ]*:[ ]*(.+)$/im) || head.match(/"\s*description\s*"\s*:\s*"(.+?)"/);
          if (fm) description = fm[1].trim();
          else { const h = head.match(/^#+\s+(.+)$/m); if (h) description = h[1].trim().slice(0, 120); }
        } catch { /* unreachable: no SKILL.md, keep name only */ }
        out.push({ name: n, dir: d, description });
      } catch { /* nop */ }
    }
  }
  return out;
}
function skillsCount() { return listSkillDirs().length; }

// ---- hermes-grade self-improvement layer:
//   memory     = ~/.hydra/memory.md              small facts, always in context
//   lessons    = ~/.hydra/learnings.jsonl         session transcript-of-results, last 5 injected
//   skills     = ~/.hydra/skills/<slug>/SKILL.md  procedures, description always in context, body on demand
const MEM_MD = path.join(CFG_DIR, "memory.md");
const LESSONS_L = path.join(CFG_DIR, "learnings.jsonl");
function readMemoryLines(cap) {
  try {
    return fs.readFileSync(MEM_MD, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-(cap || 12));
  } catch { return []; }
}
function memoryAppend(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim().slice(0, 240);
  if (!t) return false;
  try {
    const lines = readMemoryLines(50);
    if (lines.some((l) => l.toLowerCase() === t.toLowerCase())) return false; // no duplicates
    lines.push(t);
    fs.mkdirSync(CFG_DIR, { recursive: true });
    atomicWrite(MEM_MD, lines.slice(-20).join("\n") + "\n");
    return true;
  } catch { return false; }
}
function appendLearning(topic, tools, outcome) {
  try {
    fs.mkdirSync(CFG_DIR, { recursive: true });
    fs.appendFileSync(LESSONS_L, JSON.stringify({ ts: new Date().toISOString(), topic: String(topic || "").slice(0, 80), tools: tools | 0, outcome: String(outcome || "").slice(0, 200) }) + "\n");
  } catch { /* nop */ }
}
function readLessons(cap) {
  try {
    const raw = fs.readFileSync(LESSONS_L, "utf8").split(/\r?\n/).filter(Boolean);
    return raw.slice(-(cap || 5));
  } catch { return []; }
}

// ---- hub: /hub fetches the catalog, installs skill files after a security scan ((jsonl) check)
const HUB_URL = process.env.HYDRA_HUB_URL || "https://raw.githubusercontent.com/hydra-eng/hydra-cli/master/hub.json";
const HUB_BASE = process.env.HYDRA_HUB_BASE || "https://raw.githubusercontent.com/hydra-eng/hydra-cli/master/skills/";
let HUB_CATALOG = [];
async function hubInstall(idx) {
  const entry = HUB_CATALOG[idx];
  if (!entry || !entry.name) { addLog(cc(DIM, " nothing selected from the hub")); return; }
  const slug = safeSkillName(entry.name);
  if (!slug) { addLog(cc("\u001b[31m", " bad hub skill name: " + entry.name)); return; }
  const hadBusy = UI.busy;
  if (!hadBusy) startBusy("hub install");
  try {
    const raw = await fetchText(HUB_BASE + (entry.path || slug + ".md"), 15000);
    const verdict = hubScan(raw);
    if (verdict) { addLog(cc("\u001b[31m", " hub install blocked: " + verdict)); return; }
    const file = skillFile(slug);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicWrite(file, raw);
    addLog(cc(CRIMSON + BOLD, " installed skill: ") + slug + cc(DIM, " (hub \u00b7 security scan ok \u00b7 type " + slug + " <task> to use it)"));
  } catch (e) {
    addLog(cc("\u001b[31m", " hub install failed: " + (e.message || e)));
  } finally { if (!hadBusy) stopBusy(); scheduleDraw(true); }
}
const SECRET_RX = /(sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|gsk_[A-Za-z0-9]{20,}|BEGIN [A-Z ]*PRIVATE KEY|-----BEGIN)/;
function hubScan(text) {
  if (!text || text.length > 65536) return "too large or empty";
  if (SECRET_RX.test(text)) return "looks like embedded credentials";
  if (/Invoke-Expression|IEX\s*\(|Set-ExecutionPolicy|curl.*\|\s*(sh|bash|powershell)|irm\s+https?:/.test(text)) return "contains raw shell-eval or policy tampering";
  return "";
}
async function fetchText(url, ms) {
  const ac = new AbortController();
  const to = setTimeout(() => { try { ac.abort(); } catch { /* nop */ } }, ms || 12000);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { "user-agent": "hydra-cli" } });
    if (!r.ok) throw new Error("http " + r.status);
    return await r.text();
  } finally { clearTimeout(to); }
}

// ---- sandbox: ask|strict|open — gates destructive bash commands behind a y/n prompt
const SANDBOX_MODE = () => String(process.env.HYDRA_SANDBOX || CFG.sandbox || "ask").toLowerCase();
const RISKY_RX = /(^|[;&|]\s*)(rm\s+(-[a-z]*r[a-z]*f?|-[a-z]*f?-?[a-z]*r?)\b|remove-item\b.+-(recurse|force)|rd\s+\/s|del\s+\/[fqs].*\*|format(-volume)?\b|diskpart|reg\s+(delete|add)|set-executionpolicy|invoke-expression|\biex\b|taskkill\s+\/[fs]|git\s+(push\s+.*--force|--force.*push|reset\s+--hard|clean\s+-[fxd]))/i;
function isRisky(cmd) { return RISKY_RX.test(String(cmd || "")); }
let UI_CONFIRM = null;   // { label, resolve } while a sandbox y/n is pending
function askUserConfirm(label, ms) {
  const mode = SANDBOX_MODE();
  if (!process.stdout.isTTY) return Promise.resolve(false);           // headless/scripts: refuse destructive by default
  if (mode !== "ask" && mode !== "strict") return Promise.resolve(true);
  return new Promise((resolve) => {
    const total = ms || 120000;
    const to = setTimeout(() => { if (UI_CONFIRM && UI_CONFIRM._resolve === resolve) { try { UI_CONFIRM._tick?.unref && clearInterval(UI_CONFIRM._tick); } catch { /* nop */ } UI_CONFIRM = null; scheduleDraw(true); addLog(cc(DIM, " sandbox confirm timed out \u00b7 treated as no")); resolve(false); } }, total);
    UI_CONFIRM = { label, dead: Date.now() + total, resolve: (v) => { clearTimeout(to); try { clearInterval(UI_CONFIRM._tick); } catch { /* nop */ } UI_CONFIRM = null; resolve(v); } };
    UI_CONFIRM._resolve = resolve;
    UI_CONFIRM._tick = setInterval(() => { if (UI_CONFIRM) scheduleDraw(); }, 1000);
    try { UI_CONFIRM._tick.unref(); } catch { /* nop */ }
    addLog(cc(CRIMSON + BOLD, " sandbox risk \u00b7 allow? ") + clip(label, Math.max(40, UI.cols - PANEL_W - 24)) + cc(DIM, "  y allow \u00b7 n/esc block \u00b7 auto-no in " + Math.round(total / 1000) + "s"));
    scheduleDraw(true);
  });
}

// ---- deep terminal: one persistent PowerShell child so cwd/env survive between bash tool calls
class DeepShell {
  constructor() { this.child = null; this.seq = 0; this.current = null; }
  spawn() {
    if (this.child) return this.child;
    const sh = process.env.SystemRoot ? process.env.SystemRoot + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" : "powershell.exe";
    this.child = spawn(sh, ["-NoProfile", "-NoLogo", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child.on("exit", () => {
      this.child = null;
      const cur = this.current; this.current = null;
      if (cur) cur.dead();
    });
    this.child.on("error", () => {
      this.child = null;
      const cur = this.current; this.current = null;
      if (cur) cur.dead();
    });
    return this.child;
  }
  get alive() { return !!(this.child && this.child.stdin && this.child.stdin.writable); }
  kill() {
    try { if (this.child) this.child.kill(); } catch { /* nop */ }
    this.child = null;
    const cur = this.current; this.current = null;
    if (cur) cur.dead();
  }
  // single flight: one command at a time (the tool loop is sequential by design)
  run(cmd, timeoutMs, signal) {
    if (this.current) return Promise.resolve({ code: -2, out: "", failed: "busy" });
    if (/[\r\n]/.test(String(cmd || "")) || String(cmd).length >= 2000)
      return Promise.resolve({ code: -3, out: "", failed: "multiline" });
    const c = this.spawn();
    if (!c || !this.alive) return Promise.resolve({ code: -1, out: "", failed: "spawn" });
    const n = ++this.seq;
    const tag = "__HDEND_" + n + "__";
    return new Promise((resolve, reject) => {
      let out = "", err = "", h = null, finished = false;
      const finish = (fn, v) => { if (finished) return; finished = true; if (h) clearTimeout(h);
        try { c.stdout.removeListener("data", onData); } catch { /* nop */ }
        try { c.stderr.removeListener("data", onErr); } catch { /* nop */ }
        if (signal) signal.removeEventListener("abort", onAbort);
        this.current = null; fn(v); };
      const onData = (d) => {
        out += d;
        const m = out.match(new RegExp("__HDEND_" + n + "_(\\d*)__"));
        if (m) {
          const idx = out.indexOf(m[0]);
          out = out.slice(0, idx);
          finish(resolve, { code: parseInt(m[1] || "0", 10) || 0, out, err });
        }
      };
      const onErr = (d) => { err += d; };
      const onAbort = () => { this.kill(); finish(reject, Object.assign(new Error("aborted"), { name: "AbortError" })); };
      const onDead = () => finish(reject, Object.assign(new Error("deep shell died"), { name: "DeepDead" }));
      this.current = { dead: onDead };
      c.stdout.on("data", onData);
      c.stderr.on("data", onErr);
      if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener("abort", onAbort); }
      h = setTimeout(() => {
        this.kill();
        finish(resolve, { code: -4, out, err, failed: "timeout" });
      }, Math.max(10000, timeoutMs || TOOL_TIMEOUT));
      out = ""; err = "";
      try { c.stdin.write(String(cmd) + ' ; Write-Output ("__HDEND_' + n + '_" + $LASTEXITCODE + "__")' + "\n"); }
      catch { this.kill(); }
    });
  }
}
const DEEP_SHELL = new DeepShell();
// one bash call: sandbox gate first, then persistent shell (single-line) with fresh-shell fallback
async function runBash(cmd, timeoutMs, signal) {
  recBash(cmd);   // macro recording watches every planned shell step
  const mode = SANDBOX_MODE();
  if (mode !== "open" && isRisky(cmd)) {
    const ok = await askUserConfirm(String(cmd || "").trim().slice(0, 120), 120000, signal);
    if (!ok) return { code: -9, out: "", failed: "denied" };
  }
  if (!/[\r\n]/.test(String(cmd || "")) && String(cmd).length < 2000) {
    try { return await DEEP_SHELL.run(cmd, timeoutMs, signal); }
    catch (e) {
      if (signal?.aborted || e.name === "AbortError") throw e;
      // deep shell died or failed to spawn: fall through to a fresh shell, same semantics
    }
  }
  return runShellAsync(cmd, CWD, timeoutMs, signal);
}

// ---- permission zones (.agentrules): the user's own red/yellow/green file for what bash may run
// first matching rule wins: `deny <pattern>` blocks, `ask <pattern>` confirms, `allow <pattern>` runs even in a strict sandbox
let _ZONE_CACHE = { t: 0, z: null };
function loadZones() {
  if (Date.now() - _ZONE_CACHE.t > 4000) {
    const z = [];
    for (const p of [path.join(CWD, ".agentrules"), path.join(CFG_DIR, ".agentrules")]) {
      try {
        for (const l of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
          const s = l.trim();
          if (!s || s.startsWith("#")) continue;
          const kw = (s.match(/^(deny|ask|allow)\b/i) || [])[1];
          if (kw) z.push({ kind: kw.toLowerCase(), rx: s.replace(/^[a-zA-Z]+\s*/, "").trim(), dir: p });
        }
      } catch { /* no rules file here */ }
      if (z.length) break;   // workspace rules shadow the global ones
    }
    _ZONE_CACHE = { t: Date.now(), z };
  }
  return _ZONE_CACHE.z;
}
function ruleZone(cmd) {
  const z = loadZones();
  if (!z) return null;
  const s = String(cmd || "");
  for (const r of z) {
    let rx = null;
    try { rx = new RegExp(r.rx, "i"); } catch { continue; }
    if (rx.test(s)) return r.kind;
  }
  return null;
}
function zoneLines() {
  const z = loadZones() || [];
  return [" Zones (" + (z.length ? (z[0].dir === path.join(CWD, ".agentrules") ? shortPath(path.join(CWD, ".agentrules")) : shortPath(z[0].dir)) : "no .agentrules found") + "):",
    ...(z.length ? z.slice(0, 24).map((r) => cc(DIM, "  " + r.kind.padEnd(6)) + cc(CRIMSON, r.rx)) : [" " + cc(DIM, " deny/ask/allow <pattern> \u00b7 first match wins")])];
}

// ---- macro recording: ctrl+r starts grabbing every bash step the agent runs; /rec stop compiles it into a reusable skill ----
const REC = { on: false, items: [], ts: 0, last: null };
function recStart() {
  REC.on = true; REC.items = []; REC.ts = Date.now();
  addLog(cc(CRIMSON + BOLD, " \u25cf recording \u00b7 every shell step hydra runs is captured") + cc(DIM, " \u00b7 ctrl+r again (or /rec) to compile it into a skill"));
  scheduleDraw();
}
function recBash(cmd) { if (REC.on && cmd) REC.items.push(String(cmd).slice(0, 500)); }
async function recStop(askKeep) {
  if (!REC.on) { addLog(cc(DIM, " not recording \u00b7 ctrl+r starts a macro")); return; }
  const n = REC.items.length;
  REC.on = false;
  if (!n) { addLog(cc(DIM, " recording stopped \u00b7 no steps captured")); return; }
  const slug = safeSkillName("macro-" + (askKeep ? String(askKeep).replace(/[^a-z0-9]+/gi, "-").slice(0, 24) : "capture-" + String(RREC_TS()).slice(-4)));
  const body = ["# Macro (auto-recorded by hydra)", "",
    "The user hit ctrl+r and I ran the following shell steps in order. Reproduce them EXACTLY with the bash tool when asked to repeat this workflow:",
    "",
    ...REC.items.map((c, i) => (i + 1) + ". `" + c.replace(/`/g, "'") + "`"),
    "",
    "Run them one at a time; stop if a step fails and say which one."].join("\n");
  const file = skillFile(slug);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicWrite(file, "---\nname: " + slug + "\ndescription: recorded macro with " + n + " shell steps (macros capture workflows in real time)\n---\n\n" + body + "\n");
    REC.last = slug;
    addLog(cc(CRIMSON + BOLD, " \u2b1c macro skill saved: " + slug) + cc(DIM, " \u00b7 " + n + " steps \u00b7 say \u201cmacro " + slug + "\u201d to replay it"));
    scheduleDraw(true);
  } catch (e) { addLog(cc("\u001b[31m", " macro save failed: " + (e.message || e))); }
}
function RREC_TS() { return Date.now().toString(36); }
async function macroRun(name) {
  const slug = safeSkillName(name);
  const body = slug ? readSkillBody(slug, 20000) : "";
  if (!body || !/macro|shell|steps/i.test(body + slug)) {
    addLog(cc(DIM, " no macro skill named \u201c" + (name || "?") + "\u201d \u00b7 ctrl+r records one, /rec compiles it"));
    return;
  }
  addLog(cc(CRIMSON + BOLD, " \u25b6 replaying macro: ") + slug);
  await runAgentTurn("Replay the skill \u201c" + slug + "\u201d: follow its numbered steps with the bash tool exactly, in order, reporting each step result in one short line. The skill body is loaded automatically since my message started with its name.");
}

// ---- split-agent lane B ( the grid's second worker ): its own history clone, its own abort, deltas stamped into the shared body
function laneStop(quiet) {
  const L = UI.LANES;
  if (!L.abort) { if (!quiet) addLog(cc(DIM, " no lane running \u00b7 /lane start <task> spawns one")); return; }
  try { L.abort.abort(); } catch { /* nop */ }
}
async function laneStart(q) {
  const L = UI.LANES;
  if (L.abort) { addLog(cc(DIM, " lane B is already running \u00b7 /lane stop first")); return; }
  if (!q) { addLog(cc(DIM, " /lane start <task> \u00b7 \u00b7 the task runs on lane B while lane A keeps yours \u00b7 esc or /lane stop ends it")); return; }
  if (UI.busy) { addLog(cc(DIM, " lane A is mid-turn \u00b7 lane B can start alongside after it \u00b7 try again then")); return; }
  const histB = HISTORY.slice(0);   // independent clone: lane B works on a snapshot, never mutates lane A's context
  const ab = new AbortController();
  L.abort = ab;
  addLog(cc(CRIMSON + BOLD, " \u26a1 lane B started \u00b7 ") + clip(q, 64) + cc(DIM, " \u00b7 its own context clone \u00b7 ESC ends it"));
  try {
    const out = await agentLoop(q, activeProvider(),
      (t) => addLog(cc("\u001b[38;5;141m", "" ) + cc(DIM, " \u2039b\u203a ") + t),
      (tool) => addLog(cc("\u001b[38;5;141m", "   > lane: ") + cc(DIM, truncateLine(tool, Math.max(30, UI.cols - PANEL_W - 12)))),
      histB, ab.signal, false,
      "[grid lane B: you are posting into a SPLIT-AGENT GRID. Reply tight (<=300 words); the user watches lane A's text as the master draft; your work extends it.]");
    if (L.abort === ab) { addLog(cc("\u001b[38;5;141m", " \u26a1 lane B done \u00b7 ") + cc(DIM, stripAnsi(out).length + " chars (its clone is not merged into lane A's history \u00b7 reference it by asking)")); L.abort = null; }
  } catch (e) {
    if (L.abort === ab) { addLog(ab.signal.aborted ? cc("\u001b[38;5;141m", " \u26a1 lane B stopped by you") : cc("\u001b[31m", " lane B failed: " + (e.message || e))); L.abort = null; }
  }
  if (L.abort === ab) L.abort = null;
}

// ---- diagnostic cards: failing tool output is parsed into one-line cards; a built-in fixer patches common breakage
let DIAG = [];
function diagProbe(cmd, text, code) {
  const s = String(text || "");
  if (!s) return;
  const rx = /^(.*?error:.*)|^(.*?uncaught .*)|^(.*?cannot find.*)|^(.*?enoent.*)|^(.*?traceback.*)/im;
  const m = rx.exec(s) || (code ? null : null);
  if (!m) return;
  const c = { text: clip(String(m[0]).replace(/\s+/g, " ").trim(), 90) + (code ? " (exit " + code + ")" : ""), cmd: clip(String(cmd || ""), 40), at: Date.now() };
  DIAG = [c, ...DIAG].slice(0, 5);
  addLog(cc(CRIMSON + BOLD, " \u26a0 diag card: ") + cc(DIM, c.text + " \u00b7 /fix helps"));
  scheduleDraw();
}
function diagLines() {
  if (!DIAG.length) return [" " + cc(DIM, " no diagnostic cards (they appear for failing tool output)")];
  return DIAG.map((c, i) => " " + cc(CRIMSON, " \u26a0 card " + (i + 1) + ": ") + cc(DIM, c.text + " \u00b7 from " + c.cmd));
}
// one-shot heuristic fixer: patch common failure families ( missing npm module ), dismiss everything else with guidance
async function diagFix() {
  if (!DIAG.length) { addLog(cc(DIM, " nothing to fix \u00b7 no open diagnostic cards")); return; }
  const c = DIAG[0];
  c.tries = (c.tries || 0) + 1;
  if (c.tries > 3) {
    DIAG = DIAG.filter((x) => x !== c);
    addLog(cc(DIM, " diag card parked (3 fix attempts) \u00b7 it will not nag again"));
    scheduleDraw(true);
    return;
  }
  const mod = /cannot find module '([^']+)'/.exec(String(c.text || ""));
  if (mod && mod[1] && !/^\.|^\//.test(mod[1])) {
    const plan = "npm install " + mod[1].split("/")[0].replace(/^@/, "");
    addLog(cc(CRIMSON + BOLD, " auto-fix candidate: ") + cc(DIM, plan + " \u00b7 running it"));
    await runBash(plan, 90000, null);
    return;   // the next failing/succeeding output refreshes or clears the card
  }
  DIAG = DIAG.filter((x) => x !== c);
  addLog(cc(DIM, " card dismissed \u00b7 no heuristic matched; the failing line stays in /diag for the model"));
  scheduleDraw(true);
}

// ---- dependency radar ( fig 2 ): after a write/edit, scan who imports the file and show the fan-out on the rail
async function radarScan(fp) {
  try {
    const p = path.resolve(CWD, String(fp || ""));
    const B = path.basename(p);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile() || fs.statSync(p).size > 2000000) return;
    const readables = new Set(["js", "mjs", "cjs", "ts", "tsx", "jsx", "vue", "svelte", "py", "ps1", "c", "cc", "cpp", "h", "hpp", "cs", "go", "rs", "java", "rb", "php", "sh", "json", "md", "yml", "yaml", "toml", "html", "css", "txt", "astro"]);
    const skip = new Set(SKIP_DIRS.concat([".hydra", ".trash", "coverage", "vendor", "obj", ".gradle", ".terraform", ".pnpm-store", "site-packages", ".cache", ".svelte-kit", ".output", "__snapshots__"]));
    const hits = [];
    const t0 = Date.now();
    let filesRead = 0, partial = false;
    // BFS queue with event-loop yields: an async fn body is sync until its first await,
    // so this walk breathes between directories — the TUI (keys, redraws, streaming) never stalls
    const queue = [[CWD, "", 0]];
    while (queue.length) {
      if (hits.length >= 24) break;
      if (filesRead >= 2500 || Date.now() - t0 > 400) { partial = true; break; }
      const job = queue.shift();
      const d = job[0], rel = job[1], lvl = job[2];
      if (lvl > 12) continue;
      let names = [];
      try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of names) {
        if (hits.length >= 24) break;
        if (e.isDirectory()) { if (!skip.has(e.name)) queue.push([path.join(d, e.name), rel ? rel + "\\" + e.name : e.name, lvl + 1]); continue; }
        if (e.name === B || e.name.startsWith(".") || e.name.endsWith(".tmp")) continue;
        const ext = path.extname(e.name).slice(1).toLowerCase();
        if (!readables.has(ext)) continue;
        try { if (fs.statSync(path.join(d, e.name)).size > 512000) continue; } catch { continue; }
        filesRead++;
        try {
          const txt = fs.readFileSync(path.join(d, e.name), "utf8").slice(0, 500000);
          let li = 0, pos = 0;
          while (pos < txt.length && hits.length < 24) {
            const nl = txt.indexOf("\n", pos);
            const l = txt.slice(pos, nl === -1 ? txt.length : nl);
            if (l.includes(B)) hits.push({ tgt: (rel ? rel + "\\" : "") + e.name, line: li + 1, txt: l.trim().slice(0, 90) });
            if (nl === -1) break;
            pos = nl + 1; li++;
          }
        } catch { /* unreadable: skip file */ }
        if (Date.now() - t0 > 400 || filesRead >= 2500) { partial = true; break; }
      }
      await new Promise((r) => setImmediate(r));
    }
    hits.sort((a, b) => a.tgt.localeCompare(b.tgt));
    UI.RADAR = { n: hits.length, top: hits.slice(0, 4), file: B, at: Date.now() };
    addLog(cc(DIM, " radar fan-out: " + hits.length + " referencing " + clip(B, 24) + (partial ? " (partial scan)" : "")));
    if (hits.length) { for (const h of hits.slice(0, 3)) addLog(cc(DIM, "   \u21b3 " + clip(h.tgt + ":" + h.line, Math.max(40, UI.cols - PANEL_W - 16)) + " " + clip(h.txt, 44))); }
    else addLog(cc(DIM, "   (nothing imports " + clip(B, 20) + ")"));
  } catch (e) { addLog(cc(DIM, "   radar skipped: " + clip(String(e && e.message || e), 60))); }
  scheduleDraw(true);
}


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
let SAVE_FAIL_AT = 0;
function saveSession() {
  try {
    if (!HISTORY.length) return null;
    fs.mkdirSync(sessionsDir(), { recursive: true });
    const when = new Date().toISOString();
    const disp = CURRENT_SESSION_TITLE || sessionNameText();
    const kebab = disp.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "chat";
    const file = sessionFileTS() + "-" + kebab + ".json";
    const full = path.join(sessionsDir(), file);
    atomicWrite(full, JSON.stringify({
      when,
      name: disp,
      provider: activeProvider().name,
      model: activeProvider().model,
      cwd: CWD,
      history: HISTORY,
    }, null, 2));
    if (ACTIVE_SESSION_FILE && ACTIVE_SESSION_FILE !== file) {
      stashReplace(ACTIVE_SESSION_FILE);   // superseded file keeps a restorable copy instead of deleting it
    }
    ACTIVE_SESSION_FILE = file;
    SESSIONS_DIRTY = true;
    try { saveCheckpoint(true); } catch { /* time travel snapshot is best effort */ }
    return file;
  } catch (e) {
    const n = Date.now();
    if (!SAVE_FAIL_AT || n - SAVE_FAIL_AT > 30000) {
      SAVE_FAIL_AT = n;
      addLog(cc("\u001b[31m", " !! session save failed: " + clip(String((e && (e.code || e.message)) || e), 70)));
    }
    return null;
  }
}

// ---- time travel: every finished turn snapshots into ~/.hydra/checkpoints ( capped at 24 ), /time rewinds ----
const CHK_DIR = () => path.join(CFG_DIR, "checkpoints");
let CHK_SIG = "";
let CHK_LAST = null;
function saveCheckpoint(auto) {
  try {
    if (HISTORY.length < 2) return null;
    const last = HISTORY[HISTORY.length - 1] || {};
    const sig = HISTORY.length + "|" + String(last.content || "").slice(0, 80);
    if (auto && CHK_SIG === sig) return null;   // same content: skip ( tool-step saves don't spam the dir )
    CHK_SIG = sig;
    const name = (CURRENT_SESSION_TITLE || sessionNameText() || "chat").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "chat";
    const file = String(Date.now()).padStart(13, "0") + "-" + name + ".json";
    fs.mkdirSync(CHK_DIR(), { recursive: true });
    atomicWrite(path.join(CHK_DIR(), file), JSON.stringify({ when: new Date().toISOString(), name: CURRENT_SESSION_TITLE || name, from: ACTIVE_SESSION_FILE, history: HISTORY }, null, 2));
    restrictDir(CHK_DIR(), 24);
    CHK_LAST = file;
    addLog(cc(DIM, "  \u21bb checkpoint saved \u00b7 /time rewinds"));
    return file;
  } catch { return null; }
}
function restrictDir(dir, cap) {
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    for (const f of files.slice(0, Math.max(0, files.length - cap))) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* nop */ } }
  } catch { /* nop */ }
}
function restoreCheckpoint(file) {
  if (UI.busy) { addLog(cc(DIM, " can't rewind while a turn runs \u00b7 esc interrupts first")); return; }
  try {
    let raw = fs.readFileSync(path.join(CHK_DIR(), String(file)), "utf8");
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    const j = JSON.parse(raw);
    HISTORY = Array.isArray(j.history) ? j.history : [];
    UI.TODOS = []; UI.scroll = 0; UI.log = [];
    CTX.excl.clear(); REC.on = false; UI.TOKENS = Math.max(UI.TOKENS, 0);
    CHK_SIG = "}";
    UI.turn = Math.floor(HISTORY.length / 2);
    CURRENT_SESSION_TITLE = j.name || "";
    saveSession();
    addLog(cc(CRIMSON + BOLD, "  \u23ee time travel: rewound to ") + clip(String(j.when || "").replace("T", " ").slice(0, 19), 26) + cc(DIM, " (" + HISTORY.length + " messages)"));
    for (const m of HISTORY) {
      let c = String(m.content || "");
      if (!c.trim() || c.startsWith("[skill")) continue;
      c = c.replace(/[ \t]+/g, " ").trim();
      if (c.length > 2400) c = c.slice(0, 2400) + " \u2026";
      addLog(m.role === "user" ? cc(CRIMSON + BOLD, " \u276f " + c) : "  " + c);
    }
  } catch (e) { addLog(cc("\u001b[31m", " rewind failed: " + (e.message || e))); }
  scheduleDraw(true);
}
function openTimeDialog() {
  const items = [];
  try {
    fs.mkdirSync(CHK_DIR(), { recursive: true });
    for (const f of fs.readdirSync(CHK_DIR()).filter((f) => f.endsWith(".json")).sort().reverse()) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(CHK_DIR(), f), "utf8"));
        items.push({ value: f, name: clip(String(j.name || f), 40), when: j.when || "", turns: Math.floor(((j.history || []).length) / 2), whenISO: j.when || "" });
      } catch { items.push({ value: f, name: String(f) }); }
    }
  } catch { /* first time */ }
  updateGhost();
  if (!items.length) { addLog(cc(DIM, " no checkpoints yet \u00b7 every finished turn saves one automatically \u00b7 /time lists them")); return; }
  UI.dialog = { kind: "sessions", sel: 0, items, mode: "", buf: "", preview: [], previewFile: "", title: "time travel \u2502 \u2193\u2193 enter rewinds \u00b7 esc close", isTime: true };
  scheduleDraw(true);
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
    UI.TODOS = [];   // the checklist belongs to the previous session's work
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
    CTX.excl.clear(); CHK_SIG = ""; REC.on = false;   // new session: parked turns + macro recording + checkpoint debounce reset
    updateGhost();
  } catch (e) {
    addLog(cc("\u001b[31m", " load failed: " + (e.message || e)));
  }
  scheduleDraw(true);
}


function drawFrame() {
  if (!process.stdout.isTTY) return;
  // backpressure guard: if the console is not draining our frames, skip this one instead of flooding (opencode-style renderer discipline)
  if (process.stdout.writableLength > 98304) { scheduleDraw(); return; }
  const cols = UI.cols, rows = UI.rows;
  if (rows < 16 || cols < 56) {
    process.stdout.write(ESC + "[?25l" + ESC + "[2J" + ESC + "[H" + ESC + "[1;1H" + padRow(" terminal too small - need >=56x16 (have " + cols + "x" + rows + ")", cols));
    return;
  }
  const BODY = rows - 7;   // +1 row reserved for the composer's top border underneath the body
  const barX = cols - PANEL_W;
  const LW = barX - 1;
  const p0 = activeProvider();
  // -------- brand banner as scrollback head ( opencode style: scrolls up as chat grows )
  const COMBO = (LW >= HYDRA_MARK[0].length + 2)
    ? HYDRA_MARK.concat(WORDMARK)
    : WORDMARK;
  const scroll = [];
  const SMETA = [];   // per scroll line: { e, pi, first, last, para, boxed } or null ( banner / non-entry lines )
  for (const l of COMBO) { scroll.push(cc(CRIMSON + BOLD, centerText(l, LW))); SMETA.push(null); }
  const NOW_MS = Date.now();
  // -------- compose chat log flat lines into the same scrollback
  for (const e of UI.log) {
    if (!e.cache || e.cacheW !== LW) {
      // rebuild the entry's display cache AND its copy map ( per physical line: paragraph id, table/fence flag )
      const mdT = mdRender(e.text, LW - 1);
      const phys = mdT.split("\n");
      const paraOf = [];
      let pid = 0, sawText = false;
      for (let pi = 0; pi < phys.length; pi++) {
        if (phys[pi].trim() === "") { paraOf.push(-1); if (sawText) { pid++; sawText = false; } }
        else { paraOf.push(pid); sawText = true; }
      }
      const BOX_GLYPH = /^\s*[\u250c\u251c\u2514\u2570\u2502]/;
      const boxed = phys.map((pl) => BOX_GLYPH.test(stripAnsi(pl)));   // box rows carry a dim style prefix -> classify on the plain text
      e.cache = [];
      e.map = [];
      for (let pi = 0; pi < phys.length; pi++) {
        const ws = wrapText(phys[pi], LW - 3);
        for (let wi = 0; wi < ws.length; wi++) {
          e.map.push({ e, pi, first: wi === 0, last: wi === ws.length - 1, para: paraOf[pi], boxed: boxed[pi] });
          e.cache.push(ws[wi]);
        }
      }
      e.mdphys = phys; e.paraRange = {};
      for (let pi = 0; pi < paraOf.length; pi++) {
        const id = paraOf[pi];
        if (id >= 0) { if (e.paraRange[id]) e.paraRange[id][1] = pi; else e.paraRange[id] = [pi, pi]; }
      }
      e.cacheW = LW;
    }
    const fresh = NOW_MS - (e.t || 0) < 1500;   // brand-new rows leak in bright for a beat, then settle (log flash-in)
    let cvi = 0;
    for (const l of e.cache) {
      scroll.push(fresh && cvi === 0 ? cc(CRIMSON + BOLD, "\u258e ") + l : "  " + l);   // opencode-style: content sits 3 cols in
      SMETA.push(e.map && e.map[cvi] ? e.map[cvi] : null);
      cvi++;
    }
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
  // viewport-aligned copy map: SCRMETA[row] mirrors SMETA[scroll index] so drag selection
  // can reconstruct the ORIGINAL paragraph text instead of the visually wrapped fragments
  SCRMETA = new Array(rows).fill(null);
  for (let i = 0; i < BODY; i++) SCRMETA[2 + i] = SMETA[vStart + i] ?? null;
  SCRVSTART = vStart;
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
    + cc(DIM, "\u2502 mode ") + cc(CRIMSON + BOLD, UI.mode)
    + (SANDBOX_MODE() !== "ask" ? cc(DIM, "\u2502 ") + cc(CRIMSON + BOLD, " sandbox " + SANDBOX_MODE()) : "");
  out.push(ESC + "[1;1H" + padRow(head, cols - 1));
  SCR[0] = plainRow(head, cols - 1);
  // -------- body: scrollback window ( brand head scrolls up with chat )
  for (let i = 0; i < BODY; i++) {
    const t = scroll[vStart + i] ?? "";
    const pl = pflat[i] || "";
    out.push(ESC + "[" + (2 + i) + ";1H"
      + padRow(" " + t + " ", LW)
      + cc(DIM, "\u2562")
      + padRow(pl, PANEL_W));
    SCR[2 + i] = " " + plainRow(t, LW - 1) + " \u2562" + plainRow(pl, PANEL_W);
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
  // -------- composer box ( rows R-5 .. R-2 ): bordered two-row prompt with a live queue cue
  {
    const qN = UI.QUEUE.length;
    const bTitle = qN ? " \u276f queue " + qN + " " : " \u276f new turn ";
    // the border cap lands exactly on the wall column (barX-1) so the box and the rail line up
    const dashN = Math.max(6, barX - 4 - stripAnsi(bTitle).length);
    const top = cc(CRIMSON, "\u256D\u2500") + cc(CRIMSON + BOLD, bTitle) + cc(CRIMSON, "\u2500".repeat(dashN) + "\u256E");
    out.push(ESC + "[" + (rows - 5) + ";1H" + ESC + "[K" + top + cc(DIM, "\u2562") + padRow("", PANEL_W));
    SCR[rows - 5] = plainRow(top, barX - 1) + "\u2562";
  }
  const BAR = "\u2502";
  const inW = Math.max(0, barX - 8);
  const ip = stripAnsi(UI.input);
  const vis = ip.length > inW ? "\u2026" + ip.slice(-inW) : ip;
  const gtry = UI.GHOST && ip === stripAnsi(UI.input) ? Math.max(0, inW - ip.length) : 0;
  out.push(ESC + "[" + (rows - 4) + ";1H" + ESC + "[K" + BAR + " \u276f " + vis + (gtry > 1 ? cc(DIM, UI.GHOST.slice(0, gtry).trimEnd()) : ""));
  SCR[rows - 4] = BAR + " \u276f " + vis;
  const modelShort = clip(p0.model, Math.max(14, LW - 34));
  const line2 = BAR + " " + cc(CRIMSON + BOLD, UI.mode) + cc(DIM, " \u00b7 ") + cc(CRIMSON, modelShort) + (p0.apiKey ? "" : cc(DIM, "  (local)"));
  out.push(ESC + "[" + (rows - 3) + ";1H" + padRow(line2, barX - 2) + cc(CRIMSON, BAR) + cc(DIM, "\u2562") + padRow("", PANEL_W));
  SCR[rows - 3] = plainRow(line2, barX - 2) + "\u2502\u2562";
  // right rail edge for the composer rows ( the box's right wall doubles as the rail line )
  out.push(ESC + "[" + (rows - 4) + ";" + (barX - 1) + "H" + cc(CRIMSON, BAR) + cc(DIM, "\u2562") + padRow("", PANEL_W));
  SCR[rows - 4] = (SCR[rows - 4] + "").padEnd(barX - 2, " ") + "\u2502\u2562";
  const busy = UI.busy;
  const conf = UI_CONFIRM;
  const footL = (UI.REC.on ? cc("\u001b[31m", " \u25cf rec ") : "")
    + (conf
    ? ledOnStyles() + cc(CRIMSON + BOLD, " \u26a0 sandbox \u00b7 allow: ") + cc(DIM, clip(conf.label, Math.max(30, UI.cols - PANEL_W - 44))) + cc(CRIMSON + BOLD, "  y allow") + cc(DIM, " \u00b7 n/esc " + Math.max(0, Math.ceil(((conf.dead || Date.now() + 120000) - Date.now()) / 1000)) + "s left")
    : busy
    ? ledOnStyles() + cc(CRIMSON + BOLD, " " + SPINNER_FRAMES[UI.spinner] + " " + UI.busyLabel) + cc(DIM, " " + fmtDur(Date.now() - UI.busyStart)
      + (UI.TPS && UI.TPS.t > Date.now() - 3000 && UI.TPS.c > 40 && UI.TPS.t0 && Date.now() - UI.TPS.t0 > 1200 ? " \u00b7 " + Math.round(UI.TPS.c / Math.max(0.4, (UI.TPS.t - UI.TPS.t0) / 1000)) + " c/s" : "")
      + (Date.now() - UI.busyStart > 12000 ? " \u00b7 still working" : "") + " \u00b7 esc interrupt")
    : " " + ledOff + cc(DIM, CWD));
  let footR = busy ? (PENDING
    ? cc(CRIMSON + BOLD, " \u23f3 switching to \u201c" + clip(PENDING_NAME || "", 26) + "\u201d after this reply ")
    : (UI.QUEUE.length ? cc(DIM, " \u23f3 " + UI.QUEUE.length + " queued \u00b7 ") : "") + cc(DIM, "esc interrupt \u00b7 tok " + UI.TOKENS + " \u00b7 ctx " + ctxK() + " "))
    : (UI.scroll > 0
    ? cc(CRIMSON + BOLD, " \u2191 " + UI.scroll + " (pgup/pgdn ") + cc(DIM, "\u00b7 type to return ")
    : (ctxTokens() > 90000
    ? cc(CRIMSON + BOLD, " ctx " + ctxK() + " filling \u00b7 /clear? ") + cc(DIM, "\u00b7 turn " + UI.turn + " ")
    : cc(DIM, " / commands \u00b7 enter send \u00b7 turn " + UI.turn + " \u00b7 tok " + UI.TOKENS + " \u00b7 ctx " + ctxK() + " ")));
  out.push(ESC + "[" + (rows - 2) + ";1H" + padRow(footL, barX - stripAnsi(footR).length - 1) + footR + cc(DIM, "\u2562") + padRow("", PANEL_W));
  SCR[rows - 2] = plainRow(footL, barX - stripAnsi(footR).length - 1) + stripAnsi(footR) + "\u2562";
  // -------- toast card ( notification that floats over the last body row, spinner-ticking until it fades )
  if (UI.TOAST && UI.TOAST.until > NOW_MS && rows >= 16) {
    const tLabel = cc(CRIMSONBG, " " + SPINNER_FRAMES[UI.spinner % SPINNER_FRAMES.length] + " ") + cc(CRIMSON + BOLD, " " + clip(UI.TOAST.text, Math.max(20, barX - 10)) + " ");
    const tW = stripAnsi(tLabel).length;
    out.push(ESC + "[" + (rows - 6) + ";" + Math.max(1, barX - tW - 1) + "H" + tLabel);
    SCR[rows - 6] = (SCR[rows - 6] || "").slice(0, Math.max(0, barX - tW - 2)) + plainRow(tLabel, tW);
  }
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
  const curCol = 6 + Math.min(stripAnsi(UI.input).length, inW);
  out.push(ESC + "[" + (rows - 4) + ";" + clamp(curCol, 6, Math.max(6, barX - 2)) + "H" + ESC + "[?25h");
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
function closePopup() { UI.popupOpen = false; UI.popupTitle = ""; UI.popupItems = []; UI.popupSel = 0; scheduleDraw(); }
function openCtxPicker() {
  const xs = boardExchanges();
  if (!xs.length) { addLog(cc(DIM, " nothing to park yet \u00b7 say something first")); return; }
  openPopup("ctx \u2502 enter parks / unparks \u00b7 esc close",
    xs.slice().reverse().map((x) => ({ label: clip((x.parked ? "PARKED\u00a0\u00a0\u00a0 " : "on\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0 ") + "turn " + x.turn, 34), desc: " " + x.head + (x.parked ? " (enter restores)" : ""), value: x.i })));
}

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
  const p = activeProvider();
  openPopup("model \u2502 /model <n|name>",
    lastModels.map((m, i) => ({ label: m, desc: m === p.model ? " active" : "", value: i })));
  const hadBusy = UI.busy;   // a running turn owns the busy spinner - a model list refresh must never steal or clear it
  try {
    const before = lastModels.slice();
    await fetchModels(6000);
    if (UI.popupOpen && String(UI.popupTitle || "").startsWith("model")) {
      if (lastModels.join("\u0000") !== before.join("\u0000")) {
        const p2 = activeProvider();
        UI.popupItems = lastModels.map((m, i) => ({ label: m, desc: m === p2.model ? " active" : "", value: i }));
        UI.popupSel = 0; scheduleDraw();
      }
    } else {
      if (lastModels.join("\u0000") !== before.join("\u0000") && !hadBusy) scheduleDraw();
    }
  } catch (e) {
    if (!hadBusy) { addLog(cc("\u001b[31m", " model fetch failed: " + (e.message || e))); scheduleDraw(); }
  }
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
const spinnerTimer = setInterval(() => {
  const tn = Date.now();
  if (UI.TOAST && UI.TOAST.until <= tn) UI.TOAST = null;   // toast fades itself out
  if (UI.busy) UI.spinner = (UI.spinner + 1) % SPINNER_FRAMES.length;
  if (UI.busy || UI.TOAST) scheduleDraw();
}, 120);
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
    if (UI.popupOpen && popupKind() === "custom") { providerPickModels(); return; }
  if (UI.popupOpen && popupKind() === "model") {
    const it = UI.popupItems[UI.popupSel];
    closePopup(); setUserInput("");
    if (it) { startBusy("switching model"); try { addLogLines(await modelUseLines(String(it.value + 1))); } catch (e) { addLog(cc("\u001b[31m", " error: " + e.message)); } stopBusy(); }
    return;
  }
  if (UI.popupOpen && popupKind() === "provider") {
    const it = UI.popupItems[UI.popupSel];
    closePopup(); setUserInput("");
    if (it && it.value === "pastekey") { startPasteKeyCapture(); return; }
    if (it && it.value === "other") { startCustomProvider(); return; }
    if (it) addLogLines(providerUseLines(it.value));
    return;
  }
  if (UI.popupOpen && popupKind() === "skills") {
    const it = UI.popupItems[UI.popupSel];
    closePopup(); setUserInput("");
    if (it) injectSkillValue(it.value);
    return;
  }
  if (UI.popupOpen && UI.popupTitle === "slash") {
    const itq = UI.popupItems[UI.popupSel];
    if (itq && stripAnsi(itq.value) === stripAnsi(q)) { closePopup(); } // exact command -> fall through and execute
    else if (itq && stripAnsi(itq.label).startsWith(q)) { setUserInput((itq.value || stripAnsi(itq.label)).trim() + " "); return; }
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
  if (q === "/undo") { undoTurn(); return; }
  if (q === "/regen") { await regenLast(); return; }
  if (q === "/stats") { addLogLines(statsLines()); return; }
  if (q.startsWith("/web")) {
    try { addLogLines(await webInjectLines(q.replace("/web", "").trim())); } catch (e) { addLog(cc("\u001b[31m", " error: " + (e.message || e))); }
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
    CTX.excl.clear(); UI.TOKENS = 0; REC.on = false; DIAG = [];
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
    CTX.excl.clear(); UI.TOKENS = 0; REC.on = false;
    addLog(cc(CRIMSON + BOLD, "  + new session \u00b7 context cleared, files untouched"));
    return;
  }
  if (q === "/copylast") { copyLastReply(); return; }
  if (q === "/skills") {
    const s = listSkillDirs();
    if (!s.length) { addLog(cc(DIM, " no skills found in " + skillDirsLL().join(" ") + " \u00b7 say \u201ccreate a skill \u2026\u201d and hydra writes one itself")); return; }
    openPopup("skills \u2502 " + s.length + " installed \u2502 enter injects", s.slice(0, 40).map((x, i) => ({ label: x.name, desc: " " + (x.description || "inject the full body"), value: i })));
    return;
  }
  if (q.startsWith("/skill-del ")) {
    const slug = safeSkillName(q.replace("/skill-del", "").trim());
    if (!slug) { addLog(cc(DIM, " /skill-del <name> \u00b7 deletes a hydra skill (stashed into .trash first)")); return; }
    const dir = path.join(CFG_DIR, "skills", slug);
    const file = path.join(dir, "SKILL.md");
    if (!fs.existsSync(file)) { addLog(cc(DIM, " no hydra skill named \u201c" + slug + "\u201d (external skills live in " + skillDirsLL().slice(1).join(" ") + ")")); return; }
    try {
      fs.mkdirSync(SKILL_TRASH(), { recursive: true });
      const stash = String(Date.now()).padStart(13, "0") + "-" + slug;
      fs.renameSync(dir, path.join(SKILL_TRASH(), stash));
      addLog(cc(DIM, " stashed skill \u201c" + slug + "\u201d into .trash (" + stash + ")"));
    } catch (e) { addLog(cc("\u001b[31m", " delete failed: " + (e.message || e))); }
    scheduleDraw(true);
    return;
  }
  if (q.startsWith("/skills-safe")) {
    const arg = q.replace("/skills-safe", "").trim();
    CFG.skills_safe = arg === "off" ? false : arg === "on" ? true : !CFG.skills_safe;
    saveCfg();
    addLog(cc(CRIMSON + BOLD, " skills_safe -> " + (CFG.skills_safe ? "on" : "off")) + cc(DIM, " \u00b7 on = hydra asks before the agent write/edit/delete any skill"));
    return;
  }
  if (q.startsWith("/sandbox")) {
    const arg = q.replace("/sandbox", "").trim().toLowerCase();
    if (!["ask", "strict", "open"].includes(arg)) { addLog(cc(DIM, " /sandbox ask|strict|open \u00b7 current: ") + cc(CRIMSON + BOLD, SANDBOX_MODE()) + cc(DIM, " \u00b7 ask = confirm risky commands \u00b7 strict = confirm every command \u00b7 open = run all")); return; }
    CFG.sandbox = arg; saveCfg();
    addLog(cc(CRIMSON + BOLD, " sandbox -> " + arg));
    return;
  }
  if (q.startsWith("/memory")) {
    const arg = q.replace("/memory", "").trim();
    if (arg === "clear" || arg === "wipe") {
      try { fs.unlinkSync(MEM_MD); addLog(cc(DIM, " memory cleared")); } catch { addLog(cc(DIM, " memory was already empty")); }
      scheduleDraw(true); return;
    }
    const mem = readMemoryLines(20);
    if (!mem.length) { addLog(cc(DIM, " memory is empty \u00b7 the agent saves facts it learns with memory_write \u00b7 tell it \u201cremember: \u2026\u201d")); return; }
    addLogLines([" memory.md (persisted facts):", ...mem.map((l) => cc(DIM, "   " + l))]);
    return;
  }
  if (q.startsWith("/learn")) {
    const src = q.replace("/learn", "").trim();
    if (!src) { addLog(cc(DIM, " /learn <text|url|path> \u00b7 turns reference material into a reusable skill (the agent distills and saves it)")); return; }
    let material = src;
    const mUrl = src.match(/^https?:\/\//i);
    try {
      if (mUrl) {
        addLog(cc(DIM, " fetching " + src));
        const lines = await webInjectLines(src);
        const glued = lines.map((l) => stripAnsi(l)).join("\n");
        material = glued;
      } else if (fs.existsSync(path.resolve(CWD, src)) && fs.statSync(path.resolve(CWD, src)).isFile()) {
        material = fs.readFileSync(path.resolve(CWD, src), "utf8").slice(0, 60000);
        material = "FILE: " + path.resolve(CWD, src) + "\n\n" + material;
      }
    } catch (e) { addLog(cc("\u001b[31m", " /learn source failed: " + (e.message || e))); return; }
    const learnQ = "Turn the following material into a reusable skill. Distill it: synthesize frameworks, definitions, decision rules, steps and anti-patterns in your own words - NEVER copy long passages. Choose a kebab-case skill name matching the topic, write a one-line description, and save it with skill_write. If a skill with that name likely already exists, still do skill_write (it overwrites cleanly). Reply after saving with just the skill name and one line on when to use it.\n\n--- BEGIN MATERIAL ---\n" + material.slice(0, 50000) + "\n--- END MATERIAL ---";
    addLog(cc(CRIMSON + BOLD, " learn: distilling into a skill"));
    await runAgentTurn(learnQ);
    return;
  }
  if (q.startsWith("/hub")) {
    let catalog = null;
    try {
      const raw = await fetchText(HUB_URL, 12000);
      const j = JSON.parse(raw.replace(/^\uFEFF/, ""));
      catalog = (Array.isArray(j) ? j : j.skills || []).map((x) => typeof x === "string" ? { name: x, description: "" } : { name: String(x.name || ""), description: String(x.description || ""), path: String(x.path || "") }).filter((x) => x.name);
    } catch (e) {
      addLog(cc("\u001b[31m", " hub fetch failed: " + (e.message || e) + cc(DIM, " \u00b7 set HYDRA_HUB_URL to override")));
      return;
    }
    if (!catalog.length) { addLog(cc(DIM, " hub is empty right now")); return; }
    HUB_CATALOG = catalog;
    openPopup("hub \u2502 " + catalog.length + " in catalog \u2502 enter installs \u00b7 secret scan at install", catalog.slice(0, 40).map((x, i) => ({ label: x.name, desc: " " + (x.description || "install from the hub"), value: i })));
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
      atomicWrite(path.join(sessionsDir(), file), JSON.stringify({
        when: new Date().toISOString(), name, provider: activeProvider().name, model: activeProvider().model, cwd: CWD, history: hist,
      }, null, 2));
      SESSIONS_DIRTY = true;
      loadSessionFile(file);
    } catch (e) { addLog(cc("\u001b[31m", " fork failed: " + (e.message || e))); }
    return;
  }
  if (q === "/zone" || q === "/rules") {
    addLogLines(zoneLines());
    return;
  }
  if (q === "/ctx" || q.startsWith("/ctx ")) {
    openCtxPicker();
    return;
  }
  if (q.startsWith("/purge")) {
    purgeStale(q.replace("/purge", "").trim());
    return;
  }
  if (q === "/time" || q.startsWith("/time ")) {
    openTimeDialog();
    return;
  }
  if (q === "/rec") { if (REC.on) recStop(); else recStart(); return; }
  if (q.startsWith("/rec ")) {
    const a = q.replace("/rec", "").trim();
    if (a === "start") recStart();
    else recStop(a);
    return;
  }
  if (q.startsWith("/macro ")) { await macroRun(q.replace("/macro", "").trim()); return; }
  if (q === "/macro") { addLog(cc(DIM, " /macro <name> \u00b7 replays a recorded macro skill \u00b7 ctrl+r records steps, /rec compiles them")); return; }
  if (q === "/diag") { addLogLines(diagLines()); return; }
  if (q === "/fix") { await diagFix(); return; }
  if (q === "/lane" || q.startsWith("/lane ")) {
    if (UI.LANES.abort) { laneStop(); return; }
    await laneStart(q.replace("/lane", "").trim());
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
      atomicWrite(path.join(sessionsDir(), newPath), JSON.stringify(j, null, 2));
      if (newPath !== String(ACTIVE_SESSION_FILE)) stashReplace(ACTIVE_SESSION_FILE);   // pre-rename copy lands in .trash
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
      const r = await runShellAsync(cmd, CWD, 600000);
      const outl = ((r.stdout || "") + (r.stderr ? "\n[stderr] " + r.stderr : "")).trim().split(/\r?\n/);
      for (const l of outl.slice(-40)) addLog(cc(DIM, "  " + l));
      if (r.status) addLog(cc("\u001b[31m", "  exit " + r.status));
    } catch (e) { addLog(cc("\u001b[31m", " " + (e.message || e))); }
    return;
  }
  PROMPT_HIST.push(q); HIST_IDX = -1;
  UI.turn++;
  addLog(cc(CRIMSON + BOLD, " \u276f ") + q);
  await runAgentTurn(inlineAttach(q));
}

async function runAgentTurn(q, extraSystem) {
  const provider = activeProvider();
  const plan = UI.mode === "Plan";
  // hermes-style trigger: if the first word IS an installed skill name, its body is already in context
  if (!extraSystem) {
    const first = String(q || "").split(/\s+/)[0].replace(/[^\w-]/g, "").toLowerCase();
    if (first.length >= 2) {
      const body = readSkillBody(first, 8000);
      if (body) {
        extraSystem = "[skill guide: " + first + " \u00b7 loaded automatically because the user asked by name]\n" + body;
        addLog(cc(CRIMSON + BOLD, " \u2726 skill guide: ") + first + cc(DIM, " \u00b7 loaded automatically by name"));
      }
    }
  }
  const t0 = TOOL_CALLS_TOTAL;
  let streamed = "";
  let curLog = null;
  let outcome = "no reply";
  ABORT = new AbortController();
  startBusy(plan ? "Planning" : "Building");
  try {
    await agentLoop(q, provider, (t) => {
      streamed += t;
      UI.TPS = { c: stripAnsi(streamed).length, t: Date.now(), t0: UI.busyStart };   // telemetry: streaming chars/s ( footer )
      // single path: the entry keeps the RAW markdown and the drawer renders it every frame —
      // tables align live while rows stream in, instead of a wrapped garble being finalized after
      if (curLog) { curLog.cache = null; curLog.text = streamed; }
      else { addLog(streamed); curLog = UI.log[UI.log.length - 1]; }
      scheduleDraw();
    }, (tool) => {
      addLog(cc(CRIMSON, "  > ") + cc(DIM, truncateLine(tool, Math.max(30, UI.cols - PANEL_W - 4))));
      curLog = null; streamed = "";
      scheduleDraw();
    }, HISTORY, ABORT.signal, plan, extraSystem);
    if (plan) addLog(cc(DIM, "  (plan mode - no tools were run)"));
    if (!streamed.trim() && ABORT.signal.aborted) { addLog(cc(DIM, " interrupted")); outcome = "interrupted"; }
    else if (streamed.trim()) {
      outcome = "replied " + stripAnsi(streamed).length + " chars";
      if (curLog) { curLog.text = streamed; curLog.cache = null; }   // fold the real markdown source back in: the drawer renders tables/headers/bold from it
      addLog(cc(DIM, "  \u23f1 " + fmtDur(Date.now() - UI.busyStart) + " \u00b7 " + stripAnsi(streamed).length + " chars \u00b7 turn done"));
    }
  } catch (e) {
    const timedOut = e.name === "TimeoutError" || /timed out|aborted due to timeout/.test(e.message || "");
    outcome = e.name === "AbortError" ? "interrupted" : timedOut ? "model timed out" : "turn error";
    const msg = e.name === "AbortError" ? "interrupted" : timedOut ? "model timed out \u00b7 " + Math.round(MODEL_IDLE / 1000) + "s went by with no stream data (elapsed " + fmtDur(Date.now() - UI.busyStart) + ") \u00b7 provider \u201c" + provider.name + "\u201d went silent \u00b7 esc interrupts too \u00b7 HYDRA_MODEL_IDLE tunes this (streaming replies have no wall-clock limit)" : (e.message || String(e));
    addLog(cc(e.name === "AbortError" ? DIM : timedOut ? "\u001b[33m" : "\u001b[31m", " " + msg));
    if (/model.*not.*found|invalid model|model_id|http 404\b/i.test(e.message || "")) addLog(cc(DIM, " the provider didn't take that model id \u00b7 /model opens the live list for this provider \u00b7 /provider use <name> flips back"));
    if (HISTORY[HISTORY.length - 1]?.content !== q) HISTORY.push({ role: "user", content: q });
  }
  stopBusy();
  ABORT = null;
  if (Date.now() - (UI.busyStart || 0) > 8000 && process.stdout.isTTY) { try { process.stdout.write("\u0007"); } catch { /* nop */ } }
  saveSession();
  appendLearning(q, TOOL_CALLS_TOTAL - t0, outcome.slice(0, 200));
  genSessionTitle().catch(() => { /* best-effort */ });
  if (PENDING) {
    const f = PENDING;
    PENDING = null; PENDING_NAME = "";
    addLog(cc(CRIMSON + BOLD, " turn finished \u00b7 applying the queued session switch \u2193"));
    loadSessionFile(f);
    return;
  }
  if (UI.QUEUE.length) {
    const nq = UI.QUEUE.shift();
    addLog(cc(CRIMSON + BOLD, " \u25b6 running queued prompt: ") + clip(nq, 70));
    runAgentTurn(inlineAttach(nq)).catch((e) => { addLog(cc("\u001b[31m", " " + (e.message || e))); });
  }
}
let running = true; void running;


// ------------------------------------------------------------
//  keys + sessions + entry
// ------------------------------------------------------------
let MOUSE_FRAG = false;
let PASTE_BUF = null;   // != null while a bracketed paste is being accumulated
let MOUSE_BUF = "";
let MOUSE_LEG = false;   // legacy ESC[M byte grammar ( conhost/older consoles ) vs SGR ESC[<
let CLICK_ROW = null;   // press target while using the mouse in dialogs/popups
let SELECTION = null;   // {a:{r,c}, b:{r,c}} in screen cells while dragging
let SCR = [];           // plain-text snapshot of the last frame (for drag-select copy)
let SCRMETA = [];       // viewport-aligned line meta ( entry + physical line + para id ) for paragraph-aware copy
let SCRVSTART = 0;

function plainRow(text, width) {
  const p = stripAnsi(text);
  return p.length > width ? p.slice(0, width) : p + " ".repeat(width - p.length);
}
// the visible text of one screen row up to the panel seam, with styles AND decorations stripped ( copy must be clean text )
function chunkText(r) {
  let L = stripAnsi(SCR[r] || "");
  const seam = L.indexOf("\u2562");
  if (seam >= 0) L = L.slice(0, seam);
  L = L.replace(/^[ \t]*\u258e /, " ");
  L = L.replace(/^[ \t]*\u276f /, " ");
  return L.trim();
}
const mdBoxedLine = (s) => /^\s*[\u250c\u251c\u2514\u2570\u2502]/.test(String(s));
// rejoin wrapped chunks of one source paragraph: prose lines glue with spaces, table/fence rows stay boxed with \n ( styles stripped )
function mdJoinPhys(phys, i0, i1) {
  let out = "", cur = "";
  for (let i = i0; i <= i1; i++) {
    const t = stripAnsi(String(phys[i] ?? "")).trim();
    if (!t) continue;
    if (mdBoxedLine(t)) { if (cur) { out += (out ? "\n" : "") + cur; cur = ""; } out += (out ? "\n" : "") + t; }
    else cur += (cur ? " " : "") + t;
  }
  if (cur) out += (out ? "\n" : "") + cur;
  return out;
}
function selectionText(sel) {
  if (!sel) return "";
  const r0 = Math.min(sel.a.r, sel.b.r), r1 = Math.max(sel.a.r, sel.b.r);
  if (r0 === r1) {   // single-row: precise column slice, never reaching into the rail seam
    const L = stripAnsi(SCR[r0] || "");   // visible coordinates are plain-text positions -> strip styles BEFORE slicing
    const seam = L.indexOf("\u2562");
    const hardEnd = seam >= 0 ? seam : L.length;
    const c0 = Math.min(Math.min(sel.a.c, sel.b.c), hardEnd);
    const c1 = Math.min(Math.max(sel.a.c, sel.b.c), hardEnd - 1);
    const t = L.slice(Math.max(0, c0), c1 + 1).replace(/[ \t]+$/, "").trim();
    return t.replace(/^[ \t]*\u258e /, "").replace(/^[ \t]*\u276f /, "");
  }
  // multi-row: rebuild paragraphs from the copy map — wrapped fragments glue back into whole lines
  const parts = [];
  let cur = "", curCtx = null;
  const flush = () => { if (cur.trim() !== "") parts.push(cur.replace(/[ \t]+$/, "")); cur = ""; curCtx = null; };
  for (let r = r0; r <= r1; r++) {
    const t = chunkText(r);
    const m = SCRMETA[r];
    if (!t) { flush(); continue; }
    if (cur === "") { cur = t; curCtx = { e: m && m.e, pi: m && m.pi, para: m && m.para, boxed: !!(m && m.boxed) }; continue; }
    const glue = curCtx && m && curCtx.e === m.e && curCtx.para >= 0 && m.para === curCtx.para && !curCtx.boxed && !m.boxed;
    if (glue) cur += " " + t;
    else { flush(); cur = t; curCtx = { e: m && m.e, pi: m && m.pi, para: m && m.para, boxed: !!(m && m.boxed) }; }
  }
  flush();
  return parts.join("\n");
}
function copyLastReply() {
  const lu = [...HISTORY].reverse().find((m) => m.role === "assistant");
  if (!lu) { addLog(cc(DIM, " nothing to copy yet")); return; }
  const txt = String(lu.content || "").slice(0, 100000);
  copyToClipboard(txt);
  addLog(cc(DIM, " \u2398 last reply copied to clipboard (" + txt.length + " chars)"));
  toast("reply copied \u00b7 " + txt.length + " chars");
}
function copyToClipboard(txt) {
  // fire-and-forget async spawn: the clipboard request can never stall the frame loop
  try {
    const b64 = Buffer.from(txt, "utf8").toString("base64");
    process.stdout.write(ESC + "]52;c;" + b64 + ESC + "\\");
    if (process.env.HYDRA_TEST) return;   // test rigs never touch the host clipboard
    runShellAsync("Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64 + "')))", CWD, 3000).catch(() => { /* nop */ });
  } catch { /* nop */ }
}
// one mouse core for both grammars ( SGR ESC[< and legacy ESC[M ): btn 0/32 = press/drag, 64/65 = wheel, rel = button-up
function mouseAction(btn, mx, my, rel) {
  try {
    const dlg = UI.dialog, pop = UI.popupOpen && UI.popupItems.length;
    if (rel && btn >= 64) return;                       // wheel-up never behaves like a release
    if (btn === 64 || btn === 65) {                     // wheel
      const up = btn === 64;
      if (pop) { UI.popupSel = clamp(UI.popupSel + (up ? -1 : 1), 0, UI.popupItems.length - 1); scheduleDraw(); }
      else if (dlg) { dlg.sel = clamp(dlg.sel + (up ? -1 : 1), 0, Math.max(0, dlg.items.length - 1)); syncDialogPreview(); scheduleDraw(true); }
      else nudgeScroll(up ? 3 : -3);
    } else if (!rel && btn === 0) {                       // left press
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
    } else if (!rel && btn === 32) {                      // drag
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
    } else if (rel) {                                     // release
      if (SELECTION) {
        const clickOnly = SELECTION.a.r === SELECTION.b.r && SELECTION.a.c === SELECTION.b.c;
        if (clickOnly) SELECTION = null;   // a plain click clears the highlight, exactly like a browser
        // a drag keeps the paint ( highlight stays up ): ctrl+shift+c then copies it
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
  } catch (e) { crashLog(e); }
}
function onKey(str, key) {
  try {
    if (SPLASH) {
      skipSplash();
      // the character a keg hunter types the instant the splash is up must land in the box, not vanish
      const printable = str && str.length === 1 && !(key && key.ctrl) && !(key && key.meta) && /^[ -~\u00a0-\u024f\u2000-\u30ff]$/.test(str);
      if (!printable) return;
    }
    // ---- bracketed paste ( terminals send [200~..[201~ around a paste ): accumulate instead of
    // letting every interior \r submit a separate turn; the block lands in the composer as one text
    if (key && (key.name === "paste-start" || key.code === "[200~")) { PASTE_BUF = ""; return; }
    if (PASTE_BUF !== null) {
      if (key && (key.name === "paste-end" || key.code === "[201~")) {
        let t = String(PASTE_BUF || "").replace(/\r\n?/g, "\n").replace(/\n+$/, "");
        PASTE_BUF = null;
        if (t.trim()) {
          t = t.replace(/[ \t]*\n[ \t]*/g, " ");
          setUserInput(UI.input + (UI.input && !/[\s.]$/.test(UI.input) ? " " : "") + t);
          addLog(cc(DIM, "  \u2328 pasted " + t.length + " chars into the prompt \u00b7 enter runs it"));
          scheduleDraw(true);
        }
      } else if (key && (key.name === "escape" || (key.ctrl && key.name === "c"))) {
        PASTE_BUF = null;   // paste cancelled / abort
        toast("paste cancelled");
      } else if (key && (key.name === "return" || key.name === "enter")) PASTE_BUF += "\n";
      else if (key && key.name === "backspace" && PASTE_BUF.length) PASTE_BUF = PASTE_BUF.slice(0, -1);
      else if (str && str.length === 1) PASTE_BUF += str;
      if (PASTE_BUF !== null && PASTE_BUF.length > 100000) PASTE_BUF = PASTE_BUF.slice(-100000);   // runaway guard
      return;
    }
    // SGR mouse bursts arrive fragmented by readline: ESC[< + digits + M/m ; legacy consoles: ESC[M + 3 raw bytes
    if (key && (key.code === "[<" || key.code === "[M")) { MOUSE_FRAG = true; MOUSE_BUF = ""; MOUSE_LEG = key.code === "[M"; return; }
    if (MOUSE_FRAG) {
      if (MOUSE_LEG) {
        if (str && str.length === 1) MOUSE_BUF += str;
        if (MOUSE_BUF.length >= 3) {
          const cb = MOUSE_BUF.charCodeAt(0) - 32;
          const mx = clamp(MOUSE_BUF.charCodeAt(1) - 33, 0, UI.cols - 1);
          const my = clamp(MOUSE_BUF.charCodeAt(2) - 33, 0, UI.rows - 1);
          MOUSE_FRAG = false; MOUSE_LEG = false; MOUSE_BUF = "";
          mouseAction(cb & 63, mx, my, (cb & 3) === 3);
        }
        return;
      }
      if (/^[0-9;]$/.test(str || "")) { MOUSE_BUF += str; return; }
      if (str === "M" || str === "m") {
        const ps = MOUSE_BUF.split(";").map((n) => parseInt(n, 10) || 0);
        const btn = ps[0] || 0, mx = (ps[1] || 1) - 1, my = (ps[2] || 1) - 1;
        MOUSE_FRAG = false; MOUSE_BUF = "";
        mouseAction(btn, mx, my, str === "m");
      }
      return;
    }
    if (key && key.ctrl && key.shift && key.name === "c") {   // ctrl+shift+c: browser-style copy of the painted selection
      if (SELECTION) {
        const txt = selectionText(SELECTION);
        if (txt) { copyToClipboard(txt); toast("copied selection \u00b7 " + txt.length + " chars"); }
        else toast("selection is empty \u00b7 drag across text first");
        fullDraw = true; scheduleDraw(true);
      } else toast("drag to select text \u00b7 ctrl+shift+c copies \u00b7 alt+c copies the last reply");
      return;
    }
    if (key && (key.alt || key.meta) && key.name === "c") { copyLastReply(); return; }   // alt+c: one stroke copies the whole last reply ( Node gives ESC-key as meta, not alt )
    if (key.ctrl && key.name === "a") {
      // select-all copy: the plain-text screen snapshot goes to the clipboard in one stroke
      const all = (SCR || []).slice(0, Math.max(1, UI.rows - 2)).map((l) => stripAnsi(l)).join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n+$/g, "");
      if (all.trim()) { copyToClipboard(all); toast("copied whole screen \u00b7 " + all.length + " chars"); }
      return;
    }
    if (key.ctrl && key.name === "c") {
      if (SELECTION) {
        const sel = SELECTION; SELECTION = null;
        const txt = selectionText(sel);
        if (txt) { copyToClipboard(txt); toast("copied " + txt.split("\n").length + " lines \u00b7 " + txt.length + " chars"); }
        fullDraw = true; scheduleDraw(true);
        return;
      }
      if (UI.input) { setUserInput(""); toast("prompt cleared \u00b7 ctrl+c again to exit"); return; }
      const now = Date.now();
      if (UI.CC_TS && now - UI.CC_TS < 1600) { saveSession(); process.exit(0); }
      UI.CC_TS = now;
      toast("ctrl+c again to exit");
      return;
    }
    if (key.ctrl && key.name === "p") { openGovernPicker(); return; }   // fig 5: the context-govern picker replaces the tab-duplicated build/plan toggle
    if (key.ctrl && key.name === "g") { openCtxPicker(); return; }      // fast park picker ( same as /ctx )
    if (key.ctrl && key.name === "r") { if (REC.on) recStop(); else recStart(); return; }   // macro record/compile
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
    // ---- sandbox y/n confirm wins over everything except the custom capture
    if (UI_CONFIRM) {
      const cfr = UI_CONFIRM;
      if (str === "y" || str === "Y") { cfr.resolve(true); scheduleDraw(true); return; }
      if (str === "n" || str === "N" || key.name === "escape" || key.name === "backspace") { cfr.resolve(false); scheduleDraw(true); return; }
      if (key.name === "pageup" || key.name === "pagedown") { /* scrolling during a confirm stays available */ }
      else return;   // modal: y/n/esc only while the question is pending
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
          if (d.isTime) { restoreCheckpoint(it.value); return; }
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
        if (SELECTION) { SELECTION = null; fullDraw = true; scheduleDraw(true); return; }   // esc first legally clears a drag selection
        if (UI.LANES.abort) { laneStop(); if (!UI.popupOpen) return; }
        if (UI.popupOpen) { closePopup(); if (UI.input.startsWith("/")) setUserInput(""); }
        else if (ABORT) { try { ABORT.abort(); } catch { /* nop */ } }
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        const cmd = UI.input.trim();
        const pk = popupKind();
        // read-only commands are allowed while a turn runs (sessions browsing must never be blocked)
        if (UI.popupOpen && pk !== "slash" && pk !== "custom" && pk !== "model" && pk !== "provider") { popupActivate(); return; }
        if ((UI.popupOpen && !cmd) || /^(\/(sessions|resume|help|mcp|mcps?|copylast|cd|export|rename|provider|model|fork|search|theme|key|undo|regen|web|stats|ctx|time|zone|rules|diag|lane)\b)/.test(cmd)) {
          submitLine().catch((e) => { addLog(cc("\u001b[31m", " " + (e.message || e))); scheduleDraw(); });
          return;
        }
        if (cmd && !cmd.startsWith("/")) {
          // ai-cli style queueing: the prompt waits for the running turn and runs right after it
          if (UI.QUEUE.length >= 12) UI.QUEUE.shift();
          UI.QUEUE.push(cmd);
          setUserInput("");
          addLog(cc(DIM, " \u23f3 queued for after this reply: ") + clip(cmd, 64));
          scheduleDraw(true);
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
      if (SELECTION) { SELECTION = null; fullDraw = true; scheduleDraw(true); return; }
      if (UI.LANES.abort) { laneStop(); return; }   // idle esc also ends a running lane
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
      if (UI.GHOST && !UI.popupOpen) {   // ghost-write: tab accepts the suggested completion
        const got = UI.GHOST;
        setUserInput(UI.input + got);
        UI.GHOST = "";
        addLog(cc(DIM, " \u21e5 ghost accepted \u00b7 +" + got.trim().length + " chars"));
        return;
      }
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
  process.on("exit", () => { try { saveSession(); process.stdout.write(ESC + "[?25h" + ESC + "[?1000l" + ESC + "[?1006l" + ESC + "[?2004l" + ESC + "[?1049l"); } catch { /* nop */ } });
  // wrap the key handler: a throw from ANY weird key/mouse event used to bubble out uncaught and
  // kill the whole app mid-task ( crashes ARE a way the "model stops in between" ) — now the app
  // logs it and keeps going. the exit handler also restores the 1002 mouse mode we switched on.
  process.stdin.on("keypress", (s, k) => { try { onKey(s, k); } catch (e) { crashLog(e); scheduleDraw(); } });
  process.stdin.on("error", () => { /* nop */ });
  process.on("SIGINT", () => process.exit(0));
  process.on("exit", () => { try { saveSession(); process.stdout.write(ESC + "[?25h" + ESC + "[?1000l" + ESC + "[?1002l" + ESC + "[?1006l" + ESC + "[?2004l" + ESC + "[?1049l"); } catch { /* nop */ } });
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
        (await modelUseLines(q.replace("/model", "").trim())).forEach((l) => console.log(stripAnsi(l)));
      } else if (q.startsWith("/cd")) {
        const arg = q.replace("/cd", "").trim();
        if (arg) { process.chdir(path.resolve(CWD, arg)); CWD = process.cwd(); console.log("cwd -> " + CWD); }
        else console.log("cwd: " + CWD);
      } else if (q === "/mode") { UI.mode = UI.mode === "Build" ? "Plan" : "Build"; console.log("mode -> " + UI.mode); }
      else if (q === "/clear") { HISTORY = []; console.log("context cleared"); }
      else if (q.startsWith("/memory")) {
        if (/^clear|wipe$/.test(q.replace("/memory", "").trim())) { try { fs.unlinkSync(MEM_MD); console.log("memory cleared"); } catch { console.log("memory was already empty"); } }
        else { const mem = readMemoryLines(20); console.log(mem.length ? mem.map((l) => "  " + l).join("\n") : "memory is empty"); }
      }
      else if (q.startsWith("/sandbox")) {
        const arg = q.replace("/sandbox", "").trim().toLowerCase();
        if (["ask", "strict", "open"].includes(arg)) { CFG.sandbox = arg; saveCfg(); console.log("sandbox -> " + arg); }
        else console.log("sandbox: " + SANDBOX_MODE() + " (/sandbox ask|strict|open)");
      }
      else if (q.startsWith("/skills-safe")) {
        const arg = q.replace("/skills-safe", "").trim();
        CFG.skills_safe = arg === "off" ? false : arg === "on" ? true : !CFG.skills_safe;
        saveCfg(); console.log("skills_safe -> " + (CFG.skills_safe ? "on" : "off"));
      }
      else if (q === "/skills") { listSkillDirs().slice(0, 40).forEach((s) => console.log(s.name + (s.description ? ": " + s.description : ""))); }
      else if (q === "/stats") { statsLines().forEach((l) => console.log(stripAnsi(l))); }
      else if (q.startsWith("/theme")) {
        const arg = q.replace("/theme", "").trim();
        if (applyTheme(arg || activeTheme())) { CFG.theme = arg || activeTheme(); saveCfg(); console.log("palette -> " + (arg || activeTheme())); }
        else console.log("palettes: " + Object.keys(THEMES).join(" "));
      }
      else if (q.startsWith("/skill-del")) {
        const slug = safeSkillName(q.replace("/skill-del", "").trim());
        if (!slug) { console.log("/skill-del <name> - deletes a hydra skill (stashed into .trash first)"); return; }
        const dir = path.join(CFG_DIR, "skills", slug);
        if (!fs.existsSync(path.join(dir, "SKILL.md"))) { console.log("no hydra skill named \"" + slug + "\""); return; }
        try {
          fs.mkdirSync(SKILL_TRASH(), { recursive: true });
          const stash = String(Date.now()).padStart(13, "0") + "-" + slug;
          fs.renameSync(dir, path.join(SKILL_TRASH(), stash));
          console.log("stashed skill \"" + slug + "\" into .trash (" + stash + ")");
        } catch (e) { console.log("delete failed: " + (e.message || e)); }
      }
      else if (q.startsWith("/learn")) {
        const src = q.replace("/learn", "").trim();
        if (!src) { console.log("/learn <text|url|path> - turns reference material into a reusable skill (the agent distills and saves it)"); return; }
        let material = src;
        try {
          if (/^https?:\/\//i.test(src)) {
            console.log("fetching " + src);
            material = (await webInjectLines(src)).map((l) => stripAnsi(l)).join("\n");
          } else if (fs.existsSync(path.resolve(CWD, src)) && fs.statSync(path.resolve(CWD, src)).isFile()) {
            material = "FILE: " + path.resolve(CWD, src) + "\n\n" + fs.readFileSync(path.resolve(CWD, src), "utf8").slice(0, 60000);
          }
        } catch (e) { console.log("learn source failed: " + (e.message || e)); return; }
        const learnQ = "Turn the following material into a reusable skill. Distill it: synthesize frameworks, definitions, decision rules, steps and anti-patterns in your own words - NEVER copy long passages. Choose a kebab-case skill name matching the topic, write a one-line description, and save it with skill_write. If a skill with that name likely already exists, still do skill_write (it overwrites cleanly). Reply after saving with just the skill name and one line on when to use it.\n\n--- BEGIN MATERIAL ---\n" + material.slice(0, 50000) + "\n--- END MATERIAL ---";
        console.log("learn: distilling into a skill");
        await agentLoop(learnQ, activeProvider(), (t) => process.stdout.write(t), (tool) => console.log("\n  > " + tool), HISTORY, undefined, false);
        console.log("");
      }
      else if (q.startsWith("/hub")) {
        let catalog = null;
        try {
          const raw = await fetchText(HUB_URL, 12000);
          const j = JSON.parse(raw.replace(/^\uFEFF/, ""));
          catalog = (Array.isArray(j) ? j : j.skills || []).map((x) => typeof x === "string" ? { name: x, description: "" } : { name: String(x.name || ""), description: String(x.description || ""), path: String(x.path || "") }).filter((x) => x.name);
        } catch (e) { console.log("hub fetch failed: " + (e.message || e) + " - set HYDRA_HUB_URL to override"); return; }
        if (!catalog.length) { console.log("hub is empty right now"); return; }
        catalog.slice(0, 40).forEach((x) => console.log((x.name || "") + (x.description ? ": " + x.description : "")));
        console.log("install from the hub with the full-screen hydra (enter picks a row): node hydra.mjs");
      }
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
        await agentLoop(inlineAttach(q), activeProvider(), (t) => { process.stdout.write(t); },
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
  addLog(cc(DIM, centerText("\u2726 agent loop ready \u00b7 " + skillsCount() + " skills installed \u00b7 say <skill> <task> \u00b7 /learn /hub /memory", UI.cols - 2)));
}


async function main() {
  process.on("unhandledRejection", (e) => { crashLog(e); console.error("unhandled: " + (e && (e.message || e))); });
  process.on("uncaughtException", (e) => {
    crashLog(e);
    try { process.stdout.write(ESC + "[?25h" + ESC + "[?1006l" + ESC + "[?2004l" + ESC + "[?1049l"); } catch { /* nop */ }
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
      setTimeout(() => send("", { name: "down" }), 3000);          // (orng added -> list shifted one)
      setTimeout(() => send("", { name: "down" }), 3050);          // matrix (fourth)
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
  if (process.env.HYDRA_TEST === "11") {
    tuiSession();
    const send = (s, k) => process.stdin.emit("keypress", s, k || { name: s });
    // /model refresh + provider switching: each provider gets its OWN list (stale cache regression)
    const httpm = await import("node:http");
    const srv = httpm.createServer((req, res) => {
      const auth = req.headers.authorization || "";
      const body = auth === "Bearer key-old"
        ? JSON.stringify({ data: [{ id: "alpha-old" }, { id: "beta-old" }] })
        : JSON.stringify({ data: [{ id: "gamma-new" }, { id: "delta-new" }] });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
    });
    await new Promise((ok) => srv.listen(7078, "127.0.0.1", ok));
    srv.unref?.();
    loadCfg();
    CFG.providers["prov-a"] = { name: "prov-a", baseURL: "http://127.0.0.1:7078/v1", apiKey: "key-old", model: "alpha-old" };
    CFG.providers["prov-b"] = { name: "prov-b", baseURL: "http://127.0.0.1:7078/v1", apiKey: "key-new", model: "gamma-new" };
    CFG.active = "prov-a";
    saveCfg();
    setTimeout(() => { "/model".split("").forEach((c) => send(c)); }, 2400);
    setTimeout(() => send("", { name: "return" }), 3000);          // list prov-a: alpha/beta
    setTimeout(() => send("", { name: "down" }), 3400);            // hover beta-old
    setTimeout(() => send("", { name: "return" }), 3600);          // switch -> beta-old
    setTimeout(() => { "/provider use prov-b".split("").forEach((c) => send(c)); }, 5200);
    setTimeout(() => send("", { name: "return" }), 5600);          // switch provider (cache must reset)
    setTimeout(() => { "/model alpha-old".split("").forEach((c) => send(c)); }, 7200);
    setTimeout(() => send("", { name: "return" }), 7600);          // must NOT match: prov-b has no alpha-old
    setTimeout(() => { "/model delta".split("").forEach((c) => send(c)); }, 9000);
    setTimeout(() => send("", { name: "return" }), 9400);          // fresh list shows gamma/delta -> switch to delta
    setTimeout(() => process.exit(0), 12500);
    return;
  }
  if (process.env.HYDRA_TEST === "12") {
    tuiSession();
    const send = (s, k) => process.stdin.emit("keypress", s, k || { name: s });
    // turn surgery + extras: /stats / /undo / /web (mock html) / /regen (dead provider -> timeout) + quoted model-id hardening
    const httpm = await import("node:http");
    const srv = httpm.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><head><title>k-page</title></head><body><p>hydra-web-corpus-marker</p><script>void 0</script></body></html>");
    });
    await new Promise((ok) => srv.listen(7079, "127.0.0.1", ok));
    srv.unref?.();
    loadCfg();
    setTimeout(() => { "/resume".split("").forEach((c) => send(c)); }, 2200);
    setTimeout(() => send("", { name: "return" }), 2600);          // open the seeded deep-dive session
    setTimeout(() => { "/stats".split("").forEach((c) => send(c)); }, 3400);
    setTimeout(() => send("", { name: "return" }), 3800);          // turns > 0, approx tokens
    setTimeout(() => { "/undo".split("").forEach((c) => send(c)); }, 5600);
    setTimeout(() => send("", { name: "return" }), 6000);          // drops the last exchange
    setTimeout(() => { "/web http://127.0.0.1:7079".split("").forEach((c) => send(c)); }, 7600);
    setTimeout(() => send("", { name: "return" }), 8000);          // fetch page -> inject into context
    setTimeout(() => { "/regen".split("").forEach((c) => send(c)); }, 10000);
    setTimeout(() => send("", { name: "return" }), 10400);         // re-runs the last user msg -> dead provider -> timeout
    setTimeout(() => process.exit(0), 22500);
    return;
  }
  if (process.env.HYDRA_TEST === "13") {
    tuiSession();
    const send = (s, k) => process.stdin.emit("keypress", s, k || { name: s });
    // freeze regression: switching provider + model must NEVER deadlock sending in the same chat
    const httpm = await import("node:http");
    const srv = httpm.createServer((req, res) => {
      const auth = req.headers.authorization || "";
      if (req.method === "POST" && String(req.url).includes("chat/completions")) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "PONG from mock" } }] }) + "\n\n");
        res.write("data: [DONE]\n\n");
        res.end();
      }
      else if (auth === "Bearer key-a") res.end(JSON.stringify({ data: [{ id: "alpha-a" }, { id: "beta-b" }] }));
      else res.end(JSON.stringify({ data: [] }));
    });
    await new Promise((ok) => srv.listen(7081, "127.0.0.1", ok));
    srv.unref?.();
    loadCfg();
    CFG.providers["prov-live"] = { name: "prov-live", baseURL: "http://127.0.0.1:7081/v1", apiKey: "key-a", model: "alpha-a" };
    CFG.providers["prov-dead"] = { name: "prov-dead", baseURL: "http://192.0.2.1:11434/v1", apiKey: "", model: "" };
    CFG.active = "prov-live";
    saveCfg();
    setTimeout(() => { "one".split("").forEach((c) => send(c)); }, 1400);
    setTimeout(() => send("", { name: "return" }), 1800);
    setTimeout(() => { "/model".split("").forEach((c) => send(c)); }, 3200);
    setTimeout(() => send("", { name: "return" }), 3600);          // popup opens instantly (no blocking fetch)
    setTimeout(() => send("", { name: "down" }), 4000);
    setTimeout(() => send("", { name: "return" }), 4400);          // model -> beta-b
    setTimeout(() => { "/provider use prov-dead".split("").forEach((c) => send(c)); }, 5400);
    setTimeout(() => send("", { name: "return" }), 5800);          // provider -> prov-dead (unreachable)
    setTimeout(() => { "/model".split("").forEach((c) => send(c)); }, 7200);
    setTimeout(() => send("", { name: "return" }), 7600);          // popup still opens instantly on a dead provider
    setTimeout(() => send("", { name: "escape" }), 8600);          // close it without picking
    setTimeout(() => { "two".split("").forEach((c) => send(c)); }, 9200);
    setTimeout(() => send("", { name: "return" }), 9600);          // send goes through -> dead turn -> 8s timeout reported
    setTimeout(() => process.exit(0), 20500);
    return;
  }
  if (process.env.HYDRA_TEST === "14") {
    tuiSession();
    const send = (s, k) => process.stdin.emit("keypress", s, k || { name: s });
    // bash tool must NOT block the event loop: /stats typed mid-tool must render BEFORE the final reply
    const httpm = await import("node:http");
    const srv = httpm.createServer((req, res) => {
      const body = [];
      req.on("data", (c) => body.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(body).toString();
        if (req.method === "POST" && String(req.url).includes("chat/completions")) {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          if (raw.includes('"role":"tool"')) {
            res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "PONG after tool" } }] }) + "\n\n");
          } else {
            res.write("data: " + JSON.stringify({
              choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function",
                function: { name: "bash", arguments: JSON.stringify({ command: "ping -n 12 127.0.0.1" }) } }] } }],
            }) + "\n\n");
          }
          res.write("data: [DONE]\n\n");
          res.end();
        } else res.end(JSON.stringify({ data: [{ id: "alpha-a" }] }));
      });
    });
    await new Promise((ok) => srv.listen(7082, "127.0.0.1", ok));
    srv.unref?.();
    loadCfg();
    CFG.providers["prov-live"] = { name: "prov-live", baseURL: "http://127.0.0.1:7082/v1", apiKey: "key-b", model: "alpha-a" };
    CFG.active = "prov-live";
    saveCfg();
    setTimeout(() => { "go".split("").forEach((c) => send(c)); }, 1200);
    setTimeout(() => send("", { name: "return" }), 1600);          // turn: bash ping (~11s) -> replies PONG after tool
    setTimeout(() => { "/stats".split("").forEach((c) => send(c)); }, 4200);   // typed DURING the tool call
    setTimeout(() => send("", { name: "return" }), 4500);          // must land while the tool is still running (UI alive)
    setTimeout(() => process.exit(0), 20000);
    return;
  }
  if (process.env.HYDRA_TEST === "15") {
    tuiSession();
    const send = (s, k) => process.stdin.emit("keypress", s, k || { name: s });
    // hermes port: agent saves a skill + memory fact, then the skill triggers BY NAME next turn
    const httpm = await import("node:http");
    const srv = httpm.createServer((req, res) => {
      const body = [];
      req.on("data", (c) => body.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(body).toString();
        if (req.method === "POST" && String(req.url).includes("chat/completions")) {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          if (raw.includes('"role":"tool"')) res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "SAVED flyingstep" } }] }) + "\n\n");
          else if (raw.includes("fly-skill-body-v1")) res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "LOADED fly-skill-marker" } }] }) + "\n\n");
          else res.write("data: " + JSON.stringify({ choices: [{ delta: { tool_calls: [
            { index: 0, id: "c0", type: "function", function: { name: "todo_write", arguments: JSON.stringify({ items: [{ text: "save the flyingstep skill" }, { text: "remember deep-terminal preference", done: true }] }) } },
            { index: 1, id: "c1", type: "function", function: { name: "skill_write", arguments: JSON.stringify({ name: "flyingstep", description: "Greets loudly via the fly procedure", body: "# Fly\nStep one: greet the user looooud (fly-skill-body-v1)." }) } },
            { index: 2, id: "c2", type: "function", function: { name: "memory_write", arguments: JSON.stringify({ content: "User prefers deep-terminal persistence between bash calls" }) } },
          ] } }] }) + "\n\n");
          res.write("data: [DONE]\n\n");
          res.end();
        } else res.end(JSON.stringify({ data: [{ id: "alpha-a" }] }));
      });
    });
    await new Promise((ok) => srv.listen(7090, "127.0.0.1", ok));
    srv.unref?.();
    loadCfg();
    CFG.providers["prov-live"] = { name: "prov-live", baseURL: "http://127.0.0.1:7090/v1", apiKey: "key-s15", model: "alpha-a" };
    CFG.active = "prov-live";
    saveCfg();
    setTimeout(() => { "save greet flow".split("").forEach((c) => send(c)); }, 1300);
    setTimeout(() => send("", { name: "return" }), 1700);       // skill_write + memory_write land
    setTimeout(() => { "flyingstep now".split("").forEach((c) => send(c)); }, 6300);
    setTimeout(() => send("", { name: "return" }), 6700);       // name-trigger -> body in context
    setTimeout(() => process.exit(0), 12500);
    return;
  }
  if (process.env.HYDRA_TEST === "16") {
    tuiSession();
    const send = (s, k) => process.stdin.emit("keypress", s, k || { name: s });
    // sandbox: risky bash asks y/n; y runs it, n blocks it
    const httpm = await import("node:http");
    const rmCmd = "Remove-Item C:\\not_a_real_place_hydra -Recurse -Force; Write-Output hyd-d16-ran";
    const srv = httpm.createServer((req, res) => {
      const body = [];
      req.on("data", (c) => body.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(body).toString();
        if (req.method === "POST" && String(req.url).includes("chat/completions")) {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          if (raw.includes('"role":"tool"')) {
            const denied = /BLOCKED by hydra sandbox/.test(raw);
            res.write("data: " + JSON.stringify({ choices: [{ delta: { content: denied ? "SANDBOX DENIED" : "SANDBOX RAN hyd-d16-ran" } }] }) + "\n\n");
          } else {
            res.write("data: " + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: rmCmd }) } }] } }] }) + "\n\n");
          }
          res.write("data: [DONE]\n\n");
          res.end();
        } else res.end(JSON.stringify({ data: [{ id: "alpha-a" }] }));
      });
    });
    await new Promise((ok) => srv.listen(7091, "127.0.0.1", ok));
    srv.unref?.();
    loadCfg();
    CFG.providers["prov-live"] = { name: "prov-live", baseURL: "http://127.0.0.1:7091/v1", apiKey: "key-s16", model: "alpha-a" };
    CFG.active = "prov-live";
    saveCfg();
    setTimeout(() => { "one danger".split("").forEach((c) => send(c)); }, 1300);
    setTimeout(() => send("", { name: "return" }), 1700);       // tool asks y/n (sandbox=ask default)
    setTimeout(() => send("y"), 4200);                           // allow - output must land
    setTimeout(() => { "two danger".split("").forEach((c) => send(c)); }, 9600);
    setTimeout(() => send("", { name: "return" }), 10000);
    setTimeout(() => send("n"), 12000);                          // block this one
    setTimeout(() => process.exit(0), 17000);
    return;
  }
  if (process.env.HYDRA_TEST === "17") {
    tuiSession();
    const send = (s, k) => process.stdin.emit("keypress", s, k || { name: s });
    // /hub install (scanned, from a mock hub) + deep terminal cwd persistence across bash calls
    const httpm = await import("node:http");
    const srv = httpm.createServer((req, res) => {
      const url = String(req.url);
      if (url === "/hub.json") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ skills: [{ name: "deepfly", description: "flies the deep terminal marker", path: "deepfly.md" }] })); return; }
      if (url === "/skills/deepfly.md") { res.writeHead(200, { "Content-Type": "text/markdown" }); res.end("---\nname: deepfly\ndescription: flies the deep terminal marker\n---\nStep: run the persistence probe deep-cwd-b.\nhub-deepfly-body"); return; }
      const body = [];
      req.on("data", (c) => body.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(body).toString();
        if (req.method === "POST" && url.includes("chat/completions")) {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          if (raw.includes('"role":"tool"')) {
            const m17 = [...raw.matchAll(/\{"role":"tool".*?"content":"((?:[^"\\]|\\.)*)"\}/g)];
            let last17 = "";
            try { last17 = m17.length ? JSON.parse(m17[m17.length - 1][1]) : ""; } catch { last17 = m17.length ? m17[m17.length - 1][1] : ""; }
            if (last17.includes("deep-cwd-a")) {
              res.write("data: " + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c2", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "Write-Output ('cwd=' + (Get-Location).Path)" }) } }] } }] }) + "\n\n");
            } else if (/cwd=.*[\\/]home/.test(last17)) {
              res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "PWDOK deep-cwd-b" } }] }) + "\n\n");
            } else {
              res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "PWDERR" } }] }) + "\n\n");
            }
          } else if (raw.includes("hub-deepfly-body")) {
            res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "DEEPFLY ON" } }] }) + "\n\n");
          } else {
            res.write("data: " + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "Set-Location home; Write-Output deep-cwd-a" }) } }] } }] }) + "\n\n");
          }
          res.write("data: [DONE]\n\n");
          res.end();
        } else res.end(JSON.stringify({ data: [{ id: "alpha-a" }] }));
      });
    });
    await new Promise((ok) => srv.listen(7092, "127.0.0.1", ok));
    srv.unref?.();
    loadCfg();
    CFG.providers["prov-live"] = { name: "prov-live", baseURL: "http://127.0.0.1:7092/v1", apiKey: "key-s17", model: "alpha-a" };
    CFG.active = "prov-live";
    saveCfg();
    setTimeout(() => { "go deep".split("").forEach((c) => send(c)); }, 1300);
    setTimeout(() => send("", { name: "return" }), 1700);       // bash1 (cd home) -> pwd bash2 -> PWDOK (cwd persisted)
    setTimeout(() => { "/hub".split("").forEach((c) => send(c)); }, 7200);
    setTimeout(() => send("", { name: "return" }), 7600);       // submit /hub -> hub popup
    setTimeout(() => send("", { name: "return" }), 8600);       // enter installs deepfly (scanned) + closes popup
    setTimeout(() => { "deepfly check".split("").forEach((c) => send(c)); }, 10600);
    setTimeout(() => send("", { name: "return" }), 11000);      // skill trigger -> DEEPFLY ON
    setTimeout(() => process.exit(0), 16500);
    return;
  }
  if (process.env.HYDRA_TEST === "18") {
    tuiSession();
    const send = (s, k) => process.stdin.emit("keypress", s, k || { name: s });
    // ai-cli batch: queue prompts while a turn runs, @file attach, write/edit diff log
    const httpm = await import("node:http");
    fs.writeFileSync(path.join(CWD, "qatt.txt"), "ATTACHBODY-MARK pin robo-hydra\n", "utf8");
    const srv = httpm.createServer((req, res) => {
      const body = [];
      req.on("data", (c) => body.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(body).toString();
        const mU = [...raw.matchAll(/\{"role":"user","content":"((?:[^"\\]|\\.)*)"\}/g)];
        const lastU = mU.length ? mU[mU.length - 1][1] : "";
        if (req.method === "POST" && String(req.url).includes("chat/completions")) {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          if (raw.includes('"role":"tool"') && raw.includes('"content":"edited')) {
            res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "EDITDONE s18" } }] }) + "\n\n");
            res.write("data: [DONE]\n\n");
            res.end();
          } else if (raw.includes('"role":"tool"') && raw.includes('"content":"written')) {
            res.write("data: " + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "ce1", type: "function", function: { name: "edit", arguments: JSON.stringify({ filePath: "qout.txt", oldString: "line two", newString: "line two plus" }) } }] } }] }) + "\n\n");
            res.write("data: [DONE]\n\n");
            res.end();
          } else if (raw.includes('"role":"tool"')) {
            res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "TOOL-UNKNOWN s18" } }] }) + "\n\n");
            res.write("data: [DONE]\n\n");
            res.end();
          } else if (lastU.includes("slow one")) {
            res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "SLOW-TURN-ONE " } }] }) + "\n\n");
            setTimeout(() => { res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "ended" } }] }) + "\n\n"); res.write("data: [DONE]\n\n"); res.end(); }, 2200);
          } else if (lastU.includes("queued hello")) {
            res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "QUEUEDTURN-OK second prompt ran" } }] }) + "\n\n");
            res.write("data: [DONE]\n\n");
            res.end();
          } else if (lastU.includes("explain") && raw.includes("ATTACHBODY-MARK")) {
            res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "ATTACHED-OK body-seen" } }] }) + "\n\n");
            res.write("data: [DONE]\n\n");
            res.end();
          } else if (lastU.includes("explain")) {
            res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "ATTACH-FAIL" } }] }) + "\n\n");
            res.write("data: [DONE]\n\n");
            res.end();
          } else if (lastU.includes("qattdowrite")) {
            res.write("data: " + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "cw1", type: "function", function: { name: "write", arguments: JSON.stringify({ filePath: "qout.txt", content: "line one\nline two\nline tree" }) } }] } }] }) + "\n\n");
            res.write("data: [DONE]\n\n");
            res.end();
          } else {
            res.write("data: [DONE]\n\n");
            res.end();
          }
        } else res.end(JSON.stringify({ data: [{ id: "alpha-a" }] }));
      });
    });
    await new Promise((ok) => srv.listen(7094, "127.0.0.1", ok));
    srv.unref?.();
    loadCfg();
    CFG.providers["prov-live"] = { name: "prov-live", baseURL: "http://127.0.0.1:7094/v1", apiKey: "key-s18", model: "alpha-a" };
    CFG.active = "prov-live";
    saveCfg();
    setTimeout(() => { "slow one please".split("").forEach((c) => send(c)); }, 1600);   // (after the ~1.5s splash so no key is eaten)
    setTimeout(() => send("", { name: "return" }), 2000);      // turn 1 runs ~2.2s
    setTimeout(() => { "queued hello".split("").forEach((c) => send(c)); }, 2900);
    setTimeout(() => send("", { name: "return" }), 3200);      // busy: must queue, then run after turn 1
    setTimeout(() => { "explain @qatt.txt now".split("").forEach((c) => send(c)); }, 8000);
    setTimeout(() => send("", { name: "return" }), 8400);      // attach -> ATTACHED-OK body-seen
    setTimeout(() => { "qattdowrite the file".split("").forEach((c) => send(c)); }, 13500);
    setTimeout(() => send("", { name: "return" }), 13900);     // write + edit -> diff log + EDITDONE s18
    setTimeout(() => process.exit(0), 21000);
    return;
  }
  if (process.env.HYDRA_TEST === "19") {
    tuiSession();
    const send = (s, k) => process.stdin.emit("keypress", s, k || { name: s });
    // full-history durability: 22 turns -> 44 messages must ALL land in the session file
    // (the old hard 40-message cap silently deleted the four oldest) and the model-facing
    // window must stay bounded without touching the file ( FACE:<n> reports what the provider got )
    const httpm = await import("node:http");
    const srv = httpm.createServer((req, res) => {
      const body = [];
      req.on("data", (c) => body.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(body).toString();
        if (req.method === "POST" && String(req.url).includes("chat/completions")) {
          const mU = [...raw.matchAll(/\{"role":"(user|assistant|tool)"[^\}]*"content":"((?:[^"\\]|\\.)*)"/g)];
          const nFace = Math.max(0, mU.length - 1);   // minus the live question
          const lastU = mU.length ? mU[mU.length - 1][2] : "";
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "REPL:" + lastU + " FACE:" + nFace } }] }) + "\n\n");
          res.write("data: [DONE]\n\n");
          res.end();
        } else res.end(JSON.stringify({ data: [{ id: "alpha-a" }] }));
      });
    });
    await new Promise((ok) => srv.listen(7093, "127.0.0.1", ok));
    srv.unref?.();
    loadCfg();
    CFG.providers["prov-live"] = { name: "prov-live", baseURL: "http://127.0.0.1:7093/v1", apiKey: "key-s19", model: "alpha-a" };
    CFG.active = "prov-live";
    saveCfg();
    for (let i = 1; i <= 22; i++) {
      setTimeout(() => { ("t" + i).split("").forEach((c) => send(c)); }, 1400 + (i - 1) * 430);
      setTimeout(() => send("", { name: "return" }), 1400 + (i - 1) * 430 + 140);
    }
    setTimeout(() => { "/exit".split("").forEach((c) => send(c)); }, 12300);
    setTimeout(() => send("", { name: "return" }), 12500);
    setTimeout(() => process.exit(0), 13500);
    return;
  }
  if (process.env.HYDRA_TEST === "20") {
    tuiSession();
    const send = (s, k) => process.stdin.emit("keypress", s, k || { name: s });
    // step budget: a model that always wants another tool round must stop LOUDLY after
    // MAX_STEPS rounds (drive sets HYDRA_MAX_STEPS=3) instead of silently falling off the cliff
    const httpm = await import("node:http");
    let round = 0;
    const srv = httpm.createServer((req, res) => {
      const body = [];
      req.on("data", (c) => body.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(body).toString();
        if (req.method === "POST" && String(req.url).includes("chat/completions")) {
          round++;
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write("data: " + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "cs" + round, type: "function",
            function: { name: "bash", arguments: JSON.stringify({ command: "ping -n 2 127.0.0.1" }) } }] } }] }) + "\n\n");
          res.write("data: [DONE]\n\n");
          res.end();
        } else res.end(JSON.stringify({ data: [{ id: "alpha-a" }] }));
      });
    });
    await new Promise((ok) => srv.listen(7095, "127.0.0.1", ok));
    srv.unref?.();
    loadCfg();
    CFG.providers["prov-live"] = { name: "prov-live", baseURL: "http://127.0.0.1:7095/v1", apiKey: "key-s20", model: "alpha-a" };
    CFG.active = "prov-live";
    saveCfg();
    setTimeout(() => { "do the steps".split("").forEach((c) => send(c)); }, 1400);
    setTimeout(() => send("", { name: "return" }), 1800);
    setTimeout(() => { "/exit".split("").forEach((c) => send(c)); }, 11500);
    setTimeout(() => send("", { name: "return" }), 11700);
    setTimeout(() => process.exit(0), 12500);
    return;
  }
  if (process.env.HYDRA_TEST === "21") {
    tuiSession();
    setTimeout(() => {
      try {
        HISTORY.push({ role: "user", content: "ctx probe turn one: pickup-z21" }, { role: "assistant", content: "pong one z21" });
        HISTORY.push({ role: "user", content: "ctx probe turn two: small" }, { role: "assistant", content: "pong two" });
        HISTORY.push({ role: "user", content: "ctx probe turn three: stale \u00b7 " + "z21x".repeat(300) }, { role: "assistant", content: "pong three z21x".repeat(160) });
        HISTORY.push({ role: "user", content: "ctx probe turn four: stale \u00b7 " + "z21y".repeat(300) }, { role: "assistant", content: "pong four z21y".repeat(160) });
        HISTORY.push({ role: "user", content: "ctx probe turn five: stale \u00b7 " + "z21z".repeat(300) }, { role: "assistant", content: "pong five z21z".repeat(160) });
        HISTORY.push({ role: "user", content: "ctx probe turn six: fresh \u00b7 boundary" }, { role: "assistant", content: "pong six fresh" });
        const b1 = budgetFace();
        addLog(cc(DIM, " gnv1:budget " + b1.tok + " tokens cap " + b1.cap + " trim " + b1.dropped.trim + " park " + b1.dropped.park));
        CTX.excl.add(0); CTX.excl.add(1);
        const b2 = budgetFace();
        addLog(cc(DIM, " gnv2:parked " + b2.dropped.park + " turn \u00b7 window tokens " + b2.tok));
        CTX.excl.clear();
        purgeStale("200");
        const b3 = budgetFace();
        addLog(cc(DIM, " gnv3:after-purge window tokens " + b3.tok + " \u00b7 gnv-done"));
      } catch (e) { crashLog(e); addLog(cc("\u001b[31m", " s21 error: " + (e && e.message))); }
      setTimeout(() => process.exit(0), 1600);
    }, 1200);
    return;
  }
  if (process.env.HYDRA_TEST === "22") {
    tuiSession();
    setTimeout(() => {
      try {
        HISTORY.push({ role: "user", content: "chk travel one marker-chk-A" }, { role: "assistant", content: "ack-A" });
        saveSession();
        HISTORY.push({ role: "user", content: "chk travel two marker-chk-B" }, { role: "assistant", content: "ack-B" });
        saveSession();
        const files = fs.readdirSync(CHK_DIR()).filter((f) => f.endsWith(".json")).sort();
        restoreCheckpoint(files[0]);
        addLog(cc(DIM, " chk:after-rewind messages " + HISTORY.length + " last " + clip(String((HISTORY[HISTORY.length - 1] || {}).content || ""), 26)));
        addLog(cc(DIM, " chk:list " + fs.readdirSync(CHK_DIR()).filter((f) => f.endsWith(".json")).length + " checkpoints (after rewind)"));
      } catch (e) { crashLog(e); addLog(cc("\u001b[31m", " s22 error: " + (e && e.message))); }
      setTimeout(() => process.exit(0), 1600);
    }, 1200);
    return;
  }
  if (process.env.HYDRA_TEST === "23") {
    tuiSession();
    setTimeout(() => {
      try {
        fs.writeFileSync(path.join(CWD, ".agentrules"), "deny rm -rf\nallow write-output\n", "utf8");
        (async () => {
          try {
            CFG.sandbox = "open";
            const r1 = await runToolCall({ function: { name: "bash", arguments: JSON.stringify({ command: "Write-Output zone-allow-OK" }) } }, null);
            addLog(cc(DIM, " zone1:allow-out " + clip(String(r1.result), 26)));
            const r2 = await runToolCall({ function: { name: "bash", arguments: JSON.stringify({ command: "rm -rf zone-out-z23" }) } }, null);
            addLog(cc(DIM, " zone2:deny-out " + (String(r2.result).includes("BLOCKED by zone rules") ? "BLOCKED-z23" : "LEAK-z23")));
          } catch (e) { crashLog(e); addLog(cc("\u001b[31m", " s23 error: " + (e && e.message))); }
          setTimeout(() => process.exit(0), 1400);
        })();
      } catch (e) { crashLog(e); }
    }, 900);
    return;
  }
  if (process.env.HYDRA_TEST === "24") {
    tuiSession();
    setTimeout(() => {
      (async () => {
        try {
          recStart();
          const r1 = await runBash("Write-Output MACROSTEP-A", 8000, null);
          addLog(cc(DIM, " stepA-out " + clip(String((r1 && (r1.out !== undefined ? r1.out : r1.stdout)) || "").trim(), 30)));
          const r2 = await runBash("Write-Output MACROSTEP-B", 8000, null);
          addLog(cc(DIM, " stepB-out " + clip(String((r2 && (r2.out !== undefined ? r2.out : r2.stdout)) || "").trim(), 30)));
          await recStop("capture-flow");
          addLog(cc(DIM, " macro:done slug " + (REC.last || "none")));
        } catch (e) { crashLog(e); addLog(cc("\u001b[31m", " s24 error: " + (e && e.message))); }
        setTimeout(() => process.exit(0), 1800);
      })();
    }, 900);
    return;
  }
  if (process.env.HYDRA_TEST === "25") {
    tuiSession();
    setTimeout(() => {
      (async () => {
        try {
          const tgt = ["radar", "-z25", "t"].join("") + "arget.js";
          fs.writeFileSync(path.join(CWD, tgt), "export function sourceFan() {\n  return RADARSRC;\n}\n", "utf8");
          fs.writeFileSync(path.join(CWD, "z25-usr.js"), "import { sourceFan } from './" + tgt + "';\nexport const PINGFAN = sourceFan();\n", "utf8");
          await radarScan(tgt);
          addLog(cc(DIM, " radar:done count " + (UI.RADAR ? UI.RADAR.n : "-")));
        } catch (e) { crashLog(e); addLog(cc("\u001b[31m", " s25 error: " + (e && e.message))); }
        setTimeout(() => process.exit(0), 1700);
      })();
    }, 900);
    return;
  }
  if (process.env.HYDRA_TEST === "26") {
    tuiSession();
    setTimeout(() => {
      (async () => {
        try {
          const r1 = await runToolCall({ function: { name: "bash", arguments: JSON.stringify({ command: "Get-Content diag-missing-z26.txt" }) } }, null);
          addLog(cc(DIM, " dg1:code-exit " + (String(r1.result).includes("]exit") || String(r1.result).includes("[exit") ? "exit-z26" : "GLOSS-z26")));
          PROMPT_HIST.push("echo batman-vocab-two");
          PROMPT_HIST.push("echo batman-vocab-one; echo more-bat");
          setUserInput("echo batman-vocab");
          addLog(cc(DIM, " ghost:shown " + (UI.GHOST ? "yes-s26" : "no-s26") + " tail " + clip(UI.GHOST, 20)));
        } catch (e) { crashLog(e); addLog(cc("\u001b[31m", " s26 error: " + (e && e.message))); }
        setTimeout(() => {
          const send = (s, k) => process.stdin.emit("keypress", s, k || { name: s });
          send("", { name: "tab" });
          setTimeout(() => process.exit(0), 900);
        }, 900);
      })();
    }, 900);
    return;
  }
  if (process.env.HYDRA_TEST === "27") {
    tuiSession();
    const send = (s, k) => process.stdin.emit("keypress", s, k || { name: s });
    setTimeout(() => {
      (async () => {
        try {
          const httpm = await import("node:http");
          const srv = httpm.createServer((req, res) => {
            const body = [];
            req.on("data", (c) => body.push(c));
            req.on("end", () => {
              if (req.method === "POST" && String(req.url).includes("chat/completions")) {
                res.writeHead(200, { "Content-Type": "text/event-stream" });
                res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "lane-chunk-b0 lane-chunk-b1 lane-chunk-b2" } }] }) + "\n\n");
                res.write("data: [DONE]\n\n");
                res.end();
              } else res.end(JSON.stringify({ data: [{ id: "alpha-a" }] }));
            });
          });
          await new Promise((ok) => srv.listen(7096, "127.0.0.1", ok));
          srv.unref?.();
          loadCfg();
          CFG.providers["prov-lane"] = { name: "prov-lane", baseURL: "http://127.0.0.1:7096/v1", apiKey: "k-z27", model: "alpha-a" };
          CFG.active = "prov-lane";
          saveCfg();
          await laneStart("grid: summarize the constellation in one line");
          addLog(cc(DIM, " tele:tok " + UI.TOKENS + " \u00b7 z27-done"));
        } catch (e) { crashLog(e); addLog(cc("\u001b[31m", " s27 error: " + (e && e.message))); }
        setTimeout(() => process.exit(0), 1600);
      })();
    }, 500);
    void send;
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
  try { process.stdout.write(ESC + "[?25h" + ESC + "[?1006l" + ESC + "[?2004l" + ESC + "[?1049l"); } catch { /* nop */ }
  console.error("fatal: " + (e.message || e));
  process.exit(1);
});

