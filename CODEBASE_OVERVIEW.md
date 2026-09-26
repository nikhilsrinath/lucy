# EdgeOS — Codebase Overview

> A map of the whole repository: every feature and route, the modules and the files behind them, the services, the serverless API, the database schema, the security model, the tooling and the known loose ends.
>
> Written 2026-09-25 against `main` @ `2b2f90f` plus the uncommitted hub/copilot work in the working tree. Line counts are approximate. The **live Supabase project does not match the repo's migrations exactly**; see [§13 Known caveats](#13-known-caveats--loose-ends).

---

## Table of contents

1. [What EdgeOS is](#1-what-edgeos-is)
2. [Tech stack](#2-tech-stack)
3. [Repository layout](#3-repository-layout)
4. [Runtime architecture](#4-runtime-architecture)
5. [Routing & app shell](#5-routing--app-shell)
6. [Feature modules (the product)](#6-feature-modules-the-product)
7. [Cross-cutting UI: hub, AI copilot, design system](#7-cross-cutting-ui-hub-ai-copilot-design-system)
8. [Client services layer (`src/services`)](#8-client-services-layer-srcservices)
9. [Hooks, context, lib, utils, data](#9-hooks-context-lib-utils-data)
10. [Serverless API (`api/`)](#10-serverless-api-api)
11. [Database (`supabase/`)](#11-database-supabase)
12. [Tooling, tests, CI, scripts, docs](#12-tooling-tests-ci-scripts-docs)
13. [Known caveats & loose ends](#13-known-caveats--loose-ends)
14. [Where to look for X (quick index)](#14-where-to-look-for-x-quick-index)

---

## 1. What EdgeOS is

EdgeOS (the npm package is still named `qbitointern`, and `README.md` still says "OfferPro") is a **multi-tenant, all-in-one back office for small Indian companies**. It covers:

- **HR documents**: offer letters, certificates, NDAs, MoUs and HR notices (role change, termination), rendered to PDF, sent by email, and signed by the recipient through a token-gated **recipient portal**.
- **Finance**: invoices, quotations, proforma invoices, recurring invoices, payments, a cash book, vendors, purchase bills, a GST tax summary, P&L and cash flow.
- **Clients**: a CRM pipeline, a client directory and a product/service catalogue with sales roll-ups.
- **Team & people ops**: employee registry, ex-employees, an org chart, a task board, attendance, leave, announcements, and a self-service **employee portal**.
- **Analytics**: a customisable hub of widgets, a drill-down dashboard, and a revenue-by-country world map.
- **AI**: *EdgeAI* (a Gemini-powered copilot that can also write cash-book entries from a sentence) and *EdgeBrain* (a derived knowledge graph of the company, built in SQL, used for grounded AI answers with provenance).
- **Platform console** (`/admin`): a cross-tenant operator console for plans, org lifecycle and email.

Plans are tiered **Free / Pro / Max** (`src/services/planConfig.js`), with quotas on documents and AI messages.

---

## 2. Tech stack

| Layer | Choice | Where |
|---|---|---|
| UI | React 19, React Router 7 | `src/main.jsx`, `src/App.jsx` |
| Build | Vite 7 (+ a dev-server plugin that runs `api/*` in-process) | `vite.config.js` |
| Styling | Plain CSS + JS design tokens (no Tailwind) | `src/index.css` (~15k lines), `src/theme/*`, `src/components/ui/edge.jsx` |
| Icons / motion | `lucide-react`, `framer-motion` | throughout |
| Charts | `recharts`, plus a hand-rolled SVG kit | `src/components/overview/vizKit.jsx`, `hub/widgets.jsx` |
| Graph canvas | `@xyflow/react` (org chart), custom SVG (EdgeBrain) | `TeamHierarchy.jsx`, `brain/KnowledgeGraph.jsx` |
| PDF | `jspdf` + html2canvas-style capture of live previews | `src/services/pdfService.js` |
| Spreadsheets | `xlsx` (CSV/XLSX import/export) | bulk tools, attendance export |
| Misc | `qrcode.react` (UPI QR), `react-signature-canvas` | `shared/UPIQRGenerator.jsx`, `shared/SignatureCapture.jsx` |
| Backend | Supabase (Postgres + RLS, Auth, Storage, Realtime) | `supabase/`, `src/lib/supabase.js` |
| Serverless | Vercel functions (Node) | `api/*.js` |
| Email | Nodemailer over each org's own Gmail SMTP (encrypted app password) | `api/email.js` |
| AI | Google Gemini `gemini-3.6-flash` via its OpenAI-compatible endpoint | `api/nvidia.js`, `api/brain.js` |
| Tests | Vitest (unit), plain-Postgres SQL tests (RLS) | `vitest.config.js`, `supabase/tests/` |
| Map build | `d3-geo`, `topojson-client`, `world-atlas`, `i18n-iso-countries` (dev only) | `scripts/generate-world-map.js` |

TypeScript is used in a handful of AI/task files (`*.ts`, `CopilotPanel.tsx`); everything else is JS/JSX.

---

## 3. Repository layout

```
EdgeOs/
├── api/                      Vercel serverless functions (see §10)
│   └── _lib/                 shared server helpers: auth, crypto, portal tokens, brain retrieval
├── src/
│   ├── main.jsx              React root + BrowserRouter
│   ├── App.jsx               All routes, module registry, shell selection
│   ├── index.css             Global stylesheet (legacy + page styles)
│   ├── components/
│   │   ├── *.jsx             Top-level pages (forms, previews, CRM, employees…)
│   │   ├── admin/            Platform console (/admin)
│   │   ├── assistant/        EdgeAI copilot (context, UI, orb, cash-entry card)
│   │   ├── brain/            EdgeBrain module
│   │   ├── bulk/             Bulk offers/certificates/team import (+ shared/)
│   │   ├── cofounder/        Legacy CopilotPanel.tsx (orphaned; see §13)
│   │   ├── dashboard/        SalesByCountries map widget
│   │   ├── financial/        Finance module pages
│   │   ├── hub/              Hub widget board (data, layout, catalog, widgets)
│   │   ├── landing/          Marketing sub-pages (/pricing, /privacy, …)
│   │   ├── overview/         /dashboard analytics + drill-downs
│   │   ├── people/           Attendance, leave, announcements, work insights
│   │   ├── portal/           Recipient portal, employee portal, /join
│   │   ├── settings/         Roles & permissions, join code, access role picker
│   │   ├── shared/           Reusable pieces (A4Stage, pickers, signature, toast…)
│   │   ├── shell/            ModuleShell, MobileNav, module registry, rail pin/slot
│   │   ├── tasks/            Task board + modal
│   │   └── ui/               The "edge" component kit (edge.jsx, edgeUtils.js)
│   ├── context/              AuthContext, OrgContext
│   ├── hooks/                Theme, plan status, speech, pan-zoom, deadline monitor…
│   ├── lib/                  Supabase client, auth error messages, profile completion
│   ├── services/             Data + domain logic (orgStore, documentStore, AI, finance…)
│   ├── theme/                edge.js tokens, EdgeTheme context, surface.css
│   ├── data/                 indianStates.js, worldMap.js (generated)
│   └── utils/                htmlEscape, imageUtils
├── supabase/
│   ├── migrations/           0001–0043 (see §11)
│   ├── pending/              0026_drop_legacy_client_tables.sql (not yet applied)
│   ├── tests/                SQL RLS/isolation tests + expected output
│   └── config.toml           Supabase CLI config
├── scripts/                  Map/country generators, admin setup, Firebase→Supabase ETL, DB test runner
├── docs/                     RUNBOOK-restore.md, phase-0 decision records
├── .github/workflows/        backup.yml (weekly encrypted off-platform backup)
├── public/                   Logo, app icon, PWA manifest
├── main-hub.html             Untracked static mock of the hub (structure reference only)
├── FIX_PLAN.md, MEGA_AUDIT.md/.html, DESIGN_SYSTEM_AUDIT.md, SUPABASE_MIGRATION.md,
│   SKILL.md, EdgeOS-Overview.pdf       Historical audits and plans
├── vite.config.js, vitest.config.js, eslint.config.js, vercel.json, netlify.toml
└── .env / .env.example
```

---

## 4. Runtime architecture

```
Browser (React SPA)
 ├── AuthProvider ─ Supabase Auth (email/password + Google OAuth)
 ├── OrgProvider  ─ memberships → orgStore.load(orgId)
 │     └── orgStore: in-memory cache of every org "section" (= Postgres table),
 │                  localStorage mirror for instant paint, Realtime listeners
 ├── Pages read orgStore synchronously; writes go straight to Supabase (RLS-checked)
 └── Privileged calls → /api/*  (Bearer = Supabase access token)

Vercel functions (api/)
 ├── requireUser / requireOrgRole / requirePlatformAdmin   (api/_lib/auth.js)
 ├── supabaseAdmin() service-role client                    (api/_lib/supabaseAdmin.js)
 └── Gmail SMTP, Gemini, HMAC portal tokens, AES-GCM secrets

Supabase
 ├── Postgres: tenant tables, RLS driven by role_permissions (0026/0027)
 ├── schema `app`: SECURITY DEFINER helpers, guards, triggers, EdgeBrain sync
 ├── Storage buckets: org-branding (public), signatures, documents, receipts, employee-photos
 └── Realtime: orgStore.listenSection(), brainService.subscribeToBrain()
```

**Key principles, as stated in the code comments:**

- **The database is the authority.** RLS and `app.*` triggers enforce who may do what. The UI only mirrors those rules so its controls don't lie (`permissionService.js`, `RolePermissions.jsx`, `LeaveRequests.jsx`).
- **No secrets in the browser.** The Gmail password, portal-token HMAC key, Gemini key and service role all live server-side. `anon` has no table grants at all, so the recipient portal goes through `/api/portal`.
- **Derived, not duplicated.** Finance figures are pure functions over recorded rows (`financeAnalytics.js`, `overviewModel.js`). EdgeBrain is a SQL projection of the tables. Revenue by country is aggregated in Postgres.
- **AI must not bluff.** Answers come from real data, with counts and provenance (`api/_lib/brainRetrieval.js`). Writes the AI proposes, such as cash entries, are deterministic and confirmed by the user (`cashIntent.js`).

---

## 5. Routing & app shell

### 5.1 Top-level routes (`src/App.jsx` → `App`)

| Path | Component | Notes |
|---|---|---|
| `/portal/:documentId` | `portal/RecipientPortal.jsx` (via `PortalRouteWrapper`) | Public; token in `?token=`. No account needed. |
| `/join` | `portal/JoinPortal.jsx` | Employee onboarding by invite `?t=` or join code `?c=` |
| `/admin/*` | `admin/AdminApp.jsx` | Platform console, own sign-in |
| `/ai-cofounder`, `/pricing`, `/invoicing`, `/offer-letters`, `/legal-documents`, `/certificates`, `/documentation`, `/support`, `/changelog`, `/privacy`, `/terms`, `/security` | `landing/pages/*` (lazy, `landing/subPageData.js`) wrapped in `landing/SubPage.jsx` | Marketing pages |
| `/*` | `AppContent` | The authenticated app |

### 5.2 `AppContent` gate order

1. `loading` → spinner.
2. No user → `/login` shows `Auth.jsx`, `/signup` shows `Registration.jsx`, anything else shows `LandingPage.jsx`.
3. `needsOnboarding` (user with no membership) → `Registration` (Google flow).
4. Wait for `meService.getMyRole()`. If the role is **`employee`**, render `EmployeePortal` instead of the admin app.
5. Otherwise, render the routed page inside `ShellFrame` → `ModuleShell` (except `/hub`), wrapped in `AssistantProvider`, with the global `AIAssistant` launcher.

`useTaskDeadlineMonitor()` runs here: one scheduler for task deadlines **and** overdue-invoice reminders.

### 5.3 Module registry

`App.jsx` defines `MODULE_FILTER` (module → page ids), `MODULE_EXTRA_PAGES`, `FLUSH_PAGES` (edge-to-edge pages), `MODULE_META`, `NAV_ITEMS` (rail items + icons) and `PAGE_META` (title/subtitle per page). `src/components/shell/modules.js` → `MODULES` is the hub rail / mobile bottom-bar order:

| Module id | Code | Label | Default page | Pages |
|---|---|---|---|---|
| `overall` | DSH | Dashboard | `dashboard` | dashboard |
| `finance` | FIN | Finance | `finance-status` | finance-status, cashbook, invoices, quotations, proforma, recurring, vendors, purchases, tax-summary, profit-loss (+ new-invoice, new-quotation, new-proforma) |
| `business` | CLM | Client Management | `crm` | crm, customers, products, planner |
| `projects` | PRJ | Projects | `projects` | projects, tasks, portfolio, timesheets (+ project-detail, new-project) |
| `team` | TEA | Team | `team-hierarchy` | team-hierarchy, employees, offer-tracker, ex-employees, bulk-team, attendance, leave, announcements |
| `documents` | DOC | Documents | `new-certificates` | offers, new-certificates, certificates, ndas, mous, bulk-offers, bulk-certificates |
| `data` | REC | Records | `records` | records, bulk-history |
| `brain` | BRN | EdgeBrain | `edgebrain` | edgebrain |

`/profile` (Company Profile) wears the shell under a "Settings" label, and its sections become the rail through `shell/railSlot.js` → `RailSlotContext`.

### 5.4 Full in-app route table

| Route | Component |
|---|---|
| `/hub` | `Hub.jsx` |
| `/dashboard` | `overview/Overview.jsx` |
| `/edgebrain` | `brain/EdgeBrain.jsx` |
| `/profile` | `CompanyProfile.jsx` |
| `/offers` | `OfferForm.jsx` |
| `/new-certificates`, `/certificates` | `CertificateForm.jsx` |
| `/ndas` | `NdaForm.jsx` |
| `/mous` | `MoUForm.jsx` |
| `/finance-status` | `financial/FinanceStatus.jsx` |
| `/cashbook` | `financial/CashBook.jsx` |
| `/invoices`, `/quotations`, `/proforma` | `financial/InvoiceList.jsx` (`type=` invoice / quotation / proforma) |
| `/recurring`, `/recurring/new`, `/recurring/edit/:id` | `financial/RecurringInvoiceForm.jsx` (`RecurringInvoiceList` / `RecurringInvoiceForm`) |
| `/vendors` | `financial/Vendors.jsx` |
| `/purchases` | `financial/PurchaseInvoices.jsx` |
| `/tax-summary` | `financial/TaxSummary.jsx` |
| `/profit-loss` | `financial/ProfitLoss.jsx` |
| `/new-invoice` | `InvoiceForm.jsx` |
| `/new-quotation`, `/new-quotation/:docId` | `financial/QuotationForm.jsx` (edit mode via `QuotationFormWrapper`) |
| `/new-proforma` | `financial/ProformaInvoiceForm.jsx` |
| `/crm` | `CRM.jsx` |
| `/customers` | `Customers.jsx` |
| `/products` | `Products.jsx` |
| `/planner` | `ProductPlanner.jsx` |
| `/revenue` | `BillingRevenue.jsx` (routed, not in any rail) |
| `/records` | `InternRecords.jsx` |
| `/employees`, `/employees/new` | `Employees.jsx`, `EmployeeForm.jsx` |
| `/ex-employees` | `ExEmployees.jsx` |
| `/me` | `portal/EmployeePortal.jsx` |
| `/attendance` | `people/AttendanceSheet.jsx` |
| `/leave` | `people/LeaveRequests.jsx` |
| `/announcements` | `people/Announcements.jsx` |
| `/team-hierarchy` | `TeamHierarchy.jsx` |
| `/offer-tracker` | `OfferTracker.jsx` |
| `/tasks` | `tasks/TasksPage.jsx` |
| `/bulk-offers`, `/bulk-certificates`, `/bulk-team`, `/bulk-history` | `bulk/BulkOfferLetters.jsx`, `BulkCertificates.jsx`, `BulkTeamMembers.jsx`, `BulkHistory.jsx` |
| `*` | redirect → `/hub` |

### 5.5 Shell components (`src/components/shell/`)

- **`ModuleShell.jsx`** is the frame for every module page: a left rail listing the module's pages with a hub link, and a top bar with the org switcher, search, notifications (`documentStore.getNotifications`), the theme toggle, the account menu and the profile-completion red dot (`useProfileCompletion`). It provides `EdgeThemeContext` and `RailSlotContext`. Styles live in `edgeBridge.css`, which restyles legacy `index.css` pages into the edge look.
- **`MobileNav.jsx`** is the bottom bar on phones (`MOBILE_NAV_H`).
- **`railPin.jsx`** holds `useRailPin` and `RailPinButton`, which keep the rail open or let it auto-collapse (persisted).
- **`railSlot.js`** holds `RailSlotContext`, which lets a page render its own rail contents (used by CompanyProfile).
- **`modules.js`** holds `MODULES`.

---

## 6. Feature modules (the product)

### 6.1 Authentication, onboarding & organizations

| Piece | File | What it does |
|---|---|---|
| Sign in | `components/Auth.jsx` | Email/password and Google. Errors come through `lib/authErrors.js` → `authErrorMessage()`. |
| Registration wizard | `components/Registration.jsx` | Asks the six things an org needs: credentials, company, signatory and one line of AI context. Calls `OrgContext.createOrganization` → `services/orgProvisioning.js` → RPC `public.create_organization` (a single transaction that seeds org, owner membership, department, founder employee, settings, subscription, usage, banking and permissions). |
| Auth state | `context/AuthContext.jsx` → `AuthProvider`, `useAuth` | `user`, `loading`, `needsOnboarding` (no `memberships` row), `login`, `signup(email, pw, onUserCreated)`, `loginWithGoogle(next)`, `logout`, `updatePassword`, `reauthenticate`. |
| Org state | `context/OrgContext.jsx` → `OrgProvider`, `useOrg` | `organizations`, `activeOrg`, `setActiveOrg`, `createOrganization`, `updateOrganization`, `fetchOrganizations`. Hydrates `orgStore` per org. |
| Profile gaps | `lib/profileCompletion.js` (`PROFILE_ESSENTIALS`, `missingProfileEssentials`, `profileGapSummary`) + `hooks/useProfileCompletion.js` | Drives the red dot. Tracks address, phone, designation, logo and signature. |

### 6.2 Company Profile / Settings — `CompanyProfile.jsx` (~1.2k lines)

Sections (each an anchor in the rail): **Company basics · Contact & tax · Signatory · Logo & signature · Company stamp · Payments (UPI/bank) · Email sending (Gmail) · Team access · Plan · Account & data**.

- Logo, signature and stamp uploads go through `ImageEditor.jsx` (crop/cleanup) → `imageUploadService.uploadOrgImage` (WebP, buckets `org-branding` and `signatures`).
- The stamp can be generated (`StampPreview.jsx`, `utils/imageUtils.stampGeometry/buildStampSvg/generateStampPng`) or uploaded.
- Gmail setup goes to `/api/org-secrets` (the password is encrypted server-side), and "Test" calls `emailService.testConnection` → `/api/email` with `mode:'test'`.
- Team access embeds `settings/RolePermissions.jsx` (the role × resource toggle grid) and `settings/PortalJoinCode.jsx` (the employee join code, which can be rotated or disabled).
- Data export calls `GET /api/export`.

### 6.3 Documents module (HR documents → `records` table)

Each document type has a **form + live A4 preview + PDF generator**. The editors put the form beside `shared/A4Stage.jsx`, which scales the true-size preview to fit the pane and drops the transform during capture.

| Document | Form | Preview | PDF (`pdfService`) |
|---|---|---|---|
| Offer letter (full-time / intern) | `OfferForm.jsx` | `OfferPreview.jsx` | `generateOfferLetter` |
| Certificate | `CertificateForm.jsx` | `CertificatePreview.jsx` | `generateCertificate` (captures preview) |
| NDA | `NdaForm.jsx` | `NdaPreview.jsx` | `generateNda` |
| MoU | `MoUForm.jsx` | `MoUPreview.jsx` | `generateMoU` |

Shared pieces: `DocumentHeader.jsx` (letterhead), `StampPreview.jsx`, `shared/SignatureCapture.jsx`, `shared/PortalLinkGenerator.jsx` (mints, lists and revokes signed portal links), and `hooks/usePlanStatus.js` (plan quota gate on the forms). Saving goes through `storageService.save()` → `orgStore.addItem('records')`, which gets its doc number from `next_document_number()`. Sending goes through `emailService.sendOfferNotification` / `sendEmail`.

- **Offer Tracker** (`OfferTracker.jsx`) shows real-time acceptance status of sent offers (waiting / accepted / declined).
- **Records** (`InternRecords.jsx`) is the archive of every issued HR document, with search, download and delete, plus CSV export (`storageService.exportToCSV`).
- **General Documents** (`library/DocumentLibrary.jsx`, route `/library`, migration 0063) is a library for any file (25 MB, private `library` bucket). On upload, `POST /api/library` (`api/_lib/libraryExtract.js`) reads the file into one Markdown per document (`library_documents.content_md`): PDF text via `unpdf`, DOCX/PPTX/ODF by unzipping with `fflate`, spreadsheets via `xlsx`, text/HTML/RTF directly, and images or scanned PDFs through Gemini (metered as one AI message). It then cuts that Markdown into page/slide/sheet passages (`library_chunks`, full-text indexed and written only by the service role). `brainRetrieval.libraryContext` adds a DOCUMENT LIBRARY section (catalogue + ranked passages via `library_search`) to every EdgeBrain/copilot context, and `app.brain_sync_library` makes each file a `library_document` node. Permission resource: `library_documents`.
- **HR notices** (`role_change`, `termination`) are `records` rows too. They are created by the employee flows and acknowledged through the portal.

### 6.4 Bulk operations (`components/bulk/`)

| Page | What |
|---|---|
| `BulkOfferLetters.jsx` | CSV → validate → generate many offer letters → optionally email each. |
| `BulkCertificates.jsx` | Same flow for certificates. |
| `BulkTeamMembers.jsx` | Import the employee registry from CSV. |
| `BulkHistory.jsx` | Past batch jobs. **Batches aren't persisted yet, so this is always empty.** |

Shared kit in `bulk/shared/`: `BulkKit.jsx` (`Step`, `BulkFrame`, `LiveFeed`, `Outcome`, `SwitchRow`), `CSVUploader.jsx`, `ValidationTable.jsx`, `BulkProgressTracker.jsx`, `DocumentCard.jsx`, `RecipientStatusBadge.jsx`, `SignatureCanvas.jsx`. Bulk operations are a **Max-plan** feature (`planConfig.limits.bulkOperations`).

### 6.5 Recipient portal — `portal/RecipientPortal.jsx` (~1.6k lines)

This is the public page a document recipient opens from an emailed link (`/portal/:documentId?token=…`).

- Loads through `portalService.fetchPortalDocument(token)` → `GET /api/portal`.
- Actions go through `portalService.submitPortalAction(token, action, payload)` → `POST /api/portal`. The actions defined in `api/portal.js`:

| Action | Resulting status | Signs? |
|---|---|---|
| `accept_offer` | `signed` (and the recipient becomes an employee) | yes |
| `acknowledge` | `acknowledged` (HR notices, certificates) | yes |
| `mou_sign` | `fully_signed` | yes |
| `accept_quotation` | `accepted` | yes |
| `decline` | `declined` | — |
| `request_revision` | `revision_requested` | — |
| `payment_confirmation` | `payment_submitted` | — |
| `proforma_payment` | `advance_paid` | — |

- Accepting an offer creates the employee row. Acknowledging a `role_change` applies the new title and salary. A `termination` exits the employee. Each action writes a notification for the org.
- Supporting components: `shared/PaymentConfirmationForm.jsx`, `shared/UPIQRGenerator.jsx`, `shared/SignatureCapture.jsx`, `shared/DocumentStatusBadge.jsx`.

### 6.6 Finance module (`components/financial/` + `InvoiceForm.jsx`)

| Page | File | Highlights |
|---|---|---|
| Finance Status | `FinanceStatus.jsx` | Lifecycle of every financial document: status pie, ageing chart, badges. Uses `PaymentPositionCards.jsx` (invoiced / collected / outstanding / overdue, each linking to a filtered list). |
| Cash Book | `CashBook.jsx` | Money in (`income_entries`) and money out (`expenses`) that no invoice or bill covers. Records category (from `finance_categories`), GST rate, place of supply (`data/indianStates.js`), payment method, currency/FX, country and receipt uploads (`receiptService`). |
| Invoices / Quotations / Proformas lists | `InvoiceList.jsx` | Filters, status changes, record payments, portal links, reminders (`invoiceReminderService.send`), PDF via an HTML string escaped with `utils/htmlEscape.esc/safeImageUrl`, and conversions (quotation → proforma → invoice). |
| New Invoice | `InvoiceForm.jsx` + `InvoicePreview.jsx` | GST (CGST/SGST vs IGST by place of supply), line items (`shared/LineItemsEditor.jsx`), catalogue picker (`shared/ProductPicker.jsx`), client, country (`shared/CountrySelect.jsx`), UPI QR. |
| New/Edit Quotation | `QuotationForm.jsx` (~1.4k lines) | Revisions, validity, terms, and edit by `:docId`. |
| New Proforma | `ProformaInvoiceForm.jsx` | Advance-payment tracking. |
| Recurring | `RecurringInvoiceForm.jsx` → `RecurringInvoiceForm`, `RecurringInvoiceList` | Schedules stored in `recurring_invoices`. |
| Vendors | `Vendors.jsx` | Supplier directory: terms, GSTIN, and what's owed. |
| Purchase Bills | `PurchaseInvoices.jsx` | Payables with input GST and receipts. |
| Tax Summary | `TaxSummary.jsx` | Output vs input GST by month or FY quarter. Explicitly *a preparation aid, not a filing tool*. |
| Profit & Loss | `ProfitLoss.jsx` | Income, expenses and net for any period, before GST. |
| (routed only) Billing & Revenue | `BillingRevenue.jsx` | Older revenue dashboard at `/revenue`. |

Shared: `financeUi.jsx` (`Stat`, `Modal`, `ReceiptField`) and `financeHooks.js` (`money`, `fmtDate`, `useSection` = live orgStore section).

**Accounting model** (`services/financeCategories.js`, migration 0038/0041): every cash row carries a DB-stamped **treatment**:

- `revenue` / `other_income` count as income.
- `operating` / `non_operating` count as expenses.
- `cost_recovery`, capital, loans, drawings and tax remittances **move cash without touching profit**.

P&L reads treatments, while cash flow reads everything (`services/financeAnalytics.js`: `taxSummary`, `profitAndLoss`, `cashFlow`, `sixMonthSeries`, `paymentPosition`, `isOverdue`, `periodBounds`, `periodOptions`, `downloadCsv`).

**Payments**: `documentStore.recordPayment / confirmPayment / deletePayment` → `payments` table. `amount_paid` is recomputed in SQL (`app.recompute_amount_paid`), and `paid` / `partially_paid` are derived by the DB.

**Overdue reminders**: `invoiceReminderService.runCheck()` flags `sent` / `viewed` invoices past due as `overdue`. It then emails the client on the day they go overdue and every `REMINDER_INTERVAL_DAYS` (7), up to `MAX_AUTO_REMINDERS` (3). State lives in the doc payload.

### 6.7 Client Management module

| Page | File | Notes |
|---|---|---|
| CRM | `CRM.jsx` | Kanban pipeline over `clients` (orgStore section `crm_leads`). Stage lives in `stage`, with a legacy `extra.status` fallback. |
| Client Directory | `Customers.jsx` | Client list + detail view (documents, totals, notes → `clients.notes`, 0043). `customerService` handles `upsert`, `deduplicate`, `syncFromInvoices`, `deleteIfUnreferenced`, `documentsFor` and `search`. |
| Products | `Products.jsx` | Sellable catalogue (`catalog_items`, orgStore section `catalog`) with date-ranged performance from RPC `catalog_performance()`. Helpers: `catalogService` (`UNIT_OPTIONS`, `TAX_RATES`, `productToLineItem`, archive/restore). |
| Product Planner | `ProductPlanner.jsx` | Roadmap / projects (`products` table, orgStore section `products`). **Not** the catalogue; see the 0011 notes. |

`customers` and `crm_leads` were unified into one **`clients`** table in migrations 0015–0019. orgStore still exposes both old section names over that table.

### 6.7a Projects module (`components/projects/`, 0044–0052)

A project is client work (`client_id` set) or internal work, with money in, money out, people, a plan and tasks. The model — allocations, labour cost, permissions — is written up in [`docs/projects.md`](docs/projects.md).

| Page | File | Notes |
|---|---|---|
| Projects | `projects/ProjectsPage.jsx` | List (default) and status board. Filters: status, client, manager, "My projects", archived. Contract and net-margin columns only with `project_financials.view`, margins from RPC `project_portfolio`. |
| New project | `projects/ProjectForm.jsx` (`/projects/new`) | Client/internal, budget, team rows (the manager row sets the manager), milestone templates (30/70, 50/50, monthly retainer). Prefills from `?fromQuotation=` or `?client=`. Also the edit sheet. |
| Project | `projects/ProjectDetail.jsx` (`/projects/:id?tab=`) | Header with status control, close confirmation and owner/admin reopen. Tabs: `ProjectOverview`, `ProjectFinance` (P&L from RPC `project_financials`, money links, "Allocate existing…"), `ProjectTeam` (end, never delete; over-allocation from `employee_allocation`), Tasks (the task board locked to the project), `ProjectDocuments`, `ProjectActivity` (audit log). |
| Portfolio | `projects/Portfolio.jsx` (`/portfolio`, Pro+) | Every project's health, progress and (with Project financials) money; margin, health and utilisation charts; CSV. |
| Timesheets | `projects/Timesheets.jsx` + `projects/WeekGrid.jsx` (`/timesheets`, Max) | Weekly grid per person, submit week, approval queue for project managers/admins (`decide_timesheets`, never your own). |
| Tasks | `tasks/TasksPage.jsx`, `tasks/TaskModal.jsx` | Moved here from Team. Tasks have an optional project and milestone ("General" when none); filters for project, milestone and "My tasks"; `?project=`. Data in `services/taskStore.ts`; deadline notifications from `hooks/useTaskDeadlineMonitor.ts`. |

Detail tabs also include `ProjectMilestones` (order, billing %/amount, "Create invoice" → `/new-invoice` with the milestone; the database links and allocates it). Elsewhere: "Start project" on accepted quotations (`InvoiceList`), won CRM deals (toast action + lead sheet) and client pages (`RelatedProjects`); a project picker on recurring invoices; `RelatedProjects` on the employee sheet; the portal's "My projects" and "Timesheet" tabs (`portal/me/ProjectsTab.jsx`, `TimesheetTab.jsx`); hub widgets `projects_health`, `project_margin`, `milestones_due`, `team_utilisation` (`hub/projectWidgets.jsx`, picker only); EdgeAI project context and prompts (`cofounderAI.ts`, `Copilot.jsx`) and project parsing in `cashIntent.parseProject`.

Shared pieces: `shared/ProjectPicker.jsx` (single or split allocation inside the invoice, cash-book and bill forms), `projects/ProjectBadge.jsx`, `projects/AllocationBar.jsx`, `projects/HealthChip.jsx`, `projects/activityText.js`.

### 6.8 Team & People Ops module

| Page | File | Notes |
|---|---|---|
| Team Hierarchy | `TeamHierarchy.jsx` | React Flow org chart with draggable nodes and reporting lines. Stored in `org_settings` (singleton section `hierarchy`). Exports `DEPT_PALETTE`. |
| Employees | `Employees.jsx` | Registry and employee sheet. Includes `people/EmployeeWorkInsights.jsx` (attendance charts, via `portal/me/WorkCharts.jsx`) and `settings/AccessRolePicker.jsx` (app role). Portal access comes from `portalAccessService`: create login, reset password, revoke, invite, and bulk variants. |
| Add Employee | `EmployeeForm.jsx` | |
| Ex-Employees | `ExEmployees.jsx` | Same `employees` table with `exited_at` set. Exiting revokes access (`app.revoke_employee_access`). |
| Attendance | `people/AttendanceSheet.jsx` | Daily sheet (bulk mark) and monthly calendar, plus XLSX export. Writes use `source:'admin'`, so employees can't overwrite corrections. Service: `attendanceService` (`ATTENDANCE_STATUSES`, `checkIn`, `checkOut`, `markDay`, `markMany`, `exportMonth`, `summariseMonth`, `workedMinutes`…). |
| Leave | `people/LeaveRequests.jsx` | Approval queue, history, leave types and quotas. Service: `leaveService` (`countLeaveDays`, `rangesOverlap`, `applyForLeave`, `decide`, `balances` from view `leave_balances_v`, `adjustBalance`). Self-approval is blocked in SQL (`app.guard_leave_decision`). |
| Announcements | `people/Announcements.jsx` | Org-wide or single-department broadcasts, with pins and expiry. Per-user read state. Service: `announcementService`. |

### 6.9 Employee Portal (`portal/EmployeePortal.jsx` + `portal/me/`)

This is shown instead of the admin app when the role is `employee`, and also at `/me`. Tabs:

- **Overview** (`OverviewTab.jsx`): today, a clock-in card and month KPIs.
- **Attendance** (`AttendanceTab.jsx`)
- **Leave** (`LeaveTab.jsx`): balance, apply, and history.
- **Announcements** (`AnnouncementsTab.jsx`)
- **Profile** (`ProfileTab.jsx`): self-edit via `update_my_profile` (0032), a photo in the `employee-photos` bucket, and `ChangePassword`.

Helpers: `portalKit.jsx` (`PhotoAvatar`, `Kpi`, `ClockCard`, `ChartTip`…), `portalUtils.js` (`monthInsights`, `attendanceStreak`, `dailySeries`, `profileCompleteness`, `tenureLabel`, `useSignedPhoto`…) and `WorkCharts.jsx` (`HoursPerDayChart`, `MonthsWorkedChart`, `CheckInChart`). Service: `meService` (`getMyEmployee`, `getMyRole`, `updateMyProfile`, `uploadMyPhoto`, `changeMyPassword`, `linkEmployeeToUser`, `listUnlinked`).

**Getting in** is handled by `portal/JoinPortal.jsx` at `/join`, in one of three ways:

- an **invite** (`?t=token`, `accept_invitation`)
- a **join code** (`?c=code`, `claim_portal_seat`, which only works for an employee record already created at that email)
- an **admin-created login with a password** (0031 `create_portal_login`)

### 6.10 Dashboard / analytics — `overview/`

- `Overview.jsx` is the whole org for one period. Clicking any figure opens `Drilldown.jsx`.
- `overviewModel.js` holds the pure model: `buildOverview`, `PERIODS`, `resolvePeriod`, `buildBuckets`, `collectionEvents`, `expenseEvents`, `documentEvents`, `AGING`, `agingOf`, `invoiceStateOf`, `daysToPay`, and drill-downs (`customerDetail`, `bucketDetail`, `categoryDetail`, `productDetail`, `departmentDetail`, `dayDetail`, `docGroupDetail`). Tested in `overviewModel.test.js`.
- `vizKit.jsx` is the SVG chart kit: `Columns`, `Area`, `RankBars`, `SplitBar`, `Funnel`, `CalendarHeat`, `Spark`, `Gauge`, `Legend`, `Delta`, `TipProvider`. Supporting hooks are in `vizHooks.js` (`useViz`, `useWidth`, `niceMax`).
- `dashboard/SalesByCountries.jsx` is the world map (lazy-loads `data/worldMap.js`) fed by `salesGeoService.byCountry()` → RPC `sales_by_country()`. It is used by the orphaned `Dashboard.jsx`. The live hub map is the `GeoMap` widget, whose country click opens `CountryDialog.jsx`. Pan and zoom come from `hooks/usePanZoom.js`.

### 6.11 EdgeBrain — `brain/` (the company knowledge graph)

**Concept:** Supabase is the truth, EdgeBrain is a derived representation, the context engine does retrieval, and Gemini does the reasoning.

- **SQL side (0033–0037, 0038/0041 extensions):** tables `brain_nodes`, `brain_edges`, `brain_metrics`, `brain_insights`, `brain_state`, `brain_sync_runs`, `brain_dirty`. Sync functions include `app.brain_sync_org/people/clients/catalog/finance/spend/ops`, `app.brain_rebuild_edges`, `app.brain_refresh_metrics` (+ `_geo`, `_cash`) and `app.brain_tombstone`. Entry points are `public.brain_sync` and `public.brain_drain`. Triggers mark rows dirty (`app.brain_mark_dirty`) so the brain keeps itself current. RLS on brain tables applies the same `app.has_permission()` as the source tables (resource key `edgebrain`).
- **Server:** `api/brain.js` handles the actions `status`, `build`, `sync`, `search`, `entity`, `neighbors`, `metrics`, `context` and `ask`. `api/_lib/brainRetrieval.js` provides four generic capabilities (discover / traverse / retrieve / aggregate): `allowedResources`, `queryTerms`, `hintedKinds`, `searchNodes`, `neighbors`, `getMetrics`, `inventory`, `compactFacts` (key-priority order; see its test), `fitToBudget` and `buildContext`.
- **Client:** `services/brainService.js` has `getStatus`, `buildBrain`, `syncBrain`, `ask`, `getContext`, `subscribeToBrain`, `searchEntities`, `getEntity`, `getGraph`, `getMetrics`, `indexMetrics`, `DOMAINS`, `KIND_LABEL` and `REL_LABEL`.
- **UI:**
  - `EdgeBrain.jsx` is the page; the graph fills it.
  - `KnowledgeGraph.jsx` is the custom SVG graph, clustered by domain.
  - `BrainDock.jsx` is the right dock, holding `BrainSummary.jsx`, `BrainInspector.jsx` (one entity with its provenance), `BrainAsk.jsx` (question → answer + source records) and `BrainHealth.jsx` (freshness/trust).
  - `BrainOnboarding.jsx` is the pre-build screen.

### 6.12 Platform console — `admin/` (`/admin/*`)

- `AdminLogin.jsx` is a real Supabase sign-in. Access needs the `app_metadata.platform_admin` claim (set by `scripts/setup-admin.js`) **and** a match with `PLATFORM_ADMIN_EMAIL`.
- `AdminApp.jsx` / `AdminShell.jsx` hold the pages:
  - `AdminOverview.jsx`: tenants, MRR and plan mix
  - `AdminOrgs.jsx`: every tenant
  - `OrgDetail.jsx`: one tenant in full, with set plan and delete/restore org
  - `AdminMail.jsx`: send email from the platform mailbox
- `adminUi.jsx` (`PlanTag`, `SubStatus`, `MonthBars`, `KeyVal`) and `adminUtils.js` (`money`, `moneyShort`, `ago`, `monthLabel`).
- Client: `services/adminService.js` → `POST /api/admin` with the actions `overview`, `list_orgs`, `org_detail`, `set_plan`, `delete_org`, `restore_org` and `send_email`.

### 6.13 Marketing site

- `LandingPage.jsx` + `LandingPage.css` (parallax, `useScrollParallax`, `useCardGlow`).
- `landing/SubPage.jsx`, `SubPageNav.jsx`, `SubPageFooter.jsx` + `SubPage.css`, with 13 pages in `landing/pages/`: AICofounder, Pricing, Invoicing, OfferLetters, LegalDocuments, Certificates, Documentation, Support, Changelog, Privacy, Terms, Security, Quotations. `QuotationsPage` exists but is **not** registered in `subPageData.js`.

---

## 7. Cross-cutting UI: hub, AI copilot, design system

### 7.1 Hub — `Hub.jsx` + `hub/` (uncommitted, in progress)

- This is the landing screen after login. It has the module rail (`MODULES`), a top bar (org switcher, search, notifications, theme, account, profile dot), a **customisable widget board** and the **EdgeAI copilot docked on the right**.
- `hub/widgetCatalog.js` → `WIDGETS`, `WIDGET_BY_ID`, `DEFAULT_LAYOUT`.
  - The default ten are: revenue, expenses, cashflow, netcash, edgebrain, receivables, geomap, settlement, team and documents.
  - The picker adds: markets, tasks, pipeline, payables, volume, activity and shortcuts.
- `hub/widgets.jsx` holds the widget renderers (`Revenue`, `Expenses`, `NetCash`, `CashFlow`, `Receivables`, `Settlement`, `Markets`, `GeoMap`, `Brain`, `Team`, `Tasks`, `Pipeline`, `Documents`, `Volume`, `Activity`, `Payables`, `Shortcuts`).
- `hub/useHubData.js` supplies live data from orgStore sections plus the geo RPC. `hub/useWidgetLayout.js` handles add, remove, resize and move (menu, keyboard or drag), persisted per viewer. `hub/format.js` has `inr`, `inrShort`, `headline` and `monthShort`. Styles are in `hub/hub.css`.
- `main-hub.html` is the static mock the hub was modelled on. Use it for **structure only**, not its fonts or colours.

### 7.2 EdgeAI copilot — `assistant/` (uncommitted, in progress)

- **EdgeAI is an agent** (see `docs/edgeai-agent.md`). Every message goes to `POST /api/agent` (SSE). The server builds the context (user, role, `my_permissions`, plan, today in the org timezone, the page, `recentEntities`, EdgeBrain facts as `<data>`), runs Gemini with function calling over the tools the user may use (≤ 8 steps), and streams back words, **action cards**, choice chips, one-question follow-ups and page navigation. Reads run immediately; every write is only **proposed** (stored in `ai_actions`, 0068) and executes when the user taps Confirm — as the user, through their own JWT, with RLS and all guards applying.
- `AssistantContext.jsx` → `AssistantProvider` (hook `useAssistant` in `assistantStore.js`) holds the conversations once for the whole app. Chats persist in `localStorage['edgeos.ai.chats']` (max 60) with their cards (by `action_id`, refreshed from the server on reopen) and the chat's `entities` (last 10 records referred to, sent back as `recentEntities` so "it" / "that task" resolve). It runs turns (`services/agentService.js`), confirm / cancel / undo, chip answers, typed answers to an open question, and "yes" by voice for a single low-risk card.
  - Cards: `ActionCard.jsx` (proposed → executing → receipt with Undo 10 min + Open / failed / expired / cancelled; low risk = field diff, high risk = the exact row plus a named button and an irreversibility note; inline Edit; Ctrl/⌘+Enter confirms, Esc cancels), `DisambiguationCard.jsx`, `FollowUpChips.jsx`, `cardText.js`.
  - Voice input uses `hooks/useSpeechRecognition.js`.
  - The old in-browser cash flow (`CashEntryCard.jsx`) is gone; money is recorded through the agent's `create_cash_entry` (high risk), still parsed by `src/shared/cashIntent.js`.
- `Copilot.jsx` renders the copilot in two variants: `variant="dock"` (the hub column, with Chat/History tabs) and `variant="full"` (the full-screen workspace with a history list). It supports search, pin, rename, share and delete chats. Supporting pieces are `Markdown.jsx` (a tiny safe markdown renderer), `Orb.jsx` (animated voice orb) and `copilot.css`.
- `AIAssistant.jsx` is the global launcher that opens the full-screen copilot on non-hub pages.
- `services/cofounderAI.ts` holds `EdgeContext`, `buildEdgeContext` (built in `App.jsx` from records + financial docs), `callCofounderAI`, `callCofounderAISimple`, `getSuggestedPrompts` and task-assign helpers (`detectTaskAssignIntent`, `parseDateFromMessage`, `buildTaskAssignPrompt`, `parseTaskAssignResponse`…).
- `services/companyMemory.ts` stores long-lived company facts in `ai_company_memory` (`loadCompanyMemory`, `refreshMemory`, `extractCompanyMemory`, onboarding Q&A `ONBOARDING_QUESTIONS`). It has tests.
- AI message quotas are enforced server-side in `api/agent.js` and `api/nvidia.js` through `bump_ai_usage` (0010) against the plan's `aiMessages` — once per user message (a tapped chip or a typed answer to an open question costs nothing).

### 7.3 Design system

- **Tokens:** `src/theme/edge.js` → `makeTokens(isDark)`, `MONO` (now Helvetica) and `fmtCompact`. Contrast floors are documented in the file. `src/theme/EdgeTheme.jsx` → `EdgeThemeContext` / `useEdgeTheme`. `src/theme/surface.css` holds the CSS-variable surface theme used by the hub and copilot.
- **Component kit:** `src/components/ui/edge.jsx` provides `Page`, `Toolbar`, `Row`, `Panel`, `Grid`, `Label`, `Muted`, `Btn`, `Seg`, `Search`, `Field`, `Input`, `Select`, `Textarea`, `Status`, `Avatar`, `Bar`, `Breakdown`, `Stat`, `StatBand`, `Table`, `Td`, `Tr`, `Empty`, `Loading`, `Modal`, `ConfirmBtn` and `DialogSheet`. `ui/edgeUtils.js` provides `useT` (active palette), `useSearch`, `useDialog` (focus trap, Esc, focus return), `fmtDate` and `fmtDay`.
- **Theme toggle:** `hooks/useTheme.js` sets `data-theme` on `<html>` and persists it to localStorage.
- **Conventions** (from project memory): every page sits in `ModuleShell` and uses the `ui/edge` kit with accessible controls. HTML mockups provide layout only.
- **Legacy styles:** `src/index.css` (~15k lines) is bridged by `shell/edgeBridge.css`. `DESIGN_SYSTEM_AUDIT.md` records the history.
- **Toasts:** `shared/Toast.jsx` → `ToastProvider`, `useToast`.

---

## 8. Client services layer (`src/services`)

| Service | Responsibility | Key exports |
|---|---|---|
| **`orgStore.js`** (~1.7k lines) | **The data layer.** Maps app "sections" to Postgres tables with `fromRow`/`toRow` adapters. `load(orgId)` hydrates everything once, then reads are **synchronous** from cache, with a localStorage mirror (`edgeos_org_<id>`) and Realtime `listenSection`. Also snapshots the caller's own role permissions (`can(resource, action)`, `getRole()`) — for showing controls only — and skips any section whose `requires` permission the caller lacks. | `orgStore.load`, `can`, `getRole`, `refreshSection`, `getProfile`, `getUsage`, `refreshUsage`, `getSection`, `getSectionAsList`, `getItem`, `updateProfile`, `addItem`, `setItem`, `updateItem`, `removeItem`, `setSection`, `listenSection`, `saveFinDoc`, `updateFinDoc`, `deleteFinDoc`, `confirmPayment`, `deletePayment`, `clear` |
| `documentStore.js` | Financial docs, HR notices, notifications and recurring invoices over orgStore. Doc numbers come from the RPC. | `documentStore.*`, `docNumber` |
| `storageService.js` | Legacy-shaped API for HR records, employees, departments and ex-employees, plus CSV export. | `storageService.*` |
| `customerService.js` | Client CRUD, upsert, dedupe, sync from invoices, and safe delete. | `customerService.*` |
| `catalogService.js` | Product catalogue + `performance()` RPC. | `catalogService`, `UNIT_OPTIONS`, `TAX_RATES`, `productToLineItem` |
| `financeAnalytics.js` | Pure finance math. | see §6.6 |
| `financeCategories.js` | `finance_categories` reference data and treatments. | `TREATMENTS`, `PAYMENT_METHODS`, `loadFinanceCategories`, `categoriesFor`, `treatmentOf`, `countsAsIncome`, `countsAsExpense`, `isCostRecovery` |
| `cashIntent.js` | Re-export of `src/shared/cashIntent.js`: sentence → cash-book draft (deterministic NLP), also used by the agent server-side. `src/shared/` also holds `dates.js` (dates as said, resolved in the org timezone; `prefer: past/future`), `financeTaxonomy.js`, `finDocs.js` (financial document rows, line items, totals, company snapshot, receivables, `financialDocFromRow`), and `documentConversion.js` / `documentLifecycle.js` / `proformaAdvance.js` (re-exported from their old `services/` paths); it imports nothing outside itself (`sharedBoundary.test.js`). | `detectCashIntent`, `parseAmount`, `parseCurrency`, `parseDate`, `parseMethod`, `parseGstRate`, `guessCategory`, `startDraft`, `nextQuestion`, `applyAnswer`, `CURRENCIES`, `SECTION_OF` |
| `salesGeoService.js` | Revenue by country (RPC). | `salesGeoService.byCountry`, `summarise`, `PERIODS`, `periodRange` |
| `invoiceReminderService.js` | Overdue flagging + reminder emails. | `invoiceReminderService.send/runCheck` |
| `receiptService.js` | `receipts` bucket (5 MB, png/jpeg/webp/pdf), signed URLs. | `receiptService`, `validateReceipt`, `RECEIPT_*` |
| `imageUploadService.js` | Resize/encode to WebP and upload branding/signature images. | `IMAGE_KINDS`, `processImage`, `uploadOrgImage`, `resolveImageUrl`, `deleteOrgImage` |
| `pdfService.js` | jsPDF generation and preview capture. | `pdfService.generateOfferLetter/Certificate/Nda/MoU/Invoice` |
| `certificateTemplates.js` | Stub kept for old imports. | `CERTIFICATE_TEMPLATES`, `renderCertificatePdf` (no-op) |
| `emailService.js` | All mail via `/api/email`. | `emailService.testConnection/sendEmail/sendOfferNotification` |
| `portalService.js` | Mint, revoke and list portal links; recipient fetch/submit. | `createPortalLink`, `revokePortalLink`, `listPortalLinks`, `portalTokenFromUrl`, `fetchPortalDocument`, `submitPortalAction` |
| `portalAccessService.js` | Employee portal logins, invites and join codes. | `portalAccessService.*`, `joinUrl` |
| `meService.js` | "Which employee am I?", role, and self-profile. | `meService.*` |
| `attendanceService.js`, `leaveService.js`, `announcementService.js` | People ops. | see §6.8 |
| `permissionService.js` | Role/permission matrix and members. | `ACTIONS`, `loadPermissionMatrix`, `setPermission`, `getMyMembership`, `listMembers`, `setMemberRole`, `listRoles` |
| `planConfig.js` | Plan tiers and limits. | `PLANS`, `DEFAULT_PLAN`, `getPlanConfig`, `isLimitReached`, `getRemaining`, `getUsagePercentage`, `PLAN_FEATURES` |
| `orgProvisioning.js` | `create_organization` RPC wrapper. | `createOrganization` |
| `adminService.js` | Platform console client. | `adminService.*`, `isPlatformAdmin`, `PLATFORM_ADMIN_EMAIL` |
| `brainService.js` | EdgeBrain client. | see §6.11 |
| `cofounderAI.ts`, `companyMemory.ts` | AI chat + memory. | see §7.2 |
| `taskStore.ts` | Tasks. | `Task`, `taskStore` |
| `agentService.js` | EdgeAI agent client: SSE turns and card actions. | `streamAgent`, `confirmAction`, `cancelAction`, `undoAction`, `actionStatus`, `sseParser` |
| `projectService.js` | Projects: CRUD, close/reopen/archive/duplicate, team, milestones, money links (`allocate` → RPC `set_project_allocations`, one transaction), document links, the report RPCs, activity, and DB error codes → sentences. | `createProject`, `updateProject`, `closeProject`, `reopenProject`, `addMember`, `endMember`, `allocate`, `saveSplitFromPicker`, `pickerFromAllocations`, `linkDocument`, `financials`, `portfolio`, `employeeAllocation`, `activity`, `prefillFromQuotation`, `friendlyError` |
| `projectAnalytics.js` | Pure project arithmetic (no money that pay feeds). | `burnVsTime`, `milestoneProgress`, `projectProgress`, `projectedEnd`, `groupByStatus`, `allocationTotals`, `splitRemainder`, `toSplits`, `formatHealthReasons`, `pickerOrder` |
| `decisionEngine.ts`, `followUpEngine.ts`, `employeeAI.ts` | Decision mode, follow-up drafts, and conversational employee create/edit/role-change/terminate. **Only used by the orphaned `CopilotPanel.tsx`.** | — |

### 8.1 orgStore sections → tables

| Section | Table | Notes |
|---|---|---|
| `departments` | `departments` | |
| `employees` | `employees` | `exited_at is null` |
| `ex_employees` | `employees` | `exited_at` set (same row, same id) |
| `tasks` | `tasks` | `projectId` / `milestoneId` (0050); UI status `in-progress` ↔ enum `in_progress` |
| `projects` | `projects` | `code`, `closed_*`, `manager_employee_id` are database-owned |
| `project_members` | `project_members` | |
| `project_milestones` | `project_milestones` | |
| `project_documents` | `project_documents` | |
| `project_allocations` | `project_allocations` | `requires: project_financials.view` — never requested without it |
| `timesheet_entries` | `timesheet_entries` | approved/rejected only via `decide_timesheets` |
| `customers` | `clients` | |
| `crm_leads` | `clients` | pipeline view; extras in `clients.extra` |
| `products` | `products` | Product Planner roadmap |
| `catalog` | `catalog_items` | sellable catalogue |
| `expenses` | `expenses` | cash out |
| `income_entries` | `income_entries` | cash in |
| `vendors` | `vendors` | |
| `purchase_invoices` | `purchase_invoices` | |
| `records` | `records` | HR docs; `needsDocNumber` |
| `fin_docs` | `financial_documents` (+ `document_line_items`, `payments`) | via `saveFinDoc` etc. |
| `fin_notifs` | `notifications` (+ `notification_reads`) | |
| `fin_recurring` | `recurring_invoices` | |
| `hierarchy` | `org_settings` (singleton column) | org chart |
| `_profile` / `_usage` | `organizations` (+ banking, settings) / `usage_counters` | |

---

## 9. Hooks, context, lib, utils, data

| File | Export | Purpose |
|---|---|---|
| `hooks/useTheme.js` | `useTheme` | Light/dark, persisted |
| `hooks/usePlanStatus.js` | `usePlanStatus` | Plan + usage gate on document forms |
| `hooks/useProfileCompletion.js` | `useProfileCompletion` | Red-dot state |
| `hooks/useTaskDeadlineMonitor.ts` | `useTaskDeadlineMonitor` | Task deadline notifications + `invoiceReminderService.runCheck` |
| `hooks/useSpeechRecognition.js` | `useSpeechRecognition` | Voice input for the copilot |
| `hooks/usePanZoom.js` | `usePanZoom` | rAF-driven SVG pan/zoom (world map) |
| `hooks/useScrollParallax.js`, `useCardGlow.js` | — | Landing page effects |
| `lib/supabase.js` | `supabase` | Browser client (anon key) |
| `lib/authErrors.js` | `authErrorMessage` | Friendly auth errors |
| `lib/user.js` | `displayNameOf` | Name from `user_metadata` |
| `lib/profileCompletion.js` | see §6.1 | |
| `utils/htmlEscape.js` | `esc`, `safeImageUrl` | XSS safety for the one innerHTML path (InvoiceList PDF). Tested. |
| `utils/imageUtils.js` | `resolveImageToBase64`, `resolveFormImages`, `svgToPngDataUrl`, `stampGeometry`, `buildStampSvg`, `generateStampPng` | Images for jsPDF, company stamp |
| `data/indianStates.js` | `INDIAN_STATES` | Place-of-supply lists (IGST vs CGST+SGST) |
| `data/worldMap.js` | `COUNTRY_PATHS`, `COUNTRY_CENTROIDS`, `COUNTRY_NAMES`, `ALL_COUNTRIES`, `MAP_WIDTH/HEIGHT` | **Generated** by `scripts/generate-world-map.js` |

---

## 10. Serverless API (`api/`)

All handlers are Vercel functions. In dev, the `dev-api-routes` plugin in `vite.config.js` runs them in-process for `email`, `org-secrets`, `portal`, `portal-token`, `admin`, `nvidia`, `export`, `brain`, `library` and `agent`. Auth uses `Authorization: Bearer <supabase access token>`.

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/email` | POST | member of `org_id` | Send mail through the org's Gmail (creds from `org_secrets`, decrypted server-side). `mode:'test'` verifies the stored creds. Max 50 recipients. CR/LF header-injection guard (`validateMessage`, `sanitizeFromName`). Rate-limited through `claim_email_quota` (0024). |
| `/api/org-secrets` | GET / POST | admin of org | Read whether Gmail is configured, or set `gmail_user` / `gmail_app_password` (AES-256-GCM, `_lib/crypto.js`). Never returns the password. |
| `/api/portal-token` | POST | member | Mint a `portal_tokens` row and return a signed URL (`<jti>.<exp>.<hmac>`, `_lib/portalToken.js`). |
| `/api/portal` | GET / POST | portal token | The recipient portal's only door. Loads the document + company. Applies actions (§6.5) under the service role, scoped to the one document. |
| `/api/nvidia` | POST | member | Gemini chat proxy (OpenAI-compatible SSE; model `gemini-3.6-flash`). Meters `bump_ai_usage` against the plan limit (429 when exceeded). The name is historical. |
| `/api/agent` | POST | member (acts as the caller) | EdgeAI agent. `mode:'chat'` streams SSE events (`text`, `card`, `choice`, `input`, `notice`, `navigate`, `entities`, `status`); `confirm` / `cancel` / `undo` / `status` act on `ai_actions`. Writes run through the caller's JWT with header `x-edgeos-agent-action`; the service role only writes `ai_actions` and meters. See `docs/edgeai-agent.md`. |
| `/api/brain` | POST | member + `edgebrain` permission | EdgeBrain `status`, `build`, `sync`, `search`, `entity`, `neighbors`, `metrics`, `context`, `ask`. |
| `/api/export` | GET | owner/admin | Full tenant JSON export (every org table except secrets, plus bucket listings). |
| `/api/admin` | POST | `platform_admin` claim + `PLATFORM_ADMIN_EMAIL` | Platform console actions (§6.12). Sends mail from the platform's own SMTP. |

**`api/_lib/` helpers:**

- `auth.js`: `HttpError`, `requireUser`, `requireOrgRole`, `requirePlatformAdmin`, `sendError`, `methodIs`, `readJsonBody`.
- `supabaseAdmin.js`: a lazy service-role client, never imported from `src/`.
- `crypto.js`: `encryptSecret`, `decryptSecret`, `toBytea`, `fromBytea`.
- `portalToken.js`: `assertPortalSecret`, `buildToken`, `verifyToken`.
- `docShape.js`: `recordFromRow` and `financialDocFromRow`, which mirror orgStore's mappers and are deliberately without payments.
- `brainRetrieval.js`: see §6.11.
- `agent/`: the EdgeAI agent — `registry.js` (tool catalogue, risk, permission filter), `tools/*` (read, navigate, tasks, clients, cash, finance), `resolvers.js` (names → records, never a guess), `pipeline.js` (propose / confirm / undo), `executor.js` (plans applied as the user, optimistic concurrency), `loop.js`, `prompt.js` (`AGENT_PROMPT_VERSION`), `actions.js`, `context.js`, `db.js` (user-token client, friendly errors), `testing/fakeDb.js`.

**Environment variables** (`.env.example`):

- Client: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
- Server: `SUPABASE_SERVICE_ROLE_KEY`, `SECRETS_ENCRYPTION_KEY`, `PORTAL_TOKEN_SECRET`, `GEMINI_API_KEY`, `PORTAL_ALLOWED_ORIGINS`, `PLATFORM_ADMIN_EMAIL`, `PLATFORM_SMTP_USER`, `PLATFORM_SMTP_PASSWORD`, `PLATFORM_MAIL_FROM`.
- **Never** prefix server secrets with `VITE_`, because Vite inlines those into the bundle.

---

## 11. Database (`supabase/`)

### 11.1 Core tables (0001 unless noted)

- **Tenancy:** `organizations`, `memberships`, `invitations`, `org_settings`, `org_banking`, `org_secrets` (no client access), `subscriptions`, `usage_counters`
- **People:** `departments`, `employees`, `employee_compensation` (owner/admin only), `tasks`; `attendance_days`, `leave_types`, `leave_requests`, `leave_adjustments`, `announcements`, `announcement_reads`, view `leave_balances_v` (0029)
- **Clients & sales:** `clients` (0016, replaces `customers` + `crm_leads`), `products` (roadmap), `catalog_items` (0011), `country_codes` (0012)
- **Documents:** `records` (HR), `financial_documents`, `document_line_items`, `document_signatures`, `document_counters`, `recurring_invoices`, `portal_tokens`
- **Money:** `payments`, `expenses`, `income_entries` (0038), `finance_categories` (0038), `vendors`, `purchase_invoices` (0028)
- **System:** `notifications`, `notification_reads`, `audit_log` (append-only), `email_events` (0024), `ai_company_memory`, `legacy_id_map`
- **Permissions (0026):** `roles`, `permission_resources`, `role_permission_defaults`, `role_permissions`
- **EdgeBrain (0033+):** `brain_nodes`, `brain_edges`, `brain_metrics`, `brain_insights`, `brain_state`, `brain_sync_runs`, `brain_dirty`, `app.brain_resource_alias`

**Enums:**

- `member_role` (owner, admin, member, viewer). Since 0026, roles are rows in `public.roles`, and 0029 adds the `employee` role there.
- `doc_type`: offer, certificate, nda, mou, invoice, quotation, proforma, role_change, termination
- `doc_status`: draft, sent, viewed, accepted, declined, paid, partially_paid, overdue, cancelled, expired, pending, signed, party_a_signed, fully_signed, acknowledged, payment_submitted, advance_paid, revision_requested, order_confirmed, converted
- Others: `employment_type`, `task_status`, `task_priority`, `plan_tier`, `discount_kind`, `country_source`, `client_status`, `attendance_status`, `leave_status`

**Storage buckets:**

| Bucket | Public? | Contents |
|---|---|---|
| `org-branding` | public, 2 MB | logo, stamp |
| `signatures` | private, 1 MB | signature images |
| `documents` | private | generated PDFs |
| `receipts` | private, 5 MB (0028) | expense and bill receipts |
| `employee-photos` | private (0029) | employee photos |

### 11.2 Security model

- **RLS on every table** (0003), and since **0027 every configurable policy reads `role_permissions`** through `app.has_permission(org, resource, action)`.
- Roles are `owner`, `admin`, `member` and `viewer`, plus `employee`, which has self-rows only.
- **Resources** are the `permission_resources` keys: organizations, org_settings, memberships, invitations, subscriptions, usage_counters, audit_log, ai_company_memory, departments, employees, tasks, clients, catalog_items, customers*, crm_leads*, products*, financial_documents, document_line_items, recurring_invoices, records, document_signatures, portal_tokens, document_counters, payments, expenses, notifications, storage_branding, storage_signatures, storage_documents; vendors, purchase_invoices, storage_receipts (0028); attendance_days, leave_types, leave_requests, leave_adjustments, announcements, storage_employee_photos (0029); edgebrain (0033). (* = legacy.)
- **Hard guards in SQL**: the owner row is fixed; only owner/admin can grant owner/admin (`app.guard_privileged_roles`); pay, banking and email creds are owner/admin only; the last owner is protected (`app.protect_last_owner`); `org_id` and doc numbers are immutable (`app.freeze_org_id`, `app.freeze_doc_number`); cross-tenant FK guards (0014/0019); a self-approval guard on leave; and snapshot scrubbing of banking secrets (0023).
- New tenant tables go through `app.secure_tenant_table` (0027) and need `role_permissions` rows seeded. If those rows are missing, the table 403s (see the note on 0038 repair).
- **Key RPCs:** `create_organization`, `accept_invitation`, `next_document_number`, `bump_ai_usage`, `catalog_performance`, `sales_by_country`, `claim_email_quota`, `org_members`, `invite_employee_to_portal`, `claim_portal_seat`, `portal_invite_preview`, `portal_join_preview`, `rotate_portal_join_code`, `employee_portal_state`, `create_portal_login`, `reset_portal_password`, `revoke_portal_login`, `clear_password_change_flag`, `update_my_profile`, `brain_sync`, `brain_drain`.

### 11.3 Migration log

| # | File | What it does |
|---|---|---|
| 0001 | `init` | Extensions, enums, every original table (derived from the Firebase shapes) |
| 0002 | `functions` | `app.*` auth helpers, immutability guards, `updated_at`, atomic numbering, money totals, usage counters, `create_organization`, `accept_invitation` |
| 0003 | `rls` | RLS on every table |
| 0004 | `storage` | Buckets + policies |
| 0005/0006/0008 | enums | Extend `doc_type` / `doc_status` (HR notices, `pending`) |
| 0007 | `service_role_grants` | Table privileges for `service_role` |
| 0009 | `backfill_record_recipients` | Promote recipient fields out of the `records.data` blob |
| 0010 | `ai_usage` | Count AI messages (`bump_ai_usage`) |
| 0011 | `product_catalog` | `catalog_items`, catalogue sales roll-ups, `catalog_performance()` |
| 0012 | `country_codes` | **Generated** ISO country table |
| 0013 | `sales_by_country` | Country frozen per document (`country_source`), `sales_by_country()` |
| 0014 | `customer_org_guard` | Same-tenant FK guard |
| 0015–0019 | clients | `client_status` enum, `clients` table, backfill, repoint FKs, guards |
| 0020/0021 | audit | Generic audit trigger on 9 tables + read policy |
| 0022 | default privileges | `authenticated` grants survive new tables |
| 0023 | scrub snapshots | Remove banking data from company snapshots |
| 0024 | email rate limit | `email_events`, `claim_email_quota` (100/hr, 20 tests/day) |
| 0025 | clean client extra | Drop shadowing keys from `clients.extra` |
| 0026 | role permissions | Roles & permissions as data |
| 0027 | rls from permissions | Every policy reads `role_permissions` |
| 0028 | vendors/payables/receipts | `vendors`, `purchase_invoices`, `receipts` bucket |
| 0029 | people ops | Attendance, leave, announcements, photos, `employee` role, exit revokes access |
| 0030 | portal access | Invites and join codes into the employee portal |
| 0031 | portal credentials | Admin-created password logins |
| 0032 | employee self profile | `update_my_profile` |
| 0033–0037 | EdgeBrain | Graph, autosync, metric groups fix, resource guard, revenue by country |
| 0038 | cash entries | `income_entries`, `finance_categories`, treatments, cash-book metrics |
| 0038 repair | income permissions | Seed the missing `role_permissions` rows (403 fix) |
| 0039 | guard functions security definer | Fix "permission denied for schema app" on cash writes |
| 0040 | recompute cash derived columns | Cash-in now counts as revenue |
| 0041 | cash entry dimensions | Tax, FX, country and other analysable dimensions on cash rows |
| 0042 | geo includes cash entries | `sales_by_country()` counts cash-book revenue |
| 0043 | clients notes | `clients.notes` column |
| 0044 | projects permissions | Resources `projects`, `project_members`, `project_milestones`, `project_documents`, `project_allocations`, `project_financials` + defaults, fanned out |
| 0045 | projects | Six enums, `projects`, `project_code_counters` + `app.next_project_code` (PRJ-YYYY-NNN), close stamping, closed-project lock helper, `app.defer_to_rls` |
| 0046 | project members | Overlap and one-manager triggers, manager sync, exit ends memberships |
| 0047 | project milestones | Billing % → amount, invoice link → `invoiced`, lock with the invoice-link exception |
| 0048 | project documents | Links to `records` and quotations/proformas |
| 0049 | project allocations | Money links: `app.allocation_source`, cap and `full` exclusivity, source edit/delete triggers, delete guard, policies with `project_financials`, RPC `set_project_allocations` |
| 0050 | tasks project link | `tasks.project_id`, `tasks.milestone_id`, consistency guard |
| 0051 | project reporting | `app.project_labour_cost`, `project_financials`, `project_portfolio`, `employee_allocation` |
| 0052 | project access | `project_team_public_v`, `my_projects()`, `reopen_project`, project-aware `audit_log_select` |
| 0053 | project health | `project_health`, `app.project_progress`; portfolio carries health |
| 0054 | project commercial links | `recurring_invoices.project_id`; invoices from a milestone, a conversion chain or a recurring template are allocated on insert |
| 0055 | project plan limit | Active-project quota (Free 3, Pro 25, Max ∞) from `subscriptions` |
| 0056 | project reminders | `notifications.project_id`, `reminder_state`, `project_reminders_run`, member-added notification |
| 0057 | employee project tasks | `set_my_task_status` |
| 0058–0060 | timesheets | Resource, `timesheet_entries` + self/manager policies, `decide_timesheets`, `projects.cost_method`, `project_hours`, `unbilled_hours`, billing on invoice insert |
| 0061 | EdgeBrain projects | `project`/`milestone` nodes, project edges, `project.*` metrics gated by `project_financials` |
| 0062 | member permissions | Per-person exceptions (`member_permissions`), `has_permission` reads them; `my_permissions` / `user_permissions` |
| 0063 | document library | `library_documents`, `library_chunks` |
| 0064–0065 | document versions | `document_versions`, negotiation events; contract value from the locked version |
| 0066 | EdgeBrain headline totals | `cash.net` etc. on the tiles' definitions |
| 0067 | AI usage events | `ai_usage_events`, one row per AI call |
| 0068 | EdgeAI actions | `ai_actions` (proposals → executed/undone; own rows, owner/admin read all; service-role writes only), `ai_actions` permission resource, `audit_log.via` / `ai_action_id` stamped by `app.write_audit` via `app.agent_action_id()` for a confirmed action of the writer. Preflight: `supabase/checks/agent_preflight.sql` |
| *pending* | `supabase/pending/0026_drop_legacy_client_tables.sql` | Drop `customers` / `crm_leads` (not applied) |

**Two files share the `0038_` prefix.** Apply `0038_cash_entries.sql` before `0038_repair_income_permissions.sql`.

### 11.4 SQL tests (`supabase/tests/`)

Run them with `scripts/run-db-tests.sh`, which needs Docker. It builds a throwaway Postgres, applies `00_harness.sql` (which emulates Supabase `auth`, roles and storage), applies every migration, and then runs:

- `01_isolation_test`: tenant isolation
- `02_access_matrix`
- `03_role_isolation_test`
- `04_role_smoke_test`
- `05_people_ops_test`
- `06_portal_access_test`
- `07_portal_credentials_test`
- `08_projects_test`: role matrix, employee surfaces, allocation rules, closed-project lock, labour cost and P&L on a fixture, and the salary-leak check
- `08b_projects_phase2_test`: health, invoices that know their project, the plan quota, reminders, employees' own tasks
- `08c_projects_phase3_test`: timesheets (self-service, approval, lock, self-approval), timesheet costing, billing hours, EdgeBrain
- `09_member_permissions_test`, `10_document_versions_test`, `11_brain_headline_totals_test`, `12_ai_usage_events_test`
- `14_document_totals_test`: the agent's invoice totals equal `app.recompute_document_totals` on a shared fixture; issue / convert / cancel status writes pass the version guard as a member
- `13_ai_actions_test`: `ai_actions` visibility and no client writes; a member without finance rights cannot record a payment or expense through the agent's path; `via = 'edgeai'` only for the writer's own confirmed action

Expected output is in `expected/day_one_access.out`. It covers every table under RLS, including the EdgeBrain, cash-book and project tables added since 0026.

---

## 12. Tooling, tests, CI, scripts, docs

**npm scripts** (`package.json`):

| Script | What it runs |
|---|---|
| `dev` | `vite` (with the in-process API) |
| `build` | `vite build` → `dist/` |
| `lint` | `eslint .` (see `eslint.config.js`: `no-shadow` is an error, and React Compiler rules are warnings) |
| `test` / `test:watch` | Vitest over `src/**/*.test.*` and `api/**/*.test.*`, with placeholder Supabase env and no network |
| `preview` | `vite preview` |

**Unit tests:** `api/email.test.js`, `api/_lib/brainRetrieval.test.js`, `src/services/{cashIntent,customerService,financeAnalytics,leaveService,salesGeoService,companyMemory}.test.*`, `src/components/overview/overviewModel.test.js`, `src/utils/htmlEscape.test.js`.

**Deploy:** `vercel.json` passes `/api/*` through to functions and sends everything else to `index.html`. `netlify.toml` is an SPA fallback only; no functions run there.

**CI:** `.github/workflows/backup.yml` makes a weekly encrypted `pg_dump` plus a Storage backup as a 90-day artifact. It needs the secrets `SUPABASE_DB_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `BACKUP_PASSPHRASE`. The procedure is in `docs/RUNBOOK-restore.md`, which is marked *not yet rehearsed*.

**Scripts:**

| Script | Purpose |
|---|---|
| `scripts/generate-world-map.js` | Writes `src/data/worldMap.js` |
| `scripts/generate-country-seed.js` | Writes migration 0012 |
| `scripts/setup-admin.js <email> [password]` | Grants the `platform_admin` claim |
| `scripts/test-supabase.js` | Connectivity check |
| `scripts/run-db-tests.sh` | SQL tests (§11.4) |
| `scripts/migrate/01-extract.js` → `02-transform.js` → `03-load.js` → `04-verify.sql` | One-time Firebase → Supabase ETL |

**Docs and history:**

- `docs/phase-0/`: ai-context-contract, definition-of-done, document-model-decision, entity-decision (clients unification), feature-audit, migration-order, products-and-country-integration.
- Root: `FIX_PLAN.md` (numbered hardening items referenced throughout the code, e.g. "FIX_PLAN item 7"), `MEGA_AUDIT.md/.html`, `DESIGN_SYSTEM_AUDIT.md`, `SUPABASE_MIGRATION.md` (the Firebase → Supabase plan), `SKILL.md`, `EdgeOS-Overview.pdf`.

---

## 13. Known caveats & loose ends

- **Live DB ≠ repo migrations.** The deployed Supabase schema has drifted from `supabase/migrations`. For example, the live permission key for attendance is `attendance`, while the repo's 0029 seeds `attendance_days`. Check the live schema before writing policy or permission code.
- **New tenant tables 403** until `role_permissions` rows are seeded for them. The cause is the policy, not grants; see `0038_repair_income_permissions.sql`.
- **Orphaned code** (not imported anywhere):
  - `components/Dashboard.jsx` (and thus `dashboard/SalesByCountries.jsx`'s only consumer)
  - `components/financial/FinancialDocuments.jsx`
  - `components/cofounder/CopilotPanel.tsx` (~2.2k lines), and with it `decisionEngine.ts`, `followUpEngine.ts` and `employeeAI.ts`
  - `landing/pages/QuotationsPage.jsx` (not in `subPageData.js`)
- **Routed but not in any rail:** `/revenue` (`BillingRevenue.jsx`).
- **Bulk History** is always empty because batches aren't persisted.
- **`/api/nvidia`** is actually Gemini; the name is kept to avoid churn.
- **`certificateTemplates.js`** is a no-op stub.
- **Legacy names:** the npm package name `qbitointern` and README "OfferPro" predate the EdgeOS name. The orgStore sections `customers` and `crm_leads` both map to `clients`.
- **Pending migration** `supabase/pending/0026_drop_legacy_client_tables.sql` is unapplied, so the legacy `customers` / `crm_leads` / `products` resources still appear in the permission grid.
- **Uncommitted work in progress:** the hub widget board (`src/components/hub/`), the new copilot (`assistant/Copilot.jsx`, `AssistantContext.jsx`, `assistantStore.js`, `copilot.css`), `theme/surface.css`, and edits to `App.jsx`, `Hub.jsx`, `ModuleShell.jsx`, `edgeBridge.css`, `ui/edge.jsx` and `index.css`.
- **The backup restore runbook has never been rehearsed.**
- **`.env` is present in the working tree.** It is gitignored; keep it that way.

---

## 14. Where to look for X (quick index)

| I want to… | Start here |
|---|---|
| Add a page to a module | `src/App.jsx` (`MODULE_FILTER`, `NAV_ITEMS`, `PAGE_META`, `<Route>`) |
| Add a module | `src/components/shell/modules.js` + `App.jsx` `MODULE_META` |
| Read or write org data | `src/services/orgStore.js` (`SECTIONS`) |
| Add a new table | a migration + `app.secure_tenant_table` + a `permission_resources` row + `role_permissions` seeding + an orgStore section |
| Change permissions | `supabase/migrations/0026`, `0027`; UI in `settings/RolePermissions.jsx` |
| Change a PDF layout | `src/services/pdfService.js` and the matching `*Preview.jsx` |
| Change invoice / GST math | `InvoiceForm.jsx`, `LineItemsEditor.jsx`, `app.recompute_document_totals` (0002) |
| Change P&L / tax / cash flow | `src/services/financeAnalytics.js`, `financeCategories.js`, migration 0038/0041 |
| Change dashboard numbers | `src/components/overview/overviewModel.js` |
| Add a hub widget | `hub/widgetCatalog.js` + `hub/widgets.jsx` + `hub/useHubData.js` |
| Change project money / labour cost | migrations 0049 (`app.allocation_source`) and 0051; `docs/projects.md` |
| Link money to a project from a form | `shared/ProjectPicker.jsx` + `projectService.saveSplitFromPicker` |
| Show a control only to people with a permission | `orgStore.can(resource, action)` (display only; RLS decides) |
| Change AI behaviour | `api/_lib/agent/prompt.js` (bump `AGENT_PROMPT_VERSION`), `api/_lib/agent/loop.js`, `assistant/AssistantContext.jsx`; evals `scripts/eval-agent.js` |
| Make the AI do something new | add a tool in `api/_lib/agent/tools/` — `docs/edgeai-agent.md` |
| See what the AI changed | `ai_actions` (0068); `audit_log where via = 'edgeai'` |
| Change what EdgeBrain knows | migrations 0033–0041 (`app.brain_sync_*`, `brain_refresh_metrics*`) + `api/_lib/brainRetrieval.js` |
| Send email | `services/emailService.js` → `api/email.js` |
| Recipient signing / portal | `portal/RecipientPortal.jsx`, `services/portalService.js`, `api/portal.js`, `api/portal-token.js` |
| Employee self-service | `portal/EmployeePortal.jsx`, `portal/me/*`, `services/meService.js`, migrations 0029–0032 |
| Platform operator tasks | `admin/*`, `services/adminService.js`, `api/admin.js`, `scripts/setup-admin.js` |
| Theme / styling | `theme/edge.js`, `ui/edge.jsx`, `shell/edgeBridge.css`, `theme/surface.css` |
