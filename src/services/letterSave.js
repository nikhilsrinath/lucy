// letterSave.js — saving an offer letter or NDA from its editor.
//
// Letters are rows in `records` holding the whole form under `data`, which is
// also what their PDF is drawn from — so a draft is simply a letter whose
// status is 'draft', and reopening it puts `data` back into the form.
//
// · Create writes status 'pending' ("Not sent" on Team). Sending the link
//   from the letter's sheet moves it to 'sent'.
// · Draft writes status 'draft'.
// · Carrying on from a draft updates that same row rather than adding one.

import { documentStore } from './documentStore';
import { orgStore } from './orgStore';
import { storageService } from './storageService';

/** The draft's form, when `id` is a draft letter of this kind; otherwise null. */
export async function loadLetterDraft(id, kind, orgId) {
    if (!id || !orgId) return null;
    documentStore.setContext(orgId);
    await documentStore.init().catch(() => {});
    const rec = orgStore.getItem('records', id);
    if (!rec || rec.type !== kind || rec.status !== 'draft') return null;
    return rec.data && typeof rec.data === 'object' ? rec.data : null;
}

/**
 * @param {object} p
 * @param {'offer'|'nda'} p.kind
 * @param {object} p.form      the editor's form, stored as the letter's data
 * @param {'draft'|'pending'} p.status
 * @param {string|null} p.draftId  the draft being carried on, if any
 * @returns {Promise<string>} the letter's id
 */
export async function saveLetter({ kind, form, status, draftId, orgId, userId }) {
    if (draftId && orgStore.getItem('records', draftId)) {
        const existing = orgStore.getItem('records', draftId);
        await orgStore.setItem('records', draftId, {
            type: kind, status, data: form,
            // The same title storageService.save() gives a new letter.
            title: kind === 'nda'
                ? `${form.disclosingPartyName || ''} & ${form.receivingPartyName || ''}`
                : form.studentName || undefined,
            employee_id: existing.employee_id || undefined,
        });
        return draftId;
    }
    const rec = await storageService.save(form, kind, orgId, userId, { status });
    return rec?.id || null;
}
