// invoiceReminderService.js — overdue detection and payment follow-ups.
//
// Runs inside the existing task deadline monitor (useTaskDeadlineMonitor), so
// there is one scheduler in the app, not two. Each pass:
//   1. flags issued invoices past due as 'overdue' (sent/viewed only — paid and
//      partially_paid are derived by the database from payments and are left
//      alone; isOverdue() still catches a partially paid invoice past due);
//   2. emails the client on a fixed cadence: the day it goes overdue, then
//      every REMINDER_INTERVAL_DAYS, at most MAX_AUTO_REMINDERS times.
//
// Reminder state lives in the document's payload (reminder_count,
// last_reminder_at), so no column is needed and a manual send from the invoice
// list counts toward the same cadence.
import { orgStore } from './orgStore';
import { documentStore } from './documentStore';
import { emailService } from './emailService';
import { isOverdue, balanceOf, daysOverdue, todayIso } from './financeAnalytics';

export const REMINDER_INTERVAL_DAYS = 7;
export const MAX_AUTO_REMINDERS = 3;

const money = (v) => (Number(v) || 0).toLocaleString('en-IN', {
  style: 'currency', currency: 'INR', maximumFractionDigits: 2,
});

function reminderDue(doc, now = new Date()) {
  const count = Number(doc.reminder_count) || 0;
  if (count >= MAX_AUTO_REMINDERS) return false;
  if (!doc.last_reminder_at) return true;
  return (now - new Date(doc.last_reminder_at)) / 86400000 >= REMINDER_INTERVAL_DAYS;
}

function buildReminder(doc, profile) {
  const company = profile?.company_name || 'our team';
  const number = doc.doc_number || doc.invoiceNumber || '';
  const days = daysOverdue(doc);
  const firstName = (doc.clientName || '').split(' ')[0] || 'there';
  return {
    subject: `Payment reminder: invoice ${number} is ${days} day${days === 1 ? '' : 's'} overdue`,
    text: `Hi ${firstName},\n\n`
      + `This is a friendly reminder that invoice ${number} from ${company} was due on ${doc.due_date}.\n\n`
      + `Amount outstanding: ${money(balanceOf(doc))}\n`
      + `Days overdue: ${days}\n\n`
      + 'If you have already made this payment, please ignore this message and accept our thanks.\n\n'
      + `Best regards,\n${company}`,
  };
}

export const invoiceReminderService = {
  /** Sends one reminder now and records it. Returns { success, message }. */
  async send(doc) {
    if (!doc.clientEmail) return { success: false, message: 'This invoice has no client email.' };
    const profile = orgStore.getProfile();
    const { subject, text } = buildReminder(doc, profile);
    const res = await emailService.sendEmail({
      to: doc.clientEmail, subject, text, orgProfile: profile,
      fromName: profile?.company_name || 'StartupBuddy',
    });
    if (res && res.success === false) return res;
    await documentStore.updateMeta(doc.id, {
      reminder_count: (Number(doc.reminder_count) || 0) + 1,
      last_reminder_at: new Date().toISOString(),
    });
    return { success: true, message: `Reminder sent to ${doc.clientEmail}` };
  },

  /** One monitor pass. Never throws: a failed send is retried next hour. */
  async runCheck() {
    if (!orgStore.isLoaded()) return;
    const today = todayIso();
    const docs = orgStore.getSectionAsList('fin_docs');
    for (const doc of docs) {
      if (!isOverdue(doc, today)) continue;
      try {
        if (doc.status === 'sent' || doc.status === 'viewed') {
          await documentStore.updateStatus(doc.id, 'overdue');
        }
        if (doc.clientEmail && reminderDue(doc)) {
          // Re-read: updateStatus refreshed the cached row.
          const fresh = orgStore.getSection('fin_docs')[doc.id] || doc;
          await invoiceReminderService.send(fresh);
        }
      } catch (err) {
        console.warn('[invoiceReminders] pass failed for', doc.id, err?.message);
      }
    }
  },
};

export default invoiceReminderService;
