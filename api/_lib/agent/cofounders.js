import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseSituations, parseRules, buildCofounder, validate } from '../../../src/shared/cofounders/parse.js';
import { COFOUNDER_IDS, DEFAULT_COFOUNDER_ID, resolveCofounderId } from '../../../src/shared/cofounders/legacy.js';

/**
 * The cofounders, as the server knows them: read once per instance from
 * cofounders/** (vercel.json ships that folder with every function) and
 * checked as they load — every cofounder has a playbook for every situation,
 * every action is in the vocabulary, every vector is in range. A broken file
 * fails the first request loudly instead of quietly changing behaviour.
 *
 * A cofounder is a mind and a manner. Tools, permissions, confirmations and
 * the shared rules (cofounders/_core/rules.md) are identical for all of them.
 */

const ROOT = new URL('../../../cofounders/', import.meta.url);
const read = (path) => readFileSync(fileURLToPath(new URL(path, ROOT)), 'utf8');

function load() {
  const core = parseSituations(read('_core/situations.md'));
  const rules = parseRules(read('_core/rules.md'));
  const cofounders = {};
  for (const id of COFOUNDER_IDS) {
    cofounders[id] = buildCofounder({
      profile: JSON.parse(read(`${id}/profile.json`)),
      persona: read(`${id}/persona.md`),
      mind: read(`${id}/mind.md`),
      playbooks: read(`${id}/playbooks.md`),
      examples: read(`${id}/examples.md`),
    });
  }
  const problems = validate(Object.values(cofounders), core);
  if (problems.length) throw new Error(`cofounders/ is invalid: ${problems.slice(0, 5).join('; ')}`);
  return { cofounders, situations: core.situations, actions: core.actions, cues: core.cues, metrics: core.metrics, rules };
}

let loaded = null;
const all = () => (loaded || (loaded = load()));

export const DEFAULT_PERSONA = DEFAULT_COFOUNDER_ID;
export const cofounders = () => all().cofounders;
export const situations = () => all().situations;
export const actionVocabulary = () => all().actions;
/** What a mood is decided from (src/shared/cofounders/mood.js): the situations, the cues and the metrics. */
export const moodCore = () => ({ situations: all().situations, cues: all().cues, metrics: all().metrics });
export const sharedRules = () => all().rules;

/** A known cofounder id (a retired one maps to its successor), or the default. Never trusts the client beyond the lookup. */
export function cleanPersona(id) {
  return resolveCofounderId(id).id || DEFAULT_PERSONA;
}

export const cofounderOf = (id) => all().cofounders[cleanPersona(id)];
