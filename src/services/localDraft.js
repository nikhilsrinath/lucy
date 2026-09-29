// localDraft.js — an unfinished document kept on this device.
//
// Used where a server-side draft would be wrong: a tax invoice takes its
// number from a gap-free series the moment it is written, and it can only be
// cancelled, never deleted — so an invoice "draft" in the database would use up
// a number and sit in the GST register for good. Instead the form itself is
// kept here, per organisation, person and kind, until it is created or thrown
// away. Storage can be missing or full (private windows, quotas), so every
// access is guarded and simply reports failure.

const PREFIX = 'sb_draft';

export const draftKey = (kind, orgId, userId) => (orgId && userId ? `${PREFIX}:${orgId}:${userId}:${kind}` : null);

/** { form, extra, savedAt } or null. */
export function readDraft(key) {
    if (!key) return null;
    try {
        const raw = localStorage.getItem(key);
        const d = raw ? JSON.parse(raw) : null;
        return d && typeof d === 'object' && d.form ? d : null;
    } catch {
        return null;
    }
}

/** true when saved. */
export function writeDraft(key, form, extra = {}) {
    if (!key) return false;
    try {
        localStorage.setItem(key, JSON.stringify({ form, extra, savedAt: new Date().toISOString() }));
        return true;
    } catch {
        return false;
    }
}

export function clearDraft(key) {
    if (!key) return;
    try { localStorage.removeItem(key); } catch { /* nothing to clear */ }
}

/** "29 Sep, 3:40 pm" */
export const savedAtLabel = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
};
