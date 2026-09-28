import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useOrg } from '../context/OrgContext';
import { orgStore } from '../services/orgStore';
import { getStatus as brainStatus, buildBrain } from '../services/brainService';
import { useSectionList } from '../shell/useSectionList';
import { useShell } from '../shell/shellContext';
import { buildBrief } from './brief';

/* The brief's inputs, all live: orgStore sections (Realtime-backed), plus two
   one-off checks — whether Gmail is connected (owner/admin only, as the
   endpoint allows) and whether the knowledge base has been built. */

async function gmailConfigured(orgId) {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return null;
    const res = await fetch(`/api/org-secrets?org_id=${encodeURIComponent(orgId)}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
    });
    const data = await res.json().catch(() => ({}));
    return res.ok && data.success ? { configured: Boolean(data.configured) } : null;
}

export function useBrief({ persona, name }) {
    const { activeOrg } = useOrg();
    const orgId = activeOrg?.id || null;
    const docs = useSectionList('fin_docs', orgId);
    const income = useSectionList('income_entries', orgId);
    const expenses = useSectionList('expenses', orgId);
    const purchases = useSectionList('purchase_invoices', orgId);
    const vendors = useSectionList('vendors', orgId);
    const tasks = useSectionList('tasks', orgId);
    const notifications = useSectionList('fin_notifs', orgId);

    const { setBrainBuilt } = useShell();
    const [checks, setChecks] = useState({ orgId: null, gmail: null, brain: null });
    const [building, setBuilding] = useState(false);
    const [buildError, setBuildError] = useState('');

    const refreshBrain = useCallback(async () => {
        if (!orgId || !orgStore.can('edgebrain', 'view')) return null;
        try {
            const s = await brainStatus(orgId);
            const st = s.state?.status;
            return { built: !!st && st !== 'absent' && st !== 'error', canBuild: !!s.can?.build, status: st };
        } catch { return null; }
    }, [orgId]);

    useEffect(() => {
        if (!orgId) return undefined;
        let gone = false;
        const admin = ['owner', 'admin'].includes(orgStore.getRole());
        Promise.all([
            admin ? gmailConfigured(orgId).catch(() => null) : Promise.resolve(null),
            refreshBrain(),
        ]).then(([gmail, brain]) => { if (!gone) setChecks({ orgId, gmail, brain }); });
        return () => { gone = true; };
    }, [orgId, refreshBrain]);

    const build = useCallback(async () => {
        if (!orgId || building) return;
        setBuilding(true);
        setBuildError('');
        try {
            await buildBrain(orgId);
            const brain = await refreshBrain();
            setChecks((c) => ({ ...c, brain }));
        } catch (e) {
            setBuildError(e?.message || 'The build did not finish. Try again from Settings.');
        } finally {
            setBuilding(false);
        }
    }, [orgId, building, refreshBrain]);

    const fresh = checks.orgId === orgId;
    const built = fresh && !!checks.brain?.built;
    useEffect(() => { setBrainBuilt?.(built); }, [built, setBrainBuilt]);
    const brief = useMemo(() => buildBrief({
        docs, income, expenses, purchases, vendors, tasks,
        // Opening a notification removes it (as the old bell did), so what is
        // left is what has not been looked at. Only the last fortnight's.
        notifications: notifications
            .filter((n) => !n.created_at || Date.now() - Date.parse(n.created_at) < 14 * 86400000)
            .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))),
        can: (r, a) => orgStore.can(r, a),
        persona, name,
        gmail: fresh ? checks.gmail : null,
        brain: fresh ? checks.brain : null,
    }), [docs, income, expenses, purchases, vendors, tasks, notifications, persona, name, fresh, checks]);

    return { brief, build, building, buildError };
}
