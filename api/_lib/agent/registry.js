import readTools from './tools/read.js';
import navigateTools from './tools/navigate.js';
import taskTools from './tools/tasks.js';
import clientTools from './tools/clients.js';
import cashTools from './tools/cash.js';
import financeTools from './tools/finance.js';
import companyTools from './tools/company.js';
import projectTools from './tools/projects.js';
import reminderTools from './tools/reminders.js';
import planTools from './tools/plan.js';
import pulseTools from './tools/pulse.js';

/**
 * The one catalogue of what EdgeAI can do.
 *
 * A module adds tools by adding a file under tools/ and listing it here — the
 * loop, the confirm path, the cards and the tests read everything they need
 * from the tool definition itself. See docs/edgeai-agent.md.
 *
 * Risk is decided here, per tool, never by the model:
 *   low   one-tap confirm card with a field diff, Undo for 10 minutes;
 *   high  a card rendering exactly what will happen, a button naming it,
 *         and a note when it cannot be undone. Money, anything leaving the
 *         org, deletes, people and permissions are high.
 */

export const ALL_TOOLS = [
  ...readTools,
  ...navigateTools,
  ...taskTools,
  ...clientTools,
  ...cashTools,
  ...financeTools,
  ...companyTools,
  ...projectTools,
  ...reminderTools,
  ...planTools,
  ...pulseTools,
];

const BY_NAME = new Map(ALL_TOOLS.map((t) => [t.name, t]));

export const getTool = (name) => BY_NAME.get(name) || null;

export const isWrite = (tool) => tool?.kind === 'write';

/**
 * Deleting is for users whose role allows it. A company person acting
 * through a linked channel identity (ctx.canDelete false) never deletes —
 * whatever the permission map says; the database refuses it too (0071).
 */
export const deletes = (tool) => tool?.kind === 'write' && tool.permission?.action === 'delete';

/**
 * A tool whose approval happens only in the StartupBuddy app (it emails
 * someone outside the company). Someone with no app login cannot approve it,
 * so it is never offered to them.
 */
export const appApprovalOnly = (tool) => tool?.approval === 'app';

/** May this user, on this plan, use this tool at all? */
export function allowed(tool, ctx) {
  if (!tool) return false;
  if (ctx.canDelete === false && deletes(tool)) return false;
  if (ctx.actor?.kind === 'person' && appApprovalOnly(tool)) return false;
  // A shared space (a team group) never gets the tools that read one
  // person's history or the company-wide audit trail — context.js.
  if (tool.privateOnly && ctx.audience === 'shared') return false;
  if (tool.available && !tool.available(ctx)) return false;
  if (tool.planFeature && !ctx.hasPlanFeature(tool.planFeature)) return false;
  if (!tool.permission) return true;
  return ctx.can(tool.permission.resource, tool.permission.action);
}

/** The tools this caller may be offered, as the model sees them. */
export function toolsFor(ctx) {
  return ALL_TOOLS.filter((t) => allowed(t, ctx));
}

const REASON_PARAM = {
  type: 'string',
  description: 'One short line on why, from the company data or the user\'s words (e.g. "18 days overdue, no reminder yet"). Shown on the card.',
};

export function toModelTools(tools, ctx = null) {
  return tools.map((t) => {
    // A tool may describe its parameters from the org's own data (the cash
    // tool lists the real categories, so the model picks one by meaning).
    let parameters = t.modelParams && ctx ? t.modelParams(ctx) : t.params;
    // Every write carries Buddy's one-line why, shown on the card and kept in
    // the audit log. It is stripped before the tool sees its arguments.
    if (t.kind === 'write') {
      parameters = { ...parameters, properties: { ...parameters.properties, reason: REASON_PARAM } };
    }
    return {
      type: 'function',
      function: {
        name: t.name,
        description: t.risk === 'high' ? `${t.description} (Needs the user's confirmation on a detailed card.)` : t.description,
        parameters,
      },
    };
  });
}

/** Is Undo on offer for this executed action? */
export function undoableFor(tool, args, ctx) {
  if (!tool || !isWrite(tool)) return false;
  // Undoing a creation deletes what it made — not for someone who cannot
  // delete. They edit or cancel it instead (or an admin removes it).
  if (ctx?.canDelete === false && tool.permission?.action === 'create') return false;
  return typeof tool.undoable === 'function' ? !!tool.undoable(args, ctx) : !!tool.undoable;
}

/**
 * The invariants the tests assert, as a function so a new tool file that
 * breaks one fails `npm test` rather than production. Returns problems.
 */
export function registryProblems(tools = ALL_TOOLS) {
  const problems = [];
  const names = new Set();
  for (const t of tools) {
    if (!t.name || !/^[a-z][a-z0-9_]{2,63}$/.test(t.name)) problems.push(`bad name: ${t.name}`);
    if (names.has(t.name)) problems.push(`duplicate tool: ${t.name}`);
    names.add(t.name);
    if (!t.description) problems.push(`${t.name}: no description`);
    if (t.params?.type !== 'object') problems.push(`${t.name}: params must be an object schema`);
    if (!['read', 'write', 'navigate', 'plan'].includes(t.kind)) problems.push(`${t.name}: kind must be read|write|navigate|plan`);
    if (t.kind === 'write') {
      if (!['low', 'high'].includes(t.risk)) problems.push(`${t.name}: a write tool needs risk low|high`);
      if (!t.permission?.resource || !['create', 'edit', 'delete'].includes(t.permission?.action)) {
        problems.push(`${t.name}: a write tool needs a create/edit/delete permission`);
      }
      for (const fn of ['resolve', 'validate', 'preview', 'plan', 'summary']) {
        if (typeof t[fn] !== 'function') problems.push(`${t.name}: missing ${fn}()`);
      }
      if (t.undoable === undefined) problems.push(`${t.name}: say whether it can be undone`);
      if (t.run) problems.push(`${t.name}: a write tool must not have run() — writes go through plan()`);
    } else if (typeof t.run !== 'function') {
      problems.push(`${t.name}: a ${t.kind} tool needs run()`);
    }
  }
  return problems;
}
