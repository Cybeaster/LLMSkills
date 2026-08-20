# Phase 1 — Choosing what to build

Order matters: **interview → search → select → present**. Searching first gets you
the same twenty ideas that every "beginner project ideas" article contains, and the
person can find those without you.

---

## 1. The interview

Ask at most five things, in one batch. Use the interactive option picker if the
environment has one — tapping is faster than typing and the answers are more honest
when the options are visible.

1. **What can you already write?** Language(s), and roughly how comfortable —
   "I've done exercises" vs "I've finished a course" vs "I've written small things".
2. **How much time, realistically?** Hours per week, and is there a deadline.
3. **What subject genuinely interests you?** Music, games, sport, finance, text,
   maps, photos, hardware, your own daily annoyances. This is the most important
   answer and the one they'll under-answer — push once if they say "anything".
4. **Does this need to impress an employer**, or is it for learning only?
5. **Any form in mind?** Command line, web page, bot, desktop, game, library,
   "surprise me".

If they answer "I don't know" to #3, ask what they've complained about in the last
month. Irritation is a better project generator than interest.

---

## 2. Difficulty rubric

Default is **Level 1**. Move up only when they ask, or when their answers to #1 make
Level 1 obviously beneath them.

| Level | Budget | Shape |
|---|---|---|
| **L1 — first project** | 10–20 h | One process. State in memory or a file. No auth, no database, no deployment, no framework they haven't met. 3–6 modules. At most **one** genuinely new concept. |
| **L2** | 25–50 h | Real persistence (SQLite/Postgres), or one external API, or a simple HTTP server / UI. Tests. Still one process. |
| **L3** | 60–120 h | Client + server, or background processing, or real deployment. Two new concepts. |
| **L4** | open | Concurrency, distribution, performance work, anything with an operational story. |

**Why L1 is so restrictive:** a first project fails from breadth, not depth. Auth,
Docker and a database each bring a whole unfamiliar world with their own errors,
and three unfamiliar worlds at once is where people quit. One new concept, learned
properly, produces someone who finished something.

Every level keeps the same non-negotiable: **it must be runnable and visible from
milestone 1**. If they can't run something and see output in the first session, the
scope is wrong.

---

## 3. Search strategy

Search — don't invent ideas from memory. What beginners build, and what tooling is
current, shifts every year, and a stale suggestion is easy to spot.

Run 3–5 searches combining their interest with their language and form. Useful
angles:

- `<domain> project ideas <language> beginner <current year>`
- `build your own <thing>` — the from-scratch tutorial genre
- `<domain> API free` — an interesting free data source often *is* the project
- `github <domain> <language> small project` — read real repos for realistic scope
- `awesome <domain>` lists — for data sources and libraries, not for ideas

Read the results critically. Article idea lists are written for volume and their
scope estimates are fantasy: "build a chat app" is presented as a beginner project
and is not one. Take the *seed* from search, then re-scope it yourself against the
rubric above.

**Do not suggest** — unless they specifically ask: to-do list, weather app,
calculator, tip calculator, blog engine, "clone of Twitter/Instagram". They're
exhausted, they teach little, and nobody, including the author, ever uses the
result. A project the person will actually run next week is worth five they'll
delete.

**Do favour** projects with a real output: something that produces a file, a
picture, a report, a sound, a number they wanted to know. Visible output is
motivating in a way that a passing test is not.

---

## 4. Presenting the candidates

Give **4–5**, numbered. Four of them at the default level, one deliberate stretch
marked as such. Each in this shape:

```markdown
### 3. Анализатор истории прослушиваний
**Что это:** программа читает выгрузку истории из музыкального сервиса и делает
из неё отчёт: топ исполнителей по месяцам, что появилось нового, что забылось.

**Почему тебе:** ты сказал, что слушаешь музыку каждый день и тебе интересно,
как меняется вкус. Данные уже есть, придумывать их не надо.

**Что нового освоишь:** чтение и разбор JSON, группировка и сортировка данных,
формирование текстового отчёта, работа с датами.

**Сложность:** L1 · ~14 часов · 5 модулей · новое понятие одно — разбор JSON

**Что НЕ входит:** ни базы данных, ни веб-интерфейса, ни авторизации в сервисе.
Файл на входе, отчёт на выходе.

**Готово, когда:** запускаешь `./listens report 2026-01` и видишь топ-10
исполнителей за январь.
```

The two fields that do the most work:

- **Что НЕ входит** — naming the cut scope up front is what stops the project from
  quietly growing back to unbuildable size.
- **Готово, когда** — a demoable sentence, not a checklist. It's what they'll aim
  at for two weeks and what tells them they're allowed to stop.

After presenting, ask which one, and offer to adjust the scope of any of them.
Wanting to mix two candidates is common and usually fine — mix, then re-cut to the
rubric.

Once chosen, confirm the language for the documentation and move to Phase 2.
