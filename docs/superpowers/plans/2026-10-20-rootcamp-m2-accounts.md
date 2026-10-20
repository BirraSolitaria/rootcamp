# rootcamp M2 «Аккаунты» Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Регистрация, подтверждение email письмом, вход, выход, сброс и смена пароля, сессии в cookie, лимиты запросов и экраны входа — с e2e «регистрация → письмо (Mailpit) → вход» на двух вьюпортах.

**Architecture:** Схема БД выносится в `packages/db` (Drizzle), миграции генерируются в `apps/api/drizzle/` и применяются при старте `api` под advisory lock. `api` собирается фабрикой `buildApp(deps)` с плагинами: CSRF-guard, сессии, guard неподтверждённого email, rate limit. Письма идут через очередь pg-boss `email` с журналом `email_log`. `web` — React SPA с оболочкой и адаптивной навигацией §8.2.

**Tech Stack:** Fastify 5, @fastify/cookie, @fastify/rate-limit, Drizzle ORM + drizzle-kit, postgres (porsager) драйвер, pg-boss 10, argon2, nodemailer, zod, Vitest + Testcontainers (PostgreSQL 16, Mailpit), React 18, React Router 6, TanStack Query 5, CSS Modules, @fontsource, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-20-rootcamp-design.md` (§4.4, §5.1 «Аутентификация», §6.3 «Rate limit», §8.1–8.2, §9, §10.2, §10.4 сценарий 1). Предыдущая веха: `2026-10-20-rootcamp-m1-skeleton.md`.

## Global Constraints

- Все Global Constraints из M1.
- Ошибки API: `{ error: { code, message } }`, `code` только из `ErrorCode` в `packages/api-contract`.
- Мутирующие запросы требуют `X-RC: 1` и `Origin`, равный `PUBLIC_ORIGIN`; иначе `403 csrf`.
- Cookie `rc_sid`: HttpOnly, Secure (выключается только `COOKIE_SECURE=false` в dev/e2e), SameSite=Lax, 30 дней, продление при активности.
- Пароль 10–128 символов; ник `^[a-z0-9_.]{3,20}$`; email — citext unique.
- Ссылка `verify` живёт 24 ч, `reset` — 1 ч, обе одноразовые; `reset` удаляет все сессии пользователя.
- Лимиты: `login` 5/мин на IP и 20/ч на email; `register` 3/ч на IP; `forgot` 3/ч на IP; `resend-verification` 1/мин и 5/сутки на пользователя; прочее API 300/мин на пользователя.
- Миграции только расширяющие.
- `settings` по умолчанию: `registration_mode='open'`, `max_users=50`.

## Review Focus

1. Пользователь регистрируется с email в другом регистре (`Ann@Mail.ru` после `ann@mail.ru`) — получает `email_taken`, а не второй аккаунт (тест в Task 4).
2. Неподтверждённый пользователь на экране «Проверь почту» меняет опечатку в email — `PATCH /api/me {email}` должен работать, хотя общее правило §5.1 закрывает всё, кроме `/api/auth/*` и `GET /api/me` (тест в Task 3: allowlist guard; Task 5: смена email).
3. Двойной клик по ссылке из письма (два `POST /api/auth/verify` подряд) — второй отвечает `token_used`, но пользователь уже подтверждён и экран показывает успех (тест в Task 4).
4. SMTP недоступен при регистрации — регистрация отвечает 201, письмо остаётся `queued`, после восстановления уходит (тест в Task 6: фейковый транспорт падает первым вызовом).
5. Браузер в часовом поясе, которого нет в ICU сервера, или `tz` пустой — регистрация не падает 500, а отвечает `validation` (тест в Task 4).

---

## File Structure

```
packages/api-contract/src/{errors,auth,me,index}.ts
packages/db/src/{schema/accounts.ts,schema/index.ts,client.ts,migrate.ts,index.ts}
apps/api/drizzle.config.ts, apps/api/drizzle/*.sql
apps/api/src/{app,server,config,cli}.ts
apps/api/src/plugins/{errors,csrf,session,verifiedGuard,rateLimit}.ts
apps/api/src/services/{users,sessions,emailTokens,mailer,settings}.ts
apps/api/src/jobs/{boss,email}.ts, apps/api/src/mail/templates.ts
apps/api/src/routes/{auth,me,health}.ts
apps/api/test/{harness.ts,auth.test.ts,me.test.ts,limits.test.ts,email.test.ts}
apps/web/src/{main.tsx,App.tsx,api/client.ts,api/queries.ts,styles/tokens.css,styles/global.css}
apps/web/src/layout/{Shell.tsx,Nav.tsx}.tsx, apps/web/src/screens/auth/*.tsx, apps/web/src/components/Mascot.tsx
infra/compose.e2e.yaml, e2e/{playwright.config.ts,helpers/mailpit.ts,specs/01-register.spec.ts}
```

Решение сверх спецификации: Drizzle-схема живёт в `packages/db`, а не в `apps/api/src/db/schema.ts`, потому что `sandboxd` (M4a) пишет таблицу `sandboxes` и должен импортировать ту же схему. Миграции по-прежнему генерирует и применяет только `api`.

---

### Task 1: Контракт ошибок и запросов аутентификации

**Files:**
- Create: `packages/api-contract/src/{errors,auth,me,index}.ts`
- Test: `packages/api-contract/test/contract.test.ts`

**Interfaces:**
- Produces:
  - `ErrorCode` (zod enum) — все коды из §5.1, §5.2 и §9: `validation, csrf, unauthorized, forbidden, not_found, rate_limited, registration_closed, user_limit, email_taken, nick_taken, invalid_credentials, banned, email_unverified, token_invalid, token_expired, token_used, email_already_verified, wrong_password, locked, no_hearts, out_of_order, content_changed, session_closed, practice_locked, run_exists, quota_exceeded, queue_full, extend_not_allowed, reset_limit, self, already_friends, already_requested, internal`.
  - `ApiError { error: { code: ErrorCode; message: string; runId?: string } }`.
  - zod-схемы тел и ответов: `RegisterBody {email, nick, password, tz, website?}`, `LoginBody`, `ForgotBody`, `ResetBody`, `VerifyBody`, `ChangePasswordBody {current, next}`, `PatchMeBody {tz?, reminderEnabled?, reminderTime? /*HH:MM*/, email?}`, `UserDto {id, email, nick, emailVerified, isAdmin, tz, rank, totalXp, reminderEnabled, reminderTime}`, `MeDto {user, hearts:{count, msToNext: number|null}, streak:{current,best}, xpToday, dailyGoal: 30, rank, nextRank: {next, xpNeeded, tracksNeeded}}`.

- [ ] **Step 1: Write the failing test**: `RegisterBody.safeParse({…password:'123456789'})` → ошибка (9 < 10); ник `'Ann'` → ошибка (заглавная); `PatchMeBody.parse({reminderTime:'20:00'})` ок, `'25:00'` → ошибка; `ErrorCode.options` содержит `content_changed` и `queue_full`.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5: Commit** `feat(api-contract): error codes and auth schemas`.

### Task 2: Схема БД аккаунтов, миграции и тестовый стенд

**Files:**
- Create: `packages/db/src/schema/accounts.ts` (`users`, `sessions`, `email_tokens`, `email_log`, `hearts`, `streaks`, `xp_events`, `settings`, `audit_log` — колонки §4.4), `packages/db/src/{client,migrate,index}.ts`, `apps/api/drizzle.config.ts`, `apps/api/drizzle/0000_*.sql`
- Test: `apps/api/test/harness.ts`, `apps/api/test/migrate.test.ts`

**Interfaces:**
- Produces:
  - `createDb(url: string): { db: Db; sql: Sql; close(): Promise<void> }`; `type Db` — Drizzle-инстанс со всей схемой.
  - `runMigrations(db: Db, dir: string): Promise<void>` — `pg_advisory_lock(727001)` → `migrate()` → unlock.
  - Миграция включает `CREATE EXTENSION IF NOT EXISTS citext`, индекс `xp_events(user_id, day)`, `xp_events(created_at)`, CHECK `hearts.count BETWEEN 0 AND 5`, CHECK ника regex, вставку `settings` по умолчанию.
  - Тестовый стенд: `startHarness(opts?): Promise<Harness>`, `Harness { app: FastifyInstance; db: Db; mail: { messages(to: string): Promise<MailpitMessage[]> }; clock: { now(): number; set(ms: number): void; advance(ms: number): void }; close() }`. Postgres и Mailpit — контейнеры Testcontainers, один набор на файл тестов; между тестами — `TRUNCATE … CASCADE`.

- [ ] **Step 1: Write the failing test** `migrate.test.ts`: два параллельных `runMigrations` на одной БД оба завершаются без ошибки; после них `select value from settings where key='max_users'` → `50`.
- [ ] **Step 2:** Run `pnpm --filter @rootcamp/api test migrate` — Expected: FAIL. (На Windows нужен запущенный Docker Desktop.)
- [ ] **Step 3:** Описать схему, `pnpm --filter @rootcamp/api drizzle-kit generate`, дописать в SQL-миграцию extension и seed `settings`.
- [ ] **Step 4:** Run — PASS. **Step 5: Commit** `feat(db): accounts schema and migrations`.

### Task 3: Каркас `api`: конфиг, ошибки, CSRF, сессии, guard email

**Files:**
- Create: `apps/api/src/{config,app}.ts` (переписать заглушку M1), `src/plugins/{errors,csrf,session,verifiedGuard}.ts`, `src/services/sessions.ts`, `src/routes/health.ts`
- Test: `apps/api/test/plugins.test.ts`

**Interfaces:**
- Consumes: `Db` (Task 2), `ErrorCode` (Task 1).
- Produces:
  - `loadConfig(env): Config` (zod): `DATABASE_URL, PUBLIC_ORIGIN, COOKIE_SECURE=true, SMTP_HOST, SMTP_PORT=587, SMTP_USER, SMTP_PASS, SMTP_FROM, INTERNAL_TOKEN, TICKET_SECRET, SANDBOXD_URL, CONTENT_DIR, NODE_ENV`.
  - `buildApp(deps: AppDeps): Promise<FastifyInstance>`, `AppDeps { config: Config; db: Db; now: () => number; mailer: Mailer; boss: PgBoss | null; sandboxd?: SandboxdClient /*M4a*/; content?: ContentStore /*M3*/ }`.
  - `class HttpError extends Error { constructor(status: number, code: ErrorCode, message?: string, extra?: object) }` — бросается из сервисов; плагин `errors` превращает её в `ApiError`, zod-ошибки — в `400 validation`, прочее — `500 internal` с `reqId`.
  - `request.user: SessionUser | null` (`{id, email, nick, isAdmin, emailVerified, status, tz}`); `createSession(db, userId, ip, ua, now): Promise<string /*token*/>`, `revokeAllSessions(db, userId)`. Токен — 32 случайных байта base64url, в БД `id = sha256(token)`; продление `expires_at = now + 30d`, если с последнего продления прошло > 1 ч.
  - Guard: неподтверждённому пользователю разрешены `/api/auth/*`, `GET /api/me`, `PATCH /api/me`, `/api/health`, `GET /api/content/version`; остальное → `403 email_unverified`. Забаненный — сессия удаляется, ответ `403 banned`.

- [ ] **Step 1: Write the failing test**: POST без `X-RC` → 403 `csrf`; с чужим `Origin` → 403 `csrf`; GET без cookie на защищённом маршруте → 401 `unauthorized`; неподтверждённый пользователь: `GET /api/progress` (тестовый маршрут-заглушка) → 403 `email_unverified`, `PATCH /api/me` проходит guard; просроченная сессия → 401; брошенная `new Error()` → 500 с `reqId` в `message`.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5: Commit** `feat(api): app factory, csrf, sessions, verified guard`.

### Task 4: Регистрация, подтверждение, повторная отправка

**Files:**
- Create: `apps/api/src/services/{users,emailTokens,settings}.ts`, `src/routes/auth.ts` (часть: `register`, `verify`, `resend-verification`), `src/mail/templates.ts`
- Test: `apps/api/test/auth.test.ts`

**Interfaces:**
- Consumes: Task 3, `isValidTimeZone` из `@rootcamp/logic`.
- Produces: `registerUser(db, body, now): Promise<User | null>` (`null` для ловушки `website`); `issueEmailToken(db, userId, kind: 'verify'|'reset', now): Promise<string>`; `consumeEmailToken(db, token, kind, now): Promise<{userId}>` (ошибки `token_invalid|token_expired|token_used`); `enqueueEmail(boss, db, {userId, kind, to, subject, text, html})`. Шаблоны: `verifyEmail(link)`, `resetEmail(link)`; ссылки `${PUBLIC_ORIGIN}/verify?token=…`, `/reset?token=…`.
- Решения: регистрация в одной транзакции создаёт `users`, `hearts(count=5)`, `streaks(0,0,null)`, сессию (cookie ставится сразу — экран «Проверь почту» требует входа) и `email_tokens(verify)`; при числе пользователей ≥ `max_users` в той же транзакции переключает `registration_mode='closed'` и отвечает `user_limit`. Повторный `verify` уже подтверждённого пользователя — `409 token_used`, клиент показывает успех. `resend-verification` аннулирует прежние неиспользованные `verify`-токены.

- [ ] **Step 1: Write the failing test**: регистрация → 201, Set-Cookie `rc_sid`, письмо в Mailpit содержит `/verify?token=`; `POST /verify` с токеном → `emailVerified:true`; второй раз → 409 `token_used`; токен через 24 ч + 1 мс (`clock.advance`) → `token_expired`; `Ann@Mail.ru` после `ann@mail.ru` → 409 `email_taken`; тот же ник → `nick_taken`; `website:'x'` → 201 и `count(users) === 0`; `registration_mode='closed'` → 403 `registration_closed`; `max_users=1` и один пользователь → 403 `user_limit`; `tz:'Mars/Base'` → 400 `validation`; два `resend` подряд → второй 429 `rate_limited`.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5: Commit** `feat(api): registration and email verification`.

### Task 5: Вход, выход, сброс, смена пароля, `GET/PATCH /api/me`

**Files:**
- Modify: `apps/api/src/routes/auth.ts` (`login`, `logout`, `forgot`, `reset`)
- Create: `apps/api/src/routes/me.ts`
- Test: `apps/api/test/me.test.ts`, дополнение `auth.test.ts`

**Interfaces:**
- Consumes: Task 3–4; `regen`, `checkStreakBroken`, `toDateKey`, `computeRank`, `nextRankProgress`, `msToNextHeart` из `@rootcamp/logic`.
- Produces: `getMe(db, userId, now): Promise<MeDto>` — в транзакции `SELECT … FOR UPDATE` строк `hearts`/`streaks`, применяет `regen` и `checkStreakBroken(today = toDateKey(now, user.tz))`, сохраняет, считает `xpToday` суммой `xp_events` за `today`. В M2 `completedTracks = 0` (M3 подставит реальное значение через `ContentStore`).
- Решения: argon2id с параметрами по умолчанию; при неверном email всё равно вызывается `argon2.verify` по фиктивному хешу (одинаковое время). `PATCH /api/me {email}` подтверждённому → `409 email_already_verified`; неподтверждённому — смена email, аннулирование старых `verify`, новое письмо. `POST /api/me/password` — проверка `current`, затем удаление всех сессий, кроме текущей.

- [ ] **Step 1: Write the failing test**: вход неверным паролем и несуществующим email → одинаковый 401 `invalid_credentials`; забаненный → 403 `banned`; `logout` → cookie сброшен, `GET /api/me` → 401; `forgot` для неизвестного email → 204 и писем нет; `reset` → 204, старая сессия → 401; `GET /api/me` при `hearts={count:2,lastRegenAt:now-3_600_000}` → `hearts.count===4`; при `streak.lastActivityDate` позавчера → `streak.current===0`; `PATCH /api/me {email:'new@x.ru'}` неподтверждённому → письмо на новый адрес, старый токен → `token_invalid`.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5: Commit** `feat(api): login, reset, me`.

### Task 6: Очередь писем и журнал доставки

**Files:**
- Create: `apps/api/src/jobs/{boss,email}.ts`, `apps/api/src/services/mailer.ts`
- Test: `apps/api/test/email.test.ts`

**Interfaces:**
- Produces: `Mailer { send(msg: {to; subject; text; html}): Promise<void> }`, `createSmtpMailer(config)`; `startBoss(config, db): Promise<PgBoss>` (схема `pgboss`); обработчик `email`: читает `email_log` по `logId`, шлёт, ставит `sent`/`sent_at` и `settings.smtp_last_ok_at`; при ошибке `attempts+1`, `last_error`, и если `attempts < 6` — новая задача с `startAfter` из `[1, 5, 15, 60, 240]` мин (индекс `attempts-1`), иначе `status='failed'`. Встроенный retry pg-boss не используется (нужна нестандартная лестница задержек).
- Решение: «5 попыток (1, 5, 15, 60, 240 мин)» из §9 трактуется как первая отправка сразу плюс 5 повторов с этими задержками.

- [ ] **Step 1: Write the failing test**: фейковый `Mailer`, падающий 1 раз, затем успешный → после ручного прогона двух задач `email_log.status==='sent'`, `attempts===2`; всегда падающий → после 6 прогонов `status==='failed'`; `GET /api/health` возвращает `smtpLastOkAt` после успешной отправки.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5: Commit** `feat(api): email queue with retry ladder`.

### Task 7: Rate limit

**Files:**
- Create: `apps/api/src/plugins/rateLimit.ts`, `apps/api/src/services/limiter.ts`
- Test: `apps/api/test/limits.test.ts`

**Interfaces:**
- Produces: `createLimiter({ max: number; windowMs: number }): { hit(key: string, now: number): boolean }` (in-memory скользящее окно; используется там, где ключ — не IP: email при входе, userId для `resend`, запусков практики, `check`, `hints`); глобальный `@fastify/rate-limit` 300/мин с `keyGenerator = userId ?? ip`; маршрутные конфиги `login` 5/мин, `register` 3/ч, `forgot` 3/ч по IP. Ответ — `429 rate_limited`.

- [ ] **Step 1: Write the failing test**: 6-й `login` за минуту с одного IP → 429; 21-й `login` за час на один email с разных IP (`x-forwarded-for`, `trustProxy: true`) → 429; 4-я регистрация за час → 429; через 61 мин (`clock.advance`) снова 201.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement (время лимитера — из `deps.now` для тестируемости). **Step 4:** Run — PASS.
- [ ] **Step 5: Commit** `feat(api): rate limits`.

### Task 8: Оболочка `web` и экраны входа

**Files:**
- Create: `apps/web/src/styles/{tokens.css,global.css}`, `src/api/{client,queries}.ts`, `src/layout/{Shell,Nav}.tsx` + `.module.css`, `src/components/Mascot.tsx`, `src/screens/auth/{Login,Register,CheckEmail,Verify,Forgot,Reset}.tsx`, `src/App.tsx`
- Test: `apps/web/test/{client.test.ts,Register.test.tsx,Shell.test.tsx}`

**Interfaces:**
- Consumes: схемы `@rootcamp/api-contract`.
- Produces:
  - `tokens.css`: переменные палитры из `E:\Duolingo_Docker\src\ui\theme.ts` (`--bg:#151A2D`, `--surface:#1F2640`, `--surface-hi:#2A2A3A`, `--term:#0F1324`, `--line:#323B5C`, `--edge:#46507A`, `--ink:#E6E9F5`, `--muted:#9AA3C7`, `--faint:#6B7499`, `--amber:#FFB547`, `--amber-soft`, `--teal:#43D1B5`, `--teal-bg`, `--coral:#FF7A70`, `--coral-bg`, `--coral-ink`, `--flame:#FF9F43`, `--on-accent`, `--on-coral`, `--scrim`), `--space-{xs..xxl}` (4/8/12/16/24/32), `--radius-{sm,md,lg,pill}` (8/10/14/999), классы `.t-display`…`.t-code` по шкале `type`; шрифты `@fontsource/unbounded` 600/700, `@fontsource/ibm-plex-sans` 400/500/600, `@fontsource/jetbrains-mono`.
  - `apiFetch<T>(path, init?, schema?): Promise<T>` — добавляет `X-RC: 1` к не-GET, `credentials: 'same-origin'`; 401 → `navigate('/login?next=' + encodeURIComponent(location))`; ошибка → `ApiClientError {status, code, message}`. Хук `useMe()` (TanStack Query, ключ `['me']`).
  - `Shell`: раскладки §8.2 (`<640` нижняя панель, `640–1023` колонка ≤ 720 px + нижняя панель, `1024–1279` боковая 220 px, `≥1280` + правая колонка 300–360 px, max 1440 px). Пункты навигации, чьих экранов ещё нет, скрыты флагом `features` в `src/config.ts`.
  - `Mascot({ state: 'idle'|'happy'|'sad'|'waiting'|'sleep' })` — inline SVG по §8.1.
  - `ErrorBoundary` + `ErrorScreen` — на `500` и необработанных ошибках «Что-то сломалось (код <reqId>)» с маскотом `sad`.
  - Экран «Проверь почту»: адрес, «Отправить ещё раз» с таймером 60 с, подсказка про «Спам», форма «Сменить email», после 3 повторов — «Напиши администратору».

- [ ] **Step 1: Write the failing test**: `apiFetch('/api/auth/login', {method:'POST'})` шлёт заголовок `X-RC: 1`; на 401 вызывает навигацию на `/login?next=…`; `Register` блокирует кнопку при пароле < 10 символов и отправляет `tz` из `Intl.DateTimeFormat().resolvedOptions().timeZone`; `CheckEmail` — кнопка неактивна 60 с (`vi.useFakeTimers`); `Shell` при `innerWidth=390` рендерит нижнюю панель, при 1440 — боковую.
- [ ] **Step 2:** Run `pnpm --filter @rootcamp/web test` — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5: Commit** `feat(web): shell, tokens, auth screens`.

### Task 9: CLI, e2e-стенд и сценарий 1

**Files:**
- Create: `apps/api/src/cli.ts` (`rootcamp-cli`, commander), `infra/compose.e2e.yaml`, `e2e/{package.json,playwright.config.ts,helpers/mailpit.ts,helpers/users.ts,specs/01-register.spec.ts}`
- Test: `apps/api/test/cli.test.ts`, `e2e/specs/01-register.spec.ts`

**Interfaces:**
- Produces: `rootcamp-cli admin:grant <email>` (ставит `is_admin`, пишет `audit_log` с `actor_id=null`); Playwright-проекты `mobile` (390×844, `hasTouch`, `isMobile`) и `desktop` (1440×900); `baseURL=http://localhost:8081`; хелперы `latestMail(to): Promise<{subject; text; links: string[]}>`, `registerAndVerify(page, nick): Promise<{email; password}>`. Стенд e2e: caddy (`:8081`), web, api (`COOKIE_SECURE=false`, `PUBLIC_ORIGIN=http://localhost:8081`), postgres, mailpit (`:8026`). Скрипт `pnpm e2e` = `compose.e2e up -d --build --wait` → `playwright test` → `down -v`.

- [ ] **Step 1: Write the failing test** `cli.test.ts`: `admin:grant ann@x.ru` → `users.is_admin===true` и строка в `audit_log`; неизвестный email → код выхода 1.
- [ ] **Step 2: Write the failing e2e** `01-register.spec.ts`: регистрация → экран «Проверь почту» → письмо в Mailpit → переход по ссылке → главная (в M2 — заглушка «Путь») показывает ник; выход → вход тем же паролем → снова главная.
- [ ] **Step 3:** Run `pnpm --filter @rootcamp/api test cli && pnpm e2e` — Expected: FAIL.
- [ ] **Step 4:** Implement. **Step 5:** Run — Expected: PASS в обоих проектах.
- [ ] **Step 6:** Добавить в `ci.yml` джобы `integration` (Testcontainers) и `e2e`. **Commit** `feat: rootcamp-cli, e2e stand, registration e2e`.

### Task 10: Демо вехи M2

- [ ] **Step 1:** Run `pnpm test` — Expected: зелёные unit и интеграционные тесты, включая `auth`, `me`, `limits`, `email`.
- [ ] **Step 2:** Run `pnpm e2e` — Expected: `01-register` passed ×2 (mobile, desktop).
- [ ] **Step 3:** Run `pnpm dev:up`, открыть `http://localhost:8080/register` в Chrome с эмуляцией iPhone (390 px) — зарегистрироваться, открыть письмо в `http://localhost:8025`, перейти по ссылке, увидеть главную. Затем 6 неверных входов подряд — на 6-м «Слишком много попыток».
- [ ] **Step 4:** Run `docker compose -f infra/compose.yaml -f infra/compose.dev.yaml exec api node dist/cli.js admin:grant <email>` — Expected: `granted`. Показать пользователю вывод и скриншоты двух вьюпортов.
