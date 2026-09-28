import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { personaOf, isPersonaId } from './personas';

/* ══════════════════════════════════════════════════════════════════════════
   The user's chosen cofounder (decision D3).

   Stored on the person, not the company: Supabase Auth user_metadata, key
   `startupbuddy_cofounder`. No migration, follows them across devices, and
   each teammate may pick their own. Only known ids are ever written or read
   back as chosen — anything else falls back to the default.

   The accent colour is published on <html> as --sb-acc, which the `.sb`
   token --acc reads, so sheets and the call screen (portaled) follow it too.
   ══════════════════════════════════════════════════════════════════════════ */

export const COFOUNDER_KEY = 'startupbuddy_cofounder';

export function useCofounder() {
    const { user } = useAuth();
    const stored = user?.user_metadata?.[COFOUNDER_KEY] ?? null;
    // Optimistic: a pick shows at once, and holds until the stored value moves
    // (the auth event that follows the save, or a change from elsewhere).
    const [pending, setPending] = useState(null);
    const id = pending && pending.from === stored ? pending.id : stored;
    const persona = personaOf(id);

    useEffect(() => {
        document.documentElement.style.setProperty('--sb-acc', persona.acc);
    }, [persona.acc]);

    const setCofounder = useCallback(async (next) => {
        if (!isPersonaId(next)) throw new Error('Unknown cofounder');
        setPending({ id: next, from: stored });
        const { error } = await supabase.auth.updateUser({ data: { [COFOUNDER_KEY]: next } });
        if (error) { setPending(null); throw error; }
    }, [stored]);

    return { persona, chosen: isPersonaId(id), setCofounder };
}
