import { money, formatDate } from '../helpers.js';
import { cofounderOf } from '../cofounders.js';
import { PAGES } from '../tools/navigate.js';

/**
 * Words for results, without a model.
 *
 * Every figure, name and date in a reply is taken from the tool's own result
 * — the same result the model would have been handed — so a templated answer
 * cannot say something the records do not. A template only chooses the
 * sentence: singular or plural, the empty case, what to lead with.
 *
 * The cofounder colours the wording (a short remark of theirs where one fits)
 * and nothing else: the intent, the arguments, the figures and the view are
 * identical whoever is speaking.
 *
 * A renderer returns { text, show } — `show` says whether the tool's view (a
 * list, figures) goes under the words — or { ask } to put one question back.
 */

/* ── voice ────────────────────────────────────────────────────────────────── */

const VOICE = {
  steve: {
    clear: 'Clean.', warn: 'Deal with this first.', empty: 'Nothing there.', ack: 'Good.', thanks: 'Any time. What is next?',
    bye: 'Go build.', dropped: 'Dropped. Nothing was changed.', wont: 'Fine. I have left it alone.',
  },
  elon: {
    clear: 'Zero. Good.', warn: 'That is the bottleneck.', empty: 'Nothing. Zero.', ack: 'Okay.', thanks: 'Sure. Next.',
    bye: 'Later.', dropped: 'Deleted. Nothing changed.', wont: 'Okay. Not doing it.',
  },
  mark: {
    clear: 'All clear.', warn: 'Worth moving on this week.', empty: 'Nothing yet.', ack: 'Got it.', thanks: 'Anytime. What else?',
    bye: 'Talk soon.', dropped: 'Dropped it. Nothing was changed.', wont: 'Understood. I have not touched it.',
  },
};

function persona(ctx) {
  let who = null;
  try { who = cofounderOf(ctx.persona); } catch { /* the wording falls back to plain */ }
  const id = who?.id && VOICE[who.id] ? who.id : 'steve';
  return { id, name: who?.name || 'Buddy', opener: who?.opener || null, closer: who?.closer || null, say: VOICE[id] };
}

/* ── small pieces ─────────────────────────────────────────────────────────── */

const s = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const are = (n) => (n === 1 ? 'is' : 'are');
const join = (parts, sep = ' ') => parts.filter(Boolean).join(sep);
const cut = (text, n = 80) => (String(text).length > n ? `${String(text).slice(0, n - 1)}…` : String(text));

/**
 * A short list, named. "What are my tasks?" is answered with the tasks, not with
 * how many there are — so when everything that matched fits in a sentence, the
 * sentence says what they are. Longer lists keep the count; the list is under it.
 */
const named = (rows, total, each, max = 5) => (rows?.length && rows.length === total && total <= max ? `: ${rows.map(each).join('; ')}` : '');

/** "last month" → "last month"; "September 2026" → "in September 2026". */
export function when(period) {
  const label = period?.label;
  if (!label) return '';
  if (label === 'all time') return 'to date';
  if (/^(?:this|last|next|today|yesterday|tomorrow|since)\b/.test(label)) return label;
  if (/^the last\b/.test(label)) return `in ${label}`;
  if (/^[A-Z][a-z]+ \d{4}$/.test(label)) return `in ${label}`;
  if (/–/.test(label)) return `between ${label.replace(' – ', ' and ')}`;
  return `on ${label}`;
}

const entity = (decision, param) => decision.entities?.find((e) => e.param === param)?.label || null;
const more = (data, key = 'showing') => (data.total_matching > (data[key] ?? data.total_matching) ? ` Showing the first ${data[key]}.` : '');

/** What a tool says when it could not place a name, or could not read. */
function stopped(data, decision) {
  if (!data || typeof data !== 'object') return { text: 'I could not read that just now. Try again in a moment.' };
  if (data.error) return { text: `${String(data.error).replace(/\.$/, '')} just now. Try again in a moment.`, failed: true };
  if (data.unavailable) return { text: String(data.unavailable) };
  if (data.ambiguous) {
    const options = Array.isArray(data.candidates) ? data.candidates.slice(0, 5) : [];
    const said = data.said || (typeof data.ambiguous === 'string' ? data.ambiguous : 'that');
    const param = Object.entries(decision.parameters || {}).find(([, v]) => v === said)?.[0] || null;
    if (!options.length || !param) return { text: `“${said}” matches more than one ${data.kind || 'record'}. Which one did you mean?` };
    return { ask: { param, question: `Which ${data.kind === 'employee' ? 'person' : data.kind || 'one'} did you mean by “${said}”?`, options: options.map((label) => ({ label, value: label })) } };
  }
  if (data.not_found) {
    const said = data.said || (typeof data.not_found === 'string' ? data.not_found : null);
    return { text: said ? `I looked for ${data.kind ? `a ${data.kind === 'employee' ? 'person' : data.kind} called ` : ''}“${said}” and found none.` : 'I looked and found nothing matching that.' };
  }
  return null;
}

/* ── renderers ────────────────────────────────────────────────────────────── */

const R = {
  finance({ data, view, params }, ctx, v) {
    const items = view?.items || [];
    if (!items.length) return { text: 'There are no money figures to show yet.' };
    const by = (label) => items.find((i) => i.label === label);
    const cash = by('Net cash');
    const owed = by('Owed to you');
    const overdue = by('Overdue');
    const owe = by('You owe');
    const revenue = by('Revenue');
    const paidOut = by('Paid out');
    const asOf = data.as_of ? ` (as of ${data.as_of})` : '';
    const lead = params.focus === 'cash' && cash
      ? `Net cash is **${cash.value}**${asOf}.`
      : `Here is where the money stands${asOf}.${cash ? ` Net cash **${cash.value}**.` : ''}`;
    const rest = join([
      owed && `You are owed ${owed.value}${overdue && overdue.tone === 'r' ? `, ${overdue.value} of it overdue` : ''}.`,
      !owed && overdue && overdue.tone === 'r' && `${overdue.value} is overdue.`,
      owe && owe.tone !== 'g' && `You owe vendors ${owe.value}.`,
      params.focus !== 'cash' && revenue && `Revenue to date ${revenue.value}.`,
      params.focus !== 'cash' && paidOut && `Paid out ${paidOut.value}.`,
    ]);
    const tail = overdue && overdue.tone === 'r' ? v.say.warn : cash && cash.tone === 'r' ? 'Cash is negative.' : '';
    return { text: join([lead, rest, tail]), show: true };
  },

  period_money({ data, params, decision }, ctx, v) {
    const p = decision.period ? when(decision.period) : 'this month so far';
    const focus = params.focus || 'flow';
    const note = data.note ? ` (${data.note})` : '';
    if (focus === 'revenue') {
      if (data.invoiced === null && data.money_in === null) return { text: 'Your role cannot see the money that came in.' };
      const a = data.invoiced !== null ? (data.invoices_issued ? `**${data.invoiced}** invoiced across ${s(data.invoices_issued, 'invoice')} ${p}` : `Nothing was invoiced ${p}`) : null;
      const b = data.money_in !== null ? `**${data.money_in}** came in` : null;
      return { text: `${join([a, b], '; ')}.`, show: true };
    }
    if (focus === 'expenses') {
      if (data.money_out === null) return { text: 'Your role cannot see expenses.' };
      const top = data.spending_by_category || [];
      if (!top.length) return { text: `Nothing is recorded as spent ${p}.${note}` };
      const most = top.length > 1 ? ` Most on ${top[0].category.toLowerCase()} (${top[0].amount}), then ${top[1].category.toLowerCase()} (${top[1].amount}).` : ` All of it on ${top[0].category.toLowerCase()}.`;
      return { text: `**${data.money_out}** spent ${p}.${most}${note}`, show: true };
    }
    if (data.net === null) return { text: join([data.money_in !== null && `**${data.money_in}** came in ${p}.`, data.money_out !== null && `**${data.money_out}** went out ${p}.`]) || 'Your role cannot see the cash book.', show: true };
    return { text: `${p[0].toUpperCase()}${p.slice(1)}: **${data.money_in}** in, **${data.money_out}** out — net **${data.net}**.${data.net_is_positive === false ? ` ${v.say.warn}` : ''}${note}`, show: true };
  },

  invoices({ data, params, decision }, ctx, v) {
    // Out loud, a document number is noise: who and how much is what is heard.
    const spoken = ctx?.voice === true || ctx?.channel === 'voice';
    const doc = (d, tail) => `${spoken ? '' : `${d.number} `}${d.client || ''} ${tail}`.replace(/\s+/g, ' ').trim();
    const type = data.type || params.type || 'invoice';
    const n = data.total_matching;
    const who = entity(decision, 'client');
    const forWho = who ? ` for ${who}` : '';
    const p = decision.period ? ` issued ${when(decision.period)}` : '';
    if (params.overdue) {
      if (!n) return { text: `No ${type}s are overdue${forWho}. ${v.say.clear}` };
      return { text: `**${s(n, `overdue ${type}`)}**${forWho}${p}, ${data.total_balance_due} outstanding${named(data.documents, n, (d) => doc(d, `${d.balance}${d.due ? `, due ${d.due}` : ''}`))}. ${v.say.warn}${more(data)}`, show: true };
    }
    if (params.unpaid) {
      if (!n) return { text: `No unpaid ${type}s${forWho}${p}. ${who ? `${who} owes nothing` : 'Nobody owes you anything'} right now.` };
      const late = data.overdue_among_them ? ` ${data.overdue_among_them} ${are(data.overdue_among_them)} overdue.` : ' None overdue yet.';
      return { text: `**${s(n, `unpaid ${type}`)}**${forWho}${p}, ${data.total_balance_due} to collect${named(data.documents, n, (d) => doc(d, `${d.balance}${d.overdue ? ' (overdue)' : ''}`))}.${late}${more(data)}`, show: true };
    }
    const status = params.status ? `${String(params.status).replace(/_/g, ' ')} ` : '';
    if (!n) return { text: `No ${status}${type}s${forWho}${p}.` };
    const due = data.total_balance_due && !/^₹0(?:\.00)?$/.test(data.total_balance_due) && params.status !== 'paid' ? `, ${data.total_balance_due} still due` : '';
    return { text: `**${s(n, `${status}${type}`)}**${forWho}${p}, worth ${data.total_value}${due}${named(data.documents, n, (d) => doc(d, `${d.total}${params.status ? '' : ` (${String(d.status).replace(/_/g, ' ')})`}`))}.${more(data)}`, show: true };
  },

  bills({ data, params, decision }, ctx, v) {
    const n = data.total_matching;
    const who = entity(decision, 'vendor');
    const from = who ? ` from ${who}` : '';
    if (params.status === 'overdue') return n ? { text: `**${s(n, 'vendor bill')}** overdue${from}, ${data.total_owed} owed. ${v.say.warn}`, show: true } : { text: `No vendor bills are overdue${from}. ${v.say.clear}` };
    if (params.status === 'open') return n ? { text: `You owe **${data.total_owed}** across ${s(n, 'open vendor bill')}${from}.`, show: true } : { text: `Nothing is owed to vendors${from} right now.` };
    return n ? { text: `**${s(n, `${params.status ? `${params.status} ` : ''}vendor bill`)}**${from}, ${data.total_owed} still owed.`, show: true } : { text: `No vendor bills${from}.` };
  },

  tasks({ data, params, decision }, ctx, v) {
    const n = data.total_matching;
    const mine = params.assignee === 'me';
    const who = entity(decision, 'assignee');
    const owner = mine ? ' on your plate' : who ? ` with ${who}` : '';
    const scope = join([entity(decision, 'project') && `in ${entity(decision, 'project')}`, entity(decision, 'client') && `for ${entity(decision, 'client')}`, params.text && `matching “${params.text}”`]);
    const where = `${owner}${scope ? ` ${scope}` : ''}`;
    const due = decision.period && (params.due_after || params.due_before) ? ` due ${when(decision.period)}` : '';
    if (params.status === 'overdue') return n ? { text: `**${s(n, 'overdue task')}**${where}${named(data.tasks, n, (t) => `${t.title}${t.deadline ? ` (due ${t.deadline})` : ''}${t.assignee && !mine && !who ? `, ${t.assignee}` : ''}`)}. ${v.say.warn}${more(data)}`, show: true } : { text: `No overdue tasks${where}. ${v.say.clear}` };
    if (params.status === 'done') return n ? { text: `**${s(n, 'finished task')}**${where}${named(data.tasks, n, (t) => t.title)}.${more(data)}`, show: true } : { text: `No finished tasks${where}.` };
    if (!n) return { text: `No open tasks${where}${due}. ${v.say.clear}` };
    const late = data.overdue_among_them ? ` ${data.overdue_among_them} ${are(data.overdue_among_them)} overdue.` : '';
    // Asked what the tasks are, the answer names them: a count alone answers "how many".
    const rows = data.tasks || [];
    const list = named(rows, n, (t) => `${t.title}${t.deadline ? ` (due ${t.deadline}${t.overdue ? ', overdue' : ''})` : ''}`);
    return { text: `**${s(n, 'open task')}**${where}${due}${list}.${list ? '' : late}${more(data)}`, show: true };
  },

  projects({ data, params, decision }, ctx, v) {
    const n = data.total_matching;
    const who = entity(decision, 'client');
    const forWho = who ? ` for ${who}` : '';
    if (params.health) return n ? { text: `**${s(n, 'project')}** ${n === 1 ? 'needs' : 'need'} attention${forWho}. ${v.say.warn}`, show: true } : { text: `No projects are at risk${forWho}. ${v.say.clear}` };
    if (!n) return { text: `No ${params.status === 'completed' ? 'completed' : 'open'} projects${forWho}.` };
    const late = (data.projects || []).filter((p) => p.overdue_tasks > 0).length;
    return { text: `**${s(n, `${params.status === 'completed' ? 'completed' : 'open'} project`)}**${forWho}${named(data.projects, n, (p) => `${p.name}${p.client ? ` for ${p.client}` : ''}${p.target_end ? `, due ${p.target_end}` : ''}`)}.${late ? ` ${late} ${late === 1 ? 'has' : 'have'} overdue tasks.` : ''}${more(data)}`, show: true };
  },

  team({ data, decision }) {
    const n = data.total_people;
    if (!n) return { text: 'There is nobody on the team list yet.' };
    const people = data.people || [];
    if (entity(decision, 'person') && people[0]) {
      const p = people[0];
      return { text: `**${p.name}**${p.role ? ` (${p.role})` : ''} has ${s(p.open_tasks, 'open task')}${p.overdue ? `, ${p.overdue} overdue` : ''}${p.due_this_week ? `, ${p.due_this_week} due this week` : ''}.${p.next_up?.[0] ? ` Next up: ${cut(p.next_up[0], 60)}.` : ''}`, show: false };
    }
    const busiest = people[0];
    const lightest = [...people].sort((a, b) => a.open_tasks - b.open_tasks)[0];
    const spread = busiest && lightest && busiest.name !== lightest.name && busiest.open_tasks > 0
      ? ` ${busiest.name} carries the most (${s(busiest.open_tasks, 'open task')}); ${lightest.name} the least (${lightest.open_tasks}).` : '';
    const loose = data.unassigned_open_tasks ? ` ${s(data.unassigned_open_tasks, 'open task')} ${data.unassigned_open_tasks === 1 ? 'has' : 'have'} no owner.` : '';
    // Asked who is on the team, the answer is their names — in words too, for a
    // channel with no list under them (a call, Telegram).
    const names = people.length <= 12 ? `: ${people.map((p) => `${p.name}${p.role ? ` (${p.role})` : ''}`).join(', ')}` : '';
    return { text: `**${s(n, 'person', 'people')}** on the team${names}.${spread}${loose}`, show: true };
  },

  vendors({ data }) {
    const n = data.total;
    if (!n) return { text: 'There are no vendors yet.' };
    const rows = data.vendors || [];
    return { text: `**${s(n, 'vendor')}**: ${rows.slice(0, 10).map((v) => v.name).join(', ')}.${n > 10 ? ` And ${n - 10} more.` : ''}`, show: true };
  },

  catalog({ data, params }) {
    const n = data.total;
    if (!n) return { text: params.text ? `There is nothing called “${params.text}” in the catalogue.` : 'There is nothing in the catalogue yet.' };
    const rows = data.items || [];
    if (params.text && n === 1) return { text: `**${rows[0].name}** is ${rows[0].price} per ${rows[0].unit}, GST ${rows[0].gst}.` };
    return { text: `**${s(n, 'item')}** in the catalogue: ${rows.slice(0, 8).map((i) => `${i.name} (${i.price} per ${i.unit})`).join(', ')}.${n > 8 ? ` And ${n - 8} more.` : ''}`, show: true };
  },

  departments({ data }) {
    const n = data.total;
    if (!n) return { text: 'No departments are set up yet.' };
    const loose = data.unassigned_people ? ` ${s(data.unassigned_people, 'person', 'people')} ${are(data.unassigned_people)} in no department.` : '';
    return { text: `**${s(n, 'department')}**: ${(data.departments || []).map((d) => `${d.name} (${d.people})`).join(', ')}.${loose}`, show: true };
  },

  company({ data }) {
    const d = data.details || {};
    const LABEL = { name: 'name', tagline: 'tagline', address: 'address', phone: 'phone number', email: 'email', website: 'website' };
    if (data.field === 'signatory') {
      return { text: d.signatory ? `Documents are signed by **${d.signatory}**${d.signatory_title ? `, ${d.signatory_title}` : ''}.` : 'No signatory is saved in the company profile yet.' };
    }
    if (data.field && LABEL[data.field]) {
      return { text: d[data.field] ? `The company ${LABEL[data.field]} is **${d[data.field]}**.` : `No ${LABEL[data.field]} is saved in the company profile yet.` };
    }
    const lines = join([
      d.name && `**${d.name}**${d.tagline ? ` — ${d.tagline}` : ''}.`,
      d.address && `${d.address}.`,
      join([d.phone, d.email, d.website], ' · '),
      d.signatory && `Signed by ${d.signatory}${d.signatory_title ? `, ${d.signatory_title}` : ''}.`,
    ]);
    return { text: lines || 'The company profile is empty so far.', show: true };
  },

  announcements({ data }) {
    const n = data.total;
    if (!n) return { text: 'There are no announcements up right now.' };
    const rows = data.announcements || [];
    return { text: `**${s(n, 'announcement')}** up: ${rows.slice(0, 5).map((a) => `${a.title}${a.says ? ` — ${cut(a.says, 90)}` : ''}`).join('; ')}.`, show: n > 1 };
  },

  my_time({ data, decision }) {
    const p = decision.period ? when(decision.period) : 'this week';
    if (!data.entries) return { text: `You have logged no time ${p}.` };
    const split = (data.by_project || []).map((x) => `${x.project} ${x.time}`).join(', ');
    const draft = data.not_submitted ? ` ${s(data.not_submitted, 'entry', 'entries')} ${are(data.not_submitted)} not submitted yet.` : '';
    return { text: `You have logged **${data.total}** ${p}: ${split}.${draft}`, show: (data.by_project || []).length > 2 };
  },

  letters({ data }) {
    const n = data.total_matching;
    const kind = data.kind ? data.kind.replace(/^Offer letter$/, 'offer letter') : 'letter';
    if (!n) return { text: `There are no ${kind}s yet.` };
    const rows = data.letters || [];
    return { text: `**${s(n, kind)}**: ${rows.slice(0, 6).map((r) => `${r.for} (${r.number}, ${String(r.status).toLowerCase()})`).join(', ')}.${more(data)}`, show: true };
  },

  leave_balance({ data }) {
    const types = data.types || [];
    if (!types.length) return { text: 'No leave types are set up yet.' };
    const all = `${types.map((t) => `${t.name} (${t.per_year} a year)`).join(', ')}`;
    if (data.mine) {
      if (!data.linked) return { text: `You are not linked to a person in Team, so I cannot see a balance for you. The leave types are: ${all}.` };
      if (!data.has_balances) return { text: `I cannot see a leave balance for you yet. The leave types are: ${all}.` };
      return { text: `You have ${types.filter((t) => t.left !== null).map((t) => `**${t.left}** of ${t.per_year} days of ${t.name} left`).join(', and ')}.` };
    }
    return { text: `**${s(types.length, 'leave type')}**: ${all}.`, show: data.has_balances };
  },

  leave({ data, params, decision }) {
    const n = data.total_matching;
    const who = entity(decision, 'employee');
    const p = decision.period ? when(decision.period) : (params.from && params.from === params.to ? 'today' : '');
    const rows = data.requests || [];
    if (params.status === 'pending') return n ? { text: `**${s(n, 'leave request')}** waiting for approval${who ? ` from ${who}` : ''}: ${rows.slice(0, 5).map((r) => `${r.employee} (${r.from}${r.to !== r.from ? ` – ${r.to}` : ''})`).join('; ')}.` } : { text: 'No leave requests are waiting for approval.' };
    if (!n) return { text: who ? `${who} has no leave${p ? ` ${p}` : ' on record'}.` : `Nobody is on leave${p ? ` ${p}` : ''}.` };
    const list = rows.slice(0, 6).map((r) => `${r.employee || 'Someone'}${r.type ? ` (${r.type.toLowerCase()})` : ''}: ${r.from}${r.to !== r.from ? ` – ${r.to}` : ''}${r.status !== 'approved' ? `, ${r.status}` : ''}`).join('; ');
    return { text: `**${s(n, 'leave request')}**${p ? ` ${p}` : ''}${who ? ` for ${who}` : ''}: ${list}.${n > rows.length ? ` And ${n - rows.length} more.` : ''}` };
  },

  attendance({ data, decision }) {
    const who = entity(decision, 'employee');
    const span = data.from === data.to ? `on ${data.from}` : `from ${data.from} to ${data.to}`;
    if (!data.marked_days) return { text: `No attendance is marked ${span}${who ? ` for ${who}` : ''}.` };
    const counts = Object.entries(data.by_status || {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${String(k).replace(/_/g, ' ')}`).join(', ');
    const absent = data.from === data.to ? (data.days || []).filter((d) => /absent/i.test(d.status)).map((d) => d.employee).filter(Boolean) : [];
    return { text: `Attendance ${span}${who ? ` for ${who}` : ''}: ${counts}.${absent.length ? ` Absent: ${absent.slice(0, 8).join(', ')}.` : ''}` };
  },

  pulse({ data }) {
    if (!data.asked) return { text: `Nobody was sent a check-in on ${data.day}.` };
    const waiting = (data.people || []).filter((p) => !p.answered).map((p) => p.name);
    return { text: `**${data.answered} of ${data.asked}** checked in on ${data.day}.${waiting.length ? ` Still waiting on ${waiting.slice(0, 6).join(', ')}.` : ' Everyone answered.'}`, show: true };
  },

  clients({ data, params }) {
    const n = data.total_matching;
    if (params.inactive_days) return n ? { text: `**${s(n, 'lead')}** quiet for ${params.inactive_days}+ days. Open pipeline is worth ${data.open_pipeline_value}.${more(data)}`, show: true } : { text: `No leads have been quiet for ${params.inactive_days}+ days.` };
    const stages = Object.entries(data.by_stage || {}).map(([k, x]) => `${x.count} ${k.toLowerCase()}`).join(', ');
    const label = { pipeline: 'in the open pipeline', lead: 'at lead stage', deal: 'at deal stage', lost: 'marked lost', contacted: 'contacted' }[params.stage];
    if (!n) return { text: label ? `Nobody is ${label} right now.` : 'There are no clients yet.' };
    return { text: `**${s(n, 'client')}**${label ? ` ${label}` : ''}${named(data.clients, n, (c) => `${c.name}${c.stage ? ` (${String(c.stage).toLowerCase()})` : ''}`, 8)}.${stages ? ` Across the book: ${stages}.` : ''} Open pipeline is worth ${data.open_pipeline_value}.${more(data)}`, show: true };
  },

  documents({ data, params }) {
    const n = data.total_matching;
    const about = params.text ? ` matching “${params.text}”` : '';
    if (!n) return { text: `No documents in the library${about}.` };
    return { text: `**${s(n, 'document')}**${about} in the library.${more(data)}`, show: true };
  },

  insights({ data }, ctx, v) {
    if (!data.total) return { text: `Nothing stands out right now: no overdue invoices, slipping work or risks. ${v.say.clear}` };
    const top = data.insights?.[0];
    return { text: `**${s(data.total, 'thing')}** ${data.total === 1 ? 'needs' : 'need'} you.${top ? ` First: ${cut(top.title, 110)}${top.reason ? ` (${cut(top.reason, 90)})` : ''}.` : ''}`, show: true };
  },

  activity({ data }) {
    if (!data.total_changes) return { text: `Nothing was changed between ${data.from} and ${data.to}.` };
    const counts = Object.entries(data.counts || {}).slice(0, 5).map(([k, n]) => `${n} ${k.toLowerCase()}`).join(', ');
    return { text: `**${s(data.total_changes, 'change')}** between ${data.from} and ${data.to}${counts ? `: ${counts}` : ''}.${data.changes_made_through_buddy ? ` ${data.changes_made_through_buddy} went through me.` : ''}${data.note ? ` ${data.note}` : ''}`, show: true };
  },

  buddy_activity({ data }) {
    if (!data.total) return { text: 'I have not proposed or done anything for you in that time.' };
    const by = {};
    for (const a of data.actions || []) by[a.status] = (by[a.status] || 0) + 1;
    const counts = Object.entries(by).map(([k, n]) => `${n} ${k}`).join(', ');
    const failed = (data.actions || []).find((a) => a.status === 'failed');
    return { text: `**${s(data.total, 'action')}** from me recently: ${counts}.${failed ? ` One failed: ${cut(failed.what, 80)}. Its card offers Try again.` : ''}`, show: true };
  },

  record({ data, params }) {
    const r = data.record || {};
    const f = params.facet || 'all';
    const none = (what, name) => ({ text: `There is no ${what} on file for ${name}.` });
    if (data.type === 'task') {
      const status = r.overdue ? 'overdue' : String(r.status || '').replace(/_/g, ' ');
      const due = r.deadline ? formatDate(r.deadline) : null;
      if (f === 'who') return { text: r.assignee ? `**${r.assignee}** has “${r.title}” (${status}${due ? `, due ${due}` : ''}).` : `Nobody is assigned to “${r.title}” yet.` };
      if (f === 'when') return { text: due ? `“${r.title}” is due **${due}**${r.overdue ? ', so it is overdue' : ''}.` : `“${r.title}” has no deadline.` };
      if (f === 'status') return { text: `“${r.title}” is ${status}.` };
      if (f === 'priority') return { text: `“${r.title}” is ${r.priority || 'medium'} priority.` };
      return { text: `**${r.title}** — ${status}${due ? `, due ${due}` : ', no deadline'}, ${r.assignee ? `with ${r.assignee}` : 'unassigned'}${r.project ? `, in ${r.project}` : ''}${r.priority && r.priority !== 'medium' ? `, ${r.priority} priority` : ''}.` };
    }
    if (data.type === 'client') {
      const stage = { active: 'deal', lead: 'lead', contacted: 'contacted', lost: 'lost', archived: 'archived' }[r.status] || r.status;
      if (f === 'email') return r.email ? { text: `${r.name}: ${r.email}` } : none('email', r.name);
      if (f === 'phone') return r.phone ? { text: `${r.name}: ${r.phone}` } : none('phone number', r.name);
      if (f === 'contact') return r.person_name || r.email || r.phone ? { text: `${r.name}: ${join([r.person_name, r.email, r.phone], ', ')}.` } : none('contact', r.name);
      if (f === 'stage' || f === 'status') return { text: `${r.name} is at ${stage} stage.` };
      return { text: `**${r.name}** — ${stage} stage${r.person_name ? `, contact ${r.person_name}` : ''}${r.email ? `, ${r.email}` : ''}${r.phone ? `, ${r.phone}` : ''}${Number(r.value) ? `, worth ${money(r.value)}` : ''}.` };
    }
    if (data.type === 'employee') {
      if (f === 'email') return r.email ? { text: `${r.full_name}: ${r.email}` } : none('email', r.full_name);
      if (f === 'role') return r.role ? { text: `${r.full_name} is ${r.role}.` } : none('role', r.full_name);
      return { text: `**${r.full_name}**${r.role ? ` — ${r.role}` : ''}${r.email ? `, ${r.email}` : ''}${r.exited_at ? ' (no longer with the company)' : ''}.` };
    }
    if (data.type === 'project') {
      if (f === 'status') return { text: `${r.name} is ${String(r.status).replace(/_/g, ' ')}.` };
      return { text: `**${r.code ? `${r.code} · ` : ''}${r.name}** — ${String(r.status).replace(/_/g, ' ')}${r.client ? `, for ${r.client}` : ''}.` };
    }
    if (data.type === 'invoice') {
      const cur = r.currency || 'INR';
      const name = r.doc_number || `Draft ${r.type}`;
      const due = r.due_date ? formatDate(r.due_date) : null;
      if (f === 'balance') return { text: `${name}: **${money(r.balance, cur)}** still due of ${money(r.grand_total, cur)}.` };
      if (f === 'when') return { text: due ? `${name} is due **${due}**.` : `${name} has no due date.` };
      if (f === 'status') return { text: `${name} is ${String(r.status).replace(/_/g, ' ')}.` };
      return { text: `**${name}**${r.bill_to_name ? ` for ${r.bill_to_name}` : ''}: ${money(r.grand_total, cur)}, ${String(r.status).replace(/_/g, ' ')}${Number(r.balance) > 0.005 && r.status !== 'draft' ? `, ${money(r.balance, cur)} still due` : ''}${due ? `, due ${due}` : ''}.` };
    }
    if (data.type === 'vendor') {
      if (f === 'email') return r.email ? { text: `${r.company_name}: ${r.email}` } : none('email', r.company_name);
      return { text: `**${r.company_name}**${r.contact_name ? ` — contact ${r.contact_name}` : ''}${r.email ? `, ${r.email}` : ''}.` };
    }
    return { text: 'I found it, but have nothing to show for that kind of record.' };
  },

  search({ data }) {
    const hits = data.results || [];
    if (!hits.length) return { text: `Nothing called “${data.query}” in what you can see.` };
    return { text: `**${s(hits.length, 'match', 'matches')}** for “${data.query}”: ${hits.slice(0, 6).map((h) => `${h.name} (${h.type === 'employee' ? 'person' : h.type})`).join('; ')}.` };
  },

  navigate({ data, params }) {
    return { text: params.note || '', show: false, opened: data.opened };
  },
};

/** The words (and whether to show the view) for one tool result. */
export function renderResult(kind, payload, ctx) {
  const halted = stopped(payload.data, payload.decision);
  if (halted) return halted;
  const fn = R[kind];
  if (!fn) return { text: '' };
  try {
    return fn(payload, ctx, persona(ctx));
  } catch (err) {
    console.error(`[local] render ${kind}`, err);
    return { text: 'I have the result but could not put it into words. Open the list to see it.', show: true };
  }
}

/* ── talk, controls and sums ──────────────────────────────────────────────── */

export function renderGst({ amount, rate, inclusive }) {
  const r2 = (x) => Math.round(x * 100) / 100;
  if (inclusive) {
    const base = r2(amount / (1 + rate / 100));
    return `${money(amount)} including ${rate}% GST is ${money(base)} plus **${money(r2(amount - base))}** GST.`;
  }
  const tax = r2((amount * rate) / 100);
  return `${rate}% GST on ${money(amount)} is **${money(tax)}**, so ${money(r2(amount + tax))} in total.`;
}

export function renderTalk(intentId, ctx, params = {}) {
  const v = persona(ctx);
  const money$ = ctx.audience !== 'shared' && ctx.can?.('financial_documents', 'view');
  switch (intentId) {
    case 'GREETING': return `${v.opener || `${v.name} here.`} What do you need?`;
    case 'THANKS': return v.say.thanks;
    case 'ACKNOWLEDGE': return v.say.ack;
    case 'FAREWELL': return v.say.bye;
    case 'IDENTITY': return `I am ${v.name}, your cofounder in StartupBuddy. I answer from ${ctx.orgName || 'your company'}'s own records and prepare changes for you to confirm — nothing is written until you say so.`;
    case 'HELP': {
      const reads = join([money$ && '“who owes us money?”', '“what is overdue?”', '“what is on my plate this week?”', money$ && '“how much did we spend last month?”'], ', ');
      const writes = join(['“remind me to call Acme on Friday”', money$ && '“invoice Acme 50k for the website”', '“mark the pricing task done”'], ', ');
      return `I answer from your records — ${reads} — and I prepare changes as cards you confirm: ${writes}. For a plan, advice or a message to write, just ask in your own words.`;
    }
    case 'CONFIRM_HINT':
      return ctx.channel === 'telegram'
        ? 'Tap **Confirm** on the card to go ahead. A typed yes does not change anything.'
        : 'Tap the button on the card to confirm it. A typed yes does not change anything.';
    case 'UNDO_HINT': return 'Tap **Undo** on that card — it stays available for 10 minutes. I cannot undo from chat.';
    case 'CANCEL_PROPOSAL': return v.say.dropped;
    case 'DECLINED_COMMAND': return `${v.say.wont} Tell me what you want instead.`;
    case 'BARE_ANSWER': return params.said === 'no' ? v.say.ack : 'Yes to what? Tell me what you would like done.';
    case 'UNSUPPORTED_ACTION': {
      const page = PAGES[params.page]?.label;
      return `I can't ${params.doing || 'do that'} from chat${page ? `, so I have opened ${page} for you` : ''}.`;
    }
    default: return '';
  }
}

/* ── naming a reading, for "did you mean…?" ───────────────────────────────── */

const NOUN = {
  GET_CASH_BALANCE: 'the cash balance', GET_FINANCE_SUMMARY: 'the money figures', GET_MONTHLY_REVENUE: 'revenue', GET_EXPENSE_SUMMARY: 'spending',
  GET_CASH_FLOW: 'money in and out', GET_OUTSTANDING_INVOICES: 'unpaid invoices', GET_OVERDUE_PAYMENTS: 'overdue invoices', LIST_INVOICES: 'invoices',
  GET_VENDOR_BILLS: 'vendor bills', LIST_TASKS: 'open tasks', GET_OVERDUE_TASKS: 'overdue tasks', GET_OVERDUE_ITEMS: 'everything overdue',
  LIST_PROJECTS: 'projects', LIST_TEAM: 'the team and its workload', LIST_LEAVE: 'leave', GET_ATTENDANCE: 'attendance', GET_TEAM_PULSE: 'the team check-ins',
  LIST_CLIENTS: 'clients and the pipeline', SEARCH_COMPANY_DOCUMENTS: 'documents in the library', GET_INSIGHTS: 'what needs attention',
  GET_BUSINESS_OVERVIEW: 'a business overview', GET_RECENT_ACTIVITY: 'recent activity', GET_BUDDY_ACTIVITY: 'what I did', SEARCH_RECORDS: 'a search',
};

export function nameOf(decision) {
  const p = decision.parameters || {};
  const base = decision.intent === 'LIST_INVOICES' ? `${p.status ? `${p.status} ` : ''}${p.type || 'invoice'}s`
    : decision.intent === 'LIST_TASKS' && p.status === 'done' ? 'finished tasks'
      : NOUN[decision.intent] || decision.intent.toLowerCase().replace(/_/g, ' ');
  const who = (decision.entities || []).map((e) => e.label).filter(Boolean);
  return join([base, who.length && `for ${who.join(', ')}`, decision.period && when(decision.period)]);
}

export function pageLabel(key) {
  return PAGES[key]?.label || key;
}

/** Spoken replies carry no markdown. */
export function forChannel(text, ctx) {
  return ctx.voice || ctx.channel === 'voice' ? String(text).replace(/\*\*/g, '') : text;
}

/** When the model is unreachable: say so, and say what still works. */
export function modelDown(ctx, nearest = null) {
  const money$ = ctx.audience !== 'shared' && ctx.can?.('financial_documents', 'view');
  const tries = join([money$ && '“who owes us money?”', '“what is overdue?”', '“show my tasks”'], ', ');
  return `I could not reach the AI service for that one, so I have not guessed at an answer.${nearest ? '' : ` What I can do without it still works: ${tries}.`} Try again in a moment.`;
}
