// documentStore.js — financial documents, HR notices, notifications and
// recurring invoices. A thin wrapper over orgStore, as before.
//
// Three things changed with Supabase:
//   • Document numbers come from the next_document_number() RPC at save time,
//     not from a client-side count. nextId() is gone.
//   • HR notices (role_change, termination) live in `records`, not `fin_docs` —
//     they are employee documents with an employee_id, no line items and no GST.
//   • Notifications are rows with per-user read state, not one array on the org.
//
// The portal fallback branch is gone too: `anon` has no grants on any table, so
// an unauthenticated recipient cannot reach PostgREST at all and goes through
// /api/portal instead. Deleting that branch also removes the `doc` shadowing
// crash it contained.
import { orgStore } from './orgStore';
import { supabase } from '../lib/supabase';

const FINANCIAL_TYPES = new Set(['invoice', 'quotation', 'proforma']);
// Everything else is an HR document and lives in `records`: the four original
// types plus the two notices that used to be squeezed into fin_docs.
const HR_TYPES = new Set(['offer', 'certificate', 'nda', 'mou', 'role_change', 'termination']);

// The app is inconsistent about the offer key — storageService says 'offer',
// the portal and bulk tools say 'offer_letter'. The enum says 'offer'.
const normalizeType = (type) => (type === 'offer_letter' ? 'offer' : type);

// The human-facing document number. Firebase used it AS the document id, so
// the UI printed `doc.id` wherever a number belonged; in Postgres `id` is a
// uuid primary key and the number lives in doc_number. Anything user-visible —
// a list column, a PDF header, a filename, an alert — must go through this.
export { docNumber } from '../shared/finDocs.js';

let _contextOrgId = null;

export const documentStore = {
  // Names the organization init() should ensure is loaded. Under Firebase this
  // also drove an anonymous-read fallback for the portal; that path is gone.
  setContext(orgId) {
    _contextOrgId = orgId || null;
  },

  async init() {
    const orgId = _contextOrgId || orgStore.getOrgId();
    if (!orgId) return;
    if (!orgStore.isLoaded() || orgStore.getOrgId() !== orgId) {
      await orgStore.load(orgId);
    }
  },

  getCompanyProfile: () => orgStore.getProfile(),

  getSavedClients: () => orgStore.getSectionAsList('customers'),

  // Financial documents only — the finance screens' list.
  getAll: () => orgStore
    .getSectionAsList('fin_docs')
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at)),

  getByType: (type) => documentStore.getAll().filter((d) => d.type === type),

  // The portal and Employees.jsx look documents up by id without knowing which
  // table they came from, so check both.
  getById: (id) => orgStore.getItem('fin_docs', id) || orgStore.getItem('records', id),

  async save(docData) {
    const type = normalizeType(docData.type);
    const data = { ...docData, type };

    if (HR_TYPES.has(type)) {
      return data.id && orgStore.getItem('records', data.id)
        ? await orgStore.setItem('records', data.id, data)
        : await orgStore.addItem('records', data);
    }

    if (!FINANCIAL_TYPES.has(type)) {
      throw new Error(`[documentStore] Unsupported document type: ${docData.type}`);
    }

    return data.id && orgStore.getItem('fin_docs', data.id)
      ? await orgStore.updateFinDoc(data.id, data)
      : await orgStore.saveFinDoc(data);
  },

  /** { status, revision, published, locked } for a financial document, fresh from the database. */
  versionState: (id) => orgStore.finDocVersionState(id),

  /**
   * Save an edit to an existing quotation or proforma, the way its lifecycle
   * allows. Never sent: updated in place (and sent now, if `send`). Already
   * sent: published as the next version, which goes back to the client — the
   * database refuses any other write to a sent document's content.
   *
   * @returns {Promise<{doc: object, published: boolean}>}
   * @throws  when the version is locked (accepted), or when a publish would
   *          change nothing.
   */
  async saveEdit(id, docData, { send = false, summary } = {}) {
    const state = await orgStore.finDocVersionState(id);
    if (!state) throw new Error('This document no longer exists.');
    if (state.locked) {
      throw new Error('The client has already accepted this version, so it can no longer be changed.');
    }
    const data = { ...docData, id, type: normalizeType(docData.type) };

    if (!state.published) {
      const doc = await orgStore.updateFinDoc(id, { ...data, status: send ? 'sent' : 'draft' });
      return { doc, published: false };
    }

    try {
      const doc = await orgStore.publishFinDocVersion(id, data, summary);
      return { doc, published: true };
    } catch (err) {
      if (/NO_CHANGES/.test(err.message || '')) {
        throw new Error(`Nothing has changed since ${state.revision || 'the version the client has'}.`);
      }
      throw err;
    }
  },

  async updateStatus(id, status, extra = {}) {
    // An undefined status would be written as 'draft' by the row mappers, so a
    // caller that only means to attach metadata gets the status left alone.
    const updates = status ? { status, ...extra } : { ...extra };
    if (orgStore.getItem('records', id)) {
      return await orgStore.updateItem('records', id, updates);
    }
    return await orgStore.updateFinDoc(id, updates);
  },

  /** Attach fields to a document without touching its status. */
  updateMeta: (id, extra = {}) => documentStore.updateStatus(id, null, extra),

  async delete(id) {
    if (orgStore.getItem('records', id)) {
      return await orgStore.removeItem('records', id);
    }
    return await orgStore.deleteFinDoc(id);
  },

  // ── Notifications ─────────────────────────────────────────────────────────
  // Rows in `notifications`; read state per user in `notification_reads`.

  getNotifications: () => orgStore
    .getSectionAsList('fin_notifs')
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at)),

  addNotification: (notification) => orgStore.addItem('fin_notifs', notification),

  // Marks read for the CURRENT USER. Under Firebase one person opening a
  // notification marked it read for everyone in the organization.
  async markNotificationRead(id) {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { error } = await supabase.from('notification_reads')
      .upsert({ notification_id: id, user_id: user.id }, { onConflict: 'notification_id,user_id' });
    if (error) {
      console.warn('[documentStore] could not mark notification read:', error.message);
      return;
    }
    const cached = orgStore.getItem('fin_notifs', id);
    if (cached) cached.read = true;
  },

  deleteNotification: (id) => orgStore.removeItem('fin_notifs', id),

  async clearAllNotifications() {
    const ids = documentStore.getNotifications().map((n) => n.id);
    await Promise.all(ids.map((id) => orgStore.removeItem('fin_notifs', id)));
  },

  getUnreadCount: () => documentStore.getNotifications().filter((n) => !n.read).length,

  // ── Payments ──────────────────────────────────────────────────────────────
  //
  // amount_paid and the paid/partially_paid status are derived by a trigger
  // from confirmed payment rows. Nothing here writes a status for that reason:
  // record the money and the document follows.

  getPayments: (id) => documentStore.getById(id)?.payments || [],

  /** The recipient's unverified claim, if one is still waiting on an admin. */
  getPendingPayment: (id) =>
    documentStore.getPayments(id).find((p) => !p.confirmed_at) || null,

  /** What is still owed. Falls back to the document total when nothing is paid. */
  outstandingOf(doc) {
    const total = Number(doc?.grand_total ?? doc?.amount ?? 0);
    const paid = Number(doc?.amount_paid ?? 0);
    return Math.max(0, Number((total - paid).toFixed(2)));
  },

  recordPayment: (documentId, details = {}) =>
    orgStore.addPayment({ documentId, ...details }),

  confirmPayment: (paymentId, documentId) =>
    orgStore.confirmPayment(paymentId, documentId),

  deletePayment: (paymentId, documentId) =>
    orgStore.deletePayment(paymentId, documentId),

  // ── Recurring invoices ────────────────────────────────────────────────────

  getRecurring: () => orgStore.getSectionAsList('fin_recurring'),

  async saveRecurring(item) {
    return item.id && orgStore.getItem('fin_recurring', item.id)
      ? await orgStore.setItem('fin_recurring', item.id, item)
      : await orgStore.addItem('fin_recurring', item);
  },

  deleteRecurring: (id) => orgStore.removeItem('fin_recurring', id),
};
