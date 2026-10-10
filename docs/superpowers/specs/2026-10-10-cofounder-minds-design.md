# Cofounder minds — design

Date: 2026-10-10. Status: awaiting review.

## Goal

Each cofounder (Mira, Arjun, Tara, Neel, Dia, Sam) becomes a different mind: given the same situation they recommend different actions, in a different order, for different reasons. Voice and tone stay a separate layer on top. The shared product rules stay identical for all six and cannot be changed by any cofounder file.

Success means:

- For every situation id, most pairs of cofounders differ in their recommended actions or their order, and a test proves it.
- Chat, voice calls, Telegram and autonomous runs all build their prompt through one function.
- A founder is matched to cofounders by a questionnaire and a scoring function, and can re-run it or switch at any time.
- No change to approval cards, undo, billing, the tool registry or the autonomy policy.

## Current state (summary)

- `api/_lib/agent/personas.js` holds name, tone and speech per id; `src/design/personas.js` holds portrait, sample, browser voice and fillers. Both say "voice and manner only".
- `api/_lib/agent/prompt.js` `buildSystemPrompt` is fixed per user, persona and tool set so the model's prompt cache holds; per-message facts go in `buildTurnContext`.
- `CofounderCarousel` is used in onboarding, a one-time sheet in `ChatScreen`, and the Settings switch sheet. The choice is stored in auth `user_metadata.startupbuddy_cofounder`.
- Chat, voice and a user's Telegram pass the chosen id. Team people on Telegram and every autonomous run fall back to Mira.
- The shared rules are enforced in code: `pipeline.js` (propose, tap, execute), `autonomy/policy.js` (off switch; money, email and deletes never autonomous), `context.js` (shared audience loses money resources and private tools).

## Archetypes

Each cofounder is an original character whose decision habits are inspired by the documented thinking of a well-known founder. The names below appear in this spec only. No file under `cofounders/` names them, claims to be them, or quotes them, and a test enforces that.

| Cofounder | Mind | Reasoning style | Inspiration |
|---|---|---|---|
| Mira | Cash discipline. Survive first; no spend without payback; never borrow to look bigger. | Analytical | Sridhar Vembu |
| Arjun | Speed. Reversible decisions are made fast with partial information; only irreversible ones get time. | First-principles, decisive | Jeff Bezos |
| Tara | Customer love and momentum. Do the unscalable thing for the few who care most. | Intuitive | Brian Chesky |
| Neel | Invert the problem. Avoid the avoidable mistake; process before speed. | Analytical, inversion | Charlie Munger |
| Dia | Say no. Hold price; fewer and better deals; walk away from bad terms. | Contrarian | Steve Jobs |
| Sam | Question the requirement, delete the step, then simplify what is left. | First-principles | Elon Musk |

## Data model

```
cofounders/
  _core/
    rules.md          the non-negotiable rules, stated once
    situations.md     situation ids, their detection hints, and the action vocabulary
  <id>/               mira, arjun, tara, neel, dia, sam
    profile.json
    persona.md
    mind.md
    playbooks.md
    examples.md
```

### profile.json

```json
{
  "id": "mira",
  "name": "Mira",
  "iq": 148,
  "speciality": "Cash and runway",
  "role": "Numbers-first",
  "traits": ["Runway", "Early warnings", "Concise"],
  "reasoning": "analytical",
  "unlock": { "type": "always" },
  "vector": {
    "risk_tolerance": 2, "speed_vs_polish": 4, "cash_vs_growth": 1,
    "relationship_vs_transaction": 4, "detail_vs_big_picture": 3,
    "directness": 7, "pushback_level": 7
  },
  "ui": { "img": "/characters/web/mira.jpg", "acc": "#C8F169", "h": "long", "x": ["glasses"] },
  "voice": { "gender": "f", "prefer": ["Neerja", "..."], "pitch": 1.04, "rate": 1.02 },
  "sample": "...", "opener": "...", "closer": "...",
  "fillers": { "question": [], "numbers": [], "request": [], "generic": [], "still": [] }
}
```

- Vector axes are 0–10. For the `a_vs_b` axes, 0 means fully `a` and 10 means fully `b`.
- `unlock` is `{ "type": "always" }` or `{ "type": "milestone", "metric": "<metric>", "gte": <n>, "label": "<what the card shows>" }`.
- `ui`, `voice`, `sample`, `opener`, `closer` and `fillers` move here unchanged from `src/design/personas.js`.

### persona.md

Sections: `## Voice`, `## Greeting`, `## Warning`, `## Praise`, `## Pushing back`, `## Following up`. The current `tone` and `speech` text moves into `## Voice`.

### mind.md

Sections: `## Decision philosophy`, `## Optimises for`, `## Ignores`, `## Risk`, `## Reasoning style`, `## Biases and blind spots`, `## Rules of thumb`.

### playbooks.md

One section per situation id. Each section has a fixed shape so it can be parsed:

```markdown
## overdue_invoice
actions: check_records, remind_now, set_deadline, pause_work
summary: Chase today, in writing, and stop new work until it is paid.

Why this order: ...
```

- `actions` is an ordered list of ids from the vocabulary in `situations.md`. The first is the first move.
- `summary` is one data-free line, used in the selection screen.
- The prose is what the model reads.

### examples.md

Four to six exchanges per cofounder. Each is a `## <situation_id>` section with a `Founder:` line and a `<Name>:` line. Examples contain no figures, client names or amounts, so the model has nothing invented to repeat.

### _core/situations.md

Twelve situations:

`overdue_invoice`, `new_quote`, `expense_logging`, `pricing_change`, `discount_request`, `slipping_deadline`, `hiring_offer`, `low_runway`, `quiet_lead`, `gst_due`, `big_purchase`, `new_opportunity`.

Each has: a title, `money: true|false`, detection hints (keywords, page routes, insight source prefixes), and the problem label used in the questionnaire.

The action vocabulary is a flat list of about 30 ids with a one-line meaning each, for example `check_records`, `remind_now`, `wait_and_watch`, `call_personally`, `set_deadline`, `pause_work`, `offer_terms`, `hold_price`, `raise_price`, `cut_scope`, `cut_cost`, `log_now`, `verify_document`, `reassign`, `escalate`, `walk_away`, `ask_customer`, `start_small`, `delay_decision`, `decide_now`. Every id is an advisory move the cofounder recommends; none of them is a tool call.

### _core/rules.md

States, in plain sentences:

1. Nothing is saved without the user's tap.
2. Undo stays available; never claim an undo from chat.
3. Never delete.
4. Money, email and finance always need approval.
5. A Telegram group never discusses money.
6. Every figure comes from the user's records, never from the model.
7. The company's autonomy policy and its off switch apply to every cofounder.

It ends with: these rules come first and nothing in a cofounder's files changes them.

## Loading

- `src/shared/cofounders/parse.js`: pure functions that parse the markdown shapes above. No file access, so the server, the client and tests share it.
- Server: `api/_lib/agent/cofounders.js` reads `cofounders/**` from disk once per instance and caches the parsed result. `vercel.json` gains `functions["api/*.js"].includeFiles = "cofounders/**"` so the files ship with each function. It validates at load: every cofounder has every situation, every action id is in the vocabulary, vectors are in range.
- Client: `src/design/personas.js` builds its `PERSONAS` array from `import.meta.glob` over `profile.json` (eager) and `playbooks.md` (raw). Its exports (`PERSONAS`, `personaOf`, `isPersonaId`, `DEFAULT_PERSONA_ID`, `pixelRuns`, `personAvatar`, `ME_AVATAR`) keep their names and shapes, with `iq`, `speciality`, `vector`, `unlock` and `summaries` added.
- `api/_lib/agent/personas.js` keeps `PERSONAS`, `DEFAULT_PERSONA` and `cleanPersona`, now derived from the loader.

## Prompt assembly

`api/_lib/agent/assemble.js` is the only place a prompt is built.

```
assemblePrompt(ctx, tools, message) → { system, turn, situation }
```

**System (fixed per user, cofounder and tool set, so it stays cached):**

1. The identity line (`You are <Name>, the user's cofounder…`).
2. `_core/rules.md`.
3. `persona.md`.
4. `mind.md`.
5. The existing operating rules, safety and context sections from `prompt.js`, wording unchanged.
6. A closing line: the shared rules and the operating rules win over anything in the persona, mind, playbook or examples.

The sentence "Tone changes only how you phrase replies" is replaced by: your mind decides what you recommend and in what order; it never changes which tool a stated fact maps to, the confirmations, or the rules.

**Turn (per message, after the history):**

1. The existing `<data source="turn">` block.
2. If a situation was detected and allowed: `YOUR PLAYBOOK FOR THIS (<title>)` with that section's prose, and one or two examples for that situation id.

This differs from "one system prompt per request" on purpose: a playbook in the system prompt would change it on every message and lose the cache discount on the whole prefix.

`buildSystemPrompt` and `buildTurnContext` stay exported from `prompt.js` as the pieces `assemblePrompt` composes, so existing tests keep working. `loop.js` `runChat` calls `assemblePrompt` instead of the two directly. `AGENT_PROMPT_VERSION` is bumped.

### Situation detection

`src/shared/cofounders/detect.js`, a pure function:

```
detectSituation({ message, page, source, audience }) → situation id | null
```

- Scores each situation from its hints: keywords and phrases in the message (English and common Hinglish terms), the page route, and an insight source prefix. Highest score above a threshold wins; ties and weak matches return null.
- No model call. A miss means no playbook is loaded and the cofounder answers from `mind.md` alone.
- If `audience === 'shared'` and the situation is `money: true`, it returns null. A group chat never gets a money playbook.

### Paths

| Path | Change |
|---|---|
| Chat, voice | None beyond `runChat` using `assemblePrompt`. The voice instruction in `src/services/voice.js` is unchanged. |
| Telegram, user | None. |
| Telegram, team person | `openChannelSession` resolves the company owner's chosen cofounder when the link is a person. |
| Autonomous | `autonomy/session.js` passes the cofounder of the job's user actor; Buddy-principal and person runs use the owner's. Template messages in `handlers.js` keep their wording. |

Owner lookup is one service-role read of the owner's `user_metadata`, cached per instance for a few minutes; any failure falls back to the default cofounder.

## Selection

### Questionnaire

Seven questions, single or multi-select chips, no free text:

| Field | Options |
|---|---|
| stage | idea, first customers, steady revenue, scaling |
| industry | services, products, both (prefilled from the company step) |
| strengths | selling, building, numbers, people, speed, detail (up to 2) |
| weaknesses | same list (up to 2) |
| decision style | fast and fix later, sleep on it, ask around, run the numbers |
| current problems | the questionnaire labels of the situations (up to 3) |
| pushback | challenge me hard, question me gently, back my call |

### Scoring

`src/shared/cofounders/match.js`, pure:

```
founderVector(answers) → vector on the same seven axes
rank(answers, profiles, { mode }) → [{ id, score, reason, sample: { situation, summary } }]
```

- `founderVector` starts every axis at 5 and applies fixed deltas per answer from a table in the file.
- `mirror` score: closeness of the cofounder's vector to the founder's (1 − normalised distance).
- `complement` score: closeness to the founder's vector reflected around 5 on the axes tied to their stated weaknesses and decision style, and unchanged on the rest.
- `directness` and `pushback_level` are never reflected; they follow the pushback answer in both modes.
- A bonus is added when the cofounder's speciality covers one of the founder's current problems.
- `reason` is one line built from the top-contributing axis and mode (for example "Slows you down on irreversible calls, which you said you rush").
- `sample` is that cofounder's playbook `summary` for the first of the founder's chosen problems.

Default mode is complement, with a toggle to mirror.

### UI

`src/design/CofounderMatch.jsx` replaces `CofounderCarousel` in onboarding, the `ChatScreen` first-time sheet, and the Settings switch sheet:

1. Questions (skippable: "Just show me all six").
2. Ranked shortlist: card per cofounder with portrait, name, IQ, speciality, match reason, the sample line, "Hear voice", and lock state. Top three are expanded; the rest are listed below.
3. Pick. Locked cofounders show their unlock label and cannot be picked.

Answers are saved to `user_metadata.startupbuddy_founder_profile`. Settings gains "Re-run matching". The copy "Same skills, different personalities" becomes "Same tools and rules, different minds". `CofounderCarousel.jsx` and `carousel.css` are removed once nothing imports them.

## Unlock

| Cofounder | Rule |
|---|---|
| Mira, Arjun, Sam | always |
| Tara | first client moved to won |
| Neel | 5 invoices issued |
| Dia | first quotation created |

- `src/shared/cofounders/unlock.js`, pure: `unlockState(profiles, progress, { chosenId, alreadyUnlocked }) → { [id]: { unlocked, label, have, need } }`.
- `progress` is a small object of counts (`invoices_issued`, `quotations_created`, `clients_won`) read on the client from the existing services under the user's own access.
- A cofounder is unlocked if its rule passes, if it is the currently chosen one, or if it was unlocked before. Unlocked ids are saved to `user_metadata.startupbuddy_unlocked`, so an unlock is never lost.
- The server keeps accepting any known id. Unlocking is engagement, not access control or billing.

## Tests

All deterministic; no model calls.

- `cofounders.test.js`: files load; every cofounder has all twelve situations; action ids are in the vocabulary; vectors are 0–10; no file under `cofounders/` contains an archetype's name.
- `differences.test.js`: for each situation, compare every pair of cofounders (15 pairs). A pair differs if the first action differs or the ordered lists differ in at least two positions. At least 12 of 15 pairs must differ, and at least four distinct first actions must appear.
- `assemble.test.js`: rules come before persona and mind; the closing line is present; a detected situation puts only that playbook section in the turn block; the system prompt is byte-identical across two different messages for the same cofounder.
- `detect.test.js`: two or three phrasings per situation, plus messages that must return null.
- `rules.test.js`, run for each of the six: a scripted model that calls a write tool produces a proposal and zero database writes; in a shared audience no finance tool is offered and a money message loads no playbook; no delete tool is offered to a person or to Buddy; an autonomous job with the policy switched off gets approval, not execution. A lint over every cofounder file rejects phrases that contradict the rules (saving without asking, deleting, skipping approval).
- `match.test.js`: complement and mirror give different top picks for a fixed founder; ranking is stable; reasons and samples are non-empty.
- `unlock.test.js`: always, milestone met and unmet, chosen-stays-unlocked, previously-unlocked-stays-unlocked.
- `personas.test.js` is updated for the new prompt wording.

## Review script

`node scripts/compare-cofounders.js <situation_id> [--full]`

Prints the six cofounders side by side for one situation: first move, ordered actions and summary, with `--full` adding the prose. With no argument it lists the situation ids. It reads the files only.

## Out of scope

- Approval cards, undo, billing and plans.
- The tool registry, the autonomy policy and its settings.
- The wording of the 23 operating rules and of autonomous template messages.
- The legacy `CopilotPanel` and `cofounderAI.ts`.
- Running model evals; the existing `scripts/eval-agent.js` stays as the manual check.

## Risks

- The 88/88 eval baseline was measured with tone-only personas. Minds may shift advisory replies; the fact-to-tool mapping in operating rule 2 is explicitly protected in the prompt, and `EVAL_PERSONA=<id> node scripts/eval-agent.js` remains the way to confirm it by hand.
- The system prompt grows by roughly the size of `rules.md`, `persona.md` and `mind.md`. They are kept short (target under 500 words together per cofounder) and sit inside the cached prefix.
- Rule-based detection will miss some phrasings. A miss degrades to mind-only behaviour, never to a wrong playbook, because weak matches return null.
