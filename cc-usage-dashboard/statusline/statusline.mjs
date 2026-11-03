#!/usr/bin/env node
// Claude Code 상태줄 스크립트
// 1) Claude Code 가 넘겨주는 세션 정보(공식 5시간/주간 한도 % 포함)를 대시보드로 보내고
// 2) 하단 상태줄에 한 줄 요약을 표시한다.
// 대시보드가 꺼져 있어도 상태줄은 정상적으로 표시된다.

const ENDPOINT = process.env.CC_DASHBOARD_URL ?? "http://localhost:4318/api/statusline";
const SEND_TIMEOUT_MS = 400;
const WARN_PCT = 80;
const DANGER_PCT = 95;

const COLOR = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

function toMs(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function colorPct(p) {
  const c = p >= DANGER_PCT ? COLOR.red : p >= WARN_PCT ? COLOR.yellow : COLOR.green;
  return `${c}${Math.round(p)}%${COLOR.reset}`;
}

function untilText(ms) {
  const diff = ms - Date.now();
  if (diff <= 0) return "곧";
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (h >= 24) return `${Math.floor(h / 24)}일 ${h % 24}시간`;
  return h > 0 ? `${h}시간 ${m}분` : `${m}분`;
}

const raw = await readStdin();
let input = {};
try {
  input = JSON.parse(raw || "{}");
} catch {
  /* 잘못된 입력이면 빈 상태줄 */
}

// 대시보드로 전송 (실패해도 무시)
try {
  await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw || "{}",
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
} catch {
  /* 대시보드가 꺼져 있음 */
}

const parts = [];
const model = input.model?.display_name ?? input.model?.id;
if (model) parts.push(`${COLOR.cyan}${model}${COLOR.reset}`);

const five = input.rate_limits?.five_hour;
if (typeof five?.used_percentage === "number") {
  const reset = toMs(five.resets_at);
  parts.push(`5h ${colorPct(five.used_percentage)}${reset ? `${COLOR.dim} (${untilText(reset)} 후 리셋)${COLOR.reset}` : ""}`);
}
const seven = input.rate_limits?.seven_day;
if (typeof seven?.used_percentage === "number") {
  parts.push(`주간 ${colorPct(seven.used_percentage)}`);
}
const ctx = input.context_window?.used_percentage;
if (typeof ctx === "number") parts.push(`컨텍스트 ${Math.round(ctx)}%`);
const cost = input.cost?.total_cost_usd;
if (typeof cost === "number") parts.push(`${COLOR.dim}세션 $${cost.toFixed(2)}${COLOR.reset}`);

process.stdout.write(parts.join(" │ "));
