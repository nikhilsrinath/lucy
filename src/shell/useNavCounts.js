import { useMemo } from 'react';
import { useOrg } from '../context/OrgContext';
import { paymentPosition } from '../services/financeAnalytics';
import { useSectionList } from './useSectionList';

/**
 * The numbers beside the nav areas — all live, all real:
 *   business  invoices past their due date with a balance (red)
 *   work      tasks not done
 * A section the role cannot read is an empty list, so its count is 0 and
 * nothing is shown.
 */
export function useNavCounts() {
    const { activeOrg } = useOrg();
    const orgId = activeOrg?.id || null;
    const docs = useSectionList('fin_docs', orgId);
    const tasks = useSectionList('tasks', orgId);

    return useMemo(() => {
        const overdue = paymentPosition(docs).overdueCount;
        const open = tasks.filter((t) => t.status !== 'done').length;
        return {
            business: { n: overdue, tone: 'r', label: `${overdue} overdue` },
            work: { n: open, label: `${open} open tasks` },
        };
    }, [docs, tasks]);
}
