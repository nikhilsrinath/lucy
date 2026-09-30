# EdgeAI agent

EdgeAI operates the app on the user's behalf. It reads freely, and it **proposes** every change as a card; the change happens only when the user taps the card's button. This document covers how it works and how to add a tool.

## The flow

```
message ─► POST /api/agent {mode:'chat'}  (SSE)
             context: user, role, permissions (my_permissions), plan, today in the org's
             timezone, the page, recentEntities, EdgeBrain facts as <data>
             model (Gemini, OpenAI-compatible, function calling) ⇄ tools, ≤ 8 steps
               read / navigate tool → runs now, result goes back to the model as <data>
               write tool          → resolve → validate → preview → ai_actions (proposed)
                                     → card to the client; the turn ends
tap ─────► POST /api/agent {mode:'confirm', action_id, selected?, edits?}
             reload the action (must be the caller's, still proposed, < 30 min old)
             re-check permission + plan, re-resolve + re-validate against current data
             stale? (target updated_at moved) → a fresh card instead of a write
             proposed → confirmed (one conditional UPDATE = idempotent)
             plan → applied through the USER's JWT, header x-edgeos-agent-action
             → executed / failed, before/after stored; "Done." + follow-up
undo ────► POST /api/agent {mode:'undo'}   within 10 minutes, only if the rows are unchanged
```

Other modes: `cancel`, `status` (latest state of cards in a reopened thread).

## Rules that hold everywhere

- **The agent is the user.** Every read and write uses a Supabase client built from the caller's access token (`api/_lib/agent/db.js`). RLS, the permission matrix and every `app.*` guard apply exactly as in the UI. The service role touches only `ai_actions` and the AI meter. (EdgeBrain retrieval keeps its existing permission-filtered path.)
- **The model proposes; code decides.** The model chooses a tool and passes words ("2nd October", "1.2 lakh", "the pricing one"). Resolvers turn words into ids, `src/shared/dates.js` and `src/shared/cashIntent.js` turn them into dates and amounts, validators refuse bad changes, and risk is set in the registry.
- **Nothing is written without a tap.** Write tools have no `run()`; they return a plan that only `confirm()` applies. `loop.test.js` asserts this for every write tool, and the eval harness counts writes.
- **Never a guess.** Two plausible records → a choice card (≤ 5). None → "I looked for X and found none" (with "create it" where it makes sense). A missing required field → one question with chips.
- **Retrieved text is data.** Record content, notes and EdgeBrain context reach the model inside `<data>` blocks; the prompt says they are never instructions.
- **Limits:** 8 tool steps per turn, 25 items per batch, 5 pending cards per chat, proposals expire after 30 minutes.

## Files

| Path | What |
| --- | --- |
| `api/agent.js` | The endpoint (all modes). Registered in `vite.config.js` for dev. |
| `api/_lib/agent/registry.js` | The catalogue, permission/plan filter, invariants (`registryProblems`). |
| `api/_lib/agent/tools/*.js` | Tools by module: `read`, `navigate`, `tasks`, `clients`, `cash`, `finance`. |
| `api/_lib/agent/resolvers.js` | Names → records (`resolveEntity`, `rankCandidates`, `KINDS`). |
| `api/_lib/agent/pipeline.js` | `propose`, `confirm`, `cancel`, `undo`. |
| `api/_lib/agent/executor.js` | Applies a plan as the user; optimistic concurrency; `undoPlan`. |
| `api/_lib/agent/loop.js` | One turn: model ⇄ tools, SSE events, chip resumes, typed answers. |
| `api/_lib/agent/prompt.js` | System prompt, `AGENT_PROMPT_VERSION` (stored on every action). |
| `api/_lib/agent/actions.js` | `ai_actions` persistence (service role), `toCard`. |
| `src/shared/` | Isomorphic code both sides use: `dates.js`, `cashIntent.js`, `financeTaxonomy.js`, `finDocs.js` (document rows, totals, company snapshot, receivables), `documentConversion.js`, `documentLifecycle.js`, `proformaAdvance.js`. Imports only `./x.js` siblings (enforced by `sharedBoundary.test.js`); the old `src/services/` paths re-export them. |
| `src/components/assistant/` | `AssistantContext` (turns, cards, chips), `ActionCard`, `DisambiguationCard`, `FollowUpChips`. |
| `supabase/migrations/0068_ai_actions.sql` | `ai_actions`, its permission rows, and `audit_log.via / ai_action_id`. |
| `scripts/eval-agent.js` | Evals against the real model. |

## The tools

| Module | Low risk (one-tap card, Undo 10 min) | High risk (detailed card, named button) |
| --- | --- | --- |
| Read / navigate | `search`, `get_record`, `list_tasks`, `list_invoices`, `list_bills`, `list_leave`, `get_attendance`, `finance_summary`, `ask_brain`, `open_page`, `open_record` — run at once, no card | |
| Tasks | `create_task`, `update_task`, `complete_task`, `reopen_task` | `delete_task` |
| Clients / CRM | `create_client`, `update_client`, `move_client_stage`, `add_client_note` | `delete_client` |
| Finance | `create_invoice_draft`, `create_quotation_draft`, `create_proforma_draft`, `convert_quotation` | `create_cash_entry`, `record_payment`, `mark_invoice_paid`, `issue_document`, `create_vendor`, `create_purchase_bill`, `cancel_financial_document`, `delete_financial_document` |

Finance notes:

- **Drafts are exactly what the forms save.** The row is `finDocToRow` and the lines `lineItemRows` (both in `src/shared/finDocs.js`, also used by `orgStore`); the number comes from `next_document_number`; totals are computed by the database, and the card's figures come from `documentTotals`, which follows `app.recompute_document_totals` exactly (pinned by the same fixture in `finance.test.js` and `supabase/tests/14_document_totals_test.sql`). Defaults are the org's own: its usual GST rate, this client's last payment terms and terms text.
- **Plan limits** (`invoices`, `quotations`) are checked against `usage_counters`, as `usePlanStatus` does in the form.
- **Invoices are never deleted.** Undoing an invoice draft cancels it (its number stays in the GST series); a quotation or proforma draft nobody has seen is deleted. Cancel and delete follow `documentLifecycle.js`, the rules the invoice list applies, including putting a converted source back.
- **Issuing does not email.** `issue_document` moves a draft to `sent` (quotations and proformas take version 1 and lock); sending by email or portal comes in Phase 4. Status writes carry the stored payload untouched (plus `converted_to`, an exempt response key), so the version guard (0064) never sees a content change.
- **Payments** are recorded as confirmed (`confirmed_at`, `confirmed_by`), like "Mark paid" in the list; the database moves the document to paid / partially paid. More than the balance is refused.
- **Purchase bills** take the amount as said: "85k incl GST" backs out the subtotal at the vendor's last GST rate; the card shows the total the database will store.
- **Cards** for documents show the lines and the CGST/SGST or IGST split; an invoice opens as the real `InvoicePreview` (scaled into the card by `DocPaper.jsx`), open by default when issuing.

## Buddy as an operator (2026-09-30)

Buddy is one action system reached from every surface. `api/_lib/agent/buddy.js` is the only entry point: `openSession`, `chat`, `resume`, `confirm`, `cancel`, `undo`, `retry`, `status`, `insights`, `activity`. `api/agent.js` (web chat and voice) is a thin HTTP adapter over it; a Telegram or email adapter would authenticate its person, call `openSession({ …, channel: 'telegram' })` and render the same events and cards its own way — no second prompt, tool set, approval flow or audit trail.

```
                 ┌──────────── channels (adapters) ────────────┐
                 │ web chat · voice call · "Buddy noticed" tap │  · telegram (docs/telegram.md) · later: email
                 └──────────────────────┬──────────────────────┘
                                buddy.js (sessions, modes)
          ┌──────────────┬──────────────┼───────────────┬───────────────┐
      loop.js        pipeline.js     plans.js       insights.js      actions.js
   model ⇄ tools   propose/confirm   multi-step     rules over the   ai_actions log:
   views, events   undo/retry        plans          company's rows   lifecycle, audit
          └──────── registry.js: every tool (read · write · navigate · plan) ────────┘
                         executor.js: plans applied as the user (RLS), email op
```

**Three kinds of request.**

| Kind | What happens | Examples |
| --- | --- | --- |
| Read | Runs at once through the user's token; answer + optional view | "How much cash do we have?", "Who owes us money?", "What happened this week?" |
| Draft / write (low risk) | A card: review, edit, Confirm; Undo for 10 minutes | tasks, clients, notes, projects, invoice/quote drafts |
| Sensitive (high risk) | A detailed card with the exact output and a named button; often no Undo | money, deletes, issuing, **sending a payment reminder email** |
| Plan | One card with several low-risk steps; untick/edit, Approve once | "We launch in two weeks", "Collect all overdue payments" |

**Lifecycle.** Every action (and plan) is an `ai_actions` row. Status column as in 0068 (`proposed → confirmed → executed | failed`, `cancelled`, `expired`, `undone`); 0069 adds a timeline in `events` — `proposed, edited, approved, executing, completed | partial | failed, cancelled, undone, retried` — plus `kind` (action | plan), `channel`, `reason` (Buddy's why), `source` (e.g. the insight that prompted it), `edits`, `approval_required`, `parent_id` (retry of). Business rows written by a confirmed action carry `audit_log.via = 'edgeai'` and the action id. The API tolerates a database without 0069 (it logs without the new columns).

**Never "done" without the database.** The client says "Done." only after `confirm` returns `executed`; a plan's summary counts steps that the executor reported as written. Failures keep their reason, the card offers **Try again** (a fresh, re-checked proposal via `retry`), and a partly-done plan offers **Retry failed steps**.

**Plans** (`plans.js`, tool `propose_plan`). Steps are calls to ordinary low-risk write tools (`PLANNABLE`). At proposal every step runs its tool's `resolve → validate → preview`; any ambiguity or missing detail sends the whole plan back to the model to ask one question — a plan is never shown with a guess in it. A step may refer to something an earlier step creates (a task in the new project): a placeholder row (`tool.virtual()`) stands in until approval, when the real id is swapped in. At approval each ticked step is re-resolved against current data and applied through the executor; a failed step does not stop independent steps, dependants are skipped. Undo reverses executed steps newest first. Sending, money and deletes are never plan steps.

**Views** (`views.js`). Read tools return a `view` (metrics, list, timeline, insights) built from their own result; the model shows one by writing `[[show:v2]]`. Figures on a view are always the tool's, never the model's.

**Insights** (`insights.js`). Rules, no model: overdue invoices by client (with last reminder), deadlines by tomorrow, overdue tasks by owner, tasks whose deadline slipped 2+ times in 45 days (audit log), at-risk / off-track projects (`project_portfolio` health), leads quiet for 14+ days, quotes waiting 7+ days, spending 40%+ above the 3-month average, vendor bills due. Capped at 5, most severe first, each with a grounded reason and 1–2 actions (ask Buddy — which proposes a card or plan — or open the record). Shown as "Buddy noticed" in the brief and on Home (dismiss hides one for 3 days on that browser), and available to the model as `get_insights`.

**Personas** change only wording (`personas.js`); all six use the same tools, rules and approvals.

**Voice** uses the same `send()` → same loop. On a call, a low-risk card may be confirmed out loud (`confirm_proposal`) — the server now checks the stored risk, not the client's, and plans always need a tap.

New tools: `list_clients`, `list_projects`, `list_team`, `list_documents`, `recent_activity`, `buddy_activity`, `get_insights` (read); `create_project` (low); `send_payment_reminder` (high, not undoable, sent through `api/_lib/mailer.js` — the same credentials, quota and validation as `/api/email`); `propose_plan`. Every write tool also takes `reason`, shown on its card as "Why".

**Channels.** Telegram (2026-09-30) is the first external channel: see [telegram.md](telegram.md). It adds nothing to the brain: a channel-neutral bridge (`channelSession.js`: verify the person on every request, act with a short-lived token of their own) and an `audience` on the context — in a shared space (a team group) the permission map is narrowed to work resources and `privateOnly` tools are withheld. `add_task_note` (notes and blockers) and `team_pulse` (Daily Pulse, `pulse.js`) are ordinary tools every channel gets.

## Adding a tool

1. Pick (or create) a file in `api/_lib/agent/tools/` and export an array of tool objects. List the file in `registry.js` if it is new.
2. A **read** tool:

```js
{
  name: 'list_widgets', module: 'widgets', kind: 'read',
  permission: { resource: 'widgets', action: 'view' },   // or null for no data
  description: 'What it does, with the phrasings that should trigger it.',
  params: { type: 'object', properties: { … } },
  status: 'Checking widgets…',                          // shown while it runs
  async run(args, ctx) {
    // read through ctx.db (the user's client); return counts over ALL matches
    return { data: { total_matching, showing, widgets }, entities: [...] };
  },
}
```

3. A **write** tool:

```js
{
  name: 'update_widget', module: 'widgets', kind: 'write',
  risk: 'low',                          // 'high' for money, outsiders, deletes, people, permissions
  permission: { resource: 'widgets', action: 'edit' },   // resource may be a list of aliases
  planFeature: undefined,               // optional plan gate
  description: 'Include implied-intent examples: "X happened" → this tool.',
  params: { … },
  undoable: true,                       // or (args, ctx) => boolean; false for irreversible
  async resolve(args, ctx) {
    // words → ids / ISO dates. Return one of:
    //   { args: canonical, targets: [{ table, id, version: row.updated_at }], entities }
    //   choiceFrom(param, noun, resolution)   needsInput(param, question, options)
    //   notFound(message, offer?)             { error }  (the model may retry)
    // Canonical args must themselves be valid input: confirm re-runs resolve on them.
  },
  async validate(args, ctx) { return [/* sentences; empty = ok */]; },
  async preview(args, ctx) {
    return {
      title, target?, diff?: [change(...)], items?: [{ id, label, diff, checked, disabled }],
      preview?: { kind, rows: [[label, value]], note },     // high risk: the exact output
      fields?: [{ key /* an arg name */, label, type, value, options }],  // inline Edit
      confirmLabel?, irreversible?,
    };
  },
  async plan(args, ctx) { return [{ op: 'update', table, id, version, patch, before }]; },
  summary(outcome, args, ctx) { return 'Moved “X” to **2 Oct 2026**.'; },
  async after(outcome, ctx) { return 'Overdue tasks: 0.'; },   // optional follow-up line
  entitiesOf(outcome) { … },                                    // optional, for creates
}
```

4. Reuse existing logic. Shared parsing/maths goes in `src/shared/` (no browser imports; `.js` extensions). Row shapes must match what the screens write (see `cashEntryRow`).
5. Tests: add cases to `tools.test.js` (through `fakeDb`), and the new write tool is automatically covered by the "nothing written without a confirm" test and `registryProblems()`. Add eval cases to `scripts/eval-agent.cases.js`.
6. If the tool writes a new table, make sure the table has an audit trigger (`app.write_audit`) so the `via = 'edgeai'` attribution is recorded.

## Evals

```
node scripts/eval-agent.js            # all cases (needs OPENROUTER_API_KEY; uses .env)
node scripts/eval-agent.js task- crm-  # by id prefix
```

Runs each case through the real loop and model over the fixture company in `scripts/eval-agent.world.js`, with an in-memory database. Reports per-module tool and argument accuracy and the number of unconfirmed writes. Targets: **≥ 95% tool, ≥ 90% args, 0 writes.** Phase 1 + 2 (88 cases: tasks, CRM, cash, finance) runs at 98.9–100% tool and args, 0 writes.

## Deploying

1. Run `supabase/checks/agent_preflight.sql` on the live project; check section 86 (the `write_audit` fingerprint matches 0020: `lf_md5` `ee442a926db778edd095d1f4fe5c7bcb`, 2491 chars — the raw `md5` differs if the file was applied with Windows line endings), 18/133 (no collisions) and the permission keys the tools name. If the body differs, run `supabase/checks/write_audit_live.sql` and fold the live differences into 0068 section 4.
2. Apply `0068_ai_actions.sql`, then `0069_buddy_operator.sql` (or run `supabase/full_schema.sql` on a fresh project) (it also adds tasks, clients, cash, invoice, payment, bill and vendor tables to the realtime publication). Until it is applied the agent still answers and reads, and says it cannot make changes yet.
3. Environment: nothing new. Optional `AGENT_MODEL`, `AGENT_REASONING_EFFORT` (default `low`).
