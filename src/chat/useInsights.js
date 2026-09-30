import { useCallback, useEffect, useState } from 'react';
import { getInsights } from '../services/agentService';

/* "Buddy noticed" — the server's insights (api/_lib/agent/insights.js), for
   the brief in Buddy and the suggestions on Home.

   Re-read when the company changes, when the tab comes back into view, and
   when Buddy has just changed something (the event AssistantContext fires
   after a confirm or undo), so a chased invoice or a finished task drops off.

   Dismissing hides one insight for three days on this browser — a per-viewer
   convenience, not shared state. The id is per situation (and changes when
   the situation does, e.g. more tasks overdue), so a real change reappears. */

export const ACTIONS_CHANGED = 'startupbuddy:actions-changed';
const HIDE_MS = 3 * 86400000;
const keyOf = (org, user) => `startupbuddy.insights.hidden.${org}.${user}`;

function readHidden(key) {
    if (!key) return {};
    try {
        const all = JSON.parse(localStorage.getItem(key) || '{}');
        const now = Date.now();
        return Object.fromEntries(Object.entries(all).filter(([, until]) => until > now));
    } catch { return {}; }
}

export function useInsights(orgId, userId) {
    const key = orgId && userId ? keyOf(orgId, userId) : null;
    // Hidden ids belong to one company and person; another pair reads its own.
    const [hiddenState, setHiddenState] = useState(() => ({ key, map: readHidden(key) }));
    if (hiddenState.key !== key) setHiddenState({ key, map: readHidden(key) });
    const hidden = hiddenState.key === key ? hiddenState.map : {};

    const [tick, setTick] = useState(0);
    // The last answer, labelled with the request it answers.
    const [result, setResult] = useState({ req: null, items: null, error: null });
    const req = orgId ? `${orgId}|${Object.keys(hidden).sort().join(',')}|${tick}` : null;

    useEffect(() => {
        if (!orgId) return undefined;
        let gone = false;
        getInsights(orgId, { skip: Object.keys(hidden), limit: 5 })
            .then((r) => { if (!gone) setResult({ req, org: orgId, items: r.insights || [], error: null }); })
            .catch((e) => { if (!gone) setResult({ req, org: orgId, items: null, error: e?.message || 'Could not check the company just now.' }); });
        return () => { gone = true; };
    // `req` captures orgId, hidden and tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [req]);

    useEffect(() => {
        let last = Date.now();
        const refresh = () => setTick((t) => t + 1);
        const onFocus = () => { if (document.visibilityState === 'visible' && Date.now() - last > 60000) { last = Date.now(); refresh(); } };
        window.addEventListener(ACTIONS_CHANGED, refresh);
        document.addEventListener('visibilitychange', onFocus);
        return () => {
            window.removeEventListener(ACTIONS_CHANGED, refresh);
            document.removeEventListener('visibilitychange', onFocus);
        };
    }, []);

    const dismiss = useCallback((id) => {
        if (!key) return;
        const next = { ...readHidden(key), [id]: Date.now() + HIDE_MS };
        try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* private mode: hidden until reload */ }
        setHiddenState({ key, map: next });
    }, [key]);

    // Keep showing the last list for this company while a refresh runs.
    const sameOrg = result.org === orgId;
    return {
        insights: sameOrg && result.items ? result.items.filter((i) => !hidden[i.id]) : null,
        loading: !!req && result.req !== req,
        error: sameOrg ? result.error : null,
        dismiss,
        refresh: () => setTick((t) => t + 1),
    };
}
