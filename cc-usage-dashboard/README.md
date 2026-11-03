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

## 4. 공식 한도(/usage) 연결 — 상태줄

Pro/Max 구독이면 Claude Code가 상태줄 스크립트에 **5시간·주간 한도 사용률(%)과 리셋 시각**을 넘겨줍니다.
`statusline/statusline.mjs`가 이 값을 대시보드로 보내고, Claude Code 하단에도 한 줄로 보여줍니다.

`settings.json`에 `statusLine`을 추가하세요. 경로는 이 폴더를 푼 실제 위치로 바꾸고, 슬래시(`/`)로 쓰세요.

```json
{
  "statusLine": {
    "type": "command",
    "command": "node F:/github/cc-usage-dashboard/cc-usage-dashboard/statusline/statusline.mjs"
  }
}
```

Claude Code를 재시작하고 질문을 하나 하면 하단에 이렇게 나옵니다.

```
Opus 5.5 │ 5h 52% (2시간 9분 후 리셋) │ 주간 63% │ 컨텍스트 34% │ 세션 $1.23
```

- 한도 값은 세션의 첫 응답 이후부터 들어옵니다. API 키(종량제)로 쓰면 한도 정보가 없어서 토큰 분석만 표시됩니다.
- 대시보드가 꺼져 있어도 상태줄은 정상 표시됩니다 (전송만 건너뜀).
- 이미 다른 상태줄(예: 플러그인이 넣은 것)이 있으면 이걸로 바뀝니다.

## 5. 사용량 분석 페이지

상단의 **사용량 분석** 탭(http://localhost:4318/usage.html)에서 볼 수 있는 것:

- **5시간 / 주간 한도**: 공식 사용률, 리셋까지 남은 시간, 소진 속도(%/시간), 이 속도면 리셋 때 몇 %일지, 리셋 전 소진 예상 시각
- **한도 사용률 추이**: 최근 7일 동안의 5시간·주간 % 그래프
- **이번 주 vs 지난주**: 토큰·비용·요청 수와 지난주 같은 요일까지 대비 증감, 이 속도면 이번 주 총량
- **토큰 구성**: 캐시 읽기·입력·캐시 생성·출력 비율
- **프로젝트별 / 모델별**: 비중과 요일별 미니 그래프
- **시간대 히트맵**: 최근 4주 요일 × 시간대별 사용량
- **세션 순위**: 이번 주 토큰을 많이 쓴 세션, 요청당 토큰과 캐시 적중률
- **한눈에 보기**: 위 내용을 문장으로 요약 (소진 경고, 많이 쓴 프로젝트, 캐시 적중률 등)

한도가 `limitAlertThresholds` 단계(기본 50% / 80% / 95%)를 넘으면 브라우저와 Discord로 알림이 갑니다.

## 6. 예산 & 알림 설정 — `config.json`

서버를 재시작하지 않아도 저장하면 바로 반영됩니다.

| 키 | 설명 |
|---|---|
| `budgets.global.daily / monthly` | 전체 일일·월간 예산 (USD) |
| `budgets.projects.<이름>` | 프로젝트별 예산. 이름은 `project=` 값과 같아야 함 |
| `alertThresholds` | 예산 알림 단계. 기본 50% / 80% / 100% |
| `limitAlertThresholds` | 공식 한도(5시간·주간) 알림 단계. 기본 50% / 80% / 95% |
| `discordWebhookUrl` | 넣으면 알림을 Discord 채널로도 보냄 (비우면 끔) |
| `timezone` | 하루/한 달 경계 기준 시간대 (기본 Asia/Seoul) |
| `krwPerUsd` | 원화 표시용 환율 |
| `port` | 서버 포트 (바꾸면 settings.json의 엔드포인트도 같이 변경) |

같은 기간·같은 단계 알림은 한 번만 갑니다. 한 번에 여러 단계를 넘으면 가장 높은 단계만 보냅니다.

## 7. 테스트

서버를 켠 상태에서 가짜 데이터를 넣어볼 수 있습니다. (개수, 최근 며칠에 흩뿌릴지)

```powershell
node scripts/send-sample.mjs 300 14
```

데이터를 초기화하려면 서버를 끄고 `data` 폴더를 지우면 됩니다.

## 참고

- `cost_usd` 는 Claude Code가 계산한 **API 정가 기준 추정치**입니다. Pro/Max 구독이라면 실제 청구액이 아니라
  "API로 썼다면 이만큼"으로 보시면 됩니다. 구독 사용자는 토큰 수와 요청 수가 더 실질적인 지표예요.
- 팀원 사용량을 모으려면 서버를 공유 PC에서 띄우고 각자 `OTEL_EXPORTER_OTLP_ENDPOINT` 를 그 PC 주소로 바꾸면 됩니다.
  이 경우 외부에 노출되지 않도록 사내망에서만 쓰세요 (인증이 없습니다).
- 데이터는 `data/usage.db` (SQLite) 하나에 저장됩니다.
