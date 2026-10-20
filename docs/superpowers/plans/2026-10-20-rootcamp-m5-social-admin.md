# rootcamp M5 «Социальное и админка» Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Недельный лидерборд (все и друзья), заявки в друзья, профиль с настройками, email-напоминания и админка с мониторингом, банами и управлением песочницами — с e2e лидерборда и админки.

**Architecture:** Неделя считается по `xp_events.created_at` в поясе `Europe/Moscow` (пн 00:00 — вс 24:00), а не по `xp_events.day` (тот в поясе пользователя). Друзья — две строки `friendships` на пару. Напоминания и недельные снимки — задания pg-boss. Админка читает метрики `sandboxd` через внутренний клиент и пишет каждое действие в `audit_log`.

**Tech Stack:** как в M2–M4a.

**Spec:** `docs/superpowers/specs/2026-10-20-rootcamp-design.md` (A9, §4.4 social-таблицы, §5.1 «Социальное», «Админка», §7.4, §8.1 Лидерборд/Профиль/Админка, §10.2 лидерборд/админка/напоминания, §10.4 сценарии 6–7). Предыдущая веха: M4a (M4b может идти параллельно на VPS).

## Global Constraints

- Все Global Constraints из M1–M4a.
- Неделя лидерборда: пн–вс, `Europe/Moscow`; `weekEndsAt` — пн 00:00 MSK следующей недели.
- `GET /api/profile/:nick` — только для себя и друзей; для остальных `404 not_found` (не раскрывать существование ника).
- Напоминание: задание `reminders` каждые 5 мин; условия — `reminder_enabled`, подтверждённый email, `status='active'`, локальное время ≥ `reminder_time`, сегодня по поясу пользователя нет `xp_events`, нет строки `reminder_log(user_id, day)`. Текст: «Не потеряй серию из N дней», если вчера была активность, иначе общий. Подписанная (HMAC) ссылка «Отключить напоминания» без входа.
- Админ-эндпоинты требуют `is_admin`, иначе `403 forbidden`; каждое действие — строка `audit_log`. Бан удаляет сессии и останавливает песочницу (`reason: banned`). `registration_mode` — только `open|closed`.
- Админка обновляется раз в 10 с.

## Review Focus

1. Два пользователя одновременно шлют друг другу заявки — создаётся одна дружба, без дублей и 500 (тест в Task 1: параллельные запросы).
2. Пользователь из `Asia/Vladivostok` зарабатывает XP в понедельник 05:00 по своему времени (вс 22:00 MSK) — XP попадает в прошлую неделю лидерборда (тест в Task 2).
3. Пользователь включает напоминание на 20:00 в 20:03 — письмо приходит при ближайшем прогоне сегодня, а не завтра; при повторном прогоне — не дублируется (тест в Task 4).
4. Админ банит сам себя или снимает права у последнего админа — запрещено (`403 forbidden`), иначе админка становится недоступна (тест в Task 5).
5. Забаненный пользователь открыт на экране практики — следующий запрос даёт экран «Аккаунт заблокирован» с причиной, терминал закрывается с `banned` (тест в Task 7 e2e).

---

## File Structure

```
packages/logic/src/week.ts
packages/db/src/schema/social.ts (friend_requests, friendships, reminder_log, weekly_results)
packages/api-contract/src/{social,admin}.ts
apps/api/src/services/{friends,leaderboard,profile,reminders,admin}.ts
apps/api/src/routes/{friends,leaderboard,profile,reminders,admin}.ts
apps/api/src/jobs/{reminders,weeklySnapshot}.ts, apps/api/src/mail/templates.ts (reminder)
apps/web/src/screens/{Leaderboard,Profile,Admin,Banned,Unsubscribe}/**
e2e/specs/{06-friends-leaderboard,07-admin}.spec.ts
```

---

### Task 1: Друзья

**Files:**
- Create: `packages/db/src/schema/social.ts` + миграция `0003_*` (уникальность пары `friend_requests(least(from,to), greatest(from,to)) WHERE status='pending'`), `apps/api/src/services/friends.ts`, `src/routes/friends.ts`, `packages/api-contract/src/social.ts`
- Test: `apps/api/test/friends.test.ts`

**Interfaces:**
- Produces: `sendRequest(db, me, nick)`, `accept(db, me, requestId)`, `decline(db, me, requestId)`, `removeFriend(db, me, nick)`, `listFriends(db, me, now): FriendsDto` (`weekXp` — Task 2 `weekXpOf`). Встречная `pending`-заявка → дружба сразу (обе заявки `accepted`). Всё в транзакции с `SELECT … FOR UPDATE` пары (advisory lock по `hashtext(least||greatest)`).

- [ ] **Step 1: Write the failing test**: заявка на себя → 400 `self`; на несуществующий ник → 404 `not_found`; повтор → 409 `already_requested`; другу → 409 `already_friends`; встречная → 201 и обе стороны видят друг друга в `friends`; `Promise.all` двух встречных заявок → ровно 2 строки `friendships`; `DELETE /api/friends/:nick` удаляет обе строки.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5: Commit** `feat(api): friends`.

### Task 2: Лидерборд и недельный снимок

**Files:**
- Create: `packages/logic/src/week.ts`, `apps/api/src/services/leaderboard.ts`, `src/routes/leaderboard.ts`, `src/jobs/weeklySnapshot.ts`
- Test: `packages/logic/test/week.test.ts`, `apps/api/test/leaderboard.test.ts`

**Interfaces:**
- Produces:
  - `WEEK_TZ = 'Europe/Moscow'`; `weekBounds(nowMs: number): { weekStart: DateKey; startMs: number; endMs: number }`.
  - `leaderboard(db, me, scope: 'all'|'friends', now): LeaderboardDto` — сумма `xp_events.amount` с `created_at ∈ [startMs, endMs)` по активным пользователям; строки с `xp > 0` плюс всегда текущий пользователь; `place` — `RANK() OVER (ORDER BY xp DESC)`, порядок внутри места — по нику; `friends` — я и друзья. `weekXpOf(db, userIds, now): Map<string, number>`.
  - Задание `weekly-snapshot` (cron `5 0 * * 1`, tz `Europe/Moscow`): пишет `weekly_results` прошлой недели (`ON CONFLICT DO NOTHING`).

- [ ] **Step 1: Write the failing test**: `weekBounds(Date.UTC(2026,9,18,20,59))` (вс 23:59 MSK) → `weekStart '2026-10-12'`; `Date.UTC(2026,9,18,21,0)` → `'2026-10-19'`; XP пользователя `Asia/Vladivostok` с `created_at=2026-10-18T19:00Z` не входит в неделю `2026-10-19`; два пользователя по 30 XP → оба `place:1`; `scope=friends` без друзей → только я; снимок пишет `weekly_results` и повторный прогон не дублирует.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5: Commit** `feat: weekly leaderboard`.

### Task 3: Профиль

**Files:**
- Create: `apps/api/src/services/profile.ts`, `src/routes/profile.ts`
- Test: `apps/api/test/profile.test.ts`

**Interfaces:**
- Consumes: `weekBars`, `toDateKey`, `lastNDays`, `nextRankProgress`, `ContentStore`.
- Produces: `GET /api/profile/:nick` → `{nick, rank, nextRank, totalXp, streak, best, tracks: [{id, title, completedLessons, totalLessons, done}], weekBars, history: [{weekStart, xp, place}]}`; `weekBars` из `xp_events` за 7 дней по `day` (пояс профиля), цель 30.

- [ ] **Step 1: Write the failing test**: свой профиль → 200; профиль друга → 200; чужого → 404 `not_found`; `weekBars` из 7 элементов, последний — сегодня; `history` из `weekly_results` по убыванию даты.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5: Commit** `feat(api): profile`.

### Task 4: Напоминания

**Files:**
- Create: `apps/api/src/services/reminders.ts`, `src/jobs/reminders.ts`, `src/routes/reminders.ts` (`POST /api/reminders/unsubscribe {u, sig}` без сессии), `apps/web/src/screens/Unsubscribe/UnsubscribeScreen.tsx`
- Modify: `apps/api/src/mail/templates.ts` (`reminderEmail({streak, unsubscribeUrl})`), `apps/api/src/config.ts` (`REMINDER_SECRET`)
- Test: `apps/api/test/reminders.test.ts`

**Interfaces:**
- Consumes: `toDateKey`, `localTimeOn`, `addDays`, `pluralDays`.
- Produces: `dueReminders(db, now): Promise<{userId; email; streak: number}[]>` (условия из Global Constraints; `streak` = `streaks.current`, если `last_activity_date` = вчера по поясу пользователя, иначе 0); `runReminders(db, boss, now)` пишет `reminder_log` и ставит письмо в одной транзакции; `signUnsubscribe(userId, secret): string`, `verifyUnsubscribe(u, sig, secret): boolean` (секрет `REMINDER_SECRET`). Ссылка — `${PUBLIC_ORIGIN}/unsubscribe?u=…&sig=…`.

- [ ] **Step 1: Write the failing test**: 20:03 по поясу пользователя, `reminder_time=20:00`, нет XP → письмо «Не потеряй серию из 3 дней»; второй прогон → писем не прибавилось; есть XP сегодня → письма нет; неподтверждённый email → нет; вчера не было активности → общий текст; `unsubscribe` с верной подписью → `reminder_enabled=false`, с неверной → 403 `forbidden`.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5: Commit** `feat(api): email reminders`.

### Task 5: Админ-API

**Files:**
- Create: `apps/api/src/services/admin.ts`, `src/routes/admin.ts`, `packages/api-contract/src/admin.ts`
- Modify: `apps/sandboxd/src/metrics.ts` (проверка зеркал: TCP-подключение к `172.30.0.1:3142` и `:5000`, в dev — пропуск), `apps/api/src/routes/health.ts`
- Test: `apps/api/test/admin.test.ts`

**Interfaces:**
- Consumes: `SandboxdClient.metrics()`, `.remove()`, `revokeAllSessions`, `issueEmailToken`, `enqueueEmail`.
- Produces: маршруты §5.1 «Админка». `summary.services` — `api`, `db`, `sandboxd`, `apt-mirror`, `registry`, `smtp` (здоров, если нет `email_log` в `failed` за 24 ч). `sandboxes.budgetMb = 5120`, `reservedMb` — сумма `mem_mb` активных, `queue` — число `queued`. `users[].currentTrack` — трек последнего завершённого урока. `ban` запрещён для себя и для другого админа (`403 forbidden`). `audit_log.action` ∈ `ban, unban, verify_email, resend_verification, stop_sandbox, settings`.

- [ ] **Step 1: Write the failing test** (фейк sandboxd): обычный пользователь → 403 `forbidden`; `ban` → у цели сессии удалены, фейк получил `remove(…, 'banned')`, строка `audit_log`; забаненный → `GET /api/me` 403 `banned`; `ban` себя → 403; `PATCH /api/admin/settings {registrationMode:'closed'}` → регистрация отвечает `registration_closed`; `verify-email` → `email_verified_at` выставлен.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5: Commit** `feat(api): admin endpoints`.

### Task 6: Экраны «Лидерборд», «Профиль», правая колонка

**Files:**
- Create: `apps/web/src/screens/Leaderboard/{LeaderboardScreen,FriendsBlock}.tsx`, `src/screens/Profile/{ProfileScreen,SettingsForm,WeekBars}.tsx`, `src/screens/Banned/BannedScreen.tsx`
- Modify: `apps/web/src/screens/Path/RightColumn.tsx` (блок «Неделя» — топ-4), `src/api/client.ts` (`403 banned` → `/banned`), `src/config.ts` (включить вкладки)
- Test: `apps/web/test/{Leaderboard,Profile}.test.tsx`

**Interfaces:**
- Produces: `/leaderboard` — вкладки «Все»/«Друзья», отсчёт до `weekEndsAt`, блок «Друзья» (поле «Добавить по нику», входящие с «Принять»/«Отклонить», исходящие); `/profile` и `/u/:nick` — ранг и прогресс до следующего, всего XP, серия и рекорд, `WeekBars` (перенос `src/ui/components/WeekBars.tsx` DockerLingo на DOM), треки, история мест; настройки только своему: напоминания вкл/выкл и время, пояс (список `Intl.supportedValuesOf('timeZone')`), смена пароля, выход; для админа — ссылка «Админка». `/banned` — причина из ответа.

- [ ] **Step 1: Write the failing test**: вкладка «Друзья» запрашивает `scope=friends`; строка `isMe` выделена; принятие заявки инвалидирует `['friends']` и `['leaderboard']`; `SettingsForm` шлёт `PATCH /api/me {reminderTime:'21:30'}`; чужой профиль не показывает настройки.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5: Commit** `feat(web): leaderboard, friends, profile`.

### Task 7: Экран «Админка» и e2e 6–7

**Files:**
- Create: `apps/web/src/screens/Admin/{AdminScreen,Tiles,SandboxesTable,UsersTable,RegistrationToggle}.tsx`, `e2e/specs/{06-friends-leaderboard,07-admin}.spec.ts`
- Modify: `e2e/specs/a11y.spec.ts` (+ Практика, Профиль)
- Test: `apps/web/test/Admin.test.tsx`

**Interfaces:**
- Produces: `/admin` (только `isAdmin`, иначе редирект на `/`) — плитки CPU/Память/Диск/Песочницы (очередь, слот `heavy`), таблица песочниц с «Остановить», таблица пользователей (ник, email, ранг, XP, текущий трек, «был», статус, «Бан»/«Разбан» с вводом причины, «Подтвердить email»), переключатель регистрации; опрос раз в 10 с. На телефоне таблицы — карточки.

- [ ] **Step 1: Write the failing test** `Admin.test.tsx`: «Бан» без причины не отправляется; после бана строка показывает «Разбан».
- [ ] **Step 2: Write the failing e2e**: (6) два пользователя (два контекста), заявка, принятие, оба видят друг друга на вкладке «Друзья» лидерборда с XP; (7) админ (через `rootcamp-cli admin:grant`) останавливает песочницу второго пользователя (тот видит `closed: stopped_by_admin`), банит его — у забаненного экран «Аккаунт заблокирован» с причиной. Axe: Практика и Профиль без `serious`.
- [ ] **Step 3:** Run `pnpm --filter @rootcamp/web test && pnpm e2e` — FAIL. **Step 4:** Implement. **Step 5:** Run — PASS ×2 вьюпорта.
- [ ] **Step 6: Commit** `feat(web): admin screen; e2e friends and admin`.

### Task 8: Демо вехи M5

- [ ] **Step 1:** Run `pnpm test && pnpm e2e` — Expected: зелёные, сценарии 1–7 ×2 вьюпорта, axe по 4 экранам без `serious`.
- [ ] **Step 2:** `pnpm dev:up`; два браузерных профиля: подружиться, пройти по уроку, увидеть оба ника на `/leaderboard` → «Друзья»; в профиле включить напоминание на ближайшие 5 минут — письмо в Mailpit с «Отключить напоминания»; переход по ссылке отключает.
- [ ] **Step 3:** Под админом открыть `/admin` на 1440 px и 390 px: плитки с числами, запущенная песочница видна и останавливается, бан работает. Показать пользователю скриншоты и вывод тестов.
