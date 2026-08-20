# Phase 2 — The design doc

Write `docs/DESIGN.md` in the user's language. Target 1200–2000 words. It must be
readable and comprehensible *before* any code exists — that's the whole point:
they read it, they understand the shape of the thing, and only then do they start
filling it in.

**No implementation code.** Type sketches and signatures are fine — a body is not.
If the doc contains the solution, the project is over before it starts.

**Approval gate:** show the doc, ask what they'd change, and wait. People who
approve a design they understood build it; people handed a design they didn't read
stall at milestone 2.

---

## Template

Ten sections, this order. The Russian headings below are the default; translate if
they chose another language.

### 1. Что мы строим (120–180 слов)
What it does, in language a non-programmer understands. Ends with the single
sentence that defines done — the same «готово, когда» from the candidate card.

### 2. Как этим пользуются (150–250 слов)
Two or three concrete scenarios, written as a person doing a thing: what they
type, what they see, what they do next. Real values, not `foo` and `bar`. This is
what makes the abstraction below feel like it's for something.

### 3. Из чего состоит (200–300 слов)
Every module: its name, what it's responsible for, and — the important part — **why
it is separate from the others**. A beginner's default is one big file, so each
boundary needs a reason they can feel: "разбор входного файла отделён, потому что
форматов будет два, а отчёт от этого зависеть не должен".

Include a simple text diagram of the flow between modules.

### 4. Данные (150–250 слов)
The two to four core structures. For each: what one instance represents in the real
world, its fields with types, and what each field is for. State the invariants in
prose — "список всегда отсортирован по дате", "поле не бывает пустым". Those
sentences become the tests in Phase 3.

### 5. Как проходит основной сценарий (200–350 слов)
The main path, step by step, module by module: what comes in, what each step does,
what it hands to the next. Numbered. This is the map they'll navigate by for the
whole project.

### 6. Ключевые решения (3–5 решений, по 60–100 слов)
The decisions that shape the project, each in three beats:
- **Решили:** what we're doing
- **Могли бы:** the real alternative
- **Почему так:** the reason, in terms of this project's constraints

This is the most educational section in the document. A beginner who has read five
honest trade-offs has learned something no tutorial teaches — that these are
choices, made by people, for reasons, and that they could have gone the other way.

### 7. Что может пойти не так (150–250 слов)
The failure cases they must handle: empty input, malformed data, a missing file,
a value out of range, duplicates, a number that doesn't fit. For each, what the
program should do — because "падать с непонятной ошибкой" is a decision too, and an
explicit one is better than an accidental one.

These become the edge-case tests in Phase 3.

### 8. План по этапам (4–6 этапов)
Each milestone: name, what works when it's done, which modules it touches, rough
hours. **Milestone 1 must produce something runnable** — even if it only prints the
parsed input. Seeing your own program do something on day one is what buys the
motivation for the rest.

Order milestones so each one is demoable. Never plan a milestone whose output is
"the data layer is finished".

### 9. Чего мы НЕ делаем (80–150 слов)
Explicit non-goals, with a one-line reason each. Keep the "if there's time later"
ideas here too, so that when the urge to add them strikes at milestone 3 there's
somewhere to put it that isn't the code.

### 10. Что понадобится узнать (по этапам)
Per milestone: what they'll need to learn, with a link to the official
documentation. Not a course — the specific page. "Этап 2: чтение JSON —
`encoding/json`, раздел Unmarshal."

---

## Style rules

- Every technical term gets explained the first time it appears. If the explanation
  needs another unexplained term, rewrite it.
- Write to the person who will build it, not about the project. "Ты получишь на
  вход файл…" reads better and lands better than "Система принимает на вход…".
- Keep English terms in parentheses on first use — «разбор (parsing)» — because
  every error message and doc page they'll meet is in English.
- No estimates you can't defend. If you don't know how long something takes, say
  the range.
