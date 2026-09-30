import { describe, it, expect, vi, beforeEach } from 'vitest';

/*
 * The Telegram adapter with a company person who has no StartupBuddy login
 * (0071): linking by an admin's one-time invite, identity from the link —
 * never from Telegram's name, username or group membership — and the
 * group ↔ company and person ↔ company checks. Telegram, the adapter's
 * tables and Buddy itself are stand-ins; what is under test is the adapter's
 * own decisions.
 */

const mem = vi.hoisted(() => ({ links: [], chats: [], tokens: new Map(), people: [], refuse: null, sessions: [], sent: [] }));

vi.mock('./bot.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    isConfigured: () => true,
    getMe: vi.fn(async () => ({ id: 999, username: 'buddybrainsbot' })),
    sendMessage: vi.fn(async (chatId, html) => { mem.sent.push({ chatId, html }); return { message_id: mem.sent.length }; }),
    answerCallback: vi.fn(async () => {}),
    typing: vi.fn(async () => {}),
    editMessage: vi.fn(async () => {}),
    clearButtons: vi.fn(async () => {}),
  };
});

vi.mock('./store.js', () => ({
  isMissingTable: () => false,
  claimUpdate: vi.fn(async () => true),
  finishUpdate: vi.fn(async () => {}),
  recentUpdateCount: vi.fn(async () => 0),
  orgSettings: vi.fn(async (orgId) => ({ enabled: true, pulse_enabled: false, pulse_hour: 18, org_id: orgId })),
  orgBasics: vi.fn(async (orgId) => ({ name: orgId === 'org-a' ? 'Catalysis23' : 'Org B', tz: null })),
  linksForTelegram: vi.fn(async (tg) => mem.links.filter((l) => l.telegram_user_id === tg && !l.revoked_at)),
  linkFor: vi.fn(async (tg, orgId) => mem.links.find((l) => l.telegram_user_id === tg && l.org_id === orgId && !l.revoked_at) || null),
  chatFor: vi.fn(async (chatId) => mem.chats.find((c) => c.chat_id === chatId) || null),
  loadConversation: vi.fn(async () => null),
  saveConversation: vi.fn(async () => {}),
  consumeToken: vi.fn(async (token, tg) => {
    const r = mem.tokens.get(token);
    if (!r || r.used_at) return null;
    r.used_at = 'now';
    r.used_by_telegram = tg;
    return { ...r };
  }),
  releaseToken: vi.fn(async (token) => { const r = mem.tokens.get(token); if (r) r.used_at = null; }),
  personInOrg: vi.fn(async (orgId, id) => mem.people.find((p) => p.id === id && p.org_id === orgId) || null),
  createPersonLink: vi.fn(async ({ orgId, employeeId, from }) => {
    const l = { id: `l-${employeeId}`, org_id: orgId, employee_id: employeeId, user_id: null, telegram_user_id: from.id, revoked_at: null };
    mem.links.push(l);
    return l;
  }),
  voidPersonTokens: vi.fn(async () => {}),
  touchLink: vi.fn(async () => {}),
  revokeLink: vi.fn(async (id) => { const l = mem.links.find((x) => x.id === id); if (l) l.revoked_at = 'now'; }),
  clearConversationsFor: vi.fn(async () => {}),
}));

vi.mock('../agent/channelSession.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    // The session opens as whoever the LINK names — recorded for the asserts.
    openChannelSession: vi.fn(async ({ link, orgId, body, channelActor }) => {
      if (mem.refuse) throw new real.ChannelAccessError(mem.refuse);
      mem.sessions.push({ link, orgId, audience: body.audience, channelActor });
      return { orgId, aiLimit: Infinity, user: { id: link.user_id, name: 'Swetha NM' }, actor: { kind: link.employee_id ? 'person' : 'user', employeeId: link.employee_id } };
    }),
  };
});

vi.mock('../agent/buddy.js', () => ({
  chat: vi.fn(async (_ctx, _turn, emit) => emit('text', { text: 'Here are your tasks.' })),
}));

vi.mock('../aiUsage.js', () => ({ bumpAiUsage: vi.fn(async () => 1), logAiUsage: vi.fn(async () => {}) }));

const { processUpdate, confirmRefusal, ownsAction } = await import('./handler.js');
const store = await import('./store.js');
const buddy = await import('../agent/buddy.js');
const { openChannelSession } = await import('../agent/channelSession.js');

const SWETHA = 'e0000000-0000-4000-8000-000000000001';
const BOB_B = 'e0000000-0000-4000-8000-000000000009';
const TOKEN = 'Aa1_'.repeat(8); // 32 chars, the shape store.createToken makes
const ID = 'bbbbbbbb-0000-4000-8000-000000000001';
let updateId = 1000;

const dm = (fromId, text) => ({ update_id: ++updateId, message: { message_id: updateId, from: { id: fromId, first_name: 'X' }, chat: { id: fromId, type: 'private' }, text } });
const inGroup = (fromId, chatId, text) => ({ update_id: ++updateId, message: { message_id: updateId, from: { id: fromId, first_name: 'X' }, chat: { id: chatId, type: 'supergroup', title: 'Team' }, text } });
const lastSent = () => mem.sent.at(-1)?.html || '';

beforeEach(() => {
  mem.links = [];
  mem.chats = [{ chat_id: -100500, org_id: 'org-a' }, { chat_id: -100900, org_id: 'org-b' }];
  mem.tokens = new Map();
  mem.people = [
    { id: SWETHA, org_id: 'org-a', full_name: 'Swetha NM', role: 'Business Development Lead', user_id: null, exited_at: null, access_revoked_at: null },
    { id: BOB_B, org_id: 'org-b', full_name: 'Bob', role: 'Ops', user_id: null, exited_at: null, access_revoked_at: null },
  ];
  mem.refuse = null;
  mem.sessions = [];
  mem.sent = [];
  vi.clearAllMocks();
});

describe('C: an admin\'s person invite connects exactly that person', () => {
  it('links the Telegram account to the person and company the TOKEN names, and says so', async () => {
    mem.tokens.set(TOKEN, { purpose: 'person', org_id: 'org-a', employee_id: SWETHA, created_by: 'u-nikhil' });
    await processUpdate(dm(7001, `/start ${TOKEN}`));
    expect(store.createPersonLink).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org-a', employeeId: SWETHA, invitedBy: 'u-nikhil' }));
    expect(store.createPersonLink.mock.calls[0][0].from.id).toBe(7001);
    expect(lastSent()).toContain('You\'re connected to <b>Catalysis23</b> as <b>Swetha NM</b>. You can now use Buddy here.');
    expect(store.voidPersonTokens).toHaveBeenCalledWith('org-a', SWETHA);
  });

  it('works once: the same link a second time links nothing', async () => {
    mem.tokens.set(TOKEN, { purpose: 'person', org_id: 'org-a', employee_id: SWETHA, created_by: 'u-nikhil' });
    await processUpdate(dm(7001, `/start ${TOKEN}`));
    await processUpdate(dm(7666, `/start ${TOKEN}`));
    expect(store.createPersonLink).toHaveBeenCalledTimes(1);
    expect(lastSent()).toMatch(/expired or was already used/);
  });

  it('refuses a person who has left, and a Telegram account already a person in another company', async () => {
    mem.people[0].exited_at = '2026-09-01';
    mem.tokens.set(TOKEN, { purpose: 'person', org_id: 'org-a', employee_id: SWETHA, created_by: 'u-nikhil' });
    await processUpdate(dm(7001, `/start ${TOKEN}`));
    expect(lastSent()).toMatch(/no longer on the team/);

    mem.people[0].exited_at = null;
    mem.tokens.set(TOKEN, { purpose: 'person', org_id: 'org-a', employee_id: SWETHA, created_by: 'u-nikhil' });
    mem.links.push({ id: 'l-b', org_id: 'org-b', employee_id: BOB_B, user_id: null, telegram_user_id: 7001, revoked_at: null });
    await processUpdate(dm(7001, `/start ${TOKEN}`));
    expect(lastSent()).toMatch(/already connected to another company/);
    expect(store.createPersonLink).not.toHaveBeenCalled();
    expect(store.releaseToken).toHaveBeenCalledWith(TOKEN);
  });
});

describe('D, E, R: a connected person uses Buddy with no StartupBuddy login', () => {
  beforeEach(() => {
    mem.links.push({ id: 'l-swetha', org_id: 'org-a', employee_id: SWETHA, user_id: null, telegram_user_id: 7001, revoked_at: null });
  });

  it('D, R: in a private chat, as herself, with the whole private audience', async () => {
    await processUpdate(dm(7001, 'Show me my tasks'));
    expect(mem.sessions).toEqual([{ link: expect.objectContaining({ employee_id: SWETHA, user_id: null }), orgId: 'org-a', audience: 'private', channelActor: 'telegram:7001' }]);
    expect(buddy.chat).toHaveBeenCalledTimes(1);
    expect(lastSent()).toContain('Here are your tasks.');
  });

  it('E: in her company\'s group, the group decides the company and the answer is for the room', async () => {
    await processUpdate(inGroup(7001, -100500, '@buddybrainsbot create a task for me to follow up with the sponsor tomorrow'));
    expect(mem.sessions).toEqual([expect.objectContaining({ orgId: 'org-a', audience: 'shared' })]);
    expect(buddy.chat.mock.calls[0][1].message).toBe('create a task for me to follow up with the sponsor tomorrow');
  });
});

describe('O, P, Q: nobody else gets anything', () => {
  it('O: an unknown Telegram user in the group is told to ask an admin, and Buddy never runs', async () => {
    await processUpdate(inGroup(4242, -100500, '@buddybrainsbot what are our invoices?'));
    expect(lastSent()).toBe('I don\'t recognize your Buddy account yet. Ask your company admin to connect your Telegram account.');
    expect(openChannelSession).not.toHaveBeenCalled();
    expect(buddy.chat).not.toHaveBeenCalled();
  });

  it('O: an unknown user in a private chat gets the onboarding line, and nothing else', async () => {
    await processUpdate(dm(4242, 'show me the finances'));
    expect(lastSent()).toMatch(/I don't recognize your Buddy account yet/);
    expect(openChannelSession).not.toHaveBeenCalled();
  });

  it('P: someone linked to Company A gets nothing in Company B\'s group', async () => {
    mem.links.push({ id: 'l-swetha', org_id: 'org-a', employee_id: SWETHA, user_id: null, telegram_user_id: 7001, revoked_at: null });
    await processUpdate(inGroup(7001, -100900, '@buddybrainsbot list the tasks'));
    expect(store.linkFor).toHaveBeenCalledWith(7001, 'org-b');
    expect(openChannelSession).not.toHaveBeenCalled();
    expect(lastSent()).toMatch(/don't recognize your Buddy account/);
  });

  it('Q: a revoked connection is refused on the next message', async () => {
    mem.links.push({ id: 'l-swetha', org_id: 'org-a', employee_id: SWETHA, user_id: null, telegram_user_id: 7001, revoked_at: 'now' });
    await processUpdate(dm(7001, 'Show me my tasks'));
    expect(openChannelSession).not.toHaveBeenCalled();
    expect(lastSent()).toMatch(/I don't recognize your Buddy account yet/);
  });

  it('Q: a link revoked between lookup and session (the session re-checks it) ends access, it does not answer', async () => {
    mem.links.push({ id: 'l-swetha', org_id: 'org-a', employee_id: SWETHA, user_id: null, telegram_user_id: 7001, revoked_at: null });
    mem.refuse = 'unlinked';
    await processUpdate(dm(7001, 'Show me my tasks'));
    expect(buddy.chat).not.toHaveBeenCalled();
    expect(lastSent()).toMatch(/access to this company through Buddy has ended/);
  });
});

describe('T: confirming a high-risk card from Telegram', () => {
  const high = { id: ID, risk: 'high', tool: 'create_cash_entry' };
  const now = Date.parse('2026-09-30T10:00:00Z');

  it('a low-risk card confirms with one tap', () => {
    expect(confirmRefusal({ row: { ...high, risk: 'low', tool: 'create_task' }, group: false, state: {}, now })).toBeNull();
  });

  it('a high-risk card needs Review first, in this chat, within the last few minutes', () => {
    expect(confirmRefusal({ row: high, group: false, state: {}, now })).toMatch(/Tap Review first/);
    expect(confirmRefusal({ row: high, group: false, state: { reviewed: { action_id: 'another', at: now } }, now })).toMatch(/Tap Review first/);
    expect(confirmRefusal({ row: high, group: false, state: { reviewed: { action_id: ID, at: now - 6 * 60 * 1000 } }, now })).toMatch(/Tap Review first/);
    expect(confirmRefusal({ row: high, group: false, state: { reviewed: { action_id: ID, at: now - 60 * 1000 } }, now })).toBeNull();
  });

  it('never in a group, and never for a tool approved only in the app', () => {
    expect(confirmRefusal({ row: high, group: true, state: { reviewed: { action_id: ID, at: now } }, now })).toMatch(/private chat/);
    expect(confirmRefusal({ row: { ...high, tool: 'send_payment_reminder' }, group: false, state: { reviewed: { action_id: ID, at: now } }, now })).toMatch(/app only/);
  });

  it('only the identity that asked may use a card\'s buttons', () => {
    const person = { employee_id: SWETHA, user_id: null };
    const user = { employee_id: null, user_id: 'u-1' };
    expect(ownsAction(person, { user_id: null, employee_id: SWETHA })).toBe(true);
    expect(ownsAction(person, { user_id: null, employee_id: BOB_B })).toBe(false);
    expect(ownsAction(person, { user_id: 'u-1', employee_id: null })).toBe(false);
    expect(ownsAction(user, { user_id: 'u-1', employee_id: null })).toBe(true);
    expect(ownsAction(user, { user_id: null, employee_id: SWETHA })).toBe(false);
  });
});
