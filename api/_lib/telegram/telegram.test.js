import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderCard, renderOptions, renderNotice } from './render.js';
import { mdToHtml, esc, verifyWebhookSecret } from './bot.js';
import { currentState, freshState, requestBody, trackCard, remember, pushHistory, STALE_MS } from './conversation.js';
import { isTokenShape } from './store.js';
import { fakeDb, fakeCtx } from '../agent/testing/fakeDb.js';
import { getTool, toolsFor, allowed } from '../agent/registry.js';
import { applyPlan } from '../agent/executor.js';
import { SHARED_RESOURCES } from '../agent/context.js';
import { buildSystemPrompt, buildTurnContext } from '../agent/prompt.js';

const ID = '9f1c2d3e-4b5a-4c6d-8e7f-001122334455';
const future = new Date(Date.now() + 20 * 60 * 1000).toISOString();
const callbacks = (buttons) => buttons.flat().map((b) => b.callback_data).filter(Boolean);
const urls = (buttons) => buttons.flat().map((b) => b.url).filter(Boolean);

describe('Telegram cards: risk decides the buttons', () => {
  const env = { ...process.env };
  beforeEach(() => { process.env.APP_URL = 'https://app.example.com'; });
  afterEach(() => { process.env = { ...env }; });

  it('a low-risk proposal gets Confirm, Edit and Cancel', () => {
    const { html, buttons } = renderCard({ action_id: ID, status: 'proposed', risk: 'low', kind: 'action', title: 'Update task deadline', expires_at: future, diff: [{ label: 'Deadline', from: '25 Sep', to: '2 Oct 2026' }] });
    expect(callbacks(buttons)).toEqual([`a:c:${ID}`, `a:e:${ID}`, `a:x:${ID}`]);
    expect(html).toContain('Not done yet');
    expect(html).toContain('25 Sep → <b>2 Oct 2026</b>');
  });

  it('a high-risk proposal has no Confirm until it is reviewed — Review, Edit, Cancel', () => {
    const card = { action_id: ID, tool: 'create_cash_entry', status: 'proposed', risk: 'high', kind: 'action', title: 'Record cash out', expires_at: future };
    const { html, buttons } = renderCard(card);
    expect(callbacks(buttons)).toEqual([`a:v:${ID}`, `a:e:${ID}`, `a:x:${ID}`]);
    expect(html).toMatch(/Review it, then confirm/);
    // Tapping Review redraws it with the one button that applies it.
    const reviewing = renderCard(card, Date.now(), { reviewing: true });
    expect(callbacks(reviewing.buttons)).toEqual([`a:c:${ID}`, `a:x:${ID}`]);
    expect(reviewing.html).toMatch(/Check every detail/);
  });

  it('a high-risk proposal in a group never gets Confirm or Review', () => {
    const { html, buttons } = renderCard({ action_id: ID, tool: 'create_cash_entry', status: 'proposed', risk: 'high', kind: 'action', title: 'Record cash out', expires_at: future }, Date.now(), { group: true, reviewing: true });
    expect(callbacks(buttons)).toEqual([`a:x:${ID}`]);
    expect(html).toMatch(/never confirmed in a group/);
  });

  it('a tool approved only in the app (it emails a client) gets review in the app, or cancel', () => {
    const { html, buttons } = renderCard({ action_id: ID, tool: 'send_payment_reminder', status: 'proposed', risk: 'high', kind: 'action', title: 'Send payment reminder', expires_at: future }, Date.now(), { reviewing: true });
    expect(callbacks(buttons)).toEqual([`a:x:${ID}`]);
    expect(urls(buttons)).toEqual([`https://app.example.com/chat?action=${ID}`]);
    expect(html).toMatch(/approval in StartupBuddy/);
  });

  it('an app-only proposal still has no Confirm when no app URL is known', () => {
    delete process.env.APP_URL;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    const { buttons } = renderCard({ action_id: ID, tool: 'send_payment_reminder', status: 'proposed', risk: 'high', kind: 'action', title: 'Send payment reminder', expires_at: future });
    expect(callbacks(buttons)).toEqual([`a:x:${ID}`]);
    expect(urls(buttons)).toEqual([]);
  });

  it('a plan gets Approve, Cancel and a review link', () => {
    const { buttons, html } = renderCard({ action_id: ID, status: 'proposed', risk: 'low', kind: 'plan', title: 'Launch', goal: 'Launch in two weeks', confirmLabel: 'Approve 3 steps', expires_at: future, steps: [{ n: 1, title: 'Create task', tool: 'create_task' }] });
    expect(callbacks(buttons)).toEqual([`a:c:${ID}`, `a:x:${ID}`]);
    expect(buttons.flat()[0].text).toContain('Approve 3 steps');
    expect(html).toContain('Plan: Launch in two weeks');
  });

  it('an expired proposal has no buttons and says nothing changed', () => {
    const { buttons, html } = renderCard({ action_id: ID, status: 'proposed', risk: 'low', kind: 'action', title: 'X', expires_at: new Date(Date.now() - 1000).toISOString() });
    expect(buttons).toEqual([]);
    expect(html).toMatch(/nothing was changed/i);
  });

  it('says done only for an executed card, with Undo while the window is open', () => {
    const done = renderCard({ action_id: ID, status: 'executed', risk: 'low', kind: 'action', title: 'Mark task done', summary: 'Marked “Homepage” done.', undo_until: future });
    expect(done.html).toContain('✅');
    expect(callbacks(done.buttons)).toEqual([`a:u:${ID}`]);
    const failed = renderCard({ action_id: ID, status: 'failed', risk: 'low', kind: 'action', title: 'Mark task done', error: 'Your role does not allow that change.' });
    expect(failed.html).not.toContain('✅');
    expect(failed.html).toMatch(/Nothing was changed/);
    expect(callbacks(failed.buttons)).toEqual([`a:r:${ID}`]);
  });

  it('escapes record text so it cannot inject markup', () => {
    const { html } = renderCard({ action_id: ID, status: 'proposed', risk: 'low', kind: 'action', title: '<b>x</b>', expires_at: future, target: { label: '<a href="x">y</a>' } });
    expect(html).not.toContain('<a href');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('keeps every callback within Telegram\'s 64-byte limit', () => {
    for (const status of ['proposed', 'executed', 'failed']) {
      const { buttons } = renderCard({ action_id: ID, status, risk: 'low', kind: 'action', title: 'X', expires_at: future, undo_until: future });
      for (const c of callbacks(buttons)) expect(Buffer.byteLength(c)).toBeLessThanOrEqual(64);
    }
    for (const c of callbacks(renderOptions('Which task?', [{ label: 'A', value: '1' }, { label: 'B', value: '2' }], 'deadbeef').buttons)) {
      expect(c).toMatch(/^k:deadbeef:\d$/);
    }
    expect(callbacks(renderNotice('None found', { tool: 'create_task', label: 'Create it' }, 'deadbeef').buttons)).toEqual(['k:deadbeef:0']);
  });
});

describe('Telegram text', () => {
  it('maps light Markdown to HTML after escaping', () => {
    expect(mdToHtml('Moved **Homepage** to Friday <script>')).toBe('Moved <b>Homepage</b> to Friday &lt;script&gt;');
    expect(mdToHtml('- one\n- two')).toBe('• one\n• two');
    expect(esc('a & b')).toBe('a &amp; b');
  });
});

describe('webhook authenticity', () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; });

  it('accepts only the exact secret header', () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = 'a'.repeat(32);
    expect(verifyWebhookSecret({ headers: { 'x-telegram-bot-api-secret-token': 'a'.repeat(32) } })).toBe(true);
    expect(verifyWebhookSecret({ headers: { 'x-telegram-bot-api-secret-token': 'b'.repeat(32) } })).toBe(false);
    expect(verifyWebhookSecret({ headers: {} })).toBe(false);
  });

  it('refuses everything when no (or a weak) secret is configured', () => {
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    expect(verifyWebhookSecret({ headers: { 'x-telegram-bot-api-secret-token': '' } })).toBe(false);
    process.env.TELEGRAM_WEBHOOK_SECRET = 'short';
    expect(verifyWebhookSecret({ headers: { 'x-telegram-bot-api-secret-token': 'short' } })).toBe(false);
  });

  it('only accepts link tokens of the generated shape', () => {
    expect(isTokenShape('A'.repeat(32))).toBe(true);
    expect(isTokenShape("x' or 1=1 --")).toBe(false);
    expect(isTokenShape('A'.repeat(31))).toBe(false);
  });
});

describe('conversation state', () => {
  it('starts fresh for another company, so context never crosses companies', () => {
    const s = freshState('org-a');
    s.entities = [{ type: 'task', id: ID, label: 'Homepage' }];
    expect(currentState({ state: s }, 'org-b')).toEqual(expect.objectContaining({ org_id: 'org-b', entities: [] }));
  });

  it('drops stale words but keeps cards so a late tap still resolves', () => {
    const s = { ...freshState('org-a'), at: Date.now() - STALE_MS - 1000, history: [{ role: 'user', content: 'hi' }], cards: [{ action_id: ID, status: 'proposed' }] };
    const cur = currentState({ state: s }, 'org-a');
    expect(cur.history).toEqual([]);
    expect(cur.cards).toHaveLength(1);
  });

  it('builds the same request body the web client sends', () => {
    const s = freshState('org-a');
    pushHistory(s, 'user', 'what is due?');
    remember(s, [{ type: 'task', id: ID, label: 'Homepage' }], 'tg1');
    trackCard(s, { action_id: ID, title: 'Mark task done', tool: 'complete_task', kind: 'action', risk: 'low', status: 'proposed', expires_at: future }, 42);
    const body = requestBody(s, { chatId: -100123, messageId: 'tg7', audience: 'shared', source: null });
    expect(body).toMatchObject({ channel: 'telegram', audience: 'shared', chat_id: 'tg:-100123', message_id: 'tg7' });
    expect(body.context.recentEntities[0]).toMatchObject({ id: ID, type: 'task' });
    expect(body.context.openCards).toEqual([{ action_id: ID, title: 'Mark task done', risk: 'low' }]);
    expect(s.cards[0].message_id).toBe(42);
  });
});

describe('shared spaces (a team group) see only work data', () => {
  it('narrows to work resources and withholds private tools', () => {
    const perms = Object.fromEntries(['tasks', 'projects', 'employees', 'financial_documents', 'expenses', 'edgebrain', 'clients']
      .map((k) => [k, { view: true, create: true, edit: true, delete: true }]));
    const shared = fakeCtx({ perms: Object.fromEntries(Object.entries(perms).filter(([k]) => SHARED_RESOURCES.has(k))) });
    shared.audience = 'shared';
    const names = toolsFor(shared).map((t) => t.name);
    expect(names).toContain('list_tasks');
    expect(names).toContain('complete_task');
    for (const hidden of ['list_invoices', 'finance_summary', 'create_cash_entry', 'send_payment_reminder', 'recent_activity', 'buddy_activity', 'team_pulse', 'list_clients']) {
      expect(names).not.toContain(hidden);
    }
    const priv = fakeCtx({ perms });
    expect(allowed(getTool('recent_activity'), priv)).toBe(true);
  });

  it('tells the model where it is, and that Telegram confirmations are taps', () => {
    const ctx = fakeCtx();
    ctx.channel = 'telegram';
    ctx.audience = 'shared';
    const prompt = buildSystemPrompt(ctx, toolsFor(ctx));
    expect(prompt).toMatch(/SHARED SPACE/);
    expect(prompt).toMatch(/tapping its buttons in Telegram/);
    expect(prompt).toMatch(/Review and then Confirm, in a private chat/);
  });

  it('marks a Daily Pulse reply in the turn context only when it is one', () => {
    const ctx = fakeCtx();
    expect(buildTurnContext(ctx)).not.toMatch(/DAILY CHECK-IN/);
    ctx.source = 'pulse:abc';
    expect(buildTurnContext(ctx)).toMatch(/DAILY CHECK-IN/);
  });
});

describe('add_task_note', () => {
  const T1 = '11111111-1111-4111-8111-111111111111';
  const seed = () => fakeDb({
    tasks: [{ id: T1, org_id: 'org-1', title: 'Payment integration', status: 'in_progress', priority: 'high', deadline: null, assignee_id: null, assignee_label: null, project_id: null, notes: 'Started.', updated_at: '2026-09-20T10:00:00+00:00' }],
  });

  it('flags a blocker by appending a dated line, and re-resolves from its canonical args', async () => {
    const db = seed();
    const ctx = fakeCtx({ db, today: '2026-09-26' });
    const tool = getTool('add_task_note');
    const r = await tool.resolve({ task: 'payment integration', note: 'Need API access', blocker: true }, ctx);
    expect(r.args).toEqual({ tasks: [T1], note: 'Need API access', blocker: true });
    // The confirm path resolves the stored args again.
    const again = await tool.resolve(r.args, ctx);
    expect(again.args).toEqual(r.args);
    const preview = await tool.preview(r.args, ctx);
    expect(preview.title).toBe('Flag task as blocked');
    const plan = await tool.plan(r.args, ctx);
    const outcome = await applyPlan(db, plan);
    expect(db.tables.tasks[0].notes).toBe('Started.\n26 Sep 2026 — Blocked: Need API access');
    expect(tool.summary(outcome, r.args)).toBe('Flagged “Payment integration” as blocked: Need API access');
  });

  it('asks for the note when there is none', async () => {
    const r = await getTool('add_task_note').resolve({ task: 'payment', blocker: true }, fakeCtx({ db: seed() }));
    expect(r.needs).toMatchObject({ kind: 'input', question: 'What is blocking it?' });
  });
});

describe('channel identity refusals', () => {
  it('revokes links only when StartupBuddy access really ended', async () => {
    const { ChannelAccessError } = await import('../agent/channelSession.js');
    for (const reason of ['account', 'banned', 'membership', 'revoked']) expect(new ChannelAccessError(reason).ended).toBe(true);
    const role = new ChannelAccessError('role', { role: 'employee' });
    expect(role.ended).toBe(false);
    expect(role.role).toBe('employee');
  });
});
