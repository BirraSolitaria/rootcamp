# rootcamp M3 «Обучение» Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Контент T7 (перенос 600 заданий) и T1.1 проходит конвейер «YAML → валидатор → сборка → активация»; пользователь проходит урок и повторение с телефона и ПК, сервер начисляет XP, серию, сердечки, коробки Лейтнера и ранг.

**Architecture:** `tools/import-dockerlingo` один раз конвертирует JSON DockerLingo в YAML. `tools/content-build` собирает версию с хешем: публичная часть отдаётся Caddy как immutable-статика, серверная (манифесты и скрипты практик) читается только `api`. `api` держит активную версию в памяти (`ContentStore`), сессии обучения хранит в `learning_sessions.state` и применяет дельты `packages/logic` транзакцией. `web` проверяет ответ локально для мгновенной обратной связи, но итог берёт из ответа сервера.

**Tech Stack:** как в M2 + `@dnd-kit/core`/`@dnd-kit/sortable` (перетаскивание `order_steps`), `@axe-core/playwright`, Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-20-rootcamp-design.md` (§2.3 п.1–2, §3.5, §4.2, §4.4–4.5, §5.1 «Контент и прогресс», «Сессии обучения», §7.1–7.3, §8.1 Путь/Урок/Повторение, §9 строки «Контент обновился», «Сеть пропала», §10.4 сценарии 2–4). Предыдущая веха: M2.

## Global Constraints

- Все Global Constraints из M1 и M2.
- Хеш версии — первые 12 символов sha256 от канонического JSON (ключи отсортированы) **всего** собранного курса, включая серверную часть практик (скрипты), чтобы правка `check.sh` давала новую версию.
- Публичный контент: `Cache-Control: public, max-age=31536000, immutable`.
- `terminal_practice` никогда не попадает в повторение, тренировку и счёт ошибок урока.
- Урок стартует, только если его статус `current` или `completed`; незавершённая сессия заменяется новой (частичный уникальный индекс `learning_sessions(user_id) WHERE status='in_progress'`).
- Если `content_version` сессии ≠ активной версии — `409 content_changed`, сессия закрывается без награды и штрафа.
- `users.total_xp` = сумма `xp_events.amount`; обе записи в одной транзакции; `users.rank` не понижается.
- Урок `t1.s01.l01` содержит все 6 интерактивных типов заданий (нужно e2e-сценарию 2); весь T1.1 — хотя бы одно `order_steps`.
- Узлы-практики в пути (`practice: inc-…`) добавляются только в M4b, когда практики существуют (иначе R19).

## Review Focus

1. Пользователь дважды отправляет ответ из-за обрыва сети (повтор `fetch`) — сердечко списывается один раз, второй ответ возвращает тот же результат (тест в Task 5: идемпотентность по `(sessionId, taskId, presentation)`).
2. Урок открыт в двух вкладках: вторая стартует новую сессию, первая отвечает — получает `session_closed`, а не портит прогресс (тест в Task 5).
3. Пользователь отвечает в 23:59:59 и получает итог в 00:00:01 по своему поясу — XP идёт в день завершения урока (по `now` транзакции), как в DockerLingo (тест в Task 5).
4. Раздел, который клиент ещё не загрузил, открывается по прямой ссылке `/lesson/t7.s05.l02` — экран сам подгружает `sections/t7.s05.json` (тест в Task 9).
5. Тренировка у нового пользователя без пройденных уроков — `POST /api/review/start {mode:'drill'}` отвечает 204, экран показывает «Пока нечего тренировать», а не пустой плеер (тест в Task 6 и Task 10).

---

## File Structure

```
tools/import-dockerlingo/src/{convert,cli}.ts, tools/import-dockerlingo/test/**
tools/content-build/src/{build,hash,cli}.ts, tools/content-build/test/**
content/tracks/t7/**, content/tracks/t1/{track.yaml,s01/**}
packages/db/src/schema/learning.ts
apps/api/src/services/{contentStore,progress,lessons,review,rewards}.ts
apps/api/src/routes/{content,progress,lessons,review}.ts
packages/api-contract/src/{content,learning}.ts
apps/web/src/content/{useContent.ts}, apps/web/src/screens/{Path,Lesson,Review}/**
apps/web/src/player/{TaskPlayer,SingleChoiceView,TrueFalseView,AssembleView,FillBlankView,MatchPairsView,OrderStepsView,FeedbackBanner,TheoryCardView,HeartsIndicator,OutOfHearts,ProgressBar,Summary}.tsx
e2e/specs/{02-lesson,03-hearts,04-review}.spec.ts, e2e/helpers/answers.ts
```

Решение сверх спецификации: сборка пишет две независимые ветки — `content-dist/public/<hash>/` (монтируется в Caddy и отдаётся по `/content/<hash>/`) и `content-dist/server/<hash>/practices/<id>/` (монтируется только в `api`). Так серверная часть не может утечь из-за ошибки в правилах Caddy.

---

### Task 1: Конвертер DockerLingo → YAML и контент T7

**Files:**
- Create: `tools/import-dockerlingo/src/{convert,cli}.ts`, `tools/import-dockerlingo/test/convert.test.ts`, `test/fixtures/u01.json` (2 урока из `E:\Duolingo_Docker\content\units\u01.json`)
- Create: `content/tracks/t7/track.yaml`, `content/tracks/t7/s01…s10/{section.yaml,l01…l05.yaml}` (результат)

**Interfaces:**
- Produces: `convertUnit(unit: DockerLingoUnit): { sectionYaml: string; lessons: { file: string; yaml: string }[] }`; `mapId(id: string): string` (`u03`→`t7.s03`, `u03-l02`→`t7.s03.l02`, `u03-l02-t07`→`t7.s03.l02.t07`). CLI: `pnpm --filter import-dockerlingo start <path-to-units-dir> <out-dir>`.
- `track.yaml` T7: `id: t7`, `order: 7`, `title: Docker`, `status: complete`, `prerequisites: [t1, t2, t6]`, `reviewedAt: 2026-10-20`, `sections: [s01…s10]`. Длинные строки YAML — блочный скаляр `|` для многострочных, иначе одинарные кавычки (без потерь `:`/`#`).

- [ ] **Step 1: Write the failing test**: `mapId` на трёх примерах; `convertUnit(fixture)` → YAML, который `loadContentTree` + `TaskSchema` читают обратно и `deepEqual` исходным заданиям с переименованными ID.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5:** Скопировать `E:\Duolingo_Docker\content\units\` во временный каталог (исходник не изменять), запустить конвертер в `content/tracks/t7`. Commit `feat(content): import DockerLingo u01–u10 as t7`.
- [ ] **Step 6:** Run `pnpm content:validate` — исправить вручную все ошибки R21 (`docker-compose` → `docker compose`, удалить `version:`, `docker-compose.yml` → `compose.yaml`), не меняя ID. Повторять до `0 errors`. Commit отдельным коммитом `fix(content): t7 modern compose facts (R21)`.

### Task 2: Контент T1.1 «Терминал и оболочка»

**Files:**
- Create: `content/tracks/t1/track.yaml` (`status: partial`, `order: 1`, `title: Linux и терминал`, `sections: [s01]`, `prerequisites: [t0]`), `content/tracks/t1/s01/section.yaml` (5 узлов `lesson`), `l01.yaml…l05.yaml`

**Interfaces:**
- Produces: уроки `t1.s01.l01…l05`, по 10–15 заданий, теория ≤ 1200 символов. Темы по §4.2 и роадмапу: что такое терминал и оболочка; prompt, команда, аргументы; флаги; `man` и `--help`; история и автодополнение. `l01` содержит все 6 интерактивных типов. Эталонные ответы для e2e описываются в `e2e/helpers/answers.ts` из YAML (не дублируются вручную).

- [ ] **Step 1:** Run `pnpm content:validate` — Expected: ошибок нет до добавления файлов.
- [ ] **Step 2:** Написать 5 уроков (содержание — по роадмапу `claude/roadmap-devops.md`, раздел 1.1). Факты сверить по `man bash` Ubuntu 24.04.
- [ ] **Step 3:** Run `pnpm content:validate` — Expected: `0 errors` (R13–R14, R17 выполняются; R15/R16 не применяются к `partial`).
- [ ] **Step 4: Commit** `feat(content): t1.s01 terminal and shell`.

### Task 3: Сборка `content-dist` и обновление `published-ids.json`

**Files:**
- Create: `tools/content-build/src/{build,hash,cli}.ts`, `tools/content-build/test/build.test.ts`
- Modify: корневой `package.json` — `"content:build": "… cli.ts build content content-dist"`

**Interfaces:**
- Consumes: `loadContentTree`, `validateContent` (M1 Task 7–8).
- Produces: `buildContent(tree: ContentTree): BuiltContent`, `BuiltContent { hash: string; public: Record<string /*relpath*/, unknown>; server: Record<string, string | unknown>; ids: string[] }`; `writeContent(built, outDir): Promise<void>` → `outDir/public/<hash>/{catalog.json, sections/<id>.json, practices/<id>.json}` и `outDir/server/<hash>/{catalog.json, sections/*.json, practices/<id>/{practice.json, setup.sh, check/*.sh, solution.sh}}` (сервер получает полный курс, чтобы не читать `public`). Узел `- practice: inc-x` превращается в урок `{ id: '<sectionId>.p-inc-x', kind: 'practice', title: manifest.title, tasks: [{ id: '<sectionId>.p-inc-x.t01', type: 'terminal_practice', practiceId }] }`. Треки `draft` пропускаются. CLI `build --update-published-ids` дописывает новые ID в `content/published-ids.json` (вызывается в CI на `main`).

- [ ] **Step 1: Write the failing test**: сборка фикстуры `mini` (M1) дважды даёт одинаковый `hash` длины 12; изменение одного байта в `check/*.sh` меняет `hash`; `public` не содержит ключей `server`, `solution`, `setup`, `check`; `catalog.json` не содержит `tasks`; путь практики даёт урок `t9.s01.p-inc-demo` с одним заданием `terminal_practice`.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement (`canonicalJson` с сортировкой ключей). **Step 4:** Run — PASS.
- [ ] **Step 5:** Run `pnpm content:build` — Expected: `content-dist/public/<hash>/catalog.json` с треками `t1`, `t7`. Commit `feat(tools): content-build`.

### Task 4: `ContentStore`, активация версии, `GET /api/content/version` и `GET /api/progress`

**Files:**
- Create: `packages/db/src/schema/learning.ts` (`lesson_completions`, `review_items`, `learning_sessions` + частичный уникальный индекс, индекс `review_items(user_id, due_date)`), миграция `0001_*`
- Create: `apps/api/src/services/{contentStore,progress}.ts`, `src/routes/{content,progress}.ts`, `packages/api-contract/src/content.ts`
- Modify: `apps/api/src/cli.ts` (`content:install <dir>`, `content:activate <hash>`), `apps/api/src/services/users.ts` (`completedTracks` в `getMe`), `infra/compose.dev.yaml` (том `../content-dist` → api `/content-dist:ro`, caddy — только `public`), `infra/Caddyfile.dev` (`/content/*` → `file_server` из `public`, заголовок immutable)
- Test: `apps/api/test/{content,progress}.test.ts`

**Interfaces:**
- Produces:
  - `ContentStore { version: string; index: CourseIndex; catalog: Catalog; lesson(id): Lesson|undefined; task(id): Task|undefined; trackOfLesson(id): Track|undefined; practice(id): ServerPractice|undefined; completedTrackCount(completed: Set<string>): number }`; `ServerPractice { manifest: PracticeManifest; files: Record<string,string> }`.
  - `loadContentStore(dir: string, hash: string): Promise<ContentStore>`; `ContentHolder { current(): ContentStore; reload(): Promise<void> }` — читает `settings.content_version`, держит `LISTEN rc_content` и перечитывает при `NOTIFY`. Если версии нет — `api` стартует, но маршруты контента отвечают 503.
  - `content:activate <hash>` проверяет наличие `server/<hash>`, пишет `settings.content_version` и `NOTIFY rc_content`.
  - `getProgress(db, store, userId, now): ProgressDto` по §5.1 (`practiceStatuses` в M3 — из `practiceAvailability`, `solved` появится в M4a).

- [ ] **Step 1: Write the failing test**: после `activate` `GET /api/content/version` → `{version, baseUrl:'/content/<version>/'}`; второй `activate` другой версии без перезапуска → новый `version` (NOTIFY); `GET /api/progress` для нового пользователя → `completedLessonIds:[]`, `dueCount:0`, `tracks` содержит `t7` с `totalLessons:50`; `getMe` возвращает ранг `sudoer` при `total_xp=1500` и всех уроках `t7` пройденными.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5: Commit** `feat(api): content store, activation, progress`.

### Task 5: Сессия урока: старт, ответ, завершение

**Files:**
- Create: `apps/api/src/services/{lessons,rewards}.ts`, `src/routes/lessons.ts`, `packages/api-contract/src/learning.ts`
- Test: `apps/api/test/lessons.test.ts`

**Interfaces:**
- Consumes: `startLesson`, `beginTasks`, `answerLessonTask`, `continueLesson`, `completeLesson`, `checkAnswer`, `lessonStatuses`, `computeRank`, `maxRank`, `toDateKey` (`@rootcamp/logic`); `ContentStore`.
- Produces:
  - `AnswerBody { taskId: string; presentation: number; answer: UserAnswer }` — поле `presentation` добавлено к §5.1 для идемпотентности §9.
  - `AnswerResponse { correct; correctAnswerText; hearts: {count, msToNext}; status: 'in_progress'|'out_of_hearts'|'completed'; nextTaskId: string|null; presentation: number; summary?: LessonSummary|ReviewSummary }`.
  - `applyXp(tx, user, { amount, source: 'lesson'|'review'|'drill'|'practice', refId, now }): Promise<{ xpToday: number; rank: Rank }>` в `rewards.ts` — вставляет `xp_events` (`day = toDateKey(now, user.tz)`), увеличивает `users.total_xp`, пересчитывает ранг через `maxRank(saved, computeRank(total, completedTracks))`. Используется уроками, повторением и практикой.
  - `startLessonSession(db, store, user, lessonId, now)`, `answerInSession(db, store, user, sessionId, body, now)` (общая точка для урока и повторения), `abandonSession(db, user, sessionId)`.
- Решения: старт = `startLesson` + `beginTasks` (теорию показывает клиент); `learning_sessions.state` хранит `{ session, lastAnswer?: {taskId, presentation, response} }`; повтор с теми же `taskId`+`presentation` возвращает `lastAnswer.response`. Ответ в закрытую/заменённую сессию → `409 session_closed`. `out_of_hearts` закрывает сессию (`status='out_of_hearts'`). Все изменения ответа — в одной транзакции с `SELECT … FOR UPDATE` сессии и `hearts`.

- [ ] **Step 1: Write the failing test** (§10.2): урок без ошибок → `xp_events.amount=15`, `streak.current=1`, урок `completed`, следующий — `current`; одна ошибка → сердечко 4, `review_items` с `box=1`, задание в конце очереди, итог `xp=10`; 5 ошибок → `status:'out_of_hearts'`, следующий старт → 403 `no_hearts`; ответ на не текущее задание → 409 `out_of_order`; смена активной версии в середине → 409 `content_changed`, сессия закрыта, XP не начислен; повтор того же `(taskId, presentation)` → идентичный ответ и `hearts` не меняется; старт заблокированного урока → 403 `locked`; старт урока в другой вкладке → ответ в старую сессию → 409 `session_closed`; пользователь `Asia/Vladivostok`, завершение в `2026-10-20T14:30Z` → `xp_events.day='2026-10-21'`.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5: Commit** `feat(api): lesson sessions`.

### Task 6: Повторение и тренировка

**Files:**
- Create: `apps/api/src/services/review.ts`, `src/routes/review.ts`
- Modify: `apps/api/src/services/lessons.ts` (`answerInSession` ветка `kind: review|drill`)
- Test: `apps/api/test/review.test.ts`

**Interfaces:**
- Consumes: `buildReviewSession`, `answerReviewTask`, `advanceReview`, `completeReview`, `dueTaskIdsInCourse`; `applyXp`.
- Produces: `startReview(db, store, user, mode: 'review'|'drill', now): Promise<{sessionId; taskIds} | null>` (null → 204). Ответ в повторении: `answerReviewTask` → `advanceReview`; при `completed` — `completeReview`, `applyXp(source = mode)`, сохранение `hearts` и `review_items` (upsert/delete по разнице).

- [ ] **Step 1: Write the failing test**: после урока с ошибкой и `clock.advance(1 день)` `POST /api/review/start {mode:'review'}` → задание с ошибкой; верный ответ → `box=2`, `due_date = today+3`; итог `xp = числу верных`, `hearts +1`; `drill` при наличии due → 204; `drill` у нового пользователя → 204; `drill` не содержит `terminal_practice` (фикстура с узлом-практикой).
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5: Commit** `feat(api): review and drill`.

### Task 7: Компоненты плеера заданий

**Files:**
- Create: `apps/web/src/player/*.tsx` (+ `.module.css`) из File Structure
- Test: `apps/web/test/player/{SingleChoice,TrueFalse,Assemble,FillBlank,MatchPairs,OrderSteps,TaskPlayer}.test.tsx`

**Interfaces:**
- Consumes: `Task`, `UserAnswer`, `isAnswerReady`, `shuffle`, `shuffleSteps`, `checkAnswer` из пакетов.
- Produces: `TaskPlayer({ task: Task; presentation: number; onSubmit(answer: UserAnswer): void; feedback: { correct: boolean; correctAnswerText: string; explanation: string } | null; onContinue(): void; rng?: () => number })`. Вид каждого типа повторяет поведение `E:\Duolingo_Docker\src\ui\tasks\*.tsx` на DOM. `OrderStepsView` — вертикальный список с `@dnd-kit/sortable` и кнопками ↑/↓ у каждого шага; `MatchPairsView` и `AssembleView` — кнопки-плитки ≥ 44 px. Клавиатура: `1–4` выбирают вариант в `single_choice`/`true_false`, `Enter` — «Проверить», затем «Продолжить». Перемешивание детерминировано ключом `presentation` (не меняется при ререндере).

- [ ] **Step 1: Write the failing test**: для каждого из 6 типов — «Проверить» неактивна, пока ответ не готов; верный ответ вызывает `onSubmit` с ожидаемым `UserAnswer`; `OrderSteps`: кнопка ↓ у первого шага меняет его со вторым, `onSubmit` получает `{type:'order_steps', order}`; клавиша `2` выбирает второй вариант, `Enter` отправляет; `FeedbackBanner` показывает `correctAnswerText` при ошибке.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5: Commit** `feat(web): task player with order_steps`.

### Task 8: Экран «Путь»

**Files:**
- Create: `apps/web/src/content/useContent.ts`, `src/screens/Path/{PathScreen,SectionBlock,LessonLayer,PracticeNodeCard,HeaderChips,RightColumn,TrackSelect}.tsx`
- Test: `apps/web/test/Path.test.tsx`

**Interfaces:**
- Consumes: `GET /api/content/version`, `/content/<v>/catalog.json`, `GET /api/progress`, `useMe`; `lessonStatuses`, `practiceAvailability`, `layerHash`, `weekBars` не нужен.
- Produces: хуки `useContentVersion()`, `useCatalog()`, `useSection(sectionId)` (TanStack Query, `staleTime: Infinity` — путь версии неизменяем); маршруты `/` (редирект на последний открытый трек из `localStorage` `rc:lastTrack`, иначе первый по `order`) и `/track/:trackId`. Разделы: пройденные свёрнуты («5 слоёв · образ собран»), текущий раскрыт, следующий заблокирован; урок `completed` — «слой <layerHash>», `current` — янтарь и «СЕЙЧАС», `locked` — пунктир. Правая колонка (≥ 1280 px): «Цель на сегодня» (`xpToday/30`), «Повторение» (`dueCount`, кнопка на `/review`). Блоки «Инцидент дня» и «Неделя» подключаются в M4a и M5.

- [ ] **Step 1: Write the failing test** (MSW-моки API): при `completedLessonIds=[t1.s01.l01]` урок `l02` помечен «СЕЙЧАС», `l03` заблокирован; шапка показывает `XP 15/30`, сердечки, серию, ранг; выбор `t7` в `TrackSelect` переходит на `/track/t7`.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5: Commit** `feat(web): path screen`.

### Task 9: Экраны «Урок» и «Повторение»

**Files:**
- Create: `apps/web/src/screens/Lesson/LessonScreen.tsx`, `src/screens/Review/ReviewScreen.tsx`, `src/screens/shared/{useLearningSession.ts,SummaryView.tsx,OutOfHeartsModal.tsx,NetBanner.tsx}`
- Test: `apps/web/test/{Lesson,Review}.test.tsx`

**Interfaces:**
- Consumes: `TaskPlayer` (Task 7), API Task 5–6.
- Produces: `useLearningSession(kind)` — состояние экрана; отправка ответа с повтором до 3 раз при сетевой ошибке (тот же `presentation`), баннер «Нет связи» с кнопкой «Повторить»; `409 content_changed` → тост «Курс обновился, урок перезапущен» и новый старт; локальный `checkAnswer` показывает баннер сразу, при расхождении с сервером баннер заменяется серверным результатом. Колонка урока ограничена `max-width: 520px`. Итог: XP, «без ошибок», цель дня, серия; `OutOfHeartsModal` с таймером `msToNextHeart`. `/review`: «Повторение (N)» или «Тренировка», если `dueCount=0`; 204 → «Пока нечего тренировать».

- [ ] **Step 1: Write the failing test**: прямой переход на `/lesson/t7.s05.l02` загружает `sections/t7.s05.json`; первый `fetch` ответа падает, второй успешен → один вызов отрисовки итога и одинаковый `presentation` в обоих запросах; ответ сервера `correct:false` при локальном `true` → баннер ошибки; `409 content_changed` → тост и повторный `POST …/start`.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5: Commit** `feat(web): lesson and review screens`.

### Task 10: E2E сценарии 2–4 и доступность

**Files:**
- Create: `e2e/helpers/answers.ts` (читает YAML `content/tracks/t1/s01/l01.yaml`, выдаёт действия для верного и неверного ответа каждого типа), `e2e/specs/{02-lesson,03-hearts,04-review}.spec.ts`, `e2e/specs/a11y.spec.ts`
- Modify: `infra/compose.e2e.yaml` (сборка контента и `content:activate` в init-сервисе перед стартом `api`)

- [ ] **Step 1: Write the failing e2e**: (2) урок `t1.s01.l01`: по одному неверному и верному ответу каждого типа, итог, XP в шапке `10/30`; (3) 5 ошибок → модалка «Сердечки кончились» с таймером; (4) после ошибки `page.clock.setSystemTime(+1 день)` → `/review` показывает «Повторение (1)», верный ответ → итог `+1 XP`, `+1 сердечко`. `a11y.spec.ts`: Путь и Урок без нарушений `serious`/`critical` (`@axe-core/playwright`).
- [ ] **Step 2:** Run `pnpm e2e` — FAIL. **Step 3:** Исправить найденное. **Step 4:** Run — PASS в `mobile` и `desktop`.
- [ ] **Step 5: Commit** `test(e2e): lesson, hearts, review, a11y`.

### Task 11: Демо вехи M3

- [ ] **Step 1:** Run `pnpm content:validate && pnpm content:build` — Expected: `0 errors`, печать `version <hash>`; T7: 10 разделов, 50 уроков, 600 заданий; T1: 1 раздел, 5 уроков.
- [ ] **Step 2:** Run `pnpm dev:up`, затем `docker compose … exec api node dist/cli.js content:activate <hash>` — Expected: `activated <hash>`.
- [ ] **Step 3:** На 390 px и 1440 px: пройти `t1.s01.l01` с одной ошибкой, увидеть итог и XP в шапке; на следующий день (или после ручного `UPDATE review_items SET due_date=current_date`) пройти повторение.
- [ ] **Step 4:** Run `pnpm test && pnpm e2e` — Expected: зелёные, сценарии 1–4 ×2 вьюпорта. Показать пользователю вывод и скриншоты.
