import { supabase } from '../lib/supabase';

/* ══════════════════════════════════════════════════════════════════════════
   AI usage — what the Usage dashboard reads.

   Two sources, deliberately kept apart:
     · usage_counters.ai_messages (0010) — the running total the plan limit is
       enforced against. The headline number always comes from here.
     · ai_usage_events (0067) — one row per call, written best-effort by the
       API. Only the breakdowns (by day, by feature, by person) come from here,
       and they only go back as far as the day 0067 was applied.
   ══════════════════════════════════════════════════════════════════════════ */

export const AI_SURFACES = [
    { id: 'copilot', label: 'Copilot', note: 'chat and voice with the AI co-founder' },
    { id: 'brain', label: 'Company knowledge', note: 'questions answered from company data' },
    { id: 'library', label: 'Document reading', note: 'AI reading scanned files and images' },
];

export const surfaceLabel = (id) => AI_SURFACES.find((s) => s.id === id)?.label || id;

const HISTORY_DAYS = 90;
const MAX_ROWS = 5000;

export const aiUsageService = {
    /**
     * The last 90 days of events, newest first.
     * `available: false` means the table is not there yet (0067 not applied on
     * this database) — the page says so instead of showing an empty history
     * that reads as "nobody used the AI".
     */
    async recent(orgId, days = HISTORY_DAYS) {
        if (!orgId) return { available: false, rows: [] };
        const since = new Date(Date.now() - days * 86400000).toISOString();
        const { data, error } = await supabase
            .from('ai_usage_events')
            .select('id, user_id, actor_email, surface, outcome, model, prompt_tokens, completion_tokens, created_at')
            .eq('org_id', orgId)
            .gte('created_at', since)
            .order('created_at', { ascending: false })
            .limit(MAX_ROWS);
        if (error) {
            console.warn('[aiUsage] history unavailable:', error.message);
            return { available: false, rows: [], error: error.message };
        }
        return { available: true, rows: data || [], truncated: (data || []).length >= MAX_ROWS };
    },
};

const localDay = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * Every breakdown the Usage page draws, from the event rows.
 *
 * `messages` counts what the plan counts: every metered call, blocked ones
 * included, because 0010 increments before it checks the limit. `answered`
 * is the subset that reached the model.
 */
export function summariseUsage(rows = [], { today = localDay(Date.now()), days = 30 } = {}) {
    const series = [];
    const t = new Date(today + 'T00:00:00');
    for (let i = days - 1; i >= 0; i--) {
        const d = new Date(t);
        d.setDate(d.getDate() - i);
        const key = localDay(d);
        series.push({
            key, label: d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }),
            full: d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }),
            copilot: 0, brain: 0, library: 0, total: 0,
        });
    }
    const index = new Map(series.map((s, i) => [s.key, i]));

    const bySurface = Object.fromEntries(AI_SURFACES.map((s) => [s.id, 0]));
    const people = new Map();
    let blocked = 0;
    let failed = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let tokenCalls = 0;

    for (const r of rows) {
        const i = index.get(localDay(r.created_at));
        if (i !== undefined) {
            series[i].total += 1;
            if (r.surface in series[i]) series[i][r.surface] += 1;
        }
        if (r.surface in bySurface) bySurface[r.surface] += 1;
        if (r.outcome === 'blocked') blocked += 1;
        if (r.outcome === 'failed') failed += 1;
        if (r.prompt_tokens != null || r.completion_tokens != null) {
            tokenCalls += 1;
            promptTokens += Number(r.prompt_tokens) || 0;
            completionTokens += Number(r.completion_tokens) || 0;
        }
        const who = r.actor_email || (r.user_id ? 'Former member' : 'Unknown');
        const p = people.get(who) || { name: who, value: 0, last: r.created_at };
        p.value += 1;
        if (r.created_at > p.last) p.last = r.created_at;
        people.set(who, p);
    }

    const inWindow = series.reduce((a, s) => a + s.total, 0);
    const activeDays = series.filter((s) => s.total > 0).length;
    const busiest = series.reduce((m, s) => (s.total > (m?.total || 0) ? s : m), null);
    const last7 = series.slice(-7).reduce((a, s) => a + s.total, 0);
    const prev7 = series.slice(-14, -7).reduce((a, s) => a + s.total, 0);

    return {
        series,
        total: rows.length,
        inWindow,
        answered: rows.length - blocked,
        blocked,
        failed,
        bySurface: AI_SURFACES.map((s) => ({ ...s, value: bySurface[s.id] })),
        people: [...people.values()].sort((a, b) => b.value - a.value),
        tokens: { prompt: promptTokens, completion: completionTokens, calls: tokenCalls },
        activeDays,
        busiest: busiest && busiest.total ? busiest : null,
        perActiveDay: activeDays ? inWindow / activeDays : 0,
        last7,
        prev7,
        firstAt: rows.length ? rows[rows.length - 1].created_at : null,
    };
}

/**
 * Where the allowance is heading. `null` when there is nothing to project from
 * (no limit, or no use in the last 30 days) — a runway computed from zero use
 * is a division, not a forecast.
 */
export function runway({ used, limit, perDay }) {
    if (limit == null || !Number.isFinite(limit)) return null;
    const left = Math.max(0, limit - used);
    if (left === 0) return { left, days: 0 };
    if (!perDay || perDay <= 0) return null;
    return { left, days: Math.floor(left / perDay) };
}
