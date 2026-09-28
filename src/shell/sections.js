/* ══════════════════════════════════════════════════════════════════════════
   The five sections and Chat, and which section any path belongs to.

   `sectionOf` also knows the legacy paths, so the sidebar and the tab bar
   light the right section while a screen is still on its old route, and when
   the agent navigates with one of its (unchangeable) hrefs.
   ══════════════════════════════════════════════════════════════════════════ */

export const SECTIONS = [
    { id: 'chat', label: 'Chat', path: '/chat' },
    { id: 'money', label: 'Money', path: '/money' },
    { id: 'clients', label: 'Clients', path: '/clients' },
    { id: 'work', label: 'Work', path: '/work' },
    { id: 'team', label: 'Team', path: '/team' },
    { id: 'settings', label: 'Settings', path: '/settings' },
];

const LEGACY_SECTION = {
    money: ['finance-status', 'cashbook', 'invoices', 'quotations', 'proforma', 'recurring', 'vendors', 'purchases',
        'tax-summary', 'profit-loss', 'new-invoice', 'new-quotation', 'new-proforma', 'products', 'planner', 'revenue'],
    clients: ['crm', 'customers'],
    work: ['tasks', 'projects', 'portfolio', 'timesheets'],
    team: ['employees', 'ex-employees', 'team-hierarchy', 'offer-tracker', 'attendance', 'leave', 'announcements',
        'records', 'offers', 'new-certificates', 'certificates', 'ndas', 'mous',
        'bulk-offers', 'bulk-certificates', 'bulk-team', 'bulk-history'],
    settings: ['profile', 'edgebrain'],
    chat: ['hub', 'library'],
};
const BY_FIRST = new Map(Object.entries(LEGACY_SECTION).flatMap(([s, pages]) => pages.map((p) => [p, s])));

/** The section a pathname belongs to, or null (dashboards, the employee portal). */
export function sectionOf(pathname = '/') {
    const first = String(pathname).replace(/^\/+/, '').split(/[/?#]/)[0] || 'chat';
    if (SECTIONS.some((s) => s.id === first)) return first;
    return BY_FIRST.get(first) || null;
}

/** Legacy pages grouped by section, in rail order — the strip shown above a
 *  screen that has not moved to its new home yet. */
export const LEGACY_PAGES = LEGACY_SECTION;
