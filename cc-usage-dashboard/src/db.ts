import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve(process.cwd(), "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

// Node 내장 SQLite 사용 (네이티브 모듈 설치 불필요, Node 22.13+)
export const db = new DatabaseSync(path.join(DATA_DIR, "usage.db"));
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
CREATE TABLE IF NOT EXISTS requests (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                    INTEGER NOT NULL,
  day_key               TEXT    NOT NULL,
  month_key             TEXT    NOT NULL,
  hour_key              TEXT    NOT NULL,
  project               TEXT    NOT NULL,
  model                 TEXT    NOT NULL,
  session_id            TEXT,
  user_email            TEXT,
  cost_usd              REAL    NOT NULL DEFAULT 0,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_req_day   ON requests(day_key, project);
CREATE INDEX IF NOT EXISTS idx_req_month ON requests(month_key, project);
CREATE INDEX IF NOT EXISTS idx_req_hour  ON requests(hour_key);
CREATE INDEX IF NOT EXISTS idx_req_ts    ON requests(ts);

CREATE TABLE IF NOT EXISTS openai_calls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  day_key       TEXT    NOT NULL,
  hour_key      TEXT    NOT NULL,
  project       TEXT    NOT NULL,
  route         TEXT    NOT NULL,  -- gm, gm/memory, npc/image ...
  tag           TEXT    NOT NULL,  -- 호출 용도 (scene, talk, choices-redo ...), 없으면 빈 문자열
  model         TEXT    NOT NULL,
  ok            INTEGER NOT NULL DEFAULT 1,
  status        INTEGER NOT NULL DEFAULT 0,
  input_tokens  INTEGER NOT NULL DEFAULT 0,  -- cached 포함
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_oai_ts ON openai_calls(ts);

CREATE TABLE IF NOT EXISTS alerts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  scope      TEXT    NOT NULL,  -- 'global' 또는 프로젝트 이름
  period     TEXT    NOT NULL,  -- 'daily' | 'monthly'
  period_key TEXT    NOT NULL,  -- 2026-11-02 | 2026-11
  threshold  REAL    NOT NULL,  -- 0.5, 0.8, 1.0 ...
  spent      REAL    NOT NULL,
  budget     REAL    NOT NULL,
  UNIQUE(scope, period, period_key, threshold)
);
`);

export interface RequestRow {
  ts: number;
  day_key: string;
  month_key: string;
  hour_key: string;
  project: string;
  model: string;
  session_id: string | null;
  user_email: string | null;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  duration_ms: number;
}

const insertStmt = db.prepare(`
INSERT INTO requests (ts, day_key, month_key, hour_key, project, model, session_id, user_email,
  cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, duration_ms)
VALUES (@ts, @day_key, @month_key, @hour_key, @project, @model, @session_id, @user_email,
  @cost_usd, @input_tokens, @output_tokens, @cache_read_tokens, @cache_creation_tokens, @duration_ms)
`);

export function insertRequests(rows: RequestRow[]): void {
  db.exec("BEGIN");
  try {
    for (const row of rows) insertStmt.run({ ...row });
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
