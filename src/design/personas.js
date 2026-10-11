import { parseSituations, parseRules, buildCofounder } from '../shared/cofounders/parse.js';
import { COFOUNDER_IDS, DEFAULT_COFOUNDER_ID, resolveCofounderId } from '../shared/cofounders/legacy.js';

/* ══════════════════════════════════════════════════════════════════════════
   The cofounders, as the app knows them.

   Each one lives in cofounders/<id>/ (profile.json, persona.md, mind.md,
   playbooks.md, examples.md), with the shared rules and the situations in
   cofounders/_core/. The files are bundled here and parsed with the same
   functions the server uses (src/shared/cofounders/parse.js), so the app and
   the agent can never disagree about who a cofounder is.

   A persona carries what the screens need: name, title, speciality, IQ, the
   selection vector, the headline word for each mood, the browser voice
   (`voice`, picked by pickVoice), the call's opener and closer, the fillers
   that cover a wait on a call, and `art` — the id its drawings are keyed by
   (src/design/art).

   `pixelRuns` further down draws the pixel portraits teammates and the
   user's own avatar still use.
   ══════════════════════════════════════════════════════════════════════════ */

const profiles = import.meta.glob('../../cofounders/*/profile.json', { eager: true, import: 'default' });
const texts = import.meta.glob('../../cofounders/**/*.md', { eager: true, query: '?raw', import: 'default' });
const text = (path) => texts[`../../cofounders/${path}`] || '';

const core = parseSituations(text('_core/situations.md'));
export const SITUATIONS = core.situations;
export const ACTIONS = core.actions;
export const SHARED_RULES = parseRules(text('_core/rules.md'));

export const PERSONAS = COFOUNDER_IDS.map((id) => ({
    ...buildCofounder({
        profile: profiles[`../../cofounders/${id}/profile.json`],
        persona: text(`${id}/persona.md`),
        mind: text(`${id}/mind.md`),
        playbooks: text(`${id}/playbooks.md`),
        examples: text(`${id}/examples.md`),
    }),
    art: id,
}));

export const DEFAULT_PERSONA_ID = DEFAULT_COFOUNDER_ID;
const BY_ID = new Map(PERSONAS.map((p) => [p.id, p]));

/** The persona for a stored id (a retired one maps to its successor), or the default for anything unknown. */
export const personaOf = (id) => BY_ID.get(resolveCofounderId(id).id || DEFAULT_PERSONA_ID);
export const isPersonaId = (id) => BY_ID.has(id);

/** Portrait specs for the people in the mockup's team (the user's own avatar). */
export const ME_AVATAR = { h: 'side', x: [], acc: '#FFDD6B' };

/** A stable avatar for any person, picked from their name — so the same
 *  teammate always wears the same portrait. Never a persona: those are the AI. */
const PEOPLE_SPECS = [
    { h: 'long', x: ['earring'], acc: '#FFB3DF' }, { h: 'buzz', x: [], acc: '#9CCBFF' },
    { h: 'flat', x: ['glasses'], acc: '#C8F169' }, { h: 'bun', x: [], acc: '#C7B8FF' },
    { h: 'side', x: [], acc: '#FFDD6B' }, { h: 'curly', x: ['glasses'], acc: '#8EE6CB' },
    { h: 'cap', x: [], acc: '#FFB27A' }, { h: 'side', x: ['beard'], acc: '#FF9C9C' },
];
export function personAvatar(name = '') {
    let h = 0;
    for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return PEOPLE_SPECS[h % PEOPLE_SPECS.length];
}

/* ── the portrait ──────────────────────────────────────────────────────── */

const N = 24;

function paint(hair, extra) {
    const M = Array.from({ length: N }, () => Array(N).fill(0));
    const S = (x, y, v) => { if (x >= 0 && x < N && y >= 0 && y < N) M[y][x] = v; };
    const R = (x0, y0, x1, y1, v) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) S(x, y, v); };
    R(3, 21, 20, 23, 3); R(5, 20, 18, 20, 1); S(3, 21, 1); S(4, 21, 1); S(19, 21, 1); S(20, 21, 1); R(2, 22, 2, 23, 1); R(21, 22, 21, 23, 1);
    if (hair === 'hood') { R(4, 2, 19, 2, 1); R(3, 3, 20, 21, 1); R(5, 4, 18, 4, 2); R(5, 5, 5, 19, 2); R(18, 5, 18, 19, 2); }
    R(10, 17, 13, 21, 2); R(9, 17, 9, 20, 1); R(14, 17, 14, 20, 1); S(9, 21, 1); S(14, 21, 1); S(10, 22, 1); S(13, 22, 1); S(11, 22, 2); S(12, 22, 2); S(11, 23, 1); S(12, 23, 1);
    R(7, 6, 16, 17, 2); R(7, 5, 16, 5, 1); R(6, 6, 6, 16, 1); R(17, 6, 17, 16, 1); S(7, 17, 1); S(16, 17, 1); R(8, 18, 15, 18, 1);
    if (hair !== 'hood' && hair !== 'long') { S(5, 10, 1); S(4, 11, 1); S(4, 12, 1); S(5, 13, 1); S(5, 11, 2); S(5, 12, 2); S(18, 10, 1); S(19, 11, 1); S(19, 12, 1); S(18, 13, 1); S(18, 11, 2); S(18, 12, 2); }
    R(9, 11, 10, 11, 1); R(13, 11, 14, 11, 1); R(9, 9, 10, 9, 1); R(13, 9, 14, 9, 1); S(12, 12, 1); S(12, 13, 1); S(11, 13, 1); R(10, 15, 13, 15, 1);
    if (hair === 'flat') { R(6, 3, 17, 5, 1); R(6, 6, 7, 8, 1); R(16, 6, 17, 8, 1); R(8, 6, 15, 6, 1); }
    if (hair === 'side') { R(6, 3, 17, 5, 1); R(5, 4, 5, 8, 1); R(6, 6, 7, 9, 1); R(8, 6, 12, 7, 1); S(13, 6, 1); R(16, 6, 17, 7, 1); S(14, 4, 2); }
    if (hair === 'long') { R(5, 3, 18, 5, 1); R(4, 5, 6, 20, 1); R(17, 5, 19, 20, 1); R(7, 6, 11, 7, 1); S(12, 6, 1); }
    if (hair === 'bun') { R(6, 4, 17, 5, 1); R(6, 6, 7, 8, 1); R(16, 6, 17, 8, 1); R(8, 6, 15, 6, 1); R(10, 1, 13, 3, 1); S(11, 2, 2); }
    if (hair === 'buzz') { R(7, 4, 16, 4, 1); R(6, 5, 6, 9, 1); R(17, 5, 17, 9, 1); for (let y = 5; y <= 7; y++) for (let x = 7; x <= 16; x++) S(x, y, (x + y) % 2 ? 1 : 2); }
    if (hair === 'curly') { for (let x = 5; x <= 18; x++) R(x, 2 + (x % 2), x, 6, 1); R(4, 4, 5, 11, 1); R(18, 4, 19, 11, 1); [7, 10, 13, 16].forEach((x) => S(x, 7, 1)); S(4, 3, 1); S(19, 3, 1); }
    if (hair === 'cap') { R(6, 2, 17, 5, 1); R(4, 6, 19, 7, 1); R(9, 3, 14, 4, 2); S(10, 3, 1); S(12, 4, 1); S(13, 3, 1); }
    if (hair === 'hood') { R(7, 6, 12, 7, 1); }
    if (extra.includes('glasses')) { R(9, 9, 10, 9, 2); R(13, 9, 14, 9, 2); R(8, 10, 11, 10, 1); R(8, 12, 11, 12, 1); S(8, 11, 1); S(11, 11, 1); S(9, 11, 2); S(10, 11, 1); R(13, 10, 16, 10, 1); R(13, 12, 16, 12, 1); S(13, 11, 1); S(16, 11, 1); S(14, 11, 1); S(15, 11, 2); S(12, 10, 1); }
    if (extra.includes('beard')) { R(6, 13, 6, 16, 1); R(17, 13, 17, 16, 1); R(7, 14, 16, 17, 1); R(8, 18, 15, 18, 1); R(10, 15, 13, 15, 2); S(12, 13, 1); }
    if (extra.includes('earring')) { S(4, 14, 3); S(4, 15, 3); S(3, 14, 1); S(3, 15, 1); S(4, 16, 1); }
    return M;
}

const cache = new Map();

/**
 * The portrait as horizontal runs: [{ x, y, w, v }]. Memoised per spec, since
 * the same few faces are drawn on every screen.
 */
export function pixelRuns(hair, extra = []) {
    const key = `${hair}|${extra.join(',')}`;
    if (cache.has(key)) return cache.get(key);
    const M = paint(hair, extra);
    const runs = [];
    for (let y = 0; y < N; y++) {
        let x = 0;
        while (x < N) {
            const v = M[y][x];
            if (!v) { x++; continue; }
            let e = x;
            while (e + 1 < N && M[y][e + 1] === v) e++;
            runs.push({ x, y, w: e - x + 1, v });
            x = e + 1;
        }
    }
    cache.set(key, runs);
    return runs;
}
