import { getTool, allowed } from '../registry.js';
import { PLANNABLE, MAX_PLAN_STEPS } from '../plans.js';

/**
 * propose_plan — the model's way to answer a GOAL rather than a command.
 *
 * Its steps are calls to ordinary write tools, so the step arguments are the
 * union of those tools' own parameters (described per tool in its own schema,
 * which the model also has). The schema is built per request from the tools
 * this person may use, so a role that cannot create tasks is never offered
 * create_task as a step. Carried out by plans.js; see there for the rules.
 */

function mergedArgs(tools) {
  const props = {};
  for (const t of tools) {
    for (const [k, schema] of Object.entries(t.params?.properties || {})) {
      if (!props[k]) { props[k] = { ...schema }; continue; }
      const a = props[k];
      if (a.type !== schema.type) continue; // keep the first; the tool's own schema is authoritative
      if (JSON.stringify(a.enum || null) !== JSON.stringify(schema.enum || null)) {
        delete a.enum;
        a.description = `${a.description ? `${a.description} ` : ''}(Values depend on the step's tool.)`;
      }
    }
  }
  return props;
}

const propose_plan = {
  name: 'propose_plan',
  module: 'plan',
  kind: 'plan',
  permission: null,
  description: 'Propose a multi-step plan for a GOAL ("we launch the product in two weeks", "help me collect all overdue payments", '
    + '"prepare for tomorrow\'s client meeting", "we need to hire a developer"). First look at the relevant company data with read tools, '
    + 'then call this once with 2–12 concrete steps: each is a call to one of the listed write tools with that tool\'s own arguments and a short "why" '
    + 'grounded in what you found. The user reviews, edits and approves the whole plan on one card; nothing happens before that. '
    + 'Later steps may name something an earlier step creates (a task in the project created in step 1: pass the project\'s name).',
  params: {
    type: 'object',
    properties: {
      goal: { type: 'string' },
      summary: { type: 'string' },
      steps: { type: 'array', items: { type: 'object' } },
    },
    required: ['goal', 'steps'],
  },
  available(ctx) {
    return PLANNABLE.some((n) => allowed(getTool(n), ctx));
  },
  modelParams(ctx) {
    const tools = PLANNABLE.map(getTool).filter((t) => t && allowed(t, ctx));
    return {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'The goal, in the user\'s words.' },
        summary: { type: 'string', description: 'One or two sentences: the approach, and the company facts it rests on (figures, names, dates you found).' },
        steps: {
          type: 'array',
          maxItems: MAX_PLAN_STEPS,
          items: {
            type: 'object',
            properties: {
              tool: { type: 'string', enum: tools.map((t) => t.name) },
              why: { type: 'string', description: 'One short line: why this step, from the data.' },
              args: { type: 'object', description: 'The arguments for that tool, exactly as its own schema describes.', properties: mergedArgs(tools) },
            },
            required: ['tool', 'args'],
          },
        },
      },
      required: ['goal', 'summary', 'steps'],
    };
  },
  run() {
    // Never called: the loop hands a plan to plans.proposePlan.
    return { data: { error: 'propose_plan is handled by the planner.' } };
  },
};

export default [propose_plan];
