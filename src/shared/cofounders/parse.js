/**
 * Parsers for the cofounder files (cofounders/**). Pure: text in, objects
 * out, no file access — the server reads the files from disk
 * (api/_lib/agent/cofounders.js), the client bundles them
 * (src/design/personas.js), and both hand the text to these.
 */

export const MOODS = ['warning', 'win', 'thinking', 'celebrate'];
export const VECTOR_AXES = [
  'risk_tolerance', 'cash_vs_growth', 'speed_vs_polish', 'relationship_vs_transaction',
  'detail_vs_big_picture', 'directness', 'pushback_level',
];

const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

/** `## heading` blocks of a markdown text → [{ id, body }], in order. */
function sections(md, level = '##') {
  const out = [];
  let cur = null;
  for (const line of String(md || '').replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith(`${level} `)) {
      cur = { id: line.slice(level.length + 1).trim(), lines: [] };
      out.push(cur);
    } else if (/^#\s/.test(line)) {
      cur = null;
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  return out.map((s) => ({ id: s.id, body: s.lines.join('\n').trim() }));
}

/** Leading `key: value` lines of a block, and the prose after them. */
function fields(body) {
  const out = {};
  const lines = body.split('\n');
  let i = 0;
  for (; i < lines.length; i++) {
    const m = lines[i].match(/^([a-z_]+):\s*(.*)$/);
    if (!m) break;
    out[m[1]] = m[2].trim();
  }
  return { fields: out, prose: lines.slice(i).join('\n').trim() };
}

/** cofounders/_core/situations.md → { situations, actions }. */
export function parseSituations(md) {
  const text = String(md || '').replace(/\r\n/g, '\n');
  const cut = text.indexOf('\n# Actions');
  const situations = sections(cut < 0 ? text : text.slice(0, cut)).map(({ id, body }) => {
    const { fields: f } = fields(body);
    return {
      id,
      title: f.title || id,
      mood: f.mood,
      tag: f.tag || '',
      money: f.money === 'true',
      keywords: list(f.keywords).map((k) => k.toLowerCase()),
      sources: list(f.sources),
      tools: list(f.tools),
      problem: f.problem || null,
    };
  });
  const actions = (cut < 0 ? '' : text.slice(cut)).split('\n')
    .map((l) => l.match(/^- ([a-z_]+):\s*(.+)$/))
    .filter(Boolean)
    .map((m) => ({ id: m[1], meaning: m[2].trim() }));
  return { situations, actions };
}

/** playbooks.md → { [situationId]: { actions, summary, prose } }. */
export function parsePlaybooks(md) {
  const out = {};
  for (const { id, body } of sections(md)) {
    const { fields: f, prose } = fields(body);
    out[id] = { actions: list(f.actions), summary: f.summary || '', prose };
  }
  return out;
}

/** examples.md → { [situationId]: 'Founder: …\nName: …' }. */
export function parseExamples(md) {
  const out = {};
  for (const { id, body } of sections(md)) if (body) out[id] = body;
  return out;
}

/** persona.md → { text (everything but the headlines), headlines: { mood: word } }. */
export function parsePersona(md) {
  const parts = sections(md);
  const headlines = {};
  const head = parts.find((s) => s.id.toLowerCase() === 'headlines');
  for (const line of (head?.body || '').split('\n')) {
    const m = line.match(/^([a-z]+):\s*(.+)$/);
    if (m && MOODS.includes(m[1])) headlines[m[1]] = m[2].trim();
  }
  const text = parts.filter((s) => s !== head).map((s) => `${s.id.toUpperCase()}: ${s.body.replace(/\s*\n\s*/g, ' ')}`).join('\n');
  return { text, headlines };
}

/** mind.md → one compact block the model reads. */
export function parseMind(md) {
  return sections(md).map((s) => `${s.id.toUpperCase()}:\n${s.body}`).join('\n\n');
}

/** rules.md → the rules as written, without the title. */
export function parseRules(md) {
  return String(md || '').replace(/\r\n/g, '\n').split('\n').filter((l) => !/^#\s/.test(l)).join('\n').trim();
}

/** One cofounder from its five files. */
export function buildCofounder({ profile, persona, mind, playbooks, examples }) {
  const p = parsePersona(persona);
  return {
    ...profile,
    persona: p.text,
    headlines: p.headlines,
    mind: parseMind(mind),
    playbooks: parsePlaybooks(playbooks),
    examples: parseExamples(examples),
  };
}

/** Everything a set of cofounders must satisfy. Returns a list of problems (empty = valid). */
export function validate(cofounders, { situations, actions }) {
  const problems = [];
  const known = new Set(actions.map((a) => a.id));
  for (const s of situations) {
    if (!MOODS.includes(s.mood)) problems.push(`situation ${s.id}: mood "${s.mood}"`);
  }
  for (const c of cofounders) {
    for (const axis of VECTOR_AXES) {
      const v = c.vector?.[axis];
      if (!(Number.isFinite(v) && v >= 0 && v <= 10)) problems.push(`${c.id}: vector.${axis}`);
    }
    for (const mood of MOODS) if (!c.headlines[mood]) problems.push(`${c.id}: no ${mood} headline`);
    for (const s of situations) {
      const pb = c.playbooks[s.id];
      if (!pb) { problems.push(`${c.id}: no playbook for ${s.id}`); continue; }
      if (!pb.actions.length) problems.push(`${c.id}/${s.id}: no actions`);
      if (!pb.summary) problems.push(`${c.id}/${s.id}: no summary`);
      for (const a of pb.actions) if (!known.has(a)) problems.push(`${c.id}/${s.id}: unknown action ${a}`);
    }
    for (const id of Object.keys(c.examples)) {
      if (!situations.some((s) => s.id === id)) problems.push(`${c.id}: example for unknown situation ${id}`);
    }
  }
  return problems;
}
