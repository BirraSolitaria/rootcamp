# rootcamp M4a «Песочницы: sandboxd, терминал, практика (dev, runc)» Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сервис `sandboxd` с планировщиком, очередью, сборщиком мусора, терминальным WebSocket и драйвером `runc-dev`, API практик в `api` и экран практики с терминалом. Всё работает и тестируется локально на Windows + Docker Desktop (WSL2) на образе `rc/test-shell`.

**Architecture:** `sandboxd` — единственный владелец `docker.sock`. Драйвер скрывает разницу между `sysbox` (M4b) и `runc-dev`; планировщик — чистая функция над строками `sandboxes`, цикл раз в 2 с. `api` знает контент и пользователя, `sandboxd` — только контейнеры: `api` передаёт ему скрипты и параметры по внутреннему REST и подписывает одноразовые билеты для терминала. Состояние запуска в `api` синхронизируется лениво (при `GET /api/runs/:id`) и фоновым заданием.

**Tech Stack:** Node 22, Fastify 5, @fastify/websocket, dockerode, Drizzle (`@rootcamp/db`), pg-boss (в `api`), `@xterm/xterm` 5, `@xterm/addon-fit`, `@xterm/addon-web-links`, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-20-rootcamp-design.md` (§3.1–3.2 sandboxd, §4.4 таблицы практик, §5.1 «Практика», §5.2, §5.3, §6.2, §6.5–6.7, §8.1 Практика, §8.3, §9, §10.2 sandboxd, §10.4 сценарий 5). Предыдущая веха: M3. Продолжение (Sysbox, образы, инциденты, VPS): `2026-10-20-rootcamp-m4b-sysbox-incidents.md`.

## Global Constraints

- Все Global Constraints из M1–M3.
- **Режим dev.** Драйвер `runc-dev` (обычный runc) включается `SANDBOX_DRIVER=runc-dev` и разрешён только при `NODE_ENV !== 'production'`; при нарушении `sandboxd` пишет ошибку и завершается с кодом 1 на старте. В `runc-dev` любой образ практики подменяется на `rc/test-shell` (Alpine + bash, tmux, coreutils, curl), systemd отсутствует, ожидание загрузки пропускается, сеть — `rc-sbx-dev` (`internal: true`, создаётся `sandboxd` при старте). **systemd-инциденты (`inc-nginx-down`, `inc-file-perms`), docker-in-docker (`inc-container-crash`), userns, зеркала и iptables полноценно проверяются только на VPS с Sysbox (M4b).**
- Ни при каком драйвере: `--privileged`, монтирование `docker.sock` или хостовых путей, `--cap-add`, `seccomp=unconfined`.
- Бюджет: RAM 5120 МБ, CPU 3.5, ≤ 1 `heavy`; очередь ≤ 10; `queue_timeout` через 20 мин; защита от голодания `heavy` через 10 мин; цикл 2 с; диск: старт только при ≥ 10 ГБ свободно, стоп при > 3 ГБ на песочницу.
- Классы: `light` 0.5 CPU/512 МБ/pids 512; `docker` 1.0/1536/2048; `heavy` 2.0/2560/4096. `--memory-swap = --memory`, `--ulimit nofile=4096:4096`, метки `rootcamp.sandbox=<id>`, `rootcamp.user=<userId>`, `--log-driver none`, имя `rc-sbx-<первые 8 символов id>`.
- Сроки: `expires_at = ready + timeoutMin`, `hard_deadline = ready + 90 мин`; продление +15 мин при ≤ 10 мин до конца, не позже `hard_deadline`; простой 10 мин; остановка решённой через 2 мин; `starting` старше 5 мин → `failed`; `docker stop -t 10` + `rm -v`.
- Пользователь: ≤ 1 песочница в `queued…ready`; квота 180 мин/сутки; создание запуска 6/ч; `check` 1 раз в 5 с; `hints` 10/мин; `reset` ≤ 3 за запуск.
- WS: билет HMAC-SHA256, 30 с, одноразовый (`jti` в памяти 2 мин); ≤ 2 соединения на песочницу; ввод ≤ 4 КБ/кадр; `resize` cols 20–400, rows 5–200; вывод буферизуется до 16 мс или 32 КБ, поток ≤ 1 МБ/с; ping клиента каждые 20 с; 60 с без кадров — закрытие; запись `last_activity_at` не чаще 30 с; `closed` → код `4000 + индекс причины` в порядке `expired, stopped_by_admin, stopped_by_user, sandbox_failed, reset, idle, solved, disk_quota, banned`.
- Внутренний API — только сеть `rc-internal`, заголовок `Authorization: Bearer <INTERNAL_TOKEN>`.

## Review Focus

1. Пользователь закрыл вкладку с терминалом и вернулся через 3 минуты — та же tmux-сессия с историей, песочница не убита как «простой» (тест в Task 6: переподключение после разрыва; Task 5: простой считается только при нуле соединений 10 мин).
2. Пользователь жмёт «Начать» дважды (двойной тап на телефоне) — создаётся один запуск, второй запрос получает `run_exists` с id первого (тест в Task 8).
3. `sandboxd` перезапустился, пока песочница `ready` и пользователь печатает — песочница подхватывается, клиент переподключается с новым билетом (тест в Task 5: reconcile на старте).
4. Скрипт проверки выводит мегабайт мусора или не-UTF-8 байты — ответ `check` обрезает `output` до 300 символов и не падает (тест в Task 4).
5. Вставка в терминал большого блока текста (> 4 КБ) — клиент режет на кадры по 4 КБ, сервер ничего не теряет (тест в Task 9 и Task 6).

---

## File Structure

```
packages/db/src/schema/practice.ts            practice_progress, practice_runs, sandboxes, sandbox_usage
packages/api-contract/src/{practice,internal,ws}.ts, packages/api-contract/src/node/ticket.ts (subpath export "./ticket")
apps/sandboxd/src/{server,app,config}.ts
apps/sandboxd/src/driver/{types,docker,runc-dev}.ts
apps/sandboxd/src/{scheduler,lifecycle,gc,reconcile,events,terminal,metrics,usage}.ts
apps/sandboxd/src/routes/internal.ts
apps/sandboxd/test/**
sandbox/images/test-shell/Dockerfile, sandbox/images/common/tmux.conf
apps/api/src/services/{practices,runs,sandboxdClient}.ts, apps/api/src/routes/practices.ts, apps/api/src/jobs/{runsSync,stopSolved}.ts
apps/web/src/terminal/{Terminal.tsx,useTerminalSocket.ts,MobileKeys.tsx,keys.ts,useVisualViewport.ts}
apps/web/src/screens/Practice/{PracticeCatalog,PracticeScreen,StartCard,QueueCard,GoalsPanel,HintsPanel,RunTimer,ExpiryToast}.tsx
e2e/fixtures/content/{practices/inc-e2e-touch/**,images/registry.yaml,overlays/t1.s01.yaml}, e2e/specs/05-practice.spec.ts
```

Решения сверх спецификации (кратко; подробности — в задачах):
- `POST /internal/sandboxes` получает ещё `title` (для MOTD, пишется перед setup) и `test?: boolean` (для `practice:test`: вне очереди, без пользователя, ≤ 1 одновременно); `sandboxes.user_id` допускает `NULL`.
- `GET /api/runs/:id` дополнительно отдаёт `usage: {cpuPct, memMb, memLimitMb} | null` — экран практики показывает строку CPU/RAM, а в §5.1 поля нет.
- Код 4008 «60 с без кадров» из §5.2 совпадает с `4000 + 8` (`banned`); закрытие по молчанию клиента — `4100`, третье соединение — `4409`.
- `queue_timeout` у песочницы — `state='stopped'`, `stop_reason='queue_timeout'` (в §4.4 такого состояния у `sandboxes` нет).
- Режим «drain» хранится в `settings.sandboxes_drained`; `sandboxd` читает его в цикле и отвечает `queue_full`.

---

### Task 1: Таблицы практик, контракт внутреннего API и билеты

**Files:**
- Create: `packages/db/src/schema/practice.ts` + миграция `0002_*` (частичный уникальный индекс `sandboxes(user_id) WHERE state IN ('queued','starting','ready')`, индекс `sandboxes(state)`; сверх §4.4 у `sandboxes` колонки `title text`, `test bool default false`, `failure_output text`, `user_id` nullable)
- Create: `packages/api-contract/src/{internal,ws,practice}.ts`, `src/node/ticket.ts`
- Test: `packages/api-contract/test/ticket.test.ts`, `apps/api/test/migrate.test.ts` (дополнить)

**Interfaces:**
- Produces:
  - `CreateSandboxBody { runId; userId: string|null; image; class: 'light'|'docker'|'heavy'; hostname; title; setupScript; setupTimeoutSec; ttlMin; test?: boolean }`, `SandboxView { sandboxId; state; stopReason: string|null; queuePosition: number|null; expiresAt; hardDeadline; readyAt; canExtend: boolean; usage: {cpuPct; memMb; memLimitMb}|null }`, `ExecChecksBody { checks: {goalId; script; timeoutSec}[] }`, `ExecCheckResult { goalId; exitCode; output; timedOut }`.
  - `WS_CLOSE_REASONS` (массив из 9 причин по порядку), `closeCodeFor(reason): number`, `WS_CLOSE_SILENT = 4100`, `WS_CLOSE_TOO_MANY = 4409`; типы кадров `ClientCtl = {t:'resize',cols,rows}|{t:'ping'}`, `ServerCtl = {t:'ready'}|{t:'pong'}|{t:'expiring',secondsLeft}|{t:'extended',expiresAt}|{t:'closed',reason}`.
  - `@rootcamp/api-contract/ticket` (только Node): `signTicket(p: TicketPayload, secret): string`, `verifyTicket(token, secret, now): TicketPayload` (бросает `TicketError('bad_sig'|'expired')`), `TicketPayload { runId; userId; sandboxId; exp: number; jti: string }`; формат `base64url(json).base64url(hmac)`.
  - DTO для `web`: `PracticeListItem`, `RunDto` (§5.1 + `usage`, `state`, `goals`, `hints`, `canExtend`, `resetsLeft`).

- [ ] **Step 1: Write the failing test**: подпись проверяется; изменённый байт payload → `bad_sig`; `exp` в прошлом → `expired`; `closeCodeFor('expired')===4000`, `('banned')===4008`.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement (`crypto.timingSafeEqual`). **Step 4:** Run — PASS.
- [ ] **Step 5: Commit** `feat: practice schema, internal contract, terminal tickets`.

### Task 2: Каркас `sandboxd`, драйвер и образ `rc/test-shell`

**Files:**
- Create: `apps/sandboxd/src/{server,app,config}.ts`, `src/driver/{types,docker,runc-dev}.ts`, `sandbox/images/test-shell/Dockerfile`, `sandbox/images/common/tmux.conf`, `apps/sandboxd/Dockerfile`
- Test: `apps/sandboxd/test/{config.test.ts,driver.runc-dev.test.ts}`

**Interfaces:**
- Produces:
  - `loadConfig(env)`: `DATABASE_URL, INTERNAL_TOKEN, TICKET_SECRET, SANDBOX_DRIVER: 'sysbox'|'runc-dev', SANDBOX_NETWORK (по умолчанию rc-sbx / rc-sbx-dev), BUDGET_MEM_MB=5120, BUDGET_CPU=3.5, HEAVY_SLOTS=1, QUEUE_MAX=10, HOST_PROC=/host/proc, HOST_ROOT=/host/root`; `assertDriverAllowed(cfg)` — `runc-dev` при `NODE_ENV=production` → throw.
  - `interface SandboxDriver { name; createContainer(s: ContainerSpec): Promise<string>; waitBoot(id, timeoutMs): Promise<void>; exec(id, script: string, o: { timeoutSec: number; env?: string[] }): Promise<{ exitCode: number; output: string; timedOut: boolean }>; execTty(id): Promise<TtyHandle>; stopAndRemove(id): Promise<void>; diskUsageMb(id): Promise<number>; listManaged(): Promise<{ containerId; sandboxId; running: boolean }[]> }`; `ContainerSpec { sandboxId; userId; image; class; hostname; limits: {cpu; memMb; pids} }`; `TtyHandle { write(b: Buffer): void; onData(cb): void; resize(cols, rows): Promise<void>; close(): void; onExit(cb): void }`.
  - `docker.ts` — общая реализация на dockerode (exec со stdin `bash -s`, `timeout --kill-after=2 <N> bash -s`, `PATH=/usr/sbin:/usr/bin:/sbin:/bin`, вывод — первые 64 КБ); `runc-dev.ts` переопределяет: образ → `rc/test-shell`, `waitBoot` — no-op, `diskUsageMb` = `SizeRw`. `execTty` — `tmux new-session -A -s main`, `Tty: true`, `User: root`, `WorkingDir: /root`, `Env: [TERM=xterm-256color, LANG=C.UTF-8]`.

- [ ] **Step 1: Write the failing test**: `assertDriverAllowed({driver:'runc-dev', nodeEnv:'production'})` бросает; интеграционный (`describe.runIf(dockerAvailable)`): создать контейнер, `exec('echo hi; exit 3')` → `{exitCode:3, output:'hi\n'}`; `exec('sleep 5', {timeoutSec:1})` → `timedOut:true` за < 4 с; метки `rootcamp.sandbox` выставлены; `HostConfig.Privileged === false`, `Binds` пуст.
- [ ] **Step 2:** Run `docker build -t rc/test-shell sandbox/images/test-shell && pnpm --filter @rootcamp/sandboxd test` — FAIL.
- [ ] **Step 3:** Implement. **Step 4:** Run — PASS (на Windows — Docker Desktop запущен).
- [ ] **Step 5: Commit** `feat(sandboxd): skeleton, driver interface, runc-dev`.

### Task 3: Планировщик и очередь

**Files:**
- Create: `apps/sandboxd/src/scheduler.ts`
- Test: `apps/sandboxd/test/scheduler.test.ts`

**Interfaces:**
- Produces: чистая функция `plan(i: { queued: QueuedRow[]; active: ActiveRow[]; now: number; diskFreeGb: number; budget: Budget; drained: boolean }): { admit: string[]; timeout: string[]; positions: Record<string, number> }`, где `QueuedRow { id; class; cpu; memMb; queuedAt; test: boolean }`, `ActiveRow { class; cpu; memMb }`, `Budget { memMb; cpu; heavySlots }`. Строки `test` не учитываются в очереди и бюджете, но не больше одной одновременно. `canEnqueue(queuedCount, drained): 'ok'|'queue_full'`.
- Алгоритм — §6.5 п.1–5; если первая в очереди `heavy` ждёт > 10 мин, допуск остальных блокируется.

- [ ] **Step 1: Write the failing test**: бюджет 1 слот (`memMb:512, cpu:0.5`): две `light` → допущена первая, вторая позиция 1; освобождение → допущена вторая; `heavy` при занятом слоте `heavy` не допускается; `heavy` ждёт 11 мин → `light` позади неё не допускается при свободных ресурсах; заявка старше 20 мин → в `timeout`; `diskFreeGb: 9` → ничего не допущено; `canEnqueue(10,false)==='queue_full'`, `canEnqueue(0,true)==='queue_full'`.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5: Commit** `feat(sandboxd): scheduler`.

### Task 4: Жизненный цикл и внутренний REST

**Files:**
- Create: `apps/sandboxd/src/{lifecycle,usage}.ts`, `src/routes/internal.ts`, `src/app.ts` (цикл планировщика 2 с и по событию освобождения)
- Test: `apps/sandboxd/test/lifecycle.test.ts` (runc-dev)

**Interfaces:**
- Consumes: `SandboxDriver`, `plan`, `@rootcamp/db`.
- Produces: маршруты §5.3 с телами Task 1; `startSandbox(row)`: `starting` → `createContainer` → `waitBoot(60 с)` → `exec('mkdir -p /etc/rootcamp && printf %s "$TITLE" > /etc/rootcamp/title')` (MOTD образа читает этот файл, M4b) → `exec(setupScript, setupTimeoutSec)` → `exec('history -c; rm -f /root/.bash_history')` → `ready` (`ready_at`, `expires_at`, `hard_deadline`); ненулевой setup → `failed`, `stop_reason='setup_failed'`, первые 2000 символов вывода в новое поле `sandboxes.failure_output` (читает задание алертов в M6). `stopSandbox(id, reason)`: `stopping` → `stopAndRemove` → `stopped`, учёт минут `ceil((stopped - ready)/60000)` в `sandbox_usage(user_id, day по users.tz)`. `exec-checks` выполняет цели последовательно, `output` — первые 300 символов stdout, декодированные как UTF-8 с заменой невалидных байт; при таймауте `output = 'проверка не уложилась в N с'`. Любой внутренний запрос по песочнице обновляет `last_activity_at` (не чаще 30 с). `extend` → `409`, если до `expires_at` > 10 мин или `expires_at = hard_deadline`.

- [ ] **Step 1: Write the failing test**: `POST /internal/sandboxes` без токена → 401; с токеном → `queued`, затем через ≤ 10 с `ready`; setup `exit 1` → `failed/setup_failed`; `exec-checks` с `head -c 1000000 /dev/urandom` → `output.length ≤ 300`, без исключения; `extend` за 20 мин до конца → 409, за 5 мин → `expiresAt` +15 мин; `DELETE` → контейнер удалён, `sandbox_usage.minutes ≥ 1`; второй `POST` для того же `userId` при активной → 409.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5: Commit** `feat(sandboxd): lifecycle and internal API`.

### Task 5: Сборщик мусора, события Docker, восстановление при старте, метрики

**Files:**
- Create: `apps/sandboxd/src/{gc,events,reconcile,metrics}.ts`
- Test: `apps/sandboxd/test/{gc,reconcile,metrics}.test.ts`

**Interfaces:**
- Produces: `gcTick(now)` раз в 30 с — TTL (`expired`), простой (`idle`: 0 WS-соединений и `last_activity_at` старше 10 мин), диск (`disk_quota`: `driver.diskUsageMb > 3072`), сироты (контейнер с меткой без строки или со строкой `stopped/failed` → удалить), `starting` старше 5 мин → `failed`; `queue_timeout` из `plan`. `watchEvents()` — `die`/`oom` по метке → `failed` (`oom`/`crashed`) и рассылка `closed: sandbox_failed`. `reconcileOnStart()` — §6.6. `dailyPrune()` в 04:00 MSK — `image prune -f --filter label!=rootcamp.keep`, `volume prune -f`. `Metrics`: опрос раз в 10 с, кольцо 60 точек; хост из `HOST_PROC/stat`, `HOST_PROC/meminfo` (фолбэк на `/proc`, если `HOST_PROC` нет), диск — `statfs(HOST_ROOT)`; по песочницам — `docker stats --no-stream`; `GET /internal/metrics` → `{ host: {cpuPct, memUsedMb, memTotalMb, diskUsedGb, diskTotalGb}, sandboxes: [{sandboxId, cpuPct, memMb, diskMb}] }`.
- События для терминала: `onSandboxClosed(cb: (sandboxId, reason) => void)` — общий эмиттер, на который подписан Task 6.

- [ ] **Step 1: Write the failing test**: `expires_at` в прошлом → после `gcTick` `stopped/expired`; контейнер с меткой без строки → удалён; строка `ready` без контейнера при `reconcileOnStart` → `failed/lost`; `docker kill` контейнера → строка `failed/crashed` за ≤ 5 с; парсер `/proc/stat` на фикстуре двух снимков даёт ожидаемый `cpuPct`.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement (время — инъекция `now`). **Step 4:** Run — PASS.
- [ ] **Step 5: Commit** `feat(sandboxd): gc, events, reconcile, metrics`.

### Task 6: Терминальный WebSocket

**Files:**
- Create: `apps/sandboxd/src/terminal.ts`
- Test: `apps/sandboxd/test/terminal.test.ts` (клиент `ws`, runc-dev)

**Interfaces:**
- Consumes: `verifyTicket`, `driver.execTty`, `onSandboxClosed`.
- Produces: `GET /ws/terminal?ticket=…` — проверка подписи, срока, `jti` (Map с TTL 2 мин), песочницы `ready` того же `userId`; иначе закрытие `4401` до `ready`. Счётчик соединений по `sandboxId`; третье → `4409`. Вывод: буфер до 16 мс/32 КБ, токен-бакет 1 МБ/с с паузой потока exec. Кадр-ввод > 4 КБ отбрасывается и логируется. `{t:'expiring'}` за 300 и 60 с до `expires_at`; при продлении — `{t:'extended'}`; при `closed` — JSON и закрытие кодом `closeCodeFor`. 60 с без кадров → `4100`. Ввод обновляет `last_activity_at` (≤ раз в 30 с).

- [ ] **Step 1: Write the failing test**: подключение с билетом → `{t:'ready'}`, ввод `echo hi\r` → в выводе `hi`; повтор того же билета → закрытие 4401; третье соединение → 4409; `resize` cols=10 → игнор, cols=120 → вызов `resize(120, rows)`; переподключение после разрыва → `tmux` показывает предыдущий вывод (`capture-pane`); `DELETE …{reason:'stopped_by_user'}` → клиент получает `{t:'closed',reason:'stopped_by_user'}` и код 4002; 3 последовательных кадра по 4 КБ → в выводе все 12 КБ.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement (`@fastify/websocket`). **Step 4:** Run — PASS.
- [ ] **Step 5: Commit** `feat(sandboxd): terminal websocket`.

### Task 7: API практик в `api`

**Files:**
- Create: `apps/api/src/services/{sandboxdClient,practices,runs}.ts`, `src/routes/practices.ts`, `src/jobs/{runsSync,stopSolved}.ts`
- Modify: `apps/api/src/services/progress.ts` (`practiceStatuses` учитывает `solved`), `apps/api/src/cli.ts` (`sandboxes:drain`, `sandboxes:undrain`), `apps/api/src/routes/health.ts` (поле `sandboxd` — `GET /internal/health` у sandboxd отвечает 200)
- Test: `apps/api/test/practices.test.ts` (фейк `SandboxdClient`)

**Interfaces:**
- Consumes: `ContentStore.practice(id)`, `practiceAvailability`, `practiceXp`, `registerActivity`, `applyXp`, `signTicket`.
- Produces:
  - `SandboxdClient { create(b: CreateSandboxBody): Promise<SandboxView>; get(id): Promise<SandboxView>; execChecks(id, b): Promise<ExecCheckResult[]>; extend(id): Promise<{expiresAt}>; remove(id, reason): Promise<void>; metrics(): Promise<MetricsDto> }`; `createHttpSandboxdClient(url, token)`, таймаут HTTP 45 с для `execChecks`; `createFakeSandboxdClient()` для тестов (скрипты сценариев: `setGoalExitCodes`, `setState`).
  - Маршруты §5.1 «Практика». `POST /runs`: доступность → `practice_locked`; активный запуск → `409 run_exists` с `runId`; квота `sandbox_usage` за сегодня ≥ 180 → `quota_exceeded`; лимит 6/ч → `rate_limited`; иначе `practice_runs(queued)` и `sandboxd.create`. `GET /runs/:id` синхронизирует `practice_runs.status` по `SandboxView` (таблица соответствий: `queued/starting/ready` → так же; `stopped`+`expired` → `expired`; `stopped`+`solved` → `solved`; `stopped`+`queue_timeout` → `queue_timeout`; остальные `stopped` → `stopped`; `failed` → `failed`). `check` (1/5 с): `execChecks` → `goals_passed` → при всех целях: `practiceXp(manifest.reward, hints_revealed, first_solve)`, `applyXp(source 'practice')`, `registerActivity`, `practice_runs.status='solved'`, задание `stop-solved` с `startAfter: 120`. `hints` → следующая подсказка, `hints_revealed` в `practice_progress` (сохраняется между запусками). `reset` (≤ 3, иначе `reset_limit`) → `remove(reason 'reset')` + `create` с тем же `runId`. `stop` → `remove('stopped_by_user')`. `terminal-ticket` — `exp = now + 30 с`, `jti = randomUUID()`.
  - Задание `runs-sync` раз в минуту для незавершённых запусков.
  - `sandboxes:drain|undrain` пишут `settings.sandboxes_drained`.

- [ ] **Step 1: Write the failing test** (§10.2): создание запуска → `201 {runId, state:'queued'}`; второй → 409 `run_exists` с тем же `runId`; недоступная практика → 403 `practice_locked`; неподтверждённый email → 403 `email_unverified`; `sandbox_usage=180` → 403 `quota_exceeded`; `check` с кодами `[0,1,0]` → `solved:false`, `goals[1].passed:false`; затем `[0,0,0]` → `solved:true`, `xpAwarded:50`; при 2 открытых подсказках в прошлом запуске первое решение → `30`; повторное решение → `10`; второй `check` через 2 с → 429; 4-й `reset` → 409 `reset_limit`; после `solved` в pg-boss есть задача `stop-solved` со `startAfter` ≈ +120 с.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5: Commit** `feat(api): practice runs`.

### Task 8: Терминал в `web`

**Files:**
- Create: `apps/web/src/terminal/{Terminal.tsx,useTerminalSocket.ts,MobileKeys.tsx,keys.ts,useVisualViewport.ts}`
- Test: `apps/web/test/terminal/{keys.test.ts,useTerminalSocket.test.ts,MobileKeys.test.tsx}`

**Interfaces:**
- Produces:
  - `KEY_SEQUENCES: Record<'Esc'|'Tab'|'Up'|'Down'|'Left'|'Right'|'Pipe'|'Slash'|'Dash'|'Tilde'|'CtrlC', string>` = `\x1b`, `\t`, `\x1b[A`, `\x1b[B`, `\x1b[D`, `\x1b[C`, `|`, `/`, `-`, `~`, `\x03`; `ctrlOf(ch: string): string` (`a`→`\x01` … `z`→`\x1a`, `[`→`\x1b`); `chunkInput(s: string, max = 4096): Uint8Array[]`.
  - `useTerminalSocket({ getTicket: () => Promise<{url}>; onData; onCtl })` — состояния `connecting|open|reconnecting|lost|closed`; ping каждые 20 с; нет `pong` 45 с → переподключение; задержки `[1, 2, 4, 8, 15]` с, общий предел 2 мин, затем `lost`; каждый раз новый билет; `closed` от сервера — без переподключения.
  - `Terminal({ runId, compact: boolean })` — xterm (`fontFamily: 'JetBrains Mono'`, `fontSize` 14 или 12.5, тема из CSS-переменных, `scrollback: 3000`, `cursorBlink: true`), `FitAddon` через `ResizeObserver`, отправка `resize`; < 40 колонок → шрифт до 11 px, затем горизонтальная прокрутка; скрытому textarea — `autocapitalize=off`, `autocorrect=off`, `spellcheck=false`. Плашка «Переподключаемся…» и «Соединение потеряно» с кнопкой «Подключиться».
  - `MobileKeys` — сетка 6×2 из §8.3; `Ctrl` залипающий (подсвечен, пока активен, следующая буква уходит как `ctrlOf`). `useVisualViewport()` держит высоту области терминала над клавиатурой.

- [ ] **Step 1: Write the failing test**: `ctrlOf('c')==='\x03'`; `chunkInput('x'.repeat(9000))` → длины `[4096, 4096, 808]`; `MobileKeys`: нажатие `Ctrl`, затем ввод `d` → `onSend('\x04')` и `Ctrl` снят; `↑` → `\x1b[A`; `useTerminalSocket` с фейковым WebSocket: обрыв → попытки через 1, 2, 4 с (fake timers), после 2 мин → `lost`; `{t:'closed'}` → без повторов.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5: Commit** `feat(web): terminal with mobile keys and reconnect`.

### Task 9: Экраны «Практика»

**Files:**
- Create: `apps/web/src/screens/Practice/*.tsx` из File Structure
- Modify: `apps/web/src/screens/Path/{PracticeNodeCard,RightColumn}.tsx` (карточка узла и «Инцидент дня» — первая доступная нерешённая практика)
- Test: `apps/web/test/Practice.test.tsx`

**Interfaces:**
- Consumes: Task 7, Task 8, `/content/<v>/practices/<id>.json`.
- Produces: `/practice` — каталог карточек со статусом; `/practice/:practiceId`: до старта — бриф, цели, награда и `StartCard` «Начать (≈ 20 с)» (для класса `docker` — «≈ 40 с»); `queued` — `QueueCard` «Ты N-й в очереди» + маскот `waiting`; `starting` — индикатор; `ready` — терминал, цели с отметками, «Проверить», «Сбросить сервер», подсказки с ценой «−5 XP», таймер и строка CPU/RAM из `usage`; `ExpiryToast` за 5 и 1 мин с «Продлить», если `canExtend`. Опрос `GET /api/runs/:id` раз в 2 с в `queued/starting` и раз в 15 с в `ready`. Телефон (< 640 px): шапка с «назад», названием, состоянием, таймером и всегда видимой «Проверить»; вкладки «Терминал | Цели X/Y | Подсказки»; строка «Следующая цель». Ошибки §9: `queue_full`/`queue_timeout` — «Сейчас все серверы заняты, попробуй через 10 минут»; `failed` — «Сервер упал…» или «Не удалось подготовить инцидент. Мы уже знаем»; `expired` — «Время вышло» и «Новый сервер».

- [ ] **Step 1: Write the failing test** (MSW): двойной клик «Начать» шлёт один `POST /runs` (кнопка блокируется до ответа); `409 run_exists` → экран подхватывает `runId` из ответа; при `state:'queued', queuePosition:2` виден текст «Ты 2-й в очереди»; при ширине 390 px видны вкладки и «Проверить» в шапке.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5: Commit** `feat(web): practice catalog and incident screen`.

### Task 10: E2E-фикстура и сценарий 5

**Files:**
- Create: `e2e/fixtures/content/practices/inc-e2e-touch/{practice.yaml,setup.sh,check/done.sh,solution.sh}` (образ `rc/test-shell`, класс `light`, цель `done`: `test -f /tmp/done`), `e2e/fixtures/content/images/registry.yaml` (`rc/test-shell`, `light`), `e2e/fixtures/content/overlays/t1.s01.yaml` (`insertAfter: l01`, `practice: inc-e2e-touch`), `e2e/specs/05-practice.spec.ts`
- Modify: `packages/content-schema/src/load.ts` (`extraRoots`: практики, реестр образов и `overlays/<sectionId>.yaml` с `insertAfter`), `tools/content-build/src/cli.ts` (`--extra <dir>`), `infra/compose.e2e.yaml` (сервис `sandboxd`: `SANDBOX_DRIVER=runc-dev`, `NODE_ENV=test`, `docker.sock`; сборка `rc/test-shell`; Caddy проксирует `/ws/terminal` → `sandboxd:3001`), `apps/api/src/cli.ts` (`dev:seed-progress <email> <lessonId…>`, отказ при `NODE_ENV=production`)
- Test: `packages/content-schema/test/overlay.test.ts`

- [ ] **Step 1: Write the failing test** `overlay.test.ts`: overlay вставляет узел после `l01`; рабочий `content/` без `--extra` не содержит `inc-e2e-touch`.
- [ ] **Step 2: Write the failing e2e** `05-practice.spec.ts`: пользователь с пройденным `t1.s01.l01` (через `dev:seed-progress`) → `/practice/inc-e2e-touch` → «Начать» → ввод `echo hi` → в терминале `hi`; смена размера окна → сервер получил `resize` (вывод `stty size` меняется); «Проверить» → цель красная; `touch /tmp/done` → «Проверить» → «Решено», XP в шапке; `context.setOffline(true)` 5 с → плашка «Переподключаемся…» → `setOffline(false)` → история (`hi`) на месте.
- [ ] **Step 3:** Run `pnpm e2e` — FAIL. **Step 4:** Implement. **Step 5:** Run — PASS (`mobile`, `desktop`).
- [ ] **Step 6: Commit** `test(e2e): practice on runc-dev`.

### Task 11: Демо вехи M4a (локально, Windows)

- [ ] **Step 1:** Run `docker build -t rc/test-shell sandbox/images/test-shell && pnpm test` — Expected: зелёные тесты `sandboxd` (scheduler, lifecycle, gc, terminal) и `api` (practices).
- [ ] **Step 2:** Run `pnpm dev:up` (в `compose.dev.yaml` добавлен `sandboxd` с `runc-dev`), `content:build --extra e2e/fixtures/content`, `content:activate` — Expected: `sandboxd` в логах `driver=runc-dev (DEV ONLY: no systemd, no userns)`.
- [ ] **Step 3:** На 390 px и 1440 px открыть `/practice/inc-e2e-touch`, запустить, выполнить `touch /tmp/done`, нажать «Проверить» — Expected: «Решено», +XP. Открыть вторую вкладку той же практики — тот же tmux.
- [ ] **Step 4:** Run `docker ps --filter label=rootcamp.sandbox` после «Остановить» — Expected: пусто. Run `pnpm e2e` — Expected: сценарии 1–5 зелёные ×2. Показать пользователю вывод и явно отметить: systemd/dind-инциденты на этой машине не проверяются — это M4b на VPS.
