# The local router

Buddy reads every chat message before any model is called. What a business function can answer is answered from the records — the same tools, the same `propose()` and cards the model uses — and only what genuinely needs a model reaches it.

```
message ─► runChat (api/_lib/agent/loop.js)
             tryLocal (api/_lib/agent/local/engine.js)
               understand (understand.js) → a routing decision
                 local    read   → tool.run through the person's own client → template (render.js) + the tool's view
                          change → pipeline.propose → a card (nothing is written without a confirm)
                 clarify  one question with chips; the intent and what was understood are kept
                 llm      ↓
             gate()   the caller's metering — only now
             chatTurn the model loop, unchanged (docs/edgeai-agent.md)
```

Web chat, voice and Telegram all go through `runChat`, so they all get this. Buddy's own scheduled jobs and Daily Pulse replies are never read locally.

## The rule

A decision is `local` only when **every meaningful word of the message is accounted for** — by a concept the chosen rule uses, a period, or a record the person may see. Matching a few words is not understanding:

| What is left over | Effect |
| --- | --- |
| a word nothing explains ("sorted") | −0.30 |
| a concept the rule has no use for | −0.30 |
| a period the tool cannot filter by | −0.30 |
| a spelling correction | −0.04 each |
| a negation no phrase claims ("not overdue") | to the model, outright |

`T_LOCAL = 0.80`, `T_CLARIFY = 0.50` (understand.js). One unexplained thing lands in the clarify band ("I read that as **unpaid invoices**, but I could not place part of what you said. Is that what you meant?" — *No* hands the original message to the model). Two land with the model. Nothing is ever mapped to "the nearest" intent.

A change is recognised only by a strict sentence pattern, and only when it is not a question, not hedged ("maybe", "should we"), is one action, and is not a bulk change. If the pattern's reading does not fit the records (`propose()` finds nothing), the message goes to the model instead of a "not found".

## Files (`api/_lib/agent/local/`)

| File | What |
| --- | --- |
| `text.js` | Normalisation: contractions, filler, tokens, question/hedge/follow-up flags, timid spelling correction. |
| `lexicon.js` | Phrases → concepts (`RECEIVABLE`, `OVERDUE`, `TASK`, …), neutral words, the spelling vocabulary. |
| `periods.js` | "last month", "this week", "in August", "the past 30 days" → ISO range in the company's today. |
| `intents.js` | The intent registry: id, description, tool, parameters, renderer, escalation. Read-only / permission / risk / confirmation are read off the tool (`describeIntent`). |
| `understand.js` | The pipeline and the routing decision; `classifyRead` (rules over concepts); the change patterns. |
| `engine.js` | Executes a decision; names → records (`resolveName`); open questions and chips; the feature flag. |
| `render.js` | Templates per result, the cofounders' wording, "did you mean" names. |
| `telemetry.js` | One log line and one `buddy_route_events` row per message — no message content. |
| `evalset.js`, `evaluate.js` | The evaluation set and harness. |

Also: `money_for_period` (tools/read.js) — invoiced / money in / money out by period, a new read tool the model has too; `supabase/migrations/0074_buddy_route_events.sql`.

## The routing decision

```js
{ intent, parameters, entities, confidence, missingParameters, ambiguities,
  executionRoute,            // 'local' | 'clarify' | 'llm'
  reason, requiresConfirmation, requiredPermissions, readOnly }
```

Understanding and authorisation are separate. The decision *names* the permission (from the tool); the engine checks `registry.allowed(tool, ctx)` before running, the tool reads through the caller's token (RLS), and a change goes through `propose()` and `confirm()`, which re-check everything. Arguments that come back from a client (a tapped chip, an open question) are cleaned against the intent's declared parameters (`cleanArgs`) and re-run through the same checks.

## Follow-ups

A locally answered read emits a `route` event with a memo — intent, concepts, period, record ids; no words. The web client and the Telegram adapter send it back as `context.lastRoute` with the next message only. "What about last month?" replaces the period; "only the overdue ones" replaces the status; "and for Zephyr?" replaces the client. With no memo the same words go to the model. `cleanRoute` checks every field of a memo before it is used.

## Switch

`BUDDY_LOCAL_ROUTER` = `on` (default) · `shadow` (decide and log, the model still answers — compare before switching on) · `off`.

`AGENT_MODEL_TIMEOUT_MS` (default 45000) bounds one model call. When the model cannot be reached the turn says so and says what still works; it never invents an answer.

Metering: `api/agent.js` and the Telegram handler pass `gate` to `runChat`; it runs only when the model is about to be called, so a locally answered message is not an AI message and still works at the plan limit.

## Adding coverage

1. Add the phrasing to `evalset.js` with the route, intent and parameters a correct router gives. Run `node scripts/eval-router.js --misses` and watch it miss.
2. A new way of saying an existing thing → a phrase in `lexicon.js`. A new sentence form for a change → a pattern in `understand.js`. A new capability → a tool (docs/edgeai-agent.md), then an intent in `intents.js`, a rule in `classifyRead`, a template in `render.js`.
3. `npm test` — `eval.test.js` holds the invariants: no wrong local execution, no unconfirmed write, everything in `needs-model` reaches the model.

What to add comes from `buddy_route_summary` (0074): signatures that keep reaching the model, or keep being corrected at "did you mean…?".

## Evaluation

```
node scripts/eval-router.js            # no key, no network
```

Two datasets over the fixture company: the router's own set (318 messages in 12 categories) and the agent's eval cases (`scripts/eval-agent.cases.js`, written for the model before the router existed), run with a model that only counts its calls. `node scripts/eval-agent.js` still measures the model itself, with the router off.

## Guided actions (2026-10-13)

Some changes need several details before there is anything to confirm: a new team member, an offer letter. These are still one tool and one card. The tool lists its questions as `slots` and calls `askNext` (`../helpers.js`) at the top of `resolve()`; `propose()` turns the first open slot into a question with chips, exactly as it does for any missing field. The answer comes back as `pending` and is fed to the same tool with no model call (`engine.js`).

| Slot option | Meaning |
| --- | --- |
| `optional` | may be skipped ("skip", "no", the Skip chip); it is then `null` |
| `when(values, ctx)` | only asked when this holds (an end date for an internship; pay when the role may write it) |
| `free` | the answer is running text; the router takes it whole, however long |
| `read(raw, ctx, values)` | raw answer to `{ value }` or `{ error }`; an unreadable answer is asked again with the reason |

While a slot question is open, an answer is never taken for a lookup ("Head of finance and tasks" is a job title). Only "cancel", or a recognised change or navigation command, interrupts. Only the essentials are slots; everything else is a field on the card.

Also local since this change, each from a strict pattern: one changed detail of a client or team member (`UPDATE_CLIENT`, `UPDATE_EMPLOYEE`: the record decides the tool, and a detail that fits two records goes to the model), a note or blocker on a task, a vendor bill, deleting a draft document, a Telegram message in the words given, a reminder at a time, a scheduled check, starting and stopping a follow-through. A tool the company has not switched on (`tool.available`) is handed to the model, which explains what is missing. Commands whose remaining words are content (a message, a note, a bill) are marked `single`, so an "and" or a comma in the text is not read as a second action.

The team's day is local too: applying for, deciding and withdrawing leave ("apply for sick leave from 5th to 7th Oct", "approve Ravi's leave"), attendance ("mark Ravi absent today", "check me in", "I am working from home today"), the notice board ("announce that the office is closed on Monday") and time on a project ("log 3 hours on Acme website"). A statement about a day ahead ("Ravi is on leave tomorrow") is left as the question it may be.

So are an NDA ("create an NDA with Kite"), the catalogue ("add Logo design to the catalogue at 25k", "change the price of Support retainer to 25k"), emailing an issued document to its client ("email INV-2026-0012 to the client") and the plain details of the company profile ("change our address to …"). A sentence about bank details, GSTIN or credentials matches no pattern and goes to the model, which has no tool for them either.

## What stays with the model

Plans and goals, advice and explanation, original writing (emails, messages to teammates, posts), follow-through and reminders the patterns do not read exactly, the same change to many records, several actions in one message, profit/runway (the P&L treatments), relative date shifts ("push it back by 3 days"), anything negated in a way a filter cannot express, and anything the engine does not recognise.
