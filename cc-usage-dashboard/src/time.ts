export interface TimeKeys {
  day: string; // 2026-11-02
  month: string; // 2026-11
  hour: string; // 2026-11-02 09
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

/** 설정한 시간대 기준으로 일/월/시 키를 만든다 (예산은 이 키 기준으로 리셋됨). */
export function timeKeys(tsMs: number, timeZone: string): TimeKeys {
  const parts = getFormatter(timeZone).formatToParts(new Date(tsMs));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  const y = get("year");
  const m = get("month");
  const d = get("day");
  const h = get("hour");
  return { day: `${y}-${m}-${d}`, month: `${y}-${m}`, hour: `${y}-${m}-${d} ${h}` };
}
