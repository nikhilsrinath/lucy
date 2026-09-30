import { truncate, formatDate, readDate } from '../helpers.js';

/**
 * team_pulse — the founder's view of the Daily Pulse (../pulse.js): who
 * checked in on a day, what they said, and what it turned into.
 *
 * Read with the asker's own token: pulse_checkins is visible to owners and
 * admins for the whole org (0070), and ai_actions to them likewise (0068), so
 * RLS decides — the `available` check is for an honest answer, not safety.
 * Never offered in a shared space: replies can be personal.
 */

const STATUS_WORD = {
  proposed: 'waiting for their confirmation', confirmed: 'running', executed: 'done', failed: 'failed',
  cancelled: 'cancelled', expired: 'expired', undone: 'undone',
};

const team_pulse = {
  name: 'team_pulse',
  module: 'people',
  kind: 'read',
  permission: null,
  privateOnly: true,
  available: (ctx) => ctx.role === 'owner' || ctx.role === 'admin',
  description: 'The Daily Pulse: which teammates answered Buddy\'s end-of-day check-in on a day (default today), what they said, and the updates it led to (with their status). Use it for "how did the team\'s day go?", "any blockers today?", "who hasn\'t checked in?".',
  params: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'The day, as said ("today", "yesterday", "Monday") or YYYY-MM-DD.' },
    },
  },
  status: 'Reading the team pulse…',
  async run(args, ctx) {
    const day = args.date ? readDate(args.date, ctx.today, { prefer: 'past' }).value || ctx.today : ctx.today;
    const { data, error } = await ctx.db.from('pulse_checkins')
      .select('id, user_id, employee_id, pulse_date, channel, status, response, action_ids, asked_at, answered_at')
      .eq('org_id', ctx.orgId).eq('pulse_date', day).order('asked_at', { ascending: true });
    if (error) return { data: { unavailable: 'The Daily Pulse is not set up on this database yet (migration 0070).' } };
    const rows = data || [];

    const empIds = [...new Set(rows.map((r) => r.employee_id).filter(Boolean))];
    const actionIds = [...new Set(rows.flatMap((r) => r.action_ids || []))];
    const [emps, acts] = await Promise.all([
      empIds.length ? ctx.db.from('employees').select('id, full_name').in('id', empIds) : { data: [] },
      actionIds.length ? ctx.db.from('ai_actions').select('id, status, preview, tool').in('id', actionIds) : { data: [] },
    ]);
    const nameOf = new Map((emps.data || []).map((e) => [e.id, e.full_name]));
    const actOf = new Map((acts.data || []).map((a) => [a.id, a]));

    const people = rows.map((r) => ({
      name: nameOf.get(r.employee_id) || 'A teammate',
      answered: r.status === 'answered',
      said: r.response ? truncate(r.response, 400) : null,
      updates: (r.action_ids || []).map((id) => actOf.get(id)).filter(Boolean)
        .map((a) => ({ what: a.preview?.title || a.tool, status: STATUS_WORD[a.status] || a.status })),
    }));
    const answered = people.filter((p) => p.answered).length;
    return {
      data: { day: formatDate(day), asked: people.length, answered, not_answered: people.length - answered, people },
      view: {
        type: 'list',
        title: `Team pulse · ${formatDate(day)}`,
        total: people.length,
        items: people.map((p) => ({
          title: p.name,
          sub: p.said ? truncate(p.said, 120) : 'No reply yet',
          value: p.updates.length ? `${p.updates.length} update${p.updates.length === 1 ? '' : 's'}` : null,
          badge: p.answered ? 'Checked in' : 'Waiting',
          tone: p.answered ? 'g' : 'n',
        })),
      },
    };
  },
};

export default [team_pulse];
