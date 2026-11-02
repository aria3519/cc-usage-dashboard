# Claude Code 사용량 대시보드

Claude Code가 보내는 OpenTelemetry 이벤트(`claude_code.api_request`)를 받아서
**실시간 비용·토큰 집계, 프로젝트별 분리, 예산 알림, 그래프**를 보여주는 로컬 서버입니다.

```
Claude Code ──(OTLP http/json, 5초마다)──▶ localhost:4318/v1/logs ──▶ SQLite ──▶ 대시보드 (SSE 실시간 갱신)
                                                                  └─▶ 예산 체크 ─▶ 브라우저 알림 / Discord
```

## 1. 설치 & 실행

Node.js 22.13 이상이 필요합니다 (Node 내장 SQLite를 사용하므로 Python·빌드 도구는 필요 없음).
Node 22에서는 시작할 때 `ExperimentalWarning: SQLite ...` 경고가 나올 수 있는데 무시해도 됩니다.

```powershell
cd cc-usage-dashboard
npm install
npm start
```

브라우저에서 http://localhost:4318 을 엽니다. 페이지를 한 번 클릭하면 데스크톱 알림 권한을 물어봅니다.

## 2. Claude Code 연결 (한 번만)

`%USERPROFILE%\.claude\settings.json` (맥/리눅스는 `~/.claude/settings.json`)에 `env`를 추가하세요.
이미 다른 설정이 있다면 `env` 블록만 합치면 됩니다.

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://localhost:4318",
    "OTEL_LOGS_EXPORT_INTERVAL": "5000"
  }
}
```

> `OTEL_EXPORTER_OTLP_PROTOCOL` 은 반드시 `http/json` 이어야 합니다 (protobuf/gRPC는 받지 않음).

Claude Code를 새로 시작하고 아무 요청이나 하면 5초 안에 대시보드에 찍힙니다.

## 3. 프로젝트별로 나누기

각 프로젝트 폴더의 `.claude/settings.local.json` 에 프로젝트 이름만 덮어쓰면 됩니다.
(`settings.local.json` 은 보통 git에 안 올라가서 팀원 설정과 안 섞입니다.)

```json
// STB 레포/.claude/settings.local.json
{ "env": { "OTEL_RESOURCE_ATTRIBUTES": "project=STB" } }
```

```json
// AIO_Test1/.claude/settings.local.json
{ "env": { "OTEL_RESOURCE_ATTRIBUTES": "project=AIO" } }
```

- 이름은 영문·숫자로, 공백 없이 쓰세요 (`project=Spear the Brainrots` ✗ → `project=STB` ✓).
- 지정 안 한 폴더에서 쓴 사용량은 대시보드에서 `미지정`으로 모입니다.

## 4. 예산 & 알림 설정 — `config.json`

서버를 재시작하지 않아도 저장하면 바로 반영됩니다.

| 키 | 설명 |
|---|---|
| `budgets.global.daily / monthly` | 전체 일일·월간 예산 (USD) |
| `budgets.projects.<이름>` | 프로젝트별 예산. 이름은 `project=` 값과 같아야 함 |
| `alertThresholds` | 알림 단계. 기본 50% / 80% / 100% |
| `discordWebhookUrl` | 넣으면 알림을 Discord 채널로도 보냄 (비우면 끔) |
| `timezone` | 하루/한 달 경계 기준 시간대 (기본 Asia/Seoul) |
| `krwPerUsd` | 원화 표시용 환율 |
| `port` | 서버 포트 (바꾸면 settings.json의 엔드포인트도 같이 변경) |

같은 기간·같은 단계 알림은 한 번만 갑니다. 한 번에 여러 단계를 넘으면 가장 높은 단계만 보냅니다.

## 5. 테스트

서버를 켠 상태에서 가짜 데이터를 넣어볼 수 있습니다.

```powershell
node scripts/send-sample.mjs 50
```

데이터를 초기화하려면 서버를 끄고 `data` 폴더를 지우면 됩니다.

## 참고

- `cost_usd` 는 Claude Code가 계산한 **API 정가 기준 추정치**입니다. Pro/Max 구독이라면 실제 청구액이 아니라
  "API로 썼다면 이만큼"으로 보시면 됩니다. 구독 사용자는 토큰 수와 요청 수가 더 실질적인 지표예요.
- 팀원 사용량을 모으려면 서버를 공유 PC에서 띄우고 각자 `OTEL_EXPORTER_OTLP_ENDPOINT` 를 그 PC 주소로 바꾸면 됩니다.
  이 경우 외부에 노출되지 않도록 사내망에서만 쓰세요 (인증이 없습니다).
- 데이터는 `data/usage.db` (SQLite) 하나에 저장됩니다.
