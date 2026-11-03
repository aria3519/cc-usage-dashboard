import path from "node:path";
import { db } from "./db.js";
import { getConfig } from "./config.js";
import { sendDiscord, type AlertRow } from "./budget.js";

/**
 * Claude Code 상태줄(statusLine)이 stdin 으로 받는 JSON 의 일부.
 * rate_limits 는 Pro/Max 구독에서만, 세션의 첫 응답 이후에만 들어온다.
 */
interface StatuslineInput {
  session_id?: string;
  model?: { id?: string; display_name?: string };
  workspace?: { current_dir?: string; project_dir?: string };
  cwd?: string;
  cost?: { total_cost_usd?: number };
  context_window?: { used_percentage?: number | null };
  rate_limits?: {
    five_hour?: { used_percentage?: number; resets_at?: number | string };
    seven_day?: { used_percentage?: number; resets_at?: number | string };
  };
}

export type LimitWindow = "five_hour" | "seven_day";
export const LIMIT_SCOPE = "limit";

export interface Snapshot {
  ts: number;
  five_pct: number | null;
  five_reset: number | null;
  seven_pct: number | null;
  seven_reset: number | null;
  session_id: string | null;
  project: string | null;
  model: string | null;
  context_pct: number | null;
  session_cost: number | null;
}

const MS_PER_SECOND = 1000;
const EPOCH_MS_THRESHOLD = 1e12; // 이보다 작으면 초 단위로 본다
const SNAPSHOT_MIN_INTERVAL_MS = 60_000; // 값이 같으면 1분에 한 번만 저장
const PERCENT = 100;

db.exec(`
CREATE TABLE IF NOT EXISTS limit_snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  five_pct     REAL,
  five_reset   INTEGER,
  seven_pct    REAL,
  seven_reset  INTEGER,
  session_id   TEXT,
  project      TEXT,
  model        TEXT,
  context_pct  REAL,
  session_cost REAL
);
CREATE INDEX IF NOT EXISTS idx_snap_ts ON limit_snapshots(ts);
`);

const insertSnap = db.prepare(`
INSERT INTO limit_snapshots (ts, five_pct, five_reset, seven_pct, seven_reset, session_id, project, model, context_pct, session_cost)
VALUES (@ts, @five_pct, @five_reset, @seven_pct, @seven_reset, @session_id, @project, @model, @context_pct, @session_cost)`);
const lastSnapStmt = db.prepare(`SELECT * FROM limit_snapshots WHERE five_pct IS NOT NULL OR seven_pct IS NOT NULL ORDER BY ts DESC LIMIT 1`);
const insertAlert = db.prepare(`
INSERT OR IGNORE INTO alerts (ts, scope, period, period_key, threshold, spent, budget)
VALUES (?, ?, ?, ?, ?, ?, ?)`);

function toEpochMs(v: number | string | undefined): number | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number") return v < EPOCH_MS_THRESHOLD ? v * MS_PER_SECOND : v;
  const asNum = Number(v);
  if (Number.isFinite(asNum)) return toEpochMs(asNum);
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function pct(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function latestSnapshot(): Snapshot | null {
  return (lastSnapStmt.get() as unknown as Snapshot | undefined) ?? null;
}

function sameValues(a: Snapshot, b: Snapshot): boolean {
  return (
    a.five_pct === b.five_pct &&
    a.seven_pct === b.seven_pct &&
    a.five_reset === b.five_reset &&
    a.seven_reset === b.seven_reset
  );
}

function windowLabel(w: LimitWindow): string {
  return w === "five_hour" ? "5시간" : "주간(7일)";
}

function formatReset(ms: number, tz: string): string {
  return new Date(ms).toLocaleString("ko-KR", {
    timeZone: tz,
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function checkLimitAlerts(snap: Snapshot): AlertRow[] {
  const { limitAlertThresholds, timezone } = getConfig();
  const thresholds = [...limitAlertThresholds].sort((a, b) => a - b);
  const fired: AlertRow[] = [];

  const windows: [LimitWindow, number | null, number | null][] = [
    ["five_hour", snap.five_pct, snap.five_reset],
    ["seven_day", snap.seven_pct, snap.seven_reset],
  ];
  for (const [w, used, reset] of windows) {
    if (used === null || reset === null) continue;
    let highest: AlertRow | null = null;
    for (const t of thresholds) {
      if (used < t * PERCENT) continue;
      // 리셋 시각이 곧 그 창의 고유 키 — 창이 바뀌면 다시 알림
      const res = insertAlert.run(snap.ts, LIMIT_SCOPE, w, String(reset), t, used, PERCENT);
      if (res.changes === 0) continue;
      highest = {
        id: Number(res.lastInsertRowid),
        ts: snap.ts,
        scope: LIMIT_SCOPE,
        period: w,
        period_key: String(reset),
        threshold: t,
        spent: used,
        budget: PERCENT,
      };
    }
    if (highest) {
      fired.push(highest);
      const msg =
        `⏳ [Claude Code] ${windowLabel(w)} 한도 ${Math.round(highest.threshold * PERCENT)}% 도달 ` +
        `— 현재 ${used.toFixed(0)}% 사용, ${formatReset(reset, timezone)} 리셋`;
      console.log(`[alert] ${msg}`);
      void sendDiscord(msg);
    }
  }
  return fired;
}

/** 상태줄 입력을 저장한다. 저장했으면 스냅샷을, 건너뛰었으면 null 을 돌려준다. */
export function recordStatusline(input: StatuslineInput): { snapshot: Snapshot | null; alerts: AlertRow[] } {
  const rl = input.rate_limits ?? {};
  const dir = input.workspace?.project_dir ?? input.workspace?.current_dir ?? input.cwd;
  const snap: Snapshot = {
    ts: Date.now(),
    five_pct: pct(rl.five_hour?.used_percentage),
    five_reset: toEpochMs(rl.five_hour?.resets_at),
    seven_pct: pct(rl.seven_day?.used_percentage),
    seven_reset: toEpochMs(rl.seven_day?.resets_at),
    session_id: input.session_id ?? null,
    project: dir ? path.basename(dir.replace(/[\\/]+$/, "")) : null,
    model: input.model?.display_name ?? input.model?.id ?? null,
    context_pct: pct(input.context_window?.used_percentage),
    session_cost: pct(input.cost?.total_cost_usd),
  };

  // 한도 정보가 없으면(API 키 사용, 세션 첫 응답 전) 저장하지 않는다
  if (snap.five_pct === null && snap.seven_pct === null) return { snapshot: null, alerts: [] };

  const last = latestSnapshot();
  if (last && sameValues(last, snap) && snap.ts - last.ts < SNAPSHOT_MIN_INTERVAL_MS) {
    return { snapshot: null, alerts: [] };
  }
  insertSnap.run({ ...snap });
  return { snapshot: snap, alerts: checkLimitAlerts(snap) };
}
