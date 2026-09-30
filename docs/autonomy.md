# Autonomous Buddy Engine

Buddy can now keep working between requests. It notices when something becomes due, acts when the company allows it, tells the right people, and follows work through until it is done or a person needs to decide.

There is still one Buddy. The engine is an orchestration layer around the existing agent. It reuses the same tools (`registry.js`), the same write path (`pipeline.js`: propose → confirm → executor), the same action log (`ai_actions`), the same permission model (RLS, the permission matrix and the `app.*` guards) and the same audit trigger. It adds no second agent, prompt, tool set or approval flow.

```
 scheduler (Vercel Cron daily · GitHub Actions every 15 min · any caller with CRON_SECRET)
        │  GET /api/agent  (or GET /api/telegram, kept as an alias)
        ▼
 worker.js ── 1. observe.js  deterministic sweep, no model ──► buddy_jobs (dedupe_key)
          ── 2. buddy_claim_jobs()  FOR UPDATE SKIP LOCKED + lease
          ── 3. handlers.js  per event: re-read the truth, decide, act
          │        │  act.js ─► pipeline.propose ─► policy.decide ─► confirm ─► executor ─► RLS
          │        │                         └─ approval required → ai_actions (proposed) + notify approver
          │        └─ buddy_review only: loop.runChat (the model), bounded to one turn
          └─ 4. finish: completed | failed | retry (backoff) | deferred, fenced on the lease
```

## What is truly autonomous, and when

- **Works with nobody present:** reminders before a deadline, follow-ups after a missed deadline, the daily founder digest of long-overdue work, follow-through workflows (kickoff → due-day reminder → overdue follow-up → escalation → completion notice), reminders people scheduled, scheduled "check and report" requests, and the Daily Pulse.
- **Timing is only as good as the wake-ups.** A job runs at the first worker run after its `run_at`. Nothing runs in between.
  - `vercel.json` wakes the worker **once a day, at 12:30 UTC (18:00 IST)**. That is the limit of the Vercel Hobby plan. With only this, Buddy is *daily*, not 24/7.
  - `.github/workflows/buddy-worker.yml` wakes it **every 15 minutes**, once the repository secrets `BUDDY_WORKER_URL` and `CRON_SECRET` are set. GitHub runs schedules on a best-effort basis, so runs can arrive minutes late.
  - On Vercel Pro, set the cron to `*/5 * * * *` and delete the GitHub workflow.
  - Changing how often the worker runs never changes the job model. Double wake-ups are harmless.
- **Right away:** a follow-through, reminder or scheduled check that someone asks for in chat or Telegram takes effect in that same request. A follow-through's kickoff message is sent at once (`kick`), without waiting for the cron.

## Data model (migration `0072_buddy_autonomy.sql`)

| Table | Purpose |
| --- | --- |
| `buddy_jobs` | The one job/event queue. Each row has `kind`, `dedupe_key` (unique per company), `status` (`pending → processing → completed / failed / retry / cancelled`), `run_at`, `attempts / max_attempts`, `lease_until / locked_by`, the actor (`actor_kind` user / person / buddy), `workflow_id`, `payload`, `result`, `action_ids`, `last_error` and timestamps. |
| `buddy_workflows` | Durable follow-through. It records the task, assignee, initiator, a snapshot of the thresholds, and `state` (phase, what was said and when, `next` checkpoint). There is at most one live workflow per task. |
| `buddy_autonomy_policies` | Per company: `enabled` (the kill switch), `rules` (per-tool overrides), `settings` (thresholds). With no row, the defaults apply. |
| `ai_actions` (+ columns) | `actor_kind`, `autonomous`, `policy_decision` (which rule allowed it), `job_id`, `workflow_id`, `idempotency_key` (unique per company) and `approved_by`. |
| `audit_log` (+ column) | `actor_system = 'buddy'`. `via` is `'edgeai'` for human-confirmed actions and `'edgeai_auto'` for autonomous ones. |

`public.buddy_claim_jobs(worker, limit, lease_seconds, org?, ids?)` can be executed by `service_role` only.

**RLS.** No client role can write any of these tables, including owners; the API writes them with the service role after its own checks. Every member can read their own company's policy. Only owners and admins can read the jobs and workflows.

## The event vocabulary

| Kind | Created by | Does |
| --- | --- | --- |
| `task_due_soon` | Sweep: a task due within `remind_days_before`, assignee reachable on Telegram | One reminder to the assignee. |
| `task_overdue` | Sweep: past the deadline and not done | One follow-up to the assignee per missed deadline. |
| `founder_digest` | Sweep: tasks overdue by `escalate_after_days` or more | One message to the owner a day, and **only if the list changed** since the last digest. |
| `workflow_check_due` | A workflow (phases `kickoff`, `due`, `overdue`, `escalate`, `watch`) | Re-reads the task, speaks if needed, schedules the next checkpoint. |
| `reminder_due` | The `schedule_reminder` tool | Sends the reminder at the chosen time. |
| `buddy_review` | The `schedule_buddy_check` tool | Runs **the model**: the same Buddy loop, one turn, in the asker's session. It sends a report. |
| `pulse_due` | Sweep: Daily Pulse enabled | Calls the existing `sendPulse` at the company's pulse hour. |

Keys are deterministic, for example `task_due_soon:<task>:<deadline>` or `wf:<id>:<phase>:<deadline>:<generation>`. Running the sweep again, running two workers, or retrying a job never duplicates an event. A deadline that moves naturally produces new keys.

**Observation, reasoning and action are separate.**
- The clock belongs to the database and the sweep.
- Handlers first re-read the current state. If the task is already done, its deadline moved, it is unassigned, or a workflow owns it, the handler records why and does nothing.
- Only `buddy_review` calls the model. Every other event is deterministic and uses template messages built from the record.

## The autonomy policy (`api/_lib/autonomy/policy.js`)

`decide({ tool, args, ctx, policy, trigger })` is a pure function evaluated on the server. Its result is stored on the action as `policy_decision`.

1. Unknown tool or not a write → **forbidden**.
2. A delete → **forbidden**, always.
3. Not allowed for this actor (`registry.allowed`: permissions, plan, audience) → **forbidden**.
4. The company switched autonomy off → **approval**.
5. In a conversation (`trigger: 'interactive'`), only tools with `autonomy.interactive: 'auto'` skip the card. Everything else stays exactly as before.
6. Company rule `approval` → **approval**.
7. The tool's class is `approval` → **approval**, unless the company widened it. A company may widen only low-risk, non-deleting, non-finance, non-email tools.
8. `autonomy.when(args)` returns a reason → **approval**. Example: a Telegram message that mentions money, pay or secrets, or is longer than 600 characters.
9. Otherwise → **autonomous**.

An autonomous decision only removes the tap. `confirm()` still re-resolves and re-validates the action, re-checks permissions, runs it through the actor's own token, and applies optimistic concurrency.

### Classification of the actual registry

| Class | Tools |
| --- | --- |
| Autonomous (jobs) | `create_task`, `update_task`, `complete_task`, `reopen_task`, `add_task_note`, `send_telegram_message` (routine text only). In chat the same tools still show a card. |
| Autonomous (jobs and chat) | `start_followup` (routine title only), `cancel_followup`, `schedule_reminder` (to someone else: routine text only). `schedule_buddy_check` takes one tap in chat, because it hands Buddy a future turn with the user's access. |
| Approval | `create_client`, `update_client`, `move_client_stage`, `add_client_note`, `create_project` (a company may widen these). Always approval: `create_invoice_draft`, `create_quotation_draft`, `create_proforma_draft`, `convert_quotation`, `create_cash_entry`, `record_payment`, `mark_invoice_paid`, `issue_document`, `create_vendor`, `create_purchase_bill`, `cancel_financial_document`, `send_payment_reminder` (email, approved in the app only), `propose_plan` |
| Forbidden | `delete_task`, `delete_client`, `delete_financial_document` |

### Settings (defaults)

| Setting | Default |
| --- | --- |
| `deadline_reminders` | on |
| `remind_days_before` | 1 |
| `overdue_followups` | on |
| `escalate` | on |
| `escalate_after_days` | 2 |
| `overdue_window_days` | 14 (older slippage is not chased or escalated) |
| `reminder_hour` | 9 (local) |
| Quiet hours (`quiet_start`–`quiet_end`) | 21:00–08:00 local |
| `max_messages_per_person_per_day` | 4 |
| `notify_on_complete` | on |
| `approval_ttl_hours` | 48 |

During quiet hours, Buddy's own messages wait until morning. That wait does not count as an attempt. A reminder a person scheduled for a specific time is sent at that time.

**API.** All calls are `POST /api/agent`:
- `mode: 'autonomy'` returns the policy and the classified catalogue.
- `mode: 'autonomy_update'` (owner/admin only) takes `{ enabled?, rules?, settings? }`. Unknown keys are dropped, and values are clamped.
- `mode: 'autonomy_activity'` (owner/admin only) returns Buddy's jobs and its own actions.

## Who acts (the actor model)

A job always runs as a real, re-verified identity in its own company:

| `actor_kind` | Session | Used for |
| --- | --- | --- |
| `user` | `verifyPerson` + `userToken`: the user's own membership, login and permissions, re-checked at run time | `buddy_review` (acting for the person who asked) |
| `person` | `verifyLinkedPerson` + `personToken`: a live link and still employed | Supported, for future events |
| `buddy` | `buddyToken`: signed JWT, no `sub`, claim `sb_buddy: { org }` | Sweeps, workflow checkpoints, reminders |

What the Buddy principal is allowed, enforced in the database (`app.buddy_principal`, `app.buddy_permission`):
- Only for that company.
- Only while the company exists and its autonomy is on. The kill switch also stops tokens already issued.
- It may view tasks, employees, projects, milestones, project members, notifications and departments.
- It may create and edit tasks and notifications.
- All of this is intersected with the company's admin role.
- It may never delete, and never touch money, clients, pay, the AI log or governance.

`is_signed_in()` includes the Buddy principal, so every guard applies to it. Business writes a person asks for, such as the task behind a follow-through, are made as that person, when they ask.

## Proactive Telegram

Buddy sends through the existing `send_telegram_message` tool. That tool resolves the recipient from the company and the person id on the server, both at proposal time and at send time (`telegram/outbound.js`).
- The recipient must be in the same company and still active.
- The company must have Telegram on.
- The link must be live and not revoked.
- There must be a private chat the person started (`dm_chat_id` equals their own Telegram id, so a group is impossible).
- The model never supplies a chat id.
- The recipient-access check (`withheldFor`) still applies.

Messages Buddy sends on its own say **🤖 Buddy · Company**, never a person's name. They go to private chats only; groups never receive autonomous messages, and every autonomy tool is `privateOnly`. When a message needs approval, the approver gets a one-line notice with a link to review it in the app, with no details. That notice never triggers another notice.

**Approving Buddy-raised requests.** An approval request raised by the Buddy principal can be approved in the app by an owner or admin. Approving *adopts* it: it becomes their action (`approved_by`), is executed with their permissions, and is audited as `edgeai`.

## Retries, idempotency and failure

- **Claim.** A job is claimed atomically with a 120-second lease. A crashed worker's job is reclaimed after the lease expires, as a new attempt. When no attempts remain, it fails.
- **Finish.** Recording a job's outcome is fenced on `(status = processing, locked_by = me)`, so a worker that lost its lease cannot overwrite the outcome.
- **Retry.** Transient failures (a Telegram error without a specific code, 5xx or 429, network, database) retry with backoff of 1, 4, 16 and 64 minutes, then about 4 hours, capped at 6 hours, up to `max_attempts` (default 5).
- **Permanent failures** fail at once. These include: record not found, cross-company, refused by policy, bot blocked, link revoked, and "outcome unknown".
- **Action idempotency.** Every action a job takes has an `idempotency_key`. Before acting, `act()` looks up the earlier attempt:

  | Earlier attempt | What happens |
  | --- | --- |
  | Executed | Reused; nothing repeated |
  | Waiting for approval | Still waiting |
  | In flight (`confirmed`: the process died mid-send) | **Not repeated**. The job fails as "outcome unknown". A message is never sent twice. |
  | Failed, transient | A new attempt under `key#n` |

- **Success is only recorded after the database or Telegram confirms it.** A Telegram send counts only once Telegram returns a `message_id`.

## Security

- The worker endpoint (`GET /api/agent`) requires `Authorization: Bearer $CRON_SECRET`, compared in constant time. The secret must be at least 16 characters, otherwise everything is refused. The endpoint takes no input; what to do comes from the database.
- Jobs are created only by server code:
  - Payloads are validated: UUIDs, kind format, at most 8 KB.
  - The company comes from the verified session, never from the model.
  - Every record a payload names is checked against the job's company (`guardCompany`). A foreign id fails the job as `cross_company`, logged without data.
- Composite foreign keys stop a workflow or job from naming another company's task or person.
- The service-role key and JWT secret stay on the server. Logs are JSON lines built from an allowlist: ids, kinds, statuses, timings and error summaries. They never contain message bodies, tokens or Telegram ids.

## Observability

Each lifecycle step logs one JSON line:

```
{"src":"buddy","event":"job.completed","job_id":"…","org_id":"…","kind":"task_due_soon","status":"completed","attempt":1,"ms":412,"action_id":"…"}
```

Events include `job.start`, `job.completed`, `job.failed`, `job.retry`, `job.deferred`, `job.lease_lost`, `job.cross_company_denied`, `action.autonomous`, `action.approval_requested`, `action.refused`, `message.suppressed`, `observe.done` and `worker.done`.

"What did Buddy do while nobody was watching?" can be answered three ways:
- `buddy_activity` with `autonomous: true` (owners/admins, in chat).
- `mode: 'autonomy_activity'`.
- The tables `buddy_jobs` and `ai_actions where autonomous or actor_kind = 'buddy'`.

## Setup

1. Apply `supabase/migrations/0072_buddy_autonomy.sql` (idempotent), or run `full_schema.sql` on a fresh project.
2. Environment variables:
   - `SUPABASE_JWT_SECRET` is **required** for anything autonomous. It signs the Buddy principal's token.
   - `CRON_SECRET` is **required** for the worker.
   - The Telegram variables are needed as before.
3. Deploy. `vercel.json` now points the daily cron at `/api/agent`.
4. Optional, for timely reminders on Hobby: add the repository secrets `BUDDY_WORKER_URL` and `CRON_SECRET` so `.github/workflows/buddy-worker.yml` wakes the worker every 15 minutes.
5. Autonomy is on by default. To switch it off for a company: `POST /api/agent {mode:'autonomy_update', org_id, enabled:false}`.

## Not built (deliberately)

- Email as an event source or channel.
- Minute-level precision on Hobby.
- A settings UI for the policy (API only).
- Autonomous group messages.
- Autonomous finance, email or deletes.
- Person-actor scheduled checks (`schedule_buddy_check` is for users).
- Migrating the browser-side `useTaskDeadlineMonitor` (legacy EmailJS follow-ups and `project_reminders_run`, which run only while a tab is open). It is untouched.
- Redis or BullMQ: Postgres with `SKIP LOCKED` is the queue. The claim, finish and enqueue functions are the only places a different queue would plug in.
