# Telegram Buddy (V0.1)

Telegram is a **channel into the same Buddy** as the web app and the voice call, not a second AI. A Telegram message ends up in `api/_lib/agent/buddy.js` exactly like a web message. It uses the same prompt, personas, tools, permission map, `ai_actions` proposals, approval rules, executor, audit attribution (`audit_log.via = 'edgeai'`), undo and retry. The Telegram layer handles Telegram and nothing else.

```
Telegram ──webhook──▶ api/telegram.js ─▶ _lib/telegram/handler.js      (Telegram concerns only)
                          │                 identify: update → chat/group mapping → company
                          │                           → live link → verifyPerson (every update)
                          │                 translate: message → web-shaped request body
                          │                            button  → confirm/cancel/undo/retry/resume
                          │                 render:    events/cards → messages + buttons
                          ▼
             _lib/agent/channelSession.js   verified person → short-lived token AS that user
                          ▼
             _lib/agent/buddy.js            same loop · tools · permissions · ai_actions · audit
```

## What was added

| Layer | File | Role |
| --- | --- | --- |
| Endpoint | `api/telegram.js` | One Vercel function: Telegram webhook (secret header), the app's management API (bearer token), and the Daily Pulse cron (`CRON_SECRET`). |
| Bridge (channel-neutral) | `api/_lib/agent/channelSession.js` | `verifyPerson` checks the account, the live membership and a revoked login on **every** request. `userToken` issues a short-lived token for that user. `openChannelSession` opens a normal Buddy session. A future email/Slack adapter reuses this unchanged. |
| Daily Pulse (channel-neutral) | `api/_lib/agent/pulse.js`, `tools/pulse.js` | The check-in log (`pulse_checkins`) and the `team_pulse` read tool for owners/admins. |
| Telegram | `api/_lib/telegram/bot.js` | Bot API client, 429 handling, webhook-secret check, HTML escaping. |
| | `store.js` | Links, groups, one-time tokens (SHA-256 only), update dedupe, conversation state. |
| | `conversation.js` | Per-person, per-chat context: history, records in play, open question, cards. Built into the same body the web client sends. |
| | `render.js` | Cards/views/choices as messages and buttons. The card's risk decides which buttons appear. |
| | `handler.js` | Commands, linking, group gating, Buddy turns and callbacks. |
| | `pulse.js` | Delivers check-ins by DM. |
| | `manage.js` | Settings → Telegram API. |
| Web | `src/settings/TelegramSettings.jsx` | Settings → Telegram. |
| | `AssistantContext.jsx` / `ChatScreen.jsx` | `/chat?action=<id>` opens a Telegram-proposed change as its normal card, for in-app review. |
| DB | `supabase/migrations/0070_telegram_channel.sql` | Also appended to `full_schema.sql`. |

**Changes to Buddy itself (small, channel-neutral):**

- `context.js`
  - Accepts channel `telegram` and source `pulse:<id>`.
  - Adds `audience: 'private' | 'shared'`. In a shared space (a group), the permission map is narrowed to `SHARED_RESOURCES` (tasks, projects, milestones, project team, employees, announcements). Money, invoices, clients, leave and attendance never reach the model there, and neither does EdgeBrain.
- `registry.js`: tools marked `privateOnly` (`recent_activity`, `buddy_activity`, `team_pulse`) are never offered in a shared space.
- `prompt.js`: adds channel lines (Telegram style, "confirm by tapping", high risk only in the app) and the SHARED SPACE rule. Adds a DAILY CHECK-IN block when the turn replies to a check-in. Version bumped to `agent-2026-09-30.3-startupbuddy-telegram`. Persona wording is unchanged.
- New generic tool `add_task_note` (low risk, `tasks: edit`, undoable). It covers "I'm blocked on X because Y" (`blocker: true`) and task notes, on every channel, and is plannable.
- `aiUsage.js`: `bumpAiUsage()` is shared, so Telegram messages count against the same plan limit (`api/agent.js` behaves exactly as before).

## Setup (what you need to do)

1. **BotFather**
   - `/newbot` → pick a name and a username (e.g. `StartupBuddyHQ_bot`) → copy the token.
   - `/setprivacy` → your bot → **Enable**. Privacy mode means groups only deliver commands, @mentions and replies to the bot. This is the intended behaviour.
   - Optional: `/setjoingroups` **Enable** (default), plus `/setdescription` and `/setuserpic`.
2. **Database:** apply `supabase/migrations/0070_telegram_channel.sql` in the Supabase SQL editor. It is idempotent. For a fresh project, `full_schema.sql` already includes it.
3. **Environment** (Vercel → Project → Settings → Environment Variables, and `.env` for local use):

   | Variable | Required | Notes |
   | --- | --- | --- |
   | `TELEGRAM_BOT_TOKEN` | yes | From BotFather. Server-only. |
   | `TELEGRAM_WEBHOOK_SECRET` | yes | `openssl rand -hex 32` |
   | `CRON_SECRET` | for Daily Pulse | `openssl rand -hex 32`. Vercel Cron sends it automatically. |
   | `SUPABASE_JWT_SECRET` | recommended | Supabase → Project Settings → JWT Keys → *Legacy JWT secret*. Without it, sessions come from a magic-link exchange (no email sent; also updates the user's last sign-in time). |
   | `APP_URL` | recommended | e.g. `https://your-app.vercel.app`. Enables the "Review in StartupBuddy" buttons. Falls back to Vercel's production URL. |
   | `TELEGRAM_BOT_USERNAME` | optional | Otherwise read from `getMe`. |

   The existing `SUPABASE_URL`/`VITE_SUPABASE_URL`, the anon key, `SUPABASE_SERVICE_ROLE_KEY` and `OPENROUTER_API_KEY` must already be set. **Redeploy** after adding these.
4. **Webhook**, once per deployment, after deploying:
   ```
   node scripts/telegram-setup.js https://your-app.vercel.app
   node scripts/telegram-setup.js --info      # check: url set, no last_error_message
   ```
   This registers `https://…/api/telegram` with the secret token, limits updates to `message`, `callback_query` and `my_chat_member`, drops old queued updates, and publishes the command menus. Telegram requires HTTPS on port 443, 80, 88 or 8443, so a Vercel domain works but localhost does not. To test locally, use a tunnel (e.g. `cloudflared`) and point the script at it.
5. **Vercel Cron:** `vercel.json` schedules `GET /api/telegram` daily at **12:30 UTC (18:00 IST)**. Hobby plans allow one daily run. With the default hour (6 pm), check-ins go out at 6 pm IST. A company that picks a later hour only gets check-ins if the cron runs at or after that hour, so on Pro switch the schedule to hourly (`0 * * * *`). **Send now** in Settings always works.
6. **In the app** (owner/admin): Settings → Telegram → switch **Buddy on Telegram** on → **Link my Telegram** → **Connect a group** → invite members → optionally turn on **Daily Pulse**.

## Connection and identity

- **One platform bot** serves every company. A group is mapped to exactly one company (`telegram_chats`, unique while connected). A Telegram account is linked per company (`telegram_links`, one live link per account per company and per person per company).
- **Self-link (strongest):** a signed-in member taps *Link my Telegram*. The app gets a one-time `t.me/<bot>?start=<token>` link (15 min). Opening it in Telegram and pressing Start links that Telegram account to that StartupBuddy user. Both identities are proven: the StartupBuddy session created the token and the Telegram account used it.
- **Admin invite:** an owner/admin creates a link for a specific member (48 h, single use). Whoever opens it first becomes linked as that member, so it must be sent privately. The admin sees who linked (`@username`, "invite") and can unlink them. Self-link is safer and preferred.
- **Group connect:** an owner/admin (with their own Telegram already linked) taps *Connect a group* and gets `t.me/<bot>?startgroup=<token>` (30 min). Telegram adds the bot to the chosen group and sends `/start <token>` there. The server accepts it only if the sender's linked account belongs to the admin who created the token, and that person is still an owner/admin (re-checked).
- **Tokens:** 24 random bytes, stored only as SHA-256, consumed by one conditional UPDATE (no double use), and released only when the step could not complete for a reason the user can fix.
- **Unknown users** get a linking message with no company information. In a group, an unlinked sender is told to DM the bot. An unconnected group is told how an admin connects it.
- **Leaving / role change / disable:** StartupBuddy is the source of truth on every update. `verifyPerson` requires:
  - the auth account exists and is not banned;
  - a `memberships` row exists (an exit deletes it);
  - the employee login is not revoked (`access_revoked_at`) and not exited.

  Failing any of these revokes the link at that moment and clears its conversations. The permission map (`my_permissions`, including per-person overrides) is rebuilt every turn, so a role change applies from the next message. Telegram group membership is never used for authorization.
- **Roles without Buddy:** Buddy on the web admits only `owner`, `admin`, `member` and `viewer` (`requireOrgRole(..., 'viewer')`). Telegram uses the same gate. A member with another role (notably **`employee`**) is told their role doesn't include Buddy, and their link is kept. Settings shows this per member.

## Permission model

Nothing Telegram-specific exists. A Telegram turn runs with a token for the linked user, so:

- every read and write goes through RLS, the permission matrix and the `app.*` guards, exactly as in the app;
- tools are offered from the same `my_permissions` map (narrowed further in groups);
- company isolation: the company comes from the group mapping or the DM's link, never from message text. Ids in conversation context are pointers that tools reload with the user's token. Buttons carry only an action id or a per-conversation nonce, and the server reloads the action by id **and** owner before acting.

> ⚠️ **Important for employees:** the `employee` role has **no `tasks` access** in the permission matrix (see `0057`) and does not pass Buddy's role gate. So for teammates to use Buddy (on Telegram or the web) to read or change tasks, give them the **Member** role (Settings → Members), or a role or per-person override that includes tasks. This reuses the existing model and widens nothing.

## Employee actions (through existing tools)

| Said on Telegram | Buddy uses | Confirmation |
| --- | --- | --- |
| What do I need to do today? / What's the deadline for the website? / Who owns the payment integration? | `list_tasks`, `get_record`, `list_team`, `list_projects` | none: reads answer immediately |
| Move my payment task to Friday | `update_task` (deadline) | Confirm button, Undo 10 min |
| Mark the homepage task as done / I finished the client proposal | `complete_task` | Confirm button |
| I'm blocked on the payment integration because I need API access | `add_task_note` (blocker) | Confirm button |
| Remind me tomorrow at 10 | `create_task` due tomorrow (tasks have dates, not times; the card shows exactly what is created) | Confirm button |
| Add a note / new task / plan for a goal | `add_task_note`, `create_task`, `propose_plan` | Confirm / Approve (plans hold only low-risk steps) |

Ambiguity is handled by the existing resolvers: several matches become a choice rendered as buttons, a missing field becomes one question (buttons for suggested answers, or just reply), and nothing found may come with an offer button ("Create task …"). A tapped choice goes straight back into the tool without a model call, as on the web. "That", "it", "move that to Monday" resolve against the records in this chat's context, and only inside the company and the person's permissions.

## High-risk restrictions

Risk comes from the tool definition (`registry.js`), never from the model or the channel.

- A **high-risk card** (money, sending email or payment reminders, issuing or cancelling documents, deletes, vendors, bills, cash entries) is shown in Telegram **without** a Confirm button. It has *Review in StartupBuddy* (opens `/chat?action=<id>` as the normal card) and *Cancel*.
- The confirm callback also refuses any action whose stored risk is not `low`, whatever the button said.
- Plans follow the existing rules (only `PLANNABLE` low-risk steps). Approving one in Telegram approves every step. To untick or edit steps, review it in the app.
- Buddy says "done" only when `confirm` returns `executed`. Failures show the stored error and a *Try again* button (`retry` → a fresh, re-checked proposal).

## Groups vs private chats

| | Private chat (DM) | Company group |
| --- | --- | --- |
| Buddy answers | every message | only `/buddy …`, an @mention, or a reply to Buddy |
| Company | the link (switch with `/company`) | the group's mapping |
| Data | everything the person's permissions allow | work data only (`SHARED_RESOURCES`); no finance, clients, leave, attendance, audit trail, Buddy history, pulse |
| Buttons | the person's | only the person who asked can use them |
| Context | per person | per person per group (never shared between teammates) |
| Daily Pulse | yes | never |

## Daily Pulse (foundation)

Implemented as the core loop:

1. The cron (or *Send now*) DMs each linked, still-verified, not-opted-out person once per day: "How did your day go?". This is recorded in `pulse_checkins` (channel `telegram`).
2. Their reply, and follow-ups within 30 minutes, run as an ordinary Buddy turn with source `pulse:<id>`. The prompt's DAILY CHECK-IN block tells Buddy to turn it into proposals: `complete_task`, `add_task_note` (blocker), `update_task`, `create_task`, `add_client_note`, or one `propose_plan`.
3. The reply text and the proposals' action ids are stored on the check-in.
4. The founder asks Buddy (web or DM) "how did the team's day go?". `team_pulse` reads the check-ins with their own token (RLS: owners/admins see the company) and shows who answered, what they said and each update's status.

Not built (deliberately): scoring, rankings, summaries pushed to the founder, email delivery. The engine is channel-neutral, so an email or dashboard sender only needs to call `recordAsk` and route the reply with `source: pulse:<id>`.

## Production behaviour

- **Webhook auth:** a constant-time compare of `X-Telegram-Bot-Api-Secret-Token`. Anything else gets a 401. With no or a weak secret configured, everything is refused.
- **Idempotency:** each `update_id` is inserted once (`telegram_updates`), so duplicates and redeliveries are dropped. After authentication the webhook always answers 200, so Telegram never retries a turn that may have half-run. Action confirmation stays idempotent on the action id.
- **Rate limits:**
  - inbound: 20 updates per person per minute (warned once, then ignored);
  - outbound: one retry on a 429 whose `retry_after` is 5 s or less, and ~60 ms spacing for pulse sends;
  - AI: the existing plan meter.
- **Logging:** `[telegram] <kind> <update_id> <status> <ms>`, plus link, group and pulse events and token usage. No message bodies, bot tokens or user tokens are logged.
- **Secrets:** the bot token, webhook secret, JWT secret and service key are server-only. The browser receives only the bot's username and one-time `t.me` links.
- **Failure:** the user gets a short generic reply. A failed action shows its own error. Nothing is claimed done without the database.

## Manual testing checklist

Setup
- [ ] 0070 applied; env vars set; redeployed; `node scripts/telegram-setup.js <url>` and `--info` show the webhook with no error.
- [ ] Settings → Telegram shows the bot's @username; the switch turns Telegram on.

Identity
- [ ] *Link my Telegram* → open link → Start → "You're linked to <Company> as <you> (owner)".
- [ ] Opening the same link again → "expired or already used".
- [ ] A Telegram account that was never linked DMs the bot → linking instructions, no company info.
- [ ] Admin *Invite link* for a Member → they open it → linked (Settings shows them, "invite").
- [ ] Member with role `employee` opens an invite → told their role doesn't include Buddy; change them to Member → the same link works.
- [ ] Change a linked member's role to Viewer → their next write request is refused (reads still work).
- [ ] Remove a member from the company → their next Telegram message says access ended; Settings no longer shows the link.
- [ ] `/me`, `/company` (with two companies), `/unlink`, `/new`.

Private chat
- [ ] "What do I need to do today?" → list from your real tasks.
- [ ] "Move my payment task to Friday" → card with Confirm/Cancel → Confirm → "✅ Moved … to Fri …" + Undo → Undo works.
- [ ] Ambiguous task name → choice buttons → tap one → card.
- [ ] "I'm blocked on X because I need API access" → *Flag task as blocked* card → confirm → note appears on the task in the app.
- [ ] "Mark it done" right after discussing a task → resolves to that task.
- [ ] "Send a payment reminder to <client>" (owner) → high-risk card with **no Confirm**, *Review in StartupBuddy* opens the card in the app → Send there works.
- [ ] Web app → AI activity / audit log shows the action with channel `telegram` and `via = edgeai`.
- [ ] Switch cofounder in Settings → Telegram replies change tone only.

Group
- [ ] *Connect a group* → pick group → "connected to <Company>".
- [ ] Plain group chatter → Buddy stays silent. `@bot what's due this week?` → answers (reply-threaded).
- [ ] `@bot how much revenue this month?` / invoices / salaries → Buddy says it can't discuss that in the group.
- [ ] Another teammate taps your Confirm → "Only the person who asked…".
- [ ] Unlinked teammate mentions the bot → told to DM to link.
- [ ] Remove the bot from the group → Settings no longer lists the group.

Daily Pulse
- [ ] Turn on Daily Pulse → *Send now* → linked people get the check-in by DM.
- [ ] Reply "finished the proposal, stuck on payments waiting for API keys" → proposals (a plan or cards) → approve.
- [ ] Web Buddy: "how did the team's day go?" → team pulse view.
- [ ] `/pulse off` → no check-in on the next *Send now*.
