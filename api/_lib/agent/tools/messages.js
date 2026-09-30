import { resolveEntity, entityOf, normalize } from '../resolvers.js';
import { needsChoice, needsInput, notFound } from '../helpers.js';
import { recipientChannel, recipientAccess, withheldFor, MAX_MESSAGE } from '../../telegram/outbound.js';

/**
 * A private Telegram message to one person in the team: "text Swetha about
 * tomorrow's task", "tell Madheswaran the meeting moved to 4 PM".
 *
 * The model names the person as the user did; the resolver finds them among
 * the company's own people through the caller's own client (so only people
 * they can see), and two people with that name are a choice, never a guess.
 * The Telegram side — link, private chat, company — is looked up by the
 * server from the person id (telegram/outbound.js); the model never sees or
 * supplies a Telegram id.
 *
 * High risk and not undoable: a message cannot be unsent. The card shows the
 * exact text, which the user may edit, and it goes out only on their tap —
 * then everything is re-checked and it is sent by executor.js, which marks it
 * done only once Telegram returns a message id.
 *
 * It goes to that person's private chat with the bot, never to a group, and
 * the tool is not offered in a group at all (privateOnly). A message must not
 * carry what the recipient could not read in StartupBuddy (outbound.withheldFor).
 */

const firstName = (row) => String(row?.full_name || 'them').trim().split(/\s+/)[0] || 'them';
const active = (r) => !r.exited_at && !r.access_revoked_at;

const send_telegram_message = {
  name: 'send_telegram_message',
  module: 'team',
  kind: 'write',
  risk: 'high',
  // Messaging a teammate is ordinary company work: whoever may create tasks
  // or notifications may do it. Seeing the team is checked in resolve.
  permission: { resource: ['notifications', 'tasks'], action: 'create' },
  // Never drafted in a team group, where everyone would read the draft.
  privateOnly: true,
  available: (ctx) => ctx.can('employees', 'view'),
  description: 'Send a PRIVATE Telegram message to one person in the team, from Buddy on the user\'s behalf, after the user taps Send on the card: '
    + '"text Swetha about tomorrow\'s task", "message Madheswaran that the sponsor replied", "tell Swetha I\'ll review it tomorrow", "ping Ravi on Telegram". '
    + 'Pass the person as the user named them. Write `message` as the text that will be sent — first person, as the user, addressed to the recipient, '
    + 'short and friendly — using ONLY what the user said (and task details you looked up if they asked you to include them). Never add figures, '
    + 'money, salaries or client terms the user did not ask to send. If the user gave no content ("text Swetha"), leave `message` out and the user is asked. '
    + 'It goes to that person\'s private chat, never a group.',
  params: {
    type: 'object',
    properties: {
      recipient: { type: 'string', description: 'The person, as the user named them ("Swetha", "Madheswaran"), or "him"/"her" for the one being discussed.' },
      recipient_person_id: { type: 'string', description: 'The person\'s id, only if you have it from list_team or the conversation.' },
      message: { type: 'string', description: 'The exact message text to send.' },
    },
    required: ['recipient'],
  },
  undoable: false,
  stopOnError: true,

  async resolve(args, ctx) {
    const ref = String(args.recipient_person_id || args.recipient || '').trim();
    if (!ref) return needsInput('recipient', 'Who should I message?');
    if (!ctx.can('employees', 'view')) return notFound('Your role can\'t see the team, so I can\'t message someone for you.');

    const r = await resolveEntity('employee', ref, ctx, { filter: active });
    if (r.status === 'many') {
      const rows = r.candidates.map((c) => c.row);
      const said = normalize(ref);
      const sameName = rows.every((row) => normalize(firstName(row)) === normalize(firstName(rows[0])));
      const question = sameName && said && !/^[0-9a-f-]{36}$/i.test(ref)
        ? `I found ${rows.length === 2 ? 'two' : rows.length} people named ${firstName(rows[0])}. Which one do you mean?`
        : 'Which person do you mean?';
      return needsChoice('recipient_person_id', question,
        r.candidates.map((c) => ({ entity: c.entity, sub: [c.row.role, c.row.email].filter(Boolean).join(' · ') || null })));
    }
    if (r.status !== 'one') return notFound(`I couldn't find anyone called “${ref}” in your team.`);
    const person = r.row;
    if (person.id === ctx.employeeId) return notFound('That\'s you — I can only message someone else in the team.');

    // The server's view of this person and their Telegram, from the verified
    // company — not from anything the client or the model said.
    const channel = await recipientChannel(ctx.orgId, person.id);
    if (!channel.ok) return notFound(channel.message);

    const message = String(args.message ?? '').trim();
    if (!message) return needsInput('message', `Sure. What should I tell ${firstName(person)}?`);

    return {
      args: { recipient_person_id: person.id, message: message.slice(0, MAX_MESSAGE + 1) },
      targets: [],
      entities: [entityOf('employee', person)],
    };
  },

  async validate(args, ctx) {
    const problems = [];
    const text = String(args.message || '').trim();
    if (!text) problems.push('The message is empty.');
    if (text.length > MAX_MESSAGE) problems.push(`That message is too long for Telegram — keep it under ${MAX_MESSAGE} characters.`);
    const channel = await recipientChannel(ctx.orgId, args.recipient_person_id);
    if (!channel.ok) {
      problems.push(channel.message);
      return problems;
    }
    // The message may not carry what the recipient could not see themselves.
    const access = await recipientAccess(ctx.orgId, channel.person);
    const withheld = withheldFor(text, access, firstName(channel.person));
    if (withheld) problems.push(withheld);
    return problems;
  },

  async preview(args, ctx) {
    const { person } = await recipientChannel(ctx.orgId, args.recipient_person_id);
    const name = person?.full_name || 'them';
    return {
      title: `Telegram message to ${name}`,
      target: person ? entityOf('employee', person) : null,
      preview: {
        kind: 'message',
        rows: [
          ['To', `${name}${person?.role ? ` · ${person.role}` : ''}`],
          ['Via', 'Telegram · their private chat with Buddy'],
        ],
      },
      message: { to: name, via: 'Telegram', text: args.message },
      fields: [{ key: 'message', label: 'Message', type: 'textarea', value: args.message }],
      confirmLabel: `Send to ${firstName(person)}`,
      irreversible: 'A Telegram message cannot be unsent. It goes to their private chat, not the team group.',
    };
  },

  async plan(args, ctx) {
    return [{
      op: 'telegram',
      orgId: ctx.orgId,
      employeeId: args.recipient_person_id,
      text: args.message,
      senderName: ctx.user?.name || null,
      orgName: ctx.orgName || null,
      label: 'Telegram',
    }];
  },

  summary(outcome) {
    const sent = outcome.results.find((r) => r.op === 'telegram');
    if (!sent || sent.ok === false) return sent?.error || 'Telegram couldn’t deliver this message.';
    return `Sent to **${sent.after?.recipient_name || 'them'}** on Telegram, in their private chat.`;
  },

  href: () => '/employees',
};

export default [send_telegram_message];
