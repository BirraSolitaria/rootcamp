# rootcamp M6 «Эксплуатация» Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Продакшен-развёртывание на VPS с TLS, деплой из GitHub Actions с откатом, ежедневные бэкапы с внешней копией и проверкой восстановления, алерты админам и регламентные задачи — чек-лист запуска §11.6 выполнен.

**Architecture:** CI публикует образы `api`, `sandboxd`, `web` (Caddy + `web-dist`) в GHCR с тегом коммита. `deploy.sh <sha>` на VPS тянет образы, устанавливает контент из образа `api`, гоняет `practice:test --changed`, поднимает compose и активирует контент; при ошибке откатывается по `infra/.deployed`. Бэкап — отдельный контейнер с cron. Все алерты сводятся в таблицу `alert_events`, которую разбирает задание `alerts` в `api`.

**Tech Stack:** Docker Compose, Caddy 2, GitHub Actions + GHCR + environment `production`, restic, postgres-client 16, supercronic, Renovate.

**Spec:** `docs/superpowers/specs/2026-10-20-rootcamp-design.md` (§3.2 Caddy/backup, §6.3 «Обновления», §6.6 суточная очистка, §10.7, §11.1–11.6, §12 `user:delete`). Предыдущие вехи: M1–M5 (M4b обязательна).

## Global Constraints

- Все Global Constraints из M1–M5.
- Состав и лимиты compose (§11.1): caddy 256 МБ, api 512, sandboxd 256, postgres 768 (`shared_buffers=256MB`), apt-mirror 128, registry 128, dnsmasq 32, backup 128. Логи — `json-file`, `max-size 10m`, `max-file 3`. Сеть `rc-sbx` — вне compose.
- Caddy: автоматический TLS (Let's Encrypt), CSP, HSTS; `/content/*` — `Cache-Control: public, max-age=31536000, immutable`; серверная часть контента в Caddy не монтируется.
- Деплой: `docker compose pull` → `content:install <sha>` → `practice:test --changed` → `up -d` → `content:activate <hash>` → smoke `curl /api/health`; красный шаг 3–6 → откат. Миграции только расширяющие.
- Бэкап: ежедневно 03:30 MSK `pg_dump -Fc` → `/backups/rootcamp-YYYYMMDD.dump`; локально 7 ежедневных + 4 воскресных; `restic backup` → S3 (A8), `forget --keep-daily 14 --keep-weekly 8 --prune`. `caddy-data` и кэши зеркал не бэкапятся.
- Алерты (письмо всем `is_admin`, не чаще одного на тип в 30 мин): RAM > 90 % три замера подряд; диск > 85 %; сервис нездоров 2 мин; ошибка бэкапа; `setup_failed`; 5xx > 10/мин; `email_log failed`; песочница падает повторно (> 2 раз за час); провал пересборки образов; провал `restore-test`.
- Расписания (MSK): бэкап 03:30; суточная очистка Docker 04:00 (`sandboxd`); пересборка образов — первое воскресенье месяца 04:30; `restore-test` — 1-го числа 05:30; перезагрузка `unattended-upgrades` — вс 05:00.

## Review Focus

1. Деплой упал на `practice:test --changed` — старая версия продолжает работать, контент не активирован, `infra/.deployed` не изменён (тест в Task 2: `deploy.sh` с фейковым шагом, возвращающим 1).
2. S3 недоступно при бэкапе — локальный дамп всё равно сохранён, приходит один алерт `backup`, а не по письму в минуту (тест в Task 3 и Task 4: троттлинг 30 мин).
3. Диск заполняется логами сервисов — ротация `json-file` ограничивает рост (проверка в Task 1: `docker inspect` каждого сервиса показывает `max-size`).
4. Сертификат ещё не выпущен (DNS не обновился) — Caddy повторяет выпуск, не падает, `api` доступен по HTTP-челленджу после обновления DNS (проверка в Task 6).
5. Пользователь удалён через `user:delete` — все его строки (`sessions`, `xp_events`, `friendships`, песочница) удалены, лидерборд и друзья других пользователей не ломаются (тест в Task 5).

---

## File Structure

```
apps/web/Dockerfile (multi-stage: vite build → caddy:2 + /srv/web-dist), apps/api/Dockerfile (+ content-dist в образе), apps/sandboxd/Dockerfile
infra/Caddyfile, infra/compose.yaml (полный), infra/.env.example
infra/scripts/{deploy.sh,restore-test.sh,crontab.deploy}
infra/backup/{Dockerfile,backup.sh,crontab}
.github/workflows/{ci.yml,deploy.yml}, renovate.json
packages/db/src/schema/ops.ts (alert_events)
apps/api/src/jobs/alerts.ts, apps/api/src/services/{alerts,metricsSampler}.ts, apps/api/src/cli.ts (user:delete, content:install)
```

Решение сверх спецификации: таблица `alert_events(id, type, message, created_at, sent_at)` — единая точка, куда пишут и `api`, и shell-скрипты (`backup.sh`, `rebuild-sandbox-images.sh`, `restore-test.sh` через `psql`), а задание `alerts` рассылает письма с троттлингом.

---

### Task 1: Продакшен-образы, Caddyfile и полный compose

**Files:**
- Create: `infra/Caddyfile`, `infra/.env.example`, `apps/web/Dockerfile`
- Modify: `apps/api/Dockerfile` (сборка `content-dist` в `/app/content-dist`), `infra/compose.yaml`
- Test: `infra/test/compose.test.sh`, `infra/test/caddy.test.sh`

**Interfaces:**
- Produces: `Caddyfile` — `{$DOMAIN}`: `header` HSTS `max-age=31536000; includeSubDomains`, CSP `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' wss://{$DOMAIN}; frame-ancestors 'none'`, `X-Content-Type-Options nosniff`, `Referrer-Policy same-origin`; `handle /api/*` → `api:3000`; `handle /ws/terminal*` → `sandboxd:3001`; `handle /content/*` → `file_server` из `/srv/content/public` с immutable; иначе SPA `try_files {path} /index.html`. `.env.example` — все переменные `Config` api и sandboxd, `DOMAIN`, `IMAGE_TAG`, `RESTIC_*`, `S3_*`.

- [ ] **Step 1: Write the failing test**: `compose.test.sh` — `docker compose -f infra/compose.yaml config` содержит у каждого сервиса `mem_limit` из Global Constraints и `logging.options.max-size=10m`; том `content-dist` смонтирован в caddy как `…/public` и в api целиком; `caddy.test.sh` (локально через `compose.build.yaml` + `DOMAIN=localhost`) — `curl -I /` содержит `strict-transport-security` и `content-security-policy`, `curl -I /content/<hash>/catalog.json` — `immutable`, `curl /content/<hash>/../server/` → 404.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5: Commit** `feat(infra): production images, Caddyfile, compose`.

### Task 2: Публикация образов, деплой и откат

**Files:**
- Create: `infra/scripts/deploy.sh`, `.github/workflows/deploy.yml`
- Modify: `.github/workflows/ci.yml` (на `main`: push `ghcr.io/<repo>/{api,sandboxd,web}:<sha>`; `content:build --update-published-ids` и коммит `content/published-ids.json` с `[skip ci]`), `apps/api/src/cli.ts` (`content:install <sha>` — копирует `/app/content-dist/{public,server}/<hash>` в том, печатает `<hash>`)
- Test: `infra/scripts/test/deploy.test.sh` (bats-подобный, команды подменяются через `PATH` и `DEPLOY_DRY=1`)

**Interfaces:**
- Produces: `deploy.sh <sha>` и `deploy.sh --rollback`; файл `infra/.deployed` (`IMAGE_TAG=<sha>`, `CONTENT_HASH=<hash>`, `GIT_SHA=<sha>`) обновляется только после успешного smoke; `practice:test --changed --since <GIT_SHA из .deployed>`. `deploy.yml`: `workflow_dispatch` и после зелёного `ci` на `main`, `environment: production` (ручное подтверждение), шаг `ssh deploy@$VPS "cd /opt/rootcamp && git fetch && git checkout <sha> && infra/scripts/deploy.sh <sha>"`.

- [ ] **Step 1: Write the failing test**: при `practice:test` с кодом 1 — `deploy.sh` выходит с 1, `content:activate` не вызывался, `.deployed` не изменился, вызван `up -d` с прежним `IMAGE_TAG`; при успехе — шаги в порядке §11.2 и новый `.deployed`; `--rollback` поднимает теги из `.deployed`.
- [ ] **Step 2:** Run `bash infra/scripts/test/deploy.test.sh` — FAIL. **Step 3:** Implement (`set -euo pipefail`, `trap` для отката). **Step 4:** Run — PASS.
- [ ] **Step 5: Commit** `feat(infra): GHCR publish and deploy with rollback`.

### Task 3: Бэкапы и проверка восстановления

**Files:**
- Create: `infra/backup/{Dockerfile,backup.sh,crontab}`, `infra/scripts/restore-test.sh`, `packages/db/src/schema/ops.ts` + миграция `0004_*` (`alert_events`)
- Modify: `infra/compose.yaml` (сервис `backup`: `rc-internal`, `rc-mirror-egress`, том `backups`, `TZ=Europe/Moscow`)
- Test: `infra/backup/test/backup.test.sh`

**Interfaces:**
- Produces: `backup.sh` — `pg_dump -Fc` → `/backups/rootcamp-$(date +%Y%m%d).dump`; ротация (удалить ежедневные старше 7 дней, кроме воскресных моложе 28 дней); `restic backup /backups/<файл>` + `restic forget --keep-daily 14 --keep-weekly 8 --prune`; при любой ошибке — `INSERT INTO alert_events(type,message) VALUES ('backup', …)` и код 1 (локальный дамп при ошибке restic остаётся). `restore-test.sh` — `docker run --rm postgres:16` во временной сети, `pg_restore` последнего дампа, `SELECT count(*) FROM users`, `… FROM xp_events` > 0 (или равны значениям из боевой БД на момент дампа ± новые строки), лог в `/var/log/rootcamp/restore-test.log`, ошибка → `alert_events('restore_test')`.

- [ ] **Step 1: Write the failing test**: на compose-стенде с тестовыми данными `docker compose exec backup /backup.sh` → файл дампа существует; `RESTIC_REPOSITORY` недоступен → код 1, дамп на месте, 1 строка `alert_events(type='backup')`; `restore-test.sh` → `OK users=<N> xp_events=<M>`.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement (cron — supercronic). **Step 4:** Run — PASS.
- [ ] **Step 5: Commit** `feat(infra): backups with restic and restore test`.

### Task 4: Алерты

**Files:**
- Create: `apps/api/src/services/{alerts,metricsSampler}.ts`, `apps/api/src/jobs/alerts.ts`, шаблон `alertEmail` в `src/mail/templates.ts`
- Modify: `apps/api/src/plugins/errors.ts` (счётчик 5xx в скользящем окне 1 мин), `infra/scripts/rebuild-sandbox-images.sh` (провал → `alert_events('image_rebuild')`)
- Test: `apps/api/test/alerts.test.ts`

**Interfaces:**
- Consumes: `SandboxdClient.metrics()`, таблицы `sandboxes`, `email_log`, `alert_events`, `settings`.
- Produces: `collectAlerts(ctx, now): AlertCandidate[]` — чистая проверка правил из Global Constraints (`ram` по трём последним замерам семплера раз в минуту; `disk`; `service:<name>` нездоров ≥ 2 мин; `setup_failed` — новые `sandboxes.stop_reason='setup_failed'` с первыми 2000 символами `failure_output`; `sandbox_crash` — > 2 `failed` (`oom|crashed`) у одного пользователя за час; `email_failed`; `http_5xx` > 10/мин; необработанные `alert_events`). `sendAlerts(db, boss, candidates, now)` — троттлинг по `settings.alerts_last_sent[type]` (30 мин), письмо всем `is_admin`, `email_log.kind='alert'`, `alert_events.sent_at`.

- [ ] **Step 1: Write the failing test**: RAM 95 % в двух замерах → нет алерта, в трёх → один; повторный прогон через 10 мин → писем не прибавилось, через 31 мин → +1; `alert_events('backup')` → письмо с текстом ошибки; 11 ответов 500 за минуту → алерт `http_5xx`; песочница `setup_failed` → письмо содержит id практики и начало вывода.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5: Commit** `feat(api): admin alerts`.

### Task 5: Регламент и служебные команды

**Files:**
- Create: `infra/scripts/crontab.deploy` (пересборка образов — `30 4 1-7 * 0` с проверкой воскресенья, `restore-test` — `30 5 1 * *`, `CRON_TZ=Europe/Moscow`), `renovate.json` (npm и базовые образы, раз в неделю)
- Modify: `apps/api/src/cli.ts` (`user:delete <email>` — останавливает песочницу, удаляет пользователя каскадно, пишет `audit_log`), `packages/db` миграция `0005_*` (`ON DELETE CASCADE` для внешних ключей на `users`, если их не было; `audit_log.target_id` без FK)
- Test: `apps/api/test/cli.test.ts` (дополнить)

- [ ] **Step 1: Write the failing test**: `user:delete` → строк пользователя нет ни в одной таблице, кроме `audit_log`; лидерборд и `friends` второго пользователя отвечают 200; фейк sandboxd получил `remove(…, 'stopped_by_admin')`.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5 (VPS):** `crontab -u deploy infra/scripts/crontab.deploy`; `crontab -l -u deploy` показывает обе задачи. **Commit** `feat(ops): user:delete, cron, renovate`.

### Task 6: Демо вехи M6 — чек-лист запуска §11.6 (VPS)

- [ ] **Step 1:** DNS и TLS: `curl -I https://<домен>/` → 200, HSTS и CSP в заголовках; `https://<домен>/api/health` → `{"db":true,"sandboxd":true,"smtpLastOkAt":…}`.
- [ ] **Step 2:** Деплой из GitHub Actions: запустить `deploy` с подтверждением в environment `production` → зелёный; `cat /opt/rootcamp/infra/.deployed` показывает новый `sha`.
- [ ] **Step 3:** SMTP: зарегистрировать ящики Gmail и Яндекс, письма подтверждения приходят во «Входящие» (не в спам) — показать скриншоты.
- [ ] **Step 4:** `docker compose exec api node dist/cli.js admin:grant <email владельца>` → `granted`; `/admin` открывается.
- [ ] **Step 5:** `docker compose exec backup /backup.sh` → дамп и `restic snapshots` показывает снимок; `bash infra/scripts/restore-test.sh` → `OK users=… xp_events=…`.
- [ ] **Step 6:** `docker compose exec api node dist/cli.js practice:test --all` → 3 инцидента + `isolation` — `ok`.
- [ ] **Step 7:** Алерт: `fallocate -l <N>G /var/tmp/fill` до > 85 % диска → письмо «disk» админу в течение 2 мин; удалить файл.
- [ ] **Step 8:** В админке регистрация «открыта»; пройти урок и инцидент с телефона по `https://<домен>`. Показать пользователю вывод всех шагов — только после этого веха и v1 считаются готовыми.
