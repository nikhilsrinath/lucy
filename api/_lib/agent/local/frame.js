import { ACTS, THINGS, PERSON_ACTS, GENERIC, DETERMINER } from './acts.js';

/**
 * A meaning frame: what a sentence is made of.
 *
 *   { act, actWord, kind, thingWord, ref, roles: { date, amount, as, to, for }, form }
 *
 *   act    what the verb does (acts.js)          REMOVE
 *   kind   the kind of thing it is done to       employee
 *   ref    which one, as it was said             "Ravi"   ('' when none was named)
 *   roles  the details hung on prepositions      { date: 'Friday', amount: '25k' }
 *
 * Built from structure, not from sentences. The verb opens the command; its
 * object is found in one of four shapes, tried for every kind of thing:
 *
 *   A  act [det] THING [ref]              remove the vendor Dell · fire an employee
 *   B  act ref (from|off|to|in) GROUP     remove Ravi from the team · take X off the price list
 *   C  act [det] ref THING                get rid of the Dell vendor · delete the pricing task
 *   D  act NAME                           fire Ravi   (the name's own record says what it is)
 *
 * A report of something that happened is read as the act it implies: "Ravi
 * has left the company" is REMOVE employee Ravi.
 *
 * Nothing here decides what to DO with a frame (capabilities.js) and nothing
 * here guesses: a sentence with no verb it knows, or no thing it can place,
 * yields no frame at all.
 */

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const alt = (list) => [...list].sort((a, b) => b.length - a.length).map((p) => esc(p).replace(/ /g, '\\s+')).join('|');

const ACT_RE = Object.entries(ACTS).map(([act, words]) => [act, new RegExp(`^(?<w>${alt(words)})\\b\\s*`, 'i')]);
const DET = new RegExp(`^(?:${DETERMINER}\\s+)+`, 'i');
const KINDS = Object.entries(THINGS).map(([kind, t]) => {
  const one = `(?:${alt(t.one)})s?`;
  const group = t.group.length ? `(?:${alt(t.group)})` : null;
  return {
    kind,
    isOne: new RegExp(`^${one}$`, 'i'),
    A: new RegExp(`^(?<t>${one})(?=\\s|$)\\s*(?<ref>.*)$`, 'i'),
    B: new RegExp(`^(?<ref>.+?)\\s+(?:from|off|out of|to|in|into|on)\\s+(?:${DETERMINER}\\s+)*(?<t>${group ? `${group}|` : ''}${one})(?:\\s+list)?$`, 'i'),
    C: new RegExp(`^(?<ref>.+?)\\s+(?<t>${one})$`, 'i'),
  };
});

/** Said before the verb and carrying none of the request ("we have to", "i would like to"). */
const WISH = /^(?:(?:i|we)\s+(?:really\s+|just\s+)?(?:want|need|would like|wish|have|have got|got|am going|are going|plan|must|will have|will need)\s+to|need to|have to|got to|gotta|want to|would like to|time to|help me(?:\s+to)?|kindly|just|simply|go ahead and|let us|let me|you can|you need to|will you|would you|could you|can you|please|pls|plz)\s+/i;

const stripDet = (s) => { let out = String(s || '').trim(); for (let i = 0; i < 4 && DET.test(out); i++) out = out.replace(DET, '').trim(); return out; };

/** "an item name" → '' : a reference that is only determiners, a generic word or the kind's own noun names nothing. */
function cleanRef(raw) {
  let ref = stripDet(String(raw || '').replace(/^(?:called|named|about|titled|:)\s+/i, '').replace(/^["'“”‘’]+|["'“”‘’.]+$/g, ''));
  ref = ref.replace(new RegExp(`\\s+(?:${DETERMINER})$`, 'i'), '').trim();
  if (!ref || GENERIC.test(ref)) return '';
  if (KINDS.some((k) => k.isOne.test(ref))) return '';
  return ref;
}

/**
 * @param {string} core  the request, filler already removed (text.js)
 * @param {object} env   { today, resolve(text, kinds) }
 * @param {object} h     { fullDate(words, today), AMT }  — understand.js's own readers of dates and amounts
 */
export async function readFrame(core, env, h) {
  let s = String(core || '').trim();
  for (let i = 0; i < 4 && WISH.test(s); i++) s = s.replace(WISH, '');
  if (!s) return null;

  const reported = await report(s, env, h);
  if (reported) return reported;

  let act = null;
  let actWord = '';
  let body = '';
  const letGo = s.match(/^let\s+(?<ref>.+?)\s+go$/i);
  if (letGo) { act = 'REMOVE'; actWord = 'let go of'; body = letGo.groups.ref; } else {
    for (const [name, re] of ACT_RE) {
      const m = s.match(re);
      if (m && m.groups.w.length > actWord.length) { act = name; actWord = m.groups.w.toLowerCase().replace(/\s+/g, ' '); body = s.slice(m[0].length); }
    }
  }
  if (!act || !body.trim()) return null;

  // The details hung on the end, taken off from the right.
  const roles = {};
  const take = (re, key, ok = () => true) => {
    const m = body.match(re);
    if (m && ok(m.groups.v)) { roles[key] = m.groups.v.trim(); body = body.slice(0, m.index).trim(); }
  };
  take(/\s+(?:to|till|until|by|on|from|effective|starting|wef|as of|for)\s+(?<v>[^,]+)$/i, 'date', (v) => !!h.fullDate(v, env.today));
  take(new RegExp(`\\s+(?:at|for|@|priced at|worth|of)\\s+(?<v>${h.AMT})$`, 'i'), 'amount');
  take(/\s+as\s+(?:an?\s+|our\s+|the\s+)?(?<v>[^,]+)$/i, 'as');
  if (roles.date) roles.date = h.fullDate(roles.date, env.today);

  body = stripDet(body);
  if (!body) return null;

  // Which kind of thing, in which shape: the longest noun phrase wins.
  let best = null;
  for (const k of KINDS) {
    for (const form of ['B', 'A', 'C']) {
      const m = body.match(k[form]);
      if (!m) continue;
      const len = m.groups.t.length;
      if (!best || len > best.len) best = { kind: k.kind, form, thingWord: m.groups.t.toLowerCase(), raw: m.groups.ref || '', len };
    }
  }

  if (best) {
    let raw = best.raw.trim();
    // "an invoice for Acme", "a task with Ravi": the preposition names a role, not the thing itself.
    const prep = best.form === 'A' ? raw.match(/^(?<p>for|with|to)\s+(?<v>.+)$/i) : null;
    if (prep) { roles[prep.groups.p.toLowerCase() === 'to' ? 'to' : 'for'] = prep.groups.v.trim(); raw = ''; }
    const toWhom = raw.match(/^(?<ref>.*?)\s+to\s+(?<v>.+)$/i);
    if (act === 'ASSIGN' && toWhom) { roles.to = toWhom.groups.v.trim(); raw = toWhom.groups.ref; }
    // "an employee from the company": where it is taken from is not which one.
    raw = raw.replace(/^(?:from|off|out of|in|on|of)\s+.+$/i, '');
    return { act, actWord, kind: best.kind, thingWord: best.thingWord, ref: cleanRef(raw), roles, form: best.form };
  }

  // D: no noun — the name itself says what kind of record it is.
  const ref = cleanRef(body);
  if (!ref || ref.split(/\s+/).length > 5) return null;
  if (PERSON_ACTS.test(actWord)) {
    const hit = await env.resolve(ref, ['employee']);
    return hit.status === 'none' ? null : { act, actWord, kind: 'employee', thingWord: '', ref, roles, form: 'D' };
  }
  if (act === 'BILL') {
    const hit = await env.resolve(ref, ['client']);
    return hit.status === 'none' ? null : { act, actWord, kind: 'client', thingWord: '', ref, roles, form: 'D' };
  }
  if (act === 'REMOVE') {
    // "remove Ravi": only when the name is one record of one kind.
    const hit = await env.resolve(ref, ['employee', 'vendor', 'client'], { across: true });
    return hit.status === 'one' ? { act, actWord, kind: hit.kind, thingWord: '', ref, roles, form: 'D' } : null;
  }
  return null;
}

/** "Ravi has left the company" — something that happened, read as the act it implies. */
async function report(s, env, h) {
  const left = s.match(/^(?<who>.+?)\s+(?:has\s+|have\s+|just\s+|is\s+)?(?:left|resigned|quit|leaving|no longer works?|does not work|been fired|been terminated|been let go|been sacked)(?:\s+(?:here|with us|for us|the company|the team|us|the job|the organisation|the organization))?(?:\s+(?:on|from|effective|as of)\s+(?<date>.+))?$/i);
  if (!left) return null;
  const who = left.groups.who.replace(/^(?:the|our)\s+/i, '').trim();
  if (!who || who.split(/\s+/).length > 3 || /^(?:i|we|you|he|she|they|it|who|everyone|nobody|someone)$/i.test(who)) return null;
  const hit = await env.resolve(who, ['employee']);
  if (hit.status === 'none') return null;
  const date = left.groups.date ? h.fullDate(left.groups.date, env.today) : null;
  if (left.groups.date && !date) return null;
  return { act: 'REMOVE', actWord: 'left', kind: 'employee', thingWord: '', ref: who, roles: date ? { date } : {}, form: 'report' };
}
