---
name: ru-style
description: "Write working text by «Пиши, сокращай» (Ильяхов, Сарычева, 2025) — reader first, then structure, then sentences and words. Use when composing or restructuring text someone reads to decide or act: a design or spec, a brainstorm's questions and options, a report, memo, status update, proposal, work email or slides; or when the user cites the book or Ильяхов. Proofreading or scoring existing Russian text belongs to a proofreading skill such as ru-text."
---

# Пиши, сокращай

The method of Максим Ильяхов and Людмила Сарычева, «Пиши, сокращай: Как создавать сильный текст» (4th ed., Альпина Паблишер, 2024; cover title «2025»), turned into a writing procedure. The book's subject is the working text: its reader is busy and motivated, wants the point, and will act on it. Every text in a brainstorm is one — the clarifying question, the options, the design, the spec.

Rules and the book's examples in `references/` are retold in our own words, next to our own examples; «с.» there is the page of the book's 4th edition (2024) that covers the rule. `NOTICE.md` says what is and is not taken from the book.

## The book's mottos

The twelve rules from the book's opening spread. Think with them while writing:

Польза, ясность, связность, чистота · Сократи и наполни · Не усложняй · Пиши о людях · Читатель сам решит · Говори прямо, формулируй по-своему · Текст о себе — не о себе · Приведи пример · Споткнулся — упрости · Где польза, там внимание · Сразу к делу · Ты нужен читателю

## Writing a new text: top-down

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

## Brainstorm texts

| Text | Shape |
|---|---|
| Clarifying question | One question per message, after one line of context. Options are phrased situation-first: «Если важнее скорость — A». A general requirement is pushed toward a measurable one the way the book questions an expert: «Как это отследить? Какая величина? А если…?» |
| 2–3 approaches | Each option is a module with the same fields in the same order: Суть / Плюсы / Минусы / Когда выбирать, the last phrased situation-first («Если важнее X — …»). Headings carry the verdict: «Б: SSE — проще, но без двусторонней связи». Past three comparison criteria, one table carries the pluses and minuses and each module keeps only Суть and Когда выбирать, so every fact appears once. It ends on the recommendation and the assumption it stands on («если X важнее Y»), then the ask from step 5. |
| Design section | The first sentence is the decision; then why; then the rejected alternative and what it would have cost. One running example goes through every section. |
| Spec | Договор с читателем on top: for whom, what it does not cover, what it builds on. Then «Основные положения» as a list, sections with the gist directly under each heading, bold only in headings, comparisons as tables and flows as diagrams. It ends with the decision you need from the reader. |

## Where a model's draft lands

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

## Boundaries

- A rule flags; the author decides. The book insists nothing is deleted mechanically: a stop word that carries meaning stays.
- Text and sentence rules hold in any language; the word lists in `word.md` are Russian.
- Proofreading or scoring an existing Russian text belongs to a proofreading skill such as `ru-text`; when one is installed, its typography rules govern Russian output.
- Copy the owner wrote stays verbatim.

## References

| File | Holds | Load when |
|---|---|---|
| `references/text.md` | reader and useful action, gathering material, structures, intros and endings, tone, depth and examples | every new text: steps 1, 2 and 5 |
| `references/working-docs.md` | reports, memos and conclusions; what the book says about machine text | a spec, design doc, report or status |
| `references/sentence.md` | people and actions, overloaded sentences, paragraphs and lists, канцелярит | step 4, and any edit of a draft |
| `references/word.md` | stop words, parentheticals, vagueness, jargon, imposed ratings, clichés — with full word lists, grouped by meaning | step 4 on Russian text |
| `references/genres.md` | text about yourself, company text, press release, cold letter, slides, landing page | that genre; slides or mockups |
