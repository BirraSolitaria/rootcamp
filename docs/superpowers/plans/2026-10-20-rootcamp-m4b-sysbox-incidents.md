# rootcamp M4b «Песочницы: Sysbox, образы, сеть, три инцидента (VPS)» Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** На VPS с Sysbox песочницы получают настоящий systemd и dockerd, изолированы от интернета, хоста и друг друга; три эталонных инцидента и тест изоляции проходят `rootcamp-cli practice:test --all`.

**Architecture:** `bootstrap-vps.sh` готовит хост (Docker, Sysbox, сеть `rc-sbx`, файрвол). Драйвер `sysbox` реализует интерфейс `SandboxDriver` из M4a. Зеркала (`apt-cacher-ng`, `registry:2` pull-through, `dnsmasq`) слушают только `172.30.0.1`. `practice:test` и самотест изоляции идут через настоящий `sandboxd` вне пользовательской очереди. До M6 стенд на VPS собирается из исходников и доступен через SSH-туннель.

**Tech Stack:** Ubuntu 24.04, Docker Engine, Sysbox CE (.deb, версия в `infra/versions.env`), iptables, systemd, apt-cacher-ng, registry:2, dnsmasq, bash, shellcheck.

**Spec:** `docs/superpowers/specs/2026-10-20-rootcamp-design.md` (§1.3, §2.3 п.3, §6.1, §6.2 п.3–5, §6.3, §6.4, §6.8, §6.9, §10.3, §10.5, §11.1 зеркала, §11.2 bootstrap). Предыдущая веха: `2026-10-20-rootcamp-m4a-sandboxd-dev.md`.

## Global Constraints

- Все Global Constraints из M1–M4a.
- **Эта веха выполняется только на VPS** (4 vCPU / 8 ГБ / 80 ГБ, KVM, Ubuntu 24.04, ядро 6.8+). На Windows/Docker Desktop Sysbox недоступен: там можно только писать код, собирать образы `rc/linux-base` и `rc/docker` и гонять shellcheck; всё, что помечено «VPS», там не запускать.
- Контейнер песочницы: `--runtime=sysbox-runc`, `--network rc-sbx`, `--dns 172.30.0.1`, лимиты по классу, без `--privileged`, без монтирования хостовых путей и `docker.sock`, без `--cap-add` и `seccomp=unconfined`; seccomp Docker по умолчанию и AppArmor `docker-default` остаются.
- Сеть `rc-sbx`: bridge, `internal: true`, `com.docker.network.bridge.enable_icc=false`, `172.30.0.0/24`, шлюз `172.30.0.1`. Из подсети разрешены только `172.30.0.1` tcp 3142, tcp 5000, udp/tcp 53.
- apt-cacher-ng пропускает только `archive.ubuntu.com`, `security.ubuntu.com`, `download.docker.com`. dnsmasq отвечает только для имён зеркал, остальное — NXDOMAIN.
- Образы: `rc/linux-base:24.04` (`ubuntu:24.04` + systemd PID 1, nginx, curl, nano, vim-tiny, less, tmux, sudo, iproute2, procps, man-db с man-страницами), `rc/docker:24.04` (+ Docker Engine, compose v2, `daemon.json` с `registry-mirrors: ["http://172.30.0.1:5000"]`); в каждом `/etc/apt/apt.conf.d/01proxy`, `/etc/tmux.conf` (статус выключен, `history-limit 5000`, `mouse off`), `STOPSIGNAL SIGRTMIN+3`.
- Готовность: `light` ≤ 20 с, `docker` ≤ 40 с от создания до `ready` (при прогретых образах).
- Проверки вызывают бинарники по абсолютным путям и печатают понятную русскую фразу в stdout при неуспехе.
- Все `*.sh` — LF, `#!/usr/bin/env bash`, `set -euo pipefail` (кроме check-скриптов, где нужен контролируемый код возврата), shellcheck без warning.

## Review Focus

1. Пользователь внутри `inc-container-crash` делает `docker pull nginx` — образ тянется через зеркало, а не висит на таймауте (тест в Task 2: pull через registry-mirror из песочницы `docker`).
2. Пользователь решает `inc-nginx-down` не тем способом, что `solution.sh` (удаляет сайт и создаёт свой с маркером), — проверки засчитывают только состояние системы; каждый check проходит дважды подряд (идемпотентность, тест в Task 5).
3. Перезагрузка VPS (unattended-upgrades в воскресенье): после неё сеть `rc-sbx` и правила iptables на месте до старта `sandboxd` (тест в Task 1: `systemctl restart docker` → правила восстановлены юнитом).
4. Внутри песочницы `docker` пользователь запускает контейнер, заполняющий диск, — песочница останавливается с `disk_quota`, учитывая каталог `/var/lib/sysbox/docker/<id>` (тест в Task 3).
5. `setup.sh` инцидента обращается в сеть (apt) и зеркало недоступно — setup падает за `setupTimeoutSec`, а не висит бесконечно; запуск получает `setup_failed` (тест в Task 4: `practice:test` с остановленным `apt-mirror` даёт понятную ошибку).

---

## File Structure

```
infra/scripts/bootstrap-vps.sh, infra/versions.env, infra/iptables/rc-sbx.rules, infra/systemd/rc-sbx-firewall.service
infra/mirrors/{acng.conf,dnsmasq/Dockerfile,dnsmasq/dnsmasq.conf}, infra/compose.yaml (сервисы apt-mirror, registry, dnsmasq, sandboxd)
infra/compose.build.yaml (сборка образов приложений из исходников), infra/compose.vps-test.yaml (Caddyfile.dev на 127.0.0.1:8080)
sandbox/images/{registry.yaml,linux-base/Dockerfile,docker/Dockerfile,common/{apt.conf,daemon.json,motd.sh,tmux.conf}}
apps/sandboxd/src/driver/sysbox.ts, apps/sandboxd/src/selftest/isolation.ts, apps/sandboxd/test/isolation.test.ts
apps/api/src/practiceTest/{run,changed,report}.ts (команда rootcamp-cli practice:test)
content/practices/{inc-nginx-down,inc-file-perms,inc-container-crash}/{practice.yaml,setup.sh,check/*.sh,solution.sh}
infra/scripts/rebuild-sandbox-images.sh
```

---

### Task 1: Подготовка VPS и файрвол песочниц

**Files:**
- Create: `infra/scripts/bootstrap-vps.sh`, `infra/versions.env` (`SYSBOX_VERSION=…`, `DOCKER_VERSION=…`), `infra/iptables/rc-sbx.rules`, `infra/systemd/rc-sbx-firewall.service`
- Test: `infra/scripts/test/bootstrap-check.sh` (проверки состояния хоста, идемпотентна)

**Interfaces:**
- Produces: идемпотентный `bootstrap-vps.sh` (повторный запуск ничего не ломает): Docker Engine из репозитория Docker, Sysbox CE `.deb` версии `SYSBOX_VERSION`, swap 2 ГБ, сеть `rc-sbx` (параметры из Global Constraints), юнит `rc-sbx-firewall.service` (`After=docker.service`, `PartOf=docker.service`, `ExecStart=iptables-restore --noflush /opt/rootcamp/rc-sbx.rules`), ufw (22, 80, 443), `unattended-upgrades` с перезагрузкой вс 05:00 MSK, пользователь `deploy` в группе `docker`, `PasswordAuthentication no`. Правила: цепочки `DOCKER-USER` (FORWARD из `172.30.0.0/24` — только к `172.30.0.1`) и `INPUT` (из `172.30.0.0/24` — только tcp 3142, 5000, udp/tcp 53; остальное `DROP`).

- [ ] **Step 1: Write the failing test** `bootstrap-check.sh`: `docker info` содержит runtime `sysbox-runc`; `docker network inspect rc-sbx` → `Internal=true`, `enable_icc=false`, шлюз `172.30.0.1`; `iptables -S DOCKER-USER` содержит правило DROP для `172.30.0.0/24`; после `systemctl restart docker` правила снова на месте; `swapon --show` — 2G.
- [ ] **Step 2 (VPS):** Run `sudo bash infra/scripts/test/bootstrap-check.sh` — Expected: FAIL.
- [ ] **Step 3:** Implement. **Step 4 (VPS):** Run `sudo bash infra/scripts/bootstrap-vps.sh && sudo bash infra/scripts/bootstrap-check.sh` дважды — Expected: PASS оба раза.
- [ ] **Step 5: Commit** `feat(infra): VPS bootstrap with sysbox and sandbox firewall`.

### Task 2: Зеркала и образы песочниц

**Files:**
- Create: `infra/mirrors/**`, `sandbox/images/{registry.yaml,linux-base/Dockerfile,docker/Dockerfile,common/*}`
- Modify: `infra/compose.yaml` (сервисы `apt-mirror` — `sameersbn/apt-cacher-ng@sha256:…`, `registry` — `registry:2` с `REGISTRY_PROXY_REMOTEURL=https://registry-1.docker.io`, `dnsmasq` — `rc/dnsmasq`; порты `172.30.0.1:3142`, `172.30.0.1:5000`, `172.30.0.1:53/udp+tcp`; сеть `rc-mirror-egress`; тома `apt-cache`, `registry-cache`; лимиты 128/128/32 МБ)
- Test: `sandbox/images/test/images.sh`

**Interfaces:**
- Produces: `registry.yaml` — `rc/linux-base:24.04` (`light`, 0.5, 512, 512), `rc/docker:24.04` (`docker`, 1.0, 1536, 2048); `rc/k3s` не включается (подпроект T11). Имя зеркала в dnsmasq — `mirror.rootcamp.internal` → `172.30.0.1`. MOTD формирует `/etc/update-motd.d/10-rootcamp`, читающий `/etc/rootcamp/title` (файл пишет `sandboxd` перед setup). Оба образа с `LABEL rootcamp.keep=1`.

- [ ] **Step 1: Write the failing test** `images.sh` (VPS): из временной песочницы `light` (`docker run --runtime=sysbox-runc --network rc-sbx --dns 172.30.0.1 -d rc/linux-base:24.04`) — `systemctl is-system-running --wait` даёт `running|degraded`; `apt-get update` проходит; `getent hosts example.com` → пусто; `curl -m 5 -x http://172.30.0.1:3142 http://example.com` → ошибка (зеркало не пропускает); из песочницы `rc/docker:24.04` — `docker pull alpine:3.20` за < 60 с, повторно в новой песочнице — быстрее (кэш `registry-cache`).
- [ ] **Step 2 (VPS):** Run `bash sandbox/images/test/images.sh` — FAIL.
- [ ] **Step 3:** Implement Dockerfile'ы (`CMD ["/sbin/init"]`, маскировать `getty@`, `systemd-logind` не нужен; `man-db` без `excludes` из `/etc/dpkg/dpkg.cfg.d/excludes` — удалить файл и выполнить `unminimize`-эквивалент только для man) и зеркала.
- [ ] **Step 4 (VPS):** Run `docker compose -f infra/compose.yaml -f infra/compose.build.yaml up -d apt-mirror registry dnsmasq && docker build -t rc/linux-base:24.04 sandbox/images/linux-base && docker build -t rc/docker:24.04 sandbox/images/docker && bash sandbox/images/test/images.sh` — PASS.
- [ ] **Step 5: Commit** `feat(sandbox): base images and mirrors`.

### Task 3: Драйвер `sysbox`

**Files:**
- Create: `apps/sandboxd/src/driver/sysbox.ts`
- Modify: `apps/sandboxd/src/config.ts` (выбор драйвера), `infra/compose.yaml` (сервис `sandboxd`: `docker.sock`, `/proc:/host/proc:ro`, `/:/host/root:ro`, сеть `rc-internal`, 256 МБ, `SANDBOX_DRIVER=sysbox`)
- Test: `apps/sandboxd/test/driver.sysbox.test.ts` (`describe.runIf(process.env.SANDBOX_DRIVER === 'sysbox')`)

**Interfaces:**
- Consumes: `SandboxDriver`, `ContainerSpec` (M4a Task 2).
- Produces: `createSysboxDriver(docker, cfg): SandboxDriver` — `HostConfig { Runtime: 'sysbox-runc', NanoCpus, Memory, MemorySwap = Memory, PidsLimit, Ulimits: [{Name:'nofile', Soft:4096, Hard:4096}], NetworkMode: 'rc-sbx', Dns: ['172.30.0.1'], LogConfig: {Type:'none'} }`, `Hostname`, `Labels`; `waitBoot` — `exec('systemctl is-system-running --wait', 60 с)`, допустимы `running`/`degraded`; `diskUsageMb` = `SizeRw` + `du -sxm /host/root/var/lib/sysbox/docker/<containerId>` (0, если каталога нет).

- [ ] **Step 1: Write the failing test**: создание `light` → `ready` < 20 с; `Inspect.HostConfig.Runtime==='sysbox-runc'`, `Privileged===false`, `CapAdd` пуст; песочница `docker` → внутри `docker info` работает; `dd if=/dev/zero of=/var/lib/docker/fill bs=1M count=3200` внутри песочницы `docker` → `gcTick` останавливает её с `disk_quota`.
- [ ] **Step 2 (VPS):** Run `SANDBOX_DRIVER=sysbox pnpm --filter @rootcamp/sandboxd test driver.sysbox` — FAIL.
- [ ] **Step 3:** Implement. **Step 4 (VPS):** Run — PASS. На Windows тест пропускается (skip), это ожидаемо.
- [ ] **Step 5: Commit** `feat(sandboxd): sysbox driver`.

### Task 4: `rootcamp-cli practice:test`

**Files:**
- Create: `apps/api/src/practiceTest/{run,changed,report}.ts`
- Modify: `apps/api/src/cli.ts`
- Test: `apps/api/test/practiceTest.test.ts` (фейк `SandboxdClient`)

**Interfaces:**
- Consumes: `SandboxdClient` (M4a Task 7) с `test: true`, `ContentStore` / серверная часть версии.
- Produces: `rootcamp-cli practice:test <id>|--all|--changed [--since <sha>] [--version <hash>] [--image-override <from>=<to>] [--report practice-test-report.json]`. `runPracticeTest(practice, client, now): Promise<PracticeTestResult>` по §10.5 п.1–6: `setup` код 0; все checks ≠ 0; `solution.sh` (как одна «проверка» с `timeoutSec = setupTimeoutSec`) код 0; все checks = 0 дважды; `readyMs`. `PracticeTestResult { id; ok; readyMs; steps: {name; ok; detail}[] }`. `--changed`: `git diff --name-only <since>..HEAD` → практики с изменёнными файлами в `content/practices/<id>/` + практики, чей `image` собирается из изменённого `sandbox/images/<dir>/`. `--all` дополнительно вызывает самотест изоляции (Task 6). Код выхода 1 при любом `ok:false`.

- [ ] **Step 1: Write the failing test**: фейк, где один check проходит до решения → `ok:false`, шаг `checks-fail-before` с именем цели; где решение не делает check идемпотентным (второй прогон ≠ 0) → `ok:false`; `changedPractices(['content/practices/inc-a/check/x.sh','sandbox/images/docker/Dockerfile'], registry, practices)` → `['inc-a', <все практики образа rc/docker:24.04>]`; отчёт пишет JSON с `readyMs`.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5: Commit** `feat(cli): practice:test`.

### Task 5: Три эталонных инцидента и узлы пути

**Files:**
- Create: `content/practices/inc-nginx-down/**`, `content/practices/inc-file-perms/**`, `content/practices/inc-container-crash/**`
- Modify: `content/tracks/t1/s01/section.yaml` (в конец: `practice: inc-nginx-down`, `practice: inc-file-perms`), `content/tracks/t7/s09/section.yaml` (в конец: `practice: inc-container-crash`)

**Interfaces:**
- Produces: манифесты по §4.2 и §6.9 (точные значения):
  - `inc-nginx-down`: `rc/linux-base:24.04`, `light`, `hostname: incident-0314`, `timeoutMin: 30`, `reward {base:40, noHintBonus:10, hintCost:5}`, цели `config-valid` (`/usr/sbin/nginx -t`), `service-active` (`/usr/bin/systemctl is-active nginx` и `is-enabled nginx`), `http-200` (`/usr/bin/curl -s -o /tmp/b -w '%{http_code}' http://127.0.0.1/` = 200 и `/tmp/b` содержит `rootcamp-ok`); подсказки — три из §4.2.
  - `inc-file-perms`: `light`, 30 мин, 40/+10/5; цели `config-readable` (`runuser -u app -- test -r /srv/app/config.ini` и последняя цифра `stat -c %a` = 0), `script-exec`, `service-running` (`is-active report` и `report.log` моложе 15 с).
  - `inc-container-crash`: `rc/docker:24.04`, `docker`, 40 мин, `{base:50, noHintBonus:10, hintCost:5}`, `innerImages: [alpine:3.20]`, `setupTimeoutSec: 180`; цели `running` (`true false` и `StartedAt` старше 5 с), `health` (`curl -fsS http://127.0.0.1:8080/health` = `ok`), `restart-policy` (`unless-stopped`).
  - Брифы 100–700 символов на русском, 2–4 подсказки, `solution.sh` по §6.9.

- [ ] **Step 1: Write the failing test:** Run `pnpm content:validate` после добавления узлов в `section.yaml`, но до создания практик — Expected: FAIL `R19`.
- [ ] **Step 2:** Написать практики. Run `pnpm content:validate` — Expected: `0 errors` (R18: образ в реестре, класс совпадает, shellcheck чистый, `40 ≥ 5 × 3`).
- [ ] **Step 3 (VPS):** Run `docker compose … exec api node dist/cli.js practice:test inc-nginx-down` и затем остальные два — Expected: `ok:true` у каждого, `readyMs` ≤ 20000 для `light` и ≤ 40000 для `docker`.
- [ ] **Step 4: Commit** `feat(content): three reference incidents`.

### Task 6: Самотест изоляции

**Files:**
- Create: `apps/sandboxd/src/selftest/isolation.ts`, маршрут `POST /internal/selftest/isolation`, `apps/sandboxd/test/isolation.test.ts` (обёртка, `runIf sysbox`)

**Interfaces:**
- Produces: `runIsolationSelftest(deps): Promise<{ ok: boolean; checks: { name: string; ok: boolean; detail: string }[] }>` — поднимает две песочницы `light` (`test: true`, вне очереди), выполняет проверки §6.4: `curl -m 5 https://example.com` ≠ 0; `curl -m 5 http://<IP второй>` ≠ 0; `curl -m 5 http://172.30.0.1:22` и `:5432` ≠ 0; `apt-get update` = 0; UID процесса PID 1 песочницы на хосте (`/host/proc/<hostPid>/status`, `hostPid` из `docker inspect .State.Pid`) ≥ 100000; форк-бомба `timeout 20 bash -c ':(){ :|:& };:'` упирается в `pids-limit`, при этом хост (`/host/proc/loadavg` читается) и вторая песочница (`exec('true')` < 5 с) отвечают. Обе песочницы удаляются в `finally`.

- [ ] **Step 1: Write the failing test**: `isolation.test.ts` ожидает `ok:true` и 7 именованных проверок.
- [ ] **Step 2 (VPS):** Run — FAIL. **Step 3:** Implement. **Step 4 (VPS):** Run `docker compose … exec api node dist/cli.js practice:test --all` — Expected: три инцидента + `isolation` — все `ok`.
- [ ] **Step 5: Commit** `feat(sandboxd): isolation selftest`.

### Task 7: Пересборка образов и прогрев

**Files:**
- Create: `infra/scripts/rebuild-sandbox-images.sh`

**Interfaces:**
- Produces: для каждого образа из `registry.yaml` в порядке зависимостей (`linux-base` → `docker`): `docker build --pull -t <ref-без-тега>:candidate`, затем `practice:test` по практикам образа с `--image-override <ref>=<…:candidate>`; при успехе — текущий тег копируется в `:prev` (`FROM <ref>` + `LABEL rootcamp.keep=1`), `:candidate` → `:24.04`; при провале — тег не меняется, код выхода 1 (алерт подключит M6). Прогрев `innerImages`: временная песочница `docker` выполняет `docker pull` каждого образа через зеркало.

- [ ] **Step 1 (VPS):** Run `bash infra/scripts/rebuild-sandbox-images.sh` — Expected: FAIL (скрипта нет).
- [ ] **Step 2:** Implement. Добавить в `practice.yaml` временную поломку `solution.sh` и убедиться, что скрипт выходит с 1 и `rc/linux-base:24.04` указывает на прежний digest; вернуть.
- [ ] **Step 3 (VPS):** Run снова — Expected: код 0, `docker images rc/linux-base` показывает `24.04` и `prev`.
- [ ] **Step 4: Commit** `feat(infra): sandbox image rebuild with gated retag`.

### Task 8: Демо вехи M4b (VPS)

- [ ] **Step 1 (VPS):** `git clone` репозитория в `/opt/rootcamp`, `cp infra/.env.example infra/.env` (секреты), `docker compose -f infra/compose.yaml -f infra/compose.build.yaml -f infra/compose.vps-test.yaml up -d --build`, `content:build` + `content:activate`.
- [ ] **Step 2 (VPS):** Run `docker compose … exec api node dist/cli.js practice:test --all --report /tmp/report.json` — Expected: 4 строки `ok` (3 инцидента + isolation), код 0; показать `/tmp/report.json` с `readyMs`.
- [ ] **Step 3:** С ПК: `ssh -L 8080:127.0.0.1:8080 deploy@<vps>`, открыть `http://localhost:8080/practice/inc-nginx-down` на 1440 px и в эмуляции 390 px, вручную решить инцидент в терминале (`journalctl -u nginx`, правка, `systemctl restart nginx`), «Проверить» → «Решено».
- [ ] **Step 4:** Локально `pnpm e2e` — Expected: сценарий 5 (терминал на runc-dev) зелёный. Показать пользователю вывод обеих сред.
