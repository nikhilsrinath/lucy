import { useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { useOrg } from '../context/OrgContext';
import { displayNameOf } from '../lib/user';

/** Who is signed in, as the frame and the greeting address them. */
export function useMe() {
    const { user } = useAuth();
    const { activeOrg } = useOrg();
    return useMemo(() => {
        const ownerName = activeOrg?.owner_uid === user?.id ? activeOrg?.owner_full_name : '';
        const full = displayNameOf(user) || ownerName || (user?.email || '').split('@')[0] || 'You';
        const first = String(full).trim().split(/\s+/)[0];
        return {
            name: first ? first.charAt(0).toUpperCase() + first.slice(1) : 'You',
            email: user?.email || '',
            company: activeOrg?.company_name || activeOrg?.name || 'Your company',
        };
    }, [user, activeOrg]);
}
