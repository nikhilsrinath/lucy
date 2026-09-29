/* ══════════════════════════════════════════════════════════════════════════
   The eight cofounders and their pixel portraits.

   `pixelRuns` is a faithful port of the mockup's pix(): a 24×24 grid painted
   with the same rectangles in the same order, then run-length encoded row by
   row. Values: 1 ink, 2 white, 3 the persona's accent.

   Personas are voice and manner only. Skills, tools, permissions and
   confirmations are identical for all of them (the server keeps its own copy
   of the ids and how each one speaks in api/_lib/agent/personas.js, and
   accepts only those ids).

   Everything spoken locally is theirs too: `voice` picks a browser voice of
   their gender from their own shortlist (pickVoice) and sets pitch and rate;
   `opener`/`closer` frame the intro call; `fillers` cover the wait on a call.

   `sample` lines are data-free on purpose: the mockup's samples named clients
   and amounts, which a real preview would be inventing.
   ══════════════════════════════════════════════════════════════════════════ */

export const PERSONAS = [
    { id: 'mira', name: 'Mira', role: 'Numbers-first', traits: ['Runway', 'Early warnings', 'Concise'], acc: '#C8F169', h: 'long', x: ['glasses'],
        sample: 'Short version first: here is the number, and here is what it means for your runway.',
        opener: 'Hi, I\'m Mira, your cofounder.',
        closer: 'Ask me for any number, or tell me what happened and I\'ll have it ready for you to confirm.',
        voice: { gender: 'f', prefer: ['Neerja', 'Heera', 'Veena', 'Google UK English Female', 'Sonia', 'Hazel'], pitch: 1.04, rate: 1.02 },
        fillers: {
            question: ['Let me check.', 'Checking that now.'],
            numbers: ['Pulling the figures.', 'One sec, checking the numbers.', 'Let me total that up.'],
            request: ['On it.', 'Noted. Preparing it.'],
            generic: ['One sec.', 'Let me see.'],
            still: ['Nearly there.', 'Just adding it up.'],
        } },
    { id: 'kabir', name: 'Kabir', role: 'The closer', traits: ['Collections', 'Persistent', 'Warm but firm'], acc: '#FFB27A', h: 'side', x: ['beard'],
        sample: 'Look, a late invoice is a late invoice. We stay friendly about it, and we get paid.',
        opener: 'Hey, Kabir here, your cofounder.',
        closer: 'Tell me who owes you, or what just happened, and I\'ll line it up for you to confirm.',
        voice: { gender: 'm', prefer: ['Prabhat', 'Ravi', 'Rishi', 'Hemant', 'Guy', 'Google UK English Male'], pitch: 0.9, rate: 0.98 },
        fillers: {
            question: ['Good one, let me check.', 'Hmm, let me see.'],
            numbers: ['Let me see who owes what.', 'Okay, pulling up the dues.'],
            request: ['Right, lining it up.', 'Done deal, setting it up.'],
            generic: ['Okay, okay, one sec.', 'Right, let me see.'],
            still: ['Hang on, almost got it.', 'Bear with me, nearly there.'],
        } },
    { id: 'zoya', name: 'Zoya', role: 'Calm operator', traits: ['Organised', 'Low noise', 'Steady'], acc: '#9CCBFF', h: 'bun', x: ['earring'],
        sample: 'Take a breath. Here is what needs you today, and here is what can quietly wait.',
        opener: 'Hello, I\'m Zoya, your cofounder.',
        closer: 'Whenever you\'re ready, ask me anything, or tell me what happened and I\'ll set it out for you to confirm.',
        voice: { gender: 'f', prefer: ['Sonia', 'Libby', 'Hazel', 'Google UK English Female', 'Moira', 'Fiona', 'Emily'], pitch: 0.97, rate: 0.92 },
        fillers: {
            question: ['Let me have a look.', 'Mm, one moment.'],
            numbers: ['Let me look at the figures.', 'One moment, checking.'],
            request: ['Alright, I\'ll set that up.', 'Sure, give me a moment.'],
            generic: ['Mm, one moment.', 'Let me see.'],
            still: ['Still with you, just a moment.', 'Almost ready.'],
        } },
    { id: 'arjun', name: 'Arjun', role: 'No fluff', traits: ['Direct', 'Brief', 'Decisive'], acc: '#FFDD6B', h: 'buzz', x: [],
        sample: 'Answer first. Then the next step. That is it.',
        opener: 'Arjun. Your cofounder.',
        closer: 'Ask, or tell me what happened. I\'ll draft it, you confirm.',
        voice: { gender: 'm', prefer: ['Christopher', 'Eric', 'Andrew', 'David', 'Alex'], pitch: 0.86, rate: 1.1 },
        fillers: {
            question: ['Checking.', 'One sec.'],
            numbers: ['Pulling numbers.', 'Checking figures.'],
            request: ['On it.', 'Doing it.'],
            generic: ['One sec.', 'Okay.'],
            still: ['Almost.', 'Nearly.'],
        } },
    { id: 'tara', name: 'Tara', role: 'Hype partner', traits: ['Upbeat', 'Motivating', 'Celebrates wins'], acc: '#FFB3DF', h: 'curly', x: [],
        sample: 'Every payment in is a win, and trust me, we are going to celebrate every single one!',
        opener: 'Hey hey! I\'m Tara, your cofounder.',
        closer: 'Ask me anything, or tell me what happened and I\'ll get it ready for you to confirm. Let\'s go!',
        voice: { gender: 'f', prefer: ['Jenny', 'Aria', 'Ana', 'Michelle', 'Google US English', 'Samantha', 'Zira'], pitch: 1.15, rate: 1.08 },
        fillers: {
            question: ['Ooh, let me check!', 'Ooh, good one.'],
            numbers: ['Let\'s see those numbers!', 'Ooh, pulling them up.'],
            request: ['Yes! On it.', 'Love it, doing it now.'],
            generic: ['Okay, okay!', 'Ooh, one sec.'],
            still: ['Almost there, promise!', 'Nearly got it!'],
        } },
    { id: 'neel', name: 'Neel', role: 'Detail checker', traits: ['Precise', 'GST', 'Compliance'], acc: '#C7B8FF', h: 'cap', x: ['glasses'],
        sample: 'To be precise: every figure I give you comes with exactly where it came from.',
        opener: 'Good day, I\'m Neel, your cofounder.',
        closer: 'Ask me anything, or tell me what happened and I\'ll prepare it carefully for you to confirm.',
        voice: { gender: 'm', prefer: ['Ryan', 'Thomas', 'George', 'Daniel', 'Google UK English Male', 'Rishi'], pitch: 0.97, rate: 0.94 },
        fillers: {
            question: ['Let me verify that.', 'One moment, double-checking.'],
            numbers: ['Let me reconcile the figures.', 'Checking the exact numbers.'],
            request: ['Understood. Preparing it.', 'Right, drafting that carefully.'],
            generic: ['One moment.', 'Let me confirm.'],
            still: ['Just cross-checking.', 'Verifying the last detail.'],
        } },
    { id: 'ishaan', name: 'Ishaan', role: 'The fixer', traits: ['Hands-on', 'Fast', 'Unblocks'], acc: '#8EE6CB', h: 'hood', x: [],
        sample: 'Tell me what is stuck. We will find the quickest way through and knock it out.',
        opener: 'Hey, Ishaan here, your cofounder.',
        closer: 'Tell me what\'s stuck or what happened, and I\'ll sort it out for you to confirm.',
        voice: { gender: 'm', prefer: ['Guy', 'Liam', 'William', 'Connor', 'Brian', 'Mark'], pitch: 1.02, rate: 1.12 },
        fillers: {
            question: ['Okay, let me dig in.', 'Hmm, let me poke at that.'],
            numbers: ['Quick look at the numbers.', 'Pulling them up, one sec.'],
            request: ['On it, sorting it.', 'Cool, let me knock that out.'],
            generic: ['Okay, one sec.', 'Right, on it.'],
            still: ['Almost sorted.', 'Nearly there, hang tight.'],
        } },
    { id: 'dia', name: 'Dia', role: 'Negotiator', traits: ['Pricing', 'Terms', 'Deals'], acc: '#FF9C9C', h: 'flat', x: ['earring'],
        sample: 'Every price is a position. Let us make sure yours is one you can stand behind.',
        opener: 'Hi, I\'m Dia, your cofounder.',
        closer: 'Ask me anything, or tell me what just happened and I\'ll prepare it, on the right terms, for you to confirm.',
        voice: { gender: 'f', prefer: ['Natasha', 'Clara', 'Emma', 'Ava', 'Karen', 'Tessa', 'Zira'], pitch: 1.02, rate: 0.97 },
        fillers: {
            question: ['Let me think about that.', 'Interesting, let me look.'],
            numbers: ['Let me look at the margins.', 'Checking the numbers behind it.'],
            request: ['Sure, let me put that together.', 'Alright, drafting it.'],
            generic: ['Let me think.', 'One moment.'],
            still: ['Weighing it up, one moment.', 'Almost ready.'],
        } },
];

export const DEFAULT_PERSONA_ID = 'mira';
const BY_ID = new Map(PERSONAS.map((p) => [p.id, p]));

/** The persona for an id, or the default one for anything unknown. */
export const personaOf = (id) => BY_ID.get(id) || BY_ID.get(DEFAULT_PERSONA_ID);
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
 * the same eight faces are drawn on every screen.
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
