import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { personaOf, isPersonaId } from './personas';
import { resolveCofounderId } from '../shared/cofounders/legacy.js';

/* ══════════════════════════════════════════════════════════════════════════
   The user's chosen cofounder (decision D3).

   Stored on the person, not the company: Supabase Auth user_metadata, key
   `startupbuddy_cofounder`. No migration, follows them across devices, and
   each teammate may pick their own. Only known ids are ever written.

   A stored id of a retired cofounder is read as its successor at once
   (shared/cofounders/legacy.js — the server does the same). The next time
   that person opens the app, `useCofounderMigration` rewrites the stored id
   and leaves a notice (`startupbuddy_cofounder_moved`) that MovedNotice shows
   once: "Your cofounder is now <name>. Change?"

   The accent colour is published on <html> as --sb-acc, which the `.sb`
   token --acc reads, so sheets and the call screen (portaled) follow it too.
   ══════════════════════════════════════════════════════════════════════════ */

export const COFOUNDER_KEY = 'startupbuddy_cofounder';
export const MOVED_KEY = 'startupbuddy_cofounder_moved';
export const FOUNDER_PROFILE_KEY = 'startupbuddy_founder_profile';

export function useCofounder() {
    const { user } = useAuth();
    const stored = user?.user_metadata?.[COFOUNDER_KEY] ?? null;
    // Optimistic: a pick shows at once, and holds until the stored value moves
    // (the auth event that follows the save, or a change from elsewhere).
    const [pending, setPending] = useState(null);
    const raw = pending && pending.from === stored ? pending.id : stored;
    const { id, migrated } = resolveCofounderId(raw);
    const persona = personaOf(id);

    useEffect(() => {
        document.documentElement.style.setProperty('--sb-acc', persona.acc);
    }, [persona.acc]);

    /** `extra` is saved with the choice (the founder quiz answers, clearing the moved notice). */
    const setCofounder = useCallback(async (next, extra = {}) => {
        if (!isPersonaId(next)) throw new Error('Unknown cofounder');
        setPending({ id: next, from: stored });
        const { error } = await supabase.auth.updateUser({ data: { [COFOUNDER_KEY]: next, ...extra } });
        if (error) { setPending(null); throw error; }
    }, [stored]);

    return {
        persona,
        chosen: !!id,
        setCofounder,
        /** Their stored choice is a retired cofounder, not yet rewritten. */
        needsMigration: migrated,
        /** The cofounder they were moved to and have not been told about yet (an id), or null. */
        movedTo: isPersonaId(user?.user_metadata?.[MOVED_KEY]) ? user.user_metadata[MOVED_KEY] : null,
        founderProfile: user?.user_metadata?.[FOUNDER_PROFILE_KEY] || null,
    };
}

/** Mounted once in the frame: moves a retired choice to its successor and leaves the one-time notice. */
export function useCofounderMigration() {
    const { persona, needsMigration } = useCofounder();
    useEffect(() => {
        if (!needsMigration) return;
        supabase.auth.updateUser({ data: { [COFOUNDER_KEY]: persona.id, [MOVED_KEY]: persona.id } })
            .catch(() => { /* read as the successor meanwhile; tried again next open */ });
    }, [needsMigration, persona.id]);
}

/** The one-time notice has been answered. */
export function dismissMoved() {
    return supabase.auth.updateUser({ data: { [MOVED_KEY]: null } }).catch(() => {});
}
