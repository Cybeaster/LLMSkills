---
name: explain-this-project
description: Explains an unfamiliar codebase to a reader who does not know software architecture — what the project is, why it is built the way it is, every principle explained from zero, and an ordered list of what to learn in order to build something similar. Produces one self-contained HTML file (Russian by default) where every technical term has a tap/hover tooltip. Use this whenever someone opens a repository they don't understand and asks what this project is, how it works, why it's structured this way, what its architecture is, how the pieces fit together, where to start reading, or what they'd need to learn to build it — and also for any onboarding, walkthrough, or "explain this codebase" request. Trigger on Russian phrasings too — «объясни этот проект», «что это за проект», «разбери архитектуру», «объясни как это работает», «с чего начать в этом репозитории», «что нужно выучить, чтобы написать такое». Use it even when the user just says "explain this repo" without mentioning architecture, docs, or HTML.
---

# Explain This Project

Turn an unfamiliar repository into one document a beginner can actually read.

The reader is assumed to be a person who can run `git clone` and not much more.
They have never heard of a gateway, a message queue, or dependency injection.
They are not stupid — they are *new*. Everything is explained from the ground up,
and nothing is assumed.

## What gets produced

One self-contained HTML file, ~3–5 pages of reading (roughly 1500–2200 words),
six sections, no external dependencies, every technical term carrying a tooltip
the reader taps or hovers to reveal.

**Defaults: HTML, Russian.** Only switch if the user asks for English or Markdown.
Don't stop to ask — produce the default and mention at the end that it can be
regenerated in the other language or as `.md`.

If the user asks for Markdown instead, keep the same six sections and the same
word budgets, but replace tooltips with a `**Термин** — определение` list at the
end of each section (Markdown has no tooltips).

## Step 1 — Recon, without reading everything

Reading every file wastes the context window and produces vaguer output, not
sharper output. Read in this order and stop when the picture is clear:

1. **Manifests** — `package.json`, `go.mod`, `Cargo.toml`, `pyproject.toml`,
   `pom.xml`, `build.gradle`, `composer.json`, `Gemfile`, `mix.exs`, `*.csproj`.
   Dependencies tell you the architecture faster than the source does.
2. **README, `docs/`, `ADR/`, `CHANGELOG`** — the authors' own words about intent.
3. **Deployment and infra** — `docker-compose.yml`, `Dockerfile`, `k8s/`, `helm/`,
   `Makefile`, `.github/workflows/`, `Procfile`, `terraform/`. For a multi-service
   project this is the single most informative file set: it lists the parts.
4. **Directory tree, depth 2–3.** `git ls-files | head -300` beats a recursive
   listing that drowns in `node_modules`.
5. **Entry points** — `main.*`, `cmd/`, `index.*`, `app.*`, `src/main.*`,
   `wsgi.py`, `Program.cs`, route files, `App.tsx`.
6. **Config and env** — `.env.example`, `config/`, `settings.*`. External
   dependencies (database, cache, broker, third-party APIs) show up here.
7. **A few tests.** Tests state what the authors believed the system promises.

Read `references/archetypes.md` for the concrete signals that separate one kind
of project from another and for the recon commands worth running.

## Step 2 — Name the archetype

Decide which kind of thing this is before writing anything: multi-service backend,
single-service backend, frontend SPA, server-rendered app, full-stack monorepo,
library/SDK, CLI, mobile app, data pipeline.

This decides which principles are worth explaining. Retries and idempotency
matter in a distributed backend and are noise in a static site; render cycles and
state management matter in a frontend and are noise in a CLI. `references/archetypes.md`
lists what each archetype's document should focus on.

If the repo is a monorepo containing several archetypes, pick the one the user
opened it for — or, absent a signal, the largest by file count — and say so
explicitly in section 1.

## Step 3 — Trace one action end to end

Pick the single most representative user-visible action — a signup, a checkout,
a search, a page load, one CLI invocation — and follow it from the outside world
to storage and back. Name the actual files it passes through.

This is the most valuable section in the document. It's the difference between
"this project has a service layer" (meaningless to a beginner) and "when you press
Buy, the request lands *here*, gets checked *here*, writes to the database *here*,
and sends an event *here*". A newcomer who can follow one path through a repo can
find the second one alone.

Verify the path by actually opening the files. A traced path with a wrong file
name is worse than no trace at all — the reader will open it, find nothing, and
stop trusting the whole document.

## Step 4 — Extract the principles that are actually there

**Evidence rule: name a principle only if you can point at the file, folder, or
config that demonstrates it.** Otherwise the document becomes a generic
architecture lecture that happens to sit next to a repo, and the reader learns
nothing about *this* code.

Aim for 4–7 principles — the ones that explain most of the layout. `references/principles.md`
holds ready-made from-zero explanations for the ~25 principles that come up most
often; use them as raw material and adapt each one to what this repo actually does.

Each principle is presented in four beats:

- **Что это** — an everyday analogy, no software vocabulary.
- **Зачем** — the problem it solves, stated as a problem a beginner can feel.
- **Где в проекте** — the concrete path that proves it.
- **Чем платим** — what it costs. Every principle has a downside. Omitting it
  teaches cargo cult: the reader copies the pattern into a to-do app and wonders
  why everything got harder.

## Step 5 — Build the learning path

An ordered list of 8–14 things the reader would need to learn to build something
like this, ordered by dependency, not by importance.

Each item states **why it comes at this point** — "you need this before that,
because…". A bare list of topics is something the reader could have googled; the
ordering and the reasons are the actual gift.

Split into two groups: what's genuinely required to build a working version of
this, and what this specific project adds on top (scale, compliance, team size).
A beginner needs to know that Kubernetes is not a prerequisite for understanding
HTTP.

Anchor each item to something in this repo — "you'll see this in `internal/queue/`" —
so the learning path and the code stay welded together.

## Step 6 — Render

Copy `assets/template.html` and fill it in. Its comments explain every CSS class,
the tooltip markup, and how to build the map of parts. Do not fetch anything from
a CDN — the file must open from disk with no network.

Write the file to the outputs directory and present it. Then, in chat, give a
3–4 sentence summary of what the project turned out to be. Don't restate the
document.

## Document structure

Always these six sections, in this order, with these budgets. The budgets are what
keep it at one screen per section; without them this drifts into a 30-page wall
nobody reads.

| # | Section (RU) | Contains | Budget |
|---|---|---|---|
| 1 | Что это за проект | What it does, who uses it, what problem it solves, what it is *not* | 120–180 words, zero jargon |
| 2 | Из чего он состоит | The map of parts + one line per part: what it does and why it exists separately | 200–300 words + map |
| 3 | Как проходит один запрос | One action traced end to end, with real file paths | 250–400 words, 5–9 steps |
| 4 | Почему построено именно так | 4–7 principles, four beats each | 60–90 words per principle |
| 5 | Что здесь может пойти не так | The 3–4 real failure modes this design defends against | 120–200 words |
| 6 | Что нужно выучить | Ordered learning path, two groups | 8–14 items, 1–2 lines each |

Section 5 exists because architecture is mostly a response to failure. A reader
who knows that services fail independently, that networks drop messages, and that
two users can press the same button at the same moment understands *why* the rest
of the document looks the way it does. Keep it concrete to this project.

## How to explain

**No definition may contain an undefined term.** This is the rule that gets broken
most. "Идемпотентность — свойство операции, при котором повторный вызов не меняет
состояние системы" replaces one unknown word with three. Write instead: "Можно
нажать кнопку дважды, и второй раз ничего не сломает — как кнопка вызова лифта."

**Analogies come from ordinary life**, not from other software. Post office,
restaurant kitchen, warehouse, receptionist, checklist, spare key. Never "it's
like Redis, but…".

**Keep the English term.** In Russian output, give the English name in parentheses
on first use — «шлюз (API Gateway)» — because every doc, error message, and search
result the reader will ever meet is in English. Stripping it out leaves them unable
to look anything up.

**Tooltip on first mention only.** The same word tooltipped eleven times reads like
a machine wrote it. Tooltip text: 1–2 sentences, under 220 characters, no jargon
inside it.

**Never write "как известно", "очевидно", "просто", "as you know".** If it were
obvious the reader wouldn't be here, and these phrases teach them to feel stupid
instead of curious.

## Honesty

Say what you couldn't determine. "Не удалось понять, как сервис X получает
конфигурацию — в репозитории нет ни примера `.env`, ни документации" is useful;
a confident guess is a trap the reader will walk into.

Never invent a file path, a service name, or a dependency. Everything named in the
document must exist in the repo — the reader *will* check.

When the code contradicts the README, say so and trust the code. Stale READMEs are
normal, and noticing the gap is itself a lesson worth teaching.

## Bundled files

- `assets/template.html` — the HTML shell: styles, tooltip mechanism, map
  components, print styles. Read it before writing output.
- `references/principles.md` — from-zero explanations for ~25 recurring
  architecture principles, with the analogy, the cost, and where each shows up in
  a repo. Read it at Step 4.
- `references/archetypes.md` — recon commands, the signals that identify each
  archetype, and what that archetype's document should emphasize. Read it at
  Steps 1–2.
