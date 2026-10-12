import { normalize } from '../resolvers.js';
import { askNext, change, q } from '../helpers.js';

/**
 * Announcements: a notice on the team's board, to everyone or one department
 * (0029). `department_id: null` means everyone; who can read one is decided
 * by the table's policy, not here. This is the board inside StartupBuddy — a
 * message in the Telegram group is send_telegram_group_message.
 */

async function departments(ctx) {
  if (ctx.cache?.has('departments')) return ctx.cache.get('departments');
  const { data } = await ctx.db.from('departments').select('id, name').eq('org_id', ctx.orgId);
  const rows = data || [];
  ctx.cache?.set('departments', rows);
  return rows;
}

const EVERYONE = /^(?:everyone|everybody|all|the whole team|whole team|the team|team|company|the company|whole company)$/i;
const yes = (v) => v === true || /^(?:true|yes|y|1|pinned|pin)$/i.test(String(v ?? ''));

function slotsFor(depts) {
  return [
    { key: 'title', question: 'What is the announcement’s title?', read: (raw) => ({ value: String(raw).replace(/\s+/g, ' ').trim().slice(0, 200) }) },
    { key: 'body', free: true, question: 'What should it say?', read: (raw) => ({ value: String(raw).trim().slice(0, 4000) }) },
    {
      key: 'audience', optional: true, when: () => depts.length > 0,
      question: 'Who is it for?',
      options: [{ label: 'Everyone', value: 'skip' }, ...depts.slice(0, 6).map((d) => ({ label: d.name, value: d.id }))],
      read: (raw) => {
        const s = String(raw).trim();
        if (EVERYONE.test(s)) return { value: null };
        const hit = depts.find((d) => d.id === s) || depts.find((d) => normalize(d.name) === normalize(s.replace(/\s+(?:department|dept|team)$/i, '')));
        return hit ? { value: hit.id } : { error: `There is no department called “${s}”.` };
      },
    },
  ];
}

const post_announcement = {
  name: 'post_announcement',
  module: 'people',
  kind: 'write',
  risk: 'low',
  permission: { resource: 'announcements', action: 'create' },
  description: 'Post a notice on the team\'s announcement board in StartupBuddy: "post an announcement", "announce that the office is closed on Monday". '
    + 'Pass `title` and `body` if the user gave them; a one-line announcement is both. For a message in the Telegram group use send_telegram_group_message.',
  params: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      body: { type: 'string', description: 'What it says, in the user\'s words.' },
      audience: { type: 'string', description: '"everyone" (default), or a department by name.' },
      is_pinned: { type: 'string', description: '"yes" to pin it to the top.' },
      expires_on: { type: 'string', description: 'The day it stops showing, optional.' },
    },
    required: [],
  },
  slots: [{ key: 'title' }, { key: 'body', free: true }, { key: 'audience', optional: true }],
  undoable: (_args, ctx) => ctx.can('announcements', 'delete'),

  async resolve(args, ctx) {
    const depts = await departments(ctx);
    const asked = await askNext(args, slotsFor(depts), ctx);
    if (asked.needs) return asked;
    const v = asked.values;
    const expires = /^\d{4}-\d{2}-\d{2}$/.test(String(args.expires_on || '')) ? args.expires_on : null;
    return { args: { title: v.title, body: v.body, audience: v.audience ?? null, is_pinned: yes(args.is_pinned) ? 'yes' : 'no', expires_on: expires } };
  },

  validate(args, ctx) {
    const problems = [];
    if (!args.title) problems.push('Give the announcement a title.');
    if (!args.body) problems.push('An announcement needs something to say.');
    if (args.expires_on && args.expires_on < ctx.today) problems.push('It would have expired before it was posted.');
    return problems;
  },

  async preview(args, ctx) {
    const dept = (await departments(ctx)).find((d) => d.id === args.audience);
    return {
      title: 'Post announcement',
      diff: [
        change('title', 'Title', null, args.title),
        change('body', 'Says', null, args.body),
        change('audience', 'For', null, dept ? dept.name : 'Everyone'),
        ...(yes(args.is_pinned) ? [change('is_pinned', 'Pinned', null, 'Yes')] : []),
      ],
      fields: [
        { key: 'title', label: 'Title', type: 'text', value: args.title },
        { key: 'body', label: 'Says', type: 'textarea', value: args.body },
        { key: 'is_pinned', label: 'Pin to the top', type: 'select', value: args.is_pinned, options: [{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }] },
        { key: 'expires_on', label: 'Stop showing after', type: 'date', value: args.expires_on || '' },
      ],
      confirmLabel: dept ? `Post to ${dept.name}` : 'Post to everyone',
    };
  },

  plan(args, ctx) {
    return [{
      op: 'insert', table: 'announcements',
      row: {
        org_id: ctx.orgId, title: args.title, body: args.body, department_id: args.audience || null,
        is_pinned: yes(args.is_pinned), expires_at: args.expires_on ? `${args.expires_on}T23:59:59Z` : null,
        ...(ctx.user?.id ? { created_by: ctx.user.id } : {}),
      },
    }];
  },

  summary(outcome) {
    const row = outcome.results[0]?.after;
    return row ? `Posted ${q(row.title)} to ${row.department_id ? 'the department' : 'everyone'}.` : `Not posted: ${outcome.results[0]?.error || 'it could not be saved.'}`;
  },
};

export default [post_announcement];
