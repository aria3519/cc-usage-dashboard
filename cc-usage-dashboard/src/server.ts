import express, { type Request, type Response } from "express";
import path from "node:path";
import { db, insertRequests } from "./db.js";
import { getConfig, type AppConfig } from "./config.js";
import { timeKeys } from "./time.js";
import { extractApiRequests, type OtlpLogsPayload } from "./otlp.js";
import { checkBudgets, getSpent, getBudget, GLOBAL_SCOPE, type AlertRow } from "./budget.js";
import { recordStatusline } from "./limits.js";
import { buildAnalysis } from "./analysis.js";

const BODY_LIMIT = "20mb";
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const HOURS_IN_CHART = 24;
const DEFAULT_DAYS_IN_CHART = 30;
const MAX_DAYS_IN_CHART = 180;
const DEFAULT_RECENT_LIMIT = 50;
const MAX_RECENT_LIMIT = 500;
const SSE_HEARTBEAT_MS = 25_000;

const app = express();
app.use(express.json({ limit: BODY_LIMIT, type: ["application/json", "application/x-protobuf+json"] }));

// ───────────────────────── 실시간 푸시 (SSE) ─────────────────────────
const sseClients = new Set<Response>();

function broadcast(event: string, data: unknown): void {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(msg);
}

app.get("/api/stream", (req: Request, res: Response) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  res.write("event: hello\ndata: {}\n\n");
  sseClients.add(res);
  const hb = setInterval(() => res.write(": ping\n\n"), SSE_HEARTBEAT_MS);
  req.on("close", () => {
    clearInterval(hb);
    sseClients.delete(res);
  });
});

// ───────────────────────── OTLP 수신 ─────────────────────────
function rejectProtobuf(req: Request, res: Response): boolean {
  const type = req.headers["content-type"] ?? "";
  if (type.includes("protobuf") && !type.includes("json")) {
    res.status(415).json({
      error: "protobuf 는 지원하지 않습니다. OTEL_EXPORTER_OTLP_PROTOCOL=http/json 으로 설정하세요.",
    });
    return true;
  }
  return false;
}

app.post("/v1/logs", (req: Request, res: Response) => {
  if (rejectProtobuf(req, res)) return;
  try {
    const rows = extractApiRequests(req.body as OtlpLogsPayload, getConfig().timezone);
    if (rows.length > 0) {
      insertRequests(rows);
      const alerts = checkBudgets(rows);
      broadcast("usage", { count: rows.length });
      for (const a of alerts) broadcast("alert", a);
    }
    res.json({ partialSuccess: {} });
  } catch (err) {
    console.error("[otlp] 로그 처리 실패:", err);
    res.status(400).json({ error: (err as Error).message });
  }
});

// 메트릭/트레이스는 지금은 쓰지 않지만, 내보내기 오류가 안 나도록 200 으로 받아준다.
app.post(["/v1/metrics", "/v1/traces"], (req: Request, res: Response) => {
  if (rejectProtobuf(req, res)) return;
  res.json({ partialSuccess: {} });
});

// ───────────────────────── 상태줄 → 공식 한도(/usage) 수신 ─────────────────────────
app.post("/api/statusline", (req: Request, res: Response) => {
  try {
    const { snapshot, alerts } = recordStatusline(req.body ?? {});
    if (snapshot) broadcast("limits", snapshot);
    for (const a of alerts) broadcast("alert", a);
    res.json({ ok: true, stored: snapshot !== null });
  } catch (err) {
    console.error("[statusline] 처리 실패:", err);
    res.status(400).json({ error: (err as Error).message });
  }
});

app.get("/api/analysis", (_req: Request, res: Response) => {
  res.json(buildAnalysis());
});

// ───────────────────────── 조회 API ─────────────────────────
interface Totals {
  cost: number;
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

const TOTALS_SELECT = `
  COALESCE(SUM(cost_usd),0)              AS cost,
  COUNT(*)                               AS requests,
  COALESCE(SUM(input_tokens),0)          AS input,
  COALESCE(SUM(output_tokens),0)         AS output,
  COALESCE(SUM(cache_read_tokens),0)     AS cacheRead,
  COALESCE(SUM(cache_creation_tokens),0) AS cacheCreation`;

const totalsByDay = db.prepare(`SELECT ${TOTALS_SELECT} FROM requests WHERE day_key = ?`);
const totalsByMonth = db.prepare(`SELECT ${TOTALS_SELECT} FROM requests WHERE month_key = ?`);
const byProjectMonth = db.prepare(
  `SELECT project, ${TOTALS_SELECT} FROM requests WHERE month_key = ? GROUP BY project ORDER BY cost DESC`,
);
const byModelMonth = db.prepare(
  `SELECT model, ${TOTALS_SELECT} FROM requests WHERE month_key = ? GROUP BY model ORDER BY cost DESC`,
);
// 같은 기간·범위에서는 가장 높은 단계만 보여준다
const recentAlerts = db.prepare(`
  SELECT * FROM alerts a
  WHERE threshold = (SELECT MAX(threshold) FROM alerts b
                     WHERE b.scope = a.scope AND b.period = a.period AND b.period_key = a.period_key)
  ORDER BY ts DESC LIMIT 20`);

app.get("/api/summary", (_req: Request, res: Response) => {
  const cfg = getConfig();
  const keys = timeKeys(Date.now(), cfg.timezone);

  const projectsThisMonth = byProjectMonth.all(keys.month) as unknown as (Totals & { project: string })[];
  const scopes = new Set<string>([
    ...Object.keys(cfg.budgets.projects),
    ...projectsThisMonth.map((p) => p.project),
  ]);

  const budgetRow = (scope: string) => {
    const b = getBudget(scope) ?? {};
    return {
      scope,
      daily: { spent: getSpent(scope, "daily", keys.day), limit: b.daily ?? null },
      monthly: { spent: getSpent(scope, "monthly", keys.month), limit: b.monthly ?? null },
    };
  };

  res.json({
    now: keys,
    timezone: cfg.timezone,
    krwPerUsd: cfg.krwPerUsd,
    today: totalsByDay.get(keys.day) as unknown as Totals,
    month: totalsByMonth.get(keys.month) as unknown as Totals,
    budgets: [budgetRow(GLOBAL_SCOPE), ...[...scopes].sort().map(budgetRow)],
    byProject: projectsThisMonth,
    byModel: byModelMonth.all(keys.month),
    alerts: recentAlerts.all() as unknown as AlertRow[],
  });
});

const dailyByProject = db.prepare(`
  SELECT day_key AS day, project, COALESCE(SUM(cost_usd),0) AS cost,
         COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens),0) AS tokens
  FROM requests WHERE ts >= ? GROUP BY day_key, project`);
const hourlyTotals = db.prepare(`
  SELECT hour_key AS hour, COALESCE(SUM(cost_usd),0) AS cost, COUNT(*) AS requests,
         COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens),0) AS tokens
  FROM requests WHERE ts >= ? GROUP BY hour_key`);

function clampInt(raw: unknown, def: number, max: number): number {
  const n = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : def;
}

app.get("/api/timeseries", (req: Request, res: Response) => {
  const tz = getConfig().timezone;
  const now = Date.now();
  const days = clampInt(req.query.days, DEFAULT_DAYS_IN_CHART, MAX_DAYS_IN_CHART);

  const dayLabels: string[] = [];
  for (let i = days - 1; i >= 0; i--) dayLabels.push(timeKeys(now - i * MS_PER_DAY, tz).day);
  const hourLabels: string[] = [];
  for (let i = HOURS_IN_CHART - 1; i >= 0; i--) hourLabels.push(timeKeys(now - i * MS_PER_HOUR, tz).hour);

  res.json({
    days: dayLabels,
    daily: dailyByProject.all(now - days * MS_PER_DAY),
    hours: hourLabels,
    hourly: hourlyTotals.all(now - HOURS_IN_CHART * MS_PER_HOUR),
  });
});

const recentRequests = db.prepare(`
  SELECT ts, project, model, cost_usd, input_tokens, output_tokens, cache_read_tokens,
         cache_creation_tokens, duration_ms, user_email
  FROM requests ORDER BY ts DESC LIMIT ?`);

app.get("/api/recent", (req: Request, res: Response) => {
  res.json(recentRequests.all(clampInt(req.query.limit, DEFAULT_RECENT_LIMIT, MAX_RECENT_LIMIT)));
});

// ───────────────────────── OpenAI 호출 (crpg-studio instrumentation.ts 가 보냄) ─────────────────────────
// Only numbers arrive here (route, purpose tag, model, tokens, time); cost is worked out on read from config.openaiPrices,
// so a price added later also prices older calls.
const insertOpenaiCall = db.prepare(`
INSERT INTO openai_calls (ts, day_key, hour_key, project, route, tag, model, ok, status,
  input_tokens, cached_tokens, output_tokens, duration_ms)
VALUES (@ts, @day_key, @hour_key, @project, @route, @tag, @model, @ok, @status,
  @input_tokens, @cached_tokens, @output_tokens, @duration_ms)`);

const str = (v: unknown, max = 80) => String(v ?? "").slice(0, max);
const int = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0);

app.post("/api/openai/calls", (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const ts = int(b.ts) || Date.now();
  const keys = timeKeys(ts, getConfig().timezone);
  insertOpenaiCall.run({
    ts, day_key: keys.day, hour_key: keys.hour,
    project: str(b.project) || "미지정", route: str(b.route), tag: str(b.tag), model: str(b.model) || "unknown",
    ok: b.ok === false ? 0 : 1, status: int(b.status),
    input_tokens: int(b.input_tokens), cached_tokens: int(b.cached_tokens), output_tokens: int(b.output_tokens),
    duration_ms: int(b.duration_ms),
  });
  broadcast("openai", {});
  res.json({ ok: true });
});

interface OpenaiGroup {
  day: string; hour: string; route: string; tag: string; model: string;
  calls: number; errors: number; input: number; cached: number; output: number; ms: number; maxMs: number;
}
const openaiGroups = db.prepare(`
  SELECT day_key AS day, hour_key AS hour, route, tag, model, COUNT(*) AS calls, SUM(1 - ok) AS errors,
         SUM(input_tokens) AS input, SUM(cached_tokens) AS cached, SUM(output_tokens) AS output,
         SUM(duration_ms) AS ms, MAX(duration_ms) AS maxMs
  FROM openai_calls WHERE ts >= ? GROUP BY day_key, hour_key, route, tag, model`);
const openaiRecent = db.prepare(`
  SELECT ts, route, tag, model, ok, status, input_tokens, cached_tokens, output_tokens, duration_ms
  FROM openai_calls ORDER BY ts DESC LIMIT 100`);

/** Price per 1M tokens or per call; a snapshot name (gpt-6-luna-2026-…) uses the longest configured name it starts with. */
function priceOf(model: string): AppConfig["openaiPrices"][string] | null {
  const prices = getConfig().openaiPrices;
  const key = Object.keys(prices).filter((k) => model.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  return key ? prices[key] : null;
}

app.get("/api/openai/summary", (req: Request, res: Response) => {
  const days = clampInt(req.query.days, 7, MAX_DAYS_IN_CHART);
  const tz = getConfig().timezone;
  const now = Date.now();
  const rows = (openaiGroups.all(now - days * MS_PER_DAY) as unknown as OpenaiGroup[]).map((g) => {
    const p = priceOf(g.model);
    const cost = !p ? 0 : p.perCall != null ? g.calls * p.perCall
      : ((g.input - g.cached) * (p.input ?? 0) + g.cached * (p.cached ?? p.input ?? 0) + g.output * (p.output ?? 0)) / 1e6;
    return { ...g, cost, priced: !!p };
  });
  const dayLabels: string[] = [];
  for (let i = days - 1; i >= 0; i--) dayLabels.push(timeKeys(now - i * MS_PER_DAY, tz).day);
  const hourLabels: string[] = [];
  for (let i = HOURS_IN_CHART - 1; i >= 0; i--) hourLabels.push(timeKeys(now - i * MS_PER_HOUR, tz).hour);
  res.json({
    days, dayLabels, hourLabels, rows, recent: openaiRecent.all(),
    unpriced: [...new Set(rows.filter((r) => !r.priced).map((r) => r.model))],
    krwPerUsd: getConfig().krwPerUsd,
  });
});

// ───────────────────────── 대시보드 ─────────────────────────
app.use("/vendor", express.static(path.resolve(process.cwd(), "node_modules/chart.js/dist")));
app.use(express.static(path.resolve(process.cwd(), "public")));

const { port } = getConfig();
app.listen(port, () => {
  console.log(`Claude Code 사용량 대시보드: http://localhost:${port}`);
  console.log(`OTLP 수신 주소 (http/json): http://localhost:${port}/v1/logs`);
});
