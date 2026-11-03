import { db, type RequestRow } from "./db.js";
import { getConfig, type Budget } from "./config.js";

export type Period = "daily" | "monthly";
export const GLOBAL_SCOPE = "global";

export interface AlertRow {
  id: number;
  ts: number;
  scope: string; // 'global' | 프로젝트 이름 | 'limit'(구독 한도)
  period: string; // 'daily' | 'monthly' | 'five_hour' | 'seven_day'
  period_key: string;
  threshold: number;
  spent: number;
  budget: number;
}

const spentDayGlobal = db.prepare(`SELECT COALESCE(SUM(cost_usd),0) AS s FROM requests WHERE day_key = ?`);
const spentMonthGlobal = db.prepare(`SELECT COALESCE(SUM(cost_usd),0) AS s FROM requests WHERE month_key = ?`);
const spentDayProject = db.prepare(`SELECT COALESCE(SUM(cost_usd),0) AS s FROM requests WHERE day_key = ? AND project = ?`);
const spentMonthProject = db.prepare(`SELECT COALESCE(SUM(cost_usd),0) AS s FROM requests WHERE month_key = ? AND project = ?`);
const insertAlert = db.prepare(`
INSERT OR IGNORE INTO alerts (ts, scope, period, period_key, threshold, spent, budget)
VALUES (?, ?, ?, ?, ?, ?, ?)`);

export function getSpent(scope: string, period: Period, periodKey: string): number {
  const isGlobal = scope === GLOBAL_SCOPE;
  const stmt =
    period === "daily"
      ? isGlobal ? spentDayGlobal : spentDayProject
      : isGlobal ? spentMonthGlobal : spentMonthProject;
  const row = (isGlobal ? stmt.get(periodKey) : stmt.get(periodKey, scope)) as unknown as { s: number };
  return row.s;
}

export function getBudget(scope: string): Budget | undefined {
  const { budgets } = getConfig();
  return scope === GLOBAL_SCOPE ? budgets.global : budgets.projects[scope];
}

function percentLabel(threshold: number): string {
  return `${Math.round(threshold * 100)}%`;
}

export async function sendDiscord(text: string): Promise<void> {
  const url = getConfig().discordWebhookUrl;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text }),
    });
  } catch (err) {
    console.warn(`[alert] Discord 전송 실패: ${(err as Error).message}`);
  }
}

/** 새로 들어온 요청이 건드린 범위(전체 + 해당 프로젝트)의 예산 임계치를 확인한다. */
export function checkBudgets(rows: RequestRow[]): AlertRow[] {
  const { alertThresholds, krwPerUsd } = getConfig();
  const thresholds = [...alertThresholds].sort((a, b) => a - b);

  // 이번 배치에서 확인해야 할 (scope, period, key) 조합
  const targets = new Set<string>();
  for (const r of rows) {
    for (const scope of [GLOBAL_SCOPE, r.project]) {
      targets.add(`${scope}\u0000daily\u0000${r.day_key}`);
      targets.add(`${scope}\u0000monthly\u0000${r.month_key}`);
    }
  }

  const fired: AlertRow[] = [];
  for (const t of targets) {
    const [scope, period, periodKey] = t.split("\u0000") as [string, Period, string];
    const limit = getBudget(scope)?.[period];
    if (!limit || limit <= 0) continue;

    const spent = getSpent(scope, period, periodKey);
    // 새로 넘은 임계치는 모두 기록하되, 알림은 가장 높은 단계 하나만 보낸다.
    let highest: AlertRow | null = null;
    for (const threshold of thresholds) {
      if (spent < limit * threshold) continue;
      const now = Date.now();
      const res = insertAlert.run(now, scope, period, periodKey, threshold, spent, limit);
      if (res.changes === 0) continue; // 이미 보낸 알림
      highest = {
        id: Number(res.lastInsertRowid),
        ts: now,
        scope,
        period,
        period_key: periodKey,
        threshold,
        spent,
        budget: limit,
      };
    }

    if (highest) {
      const { threshold } = highest;
      fired.push(highest);

      const scopeLabel = scope === GLOBAL_SCOPE ? "전체" : scope;
      const periodLabel = period === "daily" ? "일일" : "월간";
      const krw = Math.round(spent * krwPerUsd).toLocaleString("ko-KR");
      const msg =
        `⚠️ [Claude Code] ${scopeLabel} ${periodLabel} 예산 ${percentLabel(threshold)} 도달 ` +
        `— $${spent.toFixed(2)} / $${limit.toFixed(2)} (약 ${krw}원, ${periodKey})`;
      console.log(`[alert] ${msg}`);
      void sendDiscord(msg);
    }
  }
  return fired;
}
