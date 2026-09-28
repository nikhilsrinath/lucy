import { useEffect } from 'react';
import { taskStore } from '../services/taskStore';
import { orgStore } from '../services/orgStore';
import { emailService } from '../services/emailService';
import { invoiceReminderService } from '../services/invoiceReminderService';
import { runProjectReminders } from '../services/projectService';

function formatDeadline(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' });
}

async function runCheck() {
  if (!orgStore.isLoaded()) return;

  const profile = orgStore.getProfile();
  const today = new Date().toISOString().slice(0, 10);
  const allTasks = taskStore.getAll();

  for (const task of allTasks) {
    if (task.status === 'done') continue;

    // Mark overdue
    if (task.deadline && task.deadline < today && task.status !== 'overdue') {
      await taskStore.markOverdue(task.id);
    }

    // Auto email follow-up for tasks due today or overdue with no prior follow-up
    const isDueOrOverdue =
      (task.deadline && task.deadline <= today) && task.status !== 'done';
    const notYetSent = !task.followUpSentAt;

    if (isDueOrOverdue && notYetSent && task.assignedEmail && profile?.emailjs_service_id) {
      const isOverdue = task.deadline! < today;
      const urgency = isOverdue ? 'overdue' : 'due today';
      const subject = isOverdue
        ? `[Action Required] Task overdue: ${task.title}`
        : `Reminder: Task due today — ${task.title}`;
      const body = `Hi ${task.assignedName.split(' ')[0]},\n\nThis is a reminder that the following task is ${urgency}:\n\nTask: ${task.title}\nDeadline: ${formatDeadline(task.deadline!)}\n${task.description ? `\nDetails: ${task.description}` : ''}\n\nPlease complete or update the status as soon as possible.\n\nBest regards,\n${profile.company_name || 'Your Manager'}`;

      try {
        await (emailService as any).sendEmail({
          to: task.assignedEmail,
          subject,
          text: body,
          orgProfile: profile,
          fromName: profile.company_name || 'StartupBuddy',
        });
        await taskStore.markFollowUpSent(task.id);
      } catch (err) {
        console.warn('[TaskDeadlineMonitor] Email send failed:', err);
      }
    }
  }
}

// One scheduler for the app: task deadlines, overdue invoices and their
// payment reminders (invoiceReminderService), then project reminders (the
// database's project_reminders_run, which sends each threshold once). No pass
// may stop another.
async function runAll() {
  try { await runCheck(); } catch (err) { console.warn('[TaskDeadlineMonitor] task pass failed:', err); }
  try { await invoiceReminderService.runCheck(); } catch (err) { console.warn('[TaskDeadlineMonitor] invoice pass failed:', err); }
  try { await runProjectReminders(); } catch (err) { console.warn('[TaskDeadlineMonitor] project pass failed:', err); }
}

export function useTaskDeadlineMonitor() {
  useEffect(() => {
    // Run on mount with 5-second delay to let orgStore finish loading
    const initial = setTimeout(runAll, 5000);
    // Run every hour
    const interval = setInterval(runAll, 60 * 60 * 1000);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, []);
}
