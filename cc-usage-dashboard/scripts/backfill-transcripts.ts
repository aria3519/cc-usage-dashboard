// Backfill estimated usage from local Claude Code transcripts (~/.claude/projects/**/*.jsonl)
// for the period before OTLP collection started. Re-runnable: replaces earlier backfill rows.
// Run: npx tsx scripts/backfill-transcripts.ts   (from the cc-usage-dashboard folder)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db, insertRequests, type RequestRow } from "../src/db.ts";
import { getConfig } from "../src/config.ts";
import { timeKeys } from "../src/time.ts";

const TAG = "est:"; // session_id prefix marking estimated rows

// $ per 1M tokens: input, output, cache read; cache writes are 1.25x (5m) and 2x (1h) of input.
// shortcut: hand-kept price table, update when models/prices change.
const BASE: Record<string, [number, number, number]> = {
  "claude-opus-5-5": [4, 20, 0.2], "claude-opus-5": [5, 25, 0.5],
  "claude-opus-4-8": [5, 25, 0.5], "claude-opus-4-7": [5, 25, 0.5], "claude-opus-4-6": [5, 25, 0.5],
  "claude-sonnet-5-5": [2, 10, 0.2], "claude-sonnet-5": [2, 10, 0.2], "claude-sonnet-4-6": [3, 15, 0.3],
  "claude-haiku-5-5": [0.1, 0.5, 0.01], "claude-haiku-4-5": [1, 5, 0.1],
  "claude-fable-5-1": [10, 50, 0.25], "claude-fable-5": [10, 50, 1],
};
const priceFor = (model: string) =>
  Object.keys(BASE).sort((a, b) => b.length - a.length).find((k) => model.startsWith(k));

// A session started in a subfolder (crpg-studio/app/_lib) counts for its project: the nearest folder up with a
// package.json or .git. Git Bash paths (/f/github/...) are read as F:/github/...; no such folder → the cwd's own name.
const projectCache = new Map<string, string>();
function projectOf(cwd: string): string {
  if (projectCache.has(cwd)) return projectCache.get(cwd)!;
  const start = path.resolve(cwd.replace(/^\/([a-zA-Z])\//, "$1:/"));
  let name = path.basename(start);
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "package.json")) || fs.existsSync(path.join(dir, ".git"))) { name = path.basename(dir); break; }
    if (path.dirname(dir) === dir) break;
  }
  projectCache.set(cwd, name);
  return name;
}

function* jsonlFiles(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* jsonlFiles(p);
    else if (e.name.endsWith(".jsonl")) yield p;
  }
}

const tz = getConfig().timezone;
db.exec(`DELETE FROM requests WHERE session_id LIKE '${TAG}%'`);
const first = (db.prepare("SELECT MIN(ts) AS t FROM requests").get() as { t: number | null }).t ?? Date.now();

const seen = new Set<string>();
const rows: RequestRow[] = [];
for (const file of jsonlFiles(path.join(os.homedir(), ".claude", "projects"))) {
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    const m = e?.message;
    if (e?.type !== "assistant" || !m?.usage || !e.timestamp) continue;
    const key = `${m.id}|${e.requestId}`;
    if (seen.has(key)) continue; // streamed responses repeat the same message
    seen.add(key);
    const ts = Date.parse(e.timestamp);
    const p = priceFor(String(m.model ?? ""));
    if (!p || !(ts < first)) continue; // OTLP rows already cover everything from `first` on
    const [pin, pout, pread] = BASE[p];
    const u = m.usage, cc = u.cache_creation ?? {};
    const w1 = cc.ephemeral_1h_input_tokens ?? 0;
    const w5 = cc.ephemeral_5m_input_tokens ?? (u.cache_creation_input_tokens ?? 0) - w1;
    const input = u.input_tokens ?? 0, output = u.output_tokens ?? 0, read = u.cache_read_input_tokens ?? 0;
    const k = timeKeys(ts, tz);
    rows.push({
      ts, day_key: k.day, month_key: k.month, hour_key: k.hour,
      project: e.cwd ? projectOf(e.cwd) : "미지정",
      model: m.model, session_id: TAG + (e.sessionId ?? path.basename(file, ".jsonl")), user_email: null,
      cost_usd: (input * pin + output * pout + read * pread + w5 * pin * 1.25 + w1 * pin * 2) / 1e6,
      input_tokens: input, output_tokens: output, cache_read_tokens: read, cache_creation_tokens: w5 + w1,
      duration_ms: 0,
    });
  }
}
insertRequests(rows);
const total = rows.reduce((s, r) => s + r.cost_usd, 0);
console.log(`backfilled ${rows.length} requests before ${new Date(first).toISOString()}, est. $${total.toFixed(2)}`);
