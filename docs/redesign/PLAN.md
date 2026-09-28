# StartupBuddy redesign: plan (Phase 0)

> **Status:** draft for approval. Branch `redesign/startupbuddy`, cut from `main` at `9a43eb4`. So far the only change is this file.
> **Sources read:** `edgeos-v5.html` (all 1,183 lines: CSS, markup and script), `EDGEOS_FUNCTIONAL_MAP.md`, `src/App.jsx`, `shell/*`, `AuthContext`, `OrgContext`, `orgProvisioning`, `Registration`, `assistant/*`, `agentService`, `voice.js`, `api/agent.js`, `api/_lib/agent/{context,prompt,registry,loop,pipeline,actions}.js`, `tools/navigate.js`, `resolvers.js` (hrefs), `useHubData`, `financeAnalytics`, `useTaskDeadlineMonitor`, the `create_organization` RPC (0002), the `organizations`/`org_settings` schema, `api/portal.js`.
> Every "no caller" claim below comes from a grep over `src api scripts vite.config.js vercel.json`. The output is summarised in §3.

---

## 0. Baselines (recorded before any change)

| Check | Result |
|---|---|
| Unit tests (`vitest run`) | **24 files, 465 tests, all pass** (7.8 s) |
| Build (`vite build`) | **Passes in 31.5 s.** Main chunk `index-*.js` **3,860 kB (1,123.5 kB gzip)**. CSS **353.8 kB (58.6 kB gzip)**. Lazy chunks: `worldMap` 144 kB, `index.es` 159 kB, landing subpages. |
| Lint (`eslint .`) | **Fails before any change: 3 errors, 17 warnings.** The errors are all `react-refresh/only-export-components`, in `AuthContext.jsx`, `OrgContext.jsx` and `shell/railPin.jsx`. |
| Agent evals (`scripts/eval-agent.js`, 90 cases, live Gemini) | See §0.1 |
| Playwright | Not installed. Manual walkthroughs will use the Chrome browser tool at 390×844 and 1440×900 unless you want Playwright added as a dev dependency. |

**Lint gate per phase:** no new errors or warnings in any file I add or touch. The count must not rise above the baseline. Phase 7 deletes `railPin.jsx`, which takes the baseline to 2 errors. I won't move the contexts out of `AuthContext` and `OrgContext` just to satisfy lint, because that edits auth files for no product reason. Tell me if you want that done.

### 0.1 Eval baseline

Run on 2026-09-28 against `gemini-3.6-flash`, prompt `agent-2026-09-27.4`. It took 4 min 40 s. The per-case log is in `docs/redesign/baselines/eval-agent-9a43eb4.txt`.

| Module | Cases | Tool | Args |
|---|---|---|---|
| tasks | 25 | 100.0% | 100.0% |
| clients | 20 | 100.0% | 100.0% |
| cash | 21 | 100.0% | 100.0% |
| finance | 22 | 100.0% | 100.0% |
| **all** | **88** | **100.0%** | **100.0%** |

**0 unconfirmed writes. Every case passed.** The suite has 88 cases, not ~90. The post-change gate is therefore every case passing, with any single flake re-run once and reported.

---

## 1. Route map

Chat becomes the landing route. Every removed route **redirects**, so old bookmarks, email links and, above all, **the agent's own hrefs** keep working. The agent's `open_page` and `open_record` produce old paths like `/invoices`, `/customers`, `/tasks?task=<id>` and `/projects/<id>` (`tools/navigate.js`, `resolvers.js`). Rule 1 means I can't change those, so the redirect table is how the agent's navigation lands on the new screens.

### 1.1 New routes

| Route | Screen | Notes |
|---|---|---|
| `/chat` | Chat (home) | Default after login and after Google OAuth (which returns to `/hub`, then redirects) |
| `/money/:tab` | Money. `tab` is one of `transactions`, `invoices`, `bills`, `items`, `reports` | `?doc=<id>` opens the document sheet |
| `/money/invoices/new?type=invoice\|quotation\|proforma` | Full-screen document editor (restyled `InvoiceForm`, `QuotationForm`, `ProformaInvoiceForm`) | Also `/money/invoices/:docId/edit` (the old quotation edit path) |
| `/clients` | Clients board | `?client=<id>` opens the client sheet |
| `/work` | Work | `?project=<id>` filters, `?task=<id>` opens the task sheet |
| `/team` | Team (People + Letters) | `?person=<id>` opens the person sheet |
| `/team/letters/:kind/new` (`offer`, `nda`) | Letter editor (restyled `OfferForm` / `NdaForm`) | A bottom sheet on phones, full screen on desktop |
| `/settings` | Settings | `#cofounder`, `#company`, `#paid`, `#email`, `#members`, `#ai`, `#plan`, `#data` |
| `/me` | Employee "My tasks" (see decision D1) | |
| unchanged | `/portal/:documentId`, `/join`, `/admin/*`, `/login` | |
| `/`, `/signup` (signed out) | Onboarding: Welcome, then Account… | Replaces the marketing `LandingPage` (decision D8) |

### 1.2 Redirects (old path → new path)

| Old | New | Old | New |
|---|---|---|---|
| `/`, `/hub` | `/chat` | `/crm`, `/customers` | `/clients` |
| `/dashboard`, `/dashboard/finance`, `/revenue` | `/money/reports` | `/products`, `/planner` | `/money/items` |
| `/dashboard/sales` | `/clients` | `/tasks` (`?task=`) | `/work` (`?task=` kept) |
| `/dashboard/team`, `/dashboard/documents` | `/team` | `/projects`, `/portfolio`, `/timesheets` | `/work` |
| `/dashboard/projects` | `/work` | `/projects/:id` | `/work?project=:id` |
| `/dashboard/usage` | `/settings#plan` | `/projects/new` | `/work?newProject=1` |
| `/edgebrain` | `/settings#ai` | `/employees`, `/employees/new`, `/ex-employees`, `/team-hierarchy` | `/team` (`/employees/new` → `/team?addPerson=1`) |
| `/profile` | `/settings` | `/attendance`, `/leave`, `/announcements` | `/team` |
| `/cashbook` | `/money/transactions` | `/records`, `/offer-tracker`, `/certificates`, `/new-certificates`, `/mous` | `/team` (Letters) |
| `/finance-status`, `/invoices`, `/quotations`, `/proforma`, `/recurring/*` | `/money/invoices` (with a `type` filter where the old path implied one) | `/offers` | `/team/letters/offer/new` |
| `/new-invoice`, `/new-quotation`, `/new-proforma` | `/money/invoices/new?type=…` | `/ndas` | `/team/letters/nda/new` |
| `/new-quotation/:docId` | `/money/invoices/:docId/edit` | `/library` | `/chat?files=1` (opens the Files sheet) |
| `/vendors`, `/purchases` | `/money/bills` | `/bulk-*` | `/team` |
| `/tax-summary`, `/profit-loss` | `/money/reports` | `*` | `/chat` |

**Navigate on phones.** When the `navigate` event arrives, the router goes to the (redirected) path, closes any open sheet, and the bottom tab bar follows the route. Because `open_record` for an invoice produces `/invoices` with no id, the client also uses the card's or event's `entities[0].id` (when present) to open that document's sheet. This is a client-side lookup and changes nothing on the server.

---

## 2. Screen map (mockup element → the code that powers it)

### 2.1 Shell

| Mockup | Source |
|---|---|
| Sidebar workspace name (`.ws`) | `OrgContext.activeOrg`. It is a switcher only when `organizations.length > 1` (`setActiveOrg` already exists). Otherwise it is a static label. |
| Cofounder card and call button (`.cof`) | Persona (§8) plus `CallScreen` |
| Nav counts | Money: overdue invoice count (`paymentPosition().overdueCount`, red). Clients: active clients (`clients` with status `lead`/`contacted`/`active`). Work: open tasks. Team: no count. |
| Recent chats (`.rc`) | `AssistantContext.chats` (scoped, see §5.7) |
| User row (`.me`) | `useAuth().user` plus the employee row name |
| Phone tab bar, avatar centre tab, Settings via top-right avatar | New `Shell` component. Replaces `ModuleShell`, `MobileNav` and `AIAssistant`'s launcher. |
| Composer on every section with a contextual placeholder | `Composer`, bound to `AssistantContext.send`. Sending from a section calls `navigate('/chat')` first. |

### 2.2 Chat

| Mockup | Source |
|---|---|
| Messages, cards, choices, questions, notices | `AssistantContext` (unchanged logic) and new presentational components (§4) |
| Daily brief (greeting, 4 KPIs, "Suggested for today") | New `useBrief()` hook. It is built from the money half of `useHubData` (`cashPosition`, receivables, overdue), `taskStore`, `taxSummary()` and `brainService.getStatus`, plus `/api/org-secrets` GET for the Gmail check. **No model call, not metered.** It is rendered as a client-side "brief" block at the top of a new day's chat and is not stored as an assistant message, so it never enters `history`. |
| Files sheet (`drawMemory`) | `libraryService` (list, upload, status) plus `validateLibraryFile`. The upload path is unchanged (Storage, then `library_documents`, then `/api/library process`). |
| Recent chats sheet (phone) | `AssistantContext.chats` / `pickChat` |
| Call button → call screen | `VoiceCall` logic reskinned as `CallScreen` (§5.5) |
| Attach button | Opens the Files sheet's upload |
| Suggestion chips (Chat only) | Plain prompts checked against `registry.js`. See §5.2. |

### 2.3 Money

| Tab / element | Source |
|---|---|
| KPI strip: "Net cash" (the mockup says "In the bank", see Gap G4), "Came in" vs last month, "Went out" | `useHubData` money: `netCash`, `revMonth`/`revDelta`, `spendMonth`. The "Salaries are 64%" sub-line becomes the top spend category and its share, from `expenses` by category, shown only when categories exist. |
| **Transactions** | `CashBook`'s list and add/edit logic (`income_entries`, `expenses`). The add/edit sheet keeps category (`financeCategories`), GST, rail, place of supply, FX, country, receipt upload (`receiptService`) and project split. |
| **Invoices & quotes** (grouped Awaiting payment / Quotes out / Completed) | `documentStore` / `orgStore.fin_docs`, grouped by status with `shared/finDocs` (`balanceOf`, `isOverdue`) |
| Document sheet (status progress, line items, due, actions) | `documentLifecycle`, `documentConversion` (`ConvertDialog` logic), `proformaAdvance`, record payment (`orgStore.confirmPayment` / the existing payment form), PDF (`pdfService`, lazy), email (`emailService.sendQuotationLink` / `sendPortalLink`), portal link (`/api/portal-token` via `PortalLinkGenerator` logic), reminders (`invoiceReminderService`), versioning (`document_publish_version` / `document_reopen`). **"Client view"** opens the real minted portal URL in a new tab. |
| **Bills** (one list, vendor as a field) | `PurchaseInvoices` plus `Vendors`. Adding a bill picks or creates a vendor inline (`vendors` insert through `orgStore`). |
| **Items** | `catalogService` list plus an add/edit sheet. `ProductPicker` is restyled as the line-item picker. No `catalog_performance`. |
| **Reports** | A 6-month in/out bar chart from `financeAnalytics.sixMonthSeries` (CSS bars as in the mockup, **no recharts**), plus a summary list from `profitAndLoss` and `taxSummary` for the current month |
| "New" | A sheet offering Invoice / Quote / Proforma (editors), Money in / Expense (Transactions sheet) and Bill. **No chat detour**: the mockup's `addmoney` chat flow was canned. The composer covers the AI path. |

### 2.4 Clients

| Mockup | Source |
|---|---|
| 4-column board (Lead / In talks / Won / Lost) | `orgStore` `crm_leads` over `clients`. Stage mapping in decision D5. |
| Card: name, city, sub-line (owed / next step), owner | `clients` row. Owed is `balanceOf` across that client's invoices. |
| Client sheet: GSTIN, stage progress (tappable), paid to date / outstanding, documents, latest note, actions | `customerService`, `fin_docs` filtered by client, `clients.notes`. A stage tap calls `orgStore.updateItem('crm_leads', …)` (as `CRM.jsx` does today). Actions: New quote / New invoice (open the editors prefilled), Add note (inline, `customerService` notes), Start project (decision D6). |
| "Add lead" | An add-client sheet (`customerService.upsert`) |

### 2.5 Work

| Mockup | Source |
|---|---|
| Tabs: All / one tab per active project / Done | `projectService.listProjects()` (name and status only). Projects with open tasks or status `active` get tabs. Overflow scrolls horizontally. |
| Groups: Overdue / This week / Later / Done | `taskStore` rows grouped by `deadline` against today in the org timezone (`shared/dates.todayIn`) |
| Checkbox done/undone | `taskStore` status update (it emits `edgeos:tasks-changed` as today) |
| Row: title, project, due badge, owner avatar | `tasks.assignee_id` → `employees` |
| New task, and the task sheet | `TaskModal` logic restyled as a `Sheet` |

### 2.6 Team

| Mockup | Source |
|---|---|
| People list, person sheet (role, joined, pay visible per RLS, letters) | `orgStore` `employees` (joined compensation, which RLS/column rules already limit) |
| Letters list with status (sent / opened / signed) | `records` (offer, NDA; plus existing certificate/MoU rows read-only with download via `pdfService.generateCertificate` / `generateMoU`). Status comes from `records.status` / `viewed_at` / `signed_at`, which `/api/portal` writes. |
| "Offer letter", "Send NDA" buttons | `OfferForm` / `NdaForm` in a sheet. **Not** a chat flow (Gap G1). |
| Add person (not in the mockup, see decision D7) | `EmployeeForm` logic, restyled |

### 2.7 Settings: see §7.

### 2.8 Portal: `RecipientPortal` restyled; every action and API call unchanged.

### 2.9 Onboarding: see §6.

---

## 3. Component inventory

**K** = keep logic, restyle in place. **R** = rebuild the UI with shared components over the same services and logic. **D** = delete, with the evidence shown.

### 3.1 Kept or rebuilt

| File(s) | Fate | Notes |
|---|---|---|
| `assistant/AssistantContext.jsx`, `assistantStore.js`, `cardText.js`, `Markdown.jsx` | K | Logic untouched except chat scoping (§5.7) and a `persona` field in `context` (§8) |
| `assistant/ActionCard.jsx`, `DisambiguationCard.jsx`, `FollowUpChips.jsx`, `DocPaper.jsx` | R | Same props and behaviour, new markup and classes |
| `assistant/Copilot.jsx` | R | Split into `ChatScreen`, `MessageRow` and `Composer`. The dock/full variants go away. |
| `assistant/VoiceCall.jsx` | R | All call logic moves into a `useVoiceCall()` hook, verbatim. `CallScreen` renders it. |
| `assistant/Orb.jsx`, `voiceCall.css`, `copilot.css`, `AIAssistant.jsx` | D after R | Replaced by `PixelAvatar` + `CallScreen` + `Shell` |
| `financial/CashBook`, `InvoiceList`, `PurchaseInvoices`, `Vendors`, `TaxSummary`, `ProfitLoss`, `ConvertDialog`, `financeHooks`, `PaymentPositionCards` | R | Logic lifted into hooks where it's inline. Screens rebuilt as the Money tabs and sheets. |
| `InvoiceForm`, `InvoicePreview`, `financial/QuotationForm`, `ProformaInvoiceForm`, `shared/LineItemsEditor`, `ProductPicker`, `A4Stage`, `UPIQRGenerator`, `PortalLinkGenerator`, `PaymentConfirmationForm`, `DocumentStatusBadge`, `CountrySelect`, `SignatureCapture` | K | Restyled with the tokens. Form layout stacks on phones, with a Preview toggle. |
| `OfferForm`, `OfferPreview`, `NdaForm`, `NdaPreview`, `OfferTracker` (status logic only), `InternRecords` (download logic only), `StampPreview`, `ImageEditor`, `DocumentHeader` | K / R | The previews stay pixel-identical, because they are the A4 documents |
| `CRM.jsx`, `Customers.jsx` | R | Become the Clients board and client sheet |
| `tasks/TasksPage`, `TaskModal` | R | Become Work and the task sheet |
| `Employees`, `EmployeeForm`, `ExEmployees` | R | Become Team → People and the Add person sheet. Ex-employees become a "Past" filter. |
| `Products.jsx` | R | Becomes Money → Items, without performance |
| `CompanyProfile.jsx`, `settings/MemberAccess.jsx`, `settings/PortalJoinCode.jsx` | R | Become Settings (§7). The member-exceptions editor is hidden (D2). |
| `library/DocumentLibrary.jsx` | R | Becomes the Files sheet |
| `portal/RecipientPortal`, `JoinPortal` | K | Restyle only |
| `portal/EmployeePortal` + `portal/me/*` | see D1 | |
| `Registration.jsx`, `Auth.jsx` | R | Become the onboarding steps and the sign-in screen |
| `admin/*` | K | Header rename only (§9) |
| `hub/useHubData.js` | K | The brief reuses it. A `useMoneyData` extraction drops the geo RPC from the chat bundle. |
| `overview/overviewModel.js` (+ test) | K | Pure maths kept for the brief and Reports. The dashboard UI around it is deleted. |
| `shared/Toast`, `ConfirmHost`, `EmployeeAvatar` | K / R | Toast restyled to `.toast`. Only real outcomes are toasted. |
| `hooks/useTaskDeadlineMonitor`, `useSpeechRecognition`, `usePlanStatus` | K | Mounted from the new shell |

### 3.2 Deleted (Phase 7, each after re-running the grep)

| File(s) | Evidence it is unreferenced once its route goes |
|---|---|
| `cofounder/CopilotPanel.tsx` | No importer anywhere |
| `services/cofounderAI.ts` | Only importer is `App.jsx:89` (`buildEdgeContext`). That call is removed after `orgId` is passed straight to `AssistantProvider`. The other hits are comments. |
| `services/companyMemory.ts` **and `companyMemory.test.ts`** | Imported only by `cofounderAI.ts` and its own test. The test is deleted with it, which lowers the test count (noted in the report). |
| `services/decisionEngine.ts`, `followUpEngine.ts`, `employeeAI.ts` | No importer |
| `api/nvidia.js` | No live caller. Its only client was `cofounderAI.ts`. It is also removed from the `vite.config.js` dev route list. **Kept if you prefer** (it is harmless server code). |
| `Dashboard.jsx`, `dashboard/SalesByCountries.jsx`, `data/worldMap.js`, `scripts/generate-world-map.js` | `Dashboard` has no route. `SalesByCountries` is imported only by `Dashboard`, and `worldMap` only by those two. The devDeps `d3-geo`, `topojson-client`, `world-atlas` and `i18n-iso-countries` have no `src` importer and are removed if the scripts go. |
| `financial/FinancialDocuments.jsx` | No importer (the `orgStore` hits are a different identifier) |
| `landing/pages/QuotationsPage.jsx` | Not registered in `subPageData` |
| `services/certificateTemplates.js`, `CertificateForm.jsx`, `CertificatePreview.jsx`, `MoUForm.jsx`, `MoUPreview.jsx` | Only importers are each other and the routes. **Existing certificate and MoU records still download**, because `InternRecords` calls `pdfService.generateCertificate` / `generateMoU`, which don't import these files. |
| `BillingRevenue.jsx`, `ProductPlanner.jsx` | Route only |
| `Hub.jsx`, `hub/{widgets,projectWidgets,widgetCatalog,useWidgetLayout,hub.css,format.js}` | Route only. `format.js` helpers move if the brief needs them. |
| `overview/{Overview,FinanceDash,SalesDash,TeamDash,ProjectsDash,DocumentsDash,UsageDash,Drilldown,dashKit,vizKit,vizHooks}.jsx` | Route only. The Usage figures move to Settings → Plan via `aiUsageService`. |
| `brain/*` (8 files) | Route only (`/edgebrain`). Build/sync moves to Settings → AI knowledge through `brainService`. |
| `TeamHierarchy.jsx` and **`@xyflow/react`** | Route only, **but** `Employees.jsx` and `ExEmployees.jsx` import `DEPT_PALETTE` from it. That constant moves first. `xyflow` has no other importer. |
| `people/{AttendanceSheet,LeaveRequests,Announcements,EmployeeWorkInsights}.jsx` | Route only (EmployeeWorkInsights: checked in Phase 7) |
| `projects/{Portfolio,Timesheets,WeekGrid,ProjectFinance,AllocationBar,HealthChip,ProjectMilestones,ProjectActivity,activityText,RelatedProjects,ProjectOverview,ProjectDocuments,ProjectTeam,ProjectDetail,ProjectsPage}` | Route only. `ProjectForm` / `ProjectBadge` / `ProjectPicker` are kept if D6 keeps a minimal project sheet. |
| `bulk/*` (4 screens + 7 shared) | Route only. **Removes `react-signature-canvas`** (sole importer is `bulk/shared/SignatureCanvas`). `xlsx`'s only `src` importer is `bulk/shared/CSVUploader`, but **`api/_lib/libraryExtract.js` uses it server-side, so the dependency stays.** It just leaves the client bundle. |
| `financial/RecurringInvoiceForm.jsx`, `FinanceStatus.jsx` | Route only (see D9) |
| `shell/{ModuleShell,MobileNav,modules,railPin,railSlot,edgeBridge.css}`, `theme/{edge.js,EdgeTheme.jsx,surface.css}`, `ui/edge.jsx`, `ui/edgeUtils.js`, `hooks/{useTheme,useCardGlow,usePanZoom,useScrollParallax}` | Deleted once no screen imports them (checked per file in Phase 7; the dark/light theme toggle goes with the new single theme, see D10) |
| `LandingPage.jsx/.css`, `landing/*` except `TermsPage` and `PrivacyPage` | See D8 |

`recharts` stays only if `portal/me/WorkCharts` survives D1. Otherwise it is removed (its importers are Dashboard, BillingRevenue, FinanceStatus, ProfitLoss and WorkCharts, and every one is deleted or rebuilt without it).

---

## 4. AI event → component map (checked against the real code)

Events come from `loop.js`/`agent.js`; handling is in `AssistantContext.runTurn` and the confirm/undo callbacks. **The event names match your table.** Differences:

- The confirm call can return **`invalid`** (the card stays open and shows the message inline), **`expired`**, **`failed`** and **`not_found`**, in addition to `executed` and `repreviewed`.
- `done` ends the stream.
- A card carries `tool` and `module` (`actions.toCard`), so the header's icon and type label ("Invoice draft", "Expense", "New task") come from a client-side `tool → {icon, label}` map. Nothing new is needed from the server.

| Event / result | Component | Behaviour |
|---|---|---|
| `status` | `Typing` + status line | Dots, plus `working` text in muted type |
| `text` | `MessageRow` (`.say`) | `Markdown.jsx` (already escapes HTML) |
| `card` | `ActionCard` | Header: tool icon, type label, and risk badge (`low` → "Undo in 10 min", `high` → "Review first"). Title. Preview `rows` / `diff` / `document` as `.kv2` rows. Items as checkboxes. Primary button = `confirmLabel`. **Edit is shown only when `card.fields` exist** (mockup Edit pre-filled the composer, which was fake). `irreversible` and `notes` go under the rows. Expiry minutes stay. |
| `choice` | `ChoiceCard` (`.chc` + `.copt`) | Up to 5 options. `.picked` highlights the chosen option and fades the rest (from `message.resolved` plus the chosen value, stored on the message) |
| `input` | `QuestionChips` (`.qch`) | Chips = `amountHints` + options. Free text goes through the composer as `pending`. |
| `notice` | `Notice` (dashed) | Offer button → `takeOffer` |
| `navigate` | Router | Route via §1.2, close sheets, switch tab. The "Opened X." line is kept. |
| `entities` | none | Unchanged |
| `card_update` | `ActionCard` updates in place | Unchanged handler |
| `error` | `MessageRow` error variant | Adds a Retry button (= `regenerate` on that answer). This is new UI over the existing function. |
| confirm → `executed` | `.acdone` green strip | `summary` with Undo while `undo_until` is in the future, and Open when `href` is set (via redirects). Then `refreshScreens(card.tables)` and "Done. <followUp>" as today. |
| `repreviewed` | Old card: "Changed since, updated below" | Then the new card |
| cancel | `.ac.dim` + "Cancelled. Nothing was changed." | |
| `invalid` / `failed` / `expired` | Inline error / quiet line | As today |

**Context chips** (`.ctx`) above a card are rendered only from `card.target` (its label and href) and `card.entities[]`. Tapping one opens that record's sheet (client by id, document by id, task by id). Nothing is invented from preview text.

---

## 5. AI integration details

### 5.1 Unchanged
`/api/agent` request shape, SSE events, the propose/confirm/execute/undo flow, the registry, resolvers, risk, limits, metering and audit are all unchanged. The `x-edgeos-agent-action` header, `edgeos:tasks-changed`, `edgeos_org_<id>`, table and RPC names, env vars, API paths and buckets are all untouched.

### 5.2 Suggestion chips (each checked against `registry.js`)
| Chip | Prompt sent | Tool path |
|---|---|---|
| Who owes me? | "Who owes me money?" | `list_invoices` (read) |
| Log an expense | "Log an expense" | `create_cash_entry` asks for the amount via `input` |
| New quote | "Make a quote" | `create_quotation_draft` asks for the client |
| Add a task | "Add a task" | `create_task` asks for the title |
| How's the month? | "How did we do this month?" | `finance_summary` (needs `edgebrain.view` and a built brain). **Hidden when the brain isn't built**, because the answer would otherwise be thin. |

The mockup's chips named clients ("Zephyr Health"). Mine are data-free.

### 5.3 Daily brief
- It appears at the top of Chat **once per calendar day per org and user**. It is a client-side block, not a stored message, so it costs nothing and is never sent as history.
- **Greeting:** a per-persona template with real values, e.g. Arjun: "`{company}` is owed `{receivable}`. `{overdueCount}` late." If a value is zero, the template's neutral variant is used.
- **KPIs:**
  1. **Net cash**: `cashPosition().net`, the Hub's net-cash tile definition.
  2. **Owed to you**: `receivable` + overdue count.
  3. **This week**: open tasks due this week + overdue count.
  4. **GST payable**: `taxSummary()` net output minus input for the current month (G5 covers the due date).
- **Runway:** omitted (G4).
- **Suggested for today (0–3):**
  - an overdue invoice → the document sheet, whose primary action is **Send reminder** (`emailService`);
  - overdue tasks → `/work`;
  - Gmail not configured (`/api/org-secrets` GET) → `/settings#email`;
  - brain not built (`brainService.getStatus`) → **Build** (calls `/api/brain build`, which needs `edgebrain.create`; otherwise the item is hidden).
  - If there's nothing: "Nothing needs you today."

### 5.4 Agent gaps: see §10 (G1–G3).

### 5.5 Call screen
- **Logic:** `VoiceCall.jsx`'s state machine (listening → thinking → speaking), `VOICE_INSTRUCTION`, `speakable`, `sentencesOf`, fillers, `MAX_SPOKEN_SENTENCES`, interim results, cut-in and pause all move **verbatim** into `useVoiceCall()`.
- **UI:** the mockup's dark screen.
  - top bar: live dot, timer, "Private to {company}";
  - `PixelAvatar` in an `.orb` whose `--lvl` is driven by the existing `levelRef` (mic level when listening, the synthetic speaking level when speaking; no new audio analysis);
  - name, status, the 24-bar waveform (existing bars logic);
  - controls:
    - **Mute** = the existing pause (stops recognition; `aria-pressed`);
    - **Speaker** = a new flag that skips `speechSynthesis.speak`, showing text only;
    - **Transcript** = toggle;
    - **End**.
- **Transcript:** both sides, built from the chat's messages since the call started (the call already writes every turn into the chat). Cards render as compact dark cards with their real buttons (`confirmCard`).
- **Voice confirm stays server-side:** `confirm_proposal` is offered only on `voice:true`, only for low-risk cards. The UI labels high-risk cards "Needs your tap".
- **On End:** a call-summary block is appended to the chat. Confirmed = cards from this call with status `executed`. Waiting = cards still `proposed`, with an "Open" button that scrolls to each.
- **Incoming call (end of onboarding only):** rings, Decline/Accept. On Accept, the greeting is spoken **locally** with `speechSynthesis` from a template filled with real brief values (no model call, not metered), then the real call begins listening. On Decline, go to Chat.

### 5.6 Persona prompt change (the only server change in `api/_lib/agent`)
- New `api/_lib/agent/personas.js` holds `{id, name, tone}` for the 8 ids. The client has its own copy with the avatar spec and colour. **Server-side, only known ids are accepted.** An unknown or missing id falls back to `mira`.
- `context.js`: `persona = cleanPersona(body.context?.persona)` is added to `ctx`. This adds one optional field to the context; the request shape is otherwise unchanged.
- `prompt.js`:
  - the identity line becomes "You are {Name}, the user's cofounder in StartupBuddy, working for {org}…";
  - a new block: `PERSONA: {tone, 1–2 lines}. Tone changes only how you phrase replies. It never overrides the rules, tools, confirmations or safety below.`;
  - `AGENT_PROMPT_VERSION` → `agent-2026-09-28.1-startupbuddy`.
- **Evals:**
  - I record the baseline (§0.1).
  - After the change: a full run with `mira`, and a full run with `arjun` (terse). I'll add an optional `EVAL_PERSONA` env var to `eval-agent.js`; `fakeCtx` gets `persona`.
  - Gates: tool ≥ 95%, args ≥ 90%, **0 unconfirmed writes**, and **no case that passed at baseline may fail** (flakes are re-run once and reported).

### 5.7 Chat storage scoping
- **New key:** `startupbuddy.chats.<orgId>.<userId>`. The data format is unchanged.
- **Migration on first load for an org and user:** read the old `edgeos.ai.chats`, then keep chats whose cards all carry that org's action ids. Chats with no cards can't be attributed to an org; they're copied into the **first** org the user opens after the upgrade and then the old key is marked migrated for that user (`startupbuddy.chats.migrated.<userId>`). From then on, nothing reads the old key. The old key isn't deleted, so it can be rolled back.
- The provider must know `orgId` and `userId` before loading. `AssistantProvider` re-keys when `activeOrg` changes. Cross-tab `storage` sync uses the scoped key.

---

## 6. Onboarding (new UI over the existing auth and provisioning)

Order, and where each step's data goes:

1. **Welcome.** Static. "I already have an account" goes to `/login` (the restyled `Auth.jsx`).
2. **Account.**
   - Google: `loginWithGoogle()`, which is unchanged. It returns with `needsOnboarding` and resumes at step 3.
   - Email: email **and password**. The mockup shows email only, but the existing flow uses `signUp(email, password)` and I won't invent magic links. Nothing is created yet; the values are held in state as `Registration` does today.
3. **Company:**
   - first name → `owner_full_name`;
   - company name → `p_company_name`;
   - state for GST (D4);
   - what you sell (D4);
   - team size → `company_size`.
   - "Continue" provisions through the **unchanged** `create_organization` RPC. Email users go through the existing `signup(email, pw, onUserCreated)` path; Google users go through `createOrganization()`.
4. **Choose your cofounder.** `CofounderCarousel`. The preview lines are rewritten to be data-free (no "Kite Retail owes ₹62k"). "Hear a sample" speaks the line with `speechSynthesis`. The choice is saved per D3.
5. **Head start** (each toggle opens the real flow inline):
   - Import past invoices → the library upload. Copy: "{Name} can read them to answer questions." There is **no claim of a structured import**.
   - Connect Gmail → the `/api/org-secrets` form.
   - Add bank and UPI → the `org_banking` form (owner, which the founder is).
6. **Setting up.** A checklist driven by real completions:
   - org created ✓;
   - files uploaded and processing (from `library_documents.status`);
   - bank/UPI saved;
   - Gmail connected;
   - **first EdgeBrain build** (`brainService.buildBrain`). If the build fails, the step shows "Will retry from Settings" and onboarding continues.
7. **Incoming call** (§5.5), then Chat with the brief.

**Resuming.** Provisioning happens at step 3, so after that the app has an org and would normally show the shell. A per-user flag `startupbuddy_onboarding` (in `user_metadata`, D3) holds the step, so a reload mid-onboarding resumes at the right step.

**Existing users** skip onboarding. On their first visit to Chat with no persona saved, a one-time "Choose your cofounder" sheet appears.

`Registration`'s old `offerpro_reg_*` localStorage keys are read once so an in-progress signup isn't lost.

---

## 7. Settings contents

| Section | Source | Notes |
|---|---|---|
| Cofounder | Persona (D3) | Change opens the compact carousel in a sheet |
| Company | `CompanyProfile` basics, contact and tax, signatory, logo/signature/stamp (`imageUploadService`, `StampPreview`) | GSTIN shows **"Added"** (there is no verification; the mockup says "Verified", G6) |
| Getting paid | `org_banking` (owner/admin only, as `orgStore.load` enforces today). Invoice defaults. | Is there an invoice-defaults store (GST rate / due days)? **To confirm in Phase 4.** If there is none, the row shows what the forms default to, read-only. |
| Email sending | `/api/org-secrets` GET/POST plus `emailService.testConnection` | |
| Members | `permissionService.listMembers` / `setMemberRole`, `portalAccessService` (invite, join code via `PortalJoinCode`) | The exception matrix is hidden (D2) |
| AI knowledge | `brainService.getStatus` / `buildBrain` / `syncBrain` | Build/Sync needs `edgebrain.create` |
| Plan and usage | `subscriptions.plan`, `usage_counters.ai_messages` vs `PLANS[plan].limits.aiMessages`, `aiUsageService` 30-day summary | "X of Y AI messages used". **No reset date** (G2). |
| Data | `/api/export` (owner/admin) | A real download, not the mockup's "you'll get an email" toast |
| Sign out | `useAuth().logout` | |

---

## 8. Design system (Phase 1)

- **`src/design/tokens.css`**: the mockup `:root`, copied verbatim, plus `--sat`/`--sab` and the `prefers-reduced-motion` rule.
  - Geist and Geist Mono load from Google Fonts in `index.html`, with system fallbacks. Inter is dropped.
  - `--acc` is set on `:root` from the persona and used only on the avatar, the call glow and small highlights.
- **`src/design/components/`**:
  - basics: `Button`, `Badge`, `Card`, `ListRow`, `Tabs`, `Segmented`, `Switch`, `Sheet` (right drawer at ≥761px, bottom sheet below, with a focus trap, Esc, scrim and safe-area padding), `PageHeader`, `KpiStrip`;
  - chat: `ActionCard`, `ChoiceCard`, `QuestionChips`, `Notice`, `Composer`, `MessageRow`, `Typing`;
  - persona and call: `PixelAvatar` (a faithful port of `pix()`: 24×24 run-length rects, `shape-rendering="crispEdges"`, `viewBox` sizing, memoised per persona), `CofounderCarousel` (buttons, swipe, arrow keys, thumbnails, counter, preview; respects reduced motion), `CallScreen`.
- **`src/design/personas.js`**: `COS` ported with the same ids, names, roles, traits, `acc`, `h` and `x`. The `sample` lines are replaced with data-free ones.
- **Styling approach:** plain CSS with the mockup's class vocabulary, scoped per component file. No CSS-in-JS and no new dependency. Each screen switches wholesale to the new system when it migrates, so no screen mixes the two.

---

## 9. Rename to StartupBuddy (user-facing only)

**In scope** (every hit gets listed in `REPORT.md`):
- `index.html` (title, meta, apple title), `public/manifest.json`, the favicon/app icon (a new mark);
- `Auth`, onboarding, the shell;
- assistant copy ("EdgeAI" → persona name, or "your cofounder");
- `VoiceCall` strings, `agentService`'s signed-out error;
- the `CompanyProfile`, `MemberAccess`, `CashBook` and `TaxSummary` strings;
- `RecipientPortal` (4 hits);
- `api/email.js` test mail (subject, body, `fromName`);
- the `useTaskDeadlineMonitor` fallback `fromName`;
- the `api/admin.js` default mail-from name;
- the `AdminMail` / `AdminShell` header;
- PDF footers in `pdfService` (to confirm by grep in Phase 6).

**Not renamed** (rule 6, or model-facing text that isn't user-visible):
- `x-edgeos-agent-action`, `edgeos:tasks-changed`, `edgeos_org_<id>`, the `edgeos.ai.chats` key, table/RPC/env/bucket names, API paths;
- `tools/navigate.js`'s description ("a screen of EdgeOS") and `api/brain.js`'s `SYSTEM_PROMPT`. These are model-facing, and changing them is a contract change.

**Two agent strings that users can see** need your call (D11):
- `actions.js:55` "EdgeAI cannot make changes yet…" (an error);
- `tools/finance.js:845` `note: 'Recorded by EdgeAI'`, which is **written into `payments.note`**.

---

## 10. Gaps (mockup behaviour with no backend support)

| # | Mockup | Reality | Handling |
|---|---|---|---|
| G1 | Chat flows: "Send reminder", "Send NDA", "Send offer letter", "Send follow-up" as agent cards | The agent can't email, share portal links or create HR documents | Brief and sheet buttons open the manual flow (invoice sheet → Send reminder via `emailService`; Team → offer/NDA sheet). When asked in chat, the agent answers as today (one sentence plus `open_page`, redirected). **No tools added.** |
| G2 | "38 of 50 AI messages, resets 1 Oct" | The quota is lifetime (`bump_ai_usage` never resets) | "38 of 50 AI messages used". No reset claim. |
| G3 | Mockup "Edit" on a card pre-fills the composer | Edit exists only for `card.fields` | Show Edit only when fields exist |
| G4 | "In the bank ₹4,20,000 · 9 months runway" | There is no bank balance. `cashPosition.net` is net of recorded flows. | Label "Net cash". **Runway omitted:** it would divide a derived figure by a burn estimate and imply precision we don't have. (Add it later only if you confirm that definition.) |
| G5 | "GST due ₹58,000 · By 20 Oct" | `taxSummary` computes the payable. **No code knows the filing due date** (it depends on monthly vs QRMP filing). | "GST payable · September". No due date unless you approve D12. |
| G6 | GSTIN "Verified" | There is no GSTIN verification | "Added" |
| G7 | "Replay onboarding" | Can't re-provision | Replaced by "Replay intro call" (the local incoming-call greeting). Otherwise dropped. |
| G8 | Files: "cites the page it used" | Brain Ask cites; the agent's `ask_brain` gets library passages but doesn't guarantee citations | Copy: "{Name} reads these to answer your questions." |
| G9 | Setup step "Reading 12 past invoices" | There is no structured invoice import. The library only reads text. | "Reading N files" from real `library_documents` status |
| G10 | Carousel: "Only the personality and voice change" | There are no per-persona voices | Tone only. Each persona gets a distinct browser-TTS `pitch`/`rate`, stated as such. |
| G11 | Transactions: "Salaries are 64%" | Computable only when expenses have categories | Shown when category data exists, otherwise hidden |
| G12 | "Copy pay link" | No hosted pay page exists; UPI is a QR/URI inside the portal | "Copy link" = the minted portal link, where the QR lives |
| G13 | Agent `open_page timesheets` / `announcements` / `attendance` / `leave` | Those screens are removed | They redirect to `/work` or `/team`. The agent may still say "Opened Timesheets." That can't be fixed without touching the tool, and it's listed as a follow-up. |
| G14 | Mockup clients show "city" | `clients.city` exists only if the column does | Show city when present, otherwise the first line of the address |
| G15 | Recent chats sync across devices | They are localStorage-only | Still per device, now scoped per org and user (follow-up) |

---

## 11. Decisions (each with a recommended default)

| # | Decision | Recommended default | Alternative |
|---|---|---|---|
| **D1** | Employee role | A minimal **"My tasks"** screen in the new theme: their tasks (`my_projects` / `set_my_task_status` RPCs), profile and sign out. Portal login, invite and join code are unchanged. **This removes the employee self-service for attendance clock-in, leave apply and announcements from the UI.** | Keep `EmployeePortal` as is, restyled (larger scope, and it keeps recharts) |
| **D2** | Per-member permission exceptions (0062) | Hide the editor. For a member with exceptions, show "Has custom access (managed by an owner)" read-only, using `loadMemberOverrides` | Keep the editor in a sheet |
| **D3** | Where the chosen cofounder is stored | **Supabase Auth `user_metadata.startupbuddy_cofounder`** via `supabase.auth.updateUser({ data })`. It is per user, syncs across devices and needs **no migration**. `org_settings` has only a `hierarchy` JSON column, which is gated by the `org_settings` permission (members can't write it), so it's unsuitable. The onboarding step flag lives alongside it. | An additive `memberships.cofounder text null` migration |
| **D4** | Onboarding fields | Stored: first name → `owner_full_name`; team size → `company_size`; "What you sell" → `account_usage` (`services`/`products`/`both`; a legacy text column with no live reader, verified by grep). **State for GST has no column.** Recommended: **drop it from onboarding** and ask for it where it's used (the seller-state select the invoice forms already have), plus derive it from the GSTIN in Settings. | Additive migration `0069_org_gst_state.sql`: `alter table organizations add column if not exists gst_state text` (nullable, written after provisioning, used to prefill `sellerState`). Flagged, and only if you want it. |
| **D5** | CRM stage mapping | Lead = `lead`, In talks = `contacted`, Won = `active` (`deal`), Lost = `lost`. `archived` stays hidden from the board but is shown under a "Show archived" toggle. No data changes. The agent's `readStage` already maps "in talks" → contacted and "won" → deal. | — |
| **D6** | Projects | Work shows project **tabs** only. A small **"New project"** sheet (name, client or internal) uses the existing `createProject`, reached from Work and from the client sheet's "Start project". Close/archive sits in the tab's menu. Everything else (financials, milestones, allocations, timesheets, health) is removed from the UI; the data is untouched. | Tabs only, with no creation (the agent can't create projects either, so there'd be no way in) |
| **D7** | Adding people | Keep an **"Add person"** sheet (restyled `EmployeeForm`) on Team. The mockup doesn't show one, but otherwise the only way to add someone is an accepted offer letter. | Offer-only |
| **D8** | Signed-out landing | Welcome (onboarding step 0) replaces the marketing `LandingPage`. Keep `/terms` and `/privacy` (restyled minimal; the Account step links to them). Delete the other marketing subpages. | Keep the marketing site, rebranded |
| **D9** | Recurring invoices | **Nothing processes schedules today**: `recurring_invoices` rows are only stored and edited (grep: no generator in `src`, `api` or `pg_cron`). Removing the UI changes no behaviour. The table and rows are kept, and export still includes them. | Keep a read-only list in Money |
| **D10** | Dark mode | Light only (the mockup has no dark theme). The call screen is dark by design. Tokens are structured so a dark set can be added later. | Build a dark token set now |
| **D11** | The two visible agent strings (§9) | Change the `actions.js` error text (not stored). **Leave `'Recorded by EdgeAI'`** in the tool and map it at display time to "Recorded by your cofounder", so tool output stays byte-identical. | Change both in the tool |
| **D12** | GST due date in the brief | Omit (G5) | Show "by 20 <next month>" as the GSTR-3B monthly rule, labelled as such |
| **D13** | `/api/nvidia` | Delete (there's no caller) | Keep |

---

## 12. Risks and how each is verified

| Risk | Where | Verification |
|---|---|---|
| The prompt change regresses tool choice | `prompt.js` | Full eval with mira and arjun against §0.1. 0 unconfirmed writes. No baseline-pass case may regress. |
| The agent's hrefs land on removed routes | `navigate.js`, `resolvers.js` | A unit test that feeds every `PAGES` href and every `KINDS.href` shape through the redirect table and asserts a live route |
| The background monitor stops running | `useTaskDeadlineMonitor` | Mounted in the new `Shell`. Phase 1 check: the console log on first run, plus overdue tasks flipping after load. |
| Realtime refresh after agent writes stops reaching screens | New screens must read through `orgStore.listenSection` / `useLive` | Manual: confirm a card, and the Money / Work lists update without a reload, at both breakpoints |
| Chat scoping loses history | §5.7 | A unit test for the migration (org match via action ids, the no-card case, the migrated flag, the old key left intact) |
| Onboarding breaks sign-up or provisioning | `Registration` → `signup` → `create_organization` | Manual end-to-end on a throwaway email and on Google. SQL tests untouched. |
| Mid-onboarding reload strands the user | Step flag (D3) | Manual reload at each step |
| Employees see the admin shell | The `myRole === 'employee'` gate | Kept verbatim. Manual check with an employee login. |
| Portal actions regress | `RecipientPortal` restyle | Every action checked on test docs: accept offer, acknowledge, MoU sign, accept quote, decline, request revision, payment confirmation, proforma payment |
| Bundle grows | New shell | Routes lazy-loaded. jsPDF, xlsx and chart code stay out of the chat entry. Build size compared each phase. The target is ≤ baseline and I expect far smaller. |
| Speech APIs differ by browser | Call and incoming screens | The existing `unsupported` path is kept. Safari is checked manually. The greeting plays only after the Accept tap (a user gesture). |
| Live DB drift | Anything touching SQL | **No SQL in this plan** unless D4's alternative is approved |

---

## 13. Phase breakdown (files touched)

Each phase ends with lint (no new problems), build, the unit tests, evals if AI or `src/shared` was touched, manual QA at 390×844 and 1440×900 for every screen touched, and one commit.

1. **Foundation.** `src/design/{tokens.css,personas.js,components/*}`, `index.html` (fonts, viewport-fit), new `src/shell/{Shell.jsx,Sidebar.jsx,TabBar.jsx,TopBar.jsx}`, and `App.jsx`, which gains the new shell and lazy routes **behind the existing routes** (old screens render inside the new shell's content area until they migrate), plus the redirect table and its test. `useTaskDeadlineMonitor` and `AssistantProvider` mounting are unchanged. `buildEdgeContext` is replaced by passing `{ orgId }`, so `App.jsx` no longer imports `cofounderAI`.
2. **Chat.** `ChatScreen`, `MessageRow`, `Composer`, `ActionCard`/`ChoiceCard`/`QuestionChips`/`Notice` rebuilds, `useBrief`, the Files sheet (`DocumentLibrary` logic), recent chats, and `AssistantContext` chat scoping and migration (plus its test). `/chat` becomes the landing route. The persona is read from `user_metadata` (defaulting to mira) for names and the avatar only, and **not sent to the server yet**.
3. **Call.** `useVoiceCall` (lifted verbatim), `CallScreen`, `IncomingCall`, and the call summary.
4. **Sections:** Money (5 tabs, document sheet, editors restyled), Clients, Work, Team (+ letter sheets, Add person), Settings.
5. **Onboarding and persona.** The onboarding steps and resume flag, the existing-user chooser sheet, `api/_lib/agent/personas.js`, the `context.js` field, the `prompt.js` block and version bump, `eval-agent.js` `EVAL_PERSONA`. Eval runs.
6. **Portal restyle and rename sweep** (§9 list).
7. **Removal** (§3.2, grep re-run per file), dependency removal (`@xyflow/react`, `react-signature-canvas`, `recharts` if unused, the geo devDeps), dead CSS and themes.
8. **Polish.** QA at 390 / 768 / 1024 / 1440, a11y (focus, labels, contrast on badges, reduced motion), a performance pass, and `REPORT.md`.

**Waiting for your approval of this plan, in particular decisions D1–D13, before Phase 1.**
