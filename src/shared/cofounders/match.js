import { VECTOR_AXES } from './parse.js';

/**
 * The founder quiz: four taps → a vector on the cofounders' own seven axes →
 * a ranking of the cofounders, each with a one-line reason.
 *
 *   complement  (default) the cofounder who is strong where the founder is not:
 *               the founder's vector is reflected around the middle on the
 *               five trait axes before comparing.
 *   mirror      the cofounder who thinks the way the founder does.
 *
 * How blunt and how hard they push back is never reflected: that follows the
 * founder's own answer in both modes.
 */

export const QUIZ = [
  { id: 'stage', question: 'Where is the business right now?', options: [
    { value: 'idea', label: 'Just starting' },
    { value: 'first_customers', label: 'First customers' },
    { value: 'steady', label: 'Steady revenue' },
    { value: 'scaling', label: 'Growing fast' },
  ] },
  { id: 'problem', question: 'What is your biggest problem today?', options: [
    { value: 'cash', label: 'Cash is tight or clients pay late' },
    { value: 'sales', label: 'Not enough new deals' },
    { value: 'product', label: 'The product or service is not good enough yet' },
    { value: 'ops', label: 'Work keeps slipping' },
  ] },
  { id: 'risk', question: 'How do you feel about risk?', options: [
    { value: 'careful', label: 'Careful. Protect what we have' },
    { value: 'balanced', label: 'Balanced' },
    { value: 'bold', label: 'Bold. Bet on the upside' },
  ] },
  { id: 'pushback', question: 'How should your cofounder push back?', options: [
    { value: 'hard', label: 'Challenge me hard' },
    { value: 'gentle', label: 'Question me gently' },
    { value: 'back_me', label: 'Back my call' },
  ] },
];

const MANNER_AXES = ['directness', 'pushback_level'];
const TRAIT_AXES = VECTOR_AXES.filter((a) => !MANNER_AXES.includes(a));

// What each answer says about the founder. Deltas from the middle (5).
const DELTAS = {
  stage: {
    idea: { risk_tolerance: 2, cash_vs_growth: 2, detail_vs_big_picture: 2 },
    first_customers: { relationship_vs_transaction: -2, cash_vs_growth: 1 },
    steady: { risk_tolerance: -1, cash_vs_growth: -1, detail_vs_big_picture: -1 },
    scaling: { detail_vs_big_picture: -2, speed_vs_polish: 1 },
  },
  // A problem is where the founder leans away from: tight cash means they lean to growth.
  problem: {
    cash: { cash_vs_growth: 3, detail_vs_big_picture: 2 },
    sales: { relationship_vs_transaction: 3, cash_vs_growth: -1 },
    product: { speed_vs_polish: -3, detail_vs_big_picture: -1 },
    ops: { detail_vs_big_picture: 3, speed_vs_polish: -1 },
  },
  risk: {
    careful: { risk_tolerance: -3 },
    balanced: {},
    bold: { risk_tolerance: 4 },
  },
};
const MANNER = {
  hard: { directness: 9, pushback_level: 9 },
  gentle: { directness: 6, pushback_level: 5 },
  back_me: { directness: 3, pushback_level: 2 },
};

const clamp = (n) => Math.max(0, Math.min(10, n));

export function founderVector(answers = {}) {
  const v = Object.fromEntries(VECTOR_AXES.map((a) => [a, 5]));
  for (const q of Object.keys(DELTAS)) {
    for (const [axis, d] of Object.entries(DELTAS[q][answers[q]] || {})) v[axis] = clamp(v[axis] + d);
  }
  Object.assign(v, MANNER[answers.pushback] || {});
  return v;
}

// One phrase per axis for a cofounder at the low and the high end of it.
const PHRASES = {
  risk_tolerance: ['keeps the downside small', 'takes the bold bet'],
  cash_vs_growth: ['watches the cash first', 'pushes for growth'],
  speed_vs_polish: ['moves fast', 'insists on quality'],
  relationship_vs_transaction: ['puts the relationship first', 'keeps it businesslike'],
  detail_vs_big_picture: ['catches the details', 'holds the big picture'],
};

function targetFor(founder, mode) {
  if (mode !== 'complement') return founder;
  const t = { ...founder };
  for (const axis of TRAIT_AXES) t[axis] = 10 - founder[axis];
  return t;
}

function reasonFor(c, target, founder, mode, covered) {
  if (covered) return `Strongest on ${c.speciality.toLowerCase()}, which is your biggest problem today.`;
  // The trait axis where this cofounder sits closest to what was asked for,
  // preferring an axis where they have a clear lean.
  const axis = [...TRAIT_AXES].sort((a, b) => (
    (Math.abs(c.vector[a] - target[a]) - Math.abs(c.vector[a] - 5) / 2) - (Math.abs(c.vector[b] - target[b]) - Math.abs(c.vector[b] - 5) / 2)
  ))[0];
  const phrase = PHRASES[axis][c.vector[axis] >= 5 ? 1 : 0];
  const differs = Math.abs(c.vector[axis] - founder[axis]) >= 3;
  if (mode === 'complement' && differs) return `Balances you: ${c.name} ${phrase} where you lean the other way.`;
  if (mode === 'mirror' && !differs) return `Thinks like you: ${c.name} ${phrase}, as you do.`;
  return `${c.name} ${phrase}.`;
}

/**
 * Ranks the cofounders for these answers, best first:
 *   [{ id, score (0–1), reason }]
 * Stable: ties keep the order the profiles were given in.
 */
export function rank(answers, profiles, { mode = 'complement' } = {}) {
  const founder = founderVector(answers);
  const target = targetFor(founder, mode);
  const max = Math.sqrt(VECTOR_AXES.length * 100);
  return profiles
    .map((c, i) => {
      const dist = Math.sqrt(VECTOR_AXES.reduce((sum, a) => sum + (c.vector[a] - target[a]) ** 2, 0));
      const covered = !!answers.problem && (c.covers || []).includes(answers.problem);
      const score = Math.min(1, (1 - dist / max) + (covered ? 0.15 : 0));
      return { id: c.id, score: Math.round(score * 1000) / 1000, reason: reasonFor(c, target, founder, mode, covered), i };
    })
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(({ i: _i, ...r }) => r);
}
