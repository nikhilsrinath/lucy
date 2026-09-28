import { useEffect, useMemo, useState } from 'react';
import { useOrg } from '../context/OrgContext';
import { documentStore } from '../services/documentStore';
import { loadFinanceCategories } from '../services/financeCategories';
import { useSectionList } from '../shell/useSectionList';

/* Every list the Money screens read, live (orgStore listeners, so a change
   the agent confirms shows up here without a reload). */
export function useMoneyData() {
    const { activeOrg } = useOrg();
    const orgId = activeOrg?.id || null;
    const [catsReady, setCatsReady] = useState(false);

    useEffect(() => { loadFinanceCategories().then(() => setCatsReady(true)).catch(() => setCatsReady(true)); }, []);
    useEffect(() => {
        if (!orgId) return;
        documentStore.setContext(orgId);
        documentStore.init().catch(() => { /* lists show what the cache has */ });
    }, [orgId]);

    const docs = useSectionList('fin_docs', orgId);
    const income = useSectionList('income_entries', orgId);
    const expenses = useSectionList('expenses', orgId);
    const purchases = useSectionList('purchase_invoices', orgId);
    const vendors = useSectionList('vendors', orgId);
    const catalog = useSectionList('catalog', orgId);
    const clients = useSectionList('customers', orgId);
    const employees = useSectionList('employees', orgId);

    const byId = useMemo(() => ({
        vendor: Object.fromEntries(vendors.map((v) => [v.id, v])),
        client: Object.fromEntries(clients.map((c) => [c.id, c])),
        employee: Object.fromEntries(employees.map((e) => [e.id, e])),
    }), [vendors, clients, employees]);

    return { orgId, activeOrg, docs, income, expenses, purchases, vendors, catalog, clients, employees, byId, catsReady };
}

export const docClient = (d) => d.issued_to || d.client?.name || d.clientName || 'Client';
