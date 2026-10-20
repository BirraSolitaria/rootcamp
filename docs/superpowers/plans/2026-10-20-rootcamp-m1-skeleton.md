# rootcamp M1 «Каркас» Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Монорепозиторий rootcamp с перенесённой механикой DockerLingo (`packages/logic`), схемой и валидатором контента (`packages/content-schema`), CI и dev-стендом, который поднимается `docker compose up`.

**Architecture:** pnpm workspaces + Turborepo, TypeScript strict ESM. `packages/logic` — чистые функции без I/O, время и пояс передаются параметрами. `packages/content-schema` — zod-схемы исходников YAML и собранных JSON, загрузчик дерева `content/`, валидатор R1–R22 и CLI `content:validate`. Стенд M1 — заглушки `api` (только `/api/health`) и `web` за Caddy плюс PostgreSQL и Mailpit; дальше вехи наполняют их.

**Tech Stack:** Node 22 LTS, pnpm 9 (corepack), Turborepo 2, TypeScript 5 (strict, ESM), Vitest 2 + @vitest/coverage-v8, zod 3, yaml 2, ESLint 9 (flat config) + Prettier 3, Docker Compose v2, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-20-rootcamp-design.md` (§3.4, §4.1–4.3, §7.1, §10.1, §10.6, §10.7). Индекс вех: `2026-10-20-rootcamp-plan-index.md`.

## Global Constraints

- Репозиторий: `E:\DevOps\rootcamp` (Windows + Docker Desktop/WSL2 для разработки; VPS Ubuntu 24.04 для M4b/M6). Все пути в плане — от корня репозитория.
- Node 22 LTS (`.nvmrc` = `22`, `engines.node: ">=22 <23"`), pnpm через corepack, TypeScript 5 strict, ESM (`"type": "module"`).
- Сборка и тесты — `turbo run build test lint typecheck`. Unit-тесты — Vitest (DockerLingo был на Jest: при переносе `jest.*` → `vi.*`, глобалы не включать, импорт из `vitest`).
- Окончания строк: `.gitattributes` с `* text=auto eol=lf` и `*.sh text eol=lf` — иначе скрипты практик сломаются в Linux-контейнерах после checkout на Windows.
- Тесты, зависящие от пояса, никогда не опираются на `TZ` процесса: явный IANA-пояс в аргументах. В CI и локально задать `TZ=UTC` в `vitest.config.ts` (`process.env.TZ = 'UTC'`), чтобы утечки локального пояса ловились.
- ID: трек `t\d{1,2}`, раздел `<трек>.s\d{2}`, урок `<раздел>.l\d{2}`, задание `<урок>.t\d{2}`, практика `inc-[a-z0-9-]{3,40}`, цель `[a-z0-9-]{2,30}`.
- Константы механики: `MAX_HEARTS=5`, `REGEN_MS=1_800_000`, `LESSON_XP=10`, `PERFECT_BONUS=5`, `DAILY_GOAL=30`, `INTERVAL={1:1,2:3,3:7}`, `REVIEW_LIMIT=10`, повторное решение практики — 10 XP.
- Покрытие строк `packages/logic` ≥ 95 %.
- Коммиты — Conventional Commits, мелкие, после каждой задачи.

## Review Focus

1. Пользователь в `Asia/Vladivostok` проходит урок в 00:30 по своему времени — XP и серия идут в его локальный день, а не в UTC-день (тест в Task 3: `toDateKey` и `grantReward` на границе суток).
2. YAML с CRLF или BOM, сохранённый в Windows-редакторе, — загрузчик читает его как обычный (тест в Task 7: фикстура с `\r\n` и BOM).
3. Автор вставил в `order_steps` два шага, отличающиеся только регистром/пробелами, — валидатор отвечает R17, а не падает плеер (тест в Task 8).
4. Перемешивание `order_steps` совпало с правильным порядком — функция перемешивает заново, а для 1 шага не зацикливается (тест в Task 4: `shuffleSteps` с rng, дающим тождественную перестановку).
5. `shellcheck` не установлен на Windows-машине — `content:validate` не падает с ENOENT, а использует docker-фолбэк или выдаёт понятную ошибку правила R18 (тест в Task 8: фейковый runner, бросающий ENOENT).

---

## File Structure

```
package.json, pnpm-workspace.yaml, turbo.json, tsconfig.base.json, eslint.config.js, .prettierrc,
.gitattributes, .nvmrc, .editorconfig, vitest.workspace.ts
packages/logic/src/{normalize,shuffle,plural,format,dates,hearts,streak,leitner,xp,reward,
                    answerCheck,courseQuery,unlock,lessonSession,reviewSession,rank,practiceReward,types,index}.ts
packages/logic/test/*.test.ts, packages/logic/test/helpers/{makeTrack,answers}.ts
packages/content-schema/src/{ids,types,source,built,load,validate,rules/*.ts,shellcheck,freshness,cli}.ts
packages/content-schema/test/**, packages/content-schema/test/fixtures/**
content/removed-ids.yaml, content/published-ids.json, sandbox/images/registry.yaml (пустой список)
apps/api (заглушка health), apps/web (заглушка Vite)
infra/compose.yaml (база), infra/compose.dev.yaml, infra/Caddyfile.dev, infra/versions.env
.github/workflows/ci.yml
```

---

### Task 1: Каркас монорепозитория

**Files:**
- Create: корневые файлы из File Structure; `packages/logic/package.json`, `packages/logic/tsconfig.json`, `packages/logic/vitest.config.ts`
- Test: `packages/logic/test/smoke.test.ts`

**Interfaces:**
- Produces: скрипты корня `pnpm build|test|lint|typecheck|format` (через turbo); пакеты именуются `@rootcamp/<name>`; каждый пакет экспортирует `src/index.ts` через `exports` (dev: исходники через `tsx`/vitest, build: `tsc -b` в `dist`).

- [ ] **Step 1:** Инициализировать git, `pnpm init`, `corepack use pnpm@9`, workspace `apps/*`, `packages/*`, `tools/*`, `e2e`. `.gitattributes`, `.nvmrc`, `.editorconfig` (LF, utf-8).
- [ ] **Step 2: Write the failing test** `smoke.test.ts`: `expect(await import('../src/index.js')).toBeDefined()`.
- [ ] **Step 3:** Run `pnpm turbo run test --filter @rootcamp/logic` — Expected: FAIL (нет `src/index.ts`).
- [ ] **Step 4:** Создать пустой `src/index.ts`, `tsconfig.base.json` (`strict`, `module: NodeNext`, `target: ES2023`, `noUncheckedIndexedAccess: true`, `verbatimModuleSyntax: true`), ESLint flat + Prettier, `turbo.json` с задачами `build`, `test` (dependsOn `^build`), `lint`, `typecheck`.
- [ ] **Step 5:** Run `pnpm test && pnpm lint && pnpm typecheck` — Expected: всё зелёное.
- [ ] **Step 6: Commit** `chore: scaffold pnpm/turbo monorepo`.

### Task 2: Типы контента в `packages/content-schema`

Переносит `src/content/types.ts` DockerLingo в zod. `packages/logic` зависит от этих типов, поэтому задача идёт раньше логики.

**Files:**
- Create: `packages/content-schema/src/ids.ts`, `src/types.ts`, `src/built.ts`, `src/index.ts`
- Test: `packages/content-schema/test/types.test.ts`

**Interfaces:**
- Produces (`@rootcamp/content-schema`):
  - `ID_RE = { track, section, lesson, task, practice, goal }: Record<string, RegExp>` (значения §4.1).
  - zod `TaskSchema` — дискриминированное объединение по `type`: `single_choice | true_false | assemble | fill_blank | match_pairs | order_steps | terminal_practice` с полями из таблицы §4.2; `type Task = z.infer<typeof TaskSchema>`; `TaskType`; `TASK_TYPES` (все 7); `INTERACTIVE_TASK_TYPES` (6, без `terminal_practice`).
  - `UserAnswer` — объединение с добавленным `{ type: 'order_steps'; order: string[] }`; `CheckResult { correct: boolean; correctAnswerText: string }`.
  - Собранные типы (§4.2): `Track`, `SectionRef`, `PathNode`, `Section`, `Lesson` (`kind: 'lesson' | 'practice'`), `TheoryCard`, `TheoryBlock`, `PracticePublic { id; title; track; brief; class; goals: {id,title}[]; hintCount; reward: {base,noHintBonus,hintCost}; timeoutMin }`, `Catalog { version: string; tracks: Track[] }`.
  - `ValidationError { path: string; rule: string; message: string; severity: 'error' | 'warning' }`.

- [ ] **Step 1: Write the failing test** `types.test.ts`: `TaskSchema.parse` принимает по одному валидному образцу каждого из 7 типов; `ID_RE.task.test('t7.s03.l02.t07') === true`, `ID_RE.lesson.test('t7.s03.l2') === false`, `ID_RE.practice.test('inc-nginx-down') === true`.
- [ ] **Step 2:** Run `pnpm --filter @rootcamp/content-schema test` — Expected: FAIL.
- [ ] **Step 3:** Реализовать схемы. Поля без ограничений длины (их проверяет валидатор с кодами правил, а не zod); zod проверяет только форму. `.strict()` на объектах, чтобы лишние поля давали ошибку (аналог R7).
- [ ] **Step 4:** Run — Expected: PASS.
- [ ] **Step 5: Commit** `feat(content-schema): zod types for tasks and built course`.

### Task 3: Базовая логика: даты с поясом, сердечки, серия, Лейтнер, XP, награда

**Files:**
- Create: `packages/logic/src/{normalize,shuffle,plural,format,dates,hearts,streak,leitner,xp,reward,types}.ts`
- Test: перенести `src/logic/__tests__/{dates,hearts,streak,leitner,xp,helpers}.test.ts` из `E:\Duolingo_Docker` в `packages/logic/test/`; новый `test/dates-tz.test.ts`, `test/boundaries.test.ts`

**Interfaces:**
- Consumes: ничего, кроме `DateKey`.
- Produces:
  - `types.ts`: `DateKey`, `Hearts {count; lastRegenAt}`, `Streak {current; best; lastActivityDate: DateKey|null}`, `LeitnerItem`, `ReviewItems`, `LessonSummary`, `ReviewSummary` (поле `dailyGoal: number`, `mode: 'review'|'drill'`). `PersistedState`, `Progress`, `Settings`, `DailyGoal` не переносятся.
  - `dates.ts`: `toDateKey(ms: number, tz: string): DateKey`, `localTimeOn(key: DateKey, hour: number, minute: number, tz: string): number`, `diffDays`, `addDays`, `isDateKey` (без изменений), `isValidTimeZone(tz: string): boolean`.
  - `hearts.ts`, `streak.ts`, `leitner.ts` — без изменений сигнатур (§7.1).
  - `xp.ts`: `LESSON_XP`, `PERFECT_BONUS`, `DAILY_GOAL = 30`, `lessonXp(mistakes)`, `goalJustReached(before, after, goal)`, `weekBars(xpByDate: Record<DateKey, number>, today: DateKey, goal: number)`. `addXp`/`xpOn` удалены.
  - `reward.ts`: `grantReward(i: { streak: Streak; xpToday: number; xp: number; today: DateKey }): RewardDelta`, где `RewardDelta { xp: number; streak: Streak; xpToday: number; goalJustReached: boolean; streakIncreased: boolean }`.
  - `format.ts`: `formatMmSs`, `weekdayLabel`, `lastNDays`, `layerHash(id: string): string` (FNV-1a из `src/ui/theme.ts` DockerLingo, без изменений).

- [ ] **Step 1: Перенести тесты** и поправить только сигнатуры: вызовы `toDateKey(ms)` → `toDateKey(ms, 'Europe/Berlin')` (в DockerLingo `TZ=Europe/Berlin` задавался в `jest.config.js`); тесты `addXp`/`xpOn` удалить; `grantReward` — новый вид входа.
- [ ] **Step 2: Write the failing test** `dates-tz.test.ts`:
  - `toDateKey(Date.UTC(2026,9,20,15,30), 'Asia/Vladivostok') === '2026-10-21'` (UTC+10).
  - `toDateKey(Date.UTC(2026,9,20,20,59), 'Europe/Moscow') === '2026-10-20'`, `…21,0` → `'2026-10-21'`.
  - DST: `localTimeOn('2026-03-08', 2, 30, 'America/New_York')` возвращает момент, для которого `toDateKey(·,'America/New_York') === '2026-03-08'` (несуществующее 02:30 сдвигается вперёд, не назад в другой день); `localTimeOn('2026-11-01', 20, 0, 'America/New_York') === Date.UTC(2026,10,2,1,0)`.
  - `isValidTimeZone('Mars/Base') === false`, `isValidTimeZone('Europe/Moscow') === true`.
  - `grantReward({streak:{current:2,best:2,lastActivityDate:'2026-10-19'}, xpToday:25, xp:15, today:'2026-10-20'})` → `{xpToday:40, goalJustReached:true, streakIncreased:true, streak.current:3}`.
- [ ] **Step 3:** Run `pnpm --filter @rootcamp/logic test` — Expected: FAIL.
- [ ] **Step 4:** Скопировать файлы из `E:\Duolingo_Docker\src\logic\` и изменить по таблице §7.1. `toDateKey` — `Intl.DateTimeFormat('en-CA', {timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit'})`. `localTimeOn` — итеративный поиск смещения: взять UTC-кандидат `Date.UTC(y,m-1,d,h,mi)`, вычислить смещение пояса в этот момент через `formatToParts`, вычесть, повторить один раз для DST. `boundaries.test.ts` переписать: запрещены импорты `react`, `node:*`, `fs`, любой I/O внутри `packages/logic/src`.
- [ ] **Step 5:** Run — Expected: PASS.
- [ ] **Step 6: Commit** `feat(logic): port dates/hearts/streak/leitner/xp with explicit tz`.

### Task 4: Проверка ответов, запросы к курсу, разблокировка

**Files:**
- Create: `packages/logic/src/{answerCheck,courseQuery,unlock}.ts`
- Test: перенести `answerCheck.test.ts`, `courseQuery.test.ts`, `unlock.test.ts`; `test/helpers/makeTrack.ts` (из `src/test-utils/makeCourse.ts`), `test/helpers/answers.ts` (`rightFor`/`wrongFor` + ветка `order_steps`)

**Interfaces:**
- Consumes: `Task`, `UserAnswer`, `CheckResult`, `Track`, `Section`, `Lesson` из Task 2; `normalize`, `shuffle` из Task 3.
- Produces:
  - `checkAnswer(task: Task, answer: UserAnswer): CheckResult`, `isAnswerReady(task, answer|null): boolean`, `correctAnswerText(task): string` (теперь экспортирована). Для `order_steps`: верно, если `order` поэлементно равен `steps`; текст — `steps.join(' → ')`; готов, когда `order.length === steps.length`. Для `terminal_practice`: `correct: false`, `isAnswerReady` → `false`.
  - `shuffleSteps(steps: string[], rng: () => number): string[]` — перемешивание с повтором, пока результат совпадает с исходным (не больше 10 попыток; при `steps.length < 2` возвращает копию).
  - `interface CourseIndex { tracks: Track[]; sections: ReadonlyMap<string, Section> }`; `findLesson(ix, id): Lesson|undefined`, `findTask(ix, id): Task|undefined`, `allTaskIds(ix): Set<string>`, `tasksOfLessons(ix, ids: string[]): Task[]` (исключает `terminal_practice`), `trackLessonIds(track: Track): string[]` (только `kind: 'lesson'`, в порядке пути).
  - `type LessonStatus = 'completed'|'current'|'locked'`; `lessonStatuses(track: Track, completed: Iterable<string>): Record<string, LessonStatus>`; `currentLessonId(track, completed): string|null`; `isTrackComplete(track, completed): boolean` (только уроки `kind: lesson`); `practiceAvailability(track, completed): Record<string /*practiceId*/, 'locked'|'available'>` — доступна, если пройден ближайший предшествующий в пути узел `kind: lesson` (по всем разделам трека; если такого нет — `available`). `pathOffset`/`SNAKE` не переносятся.

- [ ] **Step 1: Write the failing test** (добавить к перенесённым):
  - `checkAnswer(orderTask(['a','b','c']), {type:'order_steps', order:['a','b','c']}).correct === true`, порядок `['b','a','c']` → `false`, `correctAnswerText === 'a → b → c'`.
  - `checkAnswer(terminalTask, anyAnswer).correct === false`.
  - `shuffleSteps(['a','b','c'], identityRng)` ≠ `['a','b','c']` при rng, который первые 3 вызова даёт тождество, а потом нет; `shuffleSteps(['a'], rng)` → `['a']`.
  - Трек `[l01, l02, practice inc-x, practice inc-y, l03]`: при `completed=[]` обе практики `locked`, `l01` `current`; при `completed=[l01,l02]` обе `available`, `l03` `current` (практики не блокируют уроки).
  - `tasksOfLessons` не возвращает задания `terminal_practice`.
- [ ] **Step 2:** Run — Expected: FAIL.
- [ ] **Step 3:** Реализовать; `unlock.ts` идёт по `track.sections[].nodes[]` вместо `course.units[].lessons[]`.
- [ ] **Step 4:** Run — Expected: PASS.
- [ ] **Step 5: Commit** `feat(logic): answer check with order_steps, track-level unlock`.

### Task 5: Сессии урока и повторения как «дельты»

**Files:**
- Create: `packages/logic/src/{lessonSession,reviewSession}.ts`
- Test: перенести `lessonSession.test.ts`, `reviewSession.test.ts` (поправить на дельты); новый `test/sessionSerialize.test.ts`

**Interfaces:**
- Consumes: Task 3 (`regen`, `loseHeart`, `gainHeart`, `markWrong`, `markCorrectInReview`, `dueItems`, `grantReward`, `lessonXp`, `toDateKey`), Task 4 (`CourseIndex`, `tasksOfLessons`, `allTaskIds`).
- Produces:
  - `LessonSession { lessonId; queue: string[]; solved: string[]; mistakes: number; status: 'theory'|'in_progress'|'out_of_hearts'|'completed'; presentation: number }` — JSON-сериализуемо (вместо `Set`).
  - `startLesson(lesson, hearts, now)`, `beginTasks(s)`, `currentTaskId(s)`, `continueLesson(s, hearts, now)` — без изменений; `answerLessonTask(s, correct, ctx: { hearts; items; now; tz })`.
  - `completeLesson(i: { lessonId; mistakes; streak: Streak; xpToday: number; now: number; tz: string }): LessonDelta`, `LessonDelta { xp; completedLessonId; streak: Streak; summary: LessonSummary }`.
  - `ReviewMode = 'review'|'drill'`, `REVIEW_LIMIT = 10`, `ReviewSession` (как в DockerLingo), `dueTaskIdsInCourse(items, ix: CourseIndex, today)`, `buildReviewSession(mode, { items; completedLessonIds; index: CourseIndex; today; rng })`, `answerReviewTask(s, correct, items, today)`, `advanceReview(s)`.
  - `completeReview(i: { session: ReviewSession; hearts: Hearts; streak: Streak; xpToday: number; now: number; tz: string }): ReviewDelta`, `ReviewDelta { xp; hearts: Hearts; streak: Streak; summary: ReviewSummary }`. Незавершённая сессия → `xp: 0`, состояние без изменений.

- [ ] **Step 1: Write the failing test**: `JSON.parse(JSON.stringify(session))` после двух ответов равен исходной сессии (`toEqual`); `completeLesson({mistakes:0, xpToday:20, …})` → `xp:15`, `summary.goalJustReached:true`, `summary.dailyGoal:30`; `buildReviewSession('drill', …)` возвращает `null`, если есть хоть одно задание к повторению; пул `drill` не содержит `terminal_practice`; `completeReview` завершённой сессии с 7 верными → `xp:7`, `hearts.count` +1 (не выше 5).
- [ ] **Step 2:** Run — Expected: FAIL.
- [ ] **Step 3:** Реализовать по §7.1; `xpOn` заменён входным `xpToday`.
- [ ] **Step 4:** Run — Expected: PASS.
- [ ] **Step 5: Commit** `feat(logic): lesson/review sessions return deltas`.

### Task 6: Ранги и награда за практику, покрытие 95 %

**Files:**
- Create: `packages/logic/src/{rank,practiceReward,index}.ts`
- Test: `test/rank.test.ts`, `test/practiceReward.test.ts`

**Interfaces:**
- Produces:
  - `type Rank = 'guest'|'user'|'sudoer'|'root'`; `RANK_ORDER: Rank[]`; `computeRank(totalXp: number, completedTracks: number): Rank`; `maxRank(a: Rank, b: Rank): Rank`; `nextRankProgress(totalXp, completedTracks): { next: Rank|null; xpNeeded: number; tracksNeeded: number }`.
  - `PRACTICE_REPEAT_XP = 10`; `practiceXp(reward: {base; noHintBonus; hintCost}, hintsRevealed: number, firstSolve: boolean): number`.
  - `index.ts` реэкспортирует всё из Task 3–6.

- [ ] **Step 1: Write the failing test**: `computeRank(199,0)==='guest'`, `(200,0)==='user'`, `(1500,0)==='user'`, `(1500,1)==='sudoer'`, `(6000,3)==='sudoer'`, `(6000,4)==='root'`; `maxRank('sudoer','user')==='sudoer'`; `nextRankProgress(1600,0)` → `{next:'sudoer', xpNeeded:0, tracksNeeded:1}`; `practiceXp({base:40,noHintBonus:10,hintCost:5},0,true)===50`, `(…,2,true)===30`, `(…,0,false)===10`.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run `pnpm --filter @rootcamp/logic test -- --coverage` — Expected: PASS, lines ≥ 95 % (порог в `vitest.config.ts` `coverage.thresholds.lines: 95`).
- [ ] **Step 5: Commit** `feat(logic): ranks and practice reward`.

### Task 7: Загрузчик дерева `content/` и схемы исходников

**Files:**
- Create: `packages/content-schema/src/source.ts` (zod-схемы YAML: `TrackSrc`, `SectionSrc` c `nodes: ({lesson}|{practice})[]`, `LessonSrc`, `PracticeManifest`, `ImageRegistry`), `src/load.ts`
- Create: `content/removed-ids.yaml` (`ids: []`), `content/published-ids.json` (`[]`), `sandbox/images/registry.yaml` (`images: []`)
- Test: `test/load.test.ts`, `test/fixtures/mini/**` (трек `t9` из 1 раздела, 4 урока по 10 заданий, практика `inc-demo`)

**Interfaces:**
- Produces:
  - `PracticeManifest` — все поля примера §4.2 (`timeoutMin` 15–60, `setupTimeoutSec`, `goals[1..5]{id,title,check,timeoutSec=10}`, `hints[1..4]`, `reward`, `solution`, `innerImages: string[] = []`).
  - `ImageRegistry { images: { ref: string; class: 'light'|'docker'|'heavy'; cpu: number; memMb: number; pids: number }[] }`.
  - `loadContentTree(root: string, opts?: { extraRoots?: string[] }): Promise<ContentTree>`; `ContentTree { tracks: LoadedTrack[]; practices: LoadedPractice[]; removedIds: string[]; publishedIds: string[]; images: ImageRegistry; errors: ValidationError[] }`, где `LoadedTrack { file; src: TrackSrc; sections: { file; src: SectionSrc; lessons: { file; src: LessonSrc }[] }[] }`, `LoadedPractice { dir; manifest: PracticeManifest; files: Record<string /*relpath*/, string /*content*/> }`. Ошибки разбора YAML/zod попадают в `errors` с `rule: 'R7'` и путём файла, а не бросаются. `extraRoots` — дополнительные каталоги с `practices/` и `images/registry.yaml` (для e2e-фикстуры M4a).

- [ ] **Step 1: Write the failing test**: загрузка `fixtures/mini` даёт 1 трек, 4 урока, 1 практику, `errors: []`; файл урока с CRLF и BOM грузится так же; битый YAML даёт `errors[0].rule === 'R7'` и `path` с именем файла.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement (`yaml` 2, снимать BOM, `fs/promises`, пути нормализовать к `/`). **Step 4:** Run — PASS.
- [ ] **Step 5: Commit** `feat(content-schema): content tree loader`.

### Task 8: Валидатор R1–R22 и CLI `content:validate`

**Files:**
- Create: `packages/content-schema/src/validate.ts`, `src/rules/{structure,tasks,uniqueness,practices,ids,freshness}.ts`, `src/shellcheck.ts`, `src/cli.ts`
- Test: `test/validate.test.ts` (по одному минимальному нарушающему примеру на каждое правило), `test/content.test.ts` («текущий `content/` валиден»)
- Modify: корневой `package.json` — `"content:validate": "pnpm --filter @rootcamp/content-schema exec tsx src/cli.ts validate ../../content"`

**Interfaces:**
- Consumes: `ContentTree` (Task 7), `normalize`/`normalizeKey` из `@rootcamp/logic` (перенесены в Task 3 вместе с `normalize.ts`).
- Produces:
  - `validateContent(tree: ContentTree, opts: { shellcheck: ShellcheckRunner; today: string }): ValidationError[]`.
  - `type ShellcheckRunner = (files: { path: string; content: string }[]) => Promise<{ path: string; line: number; level: 'error'|'warning'|'info'|'style'; message: string }[]>`; `defaultShellcheck()` — бинарь `shellcheck` из PATH, при ENOENT — `docker run --rm -i koalaman/shellcheck:v0.10.0 -f json -` по каждому файлу; если нет и Docker — одна ошибка `R18` «shellcheck недоступен».
  - CLI: печатает `<severity> <rule> <path>: <message>`, код выхода 1 при любой ошибке, 0 при одних предупреждениях.
- Решения по обобщению правил DockerLingo (`validateCourse.ts`):
  - R1: разделы трека совпадают с `track.sections` и идут подряд `s01…`. R2: 4–6 узлов `lesson` в разделе (узлы `practice` не считаются). R3: 10–15 заданий, `id` по формату. R7: схема трека вместо `docker-ru`.
  - R13 уникальность вопросов — по всем трекам; ключ `normalizeKey` текста вопроса; для `order_steps` — `prompt + steps.join('|')`.
  - R14 (≥3 типа на урок, ни один > 50 %) — без изменений.
  - **R15 и R16** применяются только к трекам со `status: complete` (в DockerLingo они уже были в `PARTIAL_RULES`). R15 считает долю ≥ 10 % только для пяти исходных типов; `order_steps` не обязателен. R16 (40–60 уроков) остаётся только для `complete`.
  - R17–R22 — по §4.3. `status: draft` не публикуется, но валидируется. R20 сверяет все ID дерева с `publishedIds` минус `removedIds`. R21: ошибки на `docker-compose` (regex `\bdocker-compose\b(?!\.ya?ml)` в `code` и ответах), на строку `^\s*version\s*:` в блоках `code`, содержащих `services:`, на `docker-compose.yml` как имя по умолчанию; предупреждения — `reviewedAt` старше 180 дней от `opts.today`, `ingress-nginx` без «снят».

- [ ] **Step 1: Write the failing test**: таблица `[rule, mutate(fixture)]` на R1–R22 (`it.each`), ожидание `errors.some(e => e.rule === rule)`; отдельно: два `order_steps`-шага `'Нажать Enter'` и `' нажать  enter'` → R17; `ShellcheckRunner`, бросающий `ENOENT`, при пустом docker-фолбэке → ровно одна ошибка R18 «shellcheck недоступен», без исключения; R21-предупреждение не делает код выхода CLI ненулевым.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Перенести логику `validateCourse.ts` по правилам, разложив по файлам `rules/*`.
- [ ] **Step 4:** Run `pnpm --filter @rootcamp/content-schema test && pnpm content:validate` — Expected: PASS; CLI на пустом `content/` печатает `0 errors`.
- [ ] **Step 5:** Подключить husky + lint-staged: `content/**` → `pnpm content:validate`.
- [ ] **Step 6: Commit** `feat(content-schema): validator R1–R22 and content:validate`.

### Task 9: Заглушки сервисов, dev-стенд и CI

**Files:**
- Create: `apps/api/{package.json,src/server.ts,src/app.ts,Dockerfile}` (Fastify 5, только `GET /api/health` → `{db: boolean}` через `SELECT 1`), `apps/web/{package.json,vite.config.ts,index.html,src/main.tsx,Dockerfile}` (страница «rootcamp»), `infra/compose.yaml`, `infra/compose.dev.yaml`, `infra/Caddyfile.dev`, `infra/versions.env`, `.github/workflows/ci.yml`
- Test: `apps/api/test/health.test.ts` (Fastify `inject`, пул БД подменён)

**Interfaces:**
- Produces: `buildApp(deps: { db: { ping(): Promise<boolean> } }): FastifyInstance` в `apps/api/src/app.ts` (дальше M2 расширяет `deps`); сети compose `rc-public`, `rc-internal`; dev-адреса: сайт `http://localhost:8080`, Mailpit `http://localhost:8025`, Postgres `localhost:5432`.
- Решение: `compose.yaml` — общая база сервисов (postgres:16, api, caddy); `compose.dev.yaml` — overlay: Mailpit, сборка образов из исходников, Caddy с `Caddyfile.dev` на `:8080` без TLS. Запуск: `docker compose -f infra/compose.yaml -f infra/compose.dev.yaml up --build`. Корневой скрипт `pnpm dev:up` оборачивает эту команду. Production-часть (`apt-mirror`, `registry`, `dnsmasq`, `backup`, `sandboxd`) добавляется в M4b/M6.

- [ ] **Step 1: Write the failing test** `health.test.ts`: `inject GET /api/health` → 200 `{db:true}`; при `ping` → `false` ответ 503 `{db:false}`.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5:** `ci.yml`: на PR и `main` — `pnpm install --frozen-lockfile`, `pnpm lint typecheck test`, `pnpm content:validate`, `docker compose … build`. Ubuntu runner, Node 22, кэш pnpm.
- [ ] **Step 6: Commit** `feat: api/web stubs, dev compose stand, CI`.

### Task 10: Демо вехи M1

- [ ] **Step 1:** Run `pnpm install && pnpm test -- --coverage` — Expected: все пакеты зелёные, `packages/logic` lines ≥ 95 %.
- [ ] **Step 2:** Run `pnpm content:validate` — Expected: `0 errors, 0 warnings`, код 0.
- [ ] **Step 3:** Run `pnpm dev:up` (PowerShell в `E:\DevOps\rootcamp`), затем `curl http://localhost:8080/api/health` — Expected: `{"db":true}`; `http://localhost:8080/` открывает страницу «rootcamp»; `http://localhost:8025` — Mailpit.
- [ ] **Step 4:** Запушить ветку в GitHub — Expected: workflow `ci` зелёный. Показать пользователю вывод команд и ссылку на прогон CI.
