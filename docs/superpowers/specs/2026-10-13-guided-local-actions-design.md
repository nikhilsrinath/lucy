# Guided local actions for Buddy

## Context

"I want to add a new employee" came back as "Opened Team." because Buddy has no tool for employees or offer letters, so the model fell back to opening the page. The same is true for NDAs, MoUs, certificates, leave, attendance, announcements, products, timesheets, recurring invoices, emailing documents and settings. Separately, nine tools that do exist (edit a client, task notes, vendor bills, Telegram messages, reminders, scheduled checks, follow-ups) have no local rule, so every use of them costs a model call.

Goal: the app itself recognises these requests, asks only for what is missing, and shows a confirm card. No model call when the wording is clear. The model keeps the open-ended cases (writing, advice, bulk changes, vague phrasing).

Decisions taken with the user:
- **Asking style:** ask the 3-5 essentials one at a time with tap chips; everything else is pre-filled and editable on the confirm card.
- **Rollout:** three phases, stopping after each for the user to test.
- **Allowed from chat:** emailing invoices and quotes, sending offer letters, editing simple company profile fields. Banking, email credentials and roles stay on the Settings page.

## How it fits what exists

Nothing structural is new. Every piece below already works for tasks, clients and invoices:

- A write tool's `resolve()` returns `needsInput(param, question, options)` for one missing field (`api/_lib/agent/helpers.js`). `propose()` turns that into a question with chips (`api/_lib/agent/pipeline.js:58`).
- The answer comes back as `ctx.pending` and is fed into the same tool without the model (`api/_lib/agent/local/engine.js:381-405`). Successive `needsInput` returns already make a multi-question flow.
- The confirm card's `preview.fields` are editable (text, select, textarea, date in `src/chat/ActionCard.jsx`), and `confirm()` re-resolves with the edits (`pipeline.js:191`).
- A local rule is one entry in `INTENTS` (`local/intents.js`) plus one or more `WRITE_PATTERNS` (`local/understand.js:361`). Patterns run before reads and before the "needs the model" signals, so a new pattern also fixes the offer-letter misroute.
- All tables and permission resources already exist (`employees`, `employee_compensation`, `records`, `leave_requests`, `attendance_days`, `announcements`, `timesheets`, `catalog_items`, `recurring_invoices`, `organizations`). **No migration is expected.**

## Shared groundwork (start of Phase 1)

1. **Slot helper** in `api/_lib/agent/helpers.js`: `askNext(args, slots, ctx)`. A tool declares an ordered `slots` list: `{ key, question(args, ctx), options?(args, ctx), optional?, free?, read?(raw, ctx) }`. It returns `needsInput` for the first essential that is missing, re-asks with the reason as the hint when `read` rejects the answer, and treats `null` as "skipped". Tools call it at the top of `resolve()` and export `slots` on the tool object.
2. **Answer handling** in `engine.js` (the `pending` block). Look up `getTool(pending.tool).slots` for the open param and:
   - free-text slots (address, responsibilities, announcement body) accept answers longer than 8 words;
   - while a slot question is open, a read-shaped match does not hijack the answer ("Senior Finance Manager" must not become a finance lookup); only a cancel or a recognised change or navigation command does;
   - "skip" / "none" / "not now" on an optional slot passes `null`; "cancel" / "stop" still cancels.
   No client change: the slot metadata is read server-side from the tool.
3. **Follow-on offers:** use the existing `tool.after()` / `followUp` and `notFound(..., offer)` chips to chain flows (after adding an employee: "Create offer letter for Ravi").
4. **Shared pure helpers** move to `src/shared/` when the server needs them (pattern: `src/shared/cashIntent.js`, `dates.js`), re-exported from the service so the app is unchanged. First case: `countLeaveDays` from `src/services/leaveService.js`.
5. **Local execution of follow-through tools:** check how `loop.js` sets `ctx.autonomy` for a chat that asked for exactly a follow-through tool, and give the local path the same context so `start_followup` / `schedule_reminder` behave identically whether the model or the router called them.

## Phase 1: existing tools go local, plus employees and offer letters

**Local rules for the nine model-only tools** (intents + patterns only; the tools are untouched):

| Intent | Tool | Read locally when said like |
|---|---|---|
| `UPDATE_CLIENT` | `update_client` | "change Acme's email to ap@acme.com", "Kite's phone is 98…", "set the Kite deal value to 3 lakh" |
| `ADD_TASK_NOTE` | `add_task_note` | "add a note to the pricing task: …", "blocked on the payment task: need API access" |
| `CREATE_PURCHASE_BILL` | `create_purchase_bill` | "record a bill from Dell for 85k", "got Dell's bill 85k, bill no DL-9981" |
| `DELETE_DOCUMENT_DRAFT` | `delete_financial_document` | "delete quote QT-2026-0005", "delete the Globex quotation draft" |
| `SEND_TELEGRAM_MESSAGE` | `send_telegram_message` | "message Ravi: standup at 5", "tell Ravi that the deck is due Friday", "ping Ravi" (asks for the text) |
| `SEND_TELEGRAM_GROUP_MESSAGE` | `send_telegram_group_message` | "tell the team: office closed Monday", "post in the group: …" |
| `SCHEDULE_REMINDER` | `schedule_reminder` | "remind me at 5pm to call the sponsor", "remind Swetha tomorrow at 10 to send the deck" |
| `SCHEDULE_BUDDY_CHECK` | `schedule_buddy_check` | "on Friday check whether Swetha finished the deck and tell me" |
| `CANCEL_FOLLOWUP` | `cancel_followup` | "stop chasing Swetha about the sponsor" |
| `START_FOLLOWUP` | `start_followup` | "make sure Ravi sends the deck by Friday" (exact person + task form only) |

Messages are sent with the words as said; the card shows the text and it is editable before Send. "Draft / write / rephrase a message…" stays with the model. The existing `remind me … <clock time>` escalation in `understand.js:366` becomes `SCHEDULE_REMINDER`.

**New `api/_lib/agent/tools/people.js`** (registered in `registry.js`):
- `create_employee` (employees/create, risk high). Asks: full name, role, employment type (chips from the `employment_type` enum), start date (chips: Today, 1st of next month), pay (amount, or "Unpaid"; skipped when the role cannot edit `employee_compensation`). Card fields: email, phone, department, reports to, pay frequency. Validates duplicate name or email. Plan: insert `employees`, `then` insert `employee_compensation`. Follow-up chip: create their offer letter.
- `update_employee` (employees/edit). Person + any of role, email, phone, department, reports to, start date, employment type, pay. Diff card, undoable.

**New `api/_lib/agent/tools/letters.js`**:
- `create_offer_letter` (records/create, risk high). Asks: who (an existing team member pre-fills name, email, role, department, manager, start date and pay; otherwise a new name), offer type (Internship / Full-time), role, pay, start date, end date (internship only), reply-by date (chip: in 7 days). Company name, address and signatory come from `ctx.org`. Address, department, reports-to and responsibilities are editable on the card. `data` uses exactly the `OfferForm` keys (`src/components/OfferForm.jsx:55-86`) and the row shape `storageService.save` writes, so the app's preview, PDF and portal read it unchanged. Number from the `next_document_number` RPC inside `plan()` (as `tools/finance.js:392`). Saved as "Not sent" when the letter is complete, as a draft with a note naming what is missing otherwise. Respect the plan's offer-letter usage limit the way the form does.
- `send_offer_letter` (records/edit, risk high, `approval: 'app'`, not undoable). Emails the candidate using the same content the app sends today (`emailService.sendOfferNotification`, mirrored server-side) through the executor's `email` op, then marks the letter sent. Follow-up chip after `create_offer_letter`.

**Router:** intents `CREATE_EMPLOYEE`, `UPDATE_EMPLOYEE`, `CREATE_OFFER_LETTER`, `SEND_OFFER_LETTER`; patterns include the bare forms ("add a new employee", "hire someone", "create an offer letter") which simply start the questions. "create an offer letter for Ravi" no longer reaches the document search.

## Phase 2: day-to-day team actions

- `tools/timeoff.js`: `apply_leave` (who, defaulting to me; leave type chips from `leave_types`; dates; optional reason), `decide_leave` (approve or reject; which request, with a choice when several are pending; optional comment), `cancel_leave` (own pending request).
- `tools/attendance.js`: `mark_attendance` (person or me, status chips from the `attendance_status` enum, date defaulting to today; a manager's mark lands as `source: 'admin'`), plus "check me in" / "check me out". Existing row is updated, otherwise inserted, as `attendanceService.markDay` does.
- `tools/announcements.js`: `post_announcement` (title, body as free text, audience chips: Everyone or a department; pin and expiry on the card).
- `tools/timesheets.js`: `log_time` (project, hours, date defaulting to today, optional note and task; saved as a draft entry for the person).
- Intents and patterns for each ("apply for leave tomorrow", "approve Ravi's leave", "mark Priya absent today", "announce: office closed Monday", "log 3 hours on Acme website").

## Phase 3: documents, catalogue, recurring, email, settings

- `letters.js` grows `create_nda`, `create_mou`, `create_certificate`, each asking the essentials of its form (`NdaForm.jsx`, `MoUForm.jsx`, `CertificateForm.jsx`) and writing the same `records` shape.
- `tools/catalog.js`: `create_catalog_item` (name, rate, GST % chips, optional HSN) and `update_catalog_item`. This is the sellable catalogue (`catalog_items`), which is what invoice lines use.
- `tools/recurring.js`: `create_recurring_invoice` (client, amount or items, frequency chips, start date, end: none / date / number of cycles, draft or send) and `set_recurring_active` (pause / resume).
- `tools/reminders.js` or a new `tools/share.js`: `send_document_email` (issued invoice, quotation or proforma; asks for the email only when the client has none; subject and message editable on the card; link built the way the app's send does; a draft is refused with an "Issue it first" chip). `approval: 'app'`, not undoable.
- `tools/settings.js`: `update_company_profile` (organizations/edit, risk high) over a fixed allow-list of plain profile columns. Never banking, secrets, roles or billing.
- `prompt.js`: drop the "emailing is not available from chat yet" lines and refresh rule 4's examples.

## Files touched (pattern, not every line)

- New tool files under `api/_lib/agent/tools/`; each added to `ALL_TOOLS` in `api/_lib/agent/registry.js`.
- `api/_lib/agent/helpers.js` (`askNext`), `api/_lib/agent/local/engine.js` (answer handling), `local/intents.js`, `local/understand.js`, `local/lexicon.js` (only where a word must stop meaning "search documents"), `local/evalset.js`.
- `api/_lib/agent/prompt.js`, `src/shared/` for moved pure helpers.
- Docs: `docs/local-router.md` and `docs/edgeai-agent.md` gain the new intents and tools; the design is saved first to `docs/superpowers/specs/2026-10-13-guided-local-actions-design.md`.

## Rules kept

- Nothing is written without a tap on a card; recognising an intent grants nothing. Permissions are read off the tool and re-checked at confirm.
- Anything that emails or messages someone is risk high, not undoable, and shown word for word before sending.
- New phrasing goes into `local/evalset.js` first and is watched failing, then taught. The spelling corrector is not loosened.
- A pattern that is not sure hands the message to the model rather than guessing.

## Verification (each phase)

1. Add eval cases and tool tests first; see them fail.
2. `npx vitest run api/_lib/agent` (router tests pass `{ router: 'on' }` because `vitest.config.js` turns it off by default). `registryProblems()` and `intentProblems()` must stay empty.
3. `node scripts/eval-router.js --misses`: 0 wrong local executions, 0 unconfirmed writes, and the new cases route local.
4. Multi-turn engine tests in `local/engine.test.js`: "i want to add a new employee" → name → role → type → start → pay → card, with a skipped optional answer, a long free-text answer, a cancel mid-way, and an answer that looks like a lookup.
5. In the running app: repeat the original message and confirm the card creates the employee and offers the offer letter; open the saved letter in Team to confirm the preview renders from the chat-created data.
6. Stop and hand over for the user's own testing before the next phase. No commits unless asked.
