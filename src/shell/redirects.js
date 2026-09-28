/* ══════════════════════════════════════════════════════════════════════════
   Old paths → new ones.

   The agent's navigation (api/_lib/agent/tools/navigate.js PAGES, and each
   resolver's href in resolvers.js) produces the old paths — `/invoices`,
   `/customers`, `/tasks?task=<id>`, `/projects/<id>` — and the tool contract
   is not changing. This table is what makes those land on the new screens,
   along with bookmarks, emailed links and notification targets.

   `resolveLegacyPath(pathWithSearch)` returns the new path (with any query it
   carries over), or null when the path is not a legacy one.

   A screen is redirected only once its new home exists: until then its old
   route still renders. `LIVE_SECTIONS` is that switch, flipped per phase.
   ══════════════════════════════════════════════════════════════════════════ */

/** Sections whose new screens are built. Legacy paths into any other section
 *  are left alone (they still render their old screen). */
export const LIVE_SECTIONS = new Set(['chat']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// [pattern, section, to(match, params) → new path]
const RULES = [
    [/^\/?$/, 'chat', () => '/chat'],
    [/^\/hub\/?$/, 'chat', () => '/chat'],
    [/^\/library\/?$/, 'chat', () => '/chat?files=1'],

    [/^\/(dashboard|dashboard\/finance|revenue|tax-summary|profit-loss)\/?$/, 'money', () => '/money/reports'],
    [/^\/cashbook\/?$/, 'money', () => '/money/transactions'],
    [/^\/invoices\/?$/, 'money', () => '/money/invoices?type=invoice'],
    [/^\/quotations\/?$/, 'money', () => '/money/invoices?type=quotation'],
    [/^\/proforma\/?$/, 'money', () => '/money/invoices?type=proforma'],
    [/^\/(finance-status|recurring)(\/.*)?$/, 'money', () => '/money/invoices'],
    [/^\/new-invoice\/?$/, 'money', () => '/money/invoices/new?type=invoice'],
    [/^\/new-proforma\/?$/, 'money', () => '/money/invoices/new?type=proforma'],
    [/^\/new-quotation\/?$/, 'money', () => '/money/invoices/new?type=quotation'],
    [/^\/new-quotation\/([^/]+)\/?$/, 'money', (m) => `/money/invoices/${m[1]}/edit`],
    [/^\/(vendors|purchases)\/?$/, 'money', () => '/money/bills'],
    [/^\/(products|planner)\/?$/, 'money', () => '/money/items'],

    [/^\/(crm|customers|dashboard\/sales)\/?$/, 'clients', () => '/clients'],

    [/^\/tasks\/?$/, 'work', (m, q) => (q.get('task') ? `/work?task=${encodeURIComponent(q.get('task'))}` : '/work')],
    // A notification for an accepted quotation starts a project from it.
    [/^\/projects\/new\/?$/, 'work', (m, q) => (q.get('fromQuotation')
        ? `/work?newProject=1&fromQuotation=${encodeURIComponent(q.get('fromQuotation'))}` : '/work?newProject=1')],
    [/^\/projects\/([^/]+)\/?$/, 'work', (m) => (UUID.test(m[1]) ? `/work?project=${m[1]}` : '/work')],
    [/^\/(projects|portfolio|timesheets|dashboard\/projects)\/?$/, 'work', () => '/work'],

    [/^\/employees\/new\/?$/, 'team', () => '/team?addPerson=1'],
    [/^\/offers\/?$/, 'team', () => '/team/letters/offer/new'],
    [/^\/ndas\/?$/, 'team', () => '/team/letters/nda/new'],
    [/^\/(employees|ex-employees|team-hierarchy|offer-tracker|records|certificates|new-certificates|mous|attendance|leave|announcements|bulk-offers|bulk-certificates|bulk-team|bulk-history|dashboard\/team|dashboard\/documents)\/?$/, 'team', () => '/team'],

    [/^\/dashboard\/usage\/?$/, 'settings', () => '/settings#plan'],
    [/^\/edgebrain\/?$/, 'settings', () => '/settings#ai'],
    [/^\/profile\/?$/, 'settings', (m, q, hash) => `/settings${hash || ''}`],
];

/**
 * @param {string} href  a path, optionally with ?query and #hash
 * @param {{ live?: Set<string> }} [opts] which sections are live (default LIVE_SECTIONS)
 * @returns {string|null}
 */
export function resolveLegacyPath(href, { live = LIVE_SECTIONS } = {}) {
    if (typeof href !== 'string' || !href.startsWith('/')) return null;
    const hashAt = href.indexOf('#');
    const hash = hashAt >= 0 ? href.slice(hashAt) : '';
    const noHash = hashAt >= 0 ? href.slice(0, hashAt) : href;
    const qAt = noHash.indexOf('?');
    const path = qAt >= 0 ? noHash.slice(0, qAt) : noHash;
    const query = new URLSearchParams(qAt >= 0 ? noHash.slice(qAt + 1) : '');
    for (const [re, section, to] of RULES) {
        const m = path.match(re);
        if (!m) continue;
        if (!live.has(section)) return null;
        return to(m, query, hash);
    }
    return null;
}

/** Every section a rule can send to — for the test that proves full coverage. */
export const REDIRECT_SECTIONS = [...new Set(RULES.map((r) => r[1]))];
