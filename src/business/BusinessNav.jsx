import React from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';

/* ══════════════════════════════════════════════════════════════════════════
   The Business hub's tabs. Business is one area over two sets of screens
   that keep their routes: the overview (/business), Clients (/clients) and
   Money's tabs (/money/:tab). This strip is what makes them read as one
   place; each screen renders it under its header.
   ══════════════════════════════════════════════════════════════════════════ */

const BUSINESS_TABS = [
    { id: 'overview', label: 'Overview', to: '/business' },
    { id: 'clients', label: 'Clients', to: '/clients' },
    { id: 'invoices', label: 'Invoices & quotes', to: '/money/invoices' },
    { id: 'transactions', label: 'Transactions', to: '/money/transactions' },
    { id: 'expenses', label: 'Expenses', to: '/money/expenses' },
    { id: 'bills', label: 'Bills', to: '/money/bills' },
    { id: 'items', label: 'Items', to: '/money/items' },
    { id: 'reports', label: 'Reports', to: '/money/reports' },
];

/** counts: { [tabId]: number } — shown beside the label when non-zero. */
export default function BusinessNav({ counts = {} }) {
    const { pathname } = useLocation();
    const { tab } = useParams();
    const active = pathname.startsWith('/clients') ? 'clients'
        : pathname.startsWith('/business') ? 'overview'
            : tab || 'transactions';
    return (
        <nav className="sb-tabs" aria-label="Business">
            {BUSINESS_TABS.map((t) => (
                <Link key={t.id} to={t.to} aria-current={active === t.id ? 'page' : undefined}>
                    {t.label}{counts[t.id] ? <span className="c">{counts[t.id]}</span> : null}
                </Link>
            ))}
        </nav>
    );
}
