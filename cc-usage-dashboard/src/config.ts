import fs from "node:fs";
import path from "node:path";

export interface Budget {
  daily?: number;
  monthly?: number;
}

export interface AppConfig {
  port: number;
  timezone: string;
  krwPerUsd: number;
  alertThresholds: number[];
  discordWebhookUrl: string;
  budgets: {
    global: Budget;
    projects: Record<string, Budget>;
  };
}

const CONFIG_PATH = path.resolve(process.cwd(), "config.json");

const DEFAULT_CONFIG: AppConfig = {
  port: 4318,
  timezone: "Asia/Seoul",
  krwPerUsd: 1400,
  alertThresholds: [0.5, 0.8, 1.0],
  discordWebhookUrl: "",
  budgets: { global: {}, projects: {} },
};

let cached: AppConfig = DEFAULT_CONFIG;
let cachedMtimeMs = -1;

/** config.json 을 읽는다. 파일이 바뀌면 서버 재시작 없이 다시 읽는다. */
export function getConfig(): AppConfig {
  try {
    const stat = fs.statSync(CONFIG_PATH);
    if (stat.mtimeMs !== cachedMtimeMs) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      cached = {
        ...DEFAULT_CONFIG,
        ...raw,
        budgets: {
          global: raw?.budgets?.global ?? {},
          projects: raw?.budgets?.projects ?? {},
        },
      };
      cachedMtimeMs = stat.mtimeMs;
    }
  } catch (err) {
    if (cachedMtimeMs === -1) {
      console.warn(`[config] config.json 을 읽지 못해 기본값을 씁니다: ${(err as Error).message}`);
      cachedMtimeMs = 0;
    }
  }
  return cached;
}
