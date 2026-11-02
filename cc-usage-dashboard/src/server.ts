import express, { type Request, type Response } from "express";
import path from "node:path";
import { db, insertRequests } from "./db.js";
import { getConfig } from "./config.js";
import { timeKeys } from "./time.js";
import { extractApiRequests, type OtlpLogsPayload } from "./otlp.js";
import { checkBudgets, getSpent, getBudget, GLOBAL_SCOPE, type AlertRow } from "./budget.js";

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

// ───────────────────────── 대시보드 ─────────────────────────
app.use("/vendor", express.static(path.resolve(process.cwd(), "node_modules/chart.js/dist")));
app.use(express.static(path.resolve(process.cwd(), "public")));

const { port } = getConfig();
app.listen(port, () => {
  console.log(`Claude Code 사용량 대시보드: http://localhost:${port}`);
  console.log(`OTLP 수신 주소 (http/json): http://localhost:${port}/v1/logs`);
});
