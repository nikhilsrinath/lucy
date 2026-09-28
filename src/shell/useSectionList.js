import { useEffect, useState } from 'react';
import { orgStore } from '../services/orgStore';

const EMPTY = [];

/**
 * A live list for an orgStore section: the cached rows at once, the server's
 * answer when it lands, then every Realtime change — including the ones the
 * agent's confirmed writes cause (0068 publishes those tables). A section the
 * role cannot read comes back empty, so counts built on it are honest zeros.
 */
export function useSectionList(section, orgId) {
    const key = orgId ? `${orgId}:${section}` : null;
    const [state, setState] = useState({ key: null, list: EMPTY });
    useEffect(() => {
        if (!key) return undefined;
        return orgStore.listenSection(section, (value) => setState({ key, list: Object.values(value || {}) }));
    }, [key, section]);
    if (!key) return EMPTY;
    // Until the listener has answered for this org, the cache is the answer.
    return state.key === key ? state.list : orgStore.getSectionAsList(section);
}
