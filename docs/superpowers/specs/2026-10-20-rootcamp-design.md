# rootcamp — проектная спецификация (design spec)

Дата: 2026-10-20 · Статус: утверждена к реализации подпроекта 1 · Основа: DockerLingo (`E:\Duolingo_Docker`), роадмап `claude/roadmap-devops.md`, макеты на холсте rootcamp.

## 1. Понимание и цели

### 1.1. Что строим

rootcamp — адаптивный сайт для изучения DevOps с нуля в механике Duolingo. Курс из роадмапа: 15 треков T0–T14, 85 разделов, 425 уроков. Сайт заменяет мобильное приложение DockerLingo: переносим его игровую механику, формат заданий и 600 готовых заданий по Docker. Главное новшество — **практика-инцидент**: пользователь получает настоящий сломанный Linux-сервер в браузерном терминале и чинит его. Победа засчитывается, когда скрипты проверки на этом сервере возвращают успех.

Пользователи — 3–4 знакомых человека. Регистрация открыта, вход по email и паролю, email подтверждается ссылкой из письма. Всё работает на одном VPS (4 vCPU / 8 ГБ / 80 ГБ, KVM, Ubuntu 24.04).

### 1.2. Цели v1

1. Пройти урок, повторение и практику-инцидент с телефона (390 px) и с ПК (1440 px) без потери функций.
2. Сохранить механику DockerLingo без изменения правил: XP, дневная цель, серия, сердечки, Лейтнер, линейная разблокировка.
3. Дать песочницы с настоящим systemd и dockerd, изолированные настолько, чтобы открытая регистрация не угрожала VPS.
4. Построить контент-конвейер «исходник YAML → валидатор → сборка → публикация», которым производятся все следующие треки без правок кода платформы.
5. Пропустить через конвейер минимальный объём контента (раздел 2.3) и доказать, что он работает от начала до конца.

### 1.3. Метрики приёмки v1

- Все e2e-сценарии из §10.4 проходят на двух вьюпортах: 390×844 и 1440×900.
- Каждый из трёх эталонных инцидентов проходит тест «setup → все check падают → эталонное решение → все check проходят» на VPS.
- Песочница класса `light` готова к вводу команд за ≤ 20 с от нажатия «Начать», класса `docker` — за ≤ 40 с (при прогретых образах).
- Из песочницы недоступны интернет, хост и другие песочницы. Это проверяется автотестом из §6.4.
- Восстановление БД из бэкапа проверено скриптом хотя бы один раз до запуска.

### 1.4. Допущения

- A1. У владельца есть SMTP-учётка (адрес, порт 587 с STARTTLS, логин, пароль) с настроенными SPF/DKIM для домена отправителя. Выбор почтового провайдера не входит в проект.
- A2. У владельца есть домен. Его A-запись указывает на VPS, порты 80 и 443 открыты (нужно для автоматического TLS).
- A3. Код хранится в приватном репозитории GitHub. GitHub Actions используется для CI, GHCR — для образов приложений.
- A4. Ядро VPS — штатное ядро Ubuntu 24.04 (6.8+). Sysbox CE ставится из официального .deb. KVM-виртуализация это допускает.
- A5. Локальный прогресс DockerLingo (AsyncStorage на телефонах) не переносится: rootcamp стартует с пустой БД.
- A6. Одновременно активны не больше 4 пользователей. Масштабирование за пределы одного VPS не проектируем.
- A7. Пользователи доброжелательны, но регистрация открыта. Поэтому защита рассчитана на случайного злоумышленника (майнинг, сканирование, форк-бомба, рассылка), а не на целевую атаку с 0-day в ядре.
- A8. Есть S3-совместимое хранилище для внешней копии бэкапов. Провайдера выбирает владелец, адрес передаётся через переменные окружения.
- A9. Часовой пояс для границ недели лидерборда — Europe/Moscow. Дни для серии и дневной цели считаются в часовом поясе пользователя.

## 2. Декомпозиция на подпроекты

### 2.1. Подпроект 1 — платформа

Подпроект включает весь код, инфраструктуру и контент-конвейер. Вехи идут по порядку, каждая заканчивается демонстрацией на VPS.

| Веха | Содержание | Критерий готовности |
|---|---|---|
| M1 Каркас | Монорепозиторий, `packages/logic` (перенос и тесты), `packages/content-schema`, CI, compose-стенд | `pnpm test` зелёный в CI; стенд поднимается командой `docker compose up` |
| M2 Аккаунты | Регистрация, письмо, вход, сброс пароля, сессии, rate limit | e2e «регистрация → письмо (Mailpit) → вход» |
| M3 Обучение | Путь, Урок, Повторение, XP/серия/сердечки/ранги, контент T7 и T1.1 | e2e «урок → повторение» на двух вьюпортах |
| M4 Песочницы | `sandboxd`, Sysbox, сеть, очередь, сборщик мусора, терминал, практика, 3 инцидента | `practice:test --all` зелёный на VPS; e2e терминала |
| M5 Социальное и админка | Лидерборд, друзья, напоминания, админка | e2e лидерборда и админки |
| M6 Эксплуатация | Деплой, бэкапы, алерты, обновление образов, проверка восстановления | Чек-лист §11.6 выполнен |

### 2.2. Подпроекты 2+ — производство контента

Один подпроект — один трек. Порядок треков совпадает с роадмапом: T1 (остаток), T0, T2, T3, T4, T6, T5, T8, T9, T10, T11, T12, T13, T14, затем T7.u11. Цикл трека:

1. **План.** Список разделов и уроков по роадмапу. Для каждого раздела — 0–2 инцидента; сразу отмечаем, какие из них требуют нового образа.
2. **Черновик.** YAML уроков: теория (≤ 1200 символов) и 10–15 заданий на урок. Используются все 7 типов; `terminal_practice` идёт только отдельным узлом пути.
3. **Инциденты.** Манифест, `setup.sh`, `check/*.sh`, `solution.sh`. При необходимости — новый образ в `sandbox/images/`.
4. **Валидация.** `pnpm content:validate` без ошибок, `practice:test` для новых инцидентов зелёный.
5. **Сверка актуальности.** Проверить факты по списку устаревающих фактов роадмапа и записать дату `reviewedAt` в `track.yaml`.
6. **Вычитка человеком.** Владелец проходит трек на стенде с телефона.
7. **Публикация.** Слияние в `main` → деплой → активация новой версии контента.

Готовность трека: все разделы роадмапа опубликованы, `status: complete`, у каждого раздела, где роадмап требует практику на ПК, есть хотя бы один инцидент. Для T11 перед первым инцидентом нужен образ `rc/k3s` — он входит в подпроект T11, а не в платформу.

### 2.3. Объём контента v1

Объём v1 намеренно минимален: этого хватает, чтобы проверить конвейер и все типы узлов пути.

1. **T7 Docker — 10 разделов `t7.s01`–`t7.s10`, 50 уроков, 600 заданий.** Переносятся из DockerLingo конвертером (§7.3). Попутно исправляются устаревшие факты: только `docker compose`, без `version:`, файл `compose.yaml`. Статус трека — `complete`; раздел u11 выйдет позже в отдельном подпроекте.
2. **T1.1 «Терминал и оболочка» — 5 уроков по 10–15 заданий.** Пишется с нуля и включает хотя бы одно задание `order_steps`. Статус трека T1 — `partial`.
3. **Три эталонных инцидента** (подробно в §6.9):
   - `inc-nginx-down` — Linux/systemd, упавший nginx;
   - `inc-file-perms` — права на файл ломают сервис;
   - `inc-container-crash` — Docker, контейнер падает при старте.

Привязка в v1. Оба Linux-инцидента стоят узлами пути в конце раздела T1.1, `inc-container-crash` — в конце `t7.s09` («Отладка»). Когда в подпроекте T1 появятся разделы 1.4 и 1.7, узлы `inc-file-perms` и `inc-nginx-down` переедут туда. ID практик при этом не меняются, прогресс сохраняется.

## 3. Архитектура и компоненты

### 3.1. Общая схема

```
Браузер (React SPA, xterm.js)
   │ HTTPS / WSS
Caddy (TLS, статика SPA и контента, проксирование)
   ├── /api/*            → api (Fastify)       ── PostgreSQL
   ├── /ws/terminal      → sandboxd (Fastify)  ── PostgreSQL, docker.sock
   └── /*, /content/*    → статика (том web-dist, content-dist)
sandboxd ──docker API──> dockerd (runtime sysbox-runc) ──> песочницы rc-sbx-*
песочницы ──(сеть rc-sbx, internal)──> 172.30.0.1:3142 apt-cacher-ng, :5000 registry (pull-through)
api ──SMTP──> почтовый провайдер
```

Решение: управление песочницами вынесено в отдельный сервис `sandboxd`. Только у него смонтирован `/var/run/docker.sock`, то есть права, эквивалентные root на хосте. `api` смотрит в интернет и разбирает пользовательский ввод, но доступа к Docker не имеет. Уязвимость в `api` поэтому не даёт управления хостом.

### 3.2. Компоненты

**web** (`apps/web`) — React 18 SPA на Vite.
- Что делает: все экраны (§8), локальная проверка ответа для мгновенной обратной связи, терминал.
- Интерфейс: REST `/api/*`, статические JSON `/content/<version>/*`, WebSocket `/ws/terminal`.
- Зависит от `packages/logic` (`checkAnswer`, `isAnswerReady`, `weekBars`, `msToNextHeart`), `packages/api-contract`, React Router 6, TanStack Query 5, xterm.js 5 (`@xterm/xterm`, `addon-fit`, `addon-web-links`). Стили — CSS Modules и CSS-переменные из `tokens.css`.

**api** (`apps/api`) — Node 22 LTS, Fastify 5.
- Что делает: аутентификация, прогресс, сессии уроков и повторения, практики (выдача брифа, подсказок, вызов проверок), лидерборд, друзья, админка, письма. Фоновые задачи на pg-boss: письма, напоминания, недельные снимки, алерты.
- Интерфейс: REST (§5.1), внутренний HTTP-клиент к `sandboxd` (§5.3), CLI `rootcamp-cli` (запускается в том же образе).
- Зависит от PostgreSQL 16, Drizzle ORM, `packages/logic`, `packages/content-schema`, `packages/api-contract`, nodemailer, argon2, pg-boss, `@fastify/rate-limit`, `@fastify/cookie`.
- Источник истины для XP, сердечек, серии, коробок Лейтнера и рангов. Клиент только показывает предварительный результат.

**sandboxd** (`apps/sandboxd`) — Node 22, Fastify 5, dockerode.
- Что делает: планировщик и очередь песочниц, создание и уничтожение контейнеров, выполнение `setup.sh` и `check.sh`, терминальный WebSocket (docker exec с TTY), сборщик мусора, сбор метрик хоста и контейнеров.
- Интерфейс: внутренний REST (§5.3) только в docker-сети `rc-internal`, публичный WebSocket `/ws/terminal` (§5.2) с аутентификацией одноразовым билетом.
- Зависит от docker.sock, PostgreSQL (таблица `sandboxes`), `packages/api-contract`. Хостовые `/proc` и `/` смонтированы только на чтение в `/host/proc` и `/host/root` для метрик.
- О контенте ничего не знает: скрипты и параметры образа получает от `api`.

**PostgreSQL 16** — единственное хранилище: данные, очередь pg-boss (схема `pgboss`), сессии.

**Caddy 2** — TLS (Let's Encrypt), отдача `web-dist` и `content-dist` (контент — с `Cache-Control: immutable`, поскольку путь содержит хеш версии), обратный прокси, заголовки безопасности (CSP, HSTS).

**apt-cacher-ng** — кэширующее зеркало пакетов. Пропускает только `archive.ubuntu.com`, `security.ubuntu.com`, `download.docker.com`.

**registry:2 в режиме pull-through cache** к Docker Hub. Внутренний dockerd в песочницах использует его как `registry-mirrors`.

**backup** — контейнер с cron: `pg_dump` и restic (§11.3).

**Mailpit** — только в dev- и e2e-стендах, перехватывает SMTP.

### 3.3. Выбор ORM: Drizzle

Выбран Drizzle ORM и drizzle-kit:
- схема описывается TypeScript-кодом, типы строк и запросов выводятся без кодогенерации и делятся с `api-contract`;
- запросы близки к SQL: оконные функции для лидерборда, `FOR UPDATE SKIP LOCKED`, `ON CONFLICT` пишутся явно, без обходов;
- нет отдельного движка-бинарника (как у Prisma), образ меньше, холодный старт быстрее;
- миграции — SQL-файлы, которые генерирует `drizzle-kit generate` и которые коммитятся в `apps/api/drizzle/`. Применяются при старте `api` функцией `migrate()` под advisory lock.

### 3.4. Структура монорепозитория

pnpm workspaces. Сборкой управляет Turborepo (`turbo run build test lint`). TypeScript 5, strict, ESM.

```
rootcamp/
├─ apps/
│  ├─ web/            Vite + React SPA (src/screens, src/components, src/terminal, src/styles/tokens.css)
│  ├─ api/            Fastify API, src/routes, src/services, src/jobs, src/db/schema.ts, src/cli.ts, drizzle/
│  └─ sandboxd/       Fastify, src/scheduler.ts, src/driver/{sysbox,runc-dev}.ts, src/terminal.ts, src/gc.ts, src/metrics.ts
├─ packages/
│  ├─ logic/          перенесённая механика DockerLingo (§7.1), чистые функции, без I/O
│  ├─ content-schema/ zod-схемы курса и практик, типы, валидатор (правила R1–R16 + новые), линтер актуальности
│  └─ api-contract/   zod-схемы запросов и ответов REST, типы протокола WebSocket, коды ошибок
├─ content/
│  ├─ tracks/t1/track.yaml, tracks/t1/s01/section.yaml, tracks/t1/s01/l01.yaml …
│  ├─ tracks/t7/…     (сгенерировано конвертером, дальше правится руками)
│  ├─ practices/inc-nginx-down/{practice.yaml,setup.sh,check/*.sh,solution.sh}
│  └─ removed-ids.yaml
├─ sandbox/images/    linux-base/Dockerfile, docker/Dockerfile, общие файлы (tmux.conf, apt.conf, daemon.json)
├─ tools/
│  ├─ import-dockerlingo/  одноразовый конвертер u01–u10 → content/tracks/t7
│  └─ content-build/       сборка content-dist
├─ e2e/               Playwright
└─ infra/             compose.yaml, compose.dev.yaml, compose.e2e.yaml, Caddyfile, iptables/rc-sbx.rules,
                      scripts/{deploy.sh,rebuild-sandbox-images.sh,restore-test.sh,bootstrap-vps.sh}, versions.env
```

### 3.5. Контент-конвейер

1. Автор правит YAML и скрипты в `content/`.
2. `pnpm content:validate` разбирает YAML, прогоняет zod-схемы и правила валидатора (§4.3), shellcheck для `*.sh` и линтер актуальности. Выводит ошибки с путём файла и правилом.
3. `pnpm content:build` собирает `content-dist/<hash>/`. `<hash>` — первые 12 символов sha256 от канонического JSON всего курса. Состав:
   - `catalog.json` — треки, разделы (id, title, description, число уроков), узлы пути без заданий;
   - `sections/<sectionId>.json` — уроки раздела целиком, с ответами;
   - `practices/<practiceId>.json` — публичная часть манифеста: бриф, цели (id, title), число подсказок, награда, класс;
   - `server/practices/<practiceId>/` — полный манифест и скрипты. Этот каталог читает только `api`, Caddy его не отдаёт.
4. В CI выполняются шаги 2–3. На VPS `deploy.sh` выполняет `practice:test --changed` (§10.5), затем активирует версию: записывает `<hash>` в таблицу `settings` (`content_version`) и отправляет `api` сигнал перечитать каталог.
5. Клиент запрашивает `GET /api/content/version`, затем `catalog.json`. Разделы загружаются по требованию — при открытии раздела на экране Путь или при старте урока.

## 4. Модель данных

### 4.1. Идентификаторы

| Сущность | Формат | Пример |
|---|---|---|
| Трек | `t\d{1,2}` | `t7` |
| Раздел | `<трек>.s\d{2}` | `t7.s03` |
| Урок | `<раздел>.l\d{2}` | `t7.s03.l02` |
| Задание | `<урок>.t\d{2}` | `t7.s03.l02.t07` |
| Практика | `inc-[a-z0-9-]{3,40}` | `inc-nginx-down` |
| Цель практики | `[a-z0-9-]{2,30}` | `http-200` |

Опубликованные ID неизменяемы. ID можно удалить, только записав его в `content/removed-ids.yaml`, иначе валидатор выдаёт ошибку правила R20. Записи прогресса с удалёнными ID остаются в БД, но игнорируются при подсчётах.

### 4.2. Схема контента (YAML-исходник, JSON после сборки)

```yaml
# content/tracks/t1/track.yaml
id: t1
order: 1                        # порядок на экране выбора трека
title: Linux и терминал
description: 90% серверов на Linux; первый фильтр на собеседовании.   # ≤ 160 символов
status: partial                 # draft | partial | complete; draft не публикуется
prerequisites: [t0]             # рекомендация, доступ не блокирует
reviewedAt: 2026-10-20          # дата сверки актуальности
sections: [s01]                 # порядок разделов; каждый — каталог s01/
```

```yaml
# content/tracks/t1/s01/section.yaml
id: t1.s01
title: Терминал и оболочка
description: prompt, команды, аргументы, флаги, man и --help        # ≤ 120 символов
nodes:                          # порядок узлов на пути
  - lesson: l01                 # файл l01.yaml
  - lesson: l02
  - lesson: l03
  - lesson: l04
  - lesson: l05
  - practice: inc-nginx-down    # узел-практика
  - practice: inc-file-perms
```

```yaml
# content/tracks/t1/s01/l01.yaml
id: t1.s01.l01
title: Что такое терминал           # ≤ 50 символов
theory:
  title: Терминал и оболочка
  blocks:                           # 1–8 блоков, суммарно ≤ 1200 символов
    - { type: text, text: "..." }
    - { type: code, code: "ls -la /etc" }
tasks:                              # 10–15
  - id: t1.s01.l01.t01
    type: single_choice
    question: ...
    options: [..., ..., ...]
    correctIndex: 1
    explanation: ...                # 20–400 символов
  - id: t1.s01.l01.t02
    type: order_steps
    prompt: Расположи шаги в правильном порядке
    steps:                          # 3–6 строк в правильном порядке
      - Открыть терминал
      - Ввести команду и аргументы
      - Нажать Enter
      - Прочитать вывод
    explanation: ...
```

Типы заданий:

| Тип | Поля | Ответ пользователя (`UserAnswer`) | Правило верности |
|---|---|---|---|
| `single_choice` | `question, options[3–4], correctIndex` | `{selectedIndex}` | индекс совпадает |
| `true_false` | `statement, answer` | `{value}` | значение совпадает |
| `assemble` | `prompt, answer[2–10], altAnswers?, distractors[1–4]` | `{tokens}` | совпадает с `answer` или одним из `altAnswers` |
| `fill_blank` | `prompt, template (одно ___), acceptedAnswers[≥1]` | `{text}` | `normalize(text)` равен одному из `normalize(accepted)` |
| `match_pairs` | `prompt, pairs[3–5]` | `{pairs}` | множество пар совпадает |
| `order_steps` (новый) | `prompt, steps[3–6]` — правильный порядок; шаги попарно различны после `normalize` | `{order: string[]}` — тексты шагов в выбранном порядке | `order` поэлементно равен `steps` |
| `terminal_practice` (новый) | `practiceId` | не используется | решается только через практику (§6) |

Отличие `order_steps` от `assemble`: нет лишних плиток, элементы — целые фразы, интерфейс — вертикальный список с перетаскиванием и кнопками ↑/↓ (на телефоне перетаскивание неудобно). Перед показом шаги перемешиваются; если перемешивание совпало с правильным порядком, оно повторяется.

`terminal_practice` — тип задания единственного урока-обёртки узла-практики. Сборщик превращает `- practice: inc-x` в урок с `kind: "practice"`, id `<раздел>.p-<practiceId>` и одним заданием `{ type: terminal_practice, practiceId }`. Так клиент и `packages/logic` обходят путь единообразно. Задания `terminal_practice` никогда не попадают в повторение, тренировку и подсчёт ошибок урока.

Собранный тип (`packages/content-schema`):

```ts
interface Track { id; order; title; description; status: 'partial'|'complete'; prerequisites: string[]; reviewedAt: string; sections: SectionRef[] }
interface SectionRef { id; title; description; lessonCount: number; nodes: PathNode[] }
type PathNode = { kind: 'lesson'; lessonId: string; title: string } | { kind: 'practice'; lessonId: string; practiceId: string; title: string }
interface Section { id; title; description; lessons: Lesson[] }       // sections/<id>.json
interface Lesson { id; kind: 'lesson'; title; theory: TheoryCard; tasks: Task[] }
            | { id; kind: 'practice'; title; tasks: [TerminalPracticeTask] }
```

Манифест практики:

```yaml
# content/practices/inc-nginx-down/practice.yaml
id: inc-nginx-down
title: nginx не отвечает
track: t1
brief: |                              # 100–700 символов, показывается целиком
  Мониторинг кричит: сайт на сервере не отвечает на 80 порту…
image: rc/linux-base:24.04            # из реестра образов sandbox/images
class: light                          # light | docker | heavy
hostname: incident-0314
timeoutMin: 30                        # стартовый TTL песочницы, 15–60
setupTimeoutSec: 120
goals:                                # 1–5, порядок = порядок показа
  - id: config-valid
    title: "Конфиг исправлен: nginx -t без ошибок"
    check: check/config-valid.sh
    timeoutSec: 10                    # 1–30
  - id: service-active
    title: Сервис nginx активен и включён в автозапуск
    check: check/service-active.sh
  - id: http-200
    title: curl http://localhost отвечает 200
    check: check/http-200.sh
hints:                                # 1–4, открываются по порядку
  - В логе сервиса указан файл и номер строки.
  - "journalctl -u nginx -n 20 покажет ошибку"
  - После правки проверь конфиг командой nginx -t и перезапусти сервис.
reward: { base: 40, noHintBonus: 10, hintCost: 5 }
solution: solution.sh                 # эталонное решение, только для тестов
innerImages: []                       # образы для прогрева registry (класс docker)
```

### 4.3. Правила валидатора

Переносятся все правила `validateCourse.ts` (R1–R16). Правила, привязанные к DockerLingo, обобщаются: R1 «ровно 10 разделов u01–u10» становится «разделы трека совпадают со списком `sections` и идут подряд, начиная с `s01`»; R7 «id курса `docker-ru`» заменяется схемой трека. Ограничения на число уроков (4–6), заданий (10–15), длины полей, кириллицу, уникальность вопросов (R13, по всему курсу) сохраняются. Новые правила:

- R17 `order_steps`: 3–6 непустых шагов, попарно различных после `normalize`.
- R18 Практика: `image` есть в `sandbox/images/registry.yaml`; `class` совпадает с классом образа; каждый `check` и `setup.sh` существуют и проходят shellcheck (severity warning и выше — ошибка); `reward.base ≥ hintCost × число подсказок`; задан `solution.sh`.
- R19 Каждый `practice:` в разделе ссылается на существующую практику; одна практика стоит в пути не больше одного раза.
- R20 Ни один ID из предыдущей опубликованной версии (файл `content/published-ids.json`, обновляется при сборке в `main`) не исчез, если его нет в `removed-ids.yaml`.
- R21 Линтер актуальности (ошибки): в блоках `code` и в ответах запрещены `docker-compose` через дефис, ключ `version:` в compose-фрагментах, имя `docker-compose.yml` как файл по умолчанию. Предупреждения: `reviewedAt` старше 180 дней; упоминание `ingress-nginx` без слова «снят».
- R22 Трек со `status: complete` не содержит разделов с пустым `nodes`.

### 4.4. Таблицы БД (PostgreSQL)

Все времена — `timestamptz`, дни — `date` в часовом поясе пользователя.

| Таблица | Ключевые колонки | Назначение |
|---|---|---|
| `users` | `id uuid pk`, `email citext unique`, `email_verified_at`, `nick citext unique` (`^[a-z0-9_.]{3,20}$`), `password_hash`, `is_admin bool`, `status` (`active`/`banned`), `ban_reason`, `tz text` (IANA), `rank` (`guest`/`user`/`sudoer`/`root`), `total_xp int`, `reminder_enabled bool`, `reminder_time time` (по умолчанию 20:00), `created_at`, `last_seen_at` | Аккаунт и сводка |
| `sessions` | `id` (sha256 токена), `user_id`, `created_at`, `expires_at`, `ip`, `user_agent` | Сессии входа |
| `email_tokens` | `id`, `user_id`, `kind` (`verify`/`reset`), `token_hash`, `expires_at`, `used_at` | Ссылки из писем |
| `email_log` | `id`, `user_id`, `kind` (`verify`/`reset`/`reminder`/`alert`), `status` (`queued`/`sent`/`failed`), `attempts`, `last_error`, `created_at`, `sent_at` | Диагностика доставки |
| `hearts` | `user_id pk`, `count 0..5`, `last_regen_at` | Сердечки (`Hearts`) |
| `streaks` | `user_id pk`, `current`, `best`, `last_activity_date` | Серия (`Streak`) |
| `xp_events` | `id`, `user_id`, `amount int`, `source` (`lesson`/`review`/`drill`/`practice`), `ref_id`, `day date`, `created_at` | Журнал XP; из него считаются XP за день и за неделю |
| `lesson_completions` | `pk(user_id, lesson_id)`, `first_completed_at`, `times`, `best_mistakes` | `completedLessonIds` |
| `review_items` | `pk(user_id, task_id)`, `box 1..3`, `due_date` | Коробки Лейтнера |
| `learning_sessions` | `id`, `user_id`, `kind` (`lesson`/`review`/`drill`), `lesson_id null`, `content_version`, `state jsonb` (сериализованные `LessonSession`/`ReviewSession`), `status`, `started_at`, `updated_at` | Активная сессия; у пользователя не больше одной в статусе `in_progress` (частичный уникальный индекс) |
| `practice_progress` | `pk(user_id, practice_id)`, `hints_revealed int`, `goals_passed jsonb`, `first_solved_at`, `solve_count`, `xp_awarded` | Прогресс по практике между запусками |
| `practice_runs` | `id`, `user_id`, `practice_id`, `content_version`, `status` (`queued`/`starting`/`ready`/`solved`/`expired`/`stopped`/`failed`/`queue_timeout`), `created_at`, `ended_at` | Попытка решения |
| `sandboxes` | `id`, `run_id`, `user_id`, `container_id`, `image`, `class`, `cpu numeric`, `mem_mb`, `state` (`queued`/`starting`/`ready`/`stopping`/`stopped`/`failed`), `queued_at`, `ready_at`, `expires_at`, `hard_deadline`, `last_activity_at`, `stop_reason` | Состояние песочниц; пишет только `sandboxd` |
| `sandbox_usage` | `pk(user_id, day)`, `minutes` | Суточная квота |
| `friend_requests` | `id`, `from_id`, `to_id`, `status` (`pending`/`accepted`/`declined`), `created_at`; уникальность пары | Заявки в друзья |
| `friendships` | `pk(user_id, friend_id)`, `created_at` | Две строки на пару, для простых выборок |
| `reminder_log` | `pk(user_id, day)`, `sent_at` | Не больше одного напоминания в день |
| `weekly_results` | `pk(week_start date, user_id)`, `xp`, `place` | Снимок недели для истории в профиле |
| `settings` | `key text pk`, `value jsonb` | `content_version`, `registration_mode` (`open`/`closed`), `max_users` (по умолчанию 50) |
| `audit_log` | `id`, `actor_id`, `action`, `target_id`, `data jsonb`, `created_at` | Действия админов |

Индексы: `xp_events(user_id, day)`, `xp_events(created_at)`, `review_items(user_id, due_date)`, `sandboxes(state)`.

Инварианты. `users.total_xp` равен сумме `xp_events.amount`; обе записи обновляются в одной транзакции. `users.rank` никогда не понижается.

### 4.5. Ранги

Рассчитываются функцией `computeRank(totalXp, completedTracks)` в `packages/logic` после каждого начисления XP. Сохраняется максимум из сохранённого и рассчитанного ранга.

| Ранг | Условие |
|---|---|
| guest | по умолчанию |
| user | `totalXp ≥ 200` |
| sudoer | `totalXp ≥ 1500` и пройден ≥ 1 трек |
| root | `totalXp ≥ 6000` и пройдено ≥ 4 трека |

Трек считается пройденным, если у него `status: complete` в активной версии контента и пройдены все его уроки `kind: lesson`. Узлы-практики для прохождения трека не обязательны. В v1 достижимы guest, user и sudoer (через T7); root станет достижим, когда появятся ещё три завершённых трека.

## 5. API

### 5.1. REST

Все ответы — JSON. Ошибки имеют вид `{ error: { code, message } }`, где `code` берётся из перечисления в `api-contract`. Мутирующие запросы требуют заголовок `X-RC: 1`; кроме того, сервер сверяет `Origin` с доменом (защита от CSRF вместе с `SameSite=Lax`). Сессия хранится в cookie `rc_sid` (HttpOnly, Secure, SameSite=Lax), живёт 30 дней и продлевается при активности.

Аутентификация:

| Метод и путь | Тело → ответ | Примечания |
|---|---|---|
| `POST /api/auth/register` | `{email, nick, password, tz, website?}` → `201 {user}` | Пароль 8–128 символов. `website` — поле-ловушка: если оно не пустое, сервер отвечает 201 и ничего не создаёт. Ошибки: `registration_closed`, `user_limit`, `email_taken`, `nick_taken` |
| `POST /api/auth/verify` | `{token}` → `{user}` | Ссылка из письма живёт 24 ч и одноразовая |
| `POST /api/auth/resend-verification` | → `204` | Не чаще 1 раза в минуту и 5 раз в сутки |
| `POST /api/auth/login` | `{email, password}` → `{user}` | Ошибка `invalid_credentials` (одинаковая для неверного email и пароля), `banned` |
| `POST /api/auth/logout` | → `204` | |
| `POST /api/auth/forgot` | `{email}` → `204` всегда | Ссылка живёт 1 ч |
| `POST /api/auth/reset` | `{token, password}` → `204` | Удаляет все сессии пользователя |
| `GET /api/me` | → `{user, hearts, streak, xpToday, dailyGoal: 30, rank, nextRank}` | Перед ответом выполняет `regen` сердечек и `checkStreakBroken` |
| `PATCH /api/me` | `{tz?, reminderEnabled?, reminderTime?, email?}` → `{user}` | `email` можно менять, только пока он не подтверждён; при смене старые ссылки `verify` аннулируются и отправляется новое письмо. Подтверждённый email в v1 не меняется |
| `POST /api/me/password` | `{current, next}` → `204` | |

Пользователь с неподтверждённым email может войти, но все эндпоинты, кроме `/api/auth/*` и `GET /api/me`, отвечают ему `403 email_unverified`.

Контент и прогресс:

| Метод и путь | Ответ |
|---|---|
| `GET /api/content/version` | `{version, baseUrl: "/content/<version>/"}` |
| `GET /api/progress` | `{completedLessonIds, practiceStatuses: {id: locked/available/solved}, dueCount, tracks: [{id, completedLessons, totalLessons, done}]}` |

Сессии обучения:

| Метод и путь | Тело → ответ | Логика |
|---|---|---|
| `POST /api/lessons/:lessonId/start` | → `{sessionId, hearts, queue}` | Урок должен иметь статус `current` или `completed` (повтор). Ошибки: `locked`, `no_hearts`. Незавершённая сессия заменяется новой |
| `POST /api/sessions/:id/answer` | `{taskId, answer: UserAnswer}` → `{correct, correctAnswerText, hearts, status, nextTaskId, summary?}` | `taskId` должен совпадать с текущим заданием, иначе ошибка `out_of_order`. Порядок для урока: `checkAnswer` → `answerLessonTask` → `continueLesson`; при `completed` — `completeLesson` в той же транзакции |
| `POST /api/review/start` | `{mode: "review" \| "drill"}` → `{sessionId, taskIds}` или `204` (нечего повторять) | `buildReviewSession` |
| `POST /api/sessions/:id/abandon` | → `204` | Сессия закрывается без награды |

`POST /api/sessions/:id/answer` обслуживает и повторение. Ответ проверяется на сервере той же функцией `checkAnswer`, что и на клиенте; при расхождении побеждает сервер. Если `content_version` сессии не совпадает с активной версией, сервер отвечает `409 content_changed`, а клиент перезапускает урок без штрафа.

Практика:

| Метод и путь | Тело → ответ |
|---|---|
| `GET /api/practices` | `[{id, title, track, status, solved, anchorLessonId}]` |
| `POST /api/practices/:id/runs` | → `201 {runId, state, queuePosition?}`. Ошибки: `practice_locked`, `run_exists` (в ответе id активного запуска), `quota_exceeded`, `queue_full`, `email_unverified` |
| `GET /api/runs/:runId` | `{state, queuePosition, expiresAt, hardDeadline, goals: [{id, passed}], hintsRevealed, hints: [string], canExtend}` |
| `POST /api/runs/:runId/terminal-ticket` | → `{ticket, url: "/ws/terminal?ticket=…"}`. Билет живёт 30 с и одноразовый |
| `POST /api/runs/:runId/check` | → `{goals: [{id, passed, output}], solved, xpAwarded, summary?}`. Не чаще 1 раза в 5 с |
| `POST /api/runs/:runId/hints` | → `{index, text, hintsRevealed}`. Открывает следующую подсказку |
| `POST /api/runs/:runId/extend` | → `{expiresAt}`. Ошибка `extend_not_allowed` |
| `POST /api/runs/:runId/reset` | → `{state: "starting"}`. Пересоздаёт песочницу; не больше 3 раз за запуск |
| `POST /api/runs/:runId/stop` | → `204` |

Практика доступна (`available`), когда пройден урок, стоящий в пути непосредственно перед её узлом.

Социальное:

| Метод и путь | Ответ |
|---|---|
| `GET /api/leaderboard?scope=all\|friends` | `{weekStart, weekEndsAt, rows: [{place, nick, rank, xp, isMe}]}` |
| `GET /api/friends` | `{friends: [{nick, rank, streak, weekXp}], incoming: [{id, nick}], outgoing: [{id, nick}]}` |
| `POST /api/friends/requests` | `{nick}` → `201`. Ошибки: `not_found`, `self`, `already_friends`, `already_requested`. Если встречная заявка уже есть, дружба создаётся сразу |
| `POST /api/friends/requests/:id/accept` · `/decline` | `204` |
| `DELETE /api/friends/:nick` | `204` |
| `GET /api/profile/:nick` | `{nick, rank, totalXp, streak, best, tracks, weekBars}` — только для себя и друзей |

Админка (требует `is_admin`; каждое действие пишется в `audit_log`):

| Метод и путь | Ответ |
|---|---|
| `GET /api/admin/summary` | `{cpuPct, memUsedMb, memTotalMb, diskUsedGb, diskTotalGb, sandboxes: {running, budgetMb, reservedMb, queue}, services: [{name, healthy}]}` |
| `GET /api/admin/users` | `[{id, nick, email, rank, totalXp, currentTrack, lastSeenAt, status, emailVerified}]` |
| `GET /api/admin/users/:id` | Прогресс по трекам, последние 50 `xp_events`, `email_log` |
| `POST /api/admin/users/:id/ban` · `/unban` | `{reason}` → `204`. Бан удаляет сессии и останавливает песочницу |
| `POST /api/admin/users/:id/verify-email` | `204` — ручное подтверждение |
| `POST /api/admin/users/:id/resend-verification` | `204` |
| `GET /api/admin/sandboxes` | `[{id, nick, practiceTitle, image, cpuPct, memMb, diskMb, state, expiresAt}]` |
| `POST /api/admin/sandboxes/:id/stop` | `204` |
| `PATCH /api/admin/settings` | `{registrationMode?, maxUsers?}` |

Служебное: `GET /api/health` возвращает `{db, sandboxd, smtpLastOkAt}` и используется healthcheck'ом compose.

### 5.2. Протокол WebSocket терминала

Адрес: `wss://<домен>/ws/terminal?ticket=<билет>`. Caddy проксирует его в `sandboxd`. Билет — HMAC-SHA256 общим секретом `api` и `sandboxd` над `{runId, userId, sandboxId, exp, jti}`. `sandboxd` проверяет подпись, срок, что `jti` не встречался (в памяти, 2 минуты) и что песочница в состоянии `ready` принадлежит этому пользователю.

После подключения `sandboxd` выполняет `docker exec` с `Tty: true`, `User: root`, `WorkingDir: /root`, `Env: [TERM=xterm-256color, LANG=C.UTF-8]` и командой `tmux new-session -A -s main`. tmux держит оболочку живой между переподключениями. К одной песочнице допускается до 2 соединений одновременно (например, телефон и ПК), оба видят одну tmux-сессию.

Кадры:
- клиент → сервер, бинарный: байты ввода, UTF-8, до 4 КБ в кадре;
- клиент → сервер, текстовый JSON:
  - `{"t":"resize","cols":N,"rows":M}` — допустимо cols 20–400, rows 5–200; сервер вызывает resize у exec;
  - `{"t":"ping"}` — каждые 20 с;
- сервер → клиент, бинарный: вывод TTY, буферизуется до 16 мс или 32 КБ; поток ограничен 1 МБ/с;
- сервер → клиент, текстовый JSON:
  - `{"t":"ready"}`;
  - `{"t":"pong"}`;
  - `{"t":"expiring","secondsLeft":S}` — за 5 мин и за 1 мин до TTL;
  - `{"t":"extended","expiresAt":ISO}`;
  - `{"t":"closed","reason":R}`, где R ∈ `expired | stopped_by_admin | stopped_by_user | sandbox_failed | reset | idle | solved | disk_quota | banned`; после него сервер закрывает сокет кодом 4000 + индекс причины.

Если от клиента 60 с нет кадров, `sandboxd` закрывает соединение кодом 4008. Ввод пользователя продлевает `last_activity_at` (запись в БД не чаще раза в 30 с).

### 5.3. Внутренний API sandboxd

Доступен только в сети `rc-internal`; каждый запрос требует заголовок `Authorization: Bearer <INTERNAL_TOKEN>`.

| Метод и путь | Назначение |
|---|---|
| `POST /internal/sandboxes` | `{runId, userId, image, class, hostname, setupScript, setupTimeoutSec, ttlMin}` → `{sandboxId, state, queuePosition}` |
| `GET /internal/sandboxes/:id` | Состояние, очередь, сроки |
| `POST /internal/sandboxes/:id/exec-checks` | `{checks: [{goalId, script, timeoutSec}]}` → `[{goalId, exitCode, output, timedOut}]` |
| `POST /internal/sandboxes/:id/extend` | → `{expiresAt}` или `409` |
| `DELETE /internal/sandboxes/:id` | `{reason}` |
| `GET /internal/metrics` | Метрики хоста и каждой песочницы |

## 6. Песочницы

### 6.1. Образы и классы

Реестр образов — `sandbox/images/registry.yaml`:

| Образ | Основа | Состав | Класс | CPU | RAM | pids |
|---|---|---|---|---|---|---|
| `rc/linux-base:24.04` | `ubuntu:24.04` | systemd (PID 1), nginx, curl, nano, vim-tiny, less, tmux, sudo, iproute2, procps, man-db (без вычищенных man-страниц) | `light` | 0.5 | 512 МБ | 512 |
| `rc/docker:24.04` | `rc/linux-base:24.04` | Docker Engine и плагин compose v2; `daemon.json` с `registry-mirrors: ["http://172.30.0.1:5000"]` | `docker` | 1.0 | 1536 МБ | 2048 |
| `rc/k3s:<версия>` | `rc/linux-base:24.04` | k3s; собирается в подпроекте T11 | `heavy` | 2.0 | 2560 МБ | 4096 |

В каждом образе: `/etc/apt/apt.conf.d/01proxy` с `Acquire::http::Proxy "http://172.30.0.1:3142"`, `/etc/tmux.conf` (статусная строка выключена, `history-limit 5000`, `set -g mouse off`), MOTD с названием инцидента, `STOPSIGNAL SIGRTMIN+3`.

### 6.2. Жизненный цикл

```
queued → starting → ready → stopping → stopped
            │          │
            └→ failed  └→ (reset) → starting
```

1. **Запрос.** `api` создаёт `practice_runs` и вызывает `POST /internal/sandboxes`. `sandboxd` записывает строку `sandboxes(state=queued)`.
2. **Допуск.** Планировщик (§6.5) решает, хватает ли ресурсов. Если хватает — состояние `starting`.
3. **Создание контейнера** со следующими параметрами:
   - `--runtime=sysbox-runc`, `--name rc-sbx-<8 символов id>`, `--hostname <manifest.hostname>`;
   - `--cpus`, `--memory`, `--memory-swap` (равен memory), `--pids-limit` по классу;
   - `--ulimit nofile=4096:4096`, `--network rc-sbx`, `--dns 172.30.0.1`;
   - `--label rootcamp.sandbox=<id> --label rootcamp.user=<userId>`;
   - `--log-driver none` (вывод systemd внутри не нужен хосту).
   - Никогда не используются `--privileged`, монтирование docker.sock или хостовых путей. Опции `--cap-add` и `--security-opt seccomp=unconfined` не передаются.
4. **Ожидание загрузки.** `docker exec … systemctl is-system-running --wait` с таймаутом 60 с. Состояния `running` и `degraded` допустимы.
5. **Setup.** Скрипт передаётся через `docker exec -i` в `bash -s` (на диск песочницы не пишется). Выполняется от root с таймаутом `setupTimeoutSec`. После него `history -c`, удаляется `/root/.bash_history`. Ненулевой код → `failed`, причина `setup_failed`, алерт админам.
6. **Ready.** `ready_at = now`, `expires_at = now + timeoutMin`, `hard_deadline = now + 90 мин`.
7. **Работа.** Терминал, проверки, подсказки.
8. **Продление.** Доступно, когда до `expires_at` осталось ≤ 10 мин: +15 мин, но не позже `hard_deadline`.
9. **Остановка** — по одной из причин: решено (через 2 мин после `solved`, чтобы пользователь увидел результат), истёк TTL, простой 10 мин (нет WS-соединений и запросов к запуску), пользователь, админ, бан, превышение диска, сброс. Выполняется `docker stop -t 10`, затем `docker rm -v`.
10. **Учёт.** Минуты работы прибавляются в `sandbox_usage`.

У пользователя не больше одной песочницы в состояниях `queued`–`ready`. Суточная квота — 180 минут работы песочниц; при исчерпании запуск отклоняется с ошибкой `quota_exceeded`.

### 6.3. Изоляция и безопасность

- **Sysbox.** Каждая песочница работает в собственном user namespace с эксклюзивным диапазоном UID: root внутри — непривилегированный пользователь на хосте. Sysbox виртуализирует `/proc` и `/sys` и перехватывает `mount` и прочие опасные системные вызовы. Поэтому systemd, dockerd и k3s работают без `--privileged`.
- **seccomp и AppArmor.** Остаются профиль seccomp Docker по умолчанию (поверх него Sysbox использует seccomp-notify) и профиль AppArmor `docker-default`.
- **Ресурсы.** CPU и RAM — жёсткие лимиты cgroup v2, swap отключён. `pids-limit` защищает от форк-бомбы. `nofile` ограничен.
- **Диск.** Раз в 60 с сборщик измеряет записываемый слой (`SizeRw` из `docker ps --size`) плюс каталог внутреннего Docker (`du -sx` по `/var/lib/sysbox/docker/<containerId>`). При сумме > 3 ГБ песочница останавливается с причиной `disk_quota`. Новая песочница не запускается, если на `/` свободно < 10 ГБ.
- **Сеть.**
  - Сеть `rc-sbx` — bridge с `internal: true` (без маршрута наружу), `com.docker.network.bridge.enable_icc=false` (песочницы не видят друг друга), подсеть `172.30.0.0/24`, шлюз `172.30.0.1`.
  - apt-cacher-ng и registry публикуют порты только на `172.30.0.1:3142` и `172.30.0.1:5000`. dnsmasq на `172.30.0.1:53` отвечает только для имён зеркал, остальные запросы получают NXDOMAIN.
  - Правила `infra/iptables/rc-sbx.rules` (цепочки `DOCKER-USER` и `INPUT`): из `172.30.0.0/24` разрешены только `172.30.0.1` tcp 3142, tcp 5000, udp/tcp 53; всё остальное отбрасывается. Правила применяет systemd-юнит `rc-sbx-firewall.service` после `docker.service`.
- **Rate limit** (`@fastify/rate-limit`, хранилище в памяти, ключ — IP или userId):
  - `login`: 5/мин на IP и 20/ч на email;
  - `register`: 3/ч на IP;
  - `forgot`: 3/ч на IP;
  - создание запуска: 6/ч на пользователя;
  - `check`: 1 на 5 с;
  - `hints`: 10/мин;
  - прочее API: 300/мин на пользователя.
- **Открытая регистрация.** Песочницы доступны только с подтверждённым email. Регистрация автоматически закрывается при достижении `max_users`. Админ может перевести `registration_mode` в `closed`.
- **Секреты.** В песочнице нет переменных окружения хоста. `check.sh` и `setup.sh` не хранятся в образе. Манифест на клиент отдаётся без скриптов и решения.
- **Обновления.** На хосте включён `unattended-upgrades` с перезагрузкой по воскресеньям в 05:00 MSK (активные песочницы при этом теряются, пользователи видят `sandbox_failed`). Версия Sysbox закреплена в `infra/versions.env` и обновляется вручную (§11.5).
- **Сознательно принятый риск.** Пользователь — root внутри песочницы и может подменить утилиты, которые вызывает `check.sh`. Защита от такого обмана не входит в v1 (§12). Проверки вызывают бинарники по абсолютным путям, чтобы исключить случайные совпадения, но не умышленный обход.

### 6.4. Проверка изоляции

Тест `sandboxd/test/isolation.test.ts` запускается на VPS как часть `practice:test --all`. Он поднимает две песочницы `light` и проверяет из первой:
- `curl -m 5 https://example.com` завершается ошибкой;
- `curl -m 5 http://<IP второй песочницы>` — ошибка;
- `curl -m 5 http://172.30.0.1:22` и `:5432` — ошибка;
- `apt-get update` проходит через зеркало;
- `cat /proc/1/cgroup` и `id` подтверждают userns: на хосте процесс принадлежит UID ≥ 100000;
- форк-бомба `:(){ :|:& };:` упирается в pids-limit, а хост и вторая песочница продолжают отвечать.

### 6.5. Планировщик и очередь

Бюджет песочниц: RAM 5120 МБ, CPU 3.5, одновременно не больше одной песочницы `heavy`. Расчёт RAM: 8 ГБ минус ~2,9 ГБ на ОС, dockerd, PostgreSQL (shared_buffers 256 МБ), `api`, `sandboxd`, Caddy, зеркала и запас.

Алгоритм — цикл раз в 2 с и по событию «песочница освободилась»:
1. Берутся строки `queued` в порядке `queued_at`.
2. Для каждой: если `reserved_mem + mem ≤ 5120`, `reserved_cpu + cpu ≤ 3.5`, есть слот `heavy` (если класс heavy) и на диске ≥ 10 ГБ — запуск.
3. Защита от голодания: если первая в очереди `heavy` ждёт > 10 мин, остальные заявки не допускаются, пока она не запустится.
4. Заявка, прождавшая 20 мин, получает состояние `queue_timeout`.
5. Длина очереди ограничена 10 заявками; новые отклоняются с ошибкой `queue_full`.

Позиция в очереди отдаётся в `GET /api/runs/:id`. Клиент опрашивает его раз в 2 с, пока состояние `queued` или `starting`.

### 6.6. Сборщик мусора и восстановление

Раз в 30 с:
- останавливает песочницы с истёкшим `expires_at`, с простоем больше 10 мин и с превышением диска;
- удаляет контейнеры с меткой `rootcamp.sandbox`, которых нет в БД или которые там в состоянии `stopped`/`failed` (сироты);
- переводит в `failed` строки `starting` старше 5 мин.

При старте `sandboxd` сверяет контейнеры с меткой и БД. Живые контейнеры в состоянии `ready` подхватываются, строки без контейнера помечаются `failed` с причиной `lost`.

Раз в сутки в 04:00 MSK: `docker image prune -f --filter label!=rootcamp.keep` и `docker volume prune -f`.

### 6.7. Проверка целей

`POST /api/runs/:id/check` выполняет:
1. `api` берёт из серверной части контента скрипты целей и вызывает `exec-checks`.
2. `sandboxd` запускает цели последовательно. Каждая выполняется как `docker exec -i <c> timeout --kill-after=2 <timeoutSec> bash -s` со скриптом в stdin, от root, с окружением `PATH=/usr/sbin:/usr/bin:/sbin:/bin`.
3. Код 0 — цель выполнена; любой другой код или таймаут — не выполнена. Первые 300 символов stdout показываются пользователю как подсказка к результату: автор пишет туда понятную фразу вроде «nginx -t всё ещё сообщает об ошибке».
4. `api` записывает `goals_passed` в `practice_progress`. Если в этом прогоне выполнены все цели, практика решена:
   - при первом решении: XP = `base − hintCost × hints_revealed + (hints_revealed == 0 ? noHintBonus : 0)`;
   - при повторном: 10 XP;
   - `registerActivity` для серии, пересчёт ранга, запуск переходит в `solved`.

Подсказки. `hints_revealed` хранится в `practice_progress` и сохраняется между запусками: подсказка, открытая однажды, остаётся открытой и уменьшает награду за первое решение. «Подсказка стоит −5 XP» означает уменьшение награды за эту практику на `hintCost`; уже накопленный XP не списывается. Сердечки в практике не тратятся и не восстанавливаются.

### 6.8. Предзагрузка образов

- Образы песочниц собираются на VPS скриптом `rebuild-sandbox-images.sh`. Он выполняет `docker build --pull`, затем `practice:test` по всем практикам каждого образа и только после успеха переставляет тег `:24.04` на новую сборку. Старый образ получает тег `:prev` и метку `rootcamp.keep` до следующей сборки. Так образы всегда лежат локально, и `docker run` не тянет их из сети.
- Внутренние образы для класса `docker` (`innerImages` из манифестов) прогреваются тем же скриптом: из временной песочницы выполняется `docker pull` через registry, кэш которого лежит в томе `registry-cache`.
- Пакеты apt — по мере первого обращения в томе `apt-cache`. Кэш прогревается при сборке образов, а пакеты, нужные инцидентам, уже установлены в образах.

### 6.9. Три эталонных инцидента

**inc-nginx-down** (`rc/linux-base`, `light`, 30 мин, награда 40/+10).
- Setup: кладёт `/etc/nginx/sites-available/app` с опечаткой `listn 80;` и симлинк в `sites-enabled`; удаляет `default`; кладёт `/var/www/app/index.html` с маркером `rootcamp-ok`; выполняет `systemctl restart nginx || true`.
- Цели:
  1. `config-valid`: `/usr/sbin/nginx -t` возвращает 0.
  2. `service-active`: `systemctl is-active nginx` и `systemctl is-enabled nginx`.
  3. `http-200`: `curl -s -o /tmp/b -w '%{http_code}' http://127.0.0.1/` = 200, и `/tmp/b` содержит `rootcamp-ok`.
- Цель макета «Найти причину в логах» заменена этими тремя: её нельзя проверить состоянием системы.
- Решение: `sed -i 's/listn/listen/' …; systemctl restart nginx`.

**inc-file-perms** (`rc/linux-base`, `light`, 30 мин, 40/+10).
- Setup: создаёт пользователя `app`, юнит `report.service` (`User=app`, `ExecStart=/srv/app/run.sh`; скрипт раз в 5 с дописывает строку в `/var/log/report/report.log`). Ломает: `/srv/app/config.ini` — `root:root 600`, `run.sh` без бита `x`. Сервис падает.
- Цели:
  1. `config-readable`: `runuser -u app -- test -r /srv/app/config.ini`, при этом в `stat -c %a` последняя цифра 0 (файл не читается всеми).
  2. `script-exec`: `runuser -u app -- test -x /srv/app/run.sh`.
  3. `service-running`: `systemctl is-active report` и время изменения `report.log` моложе 15 с.
- Решение: `chown root:app config.ini; chmod 640 config.ini; chmod 755 run.sh; systemctl restart report`.

**inc-container-crash** (`rc/docker`, `docker`, 40 мин, 50/+10, `innerImages: [alpine:3.20]`).
- Setup: в `/root/shop/` кладёт `Dockerfile` (`FROM alpine:3.20`, `entrypoint.sh`: если `APP_PORT` пуст — `echo "FATAL: APP_PORT is not set" >&2; exit 1`, иначе `busybox httpd -f -p $APP_PORT -h /www`, в `/www/health` лежит `ok`). Собирает образ `shop-api` и запускает `docker run -d --name shop-api --restart unless-stopped -p 8080:8080 shop-api`. Контейнер уходит в цикл перезапусков.
- Цели:
  1. `running`: `docker inspect -f '{{.State.Running}} {{.State.Restarting}}' shop-api` = `true false`, и `StartedAt` старше 5 с.
  2. `health`: `curl -fsS http://127.0.0.1:8080/health` = `ok`.
  3. `restart-policy`: `HostConfig.RestartPolicy.Name` = `unless-stopped`.
- Решение: `docker rm -f shop-api; docker run -d --name shop-api --restart unless-stopped -e APP_PORT=8080 -p 8080:8080 shop-api`.

## 7. Перенос логики и контента из DockerLingo

### 7.1. Файлы `src/logic` → `packages/logic`

Общий принцип: функции остаются чистыми и детерминированными, время передаётся параметром `now`, а часовой пояс — новым параметром `tz`. Существующие тесты из `src/logic/__tests__` переносятся вместе с кодом и правятся только там, где меняется сигнатура.

| Файл | Берём | Меняем |
|---|---|---|
| `xp.ts` | `LESSON_XP=10`, `PERFECT_BONUS=5`, `lessonXp`, `goalJustReached`, `weekBars` | `addXp`/`xpOn`/`xpByDate` заменяются агрегатами из `xp_events`; функции принимают `xpToday: number`. `DailyGoal` — константа `DAILY_GOAL = 30` (выбор 20/50 убран) |
| `hearts.ts` | Целиком: `MAX_HEARTS=5`, `REGEN_MS=1_800_000`, `regen`, `loseHeart`, `gainHeart`, `msToNextHeart` | Ничего |
| `streak.ts` | `registerActivity`, `checkStreakBroken` | Ничего; `today` вычисляется вызывающим кодом через `toDateKey(now, tz)` |
| `leitner.ts` | `INTERVAL {1:1, 2:3, 3:7}`, `markWrong`, `markCorrectInReview`, `dueItems` | Ничего; хранение в `review_items` |
| `unlock.ts` | Алгоритм `lessonStatuses`, `currentLessonId`, `isCourseComplete` | Работают на уровне трека (`Track` вместо `Course`). Узлы `kind: practice` не участвуют в выборе `current`: их статус `available`, если пройден предыдущий урок. `pathOffset`/`SNAKE` не переносятся — путь на сайте вертикальный, без змейки |
| `answerCheck.ts` | `checkAnswer`, `isAnswerReady`, `correctAnswerText` | Добавлены ветки `order_steps` (поэлементное сравнение; текст ответа — шаги через «→») и `terminal_practice` (всегда `correct: false`, функция для него не вызывается — защитная ветка) |
| `lessonSession.ts` | `startLesson`, `beginTasks`, `answerLessonTask`, `continueLesson`, `completeLesson` | `completeLesson` больше не работает с `PersistedState`: возвращает «дельту» `{xp, completedLessonId, streak, summary}`, которую `api` применяет транзакцией. `solved: Set` сериализуется в массив для `jsonb` |
| `reviewSession.ts` | `buildReviewSession`, `answerReviewTask`, `advanceReview`, `completeReview`, `REVIEW_LIMIT=10`, `dueTaskIdsInCourse` | Режим `practice` переименован в `drill` («тренировка»), чтобы не путать с практикой-инцидентом. Пул тренировки и повторения исключает задания `terminal_practice`. `completeReview` возвращает дельту, как `completeLesson` |
| `reward.ts` | `grantReward` | Возвращает дельту (`xp`, новый `streak`, `goalJustReached`), агрегаты XP приходят параметром |
| `dates.ts` | `diffDays`, `addDays`, `isDateKey` | `toDateKey(ms, tz)` и `localTimeOn(key, h, m, tz)` считают в явном IANA-поясе через `Intl.DateTimeFormat`, а не в поясе процесса |
| `normalize.ts`, `shuffle.ts`, `plural.ts`, `format.ts` | Целиком | Ничего |
| `courseQuery.ts` | Идеи `allLessons`, `findTask`, `tasksOfLessons` | Работают с набором загруженных разделов. Сервер держит весь курс в памяти; клиенту нужен только текущий раздел |
| `reminderPlan.ts` | Текст сообщения с серией (`Не потеряй серию из N дней`) | Планирование 7 локальных уведомлений заменено серверным заданием (§7.4) |
| `progressSchema.ts`, `migrations.ts`, `refresh.ts` | — | Не переносятся: состояние живёт в БД, схема задаётся Drizzle и миграциями |
| Новый `rank.ts` | — | `computeRank`, `nextRankProgress` (§4.5) |
| Новый `practiceReward.ts` | — | Формула из §6.7 |

`src/content/types.ts` переходит в `packages/content-schema/src/types.ts` и обобщается (§4.2). Типы описываются zod-схемами, TS-типы выводятся через `z.infer`. `UserAnswer` пополняется вариантом `order_steps`. `validateCourse.ts` переносится в `packages/content-schema/src/validate.ts` с обобщением правил (§4.3), его тесты — вместе с ним.

`src/state/store.ts`, `selectors.ts` и `safeStorage.ts` не переносятся. Их роль выполняют `api` (сервисы, транзакции) и TanStack Query на клиенте. Из `selectors.ts` берутся только формулы производных значений: счётчик «К повторению», прогресс раздела.

### 7.2. UI

- `src/ui/theme.ts` → `apps/web/src/styles/tokens.css`. Все цвета палитры «Слои» становятся CSS-переменными (`--bg: #151A2D`, `--surface`, `--surface-hi`, `--term`, `--line`, `--edge`, `--ink`, `--muted`, `--faint`, `--amber`, `--teal`, `--coral`, `--flame` и остальные), шкала отступов — `--space-*`, радиусы — `--radius-*`, шрифтовые роли — классы `.t-display`, `.t-title` и т. д.
- `layerHash` переносится в `packages/logic/format.ts` («слой 3fa91c» на пути).
- `MAX_CONTENT_WIDTH = 520` действует только для колонки урока; остальные экраны используют сетку §8.2.
- Тема только тёмная.
- Компоненты React Native (`ui/components/*`, `ui/tasks/*`) переписываются на DOM-React с тем же поведением: `TaskPlayer`, пять видов заданий, `FeedbackBanner`, `HeartsIndicator`, `OutOfHearts`, `WeekBars`, `TheoryCardView`. Добавляются `OrderStepsView` и `PracticeNodeCard`.

### 7.3. Контент T7

Конвертер `tools/import-dockerlingo` (запускается один раз, результат коммитится) принимает путь к `content/units/*.json` DockerLingo:
1. Переименовывает ID: `uNN` → `t7.sNN`, `uNN-lMM` → `t7.sNN.lMM`, `uNN-lMM-tKK` → `t7.sNN.lMM.tKK`.
2. Записывает YAML по схеме §4.2: `section.yaml` и `lNN.yaml`.
3. Прогоняет валидатор. Нарушения R21 (устаревший Compose) правятся вручную в получившемся YAML, и это коммитится отдельным коммитом.
4. Узел `inc-container-crash` добавляется в конец `t7.s09/section.yaml`.

Если правка контента сделает два задания одинаковыми, правило R13 (уникальность вопросов) поймает это при валидации.

### 7.4. Напоминания

Задание pg-boss `reminders` запускается каждые 5 минут. Для пользователей с `reminder_enabled`, подтверждённым email и статусом `active` оно проверяет три условия: локальное время ≥ `reminder_time`, сегодня по поясу пользователя нет `xp_events` и нет строки в `reminder_log`. Если все выполнены — ставит письмо в очередь. Текст: если вчера была активность, «Не потеряй серию из N дней», иначе общий текст. В письме есть подписанная ссылка «Отключить напоминания» (HMAC, без входа в аккаунт).

## 8. UI

### 8.1. Экраны

Стиль — по макетам на холсте. Палитра «Слои»: пройденный урок — это собранный слой с хешем, текущий — подсвечен янтарём с подписью «СЕЙЧАС», закрытые — с пунктирной рамкой. Шрифты: Unbounded (заголовки, 600/700), IBM Plex Sans (текст, 400/500/600), JetBrains Mono (метки, цифры, код, терминал). Шрифты подключаются локально через `@fontsource` (без Google Fonts — так CSP проще). Маскот «терминальная мордочка» — SVG (рамка-терминал, два глаза-точки, рот-полоса) в 5 состояниях: `idle`, `happy` (верно, урок пройден), `sad` (ошибка, сердечки кончились), `waiting` (очередь, запуск песочницы), `sleep` (песочница остановлена).

| Экран | Маршрут | Содержание |
|---|---|---|
| Вход / Регистрация | `/login`, `/register`, `/verify`, `/forgot`, `/reset` | Формы. После регистрации — экран «Проверь почту» с кнопкой «Отправить ещё раз» (таймер 60 с) и подсказкой про спам |
| Путь | `/`, `/track/:trackId` | Шапка: трек, «N из M уроков», чипы серии, XP сегодня/30, сердечек, ранга. Разделы: пройденные свёрнуты («5 слоёв · образ собран»), текущий раскрыт со списком слоёв, следующий — заблокирован. Узлы-практики — карточки с иконкой терминала. Правая колонка (≥ 1280 px): «Цель на сегодня», «Инцидент дня» (первая доступная нерешённая практика), «Неделя» (топ-4 лидерборда), «Повторение» (счётчик). Выбор трека — выпадающий список в шапке |
| Урок | `/lesson/:lessonId` | Теория → задания. Сверху прогресс-бар и сердечки, снизу кнопка «Проверить», после ответа — баннер с объяснением и «Продолжить». Итог: XP, «без ошибок», цель дня, серия. Модальное окно «Сердечки кончились» с таймером до следующего |
| Повторение | `/review` | Тот же плеер. Режимы «Повторение» (N к повторению) и «Тренировка» (когда к повторению ничего нет). Итог: +XP, +1 сердечко |
| Практика | `/practice` (каталог), `/practice/:practiceId` | Каталог — карточки инцидентов со статусом. Экран инцидента — по макету: бриф, цели с отметками, «Проверить», «Сбросить сервер», подсказки с ценой, награда, терминал, таймер, индикатор состояния песочницы, строка CPU/RAM. Перед стартом — карточка «Начать (≈ 20 с)», при очереди — «Ты N-й в очереди» с маскотом |
| Лидерборд | `/leaderboard` | Вкладки «Все» и «Друзья», неделя пн–вс по MSK, отсчёт до конца недели. Блок «Друзья»: поле «Добавить по нику», входящие заявки (принять/отклонить), исходящие |
| Профиль | `/profile`, `/u/:nick` | Ранг и прогресс до следующего, всего XP, серия и рекорд, график недели (`weekBars`), прогресс по трекам, история мест по неделям. Настройки (только свой): напоминания вкл/выкл и время, часовой пояс, смена пароля, выход |
| Админка | `/admin` | По макету: плитки CPU/Память/Диск/Песочницы (очередь, слот heavy), таблица активных песочниц с «Остановить», таблица пользователей (ник, email, ранг, XP, текущий трек, «был», статус, «Бан»/«Разбан», «Подтвердить email»), переключатель регистрации (открыта/закрыта). Вариант «по приглашению» из макета не реализуется (§12). Обновление раз в 10 с |

### 8.2. Адаптивность

| Диапазон | Раскладка |
|---|---|
| < 640 px (телефон) | Одна колонка, нижняя панель вкладок (Путь, Практика, Повторение, Лидерборд, Профиль; Админка — в профиле для админов). Боковые поля 16 px. Чипы шапки в одной строке с горизонтальной прокруткой |
| 640–1023 px (планшет) | Одна колонка шириной до 720 px, нижняя панель остаётся |
| 1024–1279 px (ноутбук) | Боковая навигация 220 px, основная колонка; правая колонка уходит под основную |
| ≥ 1280 px (ПК) | Боковая навигация + основная колонка + правая колонка 300–360 px, максимум 1440 px по центру |

Минимальная высота касаемых элементов — 44 px. Фокус-кольцо янтарное, 2 px. Всё управляется с клавиатуры: в плеере `1–4` выбирают вариант, `Enter` проверяет и продолжает. Контраст текста ≥ 4.5:1 (палитра это обеспечивает: ink на bg — около 13:1).

### 8.3. Терминал

Настройки xterm.js: `fontFamily: JetBrains Mono`, `fontSize` 14 (ПК) или 12.5 (телефон), тема из токенов (`background: --term`), `scrollback: 3000`, `cursorBlink`. `addon-fit` пересчитывает размер при изменении контейнера (ResizeObserver) и отправляет `resize`. Вставка — `Ctrl+Shift+V` и контекстное меню браузера, копирование — выделением.

Терминал на телефоне (по макету MobilePractice):
- Шапка: «назад», название, состояние и таймер, кнопка «Проверить» всегда видна.
- Вкладки «Терминал | Цели X/Y | Подсказки»; над терминалом строка «Следующая цель».
- Ряд дополнительных клавиш 6×2: `Esc`, `Tab`, `Ctrl` (залипающий модификатор: следующая буква отправляется как управляющий символ; подсвечен, пока активен), `↑`, `↓`, `|`, `←`, `→`, `/`, `-`, `~`, `^C`. Нажатия отправляют соответствующие escape-последовательности.
- Высота области терминала следует за `visualViewport`: при открытой клавиатуре терминал и ряд клавиш остаются над ней, последняя строка видна.
- Скрытое поле ввода xterm получает `autocapitalize=off`, `autocorrect=off`, `spellcheck=false`.
- Минимум 40 колонок; если экран уже, шрифт уменьшается до 11 px, после чего включается горизонтальная прокрутка.

## 9. Обработка ошибок

| Ситуация | Обнаружение | Поведение системы | Что видит пользователь |
|---|---|---|---|
| Обрыв WebSocket | `close`/`error` на клиенте, нет `pong` 45 с | Клиент получает новый билет и переподключается с задержками 1, 2, 4, 8, 15 с, всего до 2 мин. tmux сохраняет сессию | Плашка «Переподключаемся…» поверх терминала; после успеха — та же сессия и история. Через 2 мин — «Соединение потеряно» и кнопка «Подключиться» |
| Песочница умерла (OOM, crash, перезагрузка хоста) | Событие Docker `die`/`oom` у `sandboxd`, сверка при старте | `sandboxes.state = failed`, причина `oom`/`crashed`/`lost`; WS получает `closed: sandbox_failed`; запуск переходит в `failed`. Повторно больше 2 раз за час — алерт админам | «Сервер упал (не хватило памяти)» и кнопка «Запустить заново». Пройденные цели сохранены в `practice_progress`, но для решения нужен полный проход проверок |
| Нет ресурсов | Планировщик не допускает заявку | Очередь (§6.5), `queue_timeout` через 20 мин, `queue_full` при 10 заявках | «Ты N-й в очереди, примерно M мин» с маскотом `waiting`; при `queue_full` и `queue_timeout` — «Сейчас все серверы заняты, попробуй через 10 минут» |
| Setup упал | Ненулевой код `setup.sh` | `failed: setup_failed`, алерт админам с первыми 2000 символами вывода | «Не удалось подготовить инцидент. Мы уже знаем» и кнопка «Попробовать снова» |
| TTL истёк | Сборщик мусора | Остановка, WS `closed: expired`, запуск `expired` | За 5 и 1 мин — тост с кнопкой «Продлить» (если доступно); после истечения — «Время вышло», кнопка «Новый сервер» |
| Проверка зависла | `timeout` внутри exec + таймаут HTTP 45 с | Цель с таймаутом считается невыполненной, `output = "проверка не уложилась в N с"` | Красная отметка цели и текст |
| Письмо не пришло | `email_log.status = failed` после 5 попыток (1, 5, 15, 60, 240 мин) | Алерт админам. Админ видит статус в карточке пользователя и может нажать «Подтвердить email» или «Отправить снова» | На экране «Проверь почту»: «Отправить ещё раз» (лимиты §5.1), проверка папки «Спам», адрес, на который ушло письмо, и форма «Сменить email» (`PATCH /api/me {email}`, письмо уходит на новый адрес). После 3 повторов — «Напиши администратору» |
| SMTP недоступен целиком | Ошибка соединения | Задания pg-boss копятся и отправляются после восстановления; `/api/health` показывает `smtpLastOkAt` | Без изменений, письма придут с задержкой |
| Контент обновился во время урока | `409 content_changed` | Сессия закрывается без награды и штрафа | Тост «Курс обновился, урок перезапущен» |
| Сеть пропала во время урока | `fetch` упал | Ответ повторяется до 3 раз (идемпотентность по `(sessionId, taskId, presentation)`) | Баннер «Нет связи», кнопка «Повторить» |
| Сессия входа истекла | `401` | Переход на `/login?next=…` | Форма входа, затем возврат на исходную страницу |
| Пользователь забанен во время работы | Следующий запрос → `403 banned` | Сессии удалены, песочница остановлена | Экран «Аккаунт заблокирован» с причиной |
| Внутренняя ошибка | `500` | pino пишет `reqId`; ошибки 5xx чаще 10 в минуту — алерт | «Что-то сломалось (код reqId)» и маскот `sad` |

## 10. Тестирование

### 10.1. Unit (Vitest)

- `packages/logic`: перенесённые тесты DockerLingo (`xp`, `hearts`, `streak`, `leitner`, `unlock`, `answerCheck`, `lessonSession`, `reviewSession`, `dates`, `boundaries`) плюс новые: `order_steps`, `rank`, `practiceReward`, `toDateKey` с поясами (`Europe/Moscow`, `Asia/Vladivostok`, `America/New_York`, переход на летнее время). Покрытие строк ≥ 95 %.
- `packages/content-schema`: тесты валидатора на каждое правило R1–R22 (минимальный нарушающий пример → ожидаемый код правила) и тест «текущий `content/` валиден».
- `apps/web`: тесты компонентов плеера (Testing Library) для каждого из 6 интерактивных типов; клавиатура мобильного терминала → правильные escape-последовательности.

### 10.2. Интеграционные тесты API (Vitest + Testcontainers PostgreSQL 16)

`api` поднимается с настоящей БД и миграциями, `sandboxd` заменён фейком с тем же внутренним контрактом, SMTP — Mailpit. Сценарии:
- регистрация, письмо, подтверждение, вход, сброс пароля, лимиты;
- урок без ошибок: +15 XP, серия 1, урок `completed`, следующий `current`;
- урок с ошибками: потеря сердечка, `markWrong`; при 0 сердечек — `out_of_hearts`;
- повторение: коробки, +XP, +1 сердечко; тренировка недоступна, пока есть что повторять;
- неверный порядок заданий → `out_of_order`; `content_changed`;
- практика: создание запуска, `run_exists`, проверки (фейк возвращает заданные коды), формула награды с подсказками, повторное решение → 10 XP;
- лидерборд: границы недели по MSK, вкладка друзей, встречные заявки;
- админка: доступ только `is_admin`, бан останавливает песочницу (вызов фейка), `audit_log`;
- напоминания: письмо уходит один раз в день и только если сегодня не было XP.

`sandboxd` тестируется отдельно с драйвером `runc-dev`. Это обычный runc с образом `rc/test-shell` (Alpine с bash и tmux), без systemd. Драйвер разрешён только при `NODE_ENV !== 'production'` — `sandboxd` проверяет это при старте и падает. Покрываются планировщик и очередь (бюджет в тесте уменьшен до 1 слота), сборщик мусора (сироты, TTL, простой), протокол WS (билет, повторное использование билета, resize, ограничение на 2 соединения, закрытие с причинами).

### 10.3. Тесты на Sysbox (VPS)

Запускаются командой `rootcamp-cli practice:test` на VPS (там есть Sysbox). На Docker Desktop под Windows и на стандартных раннерах GitHub Sysbox не поддерживается или не установлен, поэтому эти тесты в CI не запускаются. Набор: тест изоляции (§6.4) и тесты инцидентов (§10.5).

### 10.4. E2E (Playwright)

Стенд `infra/compose.e2e.yaml`: web, api, sandboxd с `runc-dev`, PostgreSQL, Mailpit, Caddy. Проекты Playwright: `mobile` (390×844, touch) и `desktop` (1440×900). Каждый сценарий прогоняется в обоих:
1. Регистрация → письмо в Mailpit → переход по ссылке → Путь.
2. Урок T1.1.l01: верные и неверные ответы всех типов, итог, XP в шапке.
3. Сердечки: 5 ошибок → «Сердечки кончились».
4. Повторение после ошибки (часы сдвигаются через `page.clock` на +1 день).
5. Практика на `rc/test-shell` (стенд собирает контент из `content/` плюс фикстуру `e2e/fixtures/content/`, где лежат манифест `inc-e2e-touch` и запись образа `rc/test-shell` в реестре образов; в рабочий контент фикстура не попадает): старт, ввод `echo hi` в терминал, `resize`, «Проверить» (тестовый манифест `inc-e2e-touch`: цель «существует /tmp/done»), `touch /tmp/done`, решено. Обрыв сети через `context.setOffline` → переподключение → история на месте.
6. Друзья и лидерборд: два пользователя, заявка, принятие, оба в таблице.
7. Админка: остановка песочницы, бан, у забаненного — экран блокировки.

Кроме того, `@axe-core/playwright` проверяет экраны Путь, Урок, Практика и Профиль: нарушений уровня `serious` быть не должно.

### 10.5. Тест каждого инцидента

`rootcamp-cli practice:test <id>|--all|--changed` для каждой практики:
1. Создаёт песочницу из манифеста через настоящий `sandboxd` (вне пользовательской очереди, не больше одной одновременно).
2. Выполняет `setup.sh` и проверяет код 0.
3. Запускает все `check`: **каждая** должна вернуть не 0 — инцидент действительно сломан, и проверки не проходят даром.
4. Выполняет `solution.sh` и проверяет код 0.
5. Запускает все `check`: каждая должна вернуть 0. Повторный прогон тоже 0 (идемпотентность).
6. Замеряет время до готовности и пишет отчёт в JSON (`practice-test-report.json`).

`--changed` берёт практики, файлы которых изменились относительно последнего задеплоенного коммита, и все практики изменённых образов. Красный результат прерывает `deploy.sh` до активации контента.

### 10.6. Валидатор курса

`pnpm content:validate` запускается в CI на каждом PR и в pre-commit (husky + lint-staged для `content/**`). Он покрывает R1–R22, shellcheck и линтер актуальности. Предупреждения не валят сборку; ошибки валят.

### 10.7. CI (GitHub Actions)

На PR: `lint` (ESLint, Prettier), `typecheck`, unit, интеграционные (Testcontainers на раннере), `content:validate`, сборка web и образов приложений, e2e (compose.e2e). На `main` дополнительно публикуются образы `api`, `sandboxd`, `web` (статика в образе Caddy) в GHCR с тегом коммита.

## 11. Эксплуатация

### 11.1. Состав compose (`infra/compose.yaml`)

| Сервис | Образ | Сети | Тома | Лимиты |
|---|---|---|---|---|
| caddy | `ghcr.io/<repo>/web:<sha>` (Caddy + `web-dist`) | `rc-public`, `rc-internal` | `caddy-data`, `content-dist` (ro) | 256 МБ |
| api | `ghcr.io/<repo>/api:<sha>` | `rc-internal` | `content-dist` (ro) | 512 МБ |
| sandboxd | `ghcr.io/<repo>/sandboxd:<sha>` | `rc-internal` | `/var/run/docker.sock`, `/proc:/host/proc:ro`, `/:/host/root:ro` | 256 МБ |
| postgres | `postgres:16` | `rc-internal` | `pg-data` | 768 МБ |
| apt-mirror | `sameersbn/apt-cacher-ng` (закреплённый digest) | `rc-mirror-egress`, порт `172.30.0.1:3142` | `apt-cache` | 128 МБ |
| registry | `registry:2` (proxy к Docker Hub) | `rc-mirror-egress`, порт `172.30.0.1:5000` | `registry-cache` | 128 МБ |
| dnsmasq | `rc/dnsmasq` (локальная сборка) | порт `172.30.0.1:53` | — | 32 МБ |
| backup | `rc/backup` (postgres-client + restic + cron) | `rc-internal`, `rc-mirror-egress` | `backups` | 128 МБ |

Сеть `rc-sbx` создаётся `bootstrap-vps.sh` вне compose, поскольку песочницы — не сервисы compose. Логи всех сервисов — `json-file`, `max-size 10m`, `max-file 3`.

### 11.2. Деплой

- `bootstrap-vps.sh` (однократно): Docker Engine, Sysbox CE (версия из `versions.env`), swap 2 ГБ, сеть `rc-sbx`, юнит `rc-sbx-firewall`, ufw (22, 80, 443), `unattended-upgrades`, пользователь `deploy`, вход по SSH только по ключу.
- `deploy.sh <sha>` (по SSH из GitHub Actions с ручным подтверждением в environment `production`):
  1. `docker compose pull`;
  2. `rootcamp-cli content:install <sha>` — кладёт `content-dist/<hash>` из образа api в том;
  3. `practice:test --changed`;
  4. `docker compose up -d` (api применяет миграции при старте);
  5. `rootcamp-cli content:activate <hash>`;
  6. smoke: `curl /api/health`.
- При ошибке на шагах 3–6 предыдущие теги остаются в `infra/.deployed`, и `deploy.sh --rollback` поднимает их. Миграции пишутся только расширяющими (добавить колонку или таблицу); удаление идёт отдельным релизом после того, как код перестал использовать поле. Поэтому откат кода безопасен.
- Активация контента не трогает активные песочницы. Новая версия применяется к новым запускам и сессиям.

### 11.3. Бэкапы БД

- Каждый день в 03:30 MSK: `pg_dump -Fc` → `/backups/rootcamp-YYYYMMDD.dump`. Локально хранятся 7 ежедневных и 4 еженедельных копии (воскресные).
- Сразу после дампа: `restic backup` в S3-совместимое хранилище (A8), политика `forget --keep-daily 14 --keep-weekly 8 --prune`. Пароль репозитория restic хранится в `.env` на VPS и в менеджере паролей владельца.
- Ошибка дампа или restic → алерт админам.
- `restore-test.sh`: поднимает временный `postgres:16`, восстанавливает последний дамп, проверяет число строк в `users` и `xp_events`. Запускается в M6 и затем раз в месяц через cron, результат пишется в лог и при ошибке приходит алертом.
- Тома `caddy-data` (сертификаты) и кэши зеркал не бэкапятся — они восстанавливаются сами.

### 11.4. Мониторинг ресурсов

- `sandboxd /internal/metrics`: CPU и RAM хоста из `/host/proc/stat` и `/host/proc/meminfo`, диск — `statfs` по `/host/root`, по песочницам — `docker stats --no-stream`. Опрос раз в 10 с, данные хранятся в памяти (последние 60 точек).
- Админка показывает текущие значения и отметку «все сервисы в норме» по `/api/health` каждого сервиса.
- Задание `alerts` (раз в минуту) отправляет письмо всем `is_admin`, не чаще одного письма на тип алерта в 30 мин, если:
  - RAM хоста > 90 % три замера подряд;
  - диск > 85 %;
  - сервис нездоров 2 мин;
  - ошибка бэкапа;
  - `setup_failed`;
  - 5xx > 10/мин;
  - `email_log failed`;
  - песочница падает повторно.
- Внешний мониторинг доступности сайта не входит в v1.

### 11.5. Обновление образов и компонентов

- **Образы песочниц.** Раз в месяц (cron, первое воскресенье, 04:30 MSK) запускается `rebuild-sandbox-images.sh` (§6.8). Если тесты упали, старый тег остаётся, приходит алерт.
- **Образы приложений.** Через Renovate в репозитории (PR с обновлениями npm и базовых образов раз в неделю) и деплой после зелёного CI.
- **Sysbox и Docker Engine.** Вручную, раз в квартал или по бюллетеню безопасности: обновить `versions.env`, выполнить на VPS `apt install`, затем `practice:test --all`. Перед обновлением админ выполняет `rootcamp-cli sandboxes:drain`: новые запуски запрещаются (пользователи получают `queue_full`), активные песочницы доживают до остановки. Когда в админке 0 активных песочниц, обновление начинается; после него `sandboxes:undrain` снова разрешает запуски.
- **Версии в контенте.** При каждом цикле трека сверяются факты из списка роадмапа (§2.2, шаг 5).

### 11.6. Чек-лист запуска (M6)

DNS и TLS работают; SMTP отправляет письма (проверено на Gmail и Яндекс); первый админ назначен командой `rootcamp-cli admin:grant <email>`; бэкап снят, и восстановление проверено; `practice:test --all` зелёный; тест изоляции зелёный; алерт проверен искусственным заполнением диска; регистрация открыта.

## 12. Вне scope v1

- Лента активности друзей, лиги, достижения, комментарии, чат.
- Мобильные приложения, PWA с офлайном, push-уведомления (напоминания только по email).
- Вход через OAuth, двухфакторная аутентификация, регистрация по приглашениям (вариант из макета админки), удаление аккаунта самим пользователем (выполняет админ через `rootcamp-cli user:delete`).
- Выбор дневной цели (фиксировано 30 XP), светлая тема, языки кроме русского.
- Редактор контента в браузере (контент — YAML в репозитории).
- Защита от обмана проверок изнутри песочницы (подмена утилит root-пользователем).
- Несколько песочниц у одного пользователя, загрузка файлов в песочницу, сохранение состояния песочницы между запусками.
- Образ `rc/k3s` и инциденты Kubernetes (подпроект T11); класс `heavy` и его квота в планировщике реализованы и покрыты тестами с тестовым образом.
- Контент сверх §2.3, в том числе T7.u11.
- Горизонтальное масштабирование, второй VPS, внешний мониторинг доступности, централизованные логи.
- Перенос прогресса пользователей DockerLingo.

## 13. Self-review

Проверка проведена по четырём критериям; найденное исправлено в тексте выше.

1. **TBD и заглушки.** Поиск по «TBD», «TODO», «уточнить», «позже решим» ничего не нашёл. Каждое число (лимиты, TTL, пороги рангов, бюджеты, расписания) задано явно. Внешние зависимости, которые проект не решает (SMTP-провайдер, S3-хранилище, домен), вынесены в допущения A1, A2, A8, а не оставлены пустыми.
2. **Противоречия.**
   - Макет практики содержит цель «Найти причину в логах», которую нельзя проверить скриптом. Исправлено: в §6.9 она явно заменена тремя проверяемыми целями.
   - В DockerLingo режим повторения называется `practice` и конфликтует с «Практикой» rootcamp. Исправлено: переименован в `drill` (§7.1), `xp_events.source` использует `drill`.
   - Роадмап ставит инциденты nginx и прав в разделы 1.7 и 1.4, которых нет в v1. Привязка к T1.1 в v1 и перенос с сохранением ID описаны в §2.3.
   - Роадмап делает T7 зависимым от T1, T2, T6, а в v1 этих треков почти нет. Решение: `prerequisites` — только рекомендация (§4.2), линейная разблокировка действует внутри трека.
   - T7 в роадмапе — 11 разделов, в v1 — 10. Решение: в v1 T7 публикуется со `status: complete`; ранги не понижаются при появлении u11 (§2.3, §4.4, §4.5).
   - Макет админки предлагает режим «по приглашению». Он явно исключён (§8.1, §12); `registration_mode` принимает только `open`/`closed`.
   - В §11.5 был черновой обрыв фразы про регистрацию при обновлении Sysbox. Исправлено: процедура описана через `sandboxes:drain`/`undrain`, регистрация при этом не меняется.
   - В §9 «Сменить email» было описано как повторная регистрация с тем же ником, что противоречит `nick_taken`. Исправлено: смена email — через `PATCH /api/me {email}`, только пока email не подтверждён (§5.1).
3. **Двусмысленности.**
   - «Подсказка −5 XP» определена как уменьшение награды за практику, без списания накопленного XP; подсказки сохраняются между запусками (§6.7).
   - «Трек пройден» определён через `status: complete` и уроки `kind: lesson` (§4.5).
   - «Доступна практика» — пройден предыдущий урок в пути (§5.1).
   - Границы дня — по поясу пользователя, недели — по MSK (A9).
   - Повторное решение практики — 10 XP; повтор урока — XP по правилам DockerLingo (`lessonXp`), как в оригинале.
   - Сердечки в практике не участвуют (§6.7).
4. **Покрытие требований.** Все 12 обязательных пунктов задания отражены в разделах 1–12; согласованные решения не пересматривались.
