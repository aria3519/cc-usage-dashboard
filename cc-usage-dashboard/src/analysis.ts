import { db } from "./db.js";
import { getConfig } from "./config.js";
import { timeKeys } from "./time.js";
import { latestSnapshot, type Snapshot, type LimitWindow } from "./limits.js";

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const WINDOW_MS: Record<LimitWindow, number> = { five_hour: 5 * MS_PER_HOUR, seven_day: 7 * MS_PER_DAY };
const RECENT_RATE_MS = 60 * MS_PER_MINUTE; // 최근 소진 속도 계산 구간
const MIN_RATE_SPAN_MS = 10 * MS_PER_MINUTE; // 이보다 짧으면 최근 속도 대신 평균 속도 사용
const HEATMAP_DAYS = 28;
const DAYS_IN_WEEK = 7;
const HOURS_IN_DAY = 24;
const TOP_SESSIONS = 15;
const HISTORY_DAYS = 7;
const MAX_HISTORY_POINTS = 600;
const PERCENT = 100;
const WEEKDAY_LABELS = ["월", "화", "수", "목", "금", "토", "일"];

// ───────────────────────── 공통 집계 ─────────────────────────
export interface Totals {
  cost: number;
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  tokens: number;
}

const TOTALS_SELECT = `
  COALESCE(SUM(cost_usd),0)              AS cost,
  COUNT(*)                               AS requests,
  COALESCE(SUM(input_tokens),0)          AS input,
  COALESCE(SUM(output_tokens),0)         AS output,
  COALESCE(SUM(cache_read_tokens),0)     AS cacheRead,
  COALESCE(SUM(cache_creation_tokens),0) AS cacheCreation,
  COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens),0) AS tokens`;

const totalsRange = db.prepare(`SELECT ${TOTALS_SELECT} FROM requests WHERE ts >= ? AND ts < ?`);
const projectRange = db.prepare(
  `SELECT project AS name, ${TOTALS_SELECT} FROM requests WHERE ts >= ? AND ts < ? GROUP BY project ORDER BY tokens DESC`,
);
const modelRange = db.prepare(
  `SELECT model AS name, ${TOTALS_SELECT} FROM requests WHERE ts >= ? AND ts < ? GROUP BY model ORDER BY tokens DESC`,
);
const dailyProjectByKey = db.prepare(`
  SELECT day_key AS day, project, ${TOTALS_SELECT}
  FROM requests WHERE day_key >= ? AND day_key <= ? GROUP BY day_key, project`);
const heatmapStmt = db.prepare(`
  SELECT day_key AS day, CAST(substr(hour_key, 12, 2) AS INTEGER) AS hour,
         COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens),0) AS tokens,
         COALESCE(SUM(cost_usd),0) AS cost
  FROM requests WHERE day_key >= ? GROUP BY day_key, hour`);
const sessionsStmt = db.prepare(`
  SELECT session_id, GROUP_CONCAT(DISTINCT project) AS project, MIN(ts) AS start, MAX(ts) AS end, ${TOTALS_SELECT}
  FROM requests WHERE day_key >= ? AND session_id IS NOT NULL
  GROUP BY session_id ORDER BY tokens DESC LIMIT ?`);
const snapsSince = db.prepare(`
  SELECT ts, five_pct, five_reset, seven_pct, seven_reset FROM limit_snapshots WHERE ts >= ? ORDER BY ts`);

function totals(from: number, to: number): Totals {
  return totalsRange.get(from, to) as unknown as Totals;
}

/** 캐시에서 읽어온 입력의 비율 — 높을수록 같은 내용을 싸게 다시 읽는 중 */
function cacheHitRatio(t: Totals): number | null {
  const inputSide = t.input + t.cacheRead + t.cacheCreation;
  return inputSide > 0 ? t.cacheRead / inputSide : null;
}

// ───────────────────────── 날짜 키 계산 ─────────────────────────
function parseDayKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function formatDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDays(key: string, n: number): string {
  const d = parseDayKey(key);
  d.setUTCDate(d.getUTCDate() + n);
  return formatDayKey(d);
}
/** 월=0 … 일=6 */
function weekdayIndex(key: string): number {
  return (parseDayKey(key).getUTCDay() + 6) % DAYS_IN_WEEK;
}

// ───────────────────────── 한도 창 분석 ─────────────────────────
interface WindowAnalysis {
  window: LimitWindow;
  source: "official" | "rolling"; // official = 상태줄로 받은 공식 한도, rolling = 한도 정보 없어서 최근 N시간
  usedPct: number | null;
  resetsAt: number | null;
  windowStart: number;
  windowEnd: number;
  snapshotAge: number | null; // 마지막 공식 수치를 받은 뒤 지난 시간(ms)
  ratePctPerHour: number | null;
  rateBasis: "recent" | "average" | null;
  projectedAtReset: number | null;
  exhaustAt: number | null; // 이 속도면 100%가 되는 시각 (리셋 전일 때만)
  tokensPerPct: number | null;
  totals: Totals;
  cacheHit: number | null;
  byProject: (Totals & { name: string })[];
  byModel: (Totals & { name: string })[];
}

function analyzeWindow(w: LimitWindow, snap: Snapshot | null, now: number): WindowAnalysis {
  const pctKey = w === "five_hour" ? "five_pct" : "seven_pct";
  const resetKey = w === "five_hour" ? "five_reset" : "seven_reset";
  const reset = snap?.[resetKey] ?? null;
  const official = snap !== null && reset !== null && snap[pctKey] !== null && reset > now;

  const windowEnd = official ? reset! : now;
  const windowStart = windowEnd - WINDOW_MS[w];
  const usedPct = official ? snap![pctKey] : null;
  const t = totals(windowStart, now + 1);

  let rate: number | null = null;
  let rateBasis: WindowAnalysis["rateBasis"] = null;
  if (official && usedPct !== null) {
    // 같은 창(같은 리셋 시각)의 최근 1시간 스냅샷으로 속도 계산
    const snaps = (snapsSince.all(now - RECENT_RATE_MS) as unknown as Snapshot[]).filter(
      (s) => s[resetKey] === reset && s[pctKey] !== null,
    );
    if (snaps.length >= 2) {
      const first = snaps[0];
      const last = snaps[snaps.length - 1];
      const span = last.ts - first.ts;
      if (span >= MIN_RATE_SPAN_MS) {
        rate = ((last[pctKey]! - first[pctKey]!) / span) * MS_PER_HOUR;
        rateBasis = "recent";
      }
    }
    if (rate === null) {
      // 창이 시작될 때 0% 였다고 보고 평균 속도 계산
      const elapsed = Math.max(snap!.ts - windowStart, MS_PER_MINUTE);
      rate = (usedPct / elapsed) * MS_PER_HOUR;
      rateBasis = "average";
    }
  }

  let projectedAtReset: number | null = null;
  let exhaustAt: number | null = null;
  if (rate !== null && usedPct !== null) {
    const hoursLeft = (windowEnd - now) / MS_PER_HOUR;
    projectedAtReset = Math.max(usedPct, usedPct + rate * hoursLeft);
    if (rate > 0 && usedPct < PERCENT) {
      const at = now + ((PERCENT - usedPct) / rate) * MS_PER_HOUR;
      if (at < windowEnd) exhaustAt = at;
    }
  }

  return {
    window: w,
    source: official ? "official" : "rolling",
    usedPct,
    resetsAt: official ? reset : null,
    windowStart,
    windowEnd,
    snapshotAge: snap ? now - snap.ts : null,
    ratePctPerHour: rate,
    rateBasis,
    projectedAtReset,
    exhaustAt,
    tokensPerPct: usedPct && usedPct >= 1 ? t.tokens / usedPct : null,
    totals: t,
    cacheHit: cacheHitRatio(t),
    byProject: projectRange.all(windowStart, now + 1) as unknown as (Totals & { name: string })[],
    byModel: modelRange.all(windowStart, now + 1) as unknown as (Totals & { name: string })[],
  };
}

// ───────────────────────── 주간 분석 ─────────────────────────
type DayRow = Totals & { day: string; project: string };

function emptyTotals(): Totals {
  return { cost: 0, requests: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, tokens: 0 };
}
function addInto(a: Totals, b: Totals): void {
  a.cost += b.cost;
  a.requests += b.requests;
  a.input += b.input;
  a.output += b.output;
  a.cacheRead += b.cacheRead;
  a.cacheCreation += b.cacheCreation;
  a.tokens += b.tokens;
}
function changeRatio(cur: number, prev: number): number | null {
  return prev > 0 ? (cur - prev) / prev : null;
}

function analyzeWeek(todayKey: string) {
  const todayIdx = weekdayIndex(todayKey);
  const monday = addDays(todayKey, -todayIdx);
  const lastMonday = addDays(monday, -DAYS_IN_WEEK);
  const sunday = addDays(monday, DAYS_IN_WEEK - 1);
  const thisDays = Array.from({ length: DAYS_IN_WEEK }, (_, i) => addDays(monday, i));
  const lastDays = Array.from({ length: DAYS_IN_WEEK }, (_, i) => addDays(lastMonday, i));

  const rows = dailyProjectByKey.all(lastMonday, sunday) as unknown as DayRow[];
  const perDay = new Map<string, Totals>();
  const projectsThis = new Map<string, Totals>();
  const projectDays = new Map<string, number[]>(); // 프로젝트별 이번 주 일별 토큰
  for (const r of rows) {
    if (!perDay.has(r.day)) perDay.set(r.day, emptyTotals());
    addInto(perDay.get(r.day)!, r);
    if (r.day >= monday) {
      if (!projectsThis.has(r.project)) projectsThis.set(r.project, emptyTotals());
      addInto(projectsThis.get(r.project)!, r);
      if (!projectDays.has(r.project)) projectDays.set(r.project, new Array(DAYS_IN_WEEK).fill(0));
      projectDays.get(r.project)![weekdayIndex(r.day)] += r.tokens;
    }
  }

  const sumDays = (keys: string[]) => {
    const t = emptyTotals();
    for (const k of keys) if (perDay.has(k)) addInto(t, perDay.get(k)!);
    return t;
  };
  const thisWeek = sumDays(thisDays);
  const lastWeek = sumDays(lastDays);
  // 공정한 비교: 지난주도 같은 요일까지만
  const lastWeekSamePeriod = sumDays(lastDays.slice(0, todayIdx + 1));
  const daysElapsed = todayIdx + 1;

  return {
    monday,
    sunday,
    todayIndex: todayIdx,
    labels: WEEKDAY_LABELS,
    thisDays,
    lastDays,
    thisDaily: thisDays.map((k) => perDay.get(k) ?? emptyTotals()),
    lastDaily: lastDays.map((k) => perDay.get(k) ?? emptyTotals()),
    thisWeek,
    lastWeek,
    lastWeekSamePeriod,
    changeVsLastWeek: {
      tokens: changeRatio(thisWeek.tokens, lastWeekSamePeriod.tokens),
      cost: changeRatio(thisWeek.cost, lastWeekSamePeriod.cost),
      requests: changeRatio(thisWeek.requests, lastWeekSamePeriod.requests),
    },
    dailyAverage: { tokens: thisWeek.tokens / daysElapsed, cost: thisWeek.cost / daysElapsed },
    projectedWeek: {
      tokens: (thisWeek.tokens / daysElapsed) * DAYS_IN_WEEK,
      cost: (thisWeek.cost / daysElapsed) * DAYS_IN_WEEK,
    },
    cacheHit: { thisWeek: cacheHitRatio(thisWeek), lastWeek: cacheHitRatio(lastWeek) },
    byProject: [...projectsThis]
      .map(([name, t]) => ({ name, ...t, daily: projectDays.get(name) ?? [] }))
      .sort((a, b) => b.tokens - a.tokens),
  };
}

// ───────────────────────── 시간대 히트맵 ─────────────────────────
function analyzeHeatmap(todayKey: string) {
  const since = addDays(todayKey, -(HEATMAP_DAYS - 1));
  const rows = heatmapStmt.all(since) as unknown as { day: string; hour: number; tokens: number; cost: number }[];
  const grid = Array.from({ length: DAYS_IN_WEEK }, () => new Array(HOURS_IN_DAY).fill(0));
  const hourTotals = new Array(HOURS_IN_DAY).fill(0);
  const dayTotals = new Array(DAYS_IN_WEEK).fill(0);
  for (const r of rows) {
    const d = weekdayIndex(r.day);
    grid[d][r.hour] += r.tokens;
    hourTotals[r.hour] += r.tokens;
    dayTotals[d] += r.tokens;
  }
  return { days: HEATMAP_DAYS, labels: WEEKDAY_LABELS, grid, hourTotals, dayTotals };
}

// ───────────────────────── 한도 추이 ─────────────────────────
function limitHistory(now: number) {
  const rows = snapsSince.all(now - HISTORY_DAYS * MS_PER_DAY) as unknown as Snapshot[];
  const step = Math.max(1, Math.ceil(rows.length / MAX_HISTORY_POINTS));
  const points = rows.filter((_, i) => i % step === 0 || i === rows.length - 1);
  return points.map((r) => ({ ts: r.ts, five: r.five_pct, seven: r.seven_pct }));
}

// ───────────────────────── 한 줄 인사이트 ─────────────────────────
function pctText(r: number): string {
  return `${r >= 0 ? "+" : ""}${Math.round(r * PERCENT)}%`;
}

function buildInsights(
  five: WindowAnalysis,
  seven: WindowAnalysis,
  week: ReturnType<typeof analyzeWeek>,
  heat: ReturnType<typeof analyzeHeatmap>,
  tz: string,
): string[] {
  const out: string[] = [];
  const time = (ms: number) =>
    new Date(ms).toLocaleString("ko-KR", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit" });

  for (const w of [five, seven]) {
    const label = w.window === "five_hour" ? "5시간 한도" : "주간 한도";
    if (w.exhaustAt) out.push(`⚠️ 지금 속도면 ${label}가 ${time(w.exhaustAt)}쯤 소진돼요. 리셋은 ${time(w.resetsAt!)}이에요.`);
    else if (w.projectedAtReset !== null && w.resetsAt)
      out.push(`${label}: ${time(w.resetsAt)} 리셋 전까지 이 속도면 약 ${Math.round(w.projectedAtReset)}%에서 끝나요.`);
  }

  const ch = week.changeVsLastWeek.tokens;
  if (ch !== null) out.push(`이번 주 토큰은 지난주 같은 기간보다 ${pctText(ch)} ${ch >= 0 ? "많아요" : "적어요"}.`);

  const top = week.byProject[0];
  if (top && week.thisWeek.tokens > 0) {
    out.push(`이번 주 가장 많이 쓴 프로젝트는 ${top.name} (토큰의 ${Math.round((top.tokens / week.thisWeek.tokens) * PERCENT)}%).`);
  }

  const peakHour = heat.hourTotals.indexOf(Math.max(...heat.hourTotals));
  if (heat.hourTotals[peakHour] > 0) out.push(`최근 4주 동안 가장 많이 쓴 시간대는 ${peakHour}시~${peakHour + 1}시예요.`);

  const { thisWeek: cThis, lastWeek: cLast } = week.cacheHit;
  if (cThis !== null) {
    let s = `이번 주 캐시 적중률 ${Math.round(cThis * PERCENT)}%`;
    if (cLast !== null) s += ` (지난주 ${Math.round(cLast * PERCENT)}%)`;
    s += cThis < 0.7 ? " — 작업이 바뀔 때 /clear 하면 더 올라가요." : ".";
    out.push(s);
  }

  const opus = seven.byModel.filter((m) => /opus/i.test(m.name)).reduce((a, m) => a + m.tokens, 0);
  if (seven.totals.tokens > 0 && opus / seven.totals.tokens > 0.5) {
    out.push(`최근 7일 토큰의 ${Math.round((opus / seven.totals.tokens) * PERCENT)}%가 Opus예요. 간단한 작업은 Sonnet으로 바꾸면 한도가 덜 줄어요.`);
  }
  return out;
}

// ───────────────────────── 진입점 ─────────────────────────
export function buildAnalysis() {
  const cfg = getConfig();
  const now = Date.now();
  const todayKey = timeKeys(now, cfg.timezone).day;
  const snap = latestSnapshot();

  const five = analyzeWindow("five_hour", snap, now);
  const seven = analyzeWindow("seven_day", snap, now);
  const week = analyzeWeek(todayKey);
  const heatmap = analyzeHeatmap(todayKey);
  const lastHour = totals(now - MS_PER_HOUR, now + 1);

  return {
    now,
    timezone: cfg.timezone,
    krwPerUsd: cfg.krwPerUsd,
    hasOfficialLimits: snap !== null,
    latestSnapshot: snap,
    five,
    seven,
    lastHour,
    week,
    heatmap,
    sessions: sessionsStmt.all(week.monday, TOP_SESSIONS),
    history: limitHistory(now),
    insights: buildInsights(five, seven, week, heatmap, cfg.timezone),
  };
}
