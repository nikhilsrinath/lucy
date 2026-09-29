/* ══════════════════════════════════════════════════════════════════════════
   The sections, the five areas the navigation shows, and which section any
   path belongs to.

   Navigation has five areas: Home, Work, Buddy (the cofounder — the chat, at
   /chat), Business and Team. Business gathers two content sections that keep
   their own routes — Money (/money/:tab) and Clients (/clients) — under one
   hub at /business, so every existing link, redirect and agent href still
   lands where it did. Settings sits behind the company / profile area.

   `sectionOf` also knows the legacy paths, so the sidebar and the tab bar
   light the right area while a screen is still on its old route, and when
   the agent navigates with one of its (unchangeable) hrefs.
   ══════════════════════════════════════════════════════════════════════════ */

export const SECTIONS = [
    { id: 'home', label: 'Home', path: '/home' },
    { id: 'work', label: 'Work', path: '/work' },
    { id: 'chat', label: 'Buddy', path: '/chat' },
    { id: 'business', label: 'Business', path: '/business' },
    { id: 'team', label: 'Team', path: '/team' },
    { id: 'money', label: 'Business', path: '/money', area: 'business' },
    { id: 'clients', label: 'Business', path: '/clients', area: 'business' },
    { id: 'settings', label: 'Settings', path: '/settings' },
];

/** The five areas, in tab-bar order. Buddy is the middle one. */
export const NAV_AREAS = ['home', 'work', 'chat', 'business', 'team'];

/** The area (nav entry) a section is shown under. */
export const areaOf = (section) => SECTIONS.find((s) => s.id === section)?.area || section;

const LEGACY_SECTION = {
    money: ['finance-status', 'cashbook', 'invoices', 'quotations', 'proforma', 'recurring', 'vendors', 'purchases',
        'tax-summary', 'profit-loss', 'new-invoice', 'new-quotation', 'new-proforma', 'products', 'planner', 'revenue'],
    clients: ['crm', 'customers'],
    work: ['tasks', 'projects', 'portfolio', 'timesheets'],
    team: ['employees', 'ex-employees', 'team-hierarchy', 'offer-tracker', 'attendance', 'leave', 'announcements',
        'records', 'offers', 'new-certificates', 'certificates', 'ndas', 'mous',
        'bulk-offers', 'bulk-certificates', 'bulk-team', 'bulk-history'],
    settings: ['profile', 'edgebrain'],
    chat: ['hub', 'library', 'buddy'],
};
const BY_FIRST = new Map(Object.entries(LEGACY_SECTION).flatMap(([s, pages]) => pages.map((p) => [p, s])));

/** The section a pathname belongs to, or null (dashboards, the employee portal). */
export function sectionOf(pathname = '/') {
    const first = String(pathname).replace(/^\/+/, '').split(/[/?#]/)[0] || 'home';
    if (SECTIONS.some((s) => s.id === first)) return first;
    return BY_FIRST.get(first) || null;
}

/** Legacy pages grouped by section, in rail order — the strip shown above a
 *  screen that has not moved to its new home yet. */
export const LEGACY_PAGES = LEGACY_SECTION;
