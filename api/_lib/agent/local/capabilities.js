import { THINGS, UNSUPPORTED } from './acts.js';

/**
 * What Buddy can do with a meaning frame (frame.js).
 *
 * One line per capability: the act and the kind of thing it answers, and how
 * the frame's parts become the intent's arguments. The tool then does what it
 * always does — resolves the name, asks for what is missing, draws the card.
 *
 * Three outcomes, never a silent fall-through:
 *   { intent, parameters }   something Buddy does
 *   { unsupported }          understood, but not done from chat: said plainly
 *   null                     not a frame this table knows — the rest of the
 *                            reader (and then the model) takes the message
 */

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const few = (s, n = 6) => !s || String(s).trim().split(/\s+/).length <= n;
const out = (intent, parameters, extra = {}) => ({ intent, parameters, ...extra });

const TABLE = {
  'REMOVE:employee': (f) => (few(f.ref, 4) ? out('OFFBOARD_EMPLOYEE', { person: f.ref || undefined, last_day: f.roles.date }) : null),
  'CREATE:employee': (f, h) => h.newEmployee(f.ref || undefined, f.thingWord, f.roles.as, { strict: true }),
  'REMOVE:catalog': (f) => (few(f.ref, 8) ? out('ARCHIVE_CATALOG_ITEM', { item: f.ref || undefined }) : null),
  'CREATE:catalog': (f) => (few(f.ref, 8) ? out('CREATE_CATALOG_ITEM', { name: f.ref ? cap(f.ref) : undefined, price: f.roles.amount }) : null),
  'REMOVE:vendor': (f) => (few(f.ref, 5) ? out('ARCHIVE_VENDOR', { vendor: f.ref || undefined }) : null),
  'CREATE:vendor': (f) => (few(f.ref, 6) ? out('CREATE_VENDOR', { company_name: f.ref || undefined }) : null),
  'REMOVE:client': (f) => (few(f.ref, 5) ? out('DELETE_CLIENT', { client: f.ref || undefined }) : null),
  'CREATE:client': (f) => (few(f.ref, 6) ? out('CREATE_CLIENT', { name: f.ref || undefined, stage: /lead|prospect/.test(f.thingWord) ? 'lead' : undefined }) : null),
  'REMOVE:task': (f) => (few(f.ref, 10) ? out('DELETE_TASK', { task: f.ref || undefined }) : null),
  'FINISH:task': (f) => (few(f.ref, 10) ? out('COMPLETE_TASK', { task: f.ref || undefined }) : null),
  'REOPEN:task': (f) => (few(f.ref, 10) ? out('REOPEN_TASK', { task: f.ref || undefined }) : null),
  'MOVE:task': (f) => (f.roles.date && few(f.ref, 10) ? out('UPDATE_TASK', { task: f.ref || undefined, deadline: f.roles.date }) : null),
  'ASSIGN:task': (f) => (f.roles.to && few(f.roles.to, 3) && few(f.ref, 10) ? out('UPDATE_TASK', { task: f.ref || undefined, assignee: /^(?:me|myself)$/i.test(f.roles.to) ? 'me' : f.roles.to }) : null),
  // "bill Acme": an invoice for that client.
  'BILL:client': (f, h) => h.draftDoc('CREATE_INVOICE', f.ref, f.roles.amount || null, null),
};

/**
 * @param {object} frame  from readFrame
 * @param {object} h      understand.js's own builders: { newEmployee, draftDoc }
 */
export function capable(frame, h) {
  const key = `${frame.act}:${frame.kind}`;
  const cannot = UNSUPPORTED[key] || UNSUPPORTED[`*:${frame.kind}`];
  if (cannot) return { unsupported: { doing: cannot, page: THINGS[frame.kind].page } };
  const build = TABLE[key];
  return build ? build(frame, h) : null;
}

/** The act-and-thing pairs this table answers, for the docs and the miss report. */
export const CAPABILITIES = Object.keys(TABLE);
