import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fakeDb, fakeCtx, personCtx } from './testing/fakeDb.js';

/*
 * send_telegram_message: Buddy texting a company person on Telegram, from
 * the web, a call, or Telegram itself — through the one action pipeline.
 *
 * ai_actions lives in memory with the real ownership rule; the service-role
 * database (the Telegram adapter's tables) is a fake; the Telegram Bot API is
 * a spy. Everything between — the tool, resolver, pipeline, executor, the
 * recipient checks in telegram/outbound.js and the chat loop — is real.
 */

const actions = new Map();
vi.mock('./actions.js', async (importOriginal) => {
  const real = await importOriginal();
  let n = 0;
  return {
    ...real,
    countPending: async () => 0,
    insertProposal: async (ctx, { chatId, messageId, tool, args, targets, preview, reason, source, parentId }) => {
      const id = `cccccccc-0000-4000-8000-${String(++n).padStart(12, '0')}`;
      const row = {
        id, org_id: ctx.orgId,
        user_id: ctx.actor?.kind === 'person' ? null : ctx.user.id,
        employee_id: ctx.actor?.kind === 'person' ? ctx.actor.employeeId : null,
        channel_actor: ctx.actor?.channelActor || null,
        channel: ctx.channel || 'chat',
        chat_id: chatId, message_id: messageId, tool: tool.name, module: tool.module, risk: tool.risk, args,
        target_ref: targets?.length ? { items: targets } : null, preview, status: 'proposed', kind: 'action',
        reason: reason || null, source: source || null, parent_id: parentId || null, events: [real.event('proposed')],
        proposed_at: new Date().toISOString(), expires_at: new Date(Date.now() + real.PROPOSAL_TTL_MS).toISOString(),
      };
      actions.set(id, row);
      return { ...row };
    },
    loadAction: async (id, ctx) => { const r = actions.get(id); return real.isOwner(r, ctx) ? { ...r } : null; },
    transition: async (id, from, patch) => {
      const r = actions.get(id);
      if (!r || r.status !== from) return null;
      Object.assign(r, patch);
      return { ...r };
    },
    patchAction: async (id, patch) => { Object.assign(actions.get(id), patch); return { ...actions.get(id) }; },
  };
});

// The service-role client the Telegram adapter uses.
const admin = { db: null };
vi.mock('../supabaseAdmin.js', () => ({ supabaseAdmin: () => admin.db }));

// The Telegram Bot API. Formatting helpers stay real.
const sent = [];
const telegram = { fail: null };
vi.mock('../telegram/bot.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    isConfigured: () => true,
    sendMessage: vi.fn(async (chatId, html) => {
      if (telegram.fail) throw new real.TelegramError('sendMessage', telegram.fail.status, telegram.fail.description);
      sent.push({ chatId, html });
      return { message_id: 900 + sent.length, chat: { id: chatId, type: 'private' } };
    }),
  };
});

const { propose, confirm, cancel, retry } = await import('./pipeline.js');
const { getTool, toolsFor, allowed } = await import('./registry.js');
const { runChat, runResume } = await import('./loop.js');
const { buildSystemPrompt } = await import('./prompt.js');
const { deliverPrivate, withheldFor, recipientAccess } = await import('../telegram/outbound.js');
const { applyPlan, undoPlan } = await import('./executor.js');
const { renderCard } = await import('../telegram/render.js');

const ORG = 'org-1';
const OTHER_ORG = 'org-2';
const SWETHA = 'e0000000-0000-4000-8000-000000000001';
const MADHES = 'e0000000-0000-4000-8000-000000000002';
const NIKHIL = 'e0000000-0000-4000-8000-000000000003';
const SWETHA_K = 'e0000000-0000-4000-8000-000000000004';
const RAVI = 'e0000000-0000-4000-8000-000000000005';
const PRIYA = 'e0000000-0000-4000-8000-000000000006';
const ARJUN = 'e0000000-0000-4000-8000-000000000007';
const OUTSIDER = 'e0000000-0000-4000-8000-000000000009';
const T1 = '11111111-1111-4111-8111-111111111111';
const GROUP_CHAT = -1001234567890;

const ALL = { view: true, create: true, edit: true, delete: true };
const RESOURCES = ['tasks', 'clients', 'employees', 'projects', 'financial_documents', 'payments', 'expenses', 'income_entries', 'notifications'];

const person = (id, full_name, extra = {}) => ({
  id, org_id: ORG, full_name, role: 'Team', email: `${full_name.split(' ')[0].toLowerCase()}@c23.test`, user_id: null,
  exited_at: null, access_revoked_at: null, updated_at: '2026-09-01', ...extra,
});
const link = (id, employeeId, tgId, extra = {}) => ({
  id, org_id: ORG, employee_id: employeeId, user_id: null, telegram_user_id: tgId, dm_chat_id: tgId,
  revoked_at: null, linked_via: 'person_invite', ...extra,
});

function world({ sameName = false } = {}) {
  const employees = [
    person(SWETHA, 'Swetha NM', { role: 'Business Development Lead' }),
    person(MADHES, 'Madheswaran', { role: 'Marketing Lead' }),
    person(NIKHIL, 'Nikhil', { role: 'Founder', user_id: 'u-1' }),
    person(RAVI, 'Ravi', { role: 'Engineer' }),                       // linked, never pressed Start
    person(PRIYA, 'Priya', { role: 'Designer' }),                     // link revoked
    person(ARJUN, 'Arjun', { role: 'Intern' }),                       // never connected
    // Another company's person: RLS would hide them from Nikhil's client; the
    // fake does not, so the server's own company check has to catch them.
    { ...person(OUTSIDER, 'Kiran Outsider'), org_id: OTHER_ORG },
  ];
  if (sameName) employees.push(person(SWETHA_K, 'Swetha K', { role: 'Accountant' }));
  const db = fakeDb({
    organizations: [{ id: ORG, company_name: 'Catalysis23' }],
    employees,
    tasks: [{ id: T1, org_id: ORG, title: 'Follow up with the sponsor', status: 'pending', priority: 'medium', deadline: '2026-10-02', assignee_id: SWETHA, updated_at: '2026-09-20T10:00:00+00:00' }],
    org_telegram: [{ org_id: ORG, enabled: true }, { org_id: OTHER_ORG, enabled: true }],
    telegram_links: [
      link('l-swetha', SWETHA, 7001),
      link('l-madhes', MADHES, 7002),
      link('l-swetha-k', SWETHA_K, 7004),
      link('l-ravi', RAVI, 7005, { dm_chat_id: null }),
      link('l-priya', PRIYA, 7006, { revoked_at: '2026-09-29T10:00:00Z', revoked_reason: 'admin' }),
      { ...link('l-outsider', OUTSIDER, 7009), org_id: OTHER_ORG },
    ],
    // A person with no login gets the admin role's view rights (0071).
    role_permissions: RESOURCES.map((resource) => ({ org_id: ORG, role: 'admin', resource, can_view: true })),
    memberships: [{ org_id: ORG, user_id: 'u-1', role: 'owner' }],
  }, { rpc: { user_permissions: () => RESOURCES.map((resource) => ({ resource, can_view: true })) } });
  admin.db = db;
  const nikhil = fakeCtx({ db, perms: Object.fromEntries(RESOURCES.map((k) => [k, ALL])), employeeId: NIKHIL });
  nikhil.user = { id: 'u-1', email: 'nikhil@c23.test', name: 'Nikhil' };
  nikhil.orgName = 'Catalysis23';
  nikhil.actor = { kind: 'user', userId: 'u-1', channelActor: null };
  nikhil.canDelete = true;
  nikhil.channel = 'chat';
  return { db, nikhil };
}

const tool = () => getTool('send_telegram_message');
const ask = (args, ctx) => propose(tool(), args, ctx, { chatId: 'web-1', messageId: 'm1' });
const draft = (to, message) => ({ recipient: to, message });

function scripted(...replies) {
  const seen = [];
  const fn = async ({ messages, tools }) => {
    seen.push({ messages, tools });
    return { message: replies.length ? replies.shift() : { role: 'assistant', content: 'ok' } };
  };
  fn.seen = seen;
  return fn;
}
const call = (name, args) => ({ role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
function collect() {
  const events = [];
  return { events, emit: (event, data) => events.push({ event, ...data }) };
}

beforeEach(() => {
  actions.clear();
  sent.length = 0;
  telegram.fail = null;
});

describe('the tool in the registry', () => {
  it('is a high-risk, never-undoable write offered on the web, withheld from a team group', () => {
    const { nikhil } = world();
    const t = tool();
    expect(t).toMatchObject({ kind: 'write', risk: 'high', undoable: false, privateOnly: true });
    expect(toolsFor(nikhil).map((x) => x.name)).toContain('send_telegram_message');
    expect(allowed(t, { ...nikhil, audience: 'shared' })).toBe(false);
    // The model can name a person, never a Telegram account or chat.
    expect(Object.keys(t.params.properties).sort()).toEqual(['message', 'recipient', 'recipient_person_id']);
  });

  it('tells the model it can message the team, so it no longer refuses', () => {
    const { nikhil } = world();
    const prompt = buildSystemPrompt(nikhil, toolsFor(nikhil));
    expect(prompt).toMatch(/send_telegram_message/);
    expect(prompt).toMatch(/never say you can't send Telegram messages/);
  });
});

describe('natural requests from the web chat', () => {
  it('1. "Text Swetha about tomorrow\'s task." → a draft card, nothing sent', async () => {
    const { nikhil } = world();
    const { events, emit } = collect();
    const model = scripted(call('send_telegram_message', draft('Swetha', 'Hey Swetha, just a reminder about tomorrow\'s task: please follow up with the sponsor.')));
    await runChat(nikhil, { message: 'Text Swetha about tomorrow\'s task.', history: [], chatId: 'web-1', messageId: 'm1' }, emit, { callModelImpl: model });

    const card = events.find((e) => e.event === 'card')?.card;
    expect(card).toMatchObject({ tool: 'send_telegram_message', status: 'proposed', risk: 'high', title: 'Telegram message to Swetha NM', confirmLabel: 'Send to Swetha' });
    expect(card.message).toEqual({ to: 'Swetha NM', via: 'Telegram', text: 'Hey Swetha, just a reminder about tomorrow\'s task: please follow up with the sponsor.' });
    expect(card.fields).toEqual([expect.objectContaining({ key: 'message', type: 'textarea' })]);
    expect(card.undo_until).toBeNull();
    expect(sent).toEqual([]);
    // The model was offered the tool, and the turn ended at the card.
    expect(model.seen[0].tools.map((t) => t.function.name)).toContain('send_telegram_message');
    expect(model.seen).toHaveLength(1);
  });

  it('asks what to say when only the person was named', async () => {
    const { nikhil } = world();
    const out = await ask({ recipient: 'Swetha' }, nikhil);
    expect(out.kind).toBe('input');
    expect(out.input).toMatchObject({ param: 'message', question: 'Sure. What should I tell Swetha?' });
    expect(actions.size).toBe(0);
  });

  it('2. "Tell Swetha the meeting is at 4 PM."', async () => {
    const { nikhil } = world();
    const out = await ask(draft('Swetha', 'Hi Swetha, the meeting is at 4 PM.'), nikhil);
    expect(out.kind).toBe('card');
    expect(out.card.message.text).toBe('Hi Swetha, the meeting is at 4 PM.');
    expect(out.card.entities).toEqual([expect.objectContaining({ type: 'employee', id: SWETHA })]);
  });

  it('3. "Message Madheswaran that the sponsor replied."', async () => {
    const { nikhil } = world();
    const out = await ask(draft('Madheswaran', 'Hi Madheswaran, the sponsor replied.'), nikhil);
    expect(out.kind).toBe('card');
    expect(out.card.title).toBe('Telegram message to Madheswaran');
    expect(actions.values().next().value.args).toEqual({ recipient_person_id: MADHES, message: 'Hi Madheswaran, the sponsor replied.' });
  });
});

describe('who it can go to', () => {
  it('4. two people named Swetha → a choice, never a guess; picking one drafts to her', async () => {
    const { nikhil } = world({ sameName: true });
    const out = await ask(draft('Swetha', 'Hi Swetha, the meeting is at 4 PM.'), nikhil);
    expect(out.kind).toBe('choice');
    expect(out.choice.question).toBe('I found two people named Swetha. Which one do you mean?');
    expect(out.choice.options.map((o) => o.value).sort()).toEqual([SWETHA, SWETHA_K].sort());
    expect(actions.size).toBe(0);

    // The tapped chip goes straight back into the tool.
    const { events, emit } = collect();
    await runResume(nikhil, { ...out.choice.resume, param: out.choice.param, value: SWETHA_K }, emit, { chatId: 'web-1', messageId: 'm2' });
    const card = events.find((e) => e.event === 'card')?.card;
    expect(card.title).toBe('Telegram message to Swetha K');
  });

  it('5. a person in another company cannot be messaged, even by id', async () => {
    const { nikhil } = world();
    const out = await ask({ recipient_person_id: OUTSIDER, message: 'hello' }, nikhil);
    expect(out.kind).toBe('none');
    expect(out.message).toBe('I could not find that person in your company.');
    // By name, too (were their row ever visible to the caller's client).
    expect((await ask(draft('Kiran', 'hello'), nikhil)).message).toBe('I could not find that person in your company.');
    // And the executor refuses it on its own, whatever reaches it.
    await expect(deliverPrivate({ orgId: ORG, employeeId: OUTSIDER, text: 'hello' })).rejects.toMatchObject({ code: 'not_found' });
    expect(sent).toEqual([]);
  });

  it('6. a revoked Telegram connection is reported, not used', async () => {
    const { nikhil } = world();
    const out = await ask(draft('Priya', 'Hi Priya'), nikhil);
    expect(out).toMatchObject({ kind: 'none', message: expect.stringMatching(/Priya's Telegram connection was disconnected/) });
    expect(sent).toEqual([]);
  });

  it('7. someone who never connected Telegram', async () => {
    const { nikhil } = world();
    const out = await ask(draft('Arjun', 'Hi Arjun'), nikhil);
    expect(out).toMatchObject({ kind: 'none', message: expect.stringMatching(/Arjun hasn't connected Telegram yet/) });
  });

  it('8. linked but never started the bot → says so, never claims it was sent', async () => {
    const { nikhil } = world();
    const out = await ask(draft('Ravi', 'Hi Ravi'), nikhil);
    expect(out).toMatchObject({
      kind: 'none',
      message: 'Ravi hasn\'t started a private chat with Buddy yet. Ask Ravi to open their Connect Telegram link and press Start.',
    });
    expect(sent).toEqual([]);
  });

  it('refuses when the company has Telegram switched off', async () => {
    const { db, nikhil } = world();
    db.tables.org_telegram[0].enabled = false;
    const out = await ask(draft('Swetha', 'Hi'), nikhil);
    expect(out).toMatchObject({ kind: 'none', message: expect.stringMatching(/switched off/) });
  });

  it('refuses an exited person, and messaging yourself', async () => {
    const { db, nikhil } = world();
    db.tables.employees.find((e) => e.id === MADHES).exited_at = '2026-09-15';
    expect((await ask({ recipient_person_id: MADHES, message: 'Hi' }, nikhil)).kind).toBe('none');
    expect((await ask({ recipient_person_id: NIKHIL, message: 'Hi' }, nikhil)).message).toMatch(/That's you/);
  });
});

describe('draft → review → confirm → execute → audit', () => {
  it('9 & 13. sends only after the tap, to her private chat, and records it', async () => {
    const { nikhil } = world();
    const out = await ask(draft('Swetha', 'Hey Swetha, please follow up with the sponsor at 10 AM tomorrow.'), nikhil);
    expect(sent).toEqual([]);

    const res = await confirm(nikhil, out.card.action_id);
    expect(res.status).toBe('executed');
    expect(res.card.summary).toBe('Sent to **Swetha NM** on Telegram, in their private chat.');
    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe(7001);
    expect(sent[0].html).toContain('<b>Nikhil</b> · Catalysis23 sent you a message via Buddy:');
    expect(sent[0].html).toContain('Hey Swetha, please follow up with the sponsor at 10 AM tomorrow.');

    // Audit: actor, company, channel, recipient, link, approval, Telegram's id.
    const row = actions.get(out.card.action_id);
    expect(row).toMatchObject({ org_id: ORG, user_id: 'u-1', channel: 'chat', tool: 'send_telegram_message', risk: 'high', status: 'executed' });
    expect(row.args.recipient_person_id).toBe(SWETHA);
    expect(row.events.map((e) => e.status)).toEqual(['proposed', 'approved', 'executing', 'completed']);
    expect(row.after_state[0]).toMatchObject({ recipient_person_id: SWETHA, telegram_link_id: 'l-swetha', telegram_message_id: 901, chat: 'private' });
    // The audit keeps no message text and no Telegram account details beyond the link.
    expect(JSON.stringify(row.after_state)).not.toMatch(/sponsor|7001/);
    expect(row.result.undoable).toBe(false);

    // A second tap does nothing more.
    const again = await confirm(nikhil, out.card.action_id);
    expect(again.status).toBe('executed');
    expect(sent).toHaveLength(1);
  });

  it('11. the user edits the draft before sending: the edited text is what goes out', async () => {
    const { nikhil } = world();
    const out = await ask(draft('Swetha', 'Hi Swetha, meeting at 4.'), nikhil);
    const res = await confirm(nikhil, out.card.action_id, { edits: { message: 'Hi Swetha, the meeting moved to 5 PM.' } });
    expect(res.status).toBe('executed');
    expect(sent[0].html).toContain('the meeting moved to 5 PM.');
    expect(sent[0].html).not.toContain('meeting at 4.');
    const row = actions.get(out.card.action_id);
    expect(row.events.map((e) => e.status)).toContain('edited');
    expect(row.args.message).toBe('Hi Swetha, the meeting moved to 5 PM.');
  });

  it('an edit cannot redirect the message: only the text is editable', async () => {
    const { nikhil } = world();
    const out = await ask(draft('Swetha', 'Hi Swetha'), nikhil);
    await confirm(nikhil, out.card.action_id, { edits: { recipient_person_id: MADHES, message: 'Hi there' } });
    expect(sent[0].chatId).toBe(7001);
  });

  it('12. the user cancels: nothing is sent, and it cannot be confirmed afterwards', async () => {
    const { nikhil } = world();
    const out = await ask(draft('Swetha', 'Hi Swetha'), nikhil);
    const res = await cancel(nikhil, out.card.action_id);
    expect(res.status).toBe('cancelled');
    expect((await confirm(nikhil, out.card.action_id)).status).toBe('cancelled');
    expect(sent).toEqual([]);
  });

  it('10. Telegram fails: not Done, the error says so, and Try again drafts it afresh', async () => {
    const { nikhil } = world();
    const out = await ask(draft('Swetha', 'Hi Swetha'), nikhil);
    telegram.fail = { status: 500, description: 'Internal Server Error' };
    const res = await confirm(nikhil, out.card.action_id);
    expect(res.status).toBe('failed');
    expect(res.card.error).toBe('Telegram couldn\'t deliver this message to Swetha. Try again in a moment.');
    expect(res.card.summary).not.toMatch(/^Sent/);

    telegram.fail = null;
    const again = await retry(nikhil, out.card.action_id);
    expect(again.status).toBe('proposed');
    expect(again.card.message.text).toBe('Hi Swetha');
    expect(sent).toEqual([]);   // a retry is a new card, never a send by itself
    expect((await confirm(nikhil, again.card.action_id)).status).toBe('executed');
    expect(sent).toHaveLength(1);
  });

  it('a person who blocked the bot is told apart from a generic failure', async () => {
    const { nikhil } = world();
    const out = await ask(draft('Swetha', 'Hi Swetha'), nikhil);
    telegram.fail = { status: 403, description: 'Forbidden: bot was blocked by the user' };
    const res = await confirm(nikhil, out.card.action_id);
    expect(res.status).toBe('failed');
    expect(res.card.error).toMatch(/Swetha has blocked or stopped the Buddy bot/);
  });

  it('re-checks at the tap: a link revoked after the draft stops the send', async () => {
    const { db, nikhil } = world();
    const out = await ask(draft('Swetha', 'Hi Swetha'), nikhil);
    db.tables.telegram_links.find((l) => l.id === 'l-swetha').revoked_at = new Date().toISOString();
    const res = await confirm(nikhil, out.card.action_id);
    expect(res.status).toBe('invalid');
    expect(res.message).toMatch(/Telegram connection was disconnected/);
    expect(sent).toEqual([]);
  });

  it('a Telegram message can never be undone', () => {
    expect(undoPlan([{ op: 'telegram', ok: true, after: { telegram_message_id: 1 } }])).toBeNull();
  });
});

describe('employees and other actors', () => {
  it('14. a linked company person (no login) messages a teammate through the same pipeline', async () => {
    const { db } = world();
    const swetha = personCtx({ db, employeeId: SWETHA, linkId: 'l-swetha', telegramUserId: 7001,
      perms: Object.fromEntries(RESOURCES.map((k) => [k, { view: true, create: true, edit: true, delete: false }])) });
    swetha.orgName = 'Catalysis23';
    expect(allowed(tool(), swetha)).toBe(true);

    const out = await propose(tool(), draft('Madheswaran', 'Hi Madheswaran, the sponsor replied.'), swetha, { chatId: 'tg:7001', messageId: 'tg1' });
    expect(out.kind).toBe('card');
    const row = actions.get(out.card.action_id);
    expect(row).toMatchObject({ user_id: null, employee_id: SWETHA, channel: 'telegram', channel_actor: 'telegram:7001' });

    // Only its owner may confirm it.
    const { nikhil } = world();
    expect((await confirm(nikhil, out.card.action_id)).status).toBe('not_found');
    admin.db = db;

    const res = await confirm(swetha, out.card.action_id);
    expect(res.status).toBe('executed');
    expect(sent[0].chatId).toBe(7002);
    expect(sent[0].html).toContain('<b>Swetha NM</b>');
  });

  it('a role that cannot see the team is not offered the tool', () => {
    const { nikhil } = world();
    const noTeam = { ...nikhil, can: (r, a) => r !== 'employees' && nikhil.can(r, a) };
    expect(allowed(tool(), noTeam)).toBe(false);
  });

  it('works from a voice call too, but only a tap sends it', async () => {
    const { nikhil } = world();
    nikhil.voice = true;
    nikhil.channel = 'voice';
    const out = await ask(draft('Swetha', 'Hi Swetha'), nikhil);
    expect(out.card.risk).toBe('high');
    // confirm_proposal, the only way a call confirms by voice, refuses high risk.
    nikhil.openCards = [{ action_id: out.card.action_id, title: out.card.title, risk: 'high' }];
    const { emit } = collect();
    await runChat(nikhil, { message: 'yes send it', chatId: 'web-1', messageId: 'm3' }, emit,
      { callModelImpl: scripted(call('confirm_proposal', { action_id: out.card.action_id })) });
    expect(sent).toEqual([]);
    expect(actions.get(out.card.action_id).status).toBe('proposed');
  });
});

describe('15. private chat, never the group', () => {
  it('sends to the person\'s own chat id, never a group id', async () => {
    const { nikhil } = world();
    const out = await ask(draft('Swetha', 'Tomorrow\'s task is due at 10 AM.'), nikhil);
    await confirm(nikhil, out.card.action_id);
    expect(sent.map((s) => s.chatId)).toEqual([7001]);
    expect(sent[0].chatId).toBeGreaterThan(0);
  });

  it('refuses a link whose stored chat is a group, or not the person\'s own', async () => {
    const { db, nikhil } = world();
    const l = db.tables.telegram_links.find((x) => x.id === 'l-swetha');
    l.dm_chat_id = GROUP_CHAT;
    expect((await ask(draft('Swetha', 'Hi'), nikhil)).message).toMatch(/hasn't started a private chat/);
    l.dm_chat_id = 7999;   // someone else's chat
    await expect(deliverPrivate({ orgId: ORG, employeeId: SWETHA, text: 'Hi' })).rejects.toMatchObject({ code: 'no_private_chat' });
    expect(sent).toEqual([]);
  });
});

describe('what a message may carry', () => {
  it('never sends passwords, keys or bank details', async () => {
    const { nikhil } = world();
    const out = await ask(draft('Swetha', 'The admin password is hunter2'), nikhil);
    expect(out).toMatchObject({ kind: 'none', message: expect.stringMatching(/don't send passwords/) });
  });

  it('keeps money from someone who cannot see it, and pay from anyone but owners and admins', async () => {
    const { db, nikhil } = world();
    // Swetha has a login with the employee role: no finance.
    db.tables.employees.find((e) => e.id === SWETHA).user_id = 'u-swetha';
    db.tables.memberships.push({ org_id: ORG, user_id: 'u-swetha', role: 'employee' });
    const rpc = db.rpc;
    db.rpc = async (fn, params) => (fn === 'user_permissions' && params.p_user === 'u-swetha'
      ? { data: [{ resource: 'tasks', can_view: true }], error: null } : rpc(fn, params));

    const money = await ask(draft('Swetha', 'Acme still owes us ₹2,40,000 on INV-0042'), nikhil);
    expect(money).toMatchObject({ kind: 'none', message: expect.stringMatching(/Swetha can't see money and invoices/) });
    const pay = await ask(draft('Madheswaran', 'Your salary revision is approved'), nikhil);
    expect(pay).toMatchObject({ kind: 'none', message: expect.stringMatching(/can't see salaries and pay/) });
    // Ordinary work is fine.
    expect((await ask(draft('Swetha', 'Meeting moved to 4 PM'), nikhil)).kind).toBe('card');
  });

  it('checks an edited draft again at the tap', async () => {
    const { nikhil } = world();
    const out = await ask(draft('Swetha', 'Hi Swetha'), nikhil);
    const res = await confirm(nikhil, out.card.action_id, { edits: { message: 'OTP is 123456' } });
    expect(res.status).toBe('invalid');
    expect(sent).toEqual([]);
  });

  it('reads a person\'s rights as 0071 gives them', async () => {
    world();
    const access = await recipientAccess(ORG, { id: SWETHA, user_id: null });
    expect(access.kind).toBe('person');
    expect(withheldFor('Invoice INV-0042 is paid', access, 'Swetha')).toBeNull();
    expect(withheldFor('The meeting is at 4 PM', { kind: 'person', view: new Set() }, 'Swetha')).toBeNull();
  });
});

describe('the executor op', () => {
  it('reports a failure without throwing past the plan, and does not mark it ok', async () => {
    world();
    telegram.fail = { status: 400, description: 'Bad Request: chat not found' };
    const outcome = await applyPlan(null, [{ op: 'telegram', orgId: ORG, employeeId: SWETHA, text: 'Hi' }]);
    expect(outcome.ok).toBe(false);
    expect(outcome.results[0]).toMatchObject({ ok: false, code: 'telegram', error: expect.stringMatching(/hasn't started a private chat/) });
  });

  it('the Telegram card shows the exact text', async () => {
    const { nikhil } = world();
    const out = await ask(draft('Swetha', 'Hi <Swetha>'), nikhil);
    const { html } = renderCard(out.card);
    expect(html).toContain('<blockquote>Hi &lt;Swetha&gt;</blockquote>');
  });
});
