# Eight moods and how one is chosen

Date: 2026-10-12. Status: implemented. Builds on `2026-10-10-cofounder-minds-design.md`, whose "Mood" section this replaces.

## Goal

The cofounder has eight faces instead of four. The server picks one per turn from what the founder asked and what the answer turned out to be, so the face is right without depending on the model, strong faces stay rare, and the face never flickers between extremes. Asking for revenue and getting zero looks disappointed; asking for expenses and getting zero looks happy.

## The moods

`MOODS` in `src/shared/cofounders/parse.js` becomes, in this order:

| Mood | Meaning | Tier | Default tag |
|---|---|---|---|
| neutral | An ordinary answer; the resting face | calm | Here you go |
| thinking | The reply is loading, or the cofounder is asking something | calm | Needs info |
| explaining | Teaching, advising, walking through numbers | calm | Here's how |
| happy | Good news | warm | Good news |
| serious | Something is at risk and can still be fixed | warm | Needs attention |
| surprised | Something is out of the usual pattern, good or bad | peak | Unexpected |
| disappointed | Something failed, or is already lost | peak | Didn't work |
| laughing | A big win, or the founder is joking | peak | Big win |

The old four are retired: `warning` → `serious`, `win` → `happy`, `celebrate` → `laughing`. `thinking` keeps its name.

`disappointed` is never aimed at the founder. It fires for the cofounder's own failures, for things already lost and for a figure that came back empty when it should not be (no revenue, no leads), never for cancelling a card or ignoring advice.

## The ladder

`decideMood` in `src/shared/cofounders/mood.js` walks these steps at the end of a turn. The first match wins. Each result carries `by`, the step that decided it.

| # | Condition | Mood | Tag | `by` |
|---|---|---|---|---|
| 1 | The turn failed | disappointed | Didn't work | `failure` |
| 2 | A detail or a choice was asked for | thinking | the situation's tag (`missing_info` / `quick_pick`) | `question` |
| 3 | A card was carried out and its tool belongs to a situation | that situation's mood | that situation's tag | `outcome` |
| 4 | A card is waiting for a tap | the situation's mood if one applies; else `serious` when the card's risk is not `low`; else `neutral` | situation's tag / Check this / Ready for you | `outcome` |
| 5 | The turn was started by an insight that matches a situation | that situation's mood | that situation's tag | `source` |
| 6 | The answer's figures give a verdict (see "Reading the answer") | the verdict's mood | the verdict's tag | `reading` |
| 7 | The founder's words match a situation | that situation's mood | that situation's tag | `keywords` |
| 8 | A cue is in the founder's message | the cue's mood | Good one / Here's how / Here you go | `cue` |
| 9 | The model suggested a mood it is allowed to suggest | that mood | the mood's default tag | `model` |
| 10 | A view was shown, or the reply has a list of two or more steps | explaining | Take a look / Here's how | `shape` |
| 11 | Nothing above | neutral | Here you go | `default` |

Step 6 sits above step 7 on purpose: figures outrank words. "Any overdue invoices?" matches the `overdue_invoice` keywords, but when the answer is that nothing is overdue the face is `happy`, not `serious`. The situation's playbook is still loaded for the model as before; only the mood changes.

Definitions:

- **The turn failed** (step 1): a card ended with status `failed`; or the turn was stopped by a notice that carries no offer (a refused role, "could not prepare that"); or the last tool result of the turn was an error. A notice that carries an offer ("nothing matched, shall I create it?") is not a failure.
- **Allowed model suggestions** (step 9): `neutral`, `happy`, `explaining`, `serious`. A suggestion of `thinking` or of any peak mood is ignored and the ladder continues to step 10.
- **A list of steps** (step 10): two or more lines in the reply that start with `1.`, `2.`, `-` or `•`.

Steps 1 to 4 and 6 read the turn's outcome, which `trackTurn` in `api/_lib/agent/loop.js` already collects. It gains four fields: `failed` (boolean), `viewed` (a `view` event was emitted), `readings` (below) and, on each card, `risk`.

## Reading the answer

The mood follows the figures the answer is built on, judged against what the founder asked about.

**Readings.** A read tool may return `reading` next to `data` and `view`: a list of `{ metric, value, previous? }` with plain numbers, computed in the tool from the same rows as its view. The loop adds them to the turn's `readings` wherever it registers the tool's view, so a turn answered by the local router and a turn answered by the model are read the same way. When two tools report one metric, the later one wins.

| Tool | Readings |
|---|---|
| `money_for_period` | `money_in`, `invoiced`, `money_out`, `net`; the first three with `previous` |
| `finance_summary` | `net`, `overdue`, `payables` |
| `list_invoices` | `overdue` (the overdue amount in the result) |
| `list_bills` | `payables` |
| `list_tasks` | `open_tasks`, `overdue_tasks` |
| `list_clients` | `pipeline` (leads, contacted and deals, when the pipeline was asked for) |

`previous` is the same figure for the window of equal length that ends the day before `from`; `money_for_period` already loads the rows it needs. `finance_summary` reports `payables` only when it computes the figures live. Tools about people (attendance, leave, team pulse) return no readings: people are never judged by a face.

**Metrics.** A new `# Metrics` section in `situations.md` names each metric, its kind and the phrases that mean the founder is asking about it:

```
# Metrics
- money_in: gain, money; revenue, sales, income, money in, earned, earning, earnings, collected, came in, received, kamai, kitna aaya
- invoiced: gain, money; invoiced, billed, billing
- pipeline: gain; leads, lead, pipeline, prospects, deals in
- net: balance, money; net, profit, cash flow, net cash, bacha
- money_out: cost, money; expense, expenses, spend, spent, spending, costs, cost, money out, kharcha
- payables: cost, money; we owe, vendor bills, payable, payables, bills to pay
- overdue_tasks: problem; overdue, late, behind, overdue tasks, late tasks
- open_tasks: cost; pending, open tasks, to do, left to do, pending tasks
- overdue: problem, money; overdue, late payment, unpaid, baki
```

`money` marks a metric that is never read in a shared space. "overdue" names both the task metric and the invoice metric; whichever the answer has a figure for is the focus.

**Focus.** The focus is the first metric, in file order, that has a phrase in the founder's message and a reading in the turn. Its verdict:

| Kind | Value | Mood | Tag |
|---|---|---|---|
| gain | zero | disappointed | Nothing yet |
| gain | down a quarter or more on `previous` | serious | Down |
| gain | up a quarter or more on `previous`, or `previous` was zero | happy | Up |
| gain | anything else | neutral | Here you go |
| balance | below zero | serious | In the red |
| balance | above zero | happy | In the green |
| balance | zero | neutral | Here you go |
| cost | zero | happy | All clear |
| cost | up a quarter or more on `previous` | serious | Up |
| cost | down a quarter or more on `previous` | happy | Down |
| cost | anything else | neutral | Here you go |
| problem | zero | happy | All clear |
| problem | above zero | serious | Needs attention |

Rows are checked top to bottom within a kind. A row that needs `previous` is skipped when the reading has none.

**No focus.** When the message names no metric that came back ("how is the money?"), the readings are judged together: any `problem` above zero or `balance` below zero → `serious`, "Needs attention"; otherwise a `balance` above zero → `happy`, "In the green"; otherwise no verdict, and the ladder continues.

**Empty books are still read.** Revenue at zero is `disappointed` and expenses at zero is `happy` even when nothing at all is recorded: that is the behaviour asked for, and a new company sees it on its first questions. (An earlier draft kept empty books `neutral`.)

**A cost that starts from nothing** (`previous` is zero) is `neutral`, not "Up".

**Shared spaces.** In a Telegram group, readings of money metrics are dropped, as money situations are.

`readMood(message, readings, metrics, audience)` in a new `src/shared/cofounders/reading.js` returns `{ mood, tag, metric }` or null. It is pure, like `detect.js`.

## Situations

`cofounders/_core/situations.md`, new `mood` and `tag` values:

| Situation | Mood | Tag |
|---|---|---|
| overdue_invoice, low_runway, slipping_deadline, gst_due | serious | Needs attention |
| unusual_spend | surprised | Unusual |
| record_high | surprised | New record |
| payment_received, task_done | happy | Good news |
| missing_info, quick_pick | thinking | Needs info |
| discount_request, hiring_decision | thinking | Your call |
| deal_won, milestone | laughing | Big win |
| deal_lost (new) | disappointed | Lost one |

`deal_lost`: title "A deal was lost", `money: true`, keywords `lost the deal, deal lost, we lost, went with someone else, went with another, rejected the quote, declined the quote, backed out, cancelled the order, pulled out, deal cancel ho gaya, mana kar diya`, source `insight:deal_lost`. `situationOfTurn` maps a `move_client_stage` card whose stage is `lost` to it, next to the existing `deal`/`won` rule. Each cofounder gets a playbook (actions from the existing vocabulary, e.g. `ask_customer`, `look_at_data`, `fix_root_cause`), following the existing content rules. No example was added: each cofounder already has the six examples the tests allow.

## Cues

Cues set a mood from the founder's words when no situation matched. They have no playbook. They live in a new `# Cues` section at the end of `situations.md`, one line per cue, checked in file order:

```
# Cues
- laughing: haha, hahaha, hehe, lol, lmao, rofl, 😂, 🤣, just kidding
- explaining: how do i, how do we, how to, how should, how does, why is, why are, why did, why does, explain, what does, what should, walk me through, difference between, help me understand, kaise, kyun, samjhao
- neutral: thanks, thank you, thx, shukriya, hello, hi, hey, good morning, good evening, namaste
```

`parseSituations` returns them as `cues: [{ mood, phrases }]`. `detectCue(message, cues)` in `detect.js` uses the same normalisation as keyword matching and returns the first cue with a matching phrase, or null. "how" alone is deliberately not a phrase, so "how much does Acme owe me" stays a plain lookup.

## Smoothing

1. **Peak moods need a rule.** Only steps 1 to 8 can produce `surprised`, `disappointed` or `laughing`.
2. **No repeated peak from words alone.** The app sends the mood of the exchange it is replacing as `prev_mood` in the chat request. When the new mood is a peak, equals `prev_mood`, and `by` is `keywords` or `cue`, it steps down: `laughing` → `happy`, `surprised` → `explaining`, `disappointed` → `serious`. The tag is kept. Moods decided by `failure`, `outcome`, `source` or `reading` are never stepped down. A channel that sends no `prev_mood` (Telegram) gets no step-down.
3. **Changes pass through `thinking`.** While a reply streams the stage shows `thinking`, so the face goes A → thinking → B. No extra work; `stageFor` already does this.

## The model's marker

Rule 24 in `api/_lib/agent/prompt.js` offers only the four allowed suggestions: `[[mood:neutral]]` for an ordinary answer, `[[mood:happy]]` for good news, `[[mood:explaining]]` for advice or a walkthrough, `[[mood:serious]]` for a risk or bad news. `takeMood` still strips any marker.

## The screen

`src/chat/stage.js`:

- streaming → `thinking`, tag "Thinking".
- empty, brief needs attention → `serious`, "Needs attention"; otherwise `neutral`, "Ask me anything".
- no mood stored → `neutral`, "For you".
- a stored mood passes through `legacyMood` first.

`legacyMood` in `mood.js` maps a stored exchange to the new names: `warning` → `serious`, `celebrate` → `laughing`, `win` → `happy`, except the old defaults (`win` with tag "Here you go", `thinking` with tag "Thinking it through"), which become `neutral`.

Other callers: `CallHost.jsx` uses `happy` where it used `win`; `MovedNotice.jsx` and `CofounderChooser.jsx` use `laughing` where they used `celebrate`; `faceUrl` defaults to `neutral`.

## Headline words

`## Headlines` in each `persona.md`; `validate` requires all eight.

| Mood | Steve | Elon | Mark |
|---|---|---|---|
| neutral | Here it is. | Here's the data. | Here's where we are. |
| thinking | Why? | First principles. | Let's test it. |
| explaining | Here's the thing. | Physics first. | Look at the data. |
| happy | Insanely great. | Good. Next. | It's working. |
| serious | Not good enough. | Fix it. Now. | This is a problem. |
| surprised | Wait. What? | That's wild. | Didn't expect that. |
| disappointed | That's not it. | Back to the pad. | We missed. |
| laughing | Real artists ship. | Liftoff! | Ship it! |

These are short lines in each founder's manner, not quotations.

## Art

- Source sheets: `docs/art-sources/cofounder-moods/{steve,elon,mark}.png`, a 4 × 2 grid in the order neutral, happy, thinking, explaining / surprised, serious, disappointed, laughing, each pose with a label under it.
- Cut each pose with a script kept outside the repo (it needs `sharp`, which is not a dependency): without its label, white background removed, to `src/design/art/stickers/<id>/<mood>.webp` at 400 × 464 with the body on the bottom edge, and `<mood>-face.webp` at 160 × 160, at one scale per cofounder. The eight old files per cofounder are deleted.
- `AVATAR_MOODS` and `BG_MOODS` follow `MOODS`.
- Backgrounds (`backgrounds.js`): `serious`, `happy`, `thinking`, `laughing` keep the palettes and scenes of `warning`, `win`, `thinking`, `celebrate`. Four new palettes and scenes: `neutral` (soft slate blue, quiet), `explaining` (teal), `surprised` (hot orange with rays), `disappointed` (dusk grey-violet, no rays). Each cofounder's motif gets a setting for the new moods (Elon's rocket: grounded for `disappointed`, mid-climb for `explaining`).
- `/dev/cofounders` shows all eight.

## Tests

- `cofounders.test.js`: the expected mood of every situation; one case per ladder step, in order, including that an earlier step beats a later one; the model gate (a suggested `laughing` or `thinking` is ignored); step-down for `keywords` and `cue`, none for `outcome` or `source`, none without `prev_mood`; `legacyMood`; `detectCue` (including "how much" matching nothing); `readMood`, one case per row of the verdict table, plus no focus, empty books, a shared space, and a reading beating a keyword situation ("any overdue invoices?" with none overdue is `happy`); all eight headlines per cofounder; a `deal_lost` playbook and example per cofounder.
- `loop.test.js`: a failed card ends the turn `disappointed`; an overdue insight ends it `serious`; "revenue this month" with nothing received ends it `disappointed`, and "expenses this month" with nothing spent ends it `happy`.
- `cofounders.test.js` also checks that `money_for_period` reports `previous` for the window of equal length before the period.
- `art.test.js`: a sticker, a face and a background for every cofounder × mood.
- `exchange.test.jsx`: a stored old-name mood renders under its new name.

## Out of scope

- Escalating a repeated warning to `disappointed`.
- Sending stickers on Telegram.
- Animated transitions between faces.
