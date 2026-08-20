# Phase 3 — Scaffolding

Build the skeleton: a git repository, folders, files, types, signatures, doc
comments, failing tests, per-folder instructions. No bodies.

**The skeleton must compile.** Test-driven scaffolding only works if the tests run
and fail with a real assertion — `ожидалось 3, получено 0` is a specification the
person can chase, while `undefined: ParseLine` is just a broken repo. So: real
module setup, real imports, stubs that satisfy the compiler, tests that build.

Finish by committing the scaffold, running the suite in front of them so they see
red, and saying which file to open first.

---

## 0. Git, before anything else

Run `git init` before creating a single file, then commit the finished scaffold as
one baseline commit.

```bash
git init                      # skip if .git already exists — never reinitialize
# ... create the scaffold ...
git add -A
git commit -m "Scaffold: structure, contracts and failing tests"
```

The baseline commit isn't bookkeeping — it's the mechanism that makes the rest
work:

- **`git diff` against it is exactly what the person wrote.** Reviews become
  precise: you look at their work, not at your own scaffold mixed in with it.
- **It's an escape hatch.** A beginner who has broken everything and doesn't know
  how can get back to a known-good state. Knowing that retreat exists is what makes
  them brave enough to try things.
- **It teaches the habit at the only moment it's free.** Nobody adopts version
  control in the middle of a mess.

Write a language-appropriate `.gitignore` **before** the first commit — build
output, dependency directories, virtualenvs, editor folders, `.env`. A beginner who
commits `node_modules` once has a bad afternoon; getting this right costs you three
lines.

Don't commit for them after the baseline. Commits are theirs — see §7 below.

---

## 1. Stub conventions

Bodies do the minimum to compile and to fail loudly if called.

| Language | Stub body |
|---|---|
| Go | `panic("not implemented")` — or return zero values + `errors.New("not implemented")` where the signature allows |
| Python | `raise NotImplementedError` |
| TypeScript / JS | `throw new Error("not implemented")` |
| Rust | `todo!()` |
| Java / Kotlin | `throw new UnsupportedOperationException()` |
| C++ | `throw std::logic_error("not implemented");` |
| C# | `throw new NotImplementedException();` |

Do not write a partial implementation "to get them started". Half a function is
harder to finish than none — they have to reverse-engineer someone else's half
before they can write their own.

---

## 2. The doc comment is the specification

Every function they'll implement carries a comment, in their language, stating:

- **what it does** — one sentence
- **what it guarantees** — the postcondition, in prose
- **what it rejects** — invalid input and what happens then

```go
// ParseEntry разбирает одну строку истории и превращает её в Entry.
//
// Гарантирует: у результата всегда заполнены Artist и PlayedAt.
// Отвергает: пустую строку и строку без даты — возвращает ошибку,
// не паникует. Лишние пробелы по краям игнорируются.
func ParseEntry(line string) (Entry, error) {
	panic("not implemented")
}
```

Prose, not pseudocode. Pseudocode is the answer written in a funny font; a
contract is a description of the destination that leaves the route to them.

Data structures get a comment per field explaining what it means and its
invariants — those invariants come straight from §4 of the design doc.

---

## 3. Tests as the spec

The tests are where the design doc becomes executable. Rules:

- **Name tests after the behaviour**, not the function: `TestEntryWithoutDateIsRejected`,
  not `TestParseEntry3`. When it goes red at 2am, the name should say what broke.
- **Cover the happy path and the edge cases named in §7 of the design doc.** Those
  sections were written for this.
- **Table-driven** where the language supports it — it shows them a pattern worth
  copying, and it makes adding a case trivial.
- **Real, readable fixture data.** A test with actual song titles in it explains the
  format better than three paragraphs of description.
- **One assertion concept per test.** A test that checks five things reports one
  failure and hides four.
- Leave a short comment above each test group pointing back to the design doc
  section it came from.

Don't scaffold tests for every milestone at once. Tests for milestone 1 and 2 are
enough — fifty red tests on day one reads as an impossible mountain. Add the rest
as milestones open.

---

## 4. Folder README

Every folder that contains code gets `README.md` in their language:

```markdown
# internal/parser

## Что здесь живёт
Всё, что превращает сырой файл выгрузки в структуры данных. Ничего про отчёты
и ничего про вывод на экран — только разбор.

## Почему это отдельная папка
Форматов выгрузки будет два, а отчёт не должен знать, из какого файла пришли
данные. Здесь граница: наружу отсюда выходят только готовые Entry.

## Что реализовать и в каком порядке
1. `entry.go` — структура Entry. Начни отсюда: пока её нет, остальное не о чем.
2. `lexer.go` — `SplitFields`. Самая маленькая функция, на ней проще всего
   разобраться, как гонять тесты.
3. `parser.go` — `ParseEntry`, потом `ParseFile`. ParseFile использует ParseEntry.

## Сюда не надо класть
Форматирование отчёта, работу с файлами на диске, любой вывод в консоль.

## Готово, когда
`go test ./internal/parser/...` зелёный, включая тесты на битые строки.
```

Instructions live in the folder README; contracts live in the code comments. Don't
also litter the code with `// TODO: implement this` — it duplicates what the stub
already says and makes the file look unfinished in a way that discourages.

---

## 5. Root README

Short. What the project is (one paragraph from design doc §1), how to run it, how
to run the tests, a pointer to `docs/DESIGN.md` and `PROGRESS.md`, and the single
sentence: which file to open first.

Include a short «Как сохранять работу» section with the three commands they
actually need — `git status`, `git add -A`, `git commit -m "..."` — and one line on
when to use them. Assume they've never used git. Most people who have just finished
a language course haven't, and a first project is the right place to start, because
the stakes are zero.

---

## 6. PROGRESS.md

Created at the end of Phase 3, in their language. This is what makes mentoring work
across sessions — without it, every session restarts from nothing.

```markdown
# Прогресс

**Проект:** Анализатор истории прослушиваний
**Этап:** 2 из 5 — Разбор файла
**Обновлено:** 2026-08-20

## Этапы
- [x] 1. Каркас и чтение файла — готово 14.08
- [ ] 2. Разбор строк в Entry ← сейчас здесь
  - [x] `parser.SplitFields`
  - [ ] `parser.ParseEntry` ← следующее
  - [ ] `parser.ParseFile`
- [ ] 3. Группировка по месяцам
- [ ] 4. Формирование отчёта
- [ ] 5. Аргументы командной строки

## Решения по ходу
- 14.08 — договорились, что битые строки пропускаем и считаем, а не падаем.
  Причина: в реальной выгрузке всегда есть мусор.

## Застревали здесь
- 18.08 — ParseEntry возвращал пустую дату. Оказалось, слой разбора получал
  строку уже без префикса. Вывод: проверять, что приходит на вход, раньше,
  чем что уходит на выход.

## Идеи на потом
- Второй формат выгрузки
- Графики вместо текстового отчёта
```

**Rules for keeping it:**

- Check a box only when the tests for it are green. A checked box that isn't done
  destroys the value of the file.
- Update at the end of any session where something changed.
- `Застревали здесь` is the most valuable section — it records the *reasoning*, so
  the next session doesn't re-derive it, and it shows the person a visible record of
  problems they solved. Beginners chronically underestimate their own progress and
  this is the antidote.
- Scope-creep ideas go under `Идеи на потом` immediately, so the urge has somewhere
  to go that isn't the code.
- Never rewrite history. Append.

---

## 7. Commits are theirs

After the baseline, don't commit on their behalf. The habit only forms if they do
it, and a mentor who silently commits their work removes both the practice and the
sense of ownership.

What to do instead:

- **Suggest a commit whenever a milestone goes green.** "Тесты зелёные — самое
  время закоммитить, это точка, к которой можно вернуться." Green tests are the
  natural commit boundary and connect the two habits at once.
- **Message convention: English, imperative, one line.** `Add entry parser`, not
  `добавил парсер` and not `fixes`. It's what they'll meet on every team.
- **Don't teach branching yet.** On a solo first project it's ceremony without
  benefit, and every extra concept is scope that competes with finishing. If they
  ask, explain it; otherwise `main` is fine.
- **If they haven't committed in several sessions, say so.** Uncommitted work is
  the thing that gets lost, and losing a week of a first project is often where
  people stop.
