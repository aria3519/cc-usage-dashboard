// 테스트용: 가짜 Claude Code api_request 이벤트를 대시보드로 보낸다.
// 사용법: node scripts/send-sample.mjs [개수]
const ENDPOINT = process.env.ENDPOINT ?? "http://localhost:4318/v1/logs";
const COUNT = Number(process.argv[2] ?? 20);
const PROJECTS = ["STB", "AIO", "MazeRush"];
const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
const SPREAD_MS = 3 * 24 * 3600 * 1000; // 최근 3일에 흩뿌림

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const s = (key, v) => ({ key, value: { stringValue: String(v) } });

const byProject = new Map();
for (let i = 0; i < COUNT; i++) {
  const project = pick(PROJECTS);
  const model = pick(MODELS);
  const ts = Date.now() - Math.floor(Math.random() * SPREAD_MS);
  const rec = {
    timeUnixNano: String(BigInt(ts) * 1_000_000n),
    body: { stringValue: "claude_code.api_request" },
    attributes: [
      s("event.name", "api_request"),
      s("model", model),
      s("cost_usd", (Math.random() * 0.6).toFixed(4)),
      s("duration_ms", 2000 + Math.floor(Math.random() * 20000)),
      s("input_tokens", Math.floor(Math.random() * 8000)),
      s("output_tokens", Math.floor(Math.random() * 3000)),
      s("cache_read_tokens", Math.floor(Math.random() * 60000)),
      s("cache_creation_tokens", Math.floor(Math.random() * 5000)),
      s("session.id", "sample-session"),
    ],
  };
  if (!byProject.has(project)) byProject.set(project, []);
  byProject.get(project).push(rec);
}

const payload = {
  resourceLogs: [...byProject].map(([project, logRecords]) => ({
    resource: { attributes: [s("service.name", "claude-code"), s("project", project)] },
    scopeLogs: [{ scope: { name: "com.anthropic.claude_code.events" }, logRecords }],
  })),
};

const res = await fetch(ENDPOINT, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
console.log(res.status, await res.text());
