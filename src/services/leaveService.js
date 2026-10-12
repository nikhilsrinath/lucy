// leaveService.js — leave types, applications, approvals and balances.
//
// The two rules that matter are in the database, not here:
//   · nobody approves their own request      app.guard_leave_decision (0029 §7)
//   · the notification is written for you    app.notify_leave_request (0029 §8)
// so `decide()` is a plain UPDATE and the manager's panel fills itself.
//
// Balances come from the `leave_balances_v` view rather than a stored counter:
// a rejected-after-approval request or a backdated correction would silently
// desynchronise a number kept by hand.

import { supabase } from '../lib/supabase';
import { countLeaveDays, rangesOverlap } from '../shared/leave.js';

export const LEAVE_STATUSES = {
  pending:   { label: 'Pending',   color: '#f59e0b' },
  approved:  { label: 'Approved',  color: '#10b981' },
  rejected:  { label: 'Rejected',  color: '#ef4444' },
  cancelled: { label: 'Cancelled', color: '#94a3b8' },
};

const TYPE_SELECT = 'id, org_id, name, code, annual_quota, is_paid, color, is_active, sort_order';
const REQ_SELECT = `id, org_id, employee_id, leave_type_id, start_date, end_date, days, half_day,
                    reason, status, decided_by, decided_at, decision_comment, created_at`;

// ── Day counting ─────────────────────────────────────────────────────────────
// Shared with the server (Buddy files leave from chat): src/shared/leave.js.

export { countLeaveDays, rangesOverlap };

export const leaveService = {
  // ── Types ──────────────────────────────────────────────────────────────────

  async listTypes(orgId, { includeInactive = false } = {}) {
    if (!orgId) return [];
    let q = supabase.from('leave_types').select(TYPE_SELECT).eq('org_id', orgId);
    if (!includeInactive) q = q.eq('is_active', true);
    const { data, error } = await q.order('sort_order').order('name');
    if (error) throw error;
    return data || [];
  },

  async saveType(orgId, type) {
    const row = {
      org_id: orgId,
      name: type.name?.trim(),
      code: type.code?.trim().toUpperCase() || null,
      annual_quota: Number(type.annual_quota) || 0,
      is_paid: type.is_paid !== false,
      color: type.color || null,
      is_active: type.is_active !== false,
      sort_order: Number(type.sort_order) || 0,
    };
    const q = type.id
      ? supabase.from('leave_types').update(row).eq('id', type.id)
      : supabase.from('leave_types').insert(row);
    const { data, error } = await q.select(TYPE_SELECT).single();
    if (error) throw error;
    return data;
  },

  /** Deactivates rather than deletes: requests reference the type (on delete
   *  restrict), and a deleted type would erase the history of leave taken. */
  async deactivateType(id) {
    const { error } = await supabase.from('leave_types').update({ is_active: false }).eq('id', id);
    if (error) throw error;
  },

  // ── Requests ───────────────────────────────────────────────────────────────

  /**
   * @param filters {employeeId, status, from, to, typeId}
   * RLS decides the ceiling: an approver sees the org, an employee sees their
   * own rows and their direct reports'. No filter here widens that.
   */
  async listRequests(orgId, filters = {}) {
    if (!orgId) return [];
    let q = supabase.from('leave_requests').select(REQ_SELECT).eq('org_id', orgId);
    if (filters.employeeId) q = q.eq('employee_id', filters.employeeId);
    if (filters.status) q = q.eq('status', filters.status);
    if (filters.typeId) q = q.eq('leave_type_id', filters.typeId);
    if (filters.from) q = q.gte('start_date', filters.from);
    if (filters.to) q = q.lte('end_date', filters.to);
    const { data, error } = await q.order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  },

  async applyForLeave(orgId, { employeeId, leaveTypeId, startDate, endDate, halfDay = false, reason = '', skipWeekends = false }) {
    const days = countLeaveDays(startDate, endDate, { halfDay, skipWeekends });
    if (!days) throw new Error('Pick a start and end date; the end cannot be before the start.');
    if (!leaveTypeId) throw new Error('Choose a leave type.');

    const { data, error } = await supabase.from('leave_requests').insert({
      org_id: orgId, employee_id: employeeId, leave_type_id: leaveTypeId,
      start_date: startDate, end_date: endDate, days, half_day: halfDay,
      reason: reason.trim() || null,
    }).select(REQ_SELECT).single();
    if (error) throw error;
    return data;
  },

  /** @param status 'approved' | 'rejected'. The trigger stamps who and when. */
  async decide(id, status, comment = '') {
    if (!['approved', 'rejected'].includes(status)) throw new Error(`Unknown decision: ${status}`);
    const { data, error } = await supabase.from('leave_requests')
      .update({ status, decision_comment: comment.trim() || null })
      .eq('id', id).select(REQ_SELECT).maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('You do not have permission to decide this request.');
    return data;
  },

  /** Withdrawal by the applicant. Only a pending request can be cancelled. */
  async cancel(id) {
    const { data, error } = await supabase.from('leave_requests')
      .update({ status: 'cancelled' }).eq('id', id).select(REQ_SELECT).maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('This request can no longer be cancelled.');
    return data;
  },

  /** Edit a pending request in place — dates or reason, never the status. */
  async updateRequest(id, { startDate, endDate, halfDay, reason, leaveTypeId, skipWeekends = false }) {
    const days = countLeaveDays(startDate, endDate, { halfDay, skipWeekends });
    if (!days) throw new Error('Pick a start and end date; the end cannot be before the start.');
    const { data, error } = await supabase.from('leave_requests').update({
      leave_type_id: leaveTypeId, start_date: startDate, end_date: endDate,
      days, half_day: halfDay, reason: reason?.trim() || null,
    }).eq('id', id).select(REQ_SELECT).maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('This request can no longer be edited.');
    return data;
  },

  // ── Balances ───────────────────────────────────────────────────────────────

  /** Derived, never stored. One row per active leave type. */
  async balances(orgId, employeeId) {
    if (!orgId || !employeeId) return [];
    const { data, error } = await supabase
      .from('leave_balances_v')
      .select('leave_type_id, leave_type_name, year, quota, taken, adjusted, remaining')
      .eq('org_id', orgId).eq('employee_id', employeeId);
    if (error) throw error;
    return data || [];
  },

  async adjustBalance(orgId, { employeeId, leaveTypeId, year, delta, note }) {
    const { data, error } = await supabase.from('leave_adjustments').insert({
      org_id: orgId, employee_id: employeeId, leave_type_id: leaveTypeId,
      year: Number(year) || new Date().getFullYear(),
      delta: Number(delta), note: note?.trim() || null,
    }).select().single();
    if (error) throw error;
    return data;
  },
};
