---
name: ru-style
description: "Write, check, fix and score Russian text — typography, grammar, punctuation and style — by «Пиши, сокращай» (Ильяхов, Сарычева) and the ru-text rule set. Use when composing or restructuring text someone reads to decide or act: a design or spec, a brainstorm's questions and options, a report, memo, status update, proposal, work email or slides; when asked to proofread or fix Russian text (вычитай, проверь текст, поправь, отредактируй, причеши); when a score is wanted (оцени текст); when the user cites the book or Ильяхов; and silently for typography on any Russian output."
---

# ru-style

One skill for Russian text. It writes working text by the method of «Пиши, сокращай» (Максим Ильяхов, Людмила Сарычева, 4-е изд., Альпина Паблишер, 2024), and it checks, fixes and scores Russian text against a full rule set: typography, grammar, punctuation, style and the patterns of machine-written prose. The typography, grammar, punctuation, AI-text, UX and business-writing material comes from ru-text by Arseniy Kamyshev (MIT); `references/sources.md` credits both. «с.» in the references is the page of the book's 4th edition that covers a rule.

## Always on: typography

Apply to all Russian output, silently: fix, don't announce. A person's explicit style request (casual, academic, SEO, literary) overrides these defaults where they conflict.

| Rule | Wrong | Correct |
|---|---|---|
| Primary quotes: guillemets | "текст" | «текст» |
| Nested quotes: lapki | «"вложенные"» | «„вложенные“» |
| Em dash, NBSP before it | слово - слово | слово — слово |
| En dash for ranges, no spaces | 10-15 дней | 10–15 дней |
| NBSP after single-letter words | в начале (breakable) | в\u00A0начале |
| Ellipsis: single character | ... | … |
| Digit groups with thin spaces | 1000000 | 1 000 000 |
| Decimal comma (not dot) | 3.14 | 3,14 |
| Ordinal with hyphen | 1ый, 2ой | 1-й, 2-й |
| Numero sign | No. 5, #5 | № 5 |
| Abbreviations with NBSP | т.д., т.е. | т. д., т. е. |
| Ruble sign after number, NBSP | 1500₽ | 1 500 ₽ |
| Percent glued (non-GOST) | 100 % | 100% |

Dashes: at most 1–2 per paragraph — a parallel row counts as one, dialogue dashes as none; trim to the limit, not to zero. Full rules: `references/typography.md`.

In a file, non-breaking spaces follow Fix's rule: insert them only when the person asked for typesetting or the format keeps them.

## Modes

Pick one mode per request. One combination is allowed: Write, then self-review of the draft before it goes out.

| The request | Mode |
|---|---|
| Compose a text, or rewrite or restructure a given text into a new one | Write |
| Your own draft before it goes out — after Write, or any Russian reply | Self-review (in Check): triage depth, fixes applied silently, no report |
| A person asks to have a text checked: «вычитай», «проверь текст», a gate that names this skill | Check |
| A request to edit a given text: «поправь», «отредактируй», «причеши», "fix the text in <file>" | Fix |
| «оцени текст», a number is wanted | Score |

### Write

#### The book's mottos

The twelve rules from the book's opening spread. Think with them while writing:

Польза, ясность, связность, чистота · Сократи и наполни · Не усложняй · Пиши о людях · Читатель сам решит · Говори прямо, формулируй по-своему · Текст о себе — не о себе · Приведи пример · Споткнулся — упрости · Где польза, там внимание · Сразу к делу · Ты нужен читателю

#### Writing a new text: top-down

Work in this order; each step ends on its criterion.

1. **Полезное действие.** Name the reader and what they will decide or do after reading. Done when one line holds both: «Читатель — <кто>; прочитав, он <решит / сделает что>». A mixed audience means picking one group or writing two texts.
2. **Структура.** Choose the form by what the text is (table below) and write the headings. Done when the headings plus the first sentence under each tell the whole content to someone who reads nothing else.
3. **Абзацы.** One paragraph, one thought. Each paragraph — or each labelled line of a module — opens with its point, worded to make sense without what comes before it; the reason follows the point (сначала суть, потом причина). The claims a decision rests on carry an example from the reader's world — this repo, this product, this team; in a chat message, one such fact per option or section is enough.
4. **Предложения и слова.** An edit pass with `references/sentence.md`, then `references/word.md` for Russian text. Done when every sentence names who acts and reads in one breath, and every flagged word was cut, replaced by a fact, or kept for a reason you can state.
5. **Финал.** The last lines say what the reader must do now — answer, choose, approve — or say plainly that nothing is needed.

An existing draft is edited bottom-up: words and sentences, then paragraphs, then structure. When the draft has no useful action at all, return to step 1 and rewrite instead.

| The text is | Form | Reference |
|---|---|---|
| Report, status, investigation result | результат первым → текущая ситуация → хронология → следующие шаги | `working-docs.md` |
| Spec, design doc, memo | рабочий документ; its shape is the Spec row under Brainstorm texts | `working-docs.md` |
| 2–3 options to choose from | подборка: equal modules, then a завершающий аккорд with the recommendation | `text.md` «Подборка и рейтинг», «Завершающий аккорд» |
| A recommendation to argue | пирамидальное доказательство: thesis and the list of arguments first, then each argument with an example and a counter-example | `text.md` «Рассуждение» |
| Plan, instruction, migration | хронология выполнения: an overview of phases and every precondition before the steps that need it | `text.md` «Инструкция» |
| Slides or a visual mockup | слайд — капсула смысла: a heading that states the conclusion, one visual centre | `genres.md` «Слайды» |
| About yourself, a company, press release, cold letter, landing page | the genre's schema | `genres.md` |

#### Brainstorm texts

| Text | Shape |
|---|---|
| Clarifying question | One question per message, after one line of context. Options are phrased situation-first: «Если важнее скорость — A». A general requirement is pushed toward a measurable one the way the book questions an expert: «Как это отследить? Какая величина? А если…?» |
| 2–3 approaches | Each option is a module with the same fields in the same order: Суть / Плюсы / Минусы / Когда выбирать, the last phrased situation-first («Если важнее X — …»). Headings carry the verdict: «Б: SSE — проще, но без двусторонней связи». Past three comparison criteria, one table carries the pluses and minuses and each module keeps only Суть and Когда выбирать, so every fact appears once. It ends on the recommendation and the assumption it stands on («если X важнее Y»), then the ask from step 5. |
| Design section | The first sentence is the decision; then why; then the rejected alternative and what it would have cost. One running example goes through every section. |
| Spec | Договор с читателем on top: for whom, what it does not cover, what it builds on. Then «Основные положения» as a list, sections with the gist directly under each heading, bold only in headings, comparisons as tables and flows as diagrams. It ends with the decision you need from the reader. |

#### Where a model's draft lands

The book's last chapter describes machine text as a term paper compiled from everything already written on the topic: averaged, general, missing the author's experience. Your first draft starts there. Each pattern below is a rule from the book; check the draft for all of them.

| Pattern | Fix | Rule |
|---|---|---|
| Ratings instead of facts: «надёжное», «элегантное», «критически важно» | the number, the mechanism, the scenario | `word.md` «Навязанные оценки», «Оценки при постановке задачи» |
| Synonym triples, «не только…, но и…», «Вот что…» before a list | one word; name the count; drop the bridge | `sentence.md` «Однородные члены», «Парные союзы», «Вот что» |
| Everything as bullets | a list item the length of a paragraph becomes a paragraph | `sentence.md` «Беда: всё превратилось в перечень» |
| Bold in the middle of paragraphs | the thought moves to the paragraph's start or into a heading | `working-docs.md` «Выделение жирным» |
| Enthusiastic or ingratiating tone: «Отличный вопрос!» | neutral, as an equal | `text.md` «Шесть тональностей» |
| General advice | an example from this project, plus an антипример | `text.md` «Багаж и глубина» |
| «Очевидно, что», «как известно» | the source and the fact, or nothing | `word.md` «Общеизвестное» |

The Fix column is enough to apply each row; open the cited rule only when a case is unclear.

### Check

Check reports; it never edits the analysed text or file. It is for text a person asks to have checked. It runs at one of two depths, chosen by these rules, not by preference. When the host can run a subagent, run a full Check or a Score in one and return only the report — the full rule set is large (~300k characters) and does not belong in the caller's context.

**Self-review** — your own draft before it goes out: after Write, or before any Russian reply. Check it at triage depth, escalating by triage's rules; fix the draft silently and append no report. It is the one path that edits, because the text is yours.

**Full** — whenever a person asked for the check, a gate names this skill, or triage escalated. An explicit request is never answered with triage. Read, in order:

1. Typography — `typography.md`: quotes, dashes, spaces (non-breaking after single-letter words, in digit groups, before units; `%` glued to its number), ellipsis, abbreviations, special characters. Check spaces by codepoint, not by eye.
2. Quick table — `anti-patterns.md`: bureaucratese and nominalization, passive voice, sentence bloat, tautology and pleonasm.
3. Words and sentences — `word.md` (stop words, vagueness, jargon, ratings, clichés, numbers) and `sentence.md` (who acts, overloaded sentences, paragraphs and lists, bureaucratese).
4. Text — `text.md`, plus `working-docs.md` for a spec, report or memo: reader and useful action, structure, intro and ending, tone, depth.
5. Grammar and punctuation, always — `editorial-grammar.md` (capitalization, agreement, pleonasm, lists, numbers in text) and `editorial-punctuation.md` (commas, dashes and colons in complex sentences).
6. Domain, when the text type is clear — interface text: `ux-writing.md`; email, messenger, meeting notes: `business-writing.md`; a genre: `genres.md`.
7. Machine-written prose — `ai-text.md`: the «Neuroslop index», then the AD rules with their carve-outs. AD-14 and AD-15 are charged to the document as a whole, not to a sentence.

**Triage** — only for a self-initiated check of your own or found text when no instruction names this skill. An instruction names it when it asks to check or proofread a text («вычитай», «проверь»); a standing instruction to use this skill for all Russian text does not. No search tool on this host → no triage: run the full check. Load four things: this SKILL.md; the «Neuroslop index» section of `ai-text.md`; the `word.md` entries «Стоп-слова», «Вводные конструкции», «Неопределённое», «Общеизвестное», «Навязанные оценки», «Усилитель», «Рекламные штампы», «Паразиты времени», «Заумные слова»; the «Примеры канцелярита» entry of `sentence.md`. Report only what one line decides: typography and confirmed catalogue hits; judge inflected forms yourself («данные» the noun is not «данный»). A neuroslop tell is never a triage finding — it is a reason to escalate. Escalate to full, silently, when a neuroslop candidate appears, five findings are confirmed, or the text is a deliverable the person will publish or send on (a document, a post, a letter); a chat reply is not one. A triage report names itself: «Быстрая проверка: типографика и стоп-слова. Полная вычитка не выполнялась.»

**Output:** the corrected text; then the changes grouped by category (typography / style / grammar / domain), each with its severity (critical / high / medium / low) and the rule behind it (file and section).

### Fix

Run Check at full depth, then apply the corrections to the text or file the person named, and to nothing else. Report the change list in Check's format. Quotations, code blocks and third-party text inside the document stay as they are; report an issue there if it matters. Insert non-breaking spaces into a file only when the person asked for typesetting or the file's format keeps them; otherwise list them as findings — a target that strips them shows no change, and an inserted one breaks exact-string search on that file.

### Score

Read-only, like Check, and run in a subagent the same way when the host can.

1. Read `scoring.md` for the rubric and its anchors.
2. Identify the domain: interface text adds `ux-writing.md`, business email adds `business-writing.md` to the reader-precision dimension.
3. Score each dimension 0.0–10.0, quoting 1–3 fragments: Т типографика (0.15; `typography.md`), Ч чистота языка (0.25; `word.md`, `sentence.md`, `anti-patterns.md`), Г грамотность (0.20; `editorial-grammar.md`, `editorial-punctuation.md`), С структура (0.20; `text.md`, `ai-text.md`), Ц точность для читателя (0.20; the domain file). If a dimension has no issues, write «Замечаний нет».
4. Caps: any dimension below 3.0 → total at most 5.0; typography or grammar below 4.0 → total at most 7.0; the strictest cap wins.
5. S = round₁(Т×0.15 + Ч×0.25 + Г×0.20 + С×0.20 + Ц×0.20). Under 50 words, open with a reliability caveat.
6. Report exactly in the shape of `scoring.md` «Output format».

## Boundaries

- A rule flags; the author decides. A stop word that carries meaning stays.
- On typography, grammar and punctuation the ru-text material decides; on composition — what to say, in what order, with which sentence and word — the book's material decides.
- Someone else's words stay theirs: quotations, code and third-party text are reproduced as is.
- Text and sentence rules hold in any language; the word lists, typography and grammar rules are Russian.
- Copy the owner wrote stays verbatim.

## References

| File | Holds | Load when |
|---|---|---|
| `references/text.md` | reader and useful action, gathering material, structures, intros and endings, tone, depth, register | Write steps 1, 2, 5; Check step 4 |
| `references/working-docs.md` | reports, memos, specs; machine-written text; newsroom workflow | a spec, design doc, report or status |
| `references/sentence.md` | who acts, overloaded sentences, paragraphs and lists, bureaucratese | Write step 4; Check step 3 |
| `references/word.md` | the stop-word catalogue, vagueness, jargon, ratings, clichés, numbers and facts | Write step 4 on Russian text; Check step 3; triage |
| `references/genres.md` | text about yourself, company text, press release, cold letter, slides, landing page | that genre |
| `references/typography.md` | quotes, dashes, spaces, ellipsis, numbers and dates | Check step 1; any typesetting question |
| `references/anti-patterns.md` | the wrong → right quick table | Check step 2 |
| `references/editorial-grammar.md` | capitalization, agreement, pleonasm, lists, numbers in text | Check step 5; Score Г |
| `references/editorial-punctuation.md` | commas, dashes and colons in complex sentences | Check step 5; Score Г |
| `references/ux-writing.md` | buttons, errors, empty states, hints, notifications, forms | interface text |
| `references/business-writing.md` | email, messenger, tone, meeting notes, saying no | business correspondence |
| `references/ai-text.md` | the neuroslop index and AD-1…AD-18 | Check step 7; triage |
| `references/scoring.md` | the 0–10 rubric and its report shape | Score |
| `references/sources.md` | credits | — |
