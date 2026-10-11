# Cofounders, moods and the one-exchange chat

Date: 2026-10-11. Status: implemented on `feat/cofounder-minds`. This replaces the 2026-10-10 draft (six minds); that design was dropped.

## What changed

- The six earlier cofounders are removed. There are three. Since 2026-10-11 they are **Steve** (Steve Jobs, The Visionary), **Elon** (Elon Musk, The Engineer) and **Mark** (Mark Zuckerberg, The Hacker): AI cofounders built on each founder's publicly documented way of thinking, with sticker art supplied by the product owner. Each persona states that it is an AI, not the person, and never invents quotes. They replace the original characters Vikram, Anaya and Rohan, whose ids now migrate (steve, elon, mark).
- A stored choice of a retired cofounder is mapped to its successor (`src/shared/cofounders/legacy.js`, the only file that knows the old ids). The app rewrites it on the person's next open and shows "Your cofounder is now <name>. Change?" once.
- The chat screen shows one exchange and a mood. There is no chat list, thread or history, and the model is sent no earlier chat turns.

## Files

```
cofounders/
  _core/rules.md        the seven shared rules
  _core/situations.md   situation ids (mood, tag, money, detection hints) and the action vocabulary
  <id>/profile.json     id, name, title, iq, speciality, unlock, voice, vector, sample
  <id>/persona.md       voice, greeting, warning, praise, pushing back, headline word per mood
  <id>/mind.md          philosophy, priorities, what they ignore, risk, reasoning, biases, rules of thumb
  <id>/playbooks.md     one section per situation: ordered actions, a summary, prose
  <id>/examples.md      five short exchanges, with no figures
```

Parsed by `src/shared/cofounders/parse.js` on both sides. The server reads the files from disk (`api/_lib/agent/cofounders.js`; `vercel.json` ships `cofounders/**` with each function) and validates them at load. The app bundles them (`src/design/personas.js`).

## Prompt assembly

`api/_lib/agent/assemble.js` is the only place a prompt is built, and `runChat` is the only caller, so chat, voice, Telegram and autonomous follow-ups share it.

- System (cached): identity, `rules.md`, `persona.md`, `mind.md`, then the operating rules and safety.
- Turn: the per-message facts, then the cofounder's playbook for the detected situation and one or two of their examples.

Situation detection is rule-based (`src/shared/cofounders/detect.js`). A weak or tied match loads no playbook. In a Telegram group a money situation is never detected.

## Mood

Four moods: warning, win, thinking, celebrate. Each situation fixes its mood in `situations.md`. After a turn the server looks at what it produced (a question asked means thinking; a card from a payment tool means win; a converted quote means celebrate) and emits a final `mood` event: `{ mood, headline_word, tag, situation }`. The model may add `[[mood:…]]`; it is stripped and used only when no rule applies.

The exchange on screen is `{ mood, headline_word, tag, answer, card?, picks? }` (`src/chat/exchange.js`).

## No chat history

- `runChat` sends system, turn context and the message. A `history` argument is ignored.
- What carries between exchanges is the system's record: recent entities, an open question, open cards, what was done.
- The web app keeps only the current exchange (`startupbuddy.exchange.<org>.<user>` in localStorage).
- Telegram stops storing words in `telegram_conversations.state`.

Left in place for a later decision: the `telegram_conversations` table (still used for entities, cards and the open question), and old browser keys `edgeos_ai_chats*` holding past web chats, which are no longer read or written.

## Selection

`src/design/CofounderChooser.jsx`: a four-question quiz (stage, biggest problem, risk comfort, pushback) scored against each cofounder's vector in complement and mirror modes (`src/shared/cofounders/match.js`), then three cards. Used in onboarding, Settings, the first-time sheet and the moved notice. Answers are saved to `user_metadata.startupbuddy_founder_profile`.

## Art

`src/design/art/`: 12 avatars and 12 backgrounds as SVG strings, each under 15 KB, plus a round face crop. `/dev/cofounders` shows the grid and one situation answered by all three.

## Tests

`api/_lib/agent/cofounders.test.js` (files, ids and migration map, no trace of the retired cofounders, mood for every situation, differentiation, assembly, shared rules per cofounder, quiz), `src/design/art/art.test.js` (24 snapshots, size and text limits), `src/chat/exchange.test.jsx` (the screen renders one exchange).
