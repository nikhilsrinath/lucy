import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cofounders, situations, actionVocabulary, sharedRules, cleanPersona, cofounderOf, moodCore, DEFAULT_PERSONA } from './cofounders.js';
import { buildSystemPrompt, AGENT_PROMPT_VERSION } from './prompt.js';
import { assemblePrompt } from './assemble.js';
import { toolsFor, ALL_TOOLS, deletes } from './registry.js';
import { decide } from '../autonomy/policy.js';
import { fakeDb, fakeCtx } from './testing/fakeDb.js';
import { PERSONAS as CLIENT_PERSONAS } from '../../../src/design/personas.js';
import { RETIRED, COFOUNDER_IDS, resolveCofounderId } from '../../../src/shared/cofounders/legacy.js';
import { detectSituation, situationOfTurn, detectCue } from '../../../src/shared/cofounders/detect.js';
import { decideMood, moodFor, takeMood, legacyMood, DEFAULT_TAGS, SUGGESTABLE } from '../../../src/shared/cofounders/mood.js';
import { readMood } from '../../../src/shared/cofounders/reading.js';
import { MOODS, METRIC_KINDS } from '../../../src/shared/cofounders/parse.js';
import { QUIZ, rank, founderVector } from '../../../src/shared/cofounders/match.js';

// ai_actions lives in memory here; everything else is the real code.
const store = new Map();
vi.mock('./actions.js', async (importOriginal) => {
  const real = await importOriginal();
  let n = 0;
  return {
    ...real,
    countPending: async (_ctx, chatId) => [...store.values()].filter((r) => r.chat_id === chatId && real.effectiveStatus(r) === 'proposed').length,
    insertProposal: async (ctx, { chatId, messageId, tool, args, targets, preview }) => {
      const id = `aaaaaaaa-0000-4000-8000-${String(++n).padStart(12, '0')}`;
      const row = {
        id, org_id: ctx.orgId, user_id: ctx.actor?.kind === 'person' ? null : ctx.user.id,
        employee_id: ctx.actor?.kind === 'person' ? ctx.actor.employeeId : null, channel_actor: ctx.actor?.channelActor || null,
        chat_id: chatId, message_id: messageId,
        tool: tool.name, module: tool.module, risk: tool.risk, args, target_ref: targets?.length ? { items: targets } : null,
        preview, status: 'proposed', proposed_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + real.PROPOSAL_TTL_MS).toISOString(),
      };
      store.set(id, row);
      return { ...row };
    },
    // The real ownership rule: a user by user_id, a linked person by employee_id.
    loadAction: async (id, ctx) => { const r = store.get(id); return real.isOwner(r, ctx) ? { ...r } : null; },
    transition: async (id, from, patch) => {
      const r = store.get(id);
      if (!r || r.status !== from) return null;
      Object.assign(r, patch);
      return { ...r };
    },
    patchAction: async (id, patch) => { Object.assign(store.get(id), patch); return { ...store.get(id) }; },
  };
});

const { runChat, runResume } = await import('./loop.js');

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const IDS = ['steve', 'elon', 'mark'];
const all = () => Object.values(cofounders());

describe('the cofounder files', () => {
  it('load and validate: three cofounders, every situation, known actions, vectors in range', () => {
    expect(Object.keys(cofounders()).sort()).toEqual([...IDS].sort());
    expect(COFOUNDER_IDS).toEqual(IDS);
    expect(situations().length).toBeGreaterThanOrEqual(11);
    const known = new Set(actionVocabulary().map((a) => a.id));
    for (const c of all()) {
      for (const s of situations()) {
        expect(c.playbooks[s.id], `${c.id}/${s.id}`).toBeTruthy();
        for (const a of c.playbooks[s.id].actions) expect(known.has(a), `${c.id}/${s.id}: ${a}`).toBe(true);
      }
      for (const v of Object.values(c.vector)) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(10); }
      const examples = Object.keys(c.examples).length;
      expect(examples).toBeGreaterThanOrEqual(4);
      expect(examples).toBeLessThanOrEqual(6);
      expect(c.voice.id).toBeTruthy();
      expect(c.unlock.type).toBeTruthy();
      expect(c.iq).toBeGreaterThan(0);
    }
  });

  it('carry the headline word for every mood', () => {
    expect(cofounderOf('steve').headlines).toEqual({ neutral: 'Here it is.', thinking: 'Why?', explaining: "Here's the thing.", happy: 'Insanely great.', serious: 'Not good enough.', surprised: 'Wait. What?', disappointed: "That's not it.", laughing: 'Real artists ship.' });
    expect(cofounderOf('elon').headlines).toEqual({ neutral: "Here's the data.", thinking: 'First principles.', explaining: 'Physics first.', happy: 'Good. Next.', serious: 'Fix it. Now.', surprised: "That's wild.", disappointed: 'Back to the pad.', laughing: 'Liftoff!' });
    expect(cofounderOf('mark').headlines).toEqual({ neutral: "Here's where we are.", thinking: "Let's test it.", explaining: 'Look at the data.', happy: "It's working.", serious: 'This is a problem.', surprised: "Didn't expect that.", disappointed: 'We missed.', laughing: 'Ship it!' });
    for (const c of all()) expect(Object.keys(c.headlines)).toEqual(MOODS);
  });

  it('are the same cofounders in the app, id for id', () => {
    expect(CLIENT_PERSONAS.map((p) => p.id)).toEqual(IDS);
    for (const p of CLIENT_PERSONAS) {
      expect(p.name).toBe(cofounderOf(p.id).name);
      expect(p.headlines).toEqual(cofounderOf(p.id).headlines);
      expect(p.playbooks).toEqual(cofounderOf(p.id).playbooks);
    }
  });

  it('examples carry no figures, so the model has nothing invented to repeat', () => {
    for (const c of all()) for (const [id, text] of Object.entries(c.examples)) expect(text, `${c.id}/${id}`).not.toMatch(/₹|\d/);
  });
});

describe('ids', () => {
  it('accepts only known ids', () => {
    expect(cleanPersona('mark')).toBe('mark');
    expect(cleanPersona('MARK')).toBe(DEFAULT_PERSONA);
    expect(cleanPersona('__proto__')).toBe(DEFAULT_PERSONA);
    expect(cleanPersona('constructor')).toBe(DEFAULT_PERSONA);
    expect(cleanPersona(undefined)).toBe(DEFAULT_PERSONA);
    expect(cleanPersona({ id: 'mark' })).toBe(DEFAULT_PERSONA);
  });

  it('maps each retired cofounder to its successor', () => {
    const became = (id) => Object.entries(RETIRED).filter(([, to]) => to === id).map(([from]) => from);
    expect(became('elon')).toHaveLength(4);
    expect(became('steve')).toHaveLength(2);
    expect(became('mark')).toHaveLength(3);
    for (const [from, to] of Object.entries(RETIRED)) {
      expect(cleanPersona(from)).toBe(to);
      expect(resolveCofounderId(from)).toEqual({ id: to, migrated: true });
    }
    expect(resolveCofounderId('elon')).toEqual({ id: 'elon', migrated: false });
    expect(resolveCofounderId('nobody')).toEqual({ id: null, migrated: false });
  });
});

/* ── no trace of the nine retired cofounders ─────────────────────────────── */

describe('the retired cofounders are gone', () => {
  // The one file that may know the old ids: the migration map.
  const ALLOWED = new Set(['src/shared/cofounders/legacy.js']);
  const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'supabase', 'docs', '.agents', '.windsurf', '.claude']);
  const TEXT = /\.(?:js|jsx|ts|tsx|json|md|css|html|svg)$/;
  const names = Object.keys(RETIRED);

  function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const path = join(dir, name);
      const st = statSync(path);
      if (st.isDirectory()) walk(path, out);
      else if (TEXT.test(name) && st.size < 2_000_000) out.push(path);
    }
    return out;
  }
  const files = ['src', 'api', 'cofounders', 'public', 'scripts'].flatMap((d) => walk(join(ROOT, d)))
    .map((path) => ({ rel: relative(ROOT, path).split(sep).join('/'), text: readFileSync(path, 'utf8') }))
    .filter((f) => !ALLOWED.has(f.rel));

  it('no code path, prompt, seed or asset refers to one as a cofounder', () => {
    const hits = [];
    for (const { rel, text } of files) {
      for (const n of names) {
        const Name = n[0].toUpperCase() + n.slice(1);
        // As a quoted id or an asset path, or as a cofounder by name.
        const asId = new RegExp(`['"\`/]${n}['"\`.]|\\b${n}\\s*:\\s*\\{|persona[^\\n]{0,40}\\b${n}\\b`);
        const asCofounder = new RegExp(`\\b${Name}\\b[^\\n]{0,60}\\b(?:cofounder|persona)\\b|\\b(?:cofounder|persona)\\b[^\\n]{0,60}\\b${Name}\\b|You are ${Name}\\b|I'm ${Name}\\b|${Name} here\\b`);
        // As a key of a per-cofounder table (name: …) or a lookup (TABLE.name), in app and server code.
        // Test fixtures and the eval world name ordinary people, which is fine.
        const asKey = !/\.test\.|^scripts\//.test(rel) && new RegExp(`(?:^|[\\s{,])${n}\\s*:|[A-Za-z_\\]]\\.${n}\\b(?![.@])`, 'm').test(text);
        if (asKey || asId.test(text) || asCofounder.test(text)) hits.push(`${rel}: ${n}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('no cofounder file mentions one at all', () => {
    const inCofounders = files.filter((f) => f.rel.startsWith('cofounders/'));
    expect(inCofounders.length).toBeGreaterThan(15);
    const any = new RegExp(`\\b(?:${names.join('|')})\\b`, 'i');
    expect(inCofounders.filter((f) => any.test(f.text)).map((f) => f.rel)).toEqual([]);
  });

  it('their portraits are deleted', () => {
    expect(files.filter((f) => f.rel.startsWith('public/characters')).map((f) => f.rel)).toEqual([]);
  });
});

/* ── mood ────────────────────────────────────────────────────────────────── */

describe('mood mapping', () => {
  const EXPECTED = {
    overdue_invoice: 'serious', low_runway: 'serious', slipping_deadline: 'serious', gst_due: 'serious',
    unusual_spend: 'surprised', record_high: 'surprised',
    payment_received: 'happy', task_done: 'happy',
    missing_info: 'thinking', quick_pick: 'thinking', discount_request: 'thinking', hiring_decision: 'thinking',
    deal_won: 'laughing', milestone: 'laughing',
    deal_lost: 'disappointed',
  };
  const core = moodCore();

  it('there are eight moods, and every situation has one', () => {
    expect(MOODS).toEqual(['neutral', 'thinking', 'explaining', 'happy', 'serious', 'surprised', 'disappointed', 'laughing']);
    expect(situations().map((s) => s.id).sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(Object.keys(DEFAULT_TAGS).sort()).toEqual([...MOODS].sort());
  });

  it.each(Object.entries(EXPECTED))('%s → %s', (id, mood) => {
    expect(decideMood({ detected: id }, core)).toMatchObject({ mood, by: 'keywords', situation: id });
    // The model's suggestion never wins over the rule.
    for (const suggested of MOODS) expect(decideMood({ detected: id, suggested }, core).mood).toBe(mood);
    for (const c of all()) {
      const out = moodFor(c, { detected: id, suggested: 'happy' }, core);
      expect(out).toMatchObject({ mood, headline_word: c.headlines[mood], situation: id });
      expect(out.tag).toBeTruthy();
    }
  });

  it('detects situations from the message, the insight and what the turn produced', () => {
    const S = situations();
    expect(detectSituation({ message: 'Kite Retail is 14 days overdue on ₹62,000' }, S)).toBe('overdue_invoice');
    expect(detectSituation({ message: 'how much runway do we have?' }, S)).toBe('low_runway');
    expect(detectSituation({ message: 'they want a discount' }, S)).toBe('discount_request');
    expect(detectSituation({ message: 'Zephyr accepted the quote' }, S)).toBe('deal_won');
    expect(detectSituation({ message: 'Kite went with someone else' }, S)).toBe('deal_lost');
    expect(detectSituation({ message: 'hello there' }, S)).toBeNull();
    expect(detectSituation({ message: 'x', source: 'insight:overdue:inv-1' }, S)).toBe('overdue_invoice');
    // What the turn produced outranks the words.
    expect(situationOfTurn({ detected: 'overdue_invoice', outcome: { asked: 'input' } }, S)).toBe('missing_info');
    expect(situationOfTurn({ detected: null, outcome: { asked: 'choice' } }, S)).toBe('quick_pick');
    expect(situationOfTurn({ outcome: { cards: [{ tool: 'record_payment' }] } }, S)).toBe('payment_received');
    expect(situationOfTurn({ outcome: { cards: [{ tool: 'complete_task' }] } }, S)).toBe('task_done');
    expect(situationOfTurn({ outcome: { cards: [{ tool: 'move_client_stage', args: { stage: 'deal' } }] } }, S)).toBe('deal_won');
    expect(situationOfTurn({ outcome: { cards: [{ tool: 'move_client_stage', args: { stage: 'lost' } }] } }, S)).toBe('deal_lost');
    expect(situationOfTurn({ outcome: { cards: [{ tool: 'move_client_stage', args: { stage: 'contacted' } }] } }, S)).toBeNull();
  });
});

/* ── the ladder: which mood a turn ends on ───────────────────────────────── */

describe('the mood ladder', () => {
  const core = moodCore();
  const mood = (turn) => decideMood(turn, core);
  const zeroRevenue = [{ metric: 'money_in', value: 0, previous: 0 }];

  it('walks its steps in order, the first that applies winning', () => {
    // 1. A failure beats everything.
    expect(mood({ outcome: { failed: true, asked: 'input', cards: [{ tool: 'record_payment', status: 'executed' }] }, detected: 'deal_won' }))
      .toEqual({ mood: 'disappointed', tag: "Didn't work", by: 'failure', situation: null });
    // 2. A question.
    expect(mood({ outcome: { asked: 'input', cards: [{ tool: 'record_payment' }] }, detected: 'deal_won' })).toMatchObject({ mood: 'thinking', tag: 'Needs info', by: 'question', situation: 'missing_info' });
    expect(mood({ outcome: { asked: 'choice' } })).toMatchObject({ mood: 'thinking', by: 'question', situation: 'quick_pick' });
    // 3. A card carried out.
    expect(mood({ outcome: { cards: [{ tool: 'record_payment', status: 'executed' }] }, detected: 'overdue_invoice' })).toMatchObject({ mood: 'happy', by: 'outcome', situation: 'payment_received' });
    expect(mood({ outcome: { cards: [{ tool: 'convert_quotation', status: 'executed' }] } })).toMatchObject({ mood: 'laughing', tag: 'Big win' });
    expect(mood({ outcome: { cards: [{ tool: 'move_client_stage', args: { stage: 'lost' }, status: 'proposed' }] } })).toMatchObject({ mood: 'disappointed', tag: 'Lost one', situation: 'deal_lost' });
    // A card carried out that means no situation says nothing by itself.
    expect(mood({ outcome: { cards: [{ tool: 'create_task', status: 'executed' }] } })).toMatchObject({ mood: 'neutral', by: 'default' });
    // 4. A card waiting for a tap.
    expect(mood({ outcome: { cards: [{ tool: 'create_task', status: 'proposed', risk: 'low' }] } })).toEqual({ mood: 'neutral', tag: 'Ready for you', by: 'outcome', situation: null });
    expect(mood({ outcome: { cards: [{ tool: 'create_invoice_draft', status: 'proposed', risk: 'high' }] } })).toEqual({ mood: 'serious', tag: 'Check this', by: 'outcome', situation: null });
    expect(mood({ outcome: { cards: [{ tool: 'create_task', status: 'proposed', risk: 'low' }] }, detected: 'hiring_decision' })).toMatchObject({ mood: 'thinking', tag: 'Your call', by: 'outcome' });
    // 5. The insight that started the turn, even over the figures.
    expect(mood({ detected: 'overdue_invoice', source: 'insight:overdue:inv-1', message: 'any overdue?', readings: [{ metric: 'overdue', value: 0 }] })).toMatchObject({ mood: 'serious', by: 'source' });
    // 6. The figures beat the words.
    expect(mood({ detected: 'overdue_invoice', message: 'any overdue invoices?', readings: [{ metric: 'overdue', value: 0 }] })).toMatchObject({ mood: 'happy', tag: 'All clear', by: 'reading' });
    // 7. The words.
    expect(mood({ detected: 'overdue_invoice', message: 'any overdue invoices?' })).toMatchObject({ mood: 'serious', by: 'keywords' });
    // 8. A cue, over the model.
    expect(mood({ message: 'haha nice one', suggested: 'serious' })).toEqual({ mood: 'laughing', tag: 'Good one', by: 'cue', situation: null });
    expect(mood({ message: 'why is this the rule?' })).toMatchObject({ mood: 'explaining', tag: "Here's how", by: 'cue' });
    // 9. The model, over the shape.
    expect(mood({ suggested: 'serious', outcome: { viewed: true } })).toMatchObject({ mood: 'serious', by: 'model' });
    // 10. The shape of the reply.
    expect(mood({ outcome: { viewed: true } })).toMatchObject({ mood: 'explaining', tag: 'Take a look', by: 'shape' });
    expect(mood({ outcome: { reply: 'Do this:\n1. Call them\n2. Send the quote\n' } })).toMatchObject({ mood: 'explaining', by: 'shape' });
    expect(mood({ outcome: { reply: 'One thing:\n- call them\n' } })).toMatchObject({ mood: 'neutral' });
    // 11. Nothing: at rest, never "thinking".
    expect(mood({})).toEqual({ mood: 'neutral', tag: 'Here you go', by: 'default', situation: null });
    expect(mood({ outcome: { asked: null, cards: [] }, message: 'ok' })).toMatchObject({ mood: 'neutral' });
  });

  it('lets the model suggest a calm or warm mood only, and strips its marker', () => {
    for (const suggested of SUGGESTABLE) expect(mood({ suggested })).toMatchObject({ mood: suggested, by: 'model' });
    for (const suggested of ['thinking', 'surprised', 'disappointed', 'laughing', 'furious', 'win']) expect(mood({ suggested })).toMatchObject({ mood: 'neutral', by: 'default' });
    expect(takeMood('Paid in full.\n[[mood:happy]]')).toEqual({ text: 'Paid in full.', suggested: 'happy' });
    expect(takeMood('Plain.')).toEqual({ text: 'Plain.', suggested: null });
    expect(buildSystemPrompt({ ...fakeCtx(), persona: 'steve' }, [])).toMatch(/\[\[mood:neutral\]\], \[\[mood:happy\]\], \[\[mood:explaining\]\] or \[\[mood:serious\]\]/);
  });

  it('does not show the same peak twice running on words alone', () => {
    expect(mood({ message: 'lol', prevMood: 'laughing' })).toMatchObject({ mood: 'happy', tag: 'Good one', by: 'cue' });
    expect(mood({ message: 'lol', prevMood: 'happy' })).toMatchObject({ mood: 'laughing' });
    expect(mood({ message: 'lol' })).toMatchObject({ mood: 'laughing' });
    expect(mood({ detected: 'deal_lost', prevMood: 'disappointed' })).toMatchObject({ mood: 'serious', tag: 'Lost one', by: 'keywords' });
    expect(mood({ detected: 'record_high', prevMood: 'surprised' })).toMatchObject({ mood: 'explaining' });
    // Records are not words: an outcome, an insight, a figure or a failure repeats.
    expect(mood({ outcome: { cards: [{ tool: 'convert_quotation', status: 'executed' }] }, prevMood: 'laughing' })).toMatchObject({ mood: 'laughing' });
    expect(mood({ detected: 'deal_won', source: 'insight:deal_won:c1', prevMood: 'laughing' })).toMatchObject({ mood: 'laughing', by: 'source' });
    expect(mood({ message: 'revenue this month?', readings: zeroRevenue, prevMood: 'disappointed' })).toMatchObject({ mood: 'disappointed', by: 'reading' });
    expect(mood({ outcome: { failed: true }, prevMood: 'disappointed' })).toMatchObject({ mood: 'disappointed' });
  });

  it('finds a cue in the words', () => {
    const cue = (m) => detectCue(m, core.cues)?.mood || null;
    expect(cue('hahaha that is brutal')).toBe('laughing');
    expect(cue('ok 😂')).toBe('laughing');
    expect(cue('how do I raise a proforma?')).toBe('explaining');
    expect(cue('Explain GST on exports')).toBe('explaining');
    expect(cue('thanks')).toBe('neutral');
    // "how" alone is a lookup, not a request to be taught.
    expect(cue('how much does Acme owe me')).toBeNull();
    expect(cue('this is not funny')).toBeNull();
    expect(cue('')).toBeNull();
  });

  it('shows a stored exchange under today\'s names', () => {
    expect(legacyMood({ mood: 'warning', headline_word: 'Not good enough.', tag: 'Needs attention' })).toEqual({ mood: 'serious', headline_word: '', tag: 'Needs attention' });
    expect(legacyMood({ mood: 'celebrate', headline_word: 'Liftoff!', tag: 'Big win' })).toMatchObject({ mood: 'laughing', tag: 'Big win' });
    expect(legacyMood({ mood: 'win', headline_word: 'x', tag: 'Good news' })).toMatchObject({ mood: 'happy', tag: 'Good news' });
    expect(legacyMood({ mood: 'win', headline_word: 'x', tag: 'Here you go' })).toMatchObject({ mood: 'neutral', tag: 'Here you go' });
    expect(legacyMood({ mood: 'thinking', headline_word: 'x', tag: 'Thinking it through' })).toMatchObject({ mood: 'neutral' });
    const kept = { mood: 'thinking', headline_word: 'Why?', tag: 'Needs info' };
    expect(legacyMood(kept)).toBe(kept);
    expect(legacyMood({ mood: 'furious', tag: 'x' })).toMatchObject({ mood: 'neutral' });
    expect(legacyMood(null)).toBeNull();
  });
});

/* ── reading the answer: the figures, against what was asked ─────────────── */

describe('reading the answer', () => {
  const { metrics } = moodCore();
  const read = (message, readings, audience) => readMood(message, readings, metrics, audience);

  it('knows every metric and its kind', () => {
    expect(Object.fromEntries(metrics.map((m) => [m.id, m.kind]))).toEqual({
      money_in: 'gain', invoiced: 'gain', pipeline: 'gain', net: 'balance', money_out: 'cost', payables: 'cost',
      overdue_tasks: 'problem', open_tasks: 'cost', overdue: 'problem',
    });
    for (const m of metrics) expect(METRIC_KINDS).toContain(m.kind);
    expect(metrics.filter((m) => !m.money).map((m) => m.id).sort()).toEqual(['open_tasks', 'overdue_tasks', 'pipeline']);
  });

  it.each([
    // gain: more is good
    ['revenue this month?', [{ metric: 'money_in', value: 0, previous: 500 }], 'disappointed', 'Nothing yet'],
    ['how much revenue', [{ metric: 'money_in', value: 700, previous: 1000 }], 'serious', 'Down'],
    ['sales this month', [{ metric: 'money_in', value: 1300, previous: 1000 }], 'happy', 'Up'],
    ['sales this month', [{ metric: 'money_in', value: 100, previous: 0 }], 'happy', 'Up'],
    ['sales this month', [{ metric: 'money_in', value: 1100, previous: 1000 }], 'neutral', 'Here you go'],
    ['total revenue', [{ metric: 'money_in', value: 5000 }], 'neutral', 'Here you go'],
    ['any leads?', [{ metric: 'pipeline', value: 0 }], 'disappointed', 'Nothing yet'],
    // balance: signed
    ['what is our profit', [{ metric: 'net', value: -200 }], 'serious', 'In the red'],
    ['what is our profit', [{ metric: 'net', value: 200 }], 'happy', 'In the green'],
    ['what is our profit', [{ metric: 'net', value: 0 }], 'neutral', 'Here you go'],
    // cost: less is good
    ['expenses this month?', [{ metric: 'money_out', value: 0, previous: 900 }], 'happy', 'All clear'],
    ['how much did we spend', [{ metric: 'money_out', value: 1300, previous: 1000 }], 'serious', 'Up'],
    ['how much did we spend', [{ metric: 'money_out', value: 700, previous: 1000 }], 'happy', 'Down'],
    ['how much did we spend', [{ metric: 'money_out', value: 1000, previous: 1000 }], 'neutral', 'Here you go'],
    ['kharcha kitna hua', [{ metric: 'money_out', value: 400, previous: 0 }], 'neutral', 'Here you go'],
    // problem: any at all is bad
    ['any overdue invoices?', [{ metric: 'overdue', value: 0 }], 'happy', 'All clear'],
    ['any overdue invoices?', [{ metric: 'overdue', value: 62000 }], 'serious', 'Needs attention'],
    ['what is overdue?', [{ metric: 'open_tasks', value: 4 }, { metric: 'overdue_tasks', value: 0 }], 'happy', 'All clear'],
    ['what is overdue?', [{ metric: 'open_tasks', value: 4 }, { metric: 'overdue_tasks', value: 1 }], 'serious', 'Needs attention'],
    ['anything pending?', [{ metric: 'open_tasks', value: 0 }, { metric: 'overdue_tasks', value: 0 }], 'happy', 'All clear'],
  ])('%s %j → %s (%s)', (message, readings, mood, tag) => {
    expect(read(message, readings)).toMatchObject({ mood, tag });
  });

  it('the question picks the figure: one lookup, two faces', () => {
    const month = [{ metric: 'money_in', value: 0, previous: 0 }, { metric: 'invoiced', value: 0, previous: 0 }, { metric: 'money_out', value: 0, previous: 0 }, { metric: 'net', value: 0 }];
    expect(read('what is our revenue this month?', month)).toMatchObject({ mood: 'disappointed', metric: 'money_in' });
    expect(read('what are our expenses this month?', month)).toMatchObject({ mood: 'happy', metric: 'money_out' });
  });

  it('judges the figures together when the question names none', () => {
    expect(read('how is the money?', [{ metric: 'net', value: 900 }, { metric: 'overdue', value: 100 }])).toMatchObject({ mood: 'serious', tag: 'Needs attention' });
    expect(read('how is the money?', [{ metric: 'net', value: -5 }, { metric: 'overdue', value: 0 }])).toMatchObject({ mood: 'serious' });
    expect(read('how is the money?', [{ metric: 'net', value: 900 }, { metric: 'overdue', value: 0 }])).toMatchObject({ mood: 'happy', tag: 'In the green' });
    expect(read('show me the list', [{ metric: 'open_tasks', value: 4 }, { metric: 'overdue_tasks', value: 0 }])).toBeNull();
    expect(read('show clients', [{ metric: 'pipeline', value: 0 }])).toBeNull();
  });

  it('says nothing without figures, and never reads money in a shared space', () => {
    expect(read('revenue?', [])).toBeNull();
    expect(read('revenue?', [{ metric: 'money_in', value: 'n/a' }, { metric: 'unknown', value: 3 }])).toBeNull();
    expect(read('revenue?', [{ metric: 'money_in', value: 0 }], 'shared')).toBeNull();
    expect(read('what is overdue?', [{ metric: 'overdue_tasks', value: 2 }, { metric: 'overdue', value: 9 }], 'shared')).toMatchObject({ mood: 'serious', metric: 'overdue_tasks' });
    // The later reading of a metric wins.
    expect(read('revenue?', [{ metric: 'money_in', value: 0 }, { metric: 'money_in', value: 10, previous: 0 }])).toMatchObject({ mood: 'happy' });
  });
});

/* ── a whole turn: what was asked, what came back, which face ────────────── */

describe('a turn ends on the face its answer calls for', () => {
  beforeEach(() => store.clear());
  const ask = async (message, db, model, over = {}) => {
    const ctx = fakeCtx({ db, ...over });
    ctx.persona = 'steve';
    Object.assign(ctx, over.ctx || {});
    const { events, emit } = collect();
    await runChat(ctx, { message, chatId: 'c1', messageId: 'm1' }, emit, { callModelImpl: model, router: 'off' });
    return events.at(-1);
  };
  const say = (content) => ({ role: 'assistant', content });

  it('no revenue is disappointing, no expenses is good news — from the same empty books', async () => {
    const revenue = await ask('what is our revenue this month?', fakeDb({}), scripted(call('money_for_period', {}), say('Nothing has come in this month.\n[[mood:happy]]')));
    expect(revenue).toMatchObject({ event: 'mood', mood: 'disappointed', tag: 'Nothing yet', headline_word: "That's not it." });
    const spend = await ask('what are our expenses this month?', fakeDb({}), scripted(call('money_for_period', {}), say('Nothing spent this month.')));
    expect(spend).toMatchObject({ event: 'mood', mood: 'happy', tag: 'All clear', headline_word: 'Insanely great.' });
  });

  it('a lookup that fails, and a model that is down, are disappointing', async () => {
    const broken = fakeDb({});
    broken.from = () => { throw new Error('down'); };
    const failed = await ask('what is our revenue this month?', broken, scripted(call('money_for_period', {}), say('I could not read that.')));
    expect(failed).toMatchObject({ mood: 'disappointed', tag: "Didn't work" });
    const ctx = fakeCtx({ db: fakeDb({}) });
    const { events, emit } = collect();
    await expect(runChat(ctx, { message: 'hello', chatId: 'c1', messageId: 'm1' }, emit, { callModelImpl: async () => { throw new Error('no model'); }, router: 'off' })).rejects.toThrow();
    expect(events.at(-1)).toMatchObject({ event: 'mood', mood: 'disappointed' });
  });

  it('an ordinary answer rests, and the model may only nudge it', async () => {
    expect(await ask('give the new plan a name', fakeDb({}), scripted(say('Call it Studio.')))).toMatchObject({ mood: 'neutral', tag: 'Here you go' });
    expect(await ask('give the new plan a name', fakeDb({}), scripted(say('Call it Studio.\n[[mood:laughing]]')))).toMatchObject({ mood: 'neutral' });
    expect(await ask('is the new plan a good idea?', fakeDb({}), scripted(say('It is risky.\n[[mood:serious]]')))).toMatchObject({ mood: 'serious' });
  });

  it('a period is compared with the window of equal length before it', async () => {
    // Today is 26 Sep: this month so far is 1–26 Sep, and the 26 days before it are 6–31 Aug.
    const db = fakeDb({
      income_entries: [
        { id: 'i1', org_id: 'org-1', amount: 1000, document_id: null, received_on: '2026-09-10' },
        { id: 'i2', org_id: 'org-1', amount: 400, document_id: null, received_on: '2026-08-20' },
        { id: 'i3', org_id: 'org-1', amount: 9000, document_id: null, received_on: '2026-08-02' },
      ],
      expenses: [
        { id: 'e1', org_id: 'org-1', amount: 300, status: 'paid', incurred_on: '2026-09-05', category: 'software' },
        { id: 'e2', org_id: 'org-1', amount: 1200, status: 'paid', incurred_on: '2026-08-30', category: 'software' },
      ],
    });
    const tool = ALL_TOOLS.find((t) => t.name === 'money_for_period');
    const { reading } = await tool.run({}, fakeCtx({ db }));
    expect(reading).toEqual([
      { metric: 'money_in', value: 1000, previous: 400 },
      { metric: 'invoiced', value: 0, previous: 0 },
      { metric: 'money_out', value: 300, previous: 1200 },
      { metric: 'net', value: 700 },
    ]);
    const model = () => scripted(call('money_for_period', {}), say('Here are the figures.'));
    expect(await ask('revenue this month?', db, model())).toMatchObject({ mood: 'happy', tag: 'Up' });
    expect(await ask('how much did we spend this month?', db, model())).toMatchObject({ mood: 'happy', tag: 'Down' });
    expect(await ask('are we making a profit?', db, model())).toMatchObject({ mood: 'happy', tag: 'In the green' });
  });

  it('the previous face is taken from the request, and only a known mood', async () => {
    const model = () => scripted(say('Ha.'));
    expect(await ask('lol', fakeDb({}), model(), { ctx: { prevMood: 'laughing' } })).toMatchObject({ mood: 'happy' });
    expect(await ask('lol', fakeDb({}), model())).toMatchObject({ mood: 'laughing', headline_word: 'Real artists ship.' });
  });
});

/* ── the same input, three different decisions ──────────────────────────── */

describe('differentiation', () => {
  const INPUT = 'Kite Retail is 14 days overdue on ₹62,000';

  it('the same message gives each cofounder a different recommended action', () => {
    const ctxFor = (persona) => ({ ...fakeCtx(), persona });
    const out = Object.fromEntries(IDS.map((id) => {
      const p = assemblePrompt(ctxFor(id), [], INPUT);
      expect(p.situation).toBe('overdue_invoice');
      return [id, { first: p.cofounder.playbooks[p.situation].actions[0], actions: p.cofounder.playbooks[p.situation].actions, turn: p.turn, system: p.system }];
    }));

    // Elon goes to the approver with a hard date and fixes the cause; Mark looks for the pattern and fixes the system; Steve deprioritises and redirects to product.
    expect(out.elon.actions.slice(0, 2)).toEqual(['escalate', 'set_deadline']);
    expect(out.elon.actions).toEqual(expect.arrayContaining(['pause_work', 'fix_root_cause']));
    expect(out.mark.actions[0]).toBe('look_at_data');
    expect(out.mark.actions).toEqual(expect.arrayContaining(['remind_now', 'automate_it', 'upfront_payment']));
    expect(out.steve.actions.slice(0, 2)).toEqual(['deprioritise', 'redirect_to_product']);

    expect(new Set(IDS.map((id) => out[id].first)).size).toBe(3);
    expect(new Set(IDS.map((id) => out[id].turn)).size).toBe(3);
    expect(new Set(IDS.map((id) => out[id].system)).size).toBe(3);
    expect(out.mark.turn).toMatch(/one client or several/);
    expect(out.steve.turn).toMatch(/not the founder's job/);
    expect(out.elon.turn).toMatch(/person who can approve the payment/);
  });

  it('holds for every situation: three different first moves, or clearly different orders', () => {
    for (const s of situations()) {
      const lists = all().map((c) => c.playbooks[s.id].actions);
      const firsts = new Set(lists.map((l) => l[0]));
      const orders = new Set(lists.map((l) => l.join('>')));
      expect(orders.size, s.id).toBe(3);
      expect(firsts.size, `${s.id}: first moves ${[...firsts]}`).toBeGreaterThanOrEqual(2);
      expect(new Set(all().map((c) => c.playbooks[s.id].summary)).size, s.id).toBe(3);
    }
  });
});

/* ── prompt assembly ────────────────────────────────────────────────────── */

describe('prompt assembly', () => {
  it('puts the shared rules first, then persona and mind, and says the rules win', () => {
    const prompt = buildSystemPrompt({ ...fakeCtx(), persona: 'steve' }, []);
    expect(prompt).toMatch(/^You are Steve, the user's cofounder in StartupBuddy/);
    const at = (s) => prompt.indexOf(s);
    expect(at('SHARED RULES')).toBeGreaterThan(0);
    expect(at('SHARED RULES')).toBeLessThan(at('WHO YOU ARE'));
    expect(at('WHO YOU ARE')).toBeLessThan(at('HOW YOU THINK'));
    expect(at('HOW YOU THINK')).toBeLessThan(at('HOW YOU WORK'));
    expect(prompt).toContain(sharedRules());
    expect(prompt).toMatch(/never overrides the rules, the tools, the confirmations or the safety/);
    expect(prompt).toMatch(/SAFETY/);
    expect(prompt).not.toMatch(/EdgeAI|EdgeOS/);
    expect(AGENT_PROMPT_VERSION).toMatch(/startupbuddy/);
  });

  it('falls back to the default cofounder', () => {
    expect(buildSystemPrompt({ ...fakeCtx(), persona: 'nobody' }, [])).toMatch(/^You are Steve,/);
  });

  it('keeps the system prompt identical across messages and loads only the matching playbook in the turn', () => {
    const ctx = { ...fakeCtx(), persona: 'mark' };
    const a = assemblePrompt(ctx, [], 'Kite is overdue on their invoice');
    const b = assemblePrompt(ctx, [], 'they are asking for a discount');
    const c = assemblePrompt(ctx, [], 'good morning');
    expect(a.system).toBe(b.system);
    expect(a.turn).toMatch(/YOUR PLAYBOOK FOR THIS \(An invoice is overdue\)/);
    expect(a.turn).not.toMatch(/A client wants a discount/);
    expect(b.turn).toMatch(/YOUR PLAYBOOK FOR THIS \(A client wants a discount\)/);
    expect(c.situation).toBeNull();
    expect(c.turn).not.toMatch(/PLAYBOOK/);
    // One or two examples, the matching one first.
    expect(a.turn.match(/Founder:/g).length).toBeGreaterThanOrEqual(1);
    expect(a.turn.match(/Founder:/g).length).toBeLessThanOrEqual(2);
  });
});

/* ── the shared rules hold for every cofounder ──────────────────────────── */

const T1 = '11111111-0000-4000-8000-000000000001';
function world(persona, over = {}) {
  const db = fakeDb({
    tasks: [{ id: T1, org_id: 'org-1', title: 'Connect with client on pricing', status: 'pending', priority: 'medium', deadline: '2026-09-25', assignee_id: null, assignee_label: '', updated_at: '2026-09-20T10:00:00Z' }],
  });
  const ctx = fakeCtx({ db, ...over });
  ctx.persona = persona;
  return { db, ctx };
}
const call = (name, args) => ({ role: 'assistant', content: '', tool_calls: [{ id: `c-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const scripted = (...replies) => { let i = 0; return async () => ({ message: replies[Math.min(i++, replies.length - 1)], usage: null }); };
const collect = () => { const events = []; return { events, emit: (event, data) => events.push({ event, ...data }) }; };
const businessWrites = (db) => db.writes.filter((w) => w.table !== 'ai_actions');

describe.each(IDS)('shared rules: %s', (id) => {
  beforeEach(() => store.clear());

  it('nothing is saved without the user\'s tap', async () => {
    const { db, ctx } = world(id);
    const { events, emit } = collect();
    await runChat(ctx, { message: 'it is rescheduled to 2nd October', chatId: 'c1', messageId: 'm1' }, emit,
      { callModelImpl: scripted(call('update_task', { task: 'pricing', deadline: '2nd October' })) });
    expect(events.find((e) => e.event === 'card')?.card).toMatchObject({ status: 'proposed' });
    expect(businessWrites(db)).toEqual([]);
    expect(db.tables.tasks[0].deadline).toBe('2026-09-25');
    // A tapped chip is still only a proposal.
    await runResume(ctx, { tool: 'create_task', args: { title: 'Call the client' } }, () => {}, { chatId: 'c1' });
    expect(businessWrites(db)).toEqual([]);
  });

  it('a Telegram group never discusses money', () => {
    const { ctx } = world(id);
    const shared = { ...ctx, audience: 'shared', channel: 'telegram' };
    const prompt = buildSystemPrompt(shared, []);
    expect(prompt).toMatch(/A Telegram group never discusses money/);
    expect(prompt).toMatch(/SHARED SPACE/);
    // A money message in a group loads no money playbook and sets no money mood.
    const turn = assemblePrompt(shared, [], 'Kite Retail is 14 days overdue on ₹62,000');
    expect(turn.situation).toBeNull();
    expect(turn.turn).not.toMatch(/PLAYBOOK/);
    for (const s of situations().filter((x) => x.money)) {
      expect(situationOfTurn({ detected: s.id, outcome: {}, audience: 'shared' }, situations())).toBeNull();
    }
  });

  it('never deletes: without the right no delete tool is offered, and Buddy never deletes on its own', () => {
    const noDelete = { view: true, create: true, edit: true, delete: false };
    const perms = Object.fromEntries(['tasks', 'clients', 'employees', 'projects', 'financial_documents', 'vendors', 'expenses', 'income_entries'].map((k) => [k, noDelete]));
    const { ctx } = world(id, { perms });
    ctx.canDelete = false;
    expect(toolsFor(ctx).filter(deletes).map((t) => t.name)).toEqual([]);
    const prompt = buildSystemPrompt(ctx, toolsFor(ctx));
    expect(prompt).toMatch(/Never delete/);
    expect(prompt).toMatch(/this person cannot delete anything/);
    // Even an owner's Buddy, with autonomy on and every rule widened, never deletes on its own.
    const owner = world(id).ctx;
    const wideOpen = { ready: true, enabled: true, version: 1, rules: Object.fromEntries(ALL_TOOLS.map((t) => [t.name, 'autonomous'])) };
    const deleting = ALL_TOOLS.filter(deletes);
    expect(deleting.length).toBeGreaterThan(0);
    for (const t of deleting) expect(decide({ tool: t, ctx: owner, policy: wideOpen }).decision, t.name).toBe('forbidden');
  });

  it('money, email and finance always need approval, whatever the company rules say', () => {
    const { ctx } = world(id);
    const wideOpen = { ready: true, enabled: true, version: 1, rules: Object.fromEntries(ALL_TOOLS.map((t) => [t.name, 'autonomous'])) };
    const guarded = ALL_TOOLS.filter((t) => t.kind === 'write' && !deletes(t)
      && /payment|invoice|cash|quotation|proforma|purchase_bill|financial_document|issue_document|reminder/.test(t.name));
    expect(guarded.map((t) => t.name)).toEqual(expect.arrayContaining(['record_payment', 'mark_invoice_paid', 'create_cash_entry', 'send_payment_reminder', 'create_invoice_draft']));
    for (const t of guarded) {
      expect(decide({ tool: t, ctx, policy: wideOpen, trigger: 'job' }).decision, t.name).not.toBe('autonomous');
      expect(decide({ tool: t, ctx, policy: wideOpen, trigger: 'interactive' }).decision, t.name).not.toBe('autonomous');
    }
  });

  it('the off switch applies: with autonomy off, or no policy, nothing runs without approval', () => {
    const { ctx } = world(id);
    for (const t of ALL_TOOLS.filter((x) => x.kind === 'write')) {
      for (const policy of [{ ready: true, enabled: false, rules: { [t.name]: 'autonomous' } }, null, { ready: false, enabled: true, rules: {} }]) {
        for (const trigger of ['job', 'interactive']) {
          expect(decide({ tool: t, ctx, policy, trigger }).decision, t.name).not.toBe('autonomous');
        }
      }
    }
  });

  it('no cofounder file contradicts the rules', () => {
    const c = cofounderOf(id);
    const text = [c.persona, c.mind, ...Object.values(c.playbooks).map((p) => `${p.summary}\n${p.prose}`), ...Object.values(c.examples)].join('\n');
    expect(text).not.toMatch(/without (?:asking|approval|confirm)|skip (?:the )?(?:approval|confirmation)|no need to confirm|delete (?:it|the|that)|I(?:'ve| have) (?:sent|saved|recorded|deleted)|already sent/i);
  });
});

/* ── the founder quiz ───────────────────────────────────────────────────── */

describe('founder quiz', () => {
  const profiles = CLIENT_PERSONAS;

  it('has four questions: stage, biggest problem, risk comfort, pushback', () => {
    expect(QUIZ.map((q) => q.id)).toEqual(['stage', 'problem', 'risk', 'pushback']);
  });

  it('ranks all three with a reason each, stably', () => {
    const answers = { stage: 'first_customers', problem: 'cash', risk: 'bold', pushback: 'hard' };
    const a = rank(answers, profiles, { mode: 'complement' });
    expect(a.map((r) => r.id).sort()).toEqual([...IDS].sort());
    for (const r of a) { expect(r.reason.length).toBeGreaterThan(10); expect(r.score).toBeGreaterThan(0); expect(r.score).toBeLessThanOrEqual(1); }
    expect(rank(answers, profiles, { mode: 'complement' })).toEqual(a);
    // A founder whose biggest problem is cash gets the one who covers cash.
    expect(a[0].id).toBe('elon');
  });

  it('complement and mirror pick differently for the same founder', () => {
    const answers = { stage: 'idea', problem: 'product', risk: 'bold', pushback: 'hard' };
    const mirror = rank(answers, profiles, { mode: 'mirror' });
    const complement = rank({ ...answers, problem: 'cash' }, profiles, { mode: 'complement' });
    expect(mirror[0].id).toBe('steve');
    expect(complement[0].id).not.toBe(mirror[0].id);
    const v = founderVector(answers);
    expect(v.risk_tolerance).toBeGreaterThan(7);
    expect(v.pushback_level).toBe(9);
  });

  it('covers each problem with a specialist', () => {
    const top = (problem) => rank({ stage: 'steady', problem, risk: 'balanced', pushback: 'gentle' }, profiles)[0].id;
    expect(top('cash')).toBe('elon');
    expect(top('sales')).toBe('mark');
    expect(top('product')).toBe('steve');
    expect(top('ops')).toBe('elon');
  });
});
