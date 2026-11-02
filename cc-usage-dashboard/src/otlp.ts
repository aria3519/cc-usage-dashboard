import type { RequestRow } from "./db.js";
import { timeKeys } from "./time.js";

/** OTLP/HTTP JSON 형식의 속성 값 (일부만 사용) */
interface AnyValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
}
interface KeyValue {
  key: string;
  value?: AnyValue;
}
interface LogRecord {
  timeUnixNano?: string | number;
  observedTimeUnixNano?: string | number;
  body?: AnyValue;
  attributes?: KeyValue[];
}
interface ResourceLogs {
  resource?: { attributes?: KeyValue[] };
  scopeLogs?: { logRecords?: LogRecord[] }[];
}
export interface OtlpLogsPayload {
  resourceLogs?: ResourceLogs[];
}

const API_REQUEST_EVENT = "api_request";
const API_REQUEST_BODY = "claude_code.api_request";
const PROJECT_ATTR = "project";
const UNASSIGNED_PROJECT = "미지정";
const NANOS_PER_MS = 1_000_000n;

function toPlain(v: AnyValue | undefined): string | number | boolean | undefined {
  if (!v) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  return undefined;
}

function toMap(attrs: KeyValue[] | undefined): Map<string, string | number | boolean> {
  const m = new Map<string, string | number | boolean>();
  for (const kv of attrs ?? []) {
    const v = toPlain(kv.value);
    if (v !== undefined) m.set(kv.key, v);
  }
  return m;
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string | null {
  return v === undefined || v === null || v === "" ? null : String(v);
}

function recordTimeMs(rec: LogRecord, attrs: Map<string, unknown>): number {
  const nano = rec.timeUnixNano ?? rec.observedTimeUnixNano;
  if (nano !== undefined && String(nano) !== "0") {
    try {
      return Number(BigInt(String(nano)) / NANOS_PER_MS);
    } catch {
      /* 아래로 진행 */
    }
  }
  const iso = attrs.get("event.timestamp");
  if (typeof iso === "string") {
    const t = Date.parse(iso);
    if (Number.isFinite(t)) return t;
  }
  return Date.now();
}

/** OTLP 로그 페이로드에서 Claude Code api_request 이벤트만 뽑아 DB 행으로 변환 */
export function extractApiRequests(payload: OtlpLogsPayload, timeZone: string): RequestRow[] {
  const rows: RequestRow[] = [];
  for (const rl of payload.resourceLogs ?? []) {
    const resource = toMap(rl.resource?.attributes);
    for (const sl of rl.scopeLogs ?? []) {
      for (const rec of sl.logRecords ?? []) {
        const attrs = toMap(rec.attributes);
        const eventName = attrs.get("event.name");
        const body = toPlain(rec.body);
        const isApiRequest = eventName === API_REQUEST_EVENT || body === API_REQUEST_BODY;
        if (!isApiRequest) continue;

        const ts = recordTimeMs(rec, attrs);
        const keys = timeKeys(ts, timeZone);
        const project =
          str(attrs.get(PROJECT_ATTR)) ?? str(resource.get(PROJECT_ATTR)) ?? UNASSIGNED_PROJECT;

        rows.push({
          ts,
          day_key: keys.day,
          month_key: keys.month,
          hour_key: keys.hour,
          project,
          model: str(attrs.get("model")) ?? "unknown",
          session_id: str(attrs.get("session.id")),
          user_email: str(attrs.get("user.email")),
          cost_usd: num(attrs.get("cost_usd")),
          input_tokens: num(attrs.get("input_tokens")),
          output_tokens: num(attrs.get("output_tokens")),
          cache_read_tokens: num(attrs.get("cache_read_tokens")),
          cache_creation_tokens: num(attrs.get("cache_creation_tokens")),
          duration_ms: num(attrs.get("duration_ms")),
        });
      }
    }
  }
  return rows;
}
