-- ============================================================================
-- full_schema.sql — every migration the app needs, in order, as one script.
--
-- For a FRESH Supabase project only (empty public schema). Paste into the SQL
-- editor, or: psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/full_schema.sql
-- It runs as one transaction in the SQL editor, so a failure leaves nothing
-- half-applied.
--
-- Generated from supabase/migrations/0001–0068. Do NOT put this file in
-- migrations/ — `supabase db push` would apply everything twice.
--
-- Left out on purpose (one-time repairs of rows written by older app versions;
-- on an empty database each is a no-op):
--   0009_backfill_record_recipients   — fills recipient columns from records.data
--   0023_scrub_snapshot_secrets       — strips banking keys from old snapshots
--   0025_clean_client_extra           — strips shadowing keys from clients.extra
--   0040_recompute_cash_entry_derived — recomputes net_amount/treatment
-- Also not included: pending/0026_drop_legacy_client_tables (held back by
-- design; api/export.js and the isolation tests still name those tables).
-- ============================================================================


-- ############################################################################
-- ## 0001_init.sql
-- ############################################################################

-- ============================================================================
-- EdgeOS · 0001_init.sql
-- Extensions, enumerated types, and every table.
--
-- Derived from the live Firebase shapes, not from guesswork. Source of each
-- mapping is noted inline as:  << firebase.path (file:line)
--
-- Naming: everything is snake_case. The Firebase data mixes conventions
-- (customers use created_at, tasks use createdAt, employees use studentName);
-- 02-transform.js normalizes on the way in.
-- ============================================================================

create extension if not exists pgcrypto;   -- gen_random_uuid()
create extension if not exists citext;     -- case-insensitive email

-- ─────────────────────────────────────────────────────────────────────────────
-- Types
-- ─────────────────────────────────────────────────────────────────────────────

create type member_role as enum ('owner', 'admin', 'member', 'viewer');

-- << orgStore KEYED_SECTIONS + documentStore.nextId prefixes
create type doc_type as enum (
  'offer', 'certificate', 'nda', 'mou',        -- records  (HR)
  'invoice', 'quotation', 'proforma'           -- financial_documents
);

-- << documentStore.updateStatus + RecipientPortal + OfferTracker
create type doc_status as enum (
  'draft', 'sent', 'viewed', 'accepted', 'declined',
  'paid', 'partially_paid', 'overdue', 'cancelled', 'expired'
);

-- << EmployeeForm.jsx:34  offerType
create type employment_type as enum ('fulltime', 'intern', 'contract', 'parttime');

-- << taskStore.ts:13-14
create type task_status   as enum ('pending', 'in_progress', 'done', 'overdue');
create type task_priority as enum ('low', 'medium', 'high');

-- << planConfig.js PLANS
create type plan_tier as enum ('free', 'pro', 'max');

create type discount_kind as enum ('percent', 'flat');

-- ═════════════════════════════════════════════════════════════════════════════
-- CORE TENANCY
-- ═════════════════════════════════════════════════════════════════════════════

-- << organizations/{orgId}, minus banking and secrets which are split out below.
--    Firebase kept all 42 PROFILE_FIELDS (orgStore.js:26-37) in one document,
--    which is why a member could read the Gmail App Password. Postgres RLS is
--    row-level, so splitting by sensitivity is how field-level access is done.
create table organizations (
  id                   uuid primary key default gen_random_uuid(),
  company_name         text not null check (length(btrim(company_name)) between 1 and 200),
  company_tagline      text check (length(company_tagline) <= 300),
  company_email        citext,
  company_phone        text,
  company_website      text,
  company_address      text,
  company_description  text,

  owner_uid            uuid not null references auth.users(id) on delete restrict,
  owner_full_name      text,
  owner_role           text,
  document_designation text,          -- signatory title printed on documents
  primary_contact_name text,

  -- Storage object paths. Firebase stored base64 data URLs inline
  -- (imageUploadService.js:35); 03-load.js uploads them and writes paths here.
  logo_path            text,
  signature_path       text,
  stamp_path           text,
  stamp_type           text,
  stamp_city           text,
  include_logo         boolean not null default true,

  industry             text,
  country              text,
  city                 text,
  company_size         text,
  use_cases            text[]         not null default '{}',
  account_usage        text,
  referral_source      text,

  deleted_at           timestamptz,   -- soft delete; admin hard-delete is gone
  deleted_by           uuid references auth.users(id),

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
comment on table organizations is 'Tenant root. Banking and secrets deliberately live in separate tables.';
create index organizations_owner_idx  on organizations (owner_uid);
create index organizations_active_idx on organizations (id) where deleted_at is null;

-- << the gstin/cin/upi/bank_* subset of PROFILE_FIELDS.
--    RLS: owner/admin only.
create table org_banking (
  org_id              uuid primary key references organizations(id) on delete cascade,
  gstin               text check (gstin is null or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[0-9A-Z]{1}Z[0-9A-Z]{1}$'),
  cin                 text,
  upi_id              text,
  bank_name           text,
  bank_account_number text,
  bank_ifsc           text check (bank_ifsc is null or bank_ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  bank_account_type   text,
  updated_at          timestamptz not null default now()
);

-- << gmail_user / gmail_app_password (orgStore.js:36), previously PLAINTEXT in
--    Firestore, RTDB and localStorage, and additionally copied into every
--    document's company_profile snapshot.
--    RLS is ENABLED with NO POLICY: no client role can read this at all.
--    Only the service role (which bypasses RLS) touches it, from api/email.
create table org_secrets (
  org_id       uuid primary key references organizations(id) on delete cascade,
  gmail_user   citext,
  gmail_cipher bytea,     -- AES-256-GCM
  gmail_iv     bytea,
  gmail_tag    bytea,
  rotated_at   timestamptz,
  updated_at   timestamptz not null default now(),
  constraint gmail_cipher_complete check (
    (gmail_cipher is null and gmail_iv is null and gmail_tag is null)
    or (gmail_cipher is not null and gmail_iv is not null and gmail_tag is not null)
  )
);
comment on table org_secrets is 'Server-only. RLS enabled with no policy: every client role is denied.';

-- << memberships/{pushId} {organization_id, user_id, role}
--    The UNIQUE constraint is what the Firestore plan needed a {uid}_{orgId}
--    composite-ID migration to emulate.
create table memberships (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id) on delete cascade,
  user_id    uuid not null references auth.users(id)   on delete cascade,
  role       member_role not null default 'member',
  created_at timestamptz not null default now(),
  unique (org_id, user_id)
);
create index memberships_user_idx on memberships (user_id);

-- << org_metadata/{orgId}.hierarchy  (TeamHierarchy.jsx:631)
--    Shape: { nodes: {id:{id,position}}, edges: {id:{id,source,target}} }
--    Node ids are employee ids. Reporting lines are ALSO denormalized onto
--    employees.reports_to; this table holds canvas geometry only.
create table org_settings (
  org_id     uuid primary key references organizations(id) on delete cascade,
  hierarchy  jsonb not null default '{"nodes":{},"edges":{}}'::jsonb,
  updated_at timestamptz not null default now()
);

-- << organizations/{orgId}.plan | is_premium  (previously client-writable —
--    orgStore.updateProfile() wrote it straight from the browser).
--    RLS grants SELECT to members and NO write policy to anyone.
create table subscriptions (
  org_id             uuid primary key references organizations(id) on delete cascade,
  plan               plan_tier not null default 'free',
  status             text not null default 'active'
                       check (status in ('active','past_due','cancelled','paused','trialing')),
  provider           text,
  provider_sub_id    text unique,
  current_period_end timestamptz,
  cancel_at          timestamptz,
  updated_at         timestamptz not null default now()
);

-- Replaces the O(n) count-everything loop in usePlanStatus.js:52-62.
-- Maintained by triggers in 0002; never written by the client.
create table usage_counters (
  org_id        uuid primary key references organizations(id) on delete cascade,
  offer_letters integer not null default 0 check (offer_letters >= 0),
  certificates  integer not null default 0 check (certificates  >= 0),
  nda           integer not null default 0 check (nda           >= 0),
  mou           integer not null default 0 check (mou           >= 0),
  invoices      integer not null default 0 check (invoices      >= 0),
  quotations    integer not null default 0 check (quotations    >= 0),
  proformas     integer not null default 0 check (proformas     >= 0),
  updated_at    timestamptz not null default now()
);

-- ═════════════════════════════════════════════════════════════════════════════
-- TEAM
-- ═════════════════════════════════════════════════════════════════════════════

-- << organizations/{orgId}/departments  (storageService.js:82-103)
create table departments (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations(id) on delete cascade,
  name       text not null check (length(btrim(name)) > 0),
  created_at timestamptz not null default now(),
  unique (org_id, name)
);

-- << organizations/{orgId}/employees  +  .../ex_employees
--
--    Firebase kept two collections: an employee was DELETED from `employees`
--    and re-inserted into `ex_employees` under the same key
--    (Employees.jsx:725-730). That loses referential integrity — tasks and
--    documents still point at the id. Here it is one table with exited_at.
--
--    NOTE: employees.department in Firebase is a department NAME string, not a
--    reference (EmployeeForm.jsx:40). 02-transform.js resolves it to
--    department_id, creating any department it does not find.
create table employees (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations(id) on delete cascade,

  -- RTDB called this studentName, Firestore mirrored it as name
  -- (dualWriteService.js:58-79). Normalized here.
  full_name         text not null check (length(btrim(full_name)) > 0),
  email             citext,
  phone             text,
  address           text,

  role              text,
  department_id     uuid references departments(id) on delete set null,
  employment_type   employment_type not null default 'fulltime',
  reports_to        uuid references employees(id) on delete set null,
  supervisor_name   text,               -- free text kept where reports_to is unresolved
  responsibilities  text,

  is_owner          boolean not null default false,
  start_date        date,
  end_date          date,
  acceptance_deadline date,

  exited_at         timestamptz,        -- non-null ⇒ ex-employee
  exit_reason       text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint employees_no_self_report check (reports_to is null or reports_to <> id),
  constraint employees_dates_ordered  check (end_date is null or start_date is null or end_date >= start_date)
);
create index employees_org_active_idx on employees (org_id) where exited_at is null;
create index employees_org_exited_idx on employees (org_id, exited_at desc) where exited_at is not null;
create index employees_dept_idx       on employees (org_id, department_id);
create index employees_reports_to_idx on employees (reports_to);
-- One owner row per org.
create unique index employees_single_owner_idx on employees (org_id) where is_owner;

-- << employees.stipend | salary | currency | paymentFrequency | isPaid
--    (EmployeeForm.jsx:46-49). Split out so `member` and `viewer` roles cannot
--    read compensation — Postgres RLS cannot secure individual columns.
create table employee_compensation (
  employee_id       uuid primary key references employees(id) on delete cascade,
  org_id            uuid not null references organizations(id) on delete cascade,
  is_paid           boolean not null default true,
  amount            numeric(14,2) check (amount is null or amount >= 0),
  currency          char(3) not null default 'INR',
  payment_frequency text not null default 'Monthly',
  updated_at        timestamptz not null default now()
);
create index employee_compensation_org_idx on employee_compensation (org_id);

-- << organizations/{orgId}/tasks  (taskStore.ts:3-20)
--    Firebase denormalized assignedName/Email/Phone/Role/Dept onto every task;
--    those are dropped in favour of the employees FK. 02-transform keeps the
--    denormalized name only when the assignee cannot be resolved.
create table tasks (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organizations(id) on delete cascade,
  title            text not null check (length(btrim(title)) > 0),
  description      text,
  status           task_status   not null default 'pending',
  priority         task_priority not null default 'medium',
  assignee_id      uuid references employees(id) on delete set null,
  assignee_label   text,                -- fallback when assignee_id is unresolved
  deadline         date,
  notes            text,
  follow_up_sent_at timestamptz,
  position         integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index tasks_org_status_idx on tasks (org_id, status, position);
create index tasks_assignee_idx   on tasks (assignee_id) where assignee_id is not null;
create index tasks_deadline_idx   on tasks (org_id, deadline) where status <> 'done';

-- ═════════════════════════════════════════════════════════════════════════════
-- BUSINESS
-- ═════════════════════════════════════════════════════════════════════════════

-- << organizations/{orgId}/customers  (customerService.js)
--    Firebase field names were clientName / clientEmail / clientAddress /
--    buyerGSTIN / buyerState / contactPhone. Renamed here; the ETL maps them.
create table customers (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  name         text not null check (length(btrim(name)) > 0),
  email        citext,
  phone        text,
  address      text,
  gstin        text,
  state        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index customers_org_idx on customers (org_id);
-- customerService.deduplicate() matched case-insensitively on name; enforce it.
create unique index customers_org_name_idx on customers (org_id, lower(btrim(name)));

-- << organizations/{orgId}/crm_leads  (CRM.jsx:101-106)
create table crm_leads (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  company_name text,
  person_name  text,
  email        citext,
  phone        text,
  stage        text not null default 'lead',
  value        numeric(14,2) check (value is null or value >= 0),
  notes        text,
  position     integer not null default 0,
  extra        jsonb not null default '{}'::jsonb,   -- unmapped formData keys
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint crm_leads_named check (
    coalesce(btrim(company_name), '') <> '' or coalesce(btrim(person_name), '') <> ''
  )
);
create index crm_leads_org_stage_idx on crm_leads (org_id, stage, position);

-- << organizations/{orgId}/products  (ProductPlanner.jsx:56)
create table products (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  name        text not null check (length(btrim(name)) > 0),
  description text,
  status      text not null default 'planned',
  priority    text not null default 'medium',
  due_date    date,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index products_org_idx on products (org_id, status);

-- << organizations/{orgId}/expenses  (BillingRevenue.jsx:121)
create table expenses (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  description text not null check (length(btrim(description)) > 0),
  amount      numeric(14,2) not null check (amount >= 0),
  category    text not null default 'Operations',
  incurred_on date not null default current_date,
  created_at  timestamptz not null default now()
);
create index expenses_org_date_idx on expenses (org_id, incurred_on desc);

-- ═════════════════════════════════════════════════════════════════════════════
-- DOCUMENTS  (HR: offer / certificate / nda / mou)
-- ═════════════════════════════════════════════════════════════════════════════

-- << organizations/{orgId}/records  (storageService.js:36) and the legacy RTDB
--    path organizations/{orgId}/hr_records (admin/index.html:590).
--    Firebase shape: { id, type, title, data:{...whole form...}, user_id, created_at }
--
--    `data` stays jsonb: it is a point-in-time snapshot of a legal document and
--    its shape differs per type. But the fields the app QUERIES on are promoted
--    to real columns so they can be indexed and constrained.
create table records (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete cascade,
  doc_number      text not null,                 -- OL-2026-0001 etc.
  type            doc_type not null,
  status          doc_status not null default 'draft',
  title           text not null,

  employee_id     uuid references employees(id) on delete set null,
  recipient_name  text,
  recipient_email citext,

  issue_date      date not null default current_date,
  data            jsonb not null default '{}'::jsonb,

  -- Immutable snapshot of issuer identity at issue time.
  -- SCRUBBED: 02-transform strips gmail_app_password / bank_* / gstin from the
  -- Firebase company_profile blob before it lands here.
  company_snapshot jsonb not null default '{}'::jsonb,

  pdf_path        text,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint records_type_is_hr check (type in ('offer','certificate','nda','mou')),
  unique (org_id, doc_number)
);
create index records_org_type_idx on records (org_id, type, created_at desc);
create index records_employee_idx on records (employee_id) where employee_id is not null;

-- ═════════════════════════════════════════════════════════════════════════════
-- FINANCE
-- ═════════════════════════════════════════════════════════════════════════════

-- << organizations/{orgId}/fin_docs  AND the Firestore flat collection
--    `fin_docs`  AND the Firestore subcollection
--    organizations/{orgId}/fin_docs (admin/index.html:595) — the ETL reads all
--    three and reconciles.
--
--    Firebase used the human document number as the primary key
--    (InvoiceForm.jsx:211 `id: formData.invoiceNumber`), generated by
--    documentStore.nextId() as `matching.length + 1` — which duplicates after a
--    delete and races under concurrency. Here the key is a uuid and doc_number
--    is a separate unique-per-org column produced by next_document_number().
--
--    Money is numeric(14,2). Firestore had no numeric type, which is a large
--    part of why the GST arithmetic was never verifiable.
create table financial_documents (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organizations(id) on delete cascade,
  doc_number       text not null,
  type             doc_type not null,
  status           doc_status not null default 'draft',
  revision         text not null default 'v1',

  customer_id      uuid references customers(id) on delete set null,
  -- Buyer identity frozen at issue time; a later customer edit must not
  -- retroactively alter an issued invoice.
  bill_to_name     text not null,
  bill_to_email    citext,
  bill_to_address  text,
  bill_to_gstin    text,
  bill_to_state    text,

  issue_date       date not null default current_date,
  due_date         date,
  valid_until      date,                          -- quotations

  currency         char(3) not null default 'INR',
  subtotal         numeric(14,2) not null default 0 check (subtotal >= 0),
  discount_type    discount_kind,
  discount_value   numeric(14,2) not null default 0 check (discount_value >= 0),
  discount_amount  numeric(14,2) not null default 0 check (discount_amount >= 0),
  taxable_amount   numeric(14,2) not null default 0 check (taxable_amount >= 0),
  gst_enabled      boolean not null default true,
  gst_rate         numeric(5,2)  not null default 18 check (gst_rate between 0 and 100),
  gst_amount       numeric(14,2) not null default 0 check (gst_amount >= 0),
  is_inter_state   boolean not null default false, -- IGST vs CGST+SGST
  making_charges   numeric(14,2) not null default 0 check (making_charges >= 0),
  grand_total      numeric(14,2) not null default 0 check (grand_total >= 0),
  amount_in_words  text,
  amount_paid      numeric(14,2) not null default 0 check (amount_paid >= 0),

  -- proforma advance tracking (ProformaInvoiceForm.jsx:56-58)
  advance_percent  numeric(5,2) check (advance_percent is null or advance_percent between 0 and 100),

  payment_instructions text,
  terms                text,
  notes                text,

  company_snapshot jsonb not null default '{}'::jsonb,  -- scrubbed, see records
  payload          jsonb not null default '{}'::jsonb,  -- anything unmapped

  pdf_path         text,
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint fin_docs_type_is_financial check (type in ('invoice','quotation','proforma')),
  constraint fin_docs_paid_lte_total     check (amount_paid <= grand_total + 0.01),
  constraint fin_docs_discount_sane      check (discount_amount <= subtotal + 0.01),
  unique (org_id, doc_number)
);
create index fin_docs_org_type_idx  on financial_documents (org_id, type, created_at desc);
create index fin_docs_org_status_idx on financial_documents (org_id, status);
create index fin_docs_customer_idx  on financial_documents (customer_id) where customer_id is not null;
create index fin_docs_due_idx       on financial_documents (org_id, due_date)
  where status in ('sent','viewed','partially_paid','overdue');

-- << the `items` array inside each fin_doc (QuotationForm.jsx:283-289).
--    Normalized out of jsonb so totals are checkable in SQL and 04-verify can
--    prove the migration preserved every rupee.
create table document_line_items (
  id           uuid primary key default gen_random_uuid(),
  document_id  uuid not null references financial_documents(id) on delete cascade,
  org_id       uuid not null references organizations(id) on delete cascade,
  position     integer not null default 0,
  description  text not null default '',
  hsn_sac      text,
  quantity     numeric(14,3) not null default 1 check (quantity >= 0),
  unit         text not null default 'Nos',
  rate         numeric(14,2) not null default 0 check (rate >= 0),
  gst_rate     numeric(5,2)  check (gst_rate is null or gst_rate between 0 and 100),
  line_total   numeric(14,2) not null default 0 check (line_total >= 0),
  unique (document_id, position)
);
create index line_items_doc_idx on document_line_items (document_id);
create index line_items_org_idx on document_line_items (org_id);

-- << PaymentConfirmationForm.jsx + the 'payment_submitted' notification type.
--    Firebase recorded payments as loose fields on the doc; a table gives an
--    auditable history and lets amount_paid be derived rather than asserted.
create table payments (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  document_id   uuid not null references financial_documents(id) on delete cascade,
  amount        numeric(14,2) not null check (amount > 0),
  paid_on       date not null default current_date,
  method        text,
  reference     text,
  note          text,
  submitted_by_recipient boolean not null default false,
  confirmed_at  timestamptz,
  confirmed_by  uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index payments_doc_idx on payments (document_id);
create index payments_org_idx on payments (org_id, paid_on desc);

-- << org_metadata/{orgId}.fin_recurring — an ARRAY inside a single document,
--    rewritten wholesale on every change (documentStore.js:141-148).
--    (RecurringInvoiceForm.jsx:283-305)
create table recurring_invoices (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations(id) on delete cascade,
  customer_id       uuid references customers(id) on delete set null,
  bill_to_name      text not null,
  bill_to_company   text,
  bill_to_email     citext,
  bill_to_address   text,
  bill_to_gstin     text,
  invoice_prefix    text not null default 'INV',
  frequency         text not null check (frequency in ('weekly','monthly','quarterly','half_yearly','yearly')),
  start_date        date not null,
  end_date          date,
  no_end_date       boolean not null default false,
  next_invoice_date date,
  due_offset_days   integer not null default 15 check (due_offset_days >= 0),
  total_cycles      integer check (total_cycles is null or total_cycles >= 0),
  cycles_completed  integer not null default 0 check (cycles_completed >= 0),
  auto_action       text not null default 'draft' check (auto_action in ('draft','send')),
  gst_rate          numeric(5,2) not null default 18 check (gst_rate between 0 and 100),
  subtotal          numeric(14,2) not null default 0 check (subtotal >= 0),
  gst_amount        numeric(14,2) not null default 0 check (gst_amount >= 0),
  grand_total       numeric(14,2) not null default 0 check (grand_total >= 0),
  items             jsonb not null default '[]'::jsonb,
  notes             text,
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint recurring_end_after_start check (end_date is null or end_date >= start_date)
);
create index recurring_due_idx on recurring_invoices (org_id, next_invoice_date) where active;

-- ═════════════════════════════════════════════════════════════════════════════
-- SIGNATURES & PORTAL
-- ═════════════════════════════════════════════════════════════════════════════

-- << RecipientPortal.jsx — viewed_at / signed_at / accepted_at / declined_at /
--    decline_reason / acknowledged_at, previously loose fields written straight
--    onto the document by an ANONYMOUS user with no token validation.
--
--    One table for both document families, with a check constraint guaranteeing
--    exactly one FK is set (polymorphism without losing referential integrity).
create table document_signatures (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations(id) on delete cascade,
  record_id         uuid references records(id)              on delete cascade,
  financial_doc_id  uuid references financial_documents(id)  on delete cascade,

  signer_name       text,
  signer_email      citext,
  signature_path    text,               -- Storage object, not a base64 blob
  outcome           text not null check (outcome in ('accepted','declined','acknowledged')),
  decline_reason    text,

  viewed_at         timestamptz,
  signed_at         timestamptz not null default now(),
  signer_ip         inet,               -- evidentiary value
  signer_user_agent text,

  constraint sig_exactly_one_target check (
    (record_id is not null)::int + (financial_doc_id is not null)::int = 1
  )
);
create unique index sig_one_per_record on document_signatures (record_id)        where record_id is not null;
create unique index sig_one_per_findoc on document_signatures (financial_doc_id) where financial_doc_id is not null;
create index sig_org_idx on document_signatures (org_id, signed_at desc);

-- Replaces PortalLinkGenerator.jsx:11 — `Math.random()` regenerated on every
-- render and never validated anywhere.
create table portal_tokens (
  jti              uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organizations(id) on delete cascade,
  record_id        uuid references records(id)             on delete cascade,
  financial_doc_id uuid references financial_documents(id) on delete cascade,
  scope            text not null check (scope in ('view','sign')),
  recipient_email  citext,
  issued_by        uuid references auth.users(id) on delete set null,
  issued_at        timestamptz not null default now(),
  expires_at       timestamptz not null,
  revoked_at       timestamptz,
  used_at          timestamptz,
  constraint token_exactly_one_target check (
    (record_id is not null)::int + (financial_doc_id is not null)::int = 1
  ),
  constraint token_expiry_future check (expires_at > issued_at)
);
create index portal_tokens_live_idx on portal_tokens (org_id, expires_at)
  where revoked_at is null;

-- ═════════════════════════════════════════════════════════════════════════════
-- NOTIFICATIONS
-- ═════════════════════════════════════════════════════════════════════════════

-- << org_metadata/{orgId}.fin_notifs — an unbounded ARRAY in a single document
--    (documentStore.js:111-115), rewritten in full on every insert, with ids
--    from Date.now() and a `read` flag shared by the whole organization.
create table notifications (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  type        text not null,
  title       text not null,
  message     text,
  record_id        uuid references records(id)             on delete cascade,
  financial_doc_id uuid references financial_documents(id) on delete cascade,
  created_at  timestamptz not null default now()
);
create index notifications_org_idx on notifications (org_id, created_at desc);

-- Per-user read state; Firebase had none, so one user reading a notification
-- hid it from everyone in the org.
create table notification_reads (
  notification_id uuid not null references notifications(id) on delete cascade,
  user_id         uuid not null references auth.users(id)    on delete cascade,
  read_at         timestamptz not null default now(),
  primary key (notification_id, user_id)
);

-- ═════════════════════════════════════════════════════════════════════════════
-- PLATFORM
-- ═════════════════════════════════════════════════════════════════════════════

-- Team invitations. Firebase had no mechanism to add a second user to an org.
create table invitations (
  token       uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  email       citext not null,
  role        member_role not null default 'member',
  invited_by  uuid references auth.users(id) on delete set null,
  expires_at  timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id) on delete set null,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);
create unique index invitations_pending_idx on invitations (org_id, email)
  where accepted_at is null and revoked_at is null;

-- Append-only. No client role may INSERT, UPDATE or DELETE.
create table audit_log (
  id          bigint generated always as identity primary key,
  org_id      uuid references organizations(id) on delete set null,
  actor_id    uuid references auth.users(id)    on delete set null,
  action      text not null,
  entity_type text,
  entity_id   uuid,
  diff        jsonb,
  ip          inet,
  created_at  timestamptz not null default now()
);
create index audit_log_org_idx    on audit_log (org_id, created_at desc);
create index audit_log_entity_idx on audit_log (entity_type, entity_id);

-- Gap-free per-org/type/year document numbering. See next_document_number().
create table document_counters (
  org_id   uuid not null references organizations(id) on delete cascade,
  type     doc_type not null,
  year     integer  not null check (year between 2000 and 2200),
  last_num integer  not null default 0 check (last_num >= 0),
  primary key (org_id, type, year)
);

-- << RTDB memory/{orgId} and Firestore memory/{orgId} (companyMemory.ts:151,289)
--    Migrated for data preservation only. AI behaviour is unchanged.
create table ai_company_memory (
  org_id     uuid primary key references organizations(id) on delete cascade,
  memory     jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ETL bookkeeping: maps every Firebase push-ID to its new uuid so 03-load.js is
-- idempotent and resumable, and so 04-verify.js can reconcile row-for-row.
-- Drop this table once the 30-day Firebase rollback window closes.
create table legacy_id_map (
  entity      text not null,
  legacy_id   text not null,
  new_id      uuid not null,
  org_id      uuid references organizations(id) on delete cascade,
  source      text not null check (source in ('rtdb','firestore','both')),
  migrated_at timestamptz not null default now(),
  primary key (entity, legacy_id)
);
create index legacy_id_map_new_idx on legacy_id_map (entity, new_id);


-- ############################################################################
-- ## 0002_functions.sql
-- ############################################################################

-- ============================================================================
-- EdgeOS · 0002_functions.sql
-- Authorization helpers, immutability guards, updated_at, atomic document
-- numbering, derived money totals, and usage counters.
--
-- Everything here is SECURITY DEFINER with a pinned search_path, or a plain
-- trigger. The authorization helpers MUST be SECURITY DEFINER: they read
-- `memberships`, which is itself under RLS, and an invoker-rights function
-- would recurse infinitely through its own policy.
-- ============================================================================

-- Internal helpers live in their own schema so they are not exposed through
-- PostgREST. Only the `public.` functions at the bottom are callable via RPC.
create schema if not exists app;
revoke all on schema app from public, anon, authenticated;
grant usage on schema app to postgres, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Authorization helpers
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function app.is_member(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.memberships
    where org_id = p_org and user_id = auth.uid()
  );
$$;

create or replace function app.member_role(p_org uuid)
returns member_role
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select role from public.memberships
  where org_id = p_org and user_id = auth.uid();
$$;

create or replace function app.is_admin(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(app.member_role(p_org) in ('owner','admin'), false);
$$;

create or replace function app.is_owner(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(app.member_role(p_org) = 'owner', false);
$$;

-- A viewer may read but never write.
create or replace function app.can_write(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(app.member_role(p_org) in ('owner','admin','member'), false);
$$;

-- Platform administrator, asserted by a JWT claim set server-side via the admin
-- API. Replaces admin/index.html's `localStorage.admin_session === 'true'`.
create or replace function app.is_platform_admin()
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(
    (current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'platform_admin')::boolean,
    false
  );
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Generic triggers
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function app.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- A row must never be able to hop tenants. RLS alone does not prevent an UPDATE
-- that rewrites org_id to an org the caller is ALSO a member of.
create or replace function app.freeze_org_id()
returns trigger language plpgsql as $$
begin
  if new.org_id is distinct from old.org_id then
    raise exception 'org_id is immutable (attempted % -> %)', old.org_id, new.org_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

-- An issued document's number is part of a legal and statutory record.
create or replace function app.freeze_doc_number()
returns trigger language plpgsql as $$
begin
  if new.doc_number is distinct from old.doc_number then
    raise exception 'doc_number is immutable once issued (% -> %)', old.doc_number, new.doc_number
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create or replace function app.forbid_write()
returns trigger language plpgsql as $$
begin
  raise exception 'table % is append-only', tg_table_name using errcode = 'insufficient_privilege';
end $$;

-- Attach updated_at + org_id freeze to every table that has both.
do $$
declare t text;
begin
  foreach t in array array[
    'organizations','org_banking','org_secrets','org_settings','subscriptions',
    'usage_counters','employees','employee_compensation','tasks','customers',
    'crm_leads','products','records','financial_documents','recurring_invoices',
    'ai_company_memory'
  ] loop
    execute format(
      'create trigger %I_touch before update on public.%I
         for each row execute function app.touch_updated_at()', t, t);
  end loop;

  foreach t in array array[
    'employees','employee_compensation','tasks','customers','crm_leads','products',
    'expenses','records','financial_documents','document_line_items','payments',
    'recurring_invoices','notifications','document_signatures','portal_tokens',
    'invitations','memberships'
  ] loop
    execute format(
      'create trigger %I_freeze_org before update on public.%I
         for each row execute function app.freeze_org_id()', t, t);
  end loop;
end $$;

create trigger records_freeze_number before update on public.records
  for each row execute function app.freeze_doc_number();
create trigger fin_docs_freeze_number before update on public.financial_documents
  for each row execute function app.freeze_doc_number();

create trigger audit_log_no_update before update or delete on public.audit_log
  for each row execute function app.forbid_write();

-- ─────────────────────────────────────────────────────────────────────────────
-- Atomic document numbering
--
-- Replaces documentStore.nextId() (documentStore.js:98-103):
--     const num = matching.length + 1;
--     return `${prefix}-2026-${String(num).padStart(4,'0')}`;
-- which duplicates an existing number as soon as any document is deleted,
-- races between concurrent users, and hardcodes the year 2026.
--
-- The INSERT .. ON CONFLICT DO UPDATE .. RETURNING takes a row lock for the
-- duration of the statement, so concurrent callers serialize and each receives
-- a distinct number. Gap-free.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function app.doc_prefix(p_type doc_type)
returns text language sql immutable as $$
  select case p_type
    when 'invoice'     then 'INV'
    when 'quotation'   then 'QUO'
    when 'proforma'    then 'PI'
    when 'offer'       then 'OL'
    when 'certificate' then 'CRT'
    when 'nda'         then 'NDA'
    when 'mou'         then 'MOU'
  end;
$$;

create or replace function public.next_document_number(
  p_org  uuid,
  p_type doc_type,
  p_date date default current_date
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_year integer := extract(year from p_date)::integer;
  v_num  integer;
begin
  if not app.is_member(p_org) then
    raise exception 'not a member of organization %', p_org
      using errcode = 'insufficient_privilege';
  end if;

  insert into public.document_counters (org_id, type, year, last_num)
  values (p_org, p_type, v_year, 1)
  on conflict (org_id, type, year)
    do update set last_num = public.document_counters.last_num + 1
  returning last_num into v_num;

  return app.doc_prefix(p_type) || '-' || v_year || '-' || lpad(v_num::text, 4, '0');
end $$;

grant execute on function public.next_document_number(uuid, doc_type, date) to authenticated;

-- After the ETL, push each counter past the highest number already imported so
-- migrated and newly created documents cannot collide.
create or replace function app.reseed_document_counters()
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.document_counters (org_id, type, year, last_num)
  select org_id, type,
         substring(doc_number from '-(\d{4})-')::int as year,
         max(substring(doc_number from '-(\d+)$')::int)
  from (
    select org_id, type, doc_number from public.records
    union all
    select org_id, type, doc_number from public.financial_documents
  ) d
  where doc_number ~ '-\d{4}-\d+$'
  group by org_id, type, substring(doc_number from '-(\d{4})-')::int
  on conflict (org_id, type, year) do update
    set last_num = greatest(public.document_counters.last_num, excluded.last_num);
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Derived money — line totals, document totals, amount_paid
--
-- The audit found GST arithmetic done only in React with zero tests. Deriving
-- it in the database makes it impossible for a client to persist totals that
-- disagree with the line items.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function app.line_item_total()
returns trigger language plpgsql as $$
begin
  new.line_total := round(coalesce(new.quantity,0) * coalesce(new.rate,0), 2);
  return new;
end $$;

create trigger line_items_compute before insert or update on public.document_line_items
  for each row execute function app.line_item_total();

create or replace function app.recompute_document_totals(p_doc uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  d            public.financial_documents%rowtype;
  v_subtotal   numeric(14,2);
  v_discount   numeric(14,2);
  v_taxable    numeric(14,2);
  v_gst        numeric(14,2);
begin
  select * into d from public.financial_documents where id = p_doc;
  if not found then return; end if;

  select coalesce(sum(line_total), 0) into v_subtotal
  from public.document_line_items where document_id = p_doc;

  v_discount := case
    when d.discount_type = 'percent' then round(v_subtotal * least(d.discount_value, 100) / 100.0, 2)
    when d.discount_type = 'flat'    then least(d.discount_value, v_subtotal)
    else 0
  end;

  v_taxable := round(v_subtotal - v_discount + coalesce(d.making_charges, 0), 2);
  v_gst     := case when d.gst_enabled then round(v_taxable * d.gst_rate / 100.0, 2) else 0 end;

  update public.financial_documents
     set subtotal        = v_subtotal,
         discount_amount = v_discount,
         taxable_amount  = v_taxable,
         gst_amount      = v_gst,
         grand_total     = round(v_taxable + v_gst, 2)
   where id = p_doc;
end $$;

create or replace function app.line_items_changed()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.recompute_document_totals(coalesce(new.document_id, old.document_id));
  return null;
end $$;

create trigger line_items_recompute
  after insert or update or delete on public.document_line_items
  for each row execute function app.line_items_changed();

-- amount_paid is the sum of confirmed payments, never an asserted field.
create or replace function app.recompute_amount_paid()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_doc uuid := coalesce(new.document_id, old.document_id);
        v_paid numeric(14,2);
        v_total numeric(14,2);
begin
  select coalesce(sum(amount), 0) into v_paid
  from public.payments where document_id = v_doc and confirmed_at is not null;

  select grand_total into v_total from public.financial_documents where id = v_doc;

  update public.financial_documents
     set amount_paid = v_paid,
         status = case
           when v_paid <= 0                    then status
           when v_paid >= v_total - 0.01       then 'paid'::doc_status
           else 'partially_paid'::doc_status
         end
   where id = v_doc;
  return null;
end $$;

create trigger payments_recompute
  after insert or update or delete on public.payments
  for each row execute function app.recompute_amount_paid();

-- ─────────────────────────────────────────────────────────────────────────────
-- Usage counters — replaces the read-everything-and-count loop in
-- usePlanStatus.js:52-62, which was O(n) on every mount and drifted freely.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function app.bump_usage()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_org   uuid    := coalesce(new.org_id, old.org_id);
  v_type  doc_type := coalesce(new.type, old.type);
  v_delta integer := case when tg_op = 'INSERT' then 1 when tg_op = 'DELETE' then -1 else 0 end;
  v_col   text;
begin
  if v_delta = 0 then return null; end if;

  v_col := case v_type
    when 'offer'       then 'offer_letters'
    when 'certificate' then 'certificates'
    when 'nda'         then 'nda'
    when 'mou'         then 'mou'
    when 'invoice'     then 'invoices'
    when 'quotation'   then 'quotations'
    when 'proforma'    then 'proformas'
  end;

  insert into public.usage_counters (org_id) values (v_org) on conflict do nothing;
  execute format(
    'update public.usage_counters set %I = greatest(0, %I + $1), updated_at = now() where org_id = $2',
    v_col, v_col
  ) using v_delta, v_org;

  return null;
end $$;

create trigger records_usage    after insert or delete on public.records
  for each row execute function app.bump_usage();
create trigger fin_docs_usage   after insert or delete on public.financial_documents
  for each row execute function app.bump_usage();

-- Recount from scratch; run after the ETL and any bulk operation.
--
-- NOTE: the two document families are counted in SEPARATE subqueries and then
-- joined on org_id. Counting them with two LEFT JOINs off `organizations` in a
-- single query produces a Cartesian product — every records row pairs with
-- every financial_documents row — and multiplies all seven counts.
create or replace function app.rebuild_usage_counters()
returns void language sql security definer set search_path = public, pg_temp as $$
  insert into public.usage_counters (org_id) select id from public.organizations
  on conflict do nothing;

  update public.usage_counters u set
    offer_letters = coalesce(r.offer, 0),
    certificates  = coalesce(r.cert,  0),
    nda           = coalesce(r.nda,   0),
    mou           = coalesce(r.mou,   0),
    invoices      = coalesce(f.inv,   0),
    quotations    = coalesce(f.quo,   0),
    proformas     = coalesce(f.pi,    0),
    updated_at    = now()
  from public.organizations o
  left join (
    select org_id,
      count(*) filter (where type = 'offer')       as offer,
      count(*) filter (where type = 'certificate') as cert,
      count(*) filter (where type = 'nda')         as nda,
      count(*) filter (where type = 'mou')         as mou
    from public.records group by org_id
  ) r on r.org_id = o.id
  left join (
    select org_id,
      count(*) filter (where type = 'invoice')   as inv,
      count(*) filter (where type = 'quotation') as quo,
      count(*) filter (where type = 'proforma')  as pi
    from public.financial_documents group by org_id
  ) f on f.org_id = o.id
  where u.org_id = o.id;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Organization bootstrap — one transaction, replacing dualWriteService.js's
-- three-store fan-out where a Firestore failure was caught and swallowed
-- (dualWriteService.js:154-157).
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.create_organization(
  p_company_name text,
  p_profile      jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid  uuid := auth.uid();
  v_org  uuid;
  v_dept uuid;
begin
  if v_uid is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  insert into public.organizations (
    company_name, company_email, owner_uid, owner_full_name, owner_role,
    document_designation, industry, country, city, company_size,
    company_description, company_website, primary_contact_name,
    use_cases, account_usage, referral_source, include_logo
  ) values (
    p_company_name,
    nullif(p_profile->>'company_email','')::citext,
    v_uid,
    p_profile->>'owner_full_name',
    p_profile->>'owner_role',
    p_profile->>'document_designation',
    p_profile->>'industry',
    p_profile->>'country',
    p_profile->>'city',
    p_profile->>'company_size',
    p_profile->>'company_description',
    p_profile->>'company_website',
    p_profile->>'primary_contact_name',
    coalesce(
      (select array_agg(value::text) from jsonb_array_elements_text(
         case when jsonb_typeof(p_profile->'use_cases') = 'array'
              then p_profile->'use_cases' else '[]'::jsonb end)),
      '{}'
    ),
    p_profile->>'account_usage',
    p_profile->>'referral_source',
    coalesce((p_profile->>'include_logo')::boolean, true)
  )
  returning id into v_org;

  insert into public.memberships (org_id, user_id, role) values (v_org, v_uid, 'owner');
  insert into public.org_settings   (org_id) values (v_org);
  insert into public.subscriptions  (org_id) values (v_org);
  insert into public.usage_counters (org_id) values (v_org);
  insert into public.org_banking    (org_id) values (v_org);

  insert into public.departments (org_id, name) values (v_org, 'Founder''s Office')
  returning id into v_dept;

  insert into public.employees (org_id, full_name, email, role, department_id, employment_type, is_owner)
  values (
    v_org,
    coalesce(nullif(p_profile->>'owner_full_name',''), p_company_name),
    nullif(p_profile->>'company_email','')::citext,
    coalesce(nullif(p_profile->>'owner_role',''), 'Founder'),
    v_dept, 'fulltime', true
  );

  insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id)
  values (v_org, v_uid, 'organization.created', 'organization', v_org);

  return v_org;
end $$;

grant execute on function public.create_organization(text, jsonb) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Invitation acceptance — the missing half of multi-user support.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.accept_invitation(p_token uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_email citext := (current_setting('request.jwt.claims', true)::jsonb ->> 'email')::citext;
  inv     public.invitations%rowtype;
begin
  if v_uid is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  select * into inv from public.invitations where token = p_token for update;

  if not found                          then raise exception 'invitation not found';       end if;
  if inv.revoked_at  is not null        then raise exception 'invitation revoked';         end if;
  if inv.accepted_at is not null        then raise exception 'invitation already used';    end if;
  if inv.expires_at  <= now()           then raise exception 'invitation expired';         end if;
  if lower(inv.email) <> lower(v_email) then raise exception 'invitation is for a different email address'; end if;

  insert into public.memberships (org_id, user_id, role)
  values (inv.org_id, v_uid, inv.role)
  on conflict (org_id, user_id) do update set role = excluded.role;

  update public.invitations
     set accepted_at = now(), accepted_by = v_uid
   where token = p_token;

  insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, diff)
  values (inv.org_id, v_uid, 'membership.accepted', 'membership', v_uid,
          jsonb_build_object('role', inv.role));

  return inv.org_id;
end $$;

grant execute on function public.accept_invitation(uuid) to authenticated;

-- An organization must always retain exactly one owner.
create or replace function app.protect_last_owner()
returns trigger language plpgsql as $$
declare v_owners integer;
begin
  if tg_op = 'UPDATE' and old.role = 'owner' and new.role <> 'owner'
     or tg_op = 'DELETE' and old.role = 'owner' then
    select count(*) into v_owners
    from public.memberships where org_id = old.org_id and role = 'owner';
    if v_owners <= 1 then
      raise exception 'an organization must always have at least one owner'
        using errcode = 'check_violation';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

create trigger memberships_protect_owner
  before update or delete on public.memberships
  for each row execute function app.protect_last_owner();


-- ############################################################################
-- ## 0003_rls.sql
-- ############################################################################

-- ============================================================================
-- EdgeOS · 0003_rls.sql
-- Row Level Security on every table.
--
-- This file is the replacement for the security model that did not exist:
-- Firebase had no rules file in the repository at all, and the app relied on
-- anonymous sign-in satisfying `auth != null` (RecipientPortal.jsx:99), so any
-- person on the internet could read and write every tenant's data.
--
-- Shape of the model:
--   read    → member of the row's organization
--   write   → member, excluding 'viewer'
--   delete  → owner/admin
--   money/PII (org_banking, employee_compensation) → owner/admin only
--   org_secrets     → RLS on, NO policy: no client role, ever
--   subscriptions   → SELECT only; no write policy, so `plan` cannot be
--                     self-granted from the browser
--   audit_log       → SELECT for admins; INSERT/UPDATE/DELETE denied to all
--
-- The service role bypasses RLS entirely and is used only by server code.
-- ============================================================================

-- Enable RLS everywhere. Any table added later without a policy fails closed.
do $$
declare t text;
begin
  foreach t in array array[
    'organizations','org_banking','org_secrets','org_settings','memberships',
    'subscriptions','usage_counters','departments','employees',
    'employee_compensation','tasks','customers','crm_leads','products','expenses',
    'records','financial_documents','document_line_items','payments',
    'recurring_invoices','document_signatures','portal_tokens','notifications',
    'notification_reads','invitations','audit_log','document_counters',
    'ai_company_memory','legacy_id_map'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end $$;

-- Nothing is granted to anon. The recipient portal reaches documents through
-- server-side endpoints that verify a signed token, not through PostgREST.
revoke all on all tables in schema public from anon;

-- ═════════════════════════════════════════════════════════════════════════════
-- Organizations and their satellite tables
-- ═════════════════════════════════════════════════════════════════════════════

create policy organizations_select on organizations for select to authenticated
  using (deleted_at is null and app.is_member(id));

-- Creation goes through public.create_organization(); direct INSERT is denied
-- so an org can never exist without a matching owner membership.
create policy organizations_update on organizations for update to authenticated
  using (app.is_admin(id)) with check (app.is_admin(id));

-- No delete policy: deletion is a soft delete performed by the admin endpoint
-- under the service role.

create policy org_banking_select on org_banking for select to authenticated
  using (app.is_admin(org_id));
create policy org_banking_write on org_banking for all to authenticated
  using (app.is_admin(org_id)) with check (app.is_admin(org_id));

-- org_secrets: deliberately NO policy. RLS is enabled and forced, so every
-- client role is denied. Only the service role in api/email can read it.

create policy org_settings_select on org_settings for select to authenticated
  using (app.is_member(org_id));
create policy org_settings_write on org_settings for all to authenticated
  using (app.can_write(org_id)) with check (app.can_write(org_id));

create policy memberships_select on memberships for select to authenticated
  using (app.is_member(org_id));
create policy memberships_insert on memberships for insert to authenticated
  with check (app.is_admin(org_id));
create policy memberships_update on memberships for update to authenticated
  using (app.is_admin(org_id)) with check (app.is_admin(org_id));
create policy memberships_delete on memberships for delete to authenticated
  using (app.is_admin(org_id) or user_id = auth.uid());  -- admins remove; anyone may leave

-- Members may READ their plan. There is intentionally no INSERT/UPDATE/DELETE
-- policy, which is what makes `orgStore.updateProfile({plan:'max'})` — the
-- browser-side self-upgrade the audit found — impossible.
create policy subscriptions_select on subscriptions for select to authenticated
  using (app.is_member(org_id));

create policy usage_counters_select on usage_counters for select to authenticated
  using (app.is_member(org_id));
-- Written only by triggers, which run as SECURITY DEFINER.

-- ═════════════════════════════════════════════════════════════════════════════
-- Tenant data — uniform member-read / writer-write / admin-delete
-- ═════════════════════════════════════════════════════════════════════════════

do $$
declare t text;
begin
  foreach t in array array[
    'departments','employees','tasks','customers','crm_leads','products',
    'expenses','records','financial_documents','recurring_invoices',
    'document_signatures','notifications'
  ] loop
    execute format($f$
      create policy %1$s_select on public.%1$I for select to authenticated
        using (app.is_member(org_id));
      create policy %1$s_insert on public.%1$I for insert to authenticated
        with check (app.can_write(org_id));
      create policy %1$s_update on public.%1$I for update to authenticated
        using (app.can_write(org_id)) with check (app.can_write(org_id));
      create policy %1$s_delete on public.%1$I for delete to authenticated
        using (app.is_admin(org_id));
    $f$, t);
  end loop;
end $$;

-- Compensation is the reason employees and pay are separate tables:
-- 'member' and 'viewer' must not see salaries.
create policy employee_compensation_select on employee_compensation for select to authenticated
  using (app.is_admin(org_id));
create policy employee_compensation_write on employee_compensation for all to authenticated
  using (app.is_admin(org_id)) with check (app.is_admin(org_id));

-- Line items inherit access from their parent document.
create policy line_items_select on document_line_items for select to authenticated
  using (app.is_member(org_id));
create policy line_items_write on document_line_items for all to authenticated
  using (app.can_write(org_id)) with check (app.can_write(org_id));

create policy payments_select on payments for select to authenticated
  using (app.is_member(org_id));
create policy payments_insert on payments for insert to authenticated
  with check (app.can_write(org_id));
-- Confirming or reversing a payment is an admin action.
create policy payments_update on payments for update to authenticated
  using (app.is_admin(org_id)) with check (app.is_admin(org_id));
create policy payments_delete on payments for delete to authenticated
  using (app.is_admin(org_id));

-- Portal tokens are issued and revoked by the server. Members may list them to
-- see which links are outstanding; they may not mint one client-side.
create policy portal_tokens_select on portal_tokens for select to authenticated
  using (app.is_member(org_id));
create policy portal_tokens_revoke on portal_tokens for update to authenticated
  using (app.can_write(org_id)) with check (app.can_write(org_id));

create policy notification_reads_own on notification_reads for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy invitations_select on invitations for select to authenticated
  using (app.is_admin(org_id));
create policy invitations_insert on invitations for insert to authenticated
  with check (app.is_admin(org_id));
create policy invitations_update on invitations for update to authenticated
  using (app.is_admin(org_id)) with check (app.is_admin(org_id));
-- Acceptance goes through public.accept_invitation(), which is SECURITY
-- DEFINER — an invitee is not yet a member and so cannot see the row.

-- Append-only, admin-readable.
create policy audit_log_select on audit_log for select to authenticated
  using (app.is_admin(org_id));

create policy document_counters_select on document_counters for select to authenticated
  using (app.is_member(org_id));
-- Mutated only by next_document_number().

create policy ai_memory_select on ai_company_memory for select to authenticated
  using (app.is_member(org_id));
create policy ai_memory_write on ai_company_memory for all to authenticated
  using (app.can_write(org_id)) with check (app.can_write(org_id));

-- ETL bookkeeping: service role only. No policy.

-- ═════════════════════════════════════════════════════════════════════════════
-- Platform administration
--
-- Replaces admin/index.html, whose entire auth was
--   localStorage.getItem('admin_password') || 'admin123'   (line 490)
-- with a gate on `localStorage.admin_session === 'true'`   (line 394)
-- and which signed in to Firebase ANONYMOUSLY (line 391).
--
-- Read-only across tenants, driven by a JWT claim that only the service role
-- can set. Every destructive admin action goes through a server endpoint.
-- ═════════════════════════════════════════════════════════════════════════════

do $$
declare t text;
begin
  foreach t in array array[
    'organizations','memberships','subscriptions','usage_counters',
    'records','financial_documents','audit_log'
  ] loop
    execute format($f$
      create policy %1$s_platform_admin_select on public.%1$I
        for select to authenticated using (app.is_platform_admin());
    $f$, t);
  end loop;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- Grants — RLS filters rows, GRANT decides which verbs exist at all.
-- ═════════════════════════════════════════════════════════════════════════════

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

-- Narrow the verbs where a policy alone is not the whole story.
revoke insert, update, delete on public.subscriptions      from authenticated;
revoke insert, update, delete on public.usage_counters     from authenticated;
revoke insert, update, delete on public.audit_log          from authenticated;
revoke insert, delete         on public.portal_tokens      from authenticated;
revoke all                    on public.org_secrets        from authenticated;
revoke all                    on public.legacy_id_map      from authenticated;
revoke insert, update, delete on public.document_counters  from authenticated;
revoke insert                 on public.organizations      from authenticated;
revoke delete                 on public.organizations      from authenticated;

alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;


-- ############################################################################
-- ## 0004_storage.sql
-- ############################################################################

-- ============================================================================
-- EdgeOS · 0004_storage.sql
-- Storage buckets and their policies.
--
-- Firebase Storage was configured but never used: grep for `firebase/storage`,
-- `getStorage`, `uploadBytes` and `getDownloadURL` across src/, api/ and admin/
-- returns nothing. Logos, signatures and stamps were converted to base64 data
-- URLs (imageUploadService.js:35, imageUtils.js:52) and stored inline in the
-- organization document — risking Firestore's 1 MiB document ceiling, filling
-- the localStorage quota, and re-transferring on every read with no CDN.
--
-- So there is no blob data to migrate; 03-load.js extracts the inline base64
-- and uploads it here.
--
-- Every object is pathed  {org_id}/...  and policed on that first segment.
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  -- Public read: logos and stamps are printed on documents that recipients
  -- open without an account.
  ('org-branding', 'org-branding', true,  2 * 1024 * 1024,
   array['image/png','image/jpeg','image/webp','image/svg+xml']),

  -- Private: authorized signatures, and signatures captured in the portal.
  ('signatures',   'signatures',   false, 1 * 1024 * 1024,
   array['image/png','image/jpeg','image/webp']),

  -- Private: generated PDFs.
  ('documents',    'documents',    false, 20 * 1024 * 1024,
   array['application/pdf'])
on conflict (id) do update
  set file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types,
      public             = excluded.public;

-- Helper: first path segment is the owning organization.
create or replace function app.storage_org(p_name text)
returns uuid language sql immutable as $$
  select nullif((storage.foldername(p_name))[1], '')::uuid;
$$;

-- ─── org-branding ────────────────────────────────────────────────────────────
-- Public bucket: reads are served by the CDN. Writes are member-only.

create policy branding_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'org-branding' and app.can_write(app.storage_org(name)));

create policy branding_update on storage.objects for update to authenticated
  using      (bucket_id = 'org-branding' and app.can_write(app.storage_org(name)))
  with check (bucket_id = 'org-branding' and app.can_write(app.storage_org(name)));

create policy branding_delete on storage.objects for delete to authenticated
  using (bucket_id = 'org-branding' and app.is_admin(app.storage_org(name)));

-- ─── signatures ──────────────────────────────────────────────────────────────
-- Private. Recipients never read from here directly; the portal endpoint
-- returns a short-lived signed URL after validating the portal token.

create policy signatures_select on storage.objects for select to authenticated
  using (bucket_id = 'signatures' and app.is_member(app.storage_org(name)));

create policy signatures_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'signatures' and app.can_write(app.storage_org(name)));

create policy signatures_update on storage.objects for update to authenticated
  using      (bucket_id = 'signatures' and app.can_write(app.storage_org(name)))
  with check (bucket_id = 'signatures' and app.can_write(app.storage_org(name)));

create policy signatures_delete on storage.objects for delete to authenticated
  using (bucket_id = 'signatures' and app.is_admin(app.storage_org(name)));

-- ─── documents ───────────────────────────────────────────────────────────────

create policy documents_select on storage.objects for select to authenticated
  using (bucket_id = 'documents' and app.is_member(app.storage_org(name)));

create policy documents_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'documents' and app.can_write(app.storage_org(name)));

create policy documents_delete on storage.objects for delete to authenticated
  using (bucket_id = 'documents' and app.is_admin(app.storage_org(name)));

-- Anonymous has no policy on any bucket, so `anon` can read only the public
-- org-branding bucket through the CDN and can write nothing.


-- ############################################################################
-- ## 0005_extend_enums.sql
-- ############################################################################

-- ============================================================================
-- 0005_extend_enums.sql — align doc_type / doc_status with the vocabulary the
-- application actually writes.
--
-- 0001_init.sql defined both enums from the idealised model in
-- SUPABASE_MIGRATION.md rather than from the running code. The app emits nine
-- statuses and two document types that the enums reject, so every affected
-- insert/update fails with `invalid input value for enum`.
--
-- This file contains ONLY `alter type ... add value`. Postgres forbids using a
-- newly added enum value in the same transaction that added it, so the CHECK
-- constraints and functions that reference these values live in 0006.
-- ============================================================================

-- ── doc_type ────────────────────────────────────────────────────────────────
-- HR notices issued from Employees.jsx:83-125 and rendered/acknowledged by
-- RecipientPortal.jsx. They were being saved into `fin_docs` for want of
-- anywhere better; 0006 routes them to `records`, where the employee_id FK
-- already exists.
alter type doc_type add value if not exists 'role_change';
alter type doc_type add value if not exists 'termination';

-- ── doc_status ──────────────────────────────────────────────────────────────
-- Written by documentStore.updateStatus() from RecipientPortal.jsx,
-- OfferTracker.jsx and financial/InvoiceList.jsx.

-- The state an offer letter is created in — awaiting the candidate's response.
-- OfferTracker.jsx:634 also falls back to it when status is absent, so it is
-- the effective default for HR documents rather than `draft`.
alter type doc_status add value if not exists 'pending';

-- Signature lifecycle. `signed` is one party; `fully_signed` is both (MoU);
-- `party_a_signed` is the intermediate state before the recipient counter-signs.
alter type doc_status add value if not exists 'signed';
alter type doc_status add value if not exists 'party_a_signed';
alter type doc_status add value if not exists 'fully_signed';

-- HR notices are acknowledged rather than accepted.
alter type doc_status add value if not exists 'acknowledged';

-- Payment lifecycle. `payment_submitted` is recipient-claimed and not yet
-- confirmed by the org — distinct from `paid`, which app.recompute_amount_paid()
-- sets from confirmed `payments` rows. `advance_paid` is the proforma part-payment.
alter type doc_status add value if not exists 'payment_submitted';
alter type doc_status add value if not exists 'advance_paid';

-- Quotation lifecycle.
alter type doc_status add value if not exists 'revision_requested';
alter type doc_status add value if not exists 'order_confirmed';
alter type doc_status add value if not exists 'converted';


-- ############################################################################
-- ## 0006_hr_notices.sql
-- ############################################################################

-- ============================================================================
-- 0006_hr_notices.sql — give `role_change` and `termination` a home.
--
-- Separate from 0005 because Postgres forbids referencing a newly added enum
-- value in the transaction that added it.
--
-- These are employee documents: they carry an employee_id, they are issued to
-- a person rather than a customer, and they have no line items, GST or totals.
-- They belong in `records`, not `financial_documents` — which is also where the
-- employee_id FK and the company_snapshot column already are.
-- ============================================================================

alter table records drop constraint if exists records_type_is_hr;
alter table records add constraint records_type_is_hr
  check (type in ('offer', 'certificate', 'nda', 'mou', 'role_change', 'termination'));

-- Number prefixes. 'RC' and 'TRM' match the strings Employees.jsx passed to the
-- old client-side documentStore.nextId(), so existing link formats are unchanged.
create or replace function app.doc_prefix(p_type doc_type)
returns text language sql immutable as $$
  select case p_type
    when 'invoice'     then 'INV'
    when 'quotation'   then 'QUO'
    when 'proforma'    then 'PI'
    when 'offer'       then 'OL'
    when 'certificate' then 'CRT'
    when 'nda'         then 'NDA'
    when 'mou'         then 'MOU'
    when 'role_change' then 'RC'
    when 'termination' then 'TRM'
  end;
$$;


-- ############################################################################
-- ## 0007_service_role_grants.sql
-- ############################################################################

-- ============================================================================
-- 0007_service_role_grants.sql — give the service role its table privileges.
--
-- 0003_rls.sql granted `authenticated` and revoked `anon`, but never mentioned
-- `service_role`. Supabase's project-level default privileges only cover
-- objects created by `supabase_admin`; these tables were created by `postgres`
-- running the migration, so service_role inherited nothing and every request
-- from api/ came back:
--
--   42501  permission denied for table organizations
--
-- service_role also has BYPASSRLS, so a grant here is the whole story: the
-- policies in 0003 do not filter it. That is deliberate and is why the key is
-- server-only (SUPABASE_MIGRATION.md, M0) — it is the sole route to
-- org_secrets and to writes the portal makes on a recipient's behalf.
-- ============================================================================

grant usage on schema public to service_role;

grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

-- Tables added by later migrations must not silently lock the server out again.
alter default privileges in schema public
  grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public
  grant usage, select on sequences to service_role;

-- app.* holds the helpers RLS and the server both call. 0002 granted usage on
-- the schema; execute is granted to PUBLIC by default, but say so explicitly so
-- a future `revoke ... from public` does not break the server silently.
grant execute on all functions in schema app to service_role;
alter default privileges in schema app grant execute on functions to service_role;


-- ############################################################################
-- ## 0008_pending_status.sql
-- ############################################################################

-- ============================================================================
-- 0008_pending_status.sql — add the one doc_status value that 0005 did not.
--
-- A probe of the live enum found every value 0005 declares EXCEPT 'pending':
--   present: draft sent viewed accepted declined paid partially_paid overdue
--            cancelled expired signed party_a_signed fully_signed acknowledged
--            payment_submitted advance_paid revision_requested order_confirmed
--            converted
--   missing: pending
--
-- 'pending' is the state every offer letter is created in — OfferTracker's New
-- Offer modal, BulkOfferLetters and OfferForm's "Create portal link" all insert
-- with it — so without this value each of those inserts fails outright with
--   invalid input value for enum doc_status: "pending"
-- and no offer can be raised from the tracker at all.
--
-- RUN THIS STATEMENT ON ITS OWN. Postgres forbids using a newly added enum
-- value in the transaction that added it, which is the likely reason it was
-- skipped when 0005 was applied. Run the ALTER, then the backfill separately.
-- ============================================================================

alter type doc_status add value if not exists 'pending';


-- ############################################################################
-- ## 0010_ai_usage.sql
-- ############################################################################

-- ============================================================================
-- 0010_ai_usage.sql — count AI messages in usage_counters.
--
-- usePlanStatus.js read `activeOrg.ai_message_count` and every plan declares an
-- `aiMessages` limit (free: 10), but no such column ever existed on
-- `organizations` and nothing incremented anything. The quota read 0 forever,
-- so the limit was never enforced and every NVIDIA call on the free plan was
-- unmetered spend.
--
-- The counter belongs here, next to the six document counters, and not on
-- `organizations` — that table is readable by any member, and a usage number a
-- member could edit is not a usage number.
--
-- Unlike the document counters this one NEVER decrements: app.bump_usage()
-- subtracts on delete because a deleted invoice is an invoice you no longer
-- have, but a sent message cannot be unsent and its cost is already paid.
-- ============================================================================

alter table usage_counters
  add column if not exists ai_messages integer not null default 0
    check (ai_messages >= 0);

-- Called by api/nvidia.js with the service role, once per accepted request.
--
-- An UPDATE ... SET x = x + 1 has to happen in the database to be atomic;
-- read-modify-write from the serverless function would lose counts whenever two
-- messages overlap. Returns the new total so the caller can enforce the ceiling
-- without a second round trip.
create or replace function public.bump_ai_usage(p_org uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_new integer;
begin
  insert into public.usage_counters (org_id) values (p_org)
  on conflict (org_id) do nothing;

  update public.usage_counters
     set ai_messages = ai_messages + 1,
         updated_at  = now()
   where org_id = p_org
  returning ai_messages into v_new;

  return v_new;
end $$;

-- Server-only. A client that could call this could also not call it, and a
-- quota the metered party controls is not a quota.
revoke execute on function public.bump_ai_usage(uuid) from public;
revoke execute on function public.bump_ai_usage(uuid) from anon, authenticated;
grant  execute on function public.bump_ai_usage(uuid) to service_role;

-- app.rebuild_usage_counters() names its columns explicitly and does not touch
-- ai_messages, so a recount after a bulk operation leaves the AI total intact.
-- That is deliberate: it cannot be rebuilt from rows, because messages are not
-- rows anywhere.


-- ############################################################################
-- ## 0011_product_catalog.sql
-- ############################################################################

-- ============================================================================
-- EdgeOS · 0011_product_catalog.sql — a sellable product/service catalogue and
-- its sales rollup.
--
-- NAMING, and why this table is not called `products`:
--   `products` already exists (0001_init.sql:328) and belongs to
--   ProductPlanner.jsx — it is a ROADMAP: name, status, priority, due_date.
--   It has no price, no SKU and no tax fields, and nothing bills against it.
--   The catalogue this file adds is a different thing that happens to share a
--   word, so it gets its own table. The UI calls it "Products"; the planner
--   keeps its table and its page untouched.
--
-- What this buys, beyond a list:
--   document_line_items.catalog_item_id turns a line item from free text into
--   a reference. Once a line points at a catalogue row, "what did we sell" is
--   answerable in SQL rather than by string-matching descriptions — which is
--   how it would have to be done today, and would fail the moment somebody
--   typed "Website design (Phase 2)" instead of "Website design".
--
-- The rollup columns are maintained by trigger, never by the client, for the
-- same reason the money on financial_documents is (0002_functions.sql:261):
-- a total the browser asserts is a total nobody can verify.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- The catalogue
-- ─────────────────────────────────────────────────────────────────────────────

create table catalog_items (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,

  name          text not null check (length(btrim(name)) between 1 and 200),
  sku           text check (sku is null or length(btrim(sku)) between 1 and 60),
  description   text,
  category      text,

  -- Defaults copied onto a line item when the product is picked. They are
  -- defaults and nothing more: the line item keeps its own columns, so editing
  -- a price here can never restate an invoice that was already issued.
  unit_price    numeric(14,2) not null default 0 check (unit_price >= 0),
  unit          text not null default 'Nos',
  hsn_sac       text,
  tax_rate      numeric(5,2) not null default 18 check (tax_rate between 0 and 100),

  -- Inventory is opt-in: a services business has no stock, and a column that
  -- reads 0 for every row it does not apply to is a column that gets misread.
  -- stock_qty is an operator-maintained on-hand figure. It is deliberately NOT
  -- decremented by the sales trigger — there is no goods-receipt or returns
  -- table to move it the other way, and a number that only ever falls is worse
  -- than one the operator owns outright.
  track_inventory boolean not null default false,
  stock_qty       numeric(14,3) not null default 0,
  low_stock_at    numeric(14,3),

  -- Archive rather than delete: a line item points here, and a catalogue row
  -- that vanishes takes the sales history of everything it sold with it.
  archived_at   timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- ── Trigger-owned. Never written by a client; see the revoke at the end. ──
  -- "Sold" means the line sits on an invoice that left the building, so an
  -- unsent draft cannot inflate a product's numbers.
  units_sold     numeric(14,3) not null default 0,
  revenue        numeric(14,2) not null default 0,
  -- Collected, not merely billed. BillingRevenue.jsx counts revenue as paid
  -- invoices only; a second definition on this screen would put two different
  -- numbers for the same word in the same product.
  revenue_paid   numeric(14,2) not null default 0,
  invoice_count  integer not null default 0,
  last_sold_at   date,

  constraint catalog_items_stock_sane check (stock_qty >= 0)
);

create index catalog_items_org_idx on catalog_items (org_id) where archived_at is null;
create index catalog_items_org_cat_idx on catalog_items (org_id, category) where archived_at is null;
-- Ranking for the "Top Products" view.
create index catalog_items_revenue_idx on catalog_items (org_id, revenue desc) where archived_at is null;
-- A SKU is a key when it is present. Case-insensitive, because "ws-01" and
-- "WS-01" being two products is never what anybody meant. Archived rows are
-- excluded so retiring a product frees its code for reuse.
create unique index catalog_items_org_sku_idx
  on catalog_items (org_id, lower(btrim(sku)))
  where sku is not null and archived_at is null;

-- ─────────────────────────────────────────────────────────────────────────────
-- The link from a sold line back to the catalogue
-- ─────────────────────────────────────────────────────────────────────────────

-- `on delete set null`, paired with archive-do-not-delete above: if a catalogue
-- row is ever hard-deleted the invoice survives intact and simply stops being
-- attributed. The line keeps its own description, rate, hsn_sac and gst_rate,
-- so nothing about the document itself changes.
alter table document_line_items
  add column if not exists catalog_item_id uuid references catalog_items(id) on delete set null;

create index if not exists line_items_catalog_idx
  on document_line_items (catalog_item_id) where catalog_item_id is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- What counts as a sale
-- ─────────────────────────────────────────────────────────────────────────────

-- One definition, called from every place that needs it, so the rollup columns
-- and the date-ranged report can never drift apart.
--
-- Invoices only. A quotation is a proposal and a proforma is a request for
-- advance payment; counting either as a sale would report revenue the company
-- has not earned. Drafts, cancellations and expiries are excluded.
create or replace function app.catalog_is_sold(p_type doc_type, p_status doc_status)
returns boolean language sql immutable as $$
  select p_type = 'invoice'
     and p_status in ('sent','viewed','partially_paid','overdue',
                      'paid','payment_submitted');
$$;

create or replace function app.catalog_is_collected(p_type doc_type, p_status doc_status)
returns boolean language sql immutable as $$
  select p_type = 'invoice' and p_status = 'paid';
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- The rollup
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function app.recompute_catalog_sales(p_item uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_item is null then return; end if;

  update public.catalog_items c
     set units_sold    = coalesce(agg.units, 0),
         revenue       = coalesce(agg.revenue, 0),
         revenue_paid  = coalesce(agg.revenue_paid, 0),
         invoice_count = coalesce(agg.docs, 0),
         last_sold_at  = agg.last_sold
    from (
      select
        sum(li.quantity)                                       as units,
        sum(li.line_total)                                     as revenue,
        sum(li.line_total) filter (
          where app.catalog_is_collected(d.type, d.status))    as revenue_paid,
        count(distinct d.id)                                   as docs,
        max(d.issue_date)                                      as last_sold
      from public.document_line_items li
      join public.financial_documents d on d.id = li.document_id
      where li.catalog_item_id = p_item
        and app.catalog_is_sold(d.type, d.status)
    ) agg
   where c.id = p_item;
end $$;

-- A line item moving in, out, or between products touches at most two rows.
--
-- The branches are nested under TG_OP rather than written as one flat
-- condition: OLD is unassigned on INSERT and NEW on DELETE, and PL/pgSQL does
-- not promise to short-circuit a boolean before the executor substitutes the
-- field reference. `tg_op = 'INSERT' and old.x is null` is a runtime error
-- waiting to happen; this shape cannot reach the wrong record at all.
create or replace function app.catalog_line_changed()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if new.catalog_item_id is not null then
      perform app.recompute_catalog_sales(new.catalog_item_id);
    end if;

  elsif tg_op = 'DELETE' then
    if old.catalog_item_id is not null then
      perform app.recompute_catalog_sales(old.catalog_item_id);
    end if;

  else  -- UPDATE
    -- Recompute whichever products this line has just left and joined. When it
    -- stayed on the same product, quantity or rate may still have moved, so
    -- the second call is not redundant with the first.
    if old.catalog_item_id is distinct from new.catalog_item_id then
      if old.catalog_item_id is not null then
        perform app.recompute_catalog_sales(old.catalog_item_id);
      end if;
      if new.catalog_item_id is not null then
        perform app.recompute_catalog_sales(new.catalog_item_id);
      end if;
    elsif new.catalog_item_id is not null
      and (new.quantity, new.rate) is distinct from (old.quantity, old.rate) then
      perform app.recompute_catalog_sales(new.catalog_item_id);
    end if;
  end if;

  return null;
end $$;

-- AFTER, so line_total has been computed by app.line_item_total() first — the
-- rollup sums that column and would otherwise sum a stale value.
create trigger line_items_catalog_rollup
  after insert or update or delete on public.document_line_items
  for each row execute function app.catalog_line_changed();

-- The far more common event: nothing about the line changes, but the invoice
-- it sits on is sent, or paid, or cancelled. That crosses the sold/not-sold
-- boundary for every product on the document at once.
create or replace function app.catalog_doc_status_changed()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_item uuid;
begin
  for v_item in
    select distinct catalog_item_id
      from public.document_line_items
     where document_id = coalesce(new.id, old.id)
       and catalog_item_id is not null
  loop
    perform app.recompute_catalog_sales(v_item);
  end loop;
  return null;
end $$;

-- `when` keeps this off the path of every ordinary document edit; only a status
-- change can alter what the rollup sees. issue_date is included because
-- last_sold_at reads it.
create trigger fin_docs_catalog_rollup
  after update of status, issue_date on public.financial_documents
  for each row
  when (old.status is distinct from new.status or old.issue_date is distinct from new.issue_date)
  execute function app.catalog_doc_status_changed();

-- A deleted invoice is an invoice you no longer have. The cascade to
-- document_line_items fires the row trigger above, which recomputes each
-- affected product, so no separate delete handler is needed.

-- Backfill / repair, mirroring app.rebuild_usage_counters(). Run after a bulk
-- import, or after attributing historical line items to catalogue rows.
create or replace function app.rebuild_catalog_sales(p_org uuid default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_item uuid;
begin
  for v_item in
    select id from public.catalog_items
     where p_org is null or org_id = p_org
  loop
    perform app.recompute_catalog_sales(v_item);
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Product performance over a date range
--
-- The columns above are all-time and cheap. This is the same arithmetic with a
-- window on it, for "best-selling product this quarter". It aggregates in the
-- database rather than shipping every line item to the browser to be summed
-- there — the client asks a question, not for the ledger.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.catalog_performance(
  p_org  uuid,
  p_from date default null,
  p_to   date default null
)
returns table (
  item_id       uuid,
  name          text,
  sku           text,
  category      text,
  units_sold    numeric,
  revenue       numeric,
  revenue_paid  numeric,
  invoice_count bigint,
  last_sold_at  date
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- SECURITY DEFINER with an explicit membership gate, the same shape
  -- next_document_number() uses: the function reads two tables, and the check
  -- belongs in one place rather than being inferred from whichever RLS policy
  -- happens to apply to each of them.
  select c.id, c.name, c.sku, c.category,
         coalesce(sum(li.quantity), 0)::numeric,
         coalesce(sum(li.line_total), 0)::numeric,
         coalesce(sum(li.line_total) filter (
           where app.catalog_is_collected(d.type, d.status)), 0)::numeric,
         count(distinct d.id),
         max(d.issue_date)
    from public.catalog_items c
    left join public.document_line_items li
           on li.catalog_item_id = c.id
    left join public.financial_documents d
           on d.id = li.document_id
          and app.catalog_is_sold(d.type, d.status)
          and (p_from is null or d.issue_date >= p_from)
          and (p_to   is null or d.issue_date <= p_to)
   where c.org_id = p_org
     and app.is_member(p_org)
     and c.archived_at is null
   group by c.id, c.name, c.sku, c.category
   order by 6 desc, 5 desc, c.name;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Housekeeping triggers every tenant table gets (0002_functions.sql:130)
-- ─────────────────────────────────────────────────────────────────────────────

create trigger catalog_items_touch before update on public.catalog_items
  for each row execute function app.touch_updated_at();

create trigger catalog_items_freeze_org before update on public.catalog_items
  for each row execute function app.freeze_org_id();

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS — member reads, writer writes, admin deletes, the same as every sibling
-- table (0003_rls.sql:93). Enabled AND forced: a table added without this fails
-- open, which is the one failure mode this schema does not accept.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.catalog_items enable row level security;
alter table public.catalog_items force  row level security;

create policy catalog_items_select on catalog_items for select to authenticated
  using (app.is_member(org_id));
create policy catalog_items_insert on catalog_items for insert to authenticated
  with check (app.can_write(org_id));
create policy catalog_items_update on catalog_items for update to authenticated
  using (app.can_write(org_id)) with check (app.can_write(org_id));
create policy catalog_items_delete on catalog_items for delete to authenticated
  using (app.is_admin(org_id));

-- 0003 revoked anon from every table then existing; this one is new.
revoke all on public.catalog_items from anon;

-- 0003 `alter default privileges` already grants authenticated and service_role
-- SELECT/INSERT/UPDATE/DELETE on tables created after it, so no table grant is
-- needed here.
--
-- The rollup columns are the exception. They have to be unwritable from the
-- browser, or "revenue" is whatever the client last asserted rather than what
-- the invoices say — the same failure the money columns on financial_documents
-- were locked down to avoid.
--
-- This has to be a table-level REVOKE followed by a column-level GRANT, and
-- NOT a column-level revoke: privileges are additive, so revoking UPDATE on a
-- few columns while a table-wide UPDATE grant remains changes nothing at all.
-- Dropping the table grant first is what makes the column list the whole set of
-- what a member may write.
revoke update on public.catalog_items from authenticated;
grant update (
  name, sku, description, category,
  unit_price, unit, hsn_sac, tax_rate,
  track_inventory, stock_qty, low_stock_at,
  archived_at
) on public.catalog_items to authenticated;

-- The triggers are unaffected: app.recompute_catalog_sales() is SECURITY
-- DEFINER and runs as the table owner, and app.touch_updated_at() assigns to
-- NEW rather than naming updated_at in a statement, which is not privilege
-- checked either.

-- EXECUTE is granted to PUBLIC by default, and this function is SECURITY
-- DEFINER, so say who may call it rather than leaving it to the default. The
-- app.is_member() gate in the WHERE means an unauthenticated caller would get
-- an empty result anyway; this makes it unreachable instead of merely empty.
revoke execute on function public.catalog_performance(uuid, date, date) from public, anon;
grant  execute on function public.catalog_performance(uuid, date, date) to authenticated, service_role;


-- ############################################################################
-- ## 0012_country_codes.sql
-- ############################################################################

-- ============================================================================
-- EdgeOS · 0012_country_codes.sql
--
-- GENERATED FILE — do not edit by hand.
-- Regenerate with:  node scripts/generate-country-seed.js
--
-- ISO 3166-1 alpha-2, from the i18n-iso-countries package. This is reference
-- data, not tenant data: one row per country, shared by every organisation,
-- readable by anyone signed in and writable by no one.
--
-- It earns its place twice over:
--   1. `aliases` makes organizations.country, a free-text field somebody typed
--      during registration ("India", "USA", "United States"), resolvable to a
--      code without a pile of guesswork in a CASE expression.
--   2. country_code columns get a foreign key, so a typo cannot become a
--      country that the map has no shape for and no report can explain.
-- ============================================================================

create table country_codes (
  code    char(2) primary key check (code ~ '^[A-Z]{2}$'),
  name    text not null,
  aliases text[] not null default '{}'
);

insert into country_codes (code, name, aliases) values
  ('AD', 'Andorra', array['Andorra']),
  ('AE', 'United Arab Emirates', array['United Arab Emirates', 'UAE']),
  ('AF', 'Afghanistan', array['Afghanistan']),
  ('AG', 'Antigua and Barbuda', array['Antigua and Barbuda']),
  ('AI', 'Anguilla', array['Anguilla']),
  ('AL', 'Albania', array['Albania']),
  ('AM', 'Armenia', array['Armenia']),
  ('AO', 'Angola', array['Angola']),
  ('AQ', 'Antarctica', array['Antarctica']),
  ('AR', 'Argentina', array['Argentina']),
  ('AS', 'American Samoa', array['American Samoa']),
  ('AT', 'Austria', array['Austria']),
  ('AU', 'Australia', array['Australia']),
  ('AW', 'Aruba', array['Aruba']),
  ('AX', 'Åland Islands', array['Åland Islands', 'Aland Islands']),
  ('AZ', 'Azerbaijan', array['Azerbaijan']),
  ('BA', 'Bosnia and Herzegovina', array['Bosnia and Herzegovina']),
  ('BB', 'Barbados', array['Barbados']),
  ('BD', 'Bangladesh', array['Bangladesh']),
  ('BE', 'Belgium', array['Belgium']),
  ('BF', 'Burkina Faso', array['Burkina Faso']),
  ('BG', 'Bulgaria', array['Bulgaria']),
  ('BH', 'Bahrain', array['Bahrain']),
  ('BI', 'Burundi', array['Burundi']),
  ('BJ', 'Benin', array['Benin']),
  ('BL', 'Saint Barthélemy', array['Saint Barthélemy']),
  ('BM', 'Bermuda', array['Bermuda']),
  ('BN', 'Brunei Darussalam', array['Brunei Darussalam']),
  ('BO', 'Bolivia', array['Bolivia']),
  ('BQ', 'Bonaire, Sint Eustatius and Saba', array['Bonaire, Sint Eustatius and Saba']),
  ('BR', 'Brazil', array['Brazil']),
  ('BS', 'Bahamas', array['Bahamas']),
  ('BT', 'Bhutan', array['Bhutan']),
  ('BV', 'Bouvet Island', array['Bouvet Island']),
  ('BW', 'Botswana', array['Botswana']),
  ('BY', 'Belarus', array['Belarus']),
  ('BZ', 'Belize', array['Belize']),
  ('CA', 'Canada', array['Canada']),
  ('CC', 'Cocos (Keeling) Islands', array['Cocos (Keeling) Islands']),
  ('CD', 'Democratic Republic of the Congo', array['Democratic Republic of the Congo', 'Congo']),
  ('CF', 'Central African Republic', array['Central African Republic']),
  ('CG', 'Republic of the Congo', array['Republic of the Congo', 'Congo']),
  ('CH', 'Switzerland', array['Switzerland']),
  ('CI', 'Cote d''Ivoire', array['Cote d''Ivoire', 'Côte d''Ivoire', 'Ivory Coast']),
  ('CK', 'Cook Islands', array['Cook Islands']),
  ('CL', 'Chile', array['Chile']),
  ('CM', 'Cameroon', array['Cameroon']),
  ('CN', 'People''s Republic of China', array['People''s Republic of China', 'China']),
  ('CO', 'Colombia', array['Colombia']),
  ('CR', 'Costa Rica', array['Costa Rica']),
  ('CU', 'Cuba', array['Cuba']),
  ('CV', 'Cape Verde', array['Cape Verde']),
  ('CW', 'Curaçao', array['Curaçao']),
  ('CX', 'Christmas Island', array['Christmas Island']),
  ('CY', 'Cyprus', array['Cyprus']),
  ('CZ', 'Czech Republic', array['Czech Republic', 'Czechia']),
  ('DE', 'Germany', array['Germany']),
  ('DJ', 'Djibouti', array['Djibouti']),
  ('DK', 'Denmark', array['Denmark']),
  ('DM', 'Dominica', array['Dominica']),
  ('DO', 'Dominican Republic', array['Dominican Republic']),
  ('DZ', 'Algeria', array['Algeria']),
  ('EC', 'Ecuador', array['Ecuador']),
  ('EE', 'Estonia', array['Estonia']),
  ('EG', 'Egypt', array['Egypt']),
  ('EH', 'Western Sahara', array['Western Sahara']),
  ('ER', 'Eritrea', array['Eritrea']),
  ('ES', 'Spain', array['Spain']),
  ('ET', 'Ethiopia', array['Ethiopia']),
  ('FI', 'Finland', array['Finland']),
  ('FJ', 'Fiji', array['Fiji']),
  ('FK', 'Falkland Islands (Malvinas)', array['Falkland Islands (Malvinas)']),
  ('FM', 'Micronesia, Federated States of', array['Micronesia, Federated States of']),
  ('FO', 'Faroe Islands', array['Faroe Islands']),
  ('FR', 'France', array['France']),
  ('GA', 'Gabon', array['Gabon']),
  ('GB', 'United Kingdom', array['United Kingdom', 'UK', 'Great Britain']),
  ('GD', 'Grenada', array['Grenada']),
  ('GE', 'Georgia', array['Georgia']),
  ('GF', 'French Guiana', array['French Guiana']),
  ('GG', 'Guernsey', array['Guernsey']),
  ('GH', 'Ghana', array['Ghana']),
  ('GI', 'Gibraltar', array['Gibraltar']),
  ('GL', 'Greenland', array['Greenland']),
  ('GM', 'Republic of The Gambia', array['Republic of The Gambia', 'The Gambia', 'Gambia']),
  ('GN', 'Guinea', array['Guinea']),
  ('GP', 'Guadeloupe', array['Guadeloupe']),
  ('GQ', 'Equatorial Guinea', array['Equatorial Guinea']),
  ('GR', 'Greece', array['Greece']),
  ('GS', 'South Georgia and the South Sandwich Islands', array['South Georgia and the South Sandwich Islands']),
  ('GT', 'Guatemala', array['Guatemala']),
  ('GU', 'Guam', array['Guam']),
  ('GW', 'Guinea-Bissau', array['Guinea-Bissau']),
  ('GY', 'Guyana', array['Guyana']),
  ('HK', 'Hong Kong', array['Hong Kong']),
  ('HM', 'Heard Island and McDonald Islands', array['Heard Island and McDonald Islands']),
  ('HN', 'Honduras', array['Honduras']),
  ('HR', 'Croatia', array['Croatia']),
  ('HT', 'Haiti', array['Haiti']),
  ('HU', 'Hungary', array['Hungary']),
  ('ID', 'Indonesia', array['Indonesia']),
  ('IE', 'Ireland', array['Ireland']),
  ('IL', 'Israel', array['Israel']),
  ('IM', 'Isle of Man', array['Isle of Man']),
  ('IN', 'India', array['India']),
  ('IO', 'British Indian Ocean Territory', array['British Indian Ocean Territory']),
  ('IQ', 'Iraq', array['Iraq']),
  ('IR', 'Islamic Republic of Iran', array['Islamic Republic of Iran', 'Iran']),
  ('IS', 'Iceland', array['Iceland']),
  ('IT', 'Italy', array['Italy']),
  ('JE', 'Jersey', array['Jersey']),
  ('JM', 'Jamaica', array['Jamaica']),
  ('JO', 'Jordan', array['Jordan']),
  ('JP', 'Japan', array['Japan']),
  ('KE', 'Kenya', array['Kenya']),
  ('KG', 'Kyrgyzstan', array['Kyrgyzstan']),
  ('KH', 'Cambodia', array['Cambodia']),
  ('KI', 'Kiribati', array['Kiribati']),
  ('KM', 'Comoros', array['Comoros']),
  ('KN', 'Saint Kitts and Nevis', array['Saint Kitts and Nevis']),
  ('KP', 'North Korea', array['North Korea']),
  ('KR', 'South Korea', array['South Korea', 'Korea, Republic of', 'Republic of Korea']),
  ('KW', 'Kuwait', array['Kuwait']),
  ('KY', 'Cayman Islands', array['Cayman Islands']),
  ('KZ', 'Kazakhstan', array['Kazakhstan']),
  ('LA', 'Lao People''s Democratic Republic', array['Lao People''s Democratic Republic']),
  ('LB', 'Lebanon', array['Lebanon']),
  ('LC', 'Saint Lucia', array['Saint Lucia']),
  ('LI', 'Liechtenstein', array['Liechtenstein']),
  ('LK', 'Sri Lanka', array['Sri Lanka']),
  ('LR', 'Liberia', array['Liberia']),
  ('LS', 'Lesotho', array['Lesotho']),
  ('LT', 'Lithuania', array['Lithuania']),
  ('LU', 'Luxembourg', array['Luxembourg']),
  ('LV', 'Latvia', array['Latvia']),
  ('LY', 'Libya', array['Libya']),
  ('MA', 'Morocco', array['Morocco']),
  ('MC', 'Monaco', array['Monaco']),
  ('MD', 'Moldova, Republic of', array['Moldova, Republic of']),
  ('ME', 'Montenegro', array['Montenegro']),
  ('MF', 'Saint Martin (French part)', array['Saint Martin (French part)']),
  ('MG', 'Madagascar', array['Madagascar']),
  ('MH', 'Marshall Islands', array['Marshall Islands']),
  ('MK', 'The Republic of North Macedonia', array['The Republic of North Macedonia', 'North Macedonia']),
  ('ML', 'Mali', array['Mali']),
  ('MM', 'Myanmar', array['Myanmar']),
  ('MN', 'Mongolia', array['Mongolia']),
  ('MO', 'Macao', array['Macao']),
  ('MP', 'Northern Mariana Islands', array['Northern Mariana Islands']),
  ('MQ', 'Martinique', array['Martinique']),
  ('MR', 'Mauritania', array['Mauritania']),
  ('MS', 'Montserrat', array['Montserrat']),
  ('MT', 'Malta', array['Malta']),
  ('MU', 'Mauritius', array['Mauritius']),
  ('MV', 'Maldives', array['Maldives']),
  ('MW', 'Malawi', array['Malawi']),
  ('MX', 'Mexico', array['Mexico']),
  ('MY', 'Malaysia', array['Malaysia']),
  ('MZ', 'Mozambique', array['Mozambique']),
  ('NA', 'Namibia', array['Namibia']),
  ('NC', 'New Caledonia', array['New Caledonia']),
  ('NE', 'Niger', array['Niger']),
  ('NF', 'Norfolk Island', array['Norfolk Island']),
  ('NG', 'Nigeria', array['Nigeria']),
  ('NI', 'Nicaragua', array['Nicaragua']),
  ('NL', 'Netherlands', array['Netherlands', 'The Netherlands', 'Netherlands (Kingdom of the)']),
  ('NO', 'Norway', array['Norway']),
  ('NP', 'Nepal', array['Nepal']),
  ('NR', 'Nauru', array['Nauru']),
  ('NU', 'Niue', array['Niue']),
  ('NZ', 'New Zealand', array['New Zealand']),
  ('OM', 'Oman', array['Oman']),
  ('PA', 'Panama', array['Panama']),
  ('PE', 'Peru', array['Peru']),
  ('PF', 'French Polynesia', array['French Polynesia']),
  ('PG', 'Papua New Guinea', array['Papua New Guinea']),
  ('PH', 'Philippines', array['Philippines']),
  ('PK', 'Pakistan', array['Pakistan']),
  ('PL', 'Poland', array['Poland']),
  ('PM', 'Saint Pierre and Miquelon', array['Saint Pierre and Miquelon']),
  ('PN', 'Pitcairn', array['Pitcairn', 'Pitcairn Islands']),
  ('PR', 'Puerto Rico', array['Puerto Rico']),
  ('PS', 'State of Palestine', array['State of Palestine', 'Palestine']),
  ('PT', 'Portugal', array['Portugal']),
  ('PW', 'Palau', array['Palau']),
  ('PY', 'Paraguay', array['Paraguay']),
  ('QA', 'Qatar', array['Qatar']),
  ('RE', 'Reunion', array['Reunion']),
  ('RO', 'Romania', array['Romania']),
  ('RS', 'Serbia', array['Serbia']),
  ('RU', 'Russian Federation', array['Russian Federation', 'Russia']),
  ('RW', 'Rwanda', array['Rwanda']),
  ('SA', 'Saudi Arabia', array['Saudi Arabia']),
  ('SB', 'Solomon Islands', array['Solomon Islands']),
  ('SC', 'Seychelles', array['Seychelles']),
  ('SD', 'Sudan', array['Sudan']),
  ('SE', 'Sweden', array['Sweden']),
  ('SG', 'Singapore', array['Singapore']),
  ('SH', 'Saint Helena', array['Saint Helena']),
  ('SI', 'Slovenia', array['Slovenia']),
  ('SJ', 'Svalbard and Jan Mayen', array['Svalbard and Jan Mayen']),
  ('SK', 'Slovakia', array['Slovakia']),
  ('SL', 'Sierra Leone', array['Sierra Leone']),
  ('SM', 'San Marino', array['San Marino']),
  ('SN', 'Senegal', array['Senegal']),
  ('SO', 'Somalia', array['Somalia']),
  ('SR', 'Suriname', array['Suriname']),
  ('SS', 'South Sudan', array['South Sudan']),
  ('ST', 'Sao Tome and Principe', array['Sao Tome and Principe']),
  ('SV', 'El Salvador', array['El Salvador']),
  ('SX', 'Sint Maarten (Dutch part)', array['Sint Maarten (Dutch part)']),
  ('SY', 'Syrian Arab Republic', array['Syrian Arab Republic']),
  ('SZ', 'Eswatini', array['Eswatini']),
  ('TC', 'Turks and Caicos Islands', array['Turks and Caicos Islands']),
  ('TD', 'Chad', array['Chad']),
  ('TF', 'French Southern Territories', array['French Southern Territories']),
  ('TG', 'Togo', array['Togo']),
  ('TH', 'Thailand', array['Thailand']),
  ('TJ', 'Tajikistan', array['Tajikistan']),
  ('TK', 'Tokelau', array['Tokelau']),
  ('TL', 'Timor-Leste', array['Timor-Leste']),
  ('TM', 'Turkmenistan', array['Turkmenistan']),
  ('TN', 'Tunisia', array['Tunisia']),
  ('TO', 'Tonga', array['Tonga']),
  ('TR', 'Türkiye', array['Türkiye', 'Turkey']),
  ('TT', 'Trinidad and Tobago', array['Trinidad and Tobago']),
  ('TV', 'Tuvalu', array['Tuvalu']),
  ('TW', 'Taiwan, Province of China', array['Taiwan, Province of China', 'Taiwan']),
  ('TZ', 'United Republic of Tanzania', array['United Republic of Tanzania', 'Tanzania']),
  ('UA', 'Ukraine', array['Ukraine']),
  ('UG', 'Uganda', array['Uganda']),
  ('UM', 'United States Minor Outlying Islands', array['United States Minor Outlying Islands']),
  ('US', 'United States of America', array['United States of America', 'United States', 'USA', 'U.S.A.', 'US', 'U.S.']),
  ('UY', 'Uruguay', array['Uruguay']),
  ('UZ', 'Uzbekistan', array['Uzbekistan']),
  ('VA', 'Holy See (Vatican City State)', array['Holy See (Vatican City State)']),
  ('VC', 'Saint Vincent and the Grenadines', array['Saint Vincent and the Grenadines']),
  ('VE', 'Venezuela', array['Venezuela']),
  ('VG', 'Virgin Islands, British', array['Virgin Islands, British']),
  ('VI', 'Virgin Islands, U.S.', array['Virgin Islands, U.S.']),
  ('VN', 'Vietnam', array['Vietnam']),
  ('VU', 'Vanuatu', array['Vanuatu']),
  ('WF', 'Wallis and Futuna', array['Wallis and Futuna']),
  ('WS', 'Samoa', array['Samoa']),
  ('XK', 'Kosovo', array['Kosovo']),
  ('YE', 'Yemen', array['Yemen']),
  ('YT', 'Mayotte', array['Mayotte']),
  ('ZA', 'South Africa', array['South Africa']),
  ('ZM', 'Zambia', array['Zambia']),
  ('ZW', 'Zimbabwe', array['Zimbabwe']);

-- No index. The table is 250 rows that never grow, and the lookup below runs
-- once per document insert; a sequential scan over 250 rows is cheaper than the
-- index it would have to maintain.

-- Reference data: every signed-in user reads it, nobody writes it. There is no
-- org_id here, so the member test that guards every tenant table does not
-- apply — being authenticated is the whole check.
alter table public.country_codes enable row level security;
alter table public.country_codes force  row level security;

create policy country_codes_select on country_codes for select to authenticated using (true);
-- No insert/update/delete policy: the list changes when ISO changes it, which
-- means regenerating this file, not writing from the browser.

revoke all on public.country_codes from anon;
revoke insert, update, delete on public.country_codes from authenticated;

-- Resolve whatever a human typed into a code. Returns null when nothing
-- matches, which callers treat as "country unknown" rather than as an error.
create or replace function app.country_code_from_name(p_name text)
returns char(2) language sql stable as $fn$
  select c.code
    from public.country_codes c
   where p_name is not null
     and btrim(p_name) <> ''
     and (
       lower(btrim(p_name)) = lower(c.name)
       or lower(btrim(p_name)) = lower(c.code)
       or exists (
         select 1 from unnest(c.aliases) a
          where lower(a) = lower(btrim(p_name))
       )
     )
   limit 1;
$fn$;


-- ############################################################################
-- ## 0013_sales_by_country.sql
-- ############################################################################

-- ============================================================================
-- EdgeOS · 0013_sales_by_country.sql — country as a transaction-level fact.
--
-- THE DESIGN DECISION THIS FILE EXISTS TO MAKE:
--
--   The obvious way to build "Sales by Countries" is to join every document to
--   its customer and read the country off the customer record. That works
--   today and breaks the first time anything changes:
--
--     • A customer who relocates rewrites their own sales history. Last year's
--       invoices silently move to a new country, and a report run twice gives
--       two answers.
--     • A document whose customer_id is null — the FK is ON DELETE SET NULL,
--       and the finance forms let you type a buyer without saving them to the
--       customer list — has no country at all, ever.
--     • A storefront checkout has a country BEFORE it has a customer record,
--       so there would be nowhere to put it.
--
--   So country_code lives on financial_documents, frozen at issue time, exactly
--   like bill_to_name and bill_to_gstin already are. The customer record is
--   only a DEFAULT — one of several sources, recorded in country_source.
--
--   Today that source is 'customer' or 'org_default', filled by trigger with no
--   extra typing. When the storefront ships, checkout writes 'checkout_geoip'
--   or 'checkout_form' into the same column, and the aggregation below, the
--   RPC's signature and the widget on the dashboard do not change at all.
--   That is the whole point: the switch from manual to automatic is a new value
--   in an enum, not a migration.
-- ============================================================================

-- Where a document's country came from. Recording it matters because the
-- sources are not equally trustworthy: a geo-IP guess and an address the buyer
-- typed deserve to be told apart when somebody asks why a number looks wrong.
create type country_source as enum (
  'customer',         -- copied from the customer record at issue time (today)
  'org_default',      -- fell back to the org's own country (today)
  'manual',           -- set by hand on the document
  'checkout_form',    -- billing address captured at checkout (storefront)
  'checkout_geoip'    -- inferred from the buyer's IP at checkout (storefront)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Country on the records that supply the default
-- ─────────────────────────────────────────────────────────────────────────────

-- The org's own country, resolved once from the free text Registration.jsx
-- collected, rather than re-parsed on every document insert.
alter table organizations
  add column if not exists country_code char(2) references country_codes(code);

alter table customers
  add column if not exists country_code char(2) references country_codes(code);

create index if not exists customers_country_idx on customers (org_id, country_code)
  where country_code is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- Country on the transaction itself — the first-class copy
-- ─────────────────────────────────────────────────────────────────────────────

alter table financial_documents
  add column if not exists country_code char(2) references country_codes(code);

alter table financial_documents
  add column if not exists country_source country_source;

-- The widget groups by country within a date window, per org.
create index if not exists fin_docs_country_idx
  on financial_documents (org_id, country_code, issue_date desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- Resolution
-- ─────────────────────────────────────────────────────────────────────────────

-- India-specific, and deliberately narrow. `customers.state` is a free-text
-- field that exists for GST place-of-supply, so a value in it that names an
-- Indian state or union territory is strong evidence of the country — and it is
-- the only country evidence most existing rows have. Anything else returns
-- null and falls through to the org default.
create or replace function app.country_from_state(p_state text)
returns char(2) language sql immutable as $$
  select case when lower(btrim(coalesce(p_state, ''))) in (
    'andhra pradesh','arunachal pradesh','assam','bihar','chhattisgarh','goa',
    'gujarat','haryana','himachal pradesh','jharkhand','karnataka','kerala',
    'madhya pradesh','maharashtra','manipur','meghalaya','mizoram','nagaland',
    'odisha','orissa','punjab','rajasthan','sikkim','tamil nadu','telangana',
    'tripura','uttar pradesh','uttarakhand','west bengal',
    'andaman and nicobar islands','chandigarh',
    'dadra and nagar haveli and daman and diu','dadra and nagar haveli',
    'daman and diu','delhi','new delhi','jammu and kashmir','jammu & kashmir',
    'ladakh','lakshadweep','puducherry','pondicherry'
  ) then 'IN'::char(2) else null end;
$$;

-- The default chain, in confidence order. Returns the code and the source that
-- produced it, so the trigger can stamp both without asking twice.
create or replace function app.resolve_document_country(
  p_org uuid,
  p_customer uuid,
  p_state text
)
returns table (code char(2), src country_source)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_code char(2);
begin
  -- 1. The customer's own country, if somebody has set one.
  if p_customer is not null then
    select c.country_code into v_code from public.customers c where c.id = p_customer;
    if v_code is not null then
      return query select v_code, 'customer'::country_source;
      return;
    end if;

    -- 2. Inferred from the GST state on that customer.
    select app.country_from_state(c.state) into v_code
      from public.customers c where c.id = p_customer;
    if v_code is not null then
      return query select v_code, 'customer'::country_source;
      return;
    end if;
  end if;

  -- 3. The state typed straight onto the document, for a buyer who was never
  --    saved to the customer list.
  v_code := app.country_from_state(p_state);
  if v_code is not null then
    return query select v_code, 'customer'::country_source;
    return;
  end if;

  -- 4. The organisation's own country. Most businesses sell domestically most
  --    of the time, so this is a better default than nothing — and
  --    country_source records that it is a default, not an observation.
  select o.country_code into v_code from public.organizations o where o.id = p_org;
  if v_code is not null then
    return query select v_code, 'org_default'::country_source;
    return;
  end if;

  -- 5. Genuinely unknown. Null, never a guess: the widget shows these in an
  --    "Unspecified" bucket rather than quietly attributing them somewhere.
  return query select null::char(2), null::country_source;
end $$;

-- BEFORE INSERT, and only when the caller did not supply a country. That
-- ordering is what makes the storefront a drop-in later: checkout will insert
-- with country_code and country_source already set, and this trigger will leave
-- them exactly as given.
create or replace function app.fin_doc_set_country()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare r record;
begin
  if new.country_code is not null then
    -- Supplied explicitly. Record how, defaulting to 'manual' for a caller
    -- that set the code but not the source.
    new.country_source := coalesce(new.country_source, 'manual'::country_source);
    return new;
  end if;

  select * into r from app.resolve_document_country(new.org_id, new.customer_id, new.bill_to_state);
  new.country_code := r.code;
  new.country_source := r.src;
  return new;
end $$;

create trigger fin_docs_set_country
  before insert on public.financial_documents
  for each row execute function app.fin_doc_set_country();

-- ─────────────────────────────────────────────────────────────────────────────
-- Backfill
-- ─────────────────────────────────────────────────────────────────────────────

-- The org's free-text country becomes a code once, here.
update organizations
   set country_code = app.country_code_from_name(country)
 where country_code is null and country is not null;

update customers
   set country_code = app.country_from_state(state)
 where country_code is null and app.country_from_state(state) is not null;

-- Existing documents get the same chain the trigger would have applied.
--
-- A loop rather than `UPDATE ... FROM LATERAL f(d.col)`: referencing the UPDATE
-- target from its own FROM clause is not something to rely on, and this runs
-- once, on migration, over rows that already exist. Correctness beats speed for
-- a statement that executes exactly one time.
do $$
declare
  d record;
  r record;
begin
  for d in
    select id, org_id, customer_id, bill_to_state
      from public.financial_documents
     where country_code is null
  loop
    select * into r
      from app.resolve_document_country(d.org_id, d.customer_id, d.bill_to_state);

    update public.financial_documents
       set country_code = r.code,
           country_source = r.src
     where id = d.id;
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- The aggregation behind the widget
--
-- Server-side by construction: the browser sends a window and a filter and gets
-- back one row per country. Nothing about this is computed in React, and
-- nothing is hardcoded.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.sales_by_country(
  p_org          uuid,
  p_from         date default null,
  p_to           date default null,
  p_catalog_item uuid default null
)
-- The first output column is `iso2`, not `country_code`, on purpose: RETURNS
-- TABLE names are in scope inside the body, and a column called country_code
-- there would shadow financial_documents.country_code in the query below.
returns table (
  iso2           char(2),
  revenue        numeric,
  collected      numeric,
  pipeline       numeric,
  doc_count      bigint,
  customer_count bigint,
  prev_revenue   numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with bounds as (
    -- The comparison window is the same length again, ending the day before
    -- p_from. "+34% growth" has to be measured against something, and a
    -- like-for-like preceding period is the only comparison that does not
    -- depend on how long the user happened to leave the page open.
    select
      p_from as cur_from,
      p_to   as cur_to,
      case when p_from is null or p_to is null then null
           else p_from - (p_to - p_from + 1) end as prev_from,
      case when p_from is null then null else p_from - 1 end as prev_to
  ),
  scoped as (
    select
      d.id,
      d.country_code,
      d.type,
      d.status,
      d.issue_date,
      d.customer_id,
      -- Unfiltered, a document contributes its grand total: that is what the
      -- customer was billed. Filtered to one product, it contributes only that
      -- product's lines — deliberately pre-tax and pre-discount, because a
      -- share of a document's GST is not a thing that exists.
      case
        when p_catalog_item is null then d.grand_total
        else coalesce((
          select sum(li.line_total)
            from public.document_line_items li
           where li.document_id = d.id
             and li.catalog_item_id = p_catalog_item
        ), 0)
      end as amount
    from public.financial_documents d
    where d.org_id = p_org
      and (
        p_catalog_item is null
        or exists (
          select 1 from public.document_line_items li
           where li.document_id = d.id
             and li.catalog_item_id = p_catalog_item
        )
      )
  )
  select
    s.country_code,
    -- Revenue is issued invoices, the same definition the Products page and
    -- Billing & Revenue use. Keeping one meaning for the word across three
    -- screens matters more than a bigger number on this one.
    coalesce(sum(s.amount) filter (
      where app.catalog_is_sold(s.type, s.status)
        and (b.cur_from is null or s.issue_date >= b.cur_from)
        and (b.cur_to   is null or s.issue_date <= b.cur_to)
    ), 0),
    coalesce(sum(s.amount) filter (
      where app.catalog_is_collected(s.type, s.status)
        and (b.cur_from is null or s.issue_date >= b.cur_from)
        and (b.cur_to   is null or s.issue_date <= b.cur_to)
    ), 0),
    -- Quotations and proformas, still live. Reported separately rather than
    -- folded into revenue: a quotation is an offer, and adding offers to
    -- invoices would make this widget disagree with every other total in the
    -- product. The widget shows it as pipeline.
    coalesce(sum(s.amount) filter (
      where s.type in ('quotation', 'proforma')
        and s.status not in ('cancelled', 'expired', 'declined', 'draft')
        and (b.cur_from is null or s.issue_date >= b.cur_from)
        and (b.cur_to   is null or s.issue_date <= b.cur_to)
    ), 0),
    count(distinct s.id) filter (
      where app.catalog_is_sold(s.type, s.status)
        and (b.cur_from is null or s.issue_date >= b.cur_from)
        and (b.cur_to   is null or s.issue_date <= b.cur_to)
    ),
    count(distinct s.customer_id) filter (
      where s.customer_id is not null
        and app.catalog_is_sold(s.type, s.status)
        and (b.cur_from is null or s.issue_date >= b.cur_from)
        and (b.cur_to   is null or s.issue_date <= b.cur_to)
    ),
    coalesce(sum(s.amount) filter (
      where app.catalog_is_sold(s.type, s.status)
        and b.prev_from is not null
        and s.issue_date >= b.prev_from
        and s.issue_date <= b.prev_to
    ), 0)
  from scoped s
  cross join bounds b
  where app.is_member(p_org)
  group by s.country_code, b.cur_from, b.cur_to, b.prev_from, b.prev_to
  -- Drop countries with nothing to show in EITHER window. The previous period
  -- has to be part of that test: a country that sold last quarter and nothing
  -- this one is precisely the country the growth figure needs to see, and
  -- filtering on the current window alone would hide it and overstate growth.
  having coalesce(sum(s.amount) filter (
           where app.catalog_is_sold(s.type, s.status)
             and (b.cur_from is null or s.issue_date >= b.cur_from)
             and (b.cur_to   is null or s.issue_date <= b.cur_to)), 0) <> 0
      or coalesce(sum(s.amount) filter (
           where s.type in ('quotation', 'proforma')
             and s.status not in ('cancelled', 'expired', 'declined', 'draft')
             and (b.cur_from is null or s.issue_date >= b.cur_from)
             and (b.cur_to   is null or s.issue_date <= b.cur_to)), 0) <> 0
      or coalesce(sum(s.amount) filter (
           where app.catalog_is_sold(s.type, s.status)
             and b.prev_from is not null
             and s.issue_date >= b.prev_from
             and s.issue_date <= b.prev_to), 0) <> 0
  order by 2 desc, 1;
$$;

revoke execute on function public.sales_by_country(uuid, date, date, uuid) from public, anon;
grant  execute on function public.sales_by_country(uuid, date, date, uuid) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Grants
--
-- 0011 revoked table-wide UPDATE on catalog_items and granted it back per
-- column. financial_documents has no such revoke, so country_code and
-- country_source are writable by any member — which is correct and required:
-- correcting a country on a document is an ordinary edit, and the storefront
-- will set both at insert time.
-- ─────────────────────────────────────────────────────────────────────────────


-- ############################################################################
-- ## 0014_customer_org_guard.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0014 — financial_documents.customer_id may only point inside its own tenant
--
-- Carried over from Phase 0. financial_documents.customer_id has always been a
-- plain FK to customers(id) with no same-org condition, so an org-A document
-- could reference an org-B customer. Nothing in the UI does that, but RLS does
-- not stop it either: the policies gate which ROWS a caller may read from
-- financial_documents, and app.resolve_document_country() is SECURITY DEFINER,
-- so it reads public.customers with RLS bypassed. A document carrying a foreign
-- customer_id would therefore resolve its country — and any future join —
-- against another tenant's row. That is a cross-tenant read, and it is the last
-- one known to exist in the schema.
--
-- Why a trigger and not a composite foreign key:
--
--   The textbook fix is UNIQUE (id, org_id) on customers plus a composite FK
--   (customer_id, org_id) -> customers (id, org_id). It cannot be used here
--   without changing delete semantics. The existing FK is ON DELETE SET NULL,
--   and a composite FK would try to null org_id too, which is NOT NULL. PG 15's
--   column-list `ON DELETE SET NULL (customer_id)` solves that, but pinning the
--   schema to a server version for one constraint is a worse trade than a
--   trigger that states the rule in one readable place.
--
-- The single-column FK stays exactly as it is. It is what keeps ON DELETE SET
-- NULL working. This trigger adds the org predicate the FK cannot express.
-- ─────────────────────────────────────────────────────────────────────────────

-- Report before enforcing. If any row already violates this, the ALTER below
-- would fail on the first write rather than at migration time, which is the
-- worst possible moment to find out.
do $$
declare n integer;
begin
  select count(*) into n
    from public.financial_documents d
    join public.customers c on c.id = d.customer_id
   where c.org_id <> d.org_id;
  if n > 0 then
    raise exception
      '0014: % financial_documents already reference a customer in another org. '
      'These must be resolved by hand before this guard can be installed.', n;
  end if;
  raise notice '0014: 0 pre-existing cross-tenant customer references.';
end $$;

create or replace function app.fin_doc_customer_same_org()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_org uuid;
begin
  if new.customer_id is null then
    return new;
  end if;

  select c.org_id into v_org from public.customers c where c.id = new.customer_id;

  -- Not found is the FK's problem, not ours; let it raise its own error.
  if v_org is not null and v_org <> new.org_id then
    raise exception
      'financial_documents.customer_id % belongs to organization %, not % '
      '(cross-tenant reference refused)', new.customer_id, v_org, new.org_id
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

-- BEFORE, so the row never lands. Fires on org_id too: org_id is frozen by
-- app.freeze_org_id() on this table, but a guard that depends on another
-- trigger staying installed is not a guard.
create trigger fin_docs_customer_same_org
  before insert or update of customer_id, org_id on public.financial_documents
  for each row execute function app.fin_doc_customer_same_org();

-- The mirror of the same rule, from the other side. customers.org_id is frozen,
-- so this can only fire if that freeze is ever removed — which is precisely
-- when this needs to exist.
create or replace function app.customer_org_no_orphan_docs()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  if new.org_id = old.org_id then
    return new;
  end if;
  select count(*) into n from public.financial_documents d where d.customer_id = new.id;
  if n > 0 then
    raise exception
      'customer % cannot change organization while % financial_documents reference it',
      new.id, n using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger customers_org_no_orphan_docs
  before update of org_id on public.customers
  for each row execute function app.customer_org_no_orphan_docs();


-- ############################################################################
-- ## 0015_client_status_enum.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0015 — client_status enum
-- Phase 1 · Entity unification (M1)
--
-- Single-statement transaction per Rule 1: enums get their own migration.
-- ─────────────────────────────────────────────────────────────────────────────

create type client_status as enum (
  'lead',        -- captured, not yet contacted
  'contacted',   -- in active conversation
  'active',      -- deal won / has issued documents / active customer
  'lost',        -- did not convert (CRM not_deal)
  'archived'     -- hidden / archived by operator
);


-- ############################################################################
-- ## 0016_clients.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0016 — clients table
-- Phase 1 · Entity unification (M2)
--
-- Unifies customers (billed parties) and crm_leads (pipeline leads) into a
-- single multi-tenant clients table.
-- ─────────────────────────────────────────────────────────────────────────────

create table clients (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organizations(id) on delete cascade,

  -- Identity: name is billing/company name, person_name is primary contact
  name              text not null check (length(btrim(name)) > 0),
  person_name       text,
  email             citext,
  phone             text,
  address           text,

  -- Tax / place-of-supply
  gstin             text,
  state             text,
  country_code      char(2) references country_codes(code),

  -- Lifecycle & Pipeline
  status            client_status not null default 'lead',
  status_changed_at timestamptz not null default now(),
  value             numeric(14,2) check (value is null or value >= 0),
  position          integer not null default 0,
  notes             text,

  -- Provenance & Metadata
  source            text, -- 'manual' | 'invoice_sync' | 'crm' | 'import' | 'checkout'
  extra             jsonb not null default '{}'::jsonb,
  archived_at       timestamptz,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint clients_named check (
    coalesce(btrim(name), '') <> '' or coalesce(btrim(person_name), '') <> ''
  )
);

-- Non-unique name lookup index
create index clients_org_name_idx on clients (org_id, lower(btrim(name)));

-- Partial unique index on GSTIN within tenant
create unique index clients_org_gstin_idx on clients (org_id, lower(gstin))
  where gstin is not null and btrim(gstin) <> '';

-- Pipeline stage filter index
create index clients_org_status_idx on clients (org_id, status);

-- Triggers: freeze org_id and auto-update updated_at
create trigger clients_freeze_org_id
  before update of org_id on clients
  for each row execute function app.freeze_org_id();

create trigger clients_touch_updated_at
  before update on clients
  for each row execute function app.touch_updated_at();

-- Status timestamp tracker
create or replace function app.clients_track_status_change()
returns trigger language plpgsql as $$
begin
  if new.status <> old.status then
    new.status_changed_at := now();
  end if;
  return new;
end $$;

create trigger clients_status_tracker
  before update of status on clients
  for each row execute function app.clients_track_status_change();

-- ─── Row Level Security ───────────────────────────────────────────────────────
alter table clients enable row level security;
alter table clients force row level security;

create policy clients_select on public.clients for select to authenticated
  using (app.is_member(org_id));

create policy clients_insert on public.clients for insert to authenticated
  with check (app.can_write(org_id));

create policy clients_update on public.clients for update to authenticated
  using (app.can_write(org_id)) with check (app.can_write(org_id));

create policy clients_delete on public.clients for delete to authenticated
  using (app.is_admin(org_id));

-- Anonymous role must have no grants on tenant tables
revoke all on public.clients from anon;


-- ############################################################################
-- ## 0017_clients_backfill.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0017 — backfill clients from crm_leads and customers
-- Phase 1 · Entity unification (M3)
--
-- Preserves crm_leads data, merges matching customers, and inserts unmatched
-- customers preserving their original IDs so financial documents stay linked.
-- ─────────────────────────────────────────────────────────────────────────────

-- 0. Drop legacy FK constraints to customers so customer_id can be repointed to clients
alter table public.financial_documents
  drop constraint if exists financial_documents_customer_id_fkey;

alter table public.recurring_invoices
  drop constraint if exists recurring_invoices_customer_id_fkey;

do $$
declare
  r_cust record;
  v_client_id uuid;
  n_existing integer;
begin
  -- Refuse rather than re-run.
  --
  -- This used to open with `delete from public.clients`, described as making the
  -- migration idempotent. It does the opposite once the app is live: after
  -- cutover `clients` is the table the Customers screen and the CRM board write
  -- to, so a second run would delete every client created since — and because
  -- lead-derived rows get fresh gen_random_uuid() ids on the way back in, the
  -- documents repointed to them in the first run would be left pointing at ids
  -- that no longer exist. 0018 re-adds the foreign key, so the next migration
  -- would then fail on rows this one orphaned.
  --
  -- A backfill is a one-time event. The correct behaviour on a second run is to
  -- stop, not to improvise.
  select count(*) into n_existing from public.clients;
  if n_existing > 0 then
    raise exception
      '0017: clients already holds % row(s). This backfill runs once, against an '
      'empty table. If you are rebuilding a scratch environment, truncate '
      'clients by hand first and be certain nothing depends on the ids.',
      n_existing;
  end if;

  -- 1. Backfill crm_leads into clients
  insert into public.clients (
    org_id,
    name,
    person_name,
    email,
    phone,
    status,
    value,
    position,
    notes,
    source,
    extra,
    created_at
  )
  select
    l.org_id,
    coalesce(nullif(btrim(l.company_name), ''), nullif(btrim(l.person_name), ''), 'Unnamed Lead') as name,
    l.person_name,
    l.email,
    l.phone,
    case
      when l.stage = 'deal' then 'active'::client_status
      when l.stage = 'not_deal' then 'lost'::client_status
      when l.stage = 'contacted' then 'contacted'::client_status
      else 'lead'::client_status
    end as status,
    l.value,
    coalesce(l.position, 0) as position,
    l.notes,
    'crm' as source,
    coalesce(l.extra, '{}'::jsonb) as extra,
    coalesce(l.created_at, now()) as created_at
  from public.crm_leads l;

  -- 2. Merge existing customers into clients
  for r_cust in (select * from public.customers) loop
    v_client_id := null;

    -- Match by GSTIN first within the same org
    if r_cust.gstin is not null and btrim(r_cust.gstin) <> '' then
      select id into v_client_id
      from public.clients
      where org_id = r_cust.org_id
        and lower(gstin) = lower(btrim(r_cust.gstin))
      limit 1;
    end if;

    -- Then match by email
    if v_client_id is null and r_cust.email is not null and btrim(r_cust.email) <> '' then
      select id into v_client_id
      from public.clients
      where org_id = r_cust.org_id
        and lower(email) = lower(btrim(r_cust.email))
      limit 1;
    end if;

    -- Then match by exact name
    if v_client_id is null and r_cust.name is not null and btrim(r_cust.name) <> '' then
      select id into v_client_id
      from public.clients
      where org_id = r_cust.org_id
        and lower(btrim(name)) = lower(btrim(r_cust.name))
      limit 1;
    end if;

    if v_client_id is not null then
      -- Existing lead match: update with billing/tax details
      update public.clients
      set
        address = coalesce(nullif(btrim(r_cust.address), ''), address),
        gstin = coalesce(nullif(btrim(r_cust.gstin), ''), gstin),
        state = coalesce(nullif(btrim(r_cust.state), ''), state),
        country_code = coalesce(r_cust.country_code, country_code),
        phone = coalesce(nullif(btrim(r_cust.phone), ''), phone),
        -- A customers row means this party has been billed, so 'active' is the
        -- right status for a lead still in the pipeline. It is NOT right for one
        -- the operator has already resolved: a lead marked not_deal ('lost') that
        -- matches an old customer record has genuinely been lost, and silently
        -- reviving it would put it back on the board as a live deal.
        -- entity-decision.md §3 maps stage to status; this preserves that mapping
        -- for the two terminal states and promotes only the open ones.
        status = case
                   when status in ('lost', 'archived') then status
                   else 'active'::client_status
                 end
      where id = v_client_id;

      -- If customer ID differed from matched client ID, repoint documents
      update public.financial_documents
      set customer_id = v_client_id
      where customer_id = r_cust.id;

      update public.recurring_invoices
      set customer_id = v_client_id
      where customer_id = r_cust.id;
    else
      -- No match: insert customer with its original ID preserved
      insert into public.clients (
        id,
        org_id,
        name,
        email,
        phone,
        address,
        gstin,
        state,
        country_code,
        status,
        source,
        created_at
      ) values (
        r_cust.id,
        r_cust.org_id,
        coalesce(nullif(btrim(r_cust.name), ''), 'Unnamed Client'),
        r_cust.email,
        r_cust.phone,
        r_cust.address,
        r_cust.gstin,
        r_cust.state,
        r_cust.country_code,
        'active',
        'customer_list',
        coalesce(r_cust.created_at, now())
      );
    end if;
  end loop;

  raise notice '0017: Backfill of clients completed successfully.';
end $$;


-- ############################################################################
-- ## 0018_repoint_fks.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0018 — repoint foreign keys to clients
-- Phase 1 · Entity unification (M4)
--
-- Repoints financial_documents.customer_id and recurring_invoices.customer_id
-- to clients(id), keeping the column name so sales_by_country() survives.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.financial_documents
  drop constraint if exists financial_documents_customer_id_fkey;

alter table public.financial_documents
  add constraint financial_documents_customer_id_fkey
  foreign key (customer_id) references public.clients(id) on delete set null;

alter table public.recurring_invoices
  drop constraint if exists recurring_invoices_customer_id_fkey;

alter table public.recurring_invoices
  add constraint recurring_invoices_customer_id_fkey
  foreign key (customer_id) references public.clients(id) on delete set null;


-- ############################################################################
-- ## 0019_country_guard_clients.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0019 — country resolution and cross-tenant guards over clients
-- Phase 1 · Entity unification (M6)
--
-- Updates app.resolve_document_country() and cross-tenant foreign key guards
-- to read public.clients rather than the legacy customers table.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Country resolution over clients
create or replace function app.resolve_document_country(
  p_org uuid,
  p_customer uuid,
  p_state text
)
returns table (code char(2), src country_source)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_code char(2);
begin
  -- 1. The client's own country, if somebody has set one.
  if p_customer is not null then
    select c.country_code into v_code from public.clients c where c.id = p_customer;
    if v_code is not null then
      return query select v_code, 'customer'::country_source;
      return;
    end if;

    -- 2. Inferred from the GST state on that client.
    select app.country_from_state(c.state) into v_code
      from public.clients c where c.id = p_customer;
    if v_code is not null then
      return query select v_code, 'customer'::country_source;
      return;
    end if;
  end if;

  -- 3. The state typed straight onto the document, for a buyer who was never
  --    saved to the client list.
  v_code := app.country_from_state(p_state);
  if v_code is not null then
    return query select v_code, 'customer'::country_source;
    return;
  end if;

  -- 4. The organisation's own country default.
  select o.country_code into v_code from public.organizations o where o.id = p_org;
  if v_code is not null then
    return query select v_code, 'org_default'::country_source;
    return;
  end if;

  -- 5. Genuinely unknown.
  return query select null::char(2), null::country_source;
end $$;

-- 2. Cross-tenant check on financial_documents.customer_id
create or replace function app.fin_doc_customer_same_org()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_org uuid;
begin
  if new.customer_id is null then
    return new;
  end if;

  select c.org_id into v_org from public.clients c where c.id = new.customer_id;

  if v_org is not null and v_org <> new.org_id then
    raise exception
      'financial_documents.customer_id % belongs to organization %, not % (cross-tenant reference refused)',
      new.customer_id, v_org, new.org_id
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

-- 3. Cross-tenant check on clients org update
create or replace function app.client_org_no_orphan_docs()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  if new.org_id = old.org_id then
    return new;
  end if;
  select count(*) into n from public.financial_documents d where d.customer_id = new.id;
  if n > 0 then
    raise exception
      'client % cannot change organization while % financial_documents reference it',
      new.id, n using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists clients_org_no_orphan_docs on public.clients;
create trigger clients_org_no_orphan_docs
  before update of org_id on public.clients
  for each row execute function app.client_org_no_orphan_docs();


-- ############################################################################
-- ## 0020_audit_triggers.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0020 — a generic audit trigger, attached to the tables worth auditing
-- Phase 1 · M7 (migration-order.md §2)
--
-- audit_log has existed since 0001 and is append-only (app.forbid_write blocks
-- UPDATE and DELETE, and 0003 revokes every write verb from `authenticated`),
-- but until now the only things writing to it were /api/admin and two functions
-- in 0002. Nothing recorded an ordinary edit, so feature-audit.md #24 — "who
-- changed this, and when" — had no data behind it.
--
-- Design notes:
--
--   * SECURITY DEFINER. `authenticated` has no INSERT on audit_log and must not
--     get one: a client that could insert could forge history. The trigger runs
--     as the owner instead, which is also why it sets search_path explicitly.
--
--   * The diff is the changed columns only, old and new side by side. Storing
--     whole rows would double the database and bury the one field that moved.
--
--   * Column-level exclusions. updated_at changes on every write by trigger, so
--     recording it adds a row of pure noise to every diff.
--
--   * The actor is auth.uid(), which is null for a service-role write. That is
--     correct and deliberate: a null actor means "the server did this", and the
--     endpoints that act on a recipient's behalf (api/portal.js) have no user to
--     name. api/admin.js keeps writing its own rows because it knows the
--     platform admin's id, which auth.uid() would not give it.
--
--   * AFTER, and it never raises. An audit failure must not roll back the write
--     it was describing; anything unexpected is swallowed and logged as a
--     warning. A missing audit row is a gap, a failed invoice save is an outage.
-- ─────────────────────────────────────────────────────────────────────────────

-- Columns that change on their own and say nothing about intent.
create or replace function app.audit_ignored_columns()
returns text[] language sql immutable as $$
  select array['updated_at', 'created_at', 'status_changed_at']::text[]
$$;

-- Most audited tables have an `id`; employee_compensation is keyed by
-- employee_id instead, and an audit row with a null entity_id cannot be joined
-- back to anything.
create or replace function app.audit_entity_id(p_row jsonb)
returns uuid language sql immutable as $$
  select coalesce(p_row ->> 'id', p_row ->> 'employee_id')::uuid
$$;

create or replace function app.write_audit()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_org       uuid;
  v_entity    uuid;
  v_action    text;
  v_diff      jsonb := '{}'::jsonb;
  v_old       jsonb;
  v_new       jsonb;
  v_key       text;
  v_ignored   text[] := app.audit_ignored_columns();
begin
  if tg_op = 'DELETE' then
    v_old := to_jsonb(old);
    v_new := '{}'::jsonb;
    v_org := (v_old ->> 'org_id')::uuid;
    v_entity := app.audit_entity_id(v_old);
    v_action := tg_table_name || '.delete';
  elsif tg_op = 'INSERT' then
    v_old := '{}'::jsonb;
    v_new := to_jsonb(new);
    v_org := (v_new ->> 'org_id')::uuid;
    v_entity := app.audit_entity_id(v_new);
    v_action := tg_table_name || '.insert';
  else
    v_old := to_jsonb(old);
    v_new := to_jsonb(new);
    v_org := (v_new ->> 'org_id')::uuid;
    v_entity := app.audit_entity_id(v_new);
    v_action := tg_table_name || '.update';
  end if;

  if tg_op = 'UPDATE' then
    -- Changed columns only.
    for v_key in select jsonb_object_keys(v_new) loop
      if v_key = any(v_ignored) then
        continue;
      end if;
      if (v_new -> v_key) is distinct from (v_old -> v_key) then
        v_diff := v_diff || jsonb_build_object(
          v_key, jsonb_build_object('from', v_old -> v_key, 'to', v_new -> v_key)
        );
      end if;
    end loop;

    -- A write that changed nothing we care about is not worth a row.
    if v_diff = '{}'::jsonb then
      return null;
    end if;
  else
    -- Insert and delete record the row's own identifying fields rather than
    -- every column: the row itself is still there (or still in a backup), and
    -- an audit trail is an index into it, not a second copy of it.
    v_diff := jsonb_strip_nulls(jsonb_build_object(
      'name',       coalesce(v_new -> 'name',       v_old -> 'name'),
      'title',      coalesce(v_new -> 'title',      v_old -> 'title'),
      'full_name',  coalesce(v_new -> 'full_name',  v_old -> 'full_name'),
      'doc_number', coalesce(v_new -> 'doc_number', v_old -> 'doc_number'),
      'status',     coalesce(v_new -> 'status',     v_old -> 'status'),
      'amount',     coalesce(v_new -> 'amount',     v_old -> 'amount')
    ));
  end if;

  insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, diff)
  values (v_org, auth.uid(), v_action, tg_table_name, v_entity, v_diff);

  return null;  -- AFTER trigger; the return value is ignored either way.
exception when others then
  raise warning 'audit trigger on % failed: %', tg_table_name, sqlerrm;
  return null;
end $$;

-- ─── Attach ───────────────────────────────────────────────────────────────────
--
-- The list is migration-order.md M7's, unchanged except that `customers` and
-- `crm_leads` are absent: 0016-0018 moved the app onto `clients`, nothing writes
-- the legacy tables any more, and M9 drops them.
--
-- employee_compensation is audited even though it is not on M7's list. It is the
-- most sensitive table in the schema that a human edits, and "who changed this
-- salary" is exactly the question an audit log exists to answer.
do $$
declare t text;
begin
  foreach t in array array[
    'clients', 'financial_documents', 'records', 'employees', 'tasks',
    'payments', 'catalog_items', 'expenses', 'employee_compensation'
  ] loop
    execute format('drop trigger if exists %I on public.%I', t || '_audit', t);
    execute format(
      'create trigger %I after insert or update or delete on public.%I '
      'for each row execute function app.write_audit()',
      t || '_audit', t
    );
  end loop;
end $$;


-- ############################################################################
-- ## 0021_audit_read_policy.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0021 — who may read the audit log
-- Phase 1 · M8 (migration-order.md §2)
--
-- 0003:160 made audit_log admin-only, written when nothing populated the table.
-- 0020 turned it into a live record of every edit across nine tables, so the
-- question M8 poses has to be answered now: is the Activity Log an admin report,
-- or a member-visible feature?
--
-- The decision taken here: members may read the audit trail of the entities they
-- can already read, and nothing else. The reasoning is that an audit row is
-- strictly less information than the row it describes — if a member can open the
-- invoice, they can see its amount and status, and hiding *who changed it* from
-- them protects nothing while making the history useless to the people doing the
-- work.
--
-- Two entity types do NOT widen, because the underlying table is itself
-- restricted to owner/admin and the diff would leak exactly what the table's own
-- policy withholds:
--
--   employee_compensation  salaries (0003: is_admin)
--   organization           the /api/admin actions, including plan changes
--
-- Admins keep the unrestricted view. The write side is untouched: INSERT, UPDATE
-- and DELETE stay revoked from every client role (0003:210), app.forbid_write
-- blocks UPDATE/DELETE even for the table owner, and the only writers are
-- app.write_audit() and /api/admin under the service role.
-- ─────────────────────────────────────────────────────────────────────────────

-- The entity types whose audit rows stay admin-only, as a function so the list
-- lives in one place and a future table can be added without rewriting a policy.
create or replace function app.audit_admin_only_entities()
returns text[] language sql immutable as $$
  select array['employee_compensation', 'organization']::text[]
$$;

drop policy if exists audit_log_select on public.audit_log;

create policy audit_log_select on public.audit_log for select to authenticated
  using (
    app.is_admin(org_id)
    or (
      app.is_member(org_id)
      and entity_type is not null
      and not (entity_type = any(app.audit_admin_only_entities()))
    )
  );

-- The platform admin's cross-tenant read, matching the *_platform_admin_select
-- policies 0003 installs on the other tables. Support cannot answer "what
-- happened to this org" without it.
drop policy if exists audit_log_platform_admin_select on public.audit_log;

create policy audit_log_platform_admin_select on public.audit_log for select to authenticated
  using (app.is_platform_admin());


-- ############################################################################
-- ## 0022_authenticated_default_privileges.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0022 — make the `authenticated` grant survive new tables, and say it out loud
--
-- 0007 fixed this for service_role after every api/ request started coming back
-- `42501 permission denied for table organizations`. The same hole is still open
-- for `authenticated`, and the repository currently claims otherwise:
--
--   0011:334  "0003 `alter default privileges` already grants authenticated and
--              service_role SELECT/INSERT/UPDATE/DELETE on tables created after
--              it, so no table grant is [needed]"
--
-- 0003 contains no `alter default privileges`. What it has is
--
--   0003:205  grant select, insert, update, delete on all tables in schema public
--             to authenticated;
--
-- which is a one-time grant over the tables that existed when it ran. Everything
-- added later — catalog_items (0011), country_codes (0012), clients (0016) — has
-- been relying on the Supabase project's own default privileges instead. Those
-- happen to cover it today, which is why the app works and why 0012 had
-- something to revoke at its line 292. Relying on it is still wrong: it is
-- outside this repository, it differs between a hosted project and the local
-- harness, and the next table added by a migration is one environment change
-- away from being unreadable.
--
-- RLS is unaffected either way. A grant decides which verbs exist; the policies
-- in 0003 and 0016 decide which rows. A table with a grant and no policy is
-- still fully denied, which is the fail-closed property 0003 relies on.
-- ─────────────────────────────────────────────────────────────────────────────

-- Future tables, the 0007 treatment.
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public
  grant usage, select on sequences to authenticated;

-- And the three tables that already exist on the back of the project default,
-- stated explicitly so they no longer depend on it.
--
-- Only `clients` gets the full set. The other two are deliberately narrower and
-- those narrowings must not be undone here:
--   country_codes   reference data; 0012:292 revoked insert/update/delete
--   catalog_items   0011:348 revoked table-wide UPDATE and granted it back per
--                   column, so a blanket grant would silently re-open the
--                   trigger-owned columns to clients
grant select, insert, update, delete on public.clients to authenticated;
grant select on public.country_codes to authenticated;
grant select, insert, delete on public.catalog_items to authenticated;

-- anon keeps nothing, on every one of them.
revoke all on public.clients       from anon;
revoke all on public.country_codes from anon;
revoke all on public.catalog_items from anon;


-- ############################################################################
-- ## 0024_email_rate_limit.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0024 — rate limits for /api/email
-- FIX_PLAN item 7: "Rate-limit (100 emails/hr, 20 test-connections/day)"
--
-- The endpoint now requires a session and org membership, so this is no longer
-- an open relay. What authentication does not bound is volume: one compromised
-- member account, or one loop in a bulk-send screen (BulkOfferLetters.jsx sends
-- one message per recipient), can still push an org's Gmail account past its
-- sending quota and get it throttled by Google for everyone.
--
-- Why this is in the database and not in the function:
--
--   api/ deploys as serverless functions. There is no process to keep a counter
--   in — each invocation may be a cold start on a different instance, so an
--   in-memory map would reset constantly and limit nothing. The only state all
--   invocations share is Postgres.
--
-- The table is server-only. No policy is created, and both client roles are
-- revoked, so a member cannot read who emailed whom or delete their own rows to
-- clear the limit. The service role reaches it through the function below.
-- ─────────────────────────────────────────────────────────────────────────────

create table email_events (
  id         bigint generated always as identity primary key,
  org_id     uuid not null references organizations(id) on delete cascade,
  user_id    uuid references auth.users(id) on delete set null,
  kind       text not null check (kind in ('send', 'test')),
  created_at timestamptz not null default now()
);

-- The only query shape this table serves: count one org's events of one kind
-- inside a window.
create index email_events_org_kind_idx on email_events (org_id, kind, created_at desc);

alter table email_events enable row level security;
alter table email_events force row level security;
-- Deliberately no policy: RLS with no policy denies every client role outright,
-- and the service role bypasses RLS. Same pattern as org_secrets (0003:15).

revoke all on public.email_events from anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- The limits, in one place. Changing a number here changes it for every caller.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function app.email_rate_limit(p_kind text)
returns table (max_events integer, window_length interval)
language sql immutable as $$
  select
    case p_kind when 'send' then 100 when 'test' then  20 end,
    case p_kind when 'send' then interval '1 hour'
                when 'test' then interval '1 day' end
$$;

/**
 * Claims one unit of an org's email quota.
 *
 * Returns the number of events remaining after this one on success. Raises
 * `check_violation` when the limit is already reached, which api/email.js turns
 * into a 429 — the caller is told when to come back, because a send that is
 * silently dropped looks to the user exactly like a send that worked.
 *
 * Atomic by advisory lock rather than by unique index: the limit is a count over
 * a moving window, so there is no single row to conflict on. The lock is per
 * org+kind and held to the end of the transaction, so two concurrent sends from
 * the same org serialise here and neither can read a stale count. Different orgs
 * never contend.
 */
create or replace function public.claim_email_quota(p_org uuid, p_kind text, p_user uuid default null)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_max    integer;
  v_window interval;
  v_used   integer;
begin
  select max_events, window_length into v_max, v_window
    from app.email_rate_limit(p_kind);

  if v_max is null then
    raise exception 'unknown email rate-limit kind: %', p_kind
      using errcode = 'invalid_parameter_value';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_org::text || ':' || p_kind));

  select count(*) into v_used
    from public.email_events
   where org_id = p_org
     and kind = p_kind
     and created_at > now() - v_window;

  if v_used >= v_max then
    raise exception
      'Email rate limit reached: % of % per % for this organization',
      v_used, v_max, v_window
      using errcode = 'check_violation';
  end if;

  insert into public.email_events (org_id, user_id, kind)
  values (p_org, p_user, p_kind);

  return v_max - v_used - 1;
end $$;

-- Server-only, like the table. A client that could call this could burn an org's
-- quota without sending anything.
revoke execute on function public.claim_email_quota(uuid, text, uuid) from public, anon, authenticated;
grant  execute on function public.claim_email_quota(uuid, text, uuid) to service_role;

-- Old rows say nothing once their window has passed. Nothing in this project runs
-- on a schedule (feature-audit.md #29), so the cheap approximation is to let the
-- next caller clear the backlog: one delete of rows far outside the widest
-- window, cheap because of the index above.
create or replace function public.prune_email_events()
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  delete from public.email_events where created_at < now() - interval '7 days';
  get diagnostics n = row_count;
  return n;
end $$;

revoke execute on function public.prune_email_events() from public, anon, authenticated;
grant  execute on function public.prune_email_events() to service_role;


-- ############################################################################
-- ## 0026_role_permissions.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0026 — roles and permissions become data
-- Phase 2 · step 1
--
-- Until now a role was a value of the `member_role` enum and what it could do
-- was spelled out in SQL: 0003 wrote every policy against three helpers —
--
--   app.is_member(org)  any role                     → "view"
--   app.can_write(org)  owner, admin, member         → "create" / "edit"
--   app.is_admin(org)   owner, admin                 → "delete", and the
--                                                      admin-only resources
--
-- so adding a role, or letting members delete expenses, meant a migration that
-- rewrote policies across thirty tables. This file introduces the tables that
-- replace that; 0027 rewrites the policies to read them.
--
--   roles                     the role catalogue (global). Replaces the enum:
--                             memberships.role and invitations.role become text
--                             with a foreign key here.
--   permission_resources      what can be permissioned (global), and which of
--                             view/create/edit/delete are meaningful for each.
--   role_permission_defaults  the matrix a new organization starts with.
--   role_permissions          each organization's own matrix: one row per
--                             (org, role, resource) with four flags. This is
--                             what the Settings toggle grid edits and what
--                             app.has_permission() reads.
--
-- DAY ONE CHANGES NOTHING. The defaults below are a transcription of the
-- policies as they stand after 0025, resource by resource, and
-- tests/02_access_matrix.sql proves it: it evaluates every policy expression
-- in pg_policies for every role against own-org and foreign-org rows, and its
-- output must match tests/expected/day_one_access.out — captured on the
-- schema before this migration — line for line.
--
-- What is deliberately NOT data (see 0027 for where each is enforced):
--   · employee_compensation, org_banking   owner/admin only, always
--   · org_secrets, email_events,
--     legacy_id_map                        no policy at all; service role only
--   · subscriptions / usage_counters /
--     audit_log / document_counters writes no grant; view is the only action
--   · the last owner                       app.protect_last_owner (0002)
--   · the owner role's own permissions     always complete; not editable
-- None of those appears in permission_resources as an editable action, so no
-- toggle can reach them.
-- ─────────────────────────────────────────────────────────────────────────────

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. The role catalogue, replacing the enum
-- ═════════════════════════════════════════════════════════════════════════════

create table public.roles (
  key         text primary key check (key ~ '^[a-z][a-z0-9_]{1,31}$'),
  label       text not null check (length(btrim(label)) between 1 and 60),
  description text,
  -- Display order in the UI. Never an authorization input: nothing may
  -- compare ranks to decide access, or a new role slotted "between" two others
  -- would inherit permissions nobody granted it.
  sort_order  integer not null,
  created_at  timestamptz not null default now()
);
comment on table public.roles is
  'Role catalogue. Adding a role is an INSERT here plus rows in role_permission_defaults — no DDL. '
  'owner and admin are referenced by name by the non-configurable guards in 0027.';

insert into public.roles (key, label, description, sort_order) values
  ('owner',  'Owner',  'Full control, including billing, banking, pay and who else is an owner.', 10),
  ('admin',  'Admin',  'Runs the organization day to day, including banking, pay and team access.', 20),
  ('member', 'Member', 'Creates and edits the organization''s work. Cannot see pay or banking.',    30),
  ('viewer', 'Viewer', 'Read-only.',                                                                40);

-- memberships.role / invitations.role: enum → text + FK. Every existing value
-- is one of the four keys above, so the cast and the FK cannot fail on
-- existing rows.
alter table public.memberships alter column role drop default;
alter table public.memberships alter column role type text using role::text;
alter table public.memberships alter column role set default 'member';
alter table public.memberships
  add constraint memberships_role_fkey foreign key (role) references public.roles(key) on update cascade;

alter table public.invitations alter column role drop default;
alter table public.invitations alter column role type text using role::text;
alter table public.invitations alter column role set default 'member';
alter table public.invitations
  add constraint invitations_role_fkey foreign key (role) references public.roles(key) on update cascade;

create index memberships_role_idx on public.memberships (role);

-- app.member_role() returned the enum; CREATE OR REPLACE cannot change a
-- return type. The helpers that call it (is_admin, is_owner, can_write) are
-- SQL functions with string bodies, which resolve it at call time.
drop function app.member_role(uuid);
create function app.member_role(p_org uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select role from public.memberships
  where org_id = p_org and user_id = auth.uid();
$$;

drop type member_role;

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Resources and the matrix
-- ═════════════════════════════════════════════════════════════════════════════

create table public.permission_resources (
  key         text primary key check (key ~ '^[a-z][a-z0-9_]{1,62}$'),
  label       text not null,
  category    text not null,
  description text,
  -- Which verbs this resource has at all. A verb missing here has no policy
  -- (and usually no grant) behind it, so it is not offered as a toggle and a
  -- matrix row may not set it — see app.check_permission_flags().
  actions     text[] not null
              check (cardinality(actions) > 0
                     and actions <@ array['view','create','edit','delete']::text[]),
  sort_order  integer not null
);
comment on table public.permission_resources is
  'What role_permissions can grant. One row per permissioned table or storage bucket.';

create table public.role_permission_defaults (
  role       text not null references public.roles(key) on update cascade on delete cascade,
  resource   text not null references public.permission_resources(key) on update cascade on delete cascade,
  can_view   boolean not null default false,
  can_create boolean not null default false,
  can_edit   boolean not null default false,
  can_delete boolean not null default false,
  primary key (role, resource)
);
comment on table public.role_permission_defaults is
  'The matrix every organization is seeded with. Changing a row here does not touch organizations already seeded.';

create table public.role_permissions (
  org_id     uuid not null references public.organizations(id) on delete cascade,
  role       text not null references public.roles(key) on update cascade on delete cascade,
  resource   text not null references public.permission_resources(key) on update cascade on delete cascade,
  can_view   boolean not null default false,
  can_create boolean not null default false,
  can_edit   boolean not null default false,
  can_delete boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  primary key (org_id, role, resource)
);
comment on table public.role_permissions is
  'Per-organization permission matrix, read by app.has_permission() inside every configurable RLS policy.';

-- The primary key serves the only hot lookup: (org_id, role, resource) from
-- app.has_permission(). No further index is needed.

-- ─── The day-one seed ────────────────────────────────────────────────────────
-- Each line is one resource and, per verb, the roles that hold it. The role
-- sets are the three helpers 0003 used:
--   ALL   = app.is_member   → owner, admin, member, viewer
--   WRITE = app.can_write   → owner, admin, member
--   ADMIN = app.is_admin    → owner, admin
-- and the "0003:NN" notes are the policy each line transcribes.

create temp table _role_sets (k text primary key, roles text[]);
insert into _role_sets values
  ('ALL',   array['owner','admin','member','viewer']),
  ('WRITE', array['owner','admin','member']),
  ('ADMIN', array['owner','admin']),
  ('NONE',  array[]::text[]);

create temp table _perm_spec as
select * from (values
    -- Organization ───────────────────────────────────────────────────────────
    (10,  'organizations',      'Company profile',         'Organization', array['edit'],
          'NONE', 'NONE',  'ADMIN', 'NONE',
          'Company name, address, logo and signatory. Every member can always read the profile of their own organization.'),
          -- 0003 organizations_update: is_admin. Select stays membership-only (0027).
    (20,  'org_settings',       'Org chart',               'Organization', array['view','create','edit','delete'],
          'ALL',  'WRITE', 'WRITE', 'WRITE', 'The team hierarchy canvas.'),
          -- 0003 org_settings_select is_member; org_settings_write FOR ALL can_write
    (30,  'memberships',        'Team access',             'Organization', array['view','create','edit','delete'],
          'ALL',  'ADMIN', 'ADMIN', 'ADMIN',
          'Who has a login to this organization and in which role. Anyone may leave; only an owner or admin may grant or revoke owner or admin.'),
          -- 0003 memberships_*: select is_member; insert/update/delete is_admin (+ self-delete)
    (40,  'invitations',        'Invitations',             'Organization', array['view','create','edit'],
          'ADMIN','ADMIN', 'ADMIN', 'NONE',  'Pending invitations to join.'),
          -- 0003 invitations_*: is_admin; no delete policy
    (50,  'subscriptions',      'Plan',                    'Organization', array['view'],
          'ALL',  'NONE',  'NONE',  'NONE',  'The current plan. Changed only by billing, never from the browser.'),
    (60,  'usage_counters',     'Plan usage',              'Organization', array['view'],
          'ALL',  'NONE',  'NONE',  'NONE',  'Documents and AI messages used against the plan.'),
    (70,  'audit_log',          'Activity log',            'Organization', array['view'],
          'ALL',  'NONE',  'NONE',  'NONE',
          'Who changed what. Pay and organization-level entries stay owner/admin-only regardless.'),
          -- 0021 audit_log_select
    (80,  'ai_company_memory',  'AI company memory',       'Organization', array['view','create','edit','delete'],
          'ALL',  'WRITE', 'WRITE', 'WRITE', 'What the AI co-founder remembers about the company.'),
          -- 0003 ai_memory_select is_member; ai_memory_write FOR ALL can_write
    -- People ─────────────────────────────────────────────────────────────────
    (110, 'departments',        'Departments',             'People', array['view','create','edit','delete'],
          'ALL',  'WRITE', 'WRITE', 'ADMIN', null),
    (120, 'employees',          'Employees',               'People', array['view','create','edit','delete'],
          'ALL',  'WRITE', 'WRITE', 'ADMIN', 'Employee records. Pay is separate and always owner/admin-only.'),
    (130, 'tasks',              'Tasks',                   'People', array['view','create','edit','delete'],
          'ALL',  'WRITE', 'WRITE', 'ADMIN', null),
    -- Clients & sales ────────────────────────────────────────────────────────
    (210, 'clients',            'Clients',                 'Clients & sales', array['view','create','edit','delete'],
          'ALL',  'WRITE', 'WRITE', 'ADMIN', null),                -- 0016
    (220, 'catalog_items',      'Product catalogue',       'Clients & sales', array['view','create','edit','delete'],
          'ALL',  'WRITE', 'WRITE', 'ADMIN', null),                -- 0011
    (230, 'customers',          'Customers (legacy)',      'Clients & sales', array['view','create','edit','delete'],
          'ALL',  'WRITE', 'WRITE', 'ADMIN', 'Superseded by Clients; removed by the pending legacy-table drop.'),
    (240, 'crm_leads',          'CRM leads (legacy)',      'Clients & sales', array['view','create','edit','delete'],
          'ALL',  'WRITE', 'WRITE', 'ADMIN', 'Superseded by Clients; removed by the pending legacy-table drop.'),
    (250, 'products',           'Products (legacy)',       'Clients & sales', array['view','create','edit','delete'],
          'ALL',  'WRITE', 'WRITE', 'ADMIN', 'Superseded by the product catalogue.'),
    -- Documents ──────────────────────────────────────────────────────────────
    (310, 'financial_documents','Invoices, quotes & proformas', 'Documents', array['view','create','edit','delete'],
          'ALL',  'WRITE', 'WRITE', 'ADMIN', null),
    (320, 'document_line_items','Document line items',     'Documents', array['view','create','edit','delete'],
          'ALL',  'WRITE', 'WRITE', 'WRITE', 'Rows on an invoice, quote or proforma.'),
          -- 0003 line_items_write FOR ALL can_write — members CAN delete line items today
    (330, 'recurring_invoices', 'Recurring invoices',      'Documents', array['view','create','edit','delete'],
          'ALL',  'WRITE', 'WRITE', 'ADMIN', null),
    (340, 'records',            'HR documents',            'Documents', array['view','create','edit','delete'],
          'ALL',  'WRITE', 'WRITE', 'ADMIN', 'Offer letters, certificates, NDAs, MoUs and HR notices.'),
    (350, 'document_signatures','Signatures & responses',  'Documents', array['view','create','edit','delete'],
          'ALL',  'WRITE', 'WRITE', 'ADMIN', null),
    (360, 'portal_tokens',      'Portal links',            'Documents', array['view','edit'],
          'ALL',  'NONE',  'WRITE', 'NONE',  'Links sent to recipients. Issued by the server; edit means revoke.'),
          -- 0003 portal_tokens_select is_member; portal_tokens_revoke can_write
    (370, 'document_counters',  'Document numbering',      'Documents', array['view'],
          'ALL',  'NONE',  'NONE',  'NONE',  null),
    -- Finance ────────────────────────────────────────────────────────────────
    (410, 'payments',           'Payments',                'Finance', array['view','create','edit','delete'],
          'ALL',  'WRITE', 'ADMIN', 'ADMIN', 'Recording a payment is routine; confirming or reversing one is not.'),
          -- 0003 payments_*: insert can_write; update/delete is_admin
    (420, 'expenses',           'Expenses',                'Finance', array['view','create','edit','delete'],
          'ALL',  'WRITE', 'WRITE', 'ADMIN', null),
    -- Notifications ──────────────────────────────────────────────────────────
    (510, 'notifications',      'Notifications',           'Notifications', array['view','create','edit','delete'],
          'ALL',  'WRITE', 'WRITE', 'ADMIN', null),
    -- Files (storage buckets) ────────────────────────────────────────────────
    (610, 'storage_branding',   'Logo & stamp files',      'Files', array['create','edit','delete'],
          'NONE', 'WRITE', 'WRITE', 'ADMIN', 'Public bucket: reading is open to anyone with the link, so there is no view toggle.'),
          -- 0004 branding_*
    (620, 'storage_signatures', 'Signature files',         'Files', array['view','create','edit','delete'],
          'ALL',  'WRITE', 'WRITE', 'ADMIN', null),                -- 0004 signatures_*
    (630, 'storage_documents',  'Generated PDFs',          'Files', array['view','create','delete'],
          'ALL',  'WRITE', 'NONE',  'ADMIN', null)                 -- 0004 documents_* (no update policy)
) spec(sort_order, key, label, category, actions, v, c, e, d, description);

insert into public.permission_resources (key, label, category, description, actions, sort_order)
select key, label, category, description, actions, sort_order from _perm_spec;

insert into public.role_permission_defaults (role, resource, can_view, can_create, can_edit, can_delete)
select ro.key, s.key,
       exists (select 1 from _role_sets rs where rs.k = s.v and ro.key = any(rs.roles)),
       exists (select 1 from _role_sets rs where rs.k = s.c and ro.key = any(rs.roles)),
       exists (select 1 from _role_sets rs where rs.k = s.e and ro.key = any(rs.roles)),
       exists (select 1 from _role_sets rs where rs.k = s.d and ro.key = any(rs.roles))
  from _perm_spec s
  cross join public.roles ro;

drop table _perm_spec;
drop table _role_sets;

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Integrity of the matrix
-- ═════════════════════════════════════════════════════════════════════════════

-- Client-only triggers. Some rules below apply to statements a client issues
-- directly, and not to the trusted server-side paths — create_organization()
-- and accept_invitation() are SECURITY DEFINER and have already decided who may
-- do what; the service role is the server itself.
--
-- The distinction is made in each trigger's WHEN clause:
--     when (current_user in ('authenticated', 'anon'))
-- WHEN is evaluated by the executor of the triggering statement, so inside a
-- SECURITY DEFINER function current_user is the function's owner and the
-- trigger does not fire. The trigger functions themselves are then SECURITY
-- DEFINER: a client statement that fires them runs as `authenticated`, which
-- has no USAGE on schema app (0002) and so could not call app.is_admin().

-- Applies to defaults and to every organization's matrix, from any writer.
create or replace function app.check_permission_flags()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare v_actions text[];
begin
  select actions into v_actions from public.permission_resources where key = new.resource;

  -- A flag for a verb the resource does not have would be a toggle that does
  -- nothing — or, worse, one that starts doing something the day someone adds
  -- a policy for that verb without deciding who should hold it.
  if (new.can_view   and not 'view'   = any(v_actions))
  or (new.can_create and not 'create' = any(v_actions))
  or (new.can_edit   and not 'edit'   = any(v_actions))
  or (new.can_delete and not 'delete' = any(v_actions)) then
    raise exception '% has no such action (it supports: %)', new.resource, array_to_string(v_actions, ', ')
      using errcode = 'check_violation';
  end if;

  -- Writing something you cannot see is not a coherent grant, and UPDATE and
  -- DELETE need a visible row to act on anyway.
  if 'view' = any(v_actions) and not new.can_view
     and (new.can_create or new.can_edit or new.can_delete) then
    raise exception 'role % cannot create, edit or delete % without viewing it', new.role, new.resource
      using errcode = 'check_violation';
  end if;

  -- The owner role always holds every action there is.
  if new.role = 'owner' and (
       ('view'   = any(v_actions) and not new.can_view)
    or ('create' = any(v_actions) and not new.can_create)
    or ('edit'   = any(v_actions) and not new.can_edit)
    or ('delete' = any(v_actions) and not new.can_delete)) then
    raise exception 'the owner role always holds every permission' using errcode = 'check_violation';
  end if;

  return new;
end $$;

create trigger role_permission_defaults_check
  before insert or update on public.role_permission_defaults
  for each row execute function app.check_permission_flags();

create trigger role_permissions_check
  before insert or update on public.role_permissions
  for each row execute function app.check_permission_flags();

-- Validate the seed above against the same rules, now that the trigger exists.
update public.role_permission_defaults set can_view = can_view;

-- Client-side edits (the Settings grid). Who may edit at all is the RLS policy
-- below; this adds the two rules a policy cannot express cleanly.
create or replace function app.role_permissions_client_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.role = 'owner' then
    raise exception 'the owner role''s permissions are fixed' using errcode = 'insufficient_privilege';
  end if;

  -- An admin may shape every other role, but not their own: otherwise the
  -- admin row is a role editing itself.
  if old.role = 'admin' and not app.is_owner(old.org_id) then
    raise exception 'only an owner can change what admins may do' using errcode = 'insufficient_privilege';
  end if;

  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;

create trigger role_permissions_client_guard
  before update on public.role_permissions
  for each row
  when (current_user in ('authenticated', 'anon'))
  execute function app.role_permissions_client_guard();

-- A permission change is exactly the kind of edit the activity log exists for.
-- app.write_audit() (0020) would record only the flipped flag, not which role
-- and resource it belongs to, so this table gets its own writer.
create or replace function app.audit_role_permissions()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if (old.can_view, old.can_create, old.can_edit, old.can_delete)
     is not distinct from (new.can_view, new.can_create, new.can_edit, new.can_delete) then
    return null;
  end if;
  insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, diff)
  values (new.org_id, auth.uid(), 'role_permissions.update', 'role_permissions', null,
          jsonb_build_object(
            'role', new.role, 'resource', new.resource,
            'from', jsonb_build_object('view', old.can_view, 'create', old.can_create,
                                       'edit', old.can_edit, 'delete', old.can_delete),
            'to',   jsonb_build_object('view', new.can_view, 'create', new.can_create,
                                       'edit', new.can_edit, 'delete', new.can_delete)));
  return null;
end $$;

create trigger role_permissions_audit
  after update on public.role_permissions
  for each row execute function app.audit_role_permissions();

-- Role assignments are audited the same way everything else is (0020).
create trigger memberships_audit
  after insert or update or delete on public.memberships
  for each row execute function app.write_audit();

create trigger role_permissions_freeze_org before update on public.role_permissions
  for each row execute function app.freeze_org_id();

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. Seeding organizations
-- ═════════════════════════════════════════════════════════════════════════════

-- Gives every organization a row for every (role, resource) it lacks, from the
-- defaults. Existing rows are never overwritten: an organization's
-- customisations survive a change to the defaults.
--
-- This is also how a future role or resource reaches existing organizations:
-- insert it and its defaults, and the statement trigger below calls this.
create or replace function app.sync_role_permissions(p_org uuid default null)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  insert into public.role_permissions (org_id, role, resource, can_view, can_create, can_edit, can_delete)
  select o.id, d.role, d.resource, d.can_view, d.can_create, d.can_edit, d.can_delete
    from public.organizations o
    cross join public.role_permission_defaults d
   where p_org is null or o.id = p_org
  on conflict (org_id, role, resource) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function app.seed_org_permissions()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.sync_role_permissions(new.id);
  return null;
end $$;

-- Every path that creates an organization — create_organization(), the ETL,
-- /api/admin — inserts into organizations, so this covers all of them. Without
-- it a new organization's members would hold no permission at all: the model
-- fails closed, but it would fail closed on every signup.
create trigger organizations_seed_permissions
  after insert on public.organizations
  for each row execute function app.seed_org_permissions();

create or replace function app.propagate_permission_defaults()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.sync_role_permissions(null);
  return null;
end $$;

create trigger role_permission_defaults_propagate
  after insert on public.role_permission_defaults
  for each statement execute function app.propagate_permission_defaults();

-- Existing organizations.
select app.sync_role_permissions(null);

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. The check every configurable policy calls
-- ═════════════════════════════════════════════════════════════════════════════

-- True iff the caller is a member of p_org AND their role there holds
-- p_action on p_resource. Membership is the join, so the tenant boundary is
-- part of the permission check itself: a row in org B can never be authorised
-- by a permission row of org A, whatever either matrix says.
--
-- Fails closed on every unknown: no membership, no matrix row, an unknown
-- resource, or an action other than the four → false.
--
-- SECURITY DEFINER for the same reason as app.is_member (0002): it reads
-- memberships and role_permissions, both under RLS, from inside RLS.
create or replace function app.has_permission(p_org uuid, p_resource text, p_action text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select case p_action
             when 'view'   then rp.can_view
             when 'create' then rp.can_create
             when 'edit'   then rp.can_edit
             when 'delete' then rp.can_delete
           end
      from public.memberships m
      join public.role_permissions rp
        on rp.org_id = m.org_id and rp.role = m.role and rp.resource = p_resource
     where m.org_id = p_org
       and m.user_id = auth.uid()
  ), false);
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- 6. RLS and grants on the new tables
-- ═════════════════════════════════════════════════════════════════════════════

alter table public.roles                    enable row level security;
alter table public.roles                    force  row level security;
alter table public.permission_resources     enable row level security;
alter table public.permission_resources     force  row level security;
alter table public.role_permission_defaults enable row level security;
alter table public.role_permission_defaults force  row level security;
alter table public.role_permissions         enable row level security;
alter table public.role_permissions         force  row level security;

-- The three catalogues are reference data, like country_codes (0012): readable
-- by any signed-in user, writable only by migrations and the service role.
create policy roles_select on public.roles
  for select to authenticated using (true);
create policy permission_resources_select on public.permission_resources
  for select to authenticated using (true);
create policy role_permission_defaults_select on public.role_permission_defaults
  for select to authenticated using (true);

revoke all on public.roles, public.permission_resources, public.role_permission_defaults from anon;
revoke insert, update, delete on public.roles, public.permission_resources, public.role_permission_defaults
  from authenticated;
grant select on public.roles, public.permission_resources, public.role_permission_defaults to authenticated;

-- role_permissions. These two policies are among the few in the schema that do
-- NOT read the matrix, and that is the point:
--
--   read   any member. The app needs the caller's own permissions to decide what
--          to show, and the matrix says what a role may do, not anything about
--          the organization's data.
--   edit   owner or admin, hardcoded. If editing the matrix were itself a
--          toggle, any role granted it could grant itself everything else.
create policy role_permissions_select on public.role_permissions
  for select to authenticated using (app.is_member(org_id));
create policy role_permissions_update on public.role_permissions
  for update to authenticated
  using (app.is_admin(org_id)) with check (app.is_admin(org_id));

-- No INSERT or DELETE from clients: rows are created by seeding and exist for
-- every (role, resource), so "no access" is a row of falses, never a missing
-- row. Column-level UPDATE, so org_id / role / resource cannot be rewritten.
revoke all on public.role_permissions from anon;
revoke insert, update, delete on public.role_permissions from authenticated;
grant select on public.role_permissions to authenticated;
grant update (can_view, can_create, can_edit, can_delete) on public.role_permissions to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- 7. The member list the Settings screen and employee profile need
-- ═════════════════════════════════════════════════════════════════════════════

-- auth.users is not readable from the browser, so without this a role could be
-- assigned only by user id. Returns the organization's members with their sign-in
-- email, to callers allowed to see team access; everyone else gets their own
-- row only.
create or replace function public.org_members(p_org uuid)
returns table (membership_id uuid, user_id uuid, email text, role text, created_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select m.id, m.user_id, u.email::text, m.role, m.created_at
    from public.memberships m
    join auth.users u on u.id = m.user_id
   where m.org_id = p_org
     and app.is_member(p_org)
     and (app.has_permission(p_org, 'memberships', 'view') or m.user_id = auth.uid())
   order by m.created_at;
$$;

revoke execute on function public.org_members(uuid) from public, anon;
grant  execute on function public.org_members(uuid) to authenticated, service_role;

-- Internal helpers: not callable through PostgREST (schema app is not exposed),
-- and the seeding functions are for migrations and the service role only.
revoke execute on function app.sync_role_permissions(uuid) from public;
grant  execute on function app.sync_role_permissions(uuid) to service_role;


-- ############################################################################
-- ## 0027_rls_from_permissions.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0027 — every configurable policy reads role_permissions
-- Phase 2 · steps 2 and 3
--
-- Replaces every app.is_member / app.can_write / app.is_admin role check in the
-- RLS policies of 0003, 0004, 0011, 0016 and 0021 with
--
--     app.has_permission(org_id, '<resource>', 'view'|'create'|'edit'|'delete')
--
-- reading the per-organization matrix 0026 introduced and seeded. With the
-- seeded defaults the effective access is unchanged: tests/02_access_matrix.sql
-- must produce tests/expected/day_one_access.out, which was captured before
-- 0026, line for line.
--
-- Done now, while there are thirty tables, rather than after phases 3–6 add
-- more — and app.secure_tenant_table() below is how those phases' tables get
-- the same treatment in one call.
--
-- ─── What stays hardcoded, and why ──────────────────────────────────────────
-- These are the guards that must never become a toggle. Each is enforced
-- somewhere a permission row cannot reach:
--
--   last owner          app.protect_last_owner (0002), a trigger on
--                       memberships. Untouched here. No permission, including
--                       the owner's own, can remove or demote the last owner.
--   owner/admin grants  app.guard_privileged_roles (below). Granting, changing
--                       or revoking the owner or admin role — on memberships
--                       or through an invitation — requires being an owner or
--                       admin, whatever the matrix says about memberships.
--                       Without this, handing a role "edit team access" would
--                       hand it the owner role.
--   compensation,       employee_compensation_* and org_banking_* keep their
--   banking             0003 app.is_admin policies, untouched; neither table is
--                       a permission_resource, so no row can name it. The
--                       audit trail of pay stays admin-only the same way.
--   secrets             org_secrets (and email_events, legacy_id_map) keep RLS
--                       forced with NO policy. Asserted at the end of this file.
--   plan                subscriptions has no INSERT/UPDATE/DELETE grant for
--                       authenticated (0003:207) and no write policy; its
--                       resource offers only "view". A toggle cannot create a
--                       grant.
--   matrix editing      role_permissions update is app.is_admin (0026).
--   tenancy             organizations_select stays app.is_member: you can
--                       always see the organization you belong to. Your own
--                       membership row is always visible to you.
-- ─────────────────────────────────────────────────────────────────────────────

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. The helper new tables use
-- ═════════════════════════════════════════════════════════════════════════════

-- Enables and forces RLS on a tenant table, revokes anon, drops its existing
-- policies (except the platform-admin read), and creates one policy per action
-- the resource supports, each reading the permission matrix.
--
-- Phases 3–6: add the resource and its defaults to permission_resources /
-- role_permission_defaults in the table's creation migration (existing orgs are
-- seeded automatically by the 0026 statement trigger), then call this. Grants
-- stay a separate, explicit decision, as 0022 requires.
create or replace function app.secure_tenant_table(p_table regclass, p_resource text)
returns void language plpgsql set search_path = public, pg_temp as $$
declare
  v_schema  text;
  v_name    text;
  v_actions text[];
  v_pol     text;
begin
  select n.nspname, c.relname into v_schema, v_name
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.oid = p_table;

  select actions into v_actions from public.permission_resources where key = p_resource;
  if v_actions is null then
    raise exception 'no permission resource %; add it to permission_resources first', p_resource;
  end if;

  if not exists (select 1 from information_schema.columns
                  where table_schema = v_schema and table_name = v_name and column_name = 'org_id') then
    raise exception '%.% has no org_id column', v_schema, v_name;
  end if;

  execute format('alter table %s enable row level security', p_table);
  execute format('alter table %s force row level security', p_table);
  execute format('revoke all on %s from anon', p_table);

  for v_pol in
    select policyname from pg_policies
     where schemaname = v_schema and tablename = v_name
       and policyname not like '%\_platform\_admin\_select'
  loop
    execute format('drop policy %I on %s', v_pol, p_table);
  end loop;

  if 'view' = any(v_actions) then
    execute format(
      'create policy %I on %s for select to authenticated
         using (app.has_permission(org_id, %L, ''view''))',
      v_name || '_select', p_table, p_resource);
  end if;
  if 'create' = any(v_actions) then
    execute format(
      'create policy %I on %s for insert to authenticated
         with check (app.has_permission(org_id, %L, ''create''))',
      v_name || '_insert', p_table, p_resource);
  end if;
  if 'edit' = any(v_actions) then
    execute format(
      'create policy %I on %s for update to authenticated
         using      (app.has_permission(org_id, %L, ''edit''))
         with check (app.has_permission(org_id, %L, ''edit''))',
      v_name || '_update', p_table, p_resource, p_resource);
  end if;
  if 'delete' = any(v_actions) then
    execute format(
      'create policy %I on %s for delete to authenticated
         using (app.has_permission(org_id, %L, ''delete''))',
      v_name || '_delete', p_table, p_resource);
  end if;
end $$;

revoke execute on function app.secure_tenant_table(regclass, text) from public;

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Tenant tables whose policies are exactly "the matrix"
-- ═════════════════════════════════════════════════════════════════════════════
-- Includes the three 0003 FOR ALL policies (org_settings_write,
-- line_items_write, ai_memory_write), now split per verb. Their defaults keep
-- the delete that FOR ALL implied.

select app.secure_tenant_table(t::regclass, r)
  from (values
    ('public.departments',         'departments'),
    ('public.employees',           'employees'),
    ('public.tasks',               'tasks'),
    ('public.customers',           'customers'),
    ('public.crm_leads',           'crm_leads'),
    ('public.products',            'products'),
    ('public.clients',             'clients'),
    ('public.catalog_items',       'catalog_items'),
    ('public.expenses',            'expenses'),
    ('public.records',             'records'),
    ('public.financial_documents', 'financial_documents'),
    ('public.document_line_items', 'document_line_items'),
    ('public.recurring_invoices',  'recurring_invoices'),
    ('public.document_signatures', 'document_signatures'),
    ('public.payments',            'payments'),
    ('public.portal_tokens',       'portal_tokens'),
    ('public.notifications',       'notifications'),
    ('public.org_settings',        'org_settings'),
    ('public.ai_company_memory',   'ai_company_memory'),
    ('public.subscriptions',       'subscriptions'),
    ('public.usage_counters',      'usage_counters'),
    ('public.document_counters',   'document_counters')
  ) v(t, r);

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Tables with rules beyond the matrix
-- ═════════════════════════════════════════════════════════════════════════════

-- ─── organizations ───────────────────────────────────────────────────────────
-- organizations_select (0003) is a tenancy check, not a role check, and is left
-- as it is. Creation is create_organization(); deletion is a soft delete by the
-- admin endpoint; neither has a grant.
drop policy organizations_update on public.organizations;
create policy organizations_update on public.organizations for update to authenticated
  using      (app.has_permission(id, 'organizations', 'edit'))
  with check (app.has_permission(id, 'organizations', 'edit'));

-- ─── memberships ─────────────────────────────────────────────────────────────
drop policy memberships_select on public.memberships;
drop policy memberships_insert on public.memberships;
drop policy memberships_update on public.memberships;
drop policy memberships_delete on public.memberships;

-- Your own membership is always visible to you: the app decides whether you
-- belong to any organization at all by reading it (AuthContext.jsx), so hiding
-- it would route a member to onboarding.
create policy memberships_select on public.memberships for select to authenticated
  using (user_id = auth.uid() or app.has_permission(org_id, 'memberships', 'view'));
create policy memberships_insert on public.memberships for insert to authenticated
  with check (app.has_permission(org_id, 'memberships', 'create'));
create policy memberships_update on public.memberships for update to authenticated
  using      (app.has_permission(org_id, 'memberships', 'edit'))
  with check (app.has_permission(org_id, 'memberships', 'edit'));
-- Anyone may leave (0003). app.protect_last_owner still stops the last owner.
create policy memberships_delete on public.memberships for delete to authenticated
  using (app.has_permission(org_id, 'memberships', 'delete') or user_id = auth.uid());

-- ─── invitations ─────────────────────────────────────────────────────────────
drop policy invitations_select on public.invitations;
drop policy invitations_insert on public.invitations;
drop policy invitations_update on public.invitations;
create policy invitations_select on public.invitations for select to authenticated
  using (app.has_permission(org_id, 'invitations', 'view'));
create policy invitations_insert on public.invitations for insert to authenticated
  with check (app.has_permission(org_id, 'invitations', 'create'));
create policy invitations_update on public.invitations for update to authenticated
  using      (app.has_permission(org_id, 'invitations', 'edit'))
  with check (app.has_permission(org_id, 'invitations', 'edit'));

-- ─── The owner and admin roles are granted only by an owner or admin ─────────
-- NON-NEGOTIABLE. Applies to client statements only (the WHEN clause — see
-- 0026 §3 for why it is there and not in the body): create_organization() and
-- accept_invitation() are SECURITY DEFINER and have already checked who may do
-- what; accept_invitation grants exactly the role an admin invited with.
create or replace function app.guard_privileged_roles()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_org uuid := coalesce(new.org_id, old.org_id);
begin
  if (   (tg_op in ('UPDATE', 'DELETE') and old.role in ('owner', 'admin'))
      or (tg_op in ('INSERT', 'UPDATE') and new.role in ('owner', 'admin')))
     and not app.is_admin(v_org)
  then
    raise exception 'only an owner or admin can grant, change or revoke the owner or admin role'
      using errcode = 'insufficient_privilege';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

create trigger memberships_guard_privileged_roles
  before insert or update or delete on public.memberships
  for each row
  when (current_user in ('authenticated', 'anon'))
  execute function app.guard_privileged_roles();

create trigger invitations_guard_privileged_roles
  before insert or update on public.invitations
  for each row
  when (current_user in ('authenticated', 'anon'))
  execute function app.guard_privileged_roles();

-- ─── audit_log ───────────────────────────────────────────────────────────────
-- Viewing the log is configurable. What the log may show a non-admin is not:
-- pay and organization-level entries stay owner/admin-only (0021), because the
-- diff would reveal exactly what employee_compensation's own policy withholds.
drop policy audit_log_select on public.audit_log;
create policy audit_log_select on public.audit_log for select to authenticated
  using (
    app.has_permission(org_id, 'audit_log', 'view')
    and (
      app.is_admin(org_id)
      or (entity_type is not null
          and not (entity_type = any(app.audit_admin_only_entities())))
    )
  );

-- ─── storage.objects (0004) ──────────────────────────────────────────────────
drop policy branding_insert   on storage.objects;
drop policy branding_update   on storage.objects;
drop policy branding_delete   on storage.objects;
drop policy signatures_select on storage.objects;
drop policy signatures_insert on storage.objects;
drop policy signatures_update on storage.objects;
drop policy signatures_delete on storage.objects;
drop policy documents_select  on storage.objects;
drop policy documents_insert  on storage.objects;
drop policy documents_delete  on storage.objects;

-- org-branding is a public bucket read through the CDN, so it has no select policy.
create policy branding_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'org-branding'
              and app.has_permission(app.storage_org(name), 'storage_branding', 'create'));
create policy branding_update on storage.objects for update to authenticated
  using      (bucket_id = 'org-branding'
              and app.has_permission(app.storage_org(name), 'storage_branding', 'edit'))
  with check (bucket_id = 'org-branding'
              and app.has_permission(app.storage_org(name), 'storage_branding', 'edit'));
create policy branding_delete on storage.objects for delete to authenticated
  using (bucket_id = 'org-branding'
         and app.has_permission(app.storage_org(name), 'storage_branding', 'delete'));

create policy signatures_select on storage.objects for select to authenticated
  using (bucket_id = 'signatures'
         and app.has_permission(app.storage_org(name), 'storage_signatures', 'view'));
create policy signatures_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'signatures'
              and app.has_permission(app.storage_org(name), 'storage_signatures', 'create'));
create policy signatures_update on storage.objects for update to authenticated
  using      (bucket_id = 'signatures'
              and app.has_permission(app.storage_org(name), 'storage_signatures', 'edit'))
  with check (bucket_id = 'signatures'
              and app.has_permission(app.storage_org(name), 'storage_signatures', 'edit'));
create policy signatures_delete on storage.objects for delete to authenticated
  using (bucket_id = 'signatures'
         and app.has_permission(app.storage_org(name), 'storage_signatures', 'delete'));

create policy documents_select on storage.objects for select to authenticated
  using (bucket_id = 'documents'
         and app.has_permission(app.storage_org(name), 'storage_documents', 'view'));
create policy documents_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'documents'
              and app.has_permission(app.storage_org(name), 'storage_documents', 'create'));
create policy documents_delete on storage.objects for delete to authenticated
  using (bucket_id = 'documents'
         and app.has_permission(app.storage_org(name), 'storage_documents', 'delete'));

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. Retire the write helper
-- ═════════════════════════════════════════════════════════════════════════════
-- Postgres records which functions a policy expression calls, so this DROP
-- fails if any policy anywhere still uses app.can_write — it is the check that
-- the rewrite above left nothing behind. is_member / is_admin / is_owner stay:
-- the tenancy and non-negotiable guards above use them, and
-- tests/04_role_smoke_test.sql pins exactly which policies may.
drop function app.can_write(uuid);

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. Self-checks. A violation aborts the migration.
-- ═════════════════════════════════════════════════════════════════════════════
do $$
declare v text;
begin
  -- Secrets, the email log and ETL bookkeeping: RLS forced, no policy at all.
  select string_agg(tablename || '.' || policyname, ', ') into v
    from pg_policies
   where schemaname = 'public' and tablename in ('org_secrets', 'email_events', 'legacy_id_map');
  if v is not null then
    raise exception '0027: server-only tables must have no policy, found: %', v;
  end if;

  -- Every public table has RLS enabled AND forced.
  select string_agg(c.relname, ', ') into v
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and not (c.relrowsecurity and c.relforcerowsecurity);
  if v is not null then
    raise exception '0027: tables without forced RLS: %', v;
  end if;

  -- Compensation and banking: owner/admin only, never the matrix.
  select string_agg(policyname, ', ') into v
    from pg_policies
   where schemaname = 'public' and tablename in ('employee_compensation', 'org_banking')
     and (coalesce(qual, '') not like '%app.is_admin(org_id)%'
          or coalesce(qual, '') || coalesce(with_check, '') like '%has_permission%');
  if v is not null then
    raise exception '0027: compensation/banking policies must be app.is_admin only: %', v;
  end if;

  -- No permission resource may name a table that must stay out of the matrix.
  select string_agg(key, ', ') into v
    from public.permission_resources
   where key in ('employee_compensation', 'org_banking', 'org_secrets',
                 'email_events', 'legacy_id_map', 'role_permissions');
  if v is not null then
    raise exception '0027: these must never be permission resources: %', v;
  end if;

  -- Subscriptions can only ever be viewed.
  if (select actions from public.permission_resources where key = 'subscriptions') <> array['view'] then
    raise exception '0027: subscriptions must be view-only';
  end if;
end $$;


-- ############################################################################
-- ## 0028_vendors_payables_receipts.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0028 — vendors, purchase (payable) invoices, expense receipts
--
-- Money out becomes a record rather than only an expense line:
--   vendors            the supplier directory (company, contact, terms, GSTIN)
--   purchase_invoices  bills received from vendors; input GST lives here, which
--                      is what the Tax Summary nets against output GST
--   expenses           gain a receipt_path, an optional input-GST amount and an
--                      optional vendor
--   receipts bucket    private, 5 MB ceiling, images and PDFs only
--
-- Both new tables go through app.secure_tenant_table (0027), so their policies
-- read the role_permissions matrix like every other tenant table.
-- ─────────────────────────────────────────────────────────────────────────────

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Tables
-- ═════════════════════════════════════════════════════════════════════════════

create table public.vendors (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organizations(id) on delete cascade,
  company_name       text not null check (length(btrim(company_name)) > 0),
  contact_name       text,
  email              citext,
  phone              text,
  address            text,
  state              text,
  gstin              text check (gstin is null or gstin ~ '^[0-9A-Z]{15}$'),
  -- Net days. 0 means due on receipt.
  payment_terms_days integer not null default 30 check (payment_terms_days between 0 and 365),
  category           text,
  notes              text,
  archived_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index vendors_org_name_idx on public.vendors (org_id, company_name);

create table public.purchase_invoices (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id) on delete cascade,
  -- RESTRICT, not SET NULL: a payable with no vendor is not a payable. Vendors
  -- with history are archived instead of deleted.
  vendor_id    uuid not null references public.vendors(id) on delete restrict,
  bill_number  text not null check (length(btrim(bill_number)) > 0),
  bill_date    date not null default current_date,
  due_date     date,
  category     text not null default 'Operations',
  description  text,
  subtotal     numeric(14,2) not null default 0 check (subtotal >= 0),
  tax_rate     numeric(5,2)  not null default 18 check (tax_rate between 0 and 100),
  tax_amount   numeric(14,2) not null default 0 check (tax_amount >= 0),  -- input GST
  total        numeric(14,2) not null default 0 check (total >= 0),
  amount_paid  numeric(14,2) not null default 0 check (amount_paid >= 0),
  status       text not null default 'unpaid'
               check (status in ('unpaid', 'partially_paid', 'paid', 'void')),
  paid_on      date,
  receipt_path text,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint purchase_paid_lte_total check (amount_paid <= total + 0.01),
  unique (org_id, vendor_id, bill_number)
);
create index purchase_invoices_org_date_idx on public.purchase_invoices (org_id, bill_date desc);
create index purchase_invoices_vendor_idx   on public.purchase_invoices (vendor_id);

-- A purchase invoice's vendor must belong to the same org — the FK alone would
-- let a client point a bill at another tenant's vendor id. Totals and status
-- are derived here so the ledger cannot disagree with itself.
create or replace function app.purchase_invoice_guard()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from public.vendors v
                  where v.id = new.vendor_id and v.org_id = new.org_id) then
    raise exception 'vendor % does not belong to this organization', new.vendor_id
      using errcode = '23503';
  end if;

  new.tax_amount := round(new.subtotal * new.tax_rate / 100, 2);
  new.total      := new.subtotal + new.tax_amount;
  if new.status <> 'void' then
    new.status := case
      when new.total > 0 and new.amount_paid >= new.total - 0.01 then 'paid'
      when new.amount_paid > 0 then 'partially_paid'
      else 'unpaid' end;
  end if;
  if new.status = 'paid' and new.paid_on is null then new.paid_on := current_date; end if;
  if new.status <> 'paid' then new.paid_on := null; end if;
  new.updated_at := now();
  return new;
end $$;

create trigger purchase_invoices_guard
  before insert or update on public.purchase_invoices
  for each row execute function app.purchase_invoice_guard();

create or replace function app.touch_updated_at()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger vendors_touch
  before update on public.vendors
  for each row execute function app.touch_updated_at();

alter table public.expenses
  add column if not exists receipt_path text,
  add column if not exists tax_amount   numeric(14,2) not null default 0 check (tax_amount >= 0),
  add column if not exists vendor_id    uuid references public.vendors(id) on delete set null;

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Permissions
-- ═════════════════════════════════════════════════════════════════════════════

insert into public.permission_resources (key, label, category, description, actions, sort_order) values
  ('vendors',           'Vendors',           'Finance', 'Supplier directory.',                        array['view','create','edit','delete'], 430),
  ('purchase_invoices', 'Purchase invoices', 'Finance', 'Bills received from vendors (payables).',    array['view','create','edit','delete'], 440),
  ('storage_receipts',  'Receipt files',     'Files',   'Expense and bill receipts. Private bucket.', array['view','create','delete'],        640);

-- Same shape as expenses: everyone reads, members write, admins delete.
-- The statement trigger from 0026 copies these into every existing org.
insert into public.role_permission_defaults (role, resource, can_view, can_create, can_edit, can_delete)
select r.key, s.resource,
       true,
       r.key in ('owner','admin','member'),
       s.editable and r.key in ('owner','admin','member'),
       r.key in ('owner','admin')
  from public.roles r
 cross join (values ('vendors', true), ('purchase_invoices', true), ('storage_receipts', false))
       s(resource, editable)
 where r.key in ('owner','admin','member','viewer');

select app.secure_tenant_table('public.vendors'::regclass,           'vendors');
select app.secure_tenant_table('public.purchase_invoices'::regclass, 'purchase_invoices');

grant select, insert, update, delete on public.vendors, public.purchase_invoices to authenticated;
grant all on public.vendors, public.purchase_invoices to service_role;

-- Audited, as 0020 does for the other finance tables.
create trigger vendors_audit after insert or update or delete on public.vendors
  for each row execute function app.write_audit();
create trigger purchase_invoices_audit after insert or update or delete on public.purchase_invoices
  for each row execute function app.write_audit();

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Receipts bucket — private, 5 MB ceiling
-- ═════════════════════════════════════════════════════════════════════════════
-- Object names are '<org_id>/<kind>/<uuid>.<ext>', the layout app.storage_org()
-- reads the tenant from. Reads go through short-lived signed URLs only.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 5242880,
        array['image/png','image/jpeg','image/webp','application/pdf'])
on conflict (id) do update
  set public             = false,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy receipts_select on storage.objects for select to authenticated
  using (bucket_id = 'receipts'
         and app.has_permission(app.storage_org(name), 'storage_receipts', 'view'));
create policy receipts_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts'
              and app.has_permission(app.storage_org(name), 'storage_receipts', 'create'));
create policy receipts_delete on storage.objects for delete to authenticated
  using (bucket_id = 'receipts'
         and app.has_permission(app.storage_org(name), 'storage_receipts', 'delete'));


-- ############################################################################
-- ## 0029_people_ops.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0029 — people operations: attendance, leave, announcements, photos, and the
--        exit that actually revokes access.
-- Phase 5
--
-- Until now an "employee" was a row in `employees` and nothing more: no login,
-- no way to tell the system who they were. Everything an employee might do for
-- themselves — clock in, ask for a day off, read a notice — had to be done for
-- them by someone with an admin seat. This file gives the employee an identity:
--
--   employees.user_id        links the record to auth.users
--   the `employee` role      a fifth entry in the role catalogue (0026)
--   app.my_employee_id(org)  "which employee row is the caller?"
--
-- and then four tenant tables they can use through it.
--
-- ─── Why the matrix is not enough on its own ────────────────────────────────
-- app.has_permission(org, resource, action) answers a question about a ROLE in
-- an ORGANIZATION. It cannot express "your own row" — and "every employee may
-- edit attendance" would let any of them rewrite the whole team's sheet. So the
-- `employee` role holds almost nothing in the matrix, and self-service arrives
-- as additive policies (`*_self_*`) gated on app.my_employee_id(). Those
-- policies are written once, here, and are the real boundary; the portal UI in
-- src/components/portal/EmployeePortal.jsx is convenience on top of them.
--
-- Order matters: app.secure_tenant_table() DROPS every existing policy on the
-- table it secures, so the self policies are created after it runs (section 6).
--
-- ─── Re-hire ────────────────────────────────────────────────────────────────
-- Clearing `exited_at` does NOT restore a membership. Access is granted by a
-- `memberships` row, an exit deletes it, and putting it back is a deliberate
-- act: re-invite the person. Anything else would mean un-archiving an employee
-- silently handed back a login.
-- ─────────────────────────────────────────────────────────────────────────────

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Identity: an employee record can be a person who signs in
-- ═════════════════════════════════════════════════════════════════════════════

alter table public.employees
  add column if not exists user_id           uuid references auth.users(id) on delete set null,
  add column if not exists photo_path        text,
  add column if not exists access_revoked_at timestamptz;

comment on column public.employees.user_id is
  'The auth user this record belongs to, when they have a login. Kept after an '
  'exit for the audit trail; the memberships row is what grants access.';

-- One login maps to at most one employee record per organization. Partial, so
-- the many records with no login do not collide on null.
create unique index if not exists employees_user_idx
  on public.employees (org_id, user_id) where user_id is not null;

-- Which employee row is the caller, in this org? Null when they have no record
-- (an owner who never added themselves) or have exited.
--
-- SECURITY DEFINER because it is called from policies on tables the caller may
-- not be able to read `employees` through — and because `employees` itself is
-- force-RLS, so a plain lookup inside a policy would recurse.
create or replace function app.my_employee_id(p_org uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select e.id
    from public.employees e
   where e.org_id = p_org
     and e.user_id = auth.uid()
     and e.exited_at is null
   limit 1;
$$;

-- One level only. A skip-level manager does not inherit their reports' reports:
-- walking the tree would make the visible set depend on how deep the org chart
-- happens to be drawn, which is not an authorization decision anyone made.
create or replace function app.is_manager_of(p_employee uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.employees e
      join public.employees mgr on mgr.id = e.reports_to
     where e.id = p_employee
       and mgr.user_id = auth.uid()
       and mgr.exited_at is null
  );
$$;

revoke execute on function app.my_employee_id(uuid) from public;
revoke execute on function app.is_manager_of(uuid)  from public;
grant  execute on function app.my_employee_id(uuid) to authenticated;
grant  execute on function app.is_manager_of(uuid)  to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. The `employee` role
-- ═════════════════════════════════════════════════════════════════════════════
-- Below `viewer` in the list because it sees less than a viewer does: a viewer
-- reads the whole organization, an employee reads themselves. sort_order is
-- display order and nothing else (0026) — no policy compares ranks.

insert into public.roles (key, label, description, sort_order) values
  ('employee', 'Employee',
   'Self-service only: their own attendance and leave, the team directory and the announcements board.',
   50)
on conflict (key) do nothing;

-- Every resource, explicitly denied, so the Settings grid shows a complete row
-- for the new role rather than blanks that happen to evaluate false. The few
-- grants are listed after; everything not named here stays false.
--
-- `employees` view is the team directory — pay lives in employee_compensation,
-- which is not a permission resource at all (0026) and stays owner/admin-only
-- whatever this row says.
insert into public.role_permission_defaults (role, resource, can_view, can_create, can_edit, can_delete)
select 'employee', r.key,
       'view' = any(r.actions) and r.key in (
         'employees', 'departments', 'org_settings', 'notifications'
       ),
       false, false, false
  from public.permission_resources r
on conflict (role, resource) do nothing;

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Tables
-- ═════════════════════════════════════════════════════════════════════════════

create type attendance_status as enum
  ('present', 'remote', 'half_day', 'leave', 'absent', 'holiday');

create type leave_status as enum
  ('pending', 'approved', 'rejected', 'cancelled');

-- ─── Attendance ──────────────────────────────────────────────────────────────
-- One row per employee per calendar day. The unique constraint is what makes
-- "check in" idempotent: a second tap updates the row it already found.
--
-- `source` records who wrote it. An employee's own policy may only touch a row
-- marked 'self'; once a manager corrects a day it becomes 'admin' and the
-- employee can no longer overwrite the correction.
create table public.attendance_days (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null references public.employees(id)     on delete cascade,
  work_date   date not null,
  check_in    timestamptz,
  check_out   timestamptz,
  status      attendance_status not null default 'present',
  note        text,
  source      text not null default 'self' check (source in ('self', 'admin')),
  marked_by   uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (org_id, employee_id, work_date),
  constraint attendance_times_ordered check (check_out is null or check_in is null or check_out >= check_in)
);
create index attendance_days_org_date_idx on public.attendance_days (org_id, work_date desc);
create index attendance_days_emp_date_idx on public.attendance_days (employee_id, work_date desc);

comment on table public.attendance_days is
  'One row per employee per day. Worked hours are derived from check_in/check_out '
  'at read time — storing a duration would drift the moment a time is corrected.';

-- ─── Leave ───────────────────────────────────────────────────────────────────
create table public.leave_types (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  name         text not null check (length(btrim(name)) between 1 and 60),
  code         text check (code ~ '^[A-Z]{1,6}$'),
  annual_quota numeric(5,1) not null default 0 check (annual_quota >= 0),
  is_paid      boolean not null default true,
  color        text,
  is_active    boolean not null default true,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index leave_types_org_name_idx on public.leave_types (org_id, lower(name));

create table public.leave_requests (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id) on delete cascade,
  employee_id      uuid not null references public.employees(id)     on delete cascade,
  leave_type_id    uuid not null references public.leave_types(id)   on delete restrict,
  start_date       date not null,
  end_date         date not null,
  -- Counted by the client (leaveService.countLeaveDays) and re-checked here:
  -- a half day is 0.5, and a range can never claim more days than it spans.
  days             numeric(4,1) not null check (days > 0),
  half_day         boolean not null default false,
  reason           text,
  status           leave_status not null default 'pending',
  decided_by       uuid references auth.users(id) on delete set null,
  decided_at       timestamptz,
  decision_comment text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint leave_dates_ordered check (end_date >= start_date),
  constraint leave_days_within_range check (days <= (end_date - start_date) + 1)
);
create index leave_requests_org_status_idx on public.leave_requests (org_id, status, start_date desc);
create index leave_requests_emp_idx        on public.leave_requests (employee_id, start_date desc);

-- Carry-forward, encashment, a goodwill day. Kept separate from the request
-- stream so a balance can be adjusted without inventing a fake approved leave.
create table public.leave_adjustments (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  employee_id   uuid not null references public.employees(id)     on delete cascade,
  leave_type_id uuid not null references public.leave_types(id)   on delete cascade,
  year          integer not null check (year between 2000 and 2200),
  delta         numeric(5,1) not null,
  note          text,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index leave_adjustments_emp_idx on public.leave_adjustments (employee_id, year);

-- ─── Announcements ───────────────────────────────────────────────────────────
-- department_id null means the whole organization.
create table public.announcements (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  title         text not null check (length(btrim(title)) between 1 and 200),
  body          text not null check (length(btrim(body)) > 0),
  department_id uuid references public.departments(id) on delete cascade,
  is_pinned     boolean not null default false,
  published_at  timestamptz not null default now(),
  expires_at    timestamptz,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index announcements_org_idx on public.announcements (org_id, published_at desc);

-- Per-user read state, exactly as notification_reads (0001) does it: one person
-- reading a notice must not mark it read for everyone.
create table public.announcement_reads (
  announcement_id uuid not null references public.announcements(id) on delete cascade,
  user_id         uuid not null references auth.users(id)           on delete cascade,
  read_at         timestamptz not null default now(),
  primary key (announcement_id, user_id)
);

-- ─── updated_at / org_id freeze, as every other tenant table gets (0002) ─────
do $$
declare t text;
begin
  foreach t in array array['attendance_days','leave_types','leave_requests','announcements'] loop
    execute format(
      'create trigger %I_touch before update on public.%I
         for each row execute function app.touch_updated_at()', t, t);
  end loop;

  foreach t in array array['attendance_days','leave_types','leave_requests',
                           'leave_adjustments','announcements'] loop
    execute format(
      'create trigger %I_freeze_org before update on public.%I
         for each row execute function app.freeze_org_id()', t, t);
  end loop;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. Leave balances — a view, never a stored number
-- ═════════════════════════════════════════════════════════════════════════════
-- A stored balance drifts the first time a request is edited, rejected after
-- approval, or backdated. This derives it every time from the three things that
-- actually decide it: the quota, the approved days, and manual adjustments.
--
-- A request spanning a year boundary counts against the year it starts in.
create or replace view public.leave_balances_v
with (security_invoker = true) as
select
  lt.org_id,
  e.id                              as employee_id,
  lt.id                             as leave_type_id,
  lt.name                           as leave_type_name,
  y.year,
  lt.annual_quota                   as quota,
  coalesce(taken.days, 0)           as taken,
  coalesce(adj.delta, 0)            as adjusted,
  lt.annual_quota + coalesce(adj.delta, 0) - coalesce(taken.days, 0) as remaining
from public.leave_types lt
join public.employees e
  on e.org_id = lt.org_id and e.exited_at is null
cross join lateral (select extract(year from current_date)::int as year) y
left join lateral (
  select sum(lr.days) as days
    from public.leave_requests lr
   where lr.employee_id = e.id
     and lr.leave_type_id = lt.id
     and lr.status = 'approved'
     and extract(year from lr.start_date)::int = y.year
) taken on true
left join lateral (
  select sum(la.delta) as delta
    from public.leave_adjustments la
   where la.employee_id = e.id
     and la.leave_type_id = lt.id
     and la.year = y.year
) adj on true
where lt.is_active;

comment on view public.leave_balances_v is
  'Derived leave balance for the current year. security_invoker: it shows exactly '
  'what the caller could read from leave_types, leave_requests and leave_adjustments '
  'directly, so an employee sees only their own line.';

-- ─── Default leave types for every organization ──────────────────────────────
create or replace function app.seed_org_leave_types(p_org uuid)
returns void language sql security definer set search_path = public, pg_temp as $$
  insert into public.leave_types (org_id, name, code, annual_quota, is_paid, color, sort_order)
  values (p_org, 'Casual',   'CL', 12, true,  '#3b82f6', 10),
         (p_org, 'Sick',     'SL', 12, true,  '#ef4444', 20),
         (p_org, 'Earned',   'EL', 15, true,  '#10b981', 30),
         (p_org, 'Unpaid',   'LOP', 0, false, '#6b7280', 40)
  on conflict do nothing;
$$;

create or replace function app.seed_leave_types_trigger()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.seed_org_leave_types(new.id);
  return new;
end $$;

create trigger organizations_seed_leave_types
  after insert on public.organizations
  for each row execute function app.seed_leave_types_trigger();

-- Existing organizations get the same starting set.
select app.seed_org_leave_types(id) from public.organizations;

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. Permission resources
-- ═════════════════════════════════════════════════════════════════════════════

insert into public.permission_resources (key, label, category, description, actions, sort_order) values
  ('attendance_days',         'Attendance',        'People',
   'The daily sheet and monthly calendar. Everyone checks themselves in regardless of this row.',
   array['view','create','edit','delete'], 140),
  ('leave_types',             'Leave types',       'People',
   'The leave catalogue and its annual quotas.',
   array['view','create','edit','delete'], 150),
  ('leave_requests',          'Leave requests',    'People',
   'Applying is always allowed for your own leave; `edit` is the right to approve or reject someone else''s.',
   array['view','create','edit','delete'], 160),
  ('leave_adjustments',       'Leave adjustments', 'People',
   'Carry-forward and manual balance corrections.',
   array['view','create','edit','delete'], 170),
  ('announcements',           'Announcements',     'People',
   'Broadcasts to the whole team or one department.',
   array['view','create','edit','delete'], 180),
  ('storage_employee_photos', 'Employee photos',   'Files',
   'Private bucket behind signed URLs. Read by anyone who can see the team.',
   array['view','create','delete'], 650);

-- Defaults for the four original roles. `employee` is handled separately below
-- because its grants are not a variation on "everyone reads, members write".
insert into public.role_permission_defaults (role, resource, can_view, can_create, can_edit, can_delete)
select r.key, s.resource,
       'view'   = any(s.actions),
       'create' = any(s.actions) and r.key = any(s.creators),
       'edit'   = any(s.actions) and r.key = any(s.editors),
       'delete' = any(s.actions) and r.key = any(s.deleters)
  from public.roles r
 cross join (values
    -- Marking the team's attendance is day-to-day work; deleting a day is not.
    ('attendance_days',         array['view','create','edit','delete'],
       array['owner','admin','member'], array['owner','admin','member'], array['owner','admin']),
    -- Quotas are policy. Everyone must read them to apply for leave at all.
    ('leave_types',             array['view','create','edit','delete'],
       array['owner','admin'],          array['owner','admin'],          array['owner','admin']),
    -- `edit` here IS approval, so it stops at admin even though `create`
    -- (applying on someone's behalf) does not.
    ('leave_requests',          array['view','create','edit','delete'],
       array['owner','admin','member'], array['owner','admin'],          array['owner','admin']),
    ('leave_adjustments',       array['view','create','edit','delete'],
       array['owner','admin'],          array['owner','admin'],          array['owner','admin']),
    ('announcements',           array['view','create','edit','delete'],
       array['owner','admin'],          array['owner','admin'],          array['owner','admin']),
    ('storage_employee_photos', array['view','create','delete'],
       array['owner','admin','member'], array['owner','admin','member'], array['owner','admin'])
  ) s(resource, actions, creators, editors, deleters)
 where r.key in ('owner','admin','member','viewer');

-- The employee's own grants. Everything an employee does to their own row goes
-- through the self policies in section 6, not through these flags — so the only
-- true values here are the things that are genuinely org-wide reads: the leave
-- catalogue they pick from, and the notice board.
insert into public.role_permission_defaults (role, resource, can_view, can_create, can_edit, can_delete)
values ('employee', 'attendance_days',         false, false, false, false),
       ('employee', 'leave_types',             true,  false, false, false),
       ('employee', 'leave_requests',          false, false, false, false),
       ('employee', 'leave_adjustments',       false, false, false, false),
       ('employee', 'announcements',           false, false, false, false),
       ('employee', 'storage_employee_photos', true,  false, false, false);

-- ═════════════════════════════════════════════════════════════════════════════
-- 6. RLS — the matrix first, then the self policies on top
-- ═════════════════════════════════════════════════════════════════════════════

select app.secure_tenant_table('public.attendance_days'::regclass,   'attendance_days');
select app.secure_tenant_table('public.leave_types'::regclass,       'leave_types');
select app.secure_tenant_table('public.leave_requests'::regclass,    'leave_requests');
select app.secure_tenant_table('public.leave_adjustments'::regclass, 'leave_adjustments');
select app.secure_tenant_table('public.announcements'::regclass,     'announcements');

grant select, insert, update, delete on
  public.attendance_days, public.leave_types, public.leave_requests,
  public.leave_adjustments, public.announcements, public.announcement_reads
  to authenticated;
grant all on
  public.attendance_days, public.leave_types, public.leave_requests,
  public.leave_adjustments, public.announcements, public.announcement_reads
  to service_role;
grant select on public.leave_balances_v to authenticated;

-- ─── Attendance: your own day ────────────────────────────────────────────────
-- Permissive, so it unions with attendance_days_select from the matrix: a
-- manager keeps the whole team, an employee gains themselves.
create policy attendance_self_select on public.attendance_days
  for select to authenticated
  using (employee_id = app.my_employee_id(org_id));

-- Today only, and only as 'self'. Yesterday is a correction and belongs to
-- whoever holds `attendance` edit; a row already marked 'admin' is a correction
-- that has been made and must not be undone from a phone.
create policy attendance_self_insert on public.attendance_days
  for insert to authenticated
  with check (employee_id = app.my_employee_id(org_id)
              and work_date = current_date
              and source = 'self'
              and status in ('present', 'remote'));

create policy attendance_self_update on public.attendance_days
  for update to authenticated
  using      (employee_id = app.my_employee_id(org_id)
              and work_date = current_date
              and source = 'self')
  with check (employee_id = app.my_employee_id(org_id)
              and work_date = current_date
              and source = 'self'
              and status in ('present', 'remote'));

-- ─── Leave types: readable by anyone who may apply ───────────────────────────
-- Covered by the matrix (employee holds view), so no self policy is needed.

-- ─── Leave requests: yours, and your reports' ────────────────────────────────
create policy leave_requests_self_select on public.leave_requests
  for select to authenticated
  using (employee_id = app.my_employee_id(org_id)
         or app.is_manager_of(employee_id));

create policy leave_requests_self_insert on public.leave_requests
  for insert to authenticated
  with check (employee_id = app.my_employee_id(org_id)
              and status = 'pending');

-- Withdrawing, or fixing a typo before anyone has looked. The trigger below is
-- what stops `status` moving anywhere except to 'cancelled'.
create policy leave_requests_self_update on public.leave_requests
  for update to authenticated
  using      (employee_id = app.my_employee_id(org_id) and status = 'pending')
  with check (employee_id = app.my_employee_id(org_id));

-- ─── Announcements: your department, or the whole org ────────────────────────
create policy announcements_self_select on public.announcements
  for select to authenticated
  using (
    exists (select 1 from public.memberships m
             where m.org_id = announcements.org_id and m.user_id = auth.uid())
    and (
      department_id is null
      or department_id = (select e.department_id from public.employees e
                           where e.id = app.my_employee_id(announcements.org_id))
    )
  );

alter table public.announcement_reads enable row level security;
alter table public.announcement_reads force row level security;
revoke all on public.announcement_reads from anon;
create policy announcement_reads_own on public.announcement_reads
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ═════════════════════════════════════════════════════════════════════════════
-- 7. The rules a policy cannot express
-- ═════════════════════════════════════════════════════════════════════════════

-- Nobody approves their own leave. Not "the button is hidden" — the write is
-- refused. Also pins the decision metadata so a client cannot claim someone
-- else approved it, and forbids an applicant editing anything but withdrawal.
create or replace function app.guard_leave_decision()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_self uuid;
begin
  v_self := app.my_employee_id(new.org_id);

  if tg_op = 'INSERT' then
    -- A manager filing on someone's behalf still files a pending request.
    new.status           := 'pending';
    new.decided_by       := null;
    new.decided_at       := null;
    new.decision_comment := null;
    return new;
  end if;

  if new.status is distinct from old.status then
    -- The applicant's only move is to withdraw.
    if new.employee_id = v_self and new.status <> 'cancelled' then
      raise exception 'You cannot % your own leave request.', new.status
        using errcode = 'insufficient_privilege';
    end if;

    -- Anyone else changing it must hold the approval right outright.
    if new.employee_id <> coalesce(v_self, '00000000-0000-0000-0000-000000000000'::uuid)
       and not app.has_permission(new.org_id, 'leave_requests', 'edit') then
      raise exception 'You do not have permission to decide leave requests.'
        using errcode = 'insufficient_privilege';
    end if;

    if new.status in ('approved', 'rejected') then
      new.decided_by := auth.uid();
      new.decided_at := now();
    end if;
  elsif old.status <> 'pending' then
    raise exception 'A % request can no longer be edited.', old.status
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

create trigger leave_requests_guard
  before insert or update on public.leave_requests
  for each row execute function app.guard_leave_decision();

-- Stamps who wrote an attendance row. `source` is set by whoever writes: the
-- portal sends 'self' (and the policy above enforces it), the admin sheet sends
-- 'admin' — which the self policy then refuses to let the employee overwrite.
create or replace function app.stamp_attendance()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  new.marked_by := auth.uid();
  return new;
end $$;

create trigger attendance_days_stamp
  before insert or update on public.attendance_days
  for each row execute function app.stamp_attendance();

-- Audited like the other tables that carry consequence (0020).
create trigger leave_requests_audit after insert or update or delete on public.leave_requests
  for each row execute function app.write_audit();
create trigger leave_adjustments_audit after insert or update or delete on public.leave_adjustments
  for each row execute function app.write_audit();
create trigger announcements_audit after insert or update or delete on public.announcements
  for each row execute function app.write_audit();

-- ═════════════════════════════════════════════════════════════════════════════
-- 8. Approvals land in the notification panel
-- ═════════════════════════════════════════════════════════════════════════════
-- `notifications` was org-wide: every row was visible to every member. A leave
-- decision is addressed to one person, so the table gains a recipient. Null
-- keeps the old meaning — everyone — so no existing row changes visibility.

alter table public.notifications
  add column if not exists user_id          uuid references auth.users(id)         on delete cascade,
  add column if not exists employee_id      uuid references public.employees(id)   on delete cascade,
  add column if not exists leave_request_id uuid references public.leave_requests(id) on delete cascade;

create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc)
  where user_id is not null;

-- secure_tenant_table wrote notifications_select as the matrix check alone.
-- Narrow it: an addressed notification reaches its addressee only.
drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications
  for select to authenticated
  using (app.has_permission(org_id, 'notifications', 'view')
         and (user_id is null or user_id = auth.uid()));

-- The panel fills itself. Doing this in the client would mean every future
-- caller of leaveService.decide() has to remember to write the notification.
create or replace function app.notify_leave_request()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_name    text;
  v_type    text;
  v_manager uuid;
  v_user    uuid;
begin
  select e.full_name, e.user_id,
         (select m.user_id from public.employees m where m.id = e.reports_to)
    into v_name, v_user, v_manager
    from public.employees e where e.id = new.employee_id;

  select lt.name into v_type from public.leave_types lt where lt.id = new.leave_type_id;

  if tg_op = 'INSERT' then
    -- Addressed to the manager when there is one; otherwise it goes to the
    -- whole panel, which is the only way an org with no chart drawn sees it.
    insert into public.notifications (org_id, type, title, message, user_id, employee_id, leave_request_id)
    values (new.org_id, 'leave_request',
            format('%s requested %s leave', v_name, v_type),
            format('%s to %s (%s day(s))%s',
                   to_char(new.start_date, 'DD Mon'), to_char(new.end_date, 'DD Mon'),
                   case when new.days = trunc(new.days)
                        then trunc(new.days)::text else new.days::text end,
                   case when new.reason is null then '' else ' — ' || new.reason end),
            v_manager, new.employee_id, new.id);

  elsif new.status is distinct from old.status and new.status in ('approved', 'rejected') then
    insert into public.notifications (org_id, type, title, message, user_id, employee_id, leave_request_id)
    values (new.org_id, 'leave_' || new.status,
            format('Your %s leave was %s', v_type, new.status),
            format('%s to %s%s',
                   to_char(new.start_date, 'DD Mon'), to_char(new.end_date, 'DD Mon'),
                   case when new.decision_comment is null then '' else ' — ' || new.decision_comment end),
            v_user, new.employee_id, new.id);
  end if;

  return new;
end $$;

create trigger leave_requests_notify
  after insert or update on public.leave_requests
  for each row execute function app.notify_leave_request();

-- ═════════════════════════════════════════════════════════════════════════════
-- 9. Employee photos — private bucket, 2 MB ceiling
-- ═════════════════════════════════════════════════════════════════════════════
-- Object names are '<org_id>/<employee_id>-<ts>.<ext>', the layout
-- app.storage_org() (0004) reads the tenant from. Private: a staff photo is not
-- something to leave on a public CDN, so reads go through signed URLs.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('employee-photos', 'employee-photos', false, 2097152,
        array['image/png','image/jpeg','image/webp'])
on conflict (id) do update
  set public             = false,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy employee_photos_select on storage.objects for select to authenticated
  using (bucket_id = 'employee-photos'
         and app.has_permission(app.storage_org(name), 'storage_employee_photos', 'view'));
create policy employee_photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'employee-photos'
              and app.has_permission(app.storage_org(name), 'storage_employee_photos', 'create'));
create policy employee_photos_update on storage.objects for update to authenticated
  using      (bucket_id = 'employee-photos'
              and app.has_permission(app.storage_org(name), 'storage_employee_photos', 'create'))
  with check (bucket_id = 'employee-photos'
              and app.has_permission(app.storage_org(name), 'storage_employee_photos', 'create'));
create policy employee_photos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'employee-photos'
         and app.has_permission(app.storage_org(name), 'storage_employee_photos', 'delete'));

-- ═════════════════════════════════════════════════════════════════════════════
-- 10. An exit revokes access
-- ═════════════════════════════════════════════════════════════════════════════
-- The brief promised this and nothing implemented it: orgStore.removeItem() set
-- `exited_at` and stopped. The membership row — the thing that actually grants
-- a login its permissions — was untouched, so an "ex-employee" kept full access
-- to the organization indefinitely.
--
-- Deleting the membership, not flagging it, is deliberate: every policy in the
-- system reads `memberships`, and a status column would mean auditing thirty
-- policies to honour it. app.protect_last_owner (0002) still fires on the
-- delete and refuses to strip the final owner, which is the correct outcome —
-- exiting the last owner should fail loudly.

create or replace function app.revoke_employee_access()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.user_id is not null then
    delete from public.memberships
     where org_id = new.org_id and user_id = new.user_id;
  end if;

  -- An unaccepted invitation is a login waiting to happen.
  if new.email is not null then
    update public.invitations
       set revoked_at = now()
     where org_id = new.org_id
       and email = new.email
       and accepted_at is null
       and revoked_at is null;
  end if;

  new.access_revoked_at := now();
  return new;
end $$;

-- BEFORE, so the timestamp is written by the same statement rather than by a
-- second UPDATE that would re-enter this trigger's own table.
create trigger employees_revoke_access
  before update of exited_at on public.employees
  for each row
  when (old.exited_at is null and new.exited_at is not null)
  execute function app.revoke_employee_access();

comment on function app.revoke_employee_access() is
  'Exiting an employee deletes their membership. Re-hiring does not restore it — '
  'an admin must re-invite, so restoring access is always a deliberate act.';


-- ############################################################################
-- ## 0030_portal_access.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0030 — getting into the employee portal without a ceremony
--
-- 0029 gave an employee a login but left the path to it in three pieces: an
-- admin invites an email address, the person accepts, and then an admin opens
-- the employee card and links the two by hand. The middle step existed because
-- of a worry that turned out to be unfounded — see below — and the first two
-- had no user interface at all. `invitations` and accept_invitation() have been
-- in the schema since 0001 and nothing in the app has ever called them.
--
-- This file makes two things possible and removes the third:
--
--   the invitation carries the employee    invitations.employee_id. Acceptance
--                                          links the record itself, so nobody
--                                          picks a login out of a dropdown.
--   a join code                            one code per organization. Staff let
--                                          themselves in from a link in the
--                                          group chat instead of waiting on an
--                                          invite each.
--
-- ─── Why linking by email is safe here, when it would not be at signup ──────
-- 0029's meService.linkEmployeeToUser() carried this warning: "matching by
-- email alone would hand someone else's record to whoever registered that
-- address first". True of a bare signup. Not true of either path below:
--
--   · accept_invitation() has verified since 0001 that the invitation's email
--     equals the email on the caller's JWT. Receiving the token proves control
--     of that mailbox, and an admin addressed it there deliberately.
--   · claim_portal_seat() requires all three of: the org's current code, an
--     employee record an admin already created with that email, and a verified
--     session on that same address.
--
-- In both cases the person has proved they hold the mailbox the admin typed in.
-- That is the same evidence the membership grant already rests on.
-- ─────────────────────────────────────────────────────────────────────────────

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. An invitation can name the employee it is for
-- ═════════════════════════════════════════════════════════════════════════════

alter table public.invitations
  add column if not exists employee_id uuid references public.employees(id) on delete cascade;

comment on column public.invitations.employee_id is
  'The employee record this invitation grants a portal login to. Set when the '
  'invitation is raised from the employee card, so acceptance links the record '
  'deterministically rather than matching on email.';

create index if not exists invitations_employee_idx
  on public.invitations (employee_id) where employee_id is not null;

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. The join code
-- ═════════════════════════════════════════════════════════════════════════════
-- Lives on `organizations` so the existing admin-only UPDATE policy governs who
-- may rotate or disable it, with no new table to secure. Reading it during a
-- claim happens inside a SECURITY DEFINER function, because the person claiming
-- is by definition not yet a member and cannot select the row.

alter table public.organizations
  add column if not exists portal_join_code       text,
  add column if not exists portal_join_enabled    boolean not null default false,
  add column if not exists portal_join_expires_at timestamptz;

-- Unambiguous alphabet: no O/0, I/1/l. These get read off a phone screen and
-- typed by someone standing in a corridor.
create or replace function app.new_join_code()
returns text language sql volatile as $$
  select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789',
                           (floor(random() * 31) + 1)::int, 1), '')
    from generate_series(1, 8);
$$;

create unique index if not exists organizations_join_code_idx
  on public.organizations (portal_join_code) where portal_join_code is not null;

-- Admin-only, and it never returns anyone else's code: the has_permission check
-- is the same one the organizations UPDATE policy applies.
create or replace function public.rotate_portal_join_code(p_org uuid, p_enabled boolean default true)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_code text;
begin
  if not app.has_permission(p_org, 'organizations', 'edit') then
    raise exception 'You do not have permission to change portal access.'
      using errcode = 'insufficient_privilege';
  end if;

  -- Collisions are vanishingly rare at 31^8, but a unique index that can fail a
  -- user's click is not worth leaving to chance.
  loop
    v_code := app.new_join_code();
    exit when not exists (select 1 from public.organizations where portal_join_code = v_code);
  end loop;

  update public.organizations
     set portal_join_code       = v_code,
         portal_join_enabled    = p_enabled,
         -- A code that lives forever is a password that was never rotated.
         portal_join_expires_at = now() + interval '30 days'
   where id = p_org;

  insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, diff)
  values (p_org, auth.uid(), 'portal_join_code.rotated', 'organization', p_org,
          jsonb_build_object('enabled', p_enabled));

  return v_code;
end $$;

grant execute on function public.rotate_portal_join_code(uuid, boolean) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. What the join page may show before anyone is a member
-- ═════════════════════════════════════════════════════════════════════════════
-- Deliberately thin. Enough for "Acme Pvt Ltd set up your portal" so the page
-- does not look like a phishing form, and nothing more: no employee list, no
-- confirmation that a given address is on staff, no organization id.

create or replace function public.portal_invite_preview(p_token uuid)
returns table (org_name text, employee_name text, invited_email text, problem text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare inv public.invitations%rowtype; v_org text; v_emp text;
begin
  select * into inv from public.invitations where token = p_token;
  if not found then
    return query select null::text, null::text, null::text, 'This link is not valid.';
    return;
  end if;

  select company_name into v_org from public.organizations where id = inv.org_id;
  if inv.employee_id is not null then
    select full_name into v_emp from public.employees where id = inv.employee_id;
  end if;

  return query select
    v_org, v_emp, inv.email::text,
    case
      when inv.revoked_at  is not null then 'This invitation has been withdrawn.'
      when inv.accepted_at is not null then 'This invitation has already been used.'
      when inv.expires_at  <= now()    then 'This invitation has expired. Ask for a new one.'
    end;
end $$;

grant execute on function public.portal_invite_preview(uuid) to anon, authenticated;

-- Name only, and only while the code is live. A wrong code is indistinguishable
-- from a disabled one, so the function cannot be used to test codes for a hit.
create or replace function public.portal_join_preview(p_code text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select o.company_name
    from public.organizations o
   where o.portal_join_code = upper(btrim(p_code))
     and o.portal_join_enabled
     and (o.portal_join_expires_at is null or o.portal_join_expires_at > now());
$$;

grant execute on function public.portal_join_preview(text) to anon, authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. Acceptance links the employee record
-- ═════════════════════════════════════════════════════════════════════════════
-- Same function as 0002, same guards in the same order, plus the linking step.
-- The email check on line "invitation is for a different email address" is what
-- makes the link safe, and it stays exactly where it was.

create or replace function public.accept_invitation(p_token uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_email citext := (current_setting('request.jwt.claims', true)::jsonb ->> 'email')::citext;
  inv     public.invitations%rowtype;
  v_emp   uuid;
begin
  if v_uid is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;

  select * into inv from public.invitations where token = p_token for update;

  if not found                          then raise exception 'invitation not found';       end if;
  if inv.revoked_at  is not null        then raise exception 'invitation revoked';         end if;
  -- Replay is not an error for the person who already accepted. A Google
  -- round-trip lands back on /join with the same token, and the page redeems on
  -- sight of a session; telling that caller 'already used' is both wrong (they
  -- are in) and a dead end. Anyone else holding the token still gets refused.
  if inv.accepted_at is not null then
    if inv.accepted_by is distinct from v_uid then
      raise exception 'invitation already used';
    end if;
    insert into public.memberships (org_id, user_id, role)
    values (inv.org_id, v_uid, inv.role)
    on conflict (org_id, user_id) do nothing;
    return inv.org_id;
  end if;
  if inv.expires_at  <= now()           then raise exception 'invitation expired';         end if;
  if lower(inv.email) <> lower(v_email) then raise exception 'invitation is for a different email address'; end if;

  insert into public.memberships (org_id, user_id, role)
  values (inv.org_id, v_uid, inv.role)
  on conflict (org_id, user_id) do update set role = excluded.role;

  -- The employee named on the invitation, or — for an invitation raised before
  -- this migration, or from a plain "invite by email" — whichever active record
  -- carries that address and has no login yet.
  select e.id into v_emp
    from public.employees e
   where e.org_id = inv.org_id
     and e.exited_at is null
     and e.user_id is null
     and (e.id = inv.employee_id or (inv.employee_id is null and lower(e.email) = lower(inv.email)))
   order by (e.id = inv.employee_id) desc
   limit 1;

  -- Never steal a record that already belongs to someone: the partial unique
  -- index on (org_id, user_id) would refuse it anyway, and failing the whole
  -- acceptance over it would lock a legitimate member out of their own org.
  if v_emp is not null then
    update public.employees set user_id = v_uid where id = v_emp and user_id is null;
  end if;

  update public.invitations
     set accepted_at = now(), accepted_by = v_uid
   where token = p_token;

  insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, diff)
  values (inv.org_id, v_uid, 'membership.accepted', 'membership', v_uid,
          jsonb_build_object('role', inv.role, 'employee_id', v_emp));

  return inv.org_id;
end $$;

grant execute on function public.accept_invitation(uuid) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. Claiming a seat with the join code
-- ═════════════════════════════════════════════════════════════════════════════
-- Three gates, and the code is the weakest of them on purpose: knowing it is
-- worth nothing without an employee record an admin already created at your
-- address, and a verified session on that address. So the code can be shared in
-- a group chat the way a door code is, and rotated when someone leaves.
--
-- Always lands as the `employee` role. The code is a way into the portal, never
-- a way to a seat with more reach than that.

create or replace function public.claim_portal_seat(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_email citext := (current_setting('request.jwt.claims', true)::jsonb ->> 'email')::citext;
  v_org   uuid;
  v_emp   uuid;
begin
  if v_uid is null then
    raise exception 'authentication required' using errcode = 'insufficient_privilege';
  end if;
  if v_email is null then
    raise exception 'Your sign-in has no email address, so it cannot be matched to an employee record.';
  end if;

  select id into v_org
    from public.organizations
   where portal_join_code = upper(btrim(p_code))
     and portal_join_enabled
     and (portal_join_expires_at is null or portal_join_expires_at > now());

  if v_org is null then
    raise exception 'That code is not valid. Ask for the current one.';
  end if;

  -- Already in? Say so plainly rather than raising on the membership insert.
  if exists (select 1 from public.memberships where org_id = v_org and user_id = v_uid) then
    return v_org;
  end if;

  select e.id into v_emp
    from public.employees e
   where e.org_id = v_org
     and e.exited_at is null
     and e.user_id is null
     and lower(e.email) = lower(v_email)
   limit 1;

  -- The message names the address so a person who signed in with a personal
  -- Google account instead of their work one can see what went wrong.
  if v_emp is null then
    raise exception 'No employee record at % is waiting for a login here. Ask an admin to add you, or sign in with your work email address.', v_email
      using errcode = 'no_data_found';
  end if;

  insert into public.memberships (org_id, user_id, role) values (v_org, v_uid, 'employee');
  update public.employees set user_id = v_uid where id = v_emp and user_id is null;

  insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, diff)
  values (v_org, v_uid, 'membership.claimed', 'membership', v_uid,
          jsonb_build_object('role', 'employee', 'employee_id', v_emp, 'via', 'join_code'));

  return v_org;
end $$;

grant execute on function public.claim_portal_seat(text) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- 6. Raising an invitation from the employee card
-- ═════════════════════════════════════════════════════════════════════════════
-- The client could insert into `invitations` directly — an admin holds that
-- policy — but then every caller would have to remember the role, the expiry,
-- the employee id, and to clear the previous unaccepted invitation. One function
-- so "give this person portal access" is one call, and is the same call from the
-- card and from the bulk action.

create or replace function public.invite_employee_to_portal(p_employee uuid)
returns table (token uuid, email text, full_name text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare emp public.employees%rowtype; v_token uuid;
begin
  select * into emp from public.employees where id = p_employee;
  if not found then raise exception 'No such employee.'; end if;

  if not app.has_permission(emp.org_id, 'memberships', 'create') then
    raise exception 'You do not have permission to grant access to this organization.'
      using errcode = 'insufficient_privilege';
  end if;

  if emp.exited_at is not null then
    raise exception '% has left the organization.', emp.full_name;
  end if;
  if emp.email is null or btrim(emp.email::text) = '' then
    raise exception 'Add an email address to % before giving them portal access.', emp.full_name;
  end if;
  if emp.user_id is not null then
    raise exception '% already has a login.', emp.full_name;
  end if;

  -- Re-inviting supersedes: the old link stops working, which is what someone
  -- clicking "Resend" means by it.
  -- Columns qualified: this function's OUT parameters are named `email` and
  -- `full_name`, and an unqualified `email` here resolves to the parameter.
  update public.invitations i
     set revoked_at = now()
   where i.org_id = emp.org_id and i.email = emp.email
     and i.accepted_at is null and i.revoked_at is null;

  insert into public.invitations (org_id, email, role, employee_id, invited_by, expires_at)
  values (emp.org_id, emp.email, 'employee', emp.id, auth.uid(), now() + interval '14 days')
  returning invitations.token into v_token;

  return query select v_token, emp.email::text, emp.full_name;
end $$;

grant execute on function public.invite_employee_to_portal(uuid) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- 7. Portal access, as one readable state per employee
-- ═════════════════════════════════════════════════════════════════════════════
-- The Employees list needs to show "no access / invited / active" per row, and
-- `invitations` is admin-only under RLS (0003) — so a member opening the page
-- would silently see every row as "no access". This reports the state without
-- exposing the invitation itself: no token, no inviter, no other org.

create or replace function public.employee_portal_state(p_org uuid)
returns table (employee_id uuid, state text, invited_at timestamptz, expires_at timestamptz)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select e.id,
         case
           when e.user_id is not null then 'active'
           when i.token   is not null then 'invited'
           else 'none'
         end,
         i.created_at,
         i.expires_at
    from public.employees e
    left join lateral (
      select * from public.invitations i2
       where i2.org_id = e.org_id and i2.email = e.email
         and i2.accepted_at is null and i2.revoked_at is null and i2.expires_at > now()
       order by i2.created_at desc limit 1
    ) i on true
   where e.org_id = p_org
     and e.exited_at is null
     and exists (select 1 from public.memberships m
                  where m.org_id = p_org and m.user_id = auth.uid());
$$;

grant execute on function public.employee_portal_state(uuid) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- 8. An exit closes the door it opened
-- ═════════════════════════════════════════════════════════════════════════════
-- 0029's revocation already revokes pending invitations by email. Now that an
-- invitation can name an employee, revoke by that too — an address can be
-- corrected on the record after the invitation went out.

create or replace function app.revoke_employee_access()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.user_id is not null then
    delete from public.memberships
     where org_id = new.org_id and user_id = new.user_id;
  end if;

  update public.invitations
     set revoked_at = now()
   where org_id = new.org_id
     and accepted_at is null
     and revoked_at is null
     and (employee_id = new.id or (new.email is not null and email = new.email));

  new.access_revoked_at := now();
  return new;
end $$;


-- ############################################################################
-- ## 0031_portal_credentials.sql
-- ############################################################################

-- ═══════════════════════════════════════════════════════════════════════════════
-- 0031 — Portal logins an admin creates, with a password
-- ═══════════════════════════════════════════════════════════════════════════════
-- 0030 made getting into the portal a link: an invitation, or a join code, and
-- then whatever sign-in the person chose. Google was the prominent one, and it
-- had a failure that is fatal in practice: a Google account is identified by
-- whatever address Google returns. When that is not the address the admin typed
-- on the employee card, the person lands as a stranger — no membership, no
-- employee record, and the onboarding gate inviting them to start a company.
--
-- So the identity stops being something the employee chooses. The admin creates
-- the login, the system generates the password, and the employee signs in on
-- the ordinary sign-in page with credentials that were handed to them. There is
-- nothing to accept, no mailbox round-trip, and the address on the login is the
-- address on the employee card by construction.
--
-- ─── On writing to auth.users directly ──────────────────────────────────────
-- The supported way to create a user is the Admin API (service_role), which
-- means an Edge Function and a deployed secret. This project applies SQL and
-- nothing else, so these functions write the auth row themselves: a bcrypt
-- password via pgcrypto, an email-provider identity, and the account confirmed
-- on the spot. That is a deliberate trade. Two consequences worth knowing:
--
--   · GoTrue owns this schema. If a future Supabase release changes the columns
--     below, create_portal_login() fails loudly at the insert rather than
--     quietly producing an account that cannot sign in.
--   · Passwords are generated, returned exactly once, and never stored. No
--     column anywhere holds a portal password in plain text.
--
-- ─── What an admin may never do through this ────────────────────────────────
-- Setting a password on an account is indistinguishable from taking it over, so
-- these functions set one only on an account this org created, holding exactly
-- one membership: the employee seat in this org. An address that already
-- belongs to a person with a login of their own is linked, never overwritten —
-- the admin is told to let them use the password they already have.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Generating a password that can be read out across a desk
-- ═════════════════════════════════════════════════════════════════════════════
-- Three groups of four, hyphenated. No characters that collide in a sans-serif
-- font, because this gets written on a sticky note and typed on a phone.

create or replace function app.new_portal_password()
returns text language sql volatile as $$
  select string_agg(chunk, '-') from (
    select string_agg(
             substr('abcdefghjkmnpqrstuvwxyz23456789',
                    (floor(random() * 31) + 1)::int, 1), '') as chunk
      from generate_series(1, 12) g
     group by (g - 1) / 4
     order by min(g)
  ) parts;
$$;

comment on function app.new_portal_password() is
  'A readable 14-character password. Around 2^59 of entropy, ample for a '
  'credential handed over once and changed on first use.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. The employee record remembers that a login exists, never the password
-- ═════════════════════════════════════════════════════════════════════════════

alter table public.employees
  add column if not exists portal_password_set_at      timestamptz,
  add column if not exists portal_must_change_password boolean not null default false;

comment on column public.employees.portal_password_set_at is
  'When an admin last generated a password for this person. The password itself '
  'is returned once by create_portal_login()/reset_portal_password() and is not '
  'stored anywhere.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Is this account ours to set a password on?
-- ═════════════════════════════════════════════════════════════════════════════
-- True only when the account's entire reach is the employee seat in this one
-- organization. An owner, an admin, or someone who also belongs to another org
-- answers false, and the admin screen then offers nothing but "they sign in
-- with the password they already have".

create or replace function app.portal_account_is_ours(p_user uuid, p_org uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select p_user is not null
     and exists (select 1 from public.memberships
                  where user_id = p_user and org_id = p_org and role = 'employee')
     and not exists (select 1 from public.memberships
                      where user_id = p_user and (org_id <> p_org or role <> 'employee'));
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. Writing the auth account
-- ═════════════════════════════════════════════════════════════════════════════
-- Internal. Every caller-facing guard lives in §5, and neither of these is
-- granted to anybody.

create or replace function app.create_auth_user(p_email text, p_password text)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare v_uid uuid := gen_random_uuid();
begin
  insert into auth.users (
    id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change, email_change_token_new
  ) values (
    v_uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    lower(btrim(p_email)), crypt(p_password, gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now(),
    -- Empty strings, not nulls: GoTrue reads these columns into Go strings and
    -- a null makes every sign-in for the account fail with a scan error.
    '', '', '', ''
  );

  -- The identity row. Its shape has changed across GoTrue releases (provider_id
  -- is the newer column), so add that only where it exists rather than pinning
  -- this migration to one version.
  if to_regclass('auth.identities') is not null then
    if exists (select 1 from information_schema.columns
                where table_schema = 'auth' and table_name = 'identities'
                  and column_name = 'provider_id') then
      execute 'insert into auth.identities
                 (id, provider_id, user_id, identity_data, provider,
                  last_sign_in_at, created_at, updated_at)
               values (gen_random_uuid(), $1::text, $1, $2, ''email'', now(), now(), now())'
        using v_uid, jsonb_build_object('sub', v_uid::text, 'email', lower(btrim(p_email)),
                                        'email_verified', true, 'phone_verified', false);
    else
      execute 'insert into auth.identities
                 (id, user_id, identity_data, provider,
                  last_sign_in_at, created_at, updated_at)
               values (gen_random_uuid(), $1, $2, ''email'', now(), now(), now())'
        using v_uid, jsonb_build_object('sub', v_uid::text, 'email', lower(btrim(p_email)));
    end if;
  end if;

  return v_uid;
end $$;

create or replace function app.set_auth_password(p_user uuid, p_password text)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  update auth.users
     set encrypted_password = crypt(p_password, gen_salt('bf')),
         updated_at         = now()
   where id = p_user;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. What the admin screen calls
-- ═════════════════════════════════════════════════════════════════════════════
-- One click, three outcomes, and the difference matters to the person clicking:
--   created  — here is the password, hand it over now, it is not shown again
--   linked   — the address already had a login; they use the password they have
--   exists   — nothing to do, this employee is already in the portal

create or replace function public.create_portal_login(p_employee uuid)
returns table (email text, password text, outcome text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  emp   public.employees%rowtype;
  v_uid uuid;
  v_pw  text;
begin
  select * into emp from public.employees where id = p_employee;
  if not found then raise exception 'No such employee.'; end if;

  if not app.has_permission(emp.org_id, 'memberships', 'create') then
    raise exception 'You do not have permission to create logins for this organization.'
      using errcode = 'insufficient_privilege';
  end if;
  if emp.exited_at is not null then
    raise exception '% has left the organization.', emp.full_name;
  end if;
  if emp.email is null or btrim(emp.email::text) = '' then
    raise exception 'Add an email address to % before creating a login.', emp.full_name;
  end if;

  -- Already in the portal.
  if emp.user_id is not null
     and exists (select 1 from public.memberships m
                  where m.org_id = emp.org_id and m.user_id = emp.user_id) then
    return query select emp.email::text, null::text, 'exists';
    return;
  end if;

  select u.id into v_uid from auth.users u
   where lower(u.email) = lower(emp.email::text) limit 1;

  if v_uid is null then
    v_pw  := app.new_portal_password();
    v_uid := app.create_auth_user(emp.email::text, v_pw);
  end if;

  insert into public.memberships (org_id, user_id, role)
  values (emp.org_id, v_uid, 'employee')
  on conflict (org_id, user_id) do nothing;

  update public.employees
     set user_id                     = v_uid,
         access_revoked_at           = null,
         portal_password_set_at      = case when v_pw is null
                                            then portal_password_set_at else now() end,
         portal_must_change_password = (v_pw is not null)
   where id = emp.id;

  -- Any link still in flight for this address is now pointless.
  update public.invitations i
     set revoked_at = now()
   where i.org_id = emp.org_id and i.email = emp.email
     and i.accepted_at is null and i.revoked_at is null;

  insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, diff)
  values (emp.org_id, auth.uid(), 'portal_login.created', 'employee', emp.id,
          jsonb_build_object('generated_password', v_pw is not null));

  return query select emp.email::text, v_pw,
                      case when v_pw is null then 'linked' else 'created' end;
end $$;

grant execute on function public.create_portal_login(uuid) to authenticated;

create or replace function public.reset_portal_password(p_employee uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare emp public.employees%rowtype; v_pw text;
begin
  select * into emp from public.employees where id = p_employee;
  if not found then raise exception 'No such employee.'; end if;

  if not app.has_permission(emp.org_id, 'memberships', 'create') then
    raise exception 'You do not have permission to change logins for this organization.'
      using errcode = 'insufficient_privilege';
  end if;
  if emp.user_id is null then
    raise exception '% does not have a portal login yet.', emp.full_name;
  end if;
  if not app.portal_account_is_ours(emp.user_id, emp.org_id) then
    raise exception '% signs in with their own account. Ask them to reset their password from the sign-in page.',
      emp.full_name;
  end if;

  v_pw := app.new_portal_password();
  perform app.set_auth_password(emp.user_id, v_pw);

  update public.employees
     set portal_password_set_at = now(), portal_must_change_password = true
   where id = emp.id;

  insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, diff)
  values (emp.org_id, auth.uid(), 'portal_login.password_reset', 'employee', emp.id, '{}'::jsonb);

  return v_pw;
end $$;

grant execute on function public.reset_portal_password(uuid) to authenticated;

-- Cutting access without ending the employment: the person stays on the team
-- list, the login stops working today.
create or replace function public.revoke_portal_login(p_employee uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare emp public.employees%rowtype;
begin
  select * into emp from public.employees where id = p_employee;
  if not found then raise exception 'No such employee.'; end if;

  if not app.has_permission(emp.org_id, 'memberships', 'delete')
     and not app.has_permission(emp.org_id, 'memberships', 'create') then
    raise exception 'You do not have permission to change logins for this organization.'
      using errcode = 'insufficient_privilege';
  end if;

  if emp.user_id is not null then
    -- protect_last_owner (0002) still fires here, which is what we want: the
    -- only owner of an organization cannot be locked out of it.
    delete from public.memberships where org_id = emp.org_id and user_id = emp.user_id;
  end if;

  update public.employees set access_revoked_at = now() where id = emp.id;

  insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, diff)
  values (emp.org_id, auth.uid(), 'portal_login.revoked', 'employee', emp.id, '{}'::jsonb);
end $$;

grant execute on function public.revoke_portal_login(uuid) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- 6. The employee's own side of it
-- ═════════════════════════════════════════════════════════════════════════════
-- The password change itself is supabase.auth.updateUser() in the browser. All
-- this does is clear the nag, and it can only ever clear the caller's own.

create or replace function public.clear_password_change_flag()
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.employees
     set portal_must_change_password = false
   where user_id = auth.uid() and portal_must_change_password;
$$;

grant execute on function public.clear_password_change_flag() to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- 7. What the admin screen reads
-- ═════════════════════════════════════════════════════════════════════════════
-- Replaces 0030's version. `state` gains 'revoked' — an employee who had access
-- and no longer does was previously indistinguishable from one who has it — and
-- a caller now also learns whether a password can be reset, which decides which
-- buttons the card shows.

drop function if exists public.employee_portal_state(uuid);

create or replace function public.employee_portal_state(p_org uuid)
returns table (
  employee_id uuid, state text, invited_at timestamptz, expires_at timestamptz,
  password_set_at timestamptz, can_reset_password boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select e.id,
         case
           when e.user_id is not null
            and exists (select 1 from public.memberships m
                         where m.org_id = e.org_id and m.user_id = e.user_id) then 'active'
           when e.user_id is not null then 'revoked'
           when i.token is not null   then 'invited'
           else 'none'
         end,
         i.created_at,
         i.expires_at,
         e.portal_password_set_at,
         app.portal_account_is_ours(e.user_id, e.org_id)
    from public.employees e
    left join lateral (
      select * from public.invitations i2
       where i2.org_id = e.org_id and i2.email = e.email
         and i2.accepted_at is null and i2.revoked_at is null and i2.expires_at > now()
       order by i2.created_at desc limit 1
    ) i on true
   where e.org_id = p_org
     and e.exited_at is null
     and exists (select 1 from public.memberships m
                  where m.org_id = p_org and m.user_id = auth.uid());
$$;

grant execute on function public.employee_portal_state(uuid) to authenticated;


-- ############################################################################
-- ## 0032_employee_self_profile.sql
-- ############################################################################

-- ═══════════════════════════════════════════════════════════════════════════════
-- 0032 — Employees edit their own profile, photo included
-- ═══════════════════════════════════════════════════════════════════════════════
-- Until now the portal was read-only about the person using it: a new phone
-- number or a profile photo meant asking an admin. This file lets an employee
-- keep their own card current, and because it writes the same `employees` row
-- the admin screens read, the change is visible everywhere at once.
--
-- ─── Why a function and not a policy ────────────────────────────────────────
-- RLS secures rows, not columns. An `employees_self_update` policy would let an
-- employee rewrite their own role, department, manager, start date and exit —
-- everything that is an employer's decision rather than a personal detail. So
-- there is no such policy. update_my_profile() is SECURITY DEFINER, finds the
-- caller's row through app.my_employee_id(), and touches a fixed list of
-- columns and nothing else.
--
-- ─── Photos ─────────────────────────────────────────────────────────────────
-- An employee's own uploads live under `{org_id}/self/{employee_id}/…`. The
-- storage policies below allow writes only into that folder, and the function
-- refuses a photo_path outside it — otherwise one employee could point their
-- card at a colleague's photo, or at any object in the bucket.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. The personal details an employee owns
-- ═════════════════════════════════════════════════════════════════════════════

alter table public.employees
  add column if not exists date_of_birth           date,
  add column if not exists bio                     text,
  add column if not exists emergency_contact_name  text,
  add column if not exists emergency_contact_phone text;

alter table public.employees
  drop constraint if exists employees_bio_len,
  add  constraint employees_bio_len check (bio is null or length(bio) <= 600),
  drop constraint if exists employees_dob_sane,
  -- No `< current_date` here: a CHECK must be immutable or a restore can fail
  -- on a row that was valid the day it was written. The function checks it.
  add  constraint employees_dob_sane check (date_of_birth is null or date_of_birth > date '1900-01-01');

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. update_my_profile(org, patch)
-- ═════════════════════════════════════════════════════════════════════════════
-- Only keys present in the patch are changed, so the portal can save one field
-- without round-tripping the others. An empty string clears a field.

create or replace function public.update_my_profile(p_org uuid, p_patch jsonb)
returns public.employees
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me    uuid := app.my_employee_id(p_org);
  v_photo text;
  v_name  text;
  v_row   public.employees;
begin
  if v_me is null then
    raise exception 'No employee record is linked to your login in this organization.'
      using errcode = '42501';
  end if;

  if p_patch ? 'full_name' then
    v_name := btrim(coalesce(p_patch->>'full_name', ''));
    if length(v_name) = 0 then
      raise exception 'Your name cannot be empty.' using errcode = '22023';
    end if;
    if length(v_name) > 120 then
      raise exception 'That name is too long.' using errcode = '22023';
    end if;
  end if;

  if p_patch ? 'photo_path' then
    v_photo := nullif(btrim(coalesce(p_patch->>'photo_path', '')), '');
    if v_photo is not null
       and v_photo not like p_org::text || '/self/' || v_me::text || '/%' then
      raise exception 'That photo does not belong to you.' using errcode = '42501';
    end if;
  end if;

  if nullif(p_patch->>'date_of_birth', '') is not null
     and (p_patch->>'date_of_birth')::date >= current_date then
    raise exception 'Date of birth must be in the past.' using errcode = '22023';
  end if;

  update public.employees e set
    full_name               = case when p_patch ? 'full_name' then v_name else e.full_name end,
    phone                   = case when p_patch ? 'phone'
                                   then left(nullif(btrim(p_patch->>'phone'), ''), 40) else e.phone end,
    address                 = case when p_patch ? 'address'
                                   then left(nullif(btrim(p_patch->>'address'), ''), 400) else e.address end,
    bio                     = case when p_patch ? 'bio'
                                   then left(nullif(btrim(p_patch->>'bio'), ''), 600) else e.bio end,
    date_of_birth           = case when p_patch ? 'date_of_birth'
                                   then nullif(p_patch->>'date_of_birth', '')::date else e.date_of_birth end,
    emergency_contact_name  = case when p_patch ? 'emergency_contact_name'
                                   then left(nullif(btrim(p_patch->>'emergency_contact_name'), ''), 120)
                                   else e.emergency_contact_name end,
    emergency_contact_phone = case when p_patch ? 'emergency_contact_phone'
                                   then left(nullif(btrim(p_patch->>'emergency_contact_phone'), ''), 40)
                                   else e.emergency_contact_phone end,
    photo_path              = case when p_patch ? 'photo_path' then v_photo else e.photo_path end
  where e.id = v_me
  returning e.* into v_row;

  return v_row;
end;
$$;

revoke execute on function public.update_my_profile(uuid, jsonb) from public;
grant  execute on function public.update_my_profile(uuid, jsonb) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Storage: your own folder in employee-photos
-- ═════════════════════════════════════════════════════════════════════════════
-- Permissive, so these union with the matrix policies from 0029: an admin keeps
-- the whole bucket, an employee gains `{org}/self/{their id}/`. Reading is
-- already granted to the employee role through storage_employee_photos.view.

drop policy if exists employee_photos_self_insert on storage.objects;
drop policy if exists employee_photos_self_update on storage.objects;
drop policy if exists employee_photos_self_delete on storage.objects;

create policy employee_photos_self_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'employee-photos'
              and (storage.foldername(name))[2] = 'self'
              and (storage.foldername(name))[3] = app.my_employee_id(app.storage_org(name))::text);

create policy employee_photos_self_update on storage.objects for update to authenticated
  using      (bucket_id = 'employee-photos'
              and (storage.foldername(name))[2] = 'self'
              and (storage.foldername(name))[3] = app.my_employee_id(app.storage_org(name))::text)
  with check (bucket_id = 'employee-photos'
              and (storage.foldername(name))[2] = 'self'
              and (storage.foldername(name))[3] = app.my_employee_id(app.storage_org(name))::text);

create policy employee_photos_self_delete on storage.objects for delete to authenticated
  using (bucket_id = 'employee-photos'
         and (storage.foldername(name))[2] = 'self'
         and (storage.foldername(name))[3] = app.my_employee_id(app.storage_org(name))::text);


-- ############################################################################
-- ## 0033_edgebrain.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0033 — EdgeBrain: the persistent semantic company representation
--
-- Supabase stays the single source of truth. EdgeBrain is a DERIVED projection
-- of it: one node per authoritative row, one edge per authoritative
-- relationship, plus aggregates computed here in SQL rather than by an LLM
-- reading raw transactional rows.
--
-- ─── Why nodes and edges rather than one JSON document ──────────────────────
-- A single company-wide JSON blob has to be regenerated wholesale whenever any
-- row changes, cannot be permission-filtered (it is one row, so RLS is
-- all-or-nothing), and cannot be searched without loading it. The brain here is
-- modular: each knowledge object is its own row, carries its own permission
-- resource, and is upserted independently. Collectively they behave as one
-- brain; individually they are incrementally maintainable.
--
-- ─── The four kinds of knowledge, kept separate ─────────────────────────────
--   brain_nodes.facts     authoritative — copied verbatim from the source row,
--                         stamped with source_table / entity_id / source_updated_at
--   brain_nodes.metrics   derived — computed here, per entity
--   brain_metrics         derived — computed here, org-wide aggregates
--   brain_insights        AI-generated hypotheses. NEVER mixed into facts, always
--                         carries model, confidence and the nodes it was drawn from
-- Nothing in this file lets an LLM write to the first three.
--
-- ─── Permissions ────────────────────────────────────────────────────────────
-- Every node and metric carries the permission_resources key of the table it
-- came from, and its RLS policy is app.has_permission(org_id, resource, 'view')
-- — the same check the source table's own policy makes. A role that cannot read
-- employees cannot read the employee nodes, so no retrieval path, including the
-- AI's, can widen access. Edges denormalise both endpoints' resources so an
-- edge is visible only when both ends are.
--
-- Writes are service-role only: there is no insert/update/delete policy for
-- `authenticated` at all. The brain is rebuilt by the sync engine or not at all.
--
-- ─── On embeddings ──────────────────────────────────────────────────────────
-- Deliberately none. Vector search earns its cost on unstructured prose; this
-- corpus is short labelled records whose identity is a name, a number or a
-- code, where lexical + trigram matching is both more precise and exactly
-- reproducible ("INV-2026-0041" must match that invoice, not one near it in
-- embedding space). Dumping every transactional row into a vector index would
-- also put an unfilterable copy of tenant data in a second place. Prose that
-- genuinely benefits — ai_company_memory, notes — is reachable through the same
-- full-text index. Revisit only for a corpus that is actually prose.
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists pg_trgm;

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Tables
-- ═════════════════════════════════════════════════════════════════════════════

-- One row per organization: is there a brain, how healthy is it, when did it
-- last agree with Postgres.
create table public.brain_state (
  org_id                 uuid primary key references public.organizations(id) on delete cascade,
  status                 text not null default 'absent'
                           check (status in ('absent','building','ready','error')),
  schema_version         integer not null default 1,
  initialized_at         timestamptz,
  last_full_sync_at      timestamptz,
  last_sync_at           timestamptz,
  last_sync_mode         text check (last_sync_mode in ('full','incremental')),
  last_sync_ms           integer,
  node_count             integer not null default 0,
  edge_count             integer not null default 0,
  metric_count           integer not null default 0,
  -- Per-domain: rows seen, nodes written, and the error if that domain failed.
  -- This is what makes a PARTIAL failure visible rather than silent.
  coverage               jsonb   not null default '{}'::jsonb,
  failed_domains         text[]  not null default '{}',
  last_error             text,
  updated_at             timestamptz not null default now()
);
comment on table public.brain_state is
  'EdgeBrain health per organization. Derived bookkeeping; never a source of truth.';

-- The knowledge objects. One per authoritative row in a source table.
create table public.brain_nodes (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations(id) on delete cascade,

  -- What this is ('employee', 'invoice', 'client', …) and which row it projects.
  kind              text not null check (kind ~ '^[a-z][a-z0-9_]{1,40}$'),
  entity_id         uuid not null,

  -- Provenance. Every fact in the brain can name the table and row it came from
  -- and the moment that row last changed.
  source_table      text not null,
  source_updated_at timestamptz,

  -- The permission_resources key governing this node. NULL means "any member of
  -- the org may see it" (the organization profile itself), which mirrors
  -- organizations_select being a tenancy check rather than a role check.
  resource          text references public.permission_resources(key)
                      on update cascade on delete restrict,

  label             text not null,
  summary           text,
  state             text,                                   -- status/stage, for filtering

  facts             jsonb not null default '{}'::jsonb,     -- authoritative, verbatim
  metrics           jsonb not null default '{}'::jsonb,     -- derived, per entity

  synced_at         timestamptz not null default now(),
  -- Soft tombstone: the source row is gone. Kept (and excluded from every read)
  -- so "this customer was deleted on the 3rd" stays answerable as history.
  deleted_at        timestamptz,

  search_text       tsvector generated always as (
                      to_tsvector('simple'::regconfig,
                        coalesce(label, '') || ' ' || coalesce(summary, '') || ' ' ||
                        coalesce(state, '') || ' ' || kind)
                    ) stored,

  unique (org_id, kind, entity_id)
);
create index brain_nodes_org_kind_idx  on public.brain_nodes (org_id, kind) where deleted_at is null;
create index brain_nodes_org_res_idx   on public.brain_nodes (org_id, resource) where deleted_at is null;
create index brain_nodes_search_idx    on public.brain_nodes using gin (search_text);
create index brain_nodes_label_trgm_idx on public.brain_nodes using gin (label gin_trgm_ops);
create index brain_nodes_entity_idx    on public.brain_nodes (org_id, entity_id);
create index brain_nodes_stale_idx     on public.brain_nodes (org_id, synced_at);

comment on column public.brain_nodes.facts is
  'Authoritative values copied from the source row. Never AI-written.';
comment on column public.brain_nodes.metrics is
  'Derived per-entity figures computed in SQL. Never AI-written.';

-- The relationships. Derived wholly from foreign keys — never inferred.
create table public.brain_edges (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  src_id        uuid not null references public.brain_nodes(id) on delete cascade,
  dst_id        uuid not null references public.brain_nodes(id) on delete cascade,
  rel           text not null check (rel ~ '^[a-z][a-z0-9_]{1,40}$'),

  -- Denormalised from the endpoints so visibility is one predicate, not a join
  -- back into brain_nodes from inside brain_nodes' own policy.
  src_resource  text,
  dst_resource  text,

  facts         jsonb not null default '{}'::jsonb,
  synced_at     timestamptz not null default now(),

  unique (org_id, src_id, dst_id, rel),
  constraint brain_edges_no_self_loop check (src_id <> dst_id)
);
create index brain_edges_src_idx on public.brain_edges (org_id, src_id);
create index brain_edges_dst_idx on public.brain_edges (org_id, dst_id);
create index brain_edges_rel_idx on public.brain_edges (org_id, rel);

-- Org-wide aggregates, computed in Postgres. The LLM is told these numbers; it
-- is never asked to derive them by adding up rows it was shown.
create table public.brain_metrics (
  org_id      uuid not null references public.organizations(id) on delete cascade,
  key         text not null,                       -- 'revenue.collected'
  bucket      text not null default '',            -- '2026-08', a dept uuid, or ''
  value       numeric(18,2),
  value_text  text,
  dims        jsonb not null default '{}'::jsonb,
  as_of       date  not null default current_date,
  computed_at timestamptz not null default now(),
  -- Plain-English definition, handed to the model with the number so it cannot
  -- quietly redefine what "revenue" means.
  definition  text,
  resource    text references public.permission_resources(key)
                on update cascade on delete restrict,
  primary key (org_id, key, bucket)
);
create index brain_metrics_org_key_idx on public.brain_metrics (org_id, key);

-- Every sync attempt, successful or not.
create table public.brain_sync_runs (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,
  mode           text not null check (mode in ('full','incremental')),
  status         text not null default 'running'
                   check (status in ('running','ok','partial','error')),
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  duration_ms    integer,
  nodes_upserted integer not null default 0,
  nodes_removed  integer not null default 0,
  edges_upserted integer not null default 0,
  domains        jsonb not null default '{}'::jsonb,
  errors         jsonb not null default '[]'::jsonb,
  triggered_by   uuid references auth.users(id) on delete set null
);
create index brain_sync_runs_org_idx on public.brain_sync_runs (org_id, started_at desc);

-- AI output, quarantined. Separate table, its own provenance, never merged into
-- facts or metrics, and always renderable as "the model suggested" rather than
-- "the company's records show".
create table public.brain_insights (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  kind         text not null default 'observation'
                 check (kind in ('observation','hypothesis','risk','opportunity')),
  title        text not null,
  body         text not null,
  confidence   numeric(3,2) check (confidence is null or confidence between 0 and 1),
  model        text,
  -- Which nodes this was drawn from: the provenance that lets a reader check it.
  source_nodes uuid[] not null default '{}',
  -- The resources the generating context touched. An insight is shown only to
  -- someone who could have read everything that produced it.
  resources    text[] not null default '{}',
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz
);
create index brain_insights_org_idx on public.brain_insights (org_id, created_at desc);

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Permission resource
-- ═════════════════════════════════════════════════════════════════════════════
-- `view`   — see the brain at all
-- `create` — build it the first time
-- `edit`   — resynchronise it
-- There is no `delete`: the brain is derived, and dropping it is a resync away.
insert into public.permission_resources (key, label, category, description, actions, sort_order) values
  ('edgebrain', 'Company Brain', 'Organization',
   'EdgeBrain''s derived view of the company. Each node is still governed by the permission of the table it came from, so this row grants access to the brain, never to data the role could not already read.',
   array['view','create','edit'], 90);

insert into public.role_permission_defaults (role, resource, can_view, can_create, can_edit, can_delete)
select r.key, 'edgebrain',
       r.key in ('owner','admin','member','viewer'),
       r.key in ('owner','admin','member'),
       r.key in ('owner','admin','member'),
       false
  from public.roles r;

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Row level security
-- ═════════════════════════════════════════════════════════════════════════════
-- Reads are RLS-enforced for `authenticated` so the browser can query the brain
-- directly and still be confined to what the role may see. Writes have no
-- policy at all: only the service role (which bypasses RLS) runs the sync.

alter table public.brain_state     enable row level security;
alter table public.brain_nodes     enable row level security;
alter table public.brain_edges     enable row level security;
alter table public.brain_metrics   enable row level security;
alter table public.brain_sync_runs enable row level security;
alter table public.brain_insights  enable row level security;

alter table public.brain_state     force row level security;
alter table public.brain_nodes     force row level security;
alter table public.brain_edges     force row level security;
alter table public.brain_metrics   force row level security;
alter table public.brain_sync_runs force row level security;
alter table public.brain_insights  force row level security;

revoke all on public.brain_state, public.brain_nodes, public.brain_edges,
              public.brain_metrics, public.brain_sync_runs, public.brain_insights
  from anon;

grant select on public.brain_state, public.brain_nodes, public.brain_edges,
                public.brain_metrics, public.brain_sync_runs, public.brain_insights
  to authenticated;

create policy brain_state_select on public.brain_state for select to authenticated
  using (app.has_permission(org_id, 'edgebrain', 'view'));

-- The node's own resource decides, exactly as the source table's policy would.
create policy brain_nodes_select on public.brain_nodes for select to authenticated
  using (
    deleted_at is null
    and app.has_permission(org_id, 'edgebrain', 'view')
    and case
          when resource is null then app.is_member(org_id)
          else app.has_permission(org_id, resource, 'view')
        end
  );

create policy brain_edges_select on public.brain_edges for select to authenticated
  using (
    app.has_permission(org_id, 'edgebrain', 'view')
    and case when src_resource is null then app.is_member(org_id)
             else app.has_permission(org_id, src_resource, 'view') end
    and case when dst_resource is null then app.is_member(org_id)
             else app.has_permission(org_id, dst_resource, 'view') end
  );

create policy brain_metrics_select on public.brain_metrics for select to authenticated
  using (
    app.has_permission(org_id, 'edgebrain', 'view')
    and case when resource is null then app.is_member(org_id)
             else app.has_permission(org_id, resource, 'view') end
  );

create policy brain_sync_runs_select on public.brain_sync_runs for select to authenticated
  using (app.has_permission(org_id, 'edgebrain', 'view'));

-- An insight is visible only to someone who holds `view` on every resource that
-- went into producing it.
create policy brain_insights_select on public.brain_insights for select to authenticated
  using (
    app.has_permission(org_id, 'edgebrain', 'view')
    and not exists (
      select 1 from unnest(resources) r
       where not app.has_permission(org_id, r, 'view')
    )
  );

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. Sync helpers
-- ═════════════════════════════════════════════════════════════════════════════

-- Marks nodes of one kind whose source row no longer exists. Deletes propagate
-- through this sweep rather than through a trigger on twenty source tables: the
-- sweep is an index-only anti-join, it is idempotent, and it cannot be defeated
-- by a bulk delete that skipped triggers.
create or replace function app.brain_tombstone(p_org uuid, p_kind text, p_live_ids uuid[])
returns integer language plpgsql set search_path = public, pg_temp as $$
declare n integer;
begin
  update public.brain_nodes b
     set deleted_at = now(), synced_at = now()
   where b.org_id = p_org and b.kind = p_kind and b.deleted_at is null
     and not (b.entity_id = any(p_live_ids));
  get diagnostics n = row_count;
  return n;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. Domain projections
-- ═════════════════════════════════════════════════════════════════════════════
-- Each returns {"rows": n, "nodes": n, "removed": n}. `p_since` null means a
-- full pass; otherwise only rows whose source changed after it are re-projected.
-- The tombstone sweep always runs in full: a delete has no updated_at.

-- ─── Organization, plan, usage, memory ───────────────────────────────────────
create or replace function app.brain_sync_org(p_org uuid, p_since timestamptz default null)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare v_nodes integer := 0; v_n integer;
begin
  insert into public.brain_nodes
    (org_id, kind, entity_id, source_table, source_updated_at, resource, label, summary, state, facts, metrics, synced_at, deleted_at)
  select o.id, 'organization', o.id, 'organizations', o.updated_at, null,
         o.company_name,
         concat_ws(' · ', nullif(o.company_tagline,''), nullif(o.industry,''),
                   nullif(concat_ws(', ', o.city, o.country), '')),
         case when o.deleted_at is null then 'active' else 'deleted' end,
         jsonb_strip_nulls(jsonb_build_object(
           'company_name', o.company_name, 'tagline', o.company_tagline,
           'email', o.company_email, 'phone', o.company_phone, 'website', o.company_website,
           'address', o.company_address, 'description', o.company_description,
           'industry', o.industry, 'country', o.country, 'city', o.city,
           'company_size', o.company_size, 'owner_name', o.owner_full_name,
           'document_designation', o.document_designation,
           'created_at', o.created_at)),
         '{}'::jsonb, now(), null
    from public.organizations o
   where o.id = p_org and (p_since is null or o.updated_at > p_since)
  on conflict (org_id, kind, entity_id) do update
    set label = excluded.label, summary = excluded.summary, state = excluded.state,
        facts = excluded.facts, source_updated_at = excluded.source_updated_at,
        synced_at = now(), deleted_at = null;
  get diagnostics v_n = row_count; v_nodes := v_nodes + v_n;

  -- Plan. `subscriptions` is view-only for everyone and never client-written.
  insert into public.brain_nodes
    (org_id, kind, entity_id, source_table, source_updated_at, resource, label, summary, state, facts, synced_at, deleted_at)
  select s.org_id, 'subscription', s.org_id, 'subscriptions', s.updated_at, 'subscriptions',
         initcap(s.plan::text) || ' plan', 'Current subscription', s.status,
         jsonb_strip_nulls(jsonb_build_object(
           'plan', s.plan, 'status', s.status, 'provider', s.provider,
           'current_period_end', s.current_period_end, 'cancel_at', s.cancel_at)),
         now(), null
    from public.subscriptions s
   where s.org_id = p_org and (p_since is null or s.updated_at > p_since)
  on conflict (org_id, kind, entity_id) do update
    set label = excluded.label, state = excluded.state, facts = excluded.facts,
        source_updated_at = excluded.source_updated_at, synced_at = now(), deleted_at = null;
  get diagnostics v_n = row_count; v_nodes := v_nodes + v_n;

  -- Plan usage.
  insert into public.brain_nodes
    (org_id, kind, entity_id, source_table, source_updated_at, resource, label, summary, facts, synced_at, deleted_at)
  select u.org_id, 'usage', u.org_id, 'usage_counters', u.updated_at, 'usage_counters',
         'Plan usage', 'Documents issued against the plan''s allowance',
         jsonb_build_object(
           'offer_letters', u.offer_letters, 'certificates', u.certificates,
           'nda', u.nda, 'mou', u.mou, 'invoices', u.invoices,
           'quotations', u.quotations, 'proformas', u.proformas),
         now(), null
    from public.usage_counters u
   where u.org_id = p_org and (p_since is null or u.updated_at > p_since)
  on conflict (org_id, kind, entity_id) do update
    set facts = excluded.facts, source_updated_at = excluded.source_updated_at,
        synced_at = now(), deleted_at = null;
  get diagnostics v_n = row_count; v_nodes := v_nodes + v_n;

  -- What the AI co-founder was already told to remember. Carried in as prose so
  -- retrieval can reach it, not re-derived.
  insert into public.brain_nodes
    (org_id, kind, entity_id, source_table, source_updated_at, resource, label, summary, facts, synced_at, deleted_at)
  select m.org_id, 'memory', m.org_id, 'ai_company_memory', m.updated_at, 'ai_company_memory',
         'Company memory', left(regexp_replace(m.memory::text, '[{}"]', '', 'g'), 400),
         m.memory, now(), null
    from public.ai_company_memory m
   where m.org_id = p_org and (p_since is null or m.updated_at > p_since)
  on conflict (org_id, kind, entity_id) do update
    set summary = excluded.summary, facts = excluded.facts,
        source_updated_at = excluded.source_updated_at, synced_at = now(), deleted_at = null;
  get diagnostics v_n = row_count; v_nodes := v_nodes + v_n;

  return jsonb_build_object('nodes', v_nodes, 'removed', 0);
end $$;

-- ─── People: departments, employees, logins ──────────────────────────────────
create or replace function app.brain_sync_people(p_org uuid, p_since timestamptz default null)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare v_nodes integer := 0; v_removed integer := 0; v_n integer;
begin
  insert into public.brain_nodes
    (org_id, kind, entity_id, source_table, source_updated_at, resource, label, summary, state, facts, metrics, synced_at, deleted_at)
  select d.org_id, 'department', d.id, 'departments', d.created_at, 'departments',
         d.name, 'Department', 'active',
         jsonb_build_object('name', d.name, 'created_at', d.created_at),
         jsonb_build_object('headcount',
           (select count(*) from public.employees e
             where e.department_id = d.id and e.exited_at is null)),
         now(), null
    from public.departments d
   where d.org_id = p_org
  on conflict (org_id, kind, entity_id) do update
    set label = excluded.label, metrics = excluded.metrics,
        synced_at = now(), deleted_at = null;
  get diagnostics v_n = row_count; v_nodes := v_nodes + v_n;

  v_removed := v_removed + app.brain_tombstone(p_org, 'department',
    coalesce((select array_agg(id) from public.departments where org_id = p_org), '{}'::uuid[]));

  -- Employees. Compensation is deliberately absent: employee_compensation is
  -- owner/admin-only and is not a permission_resource, so there is no resource
  -- key that could gate a node holding pay. Putting salary in the brain would
  -- mean inventing one — the brain does not get to widen access.
  insert into public.brain_nodes
    (org_id, kind, entity_id, source_table, source_updated_at, resource, label, summary, state, facts, metrics, synced_at, deleted_at)
  select e.org_id, 'employee', e.id, 'employees', e.updated_at, 'employees',
         e.full_name,
         concat_ws(' · ', nullif(e.role,''), d.name, e.employment_type::text),
         case when e.exited_at is null then 'active' else 'exited' end,
         jsonb_strip_nulls(jsonb_build_object(
           'full_name', e.full_name, 'email', e.email, 'phone', e.phone,
           'role', e.role, 'department', d.name, 'department_id', e.department_id,
           'employment_type', e.employment_type, 'reports_to', e.reports_to,
           'supervisor_name', e.supervisor_name, 'responsibilities', e.responsibilities,
           'is_owner', e.is_owner, 'start_date', e.start_date, 'end_date', e.end_date,
           'exited_at', e.exited_at, 'exit_reason', e.exit_reason,
           'created_at', e.created_at)),
         jsonb_build_object(
           'open_tasks', (select count(*) from public.tasks t
                           where t.assignee_id = e.id and t.status <> 'done'),
           'direct_reports', (select count(*) from public.employees r
                               where r.reports_to = e.id and r.exited_at is null),
           'tenure_days', case when e.start_date is null then null
                          else (coalesce(e.exited_at::date, current_date) - e.start_date) end),
         now(), null
    from public.employees e
    left join public.departments d on d.id = e.department_id
   where e.org_id = p_org and (p_since is null or e.updated_at > p_since)
  on conflict (org_id, kind, entity_id) do update
    set label = excluded.label, summary = excluded.summary, state = excluded.state,
        facts = excluded.facts, metrics = excluded.metrics,
        source_updated_at = excluded.source_updated_at, synced_at = now(), deleted_at = null;
  get diagnostics v_n = row_count; v_nodes := v_nodes + v_n;

  v_removed := v_removed + app.brain_tombstone(p_org, 'employee',
    coalesce((select array_agg(id) from public.employees where org_id = p_org), '{}'::uuid[]));

  -- Who holds a login, and in which role.
  --
  -- No employee name is attached. memberships has no employee FK, and matching
  -- one by email would be a guess presented as a fact — exactly the thing this
  -- table exists to avoid. The membership is projected as what it actually is:
  -- an access grant to a user id.
  insert into public.brain_nodes
    (org_id, kind, entity_id, source_table, source_updated_at, resource, label, summary, state, facts, synced_at, deleted_at)
  select m.org_id, 'membership', m.id, 'memberships', m.created_at, 'memberships',
         initcap(m.role) || ' access',
         'Workspace login · ' || m.role || ' since ' || to_char(m.created_at, 'DD Mon YYYY'),
         m.role,
         jsonb_build_object(
           'role', m.role, 'user_id', m.user_id, 'created_at', m.created_at),
         now(), null
    from public.memberships m
   where m.org_id = p_org
  on conflict (org_id, kind, entity_id) do update
    set label = excluded.label, summary = excluded.summary, state = excluded.state,
        facts = excluded.facts, synced_at = now(), deleted_at = null;
  get diagnostics v_n = row_count; v_nodes := v_nodes + v_n;

  v_removed := v_removed + app.brain_tombstone(p_org, 'membership',
    coalesce((select array_agg(id) from public.memberships where org_id = p_org), '{}'::uuid[]));

  return jsonb_build_object('nodes', v_nodes, 'removed', v_removed);
end $$;

-- ─── Clients, and the legacy customer/lead tables still in use ───────────────
create or replace function app.brain_sync_clients(p_org uuid, p_since timestamptz default null)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare v_nodes integer := 0; v_removed integer := 0; v_n integer;
begin
  insert into public.brain_nodes
    (org_id, kind, entity_id, source_table, source_updated_at, resource, label, summary, state, facts, metrics, synced_at, deleted_at)
  select c.org_id, 'client', c.id, 'clients', c.updated_at, 'clients',
         c.name,
         concat_ws(' · ', nullif(c.person_name,''), nullif(c.email::text,''),
                   nullif(c.state,''), c.status::text),
         c.status::text,
         jsonb_strip_nulls(jsonb_build_object(
           'name', c.name, 'person_name', c.person_name, 'email', c.email,
           'phone', c.phone, 'address', c.address, 'gstin', c.gstin,
           'state', c.state, 'country_code', c.country_code, 'status', c.status,
           'status_changed_at', c.status_changed_at, 'pipeline_value', c.value,
           'source', c.source, 'notes', c.notes, 'archived_at', c.archived_at,
           'created_at', c.created_at)),
         jsonb_build_object(
           'invoices', (select count(*) from public.financial_documents f
                         where f.org_id = c.org_id and f.customer_id = c.id),
           'billed_total', coalesce((select sum(f.grand_total) from public.financial_documents f
                                      where f.org_id = c.org_id and f.customer_id = c.id
                                        and f.type = 'invoice' and f.status <> 'cancelled'), 0),
           'collected_total', coalesce((select sum(f.amount_paid) from public.financial_documents f
                                         where f.org_id = c.org_id and f.customer_id = c.id
                                           and f.type = 'invoice'), 0)),
         now(), null
    from public.clients c
   where c.org_id = p_org and (p_since is null or c.updated_at > p_since)
  on conflict (org_id, kind, entity_id) do update
    set label = excluded.label, summary = excluded.summary, state = excluded.state,
        facts = excluded.facts, metrics = excluded.metrics,
        source_updated_at = excluded.source_updated_at, synced_at = now(), deleted_at = null;
  get diagnostics v_n = row_count; v_nodes := v_nodes + v_n;

  v_removed := v_removed + app.brain_tombstone(p_org, 'client',
    coalesce((select array_agg(id) from public.clients where org_id = p_org), '{}'::uuid[]));

  -- The legacy customers table. 0018 repointed financial_documents.customer_id
  -- and recurring_invoices.customer_id at clients, so nothing bills to a
  -- customer row any more and its billed_total will read zero — but rows remain
  -- in orgs that predate the unification, and a record that exists and is
  -- invisible to the brain is worse than one that is present and empty. It
  -- keeps its own permission resource, so a role that cannot read the legacy
  -- table cannot read it here either. Drops out on its own when the pending
  -- legacy-table migration runs.
  insert into public.brain_nodes
    (org_id, kind, entity_id, source_table, source_updated_at, resource, label, summary, state, facts, metrics, synced_at, deleted_at)
  select c.org_id, 'customer', c.id, 'customers', c.updated_at, 'customers',
         c.name, concat_ws(' · ', nullif(c.email::text,''), nullif(c.state,'')), 'active',
         jsonb_strip_nulls(jsonb_build_object(
           'name', c.name, 'email', c.email, 'phone', c.phone, 'address', c.address,
           'gstin', c.gstin, 'state', c.state, 'created_at', c.created_at)),
         jsonb_build_object(
           'invoices', (select count(*) from public.financial_documents f
                         where f.org_id = c.org_id and f.customer_id = c.id),
           'billed_total', coalesce((select sum(f.grand_total) from public.financial_documents f
                                      where f.org_id = c.org_id and f.customer_id = c.id
                                        and f.type = 'invoice' and f.status <> 'cancelled'), 0)),
         now(), null
    from public.customers c
   where c.org_id = p_org and (p_since is null or c.updated_at > p_since)
  on conflict (org_id, kind, entity_id) do update
    set label = excluded.label, summary = excluded.summary, facts = excluded.facts,
        metrics = excluded.metrics, source_updated_at = excluded.source_updated_at,
        synced_at = now(), deleted_at = null;
  get diagnostics v_n = row_count; v_nodes := v_nodes + v_n;

  v_removed := v_removed + app.brain_tombstone(p_org, 'customer',
    coalesce((select array_agg(id) from public.customers where org_id = p_org), '{}'::uuid[]));

  return jsonb_build_object('nodes', v_nodes, 'removed', v_removed);
end $$;

-- ─── Catalogue ───────────────────────────────────────────────────────────────
create or replace function app.brain_sync_catalog(p_org uuid, p_since timestamptz default null)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare v_nodes integer := 0; v_removed integer := 0; v_n integer;
begin
  -- units_sold / revenue / revenue_paid are trigger-maintained rollups (0011),
  -- so they are carried as derived metrics with the catalogue's own definition
  -- of "sold" rather than recomputed here into a second, disagreeing number.
  insert into public.brain_nodes
    (org_id, kind, entity_id, source_table, source_updated_at, resource, label, summary, state, facts, metrics, synced_at, deleted_at)
  select c.org_id, 'product', c.id, 'catalog_items', c.updated_at, 'catalog_items',
         c.name,
         concat_ws(' · ', nullif(c.sku,''), nullif(c.category,''),
                   'from ' || to_char(c.unit_price, 'FM999999990.00') || ' / ' || c.unit),
         case when c.archived_at is null then 'active' else 'archived' end,
         jsonb_strip_nulls(jsonb_build_object(
           'name', c.name, 'sku', c.sku, 'description', c.description,
           'category', c.category, 'unit_price', c.unit_price, 'unit', c.unit,
           'hsn_sac', c.hsn_sac, 'tax_rate', c.tax_rate,
           'track_inventory', c.track_inventory,
           'stock_qty', case when c.track_inventory then c.stock_qty end,
           'low_stock_at', c.low_stock_at, 'archived_at', c.archived_at,
           'created_at', c.created_at)),
         jsonb_build_object(
           'units_sold', c.units_sold, 'revenue_billed', c.revenue,
           'revenue_collected', c.revenue_paid, 'invoice_count', c.invoice_count,
           'last_sold_at', c.last_sold_at),
         now(), null
    from public.catalog_items c
   where c.org_id = p_org and (p_since is null or c.updated_at > p_since)
  on conflict (org_id, kind, entity_id) do update
    set label = excluded.label, summary = excluded.summary, state = excluded.state,
        facts = excluded.facts, metrics = excluded.metrics,
        source_updated_at = excluded.source_updated_at, synced_at = now(), deleted_at = null;
  get diagnostics v_n = row_count; v_nodes := v_nodes + v_n;

  v_removed := v_removed + app.brain_tombstone(p_org, 'product',
    coalesce((select array_agg(id) from public.catalog_items where org_id = p_org), '{}'::uuid[]));

  return jsonb_build_object('nodes', v_nodes, 'removed', v_removed);
end $$;

-- ─── Finance: invoices, quotes, proformas, payments, recurring ───────────────
create or replace function app.brain_sync_finance(p_org uuid, p_since timestamptz default null)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare v_nodes integer := 0; v_removed integer := 0; v_n integer;
begin
  -- Line items are folded into the document's facts rather than made nodes:
  -- they have no independent identity, and one node per line would multiply the
  -- graph by an order of magnitude to say nothing a reader asks about on its own.
  insert into public.brain_nodes
    (org_id, kind, entity_id, source_table, source_updated_at, resource, label, summary, state, facts, metrics, synced_at, deleted_at)
  select f.org_id, 'financial_document', f.id, 'financial_documents', f.updated_at, 'financial_documents',
         f.doc_number,
         concat_ws(' · ', initcap(f.type::text), f.bill_to_name,
                   f.currency || ' ' || to_char(f.grand_total, 'FM999999990.00'), f.status::text),
         f.status::text,
         jsonb_strip_nulls(jsonb_build_object(
           'doc_number', f.doc_number, 'type', f.type, 'status', f.status,
           'revision', f.revision, 'customer_id', f.customer_id,
           'bill_to_name', f.bill_to_name, 'bill_to_email', f.bill_to_email,
           'bill_to_state', f.bill_to_state, 'bill_to_gstin', f.bill_to_gstin,
           'issue_date', f.issue_date, 'due_date', f.due_date, 'valid_until', f.valid_until,
           'currency', f.currency, 'subtotal', f.subtotal,
           'discount_amount', f.discount_amount, 'taxable_amount', f.taxable_amount,
           'gst_enabled', f.gst_enabled, 'gst_rate', f.gst_rate, 'gst_amount', f.gst_amount,
           'is_inter_state', f.is_inter_state, 'grand_total', f.grand_total,
           'amount_paid', f.amount_paid, 'advance_percent', f.advance_percent,
           'notes', f.notes, 'created_at', f.created_at,
           'line_items', (select jsonb_agg(jsonb_build_object(
                             'position', li.position, 'description', li.description,
                             'quantity', li.quantity, 'unit', li.unit, 'rate', li.rate,
                             'hsn_sac', li.hsn_sac, 'line_total', li.line_total,
                             'catalog_item_id', li.catalog_item_id)
                           order by li.position)
                           from public.document_line_items li where li.document_id = f.id))),
         jsonb_build_object(
           'outstanding', greatest(f.grand_total - f.amount_paid, 0),
           'days_overdue', case
             when f.due_date is not null and f.amount_paid < f.grand_total - 0.01
                  and f.due_date < current_date
             then current_date - f.due_date else 0 end,
           'payment_count', (select count(*) from public.payments p where p.document_id = f.id)),
         now(), null
    from public.financial_documents f
   where f.org_id = p_org and (p_since is null or f.updated_at > p_since)
  on conflict (org_id, kind, entity_id) do update
    set label = excluded.label, summary = excluded.summary, state = excluded.state,
        facts = excluded.facts, metrics = excluded.metrics,
        source_updated_at = excluded.source_updated_at, synced_at = now(), deleted_at = null;
  get diagnostics v_n = row_count; v_nodes := v_nodes + v_n;

  v_removed := v_removed + app.brain_tombstone(p_org, 'financial_document',
    coalesce((select array_agg(id) from public.financial_documents where org_id = p_org), '{}'::uuid[]));

  insert into public.brain_nodes
    (org_id, kind, entity_id, source_table, source_updated_at, resource, label, summary, state, facts, synced_at, deleted_at)
  select p.org_id, 'payment', p.id, 'payments', p.created_at, 'payments',
         to_char(p.amount, 'FM999999990.00') || ' on ' || to_char(p.paid_on, 'DD Mon YYYY'),
         concat_ws(' · ', 'Payment against ' || f.doc_number, nullif(p.method,''), nullif(p.reference,'')),
         case when p.confirmed_at is null then 'unconfirmed' else 'confirmed' end,
         jsonb_strip_nulls(jsonb_build_object(
           'amount', p.amount, 'paid_on', p.paid_on, 'method', p.method,
           'reference', p.reference, 'note', p.note, 'document_id', p.document_id,
           'document_number', f.doc_number,
           'submitted_by_recipient', p.submitted_by_recipient,
           'confirmed_at', p.confirmed_at, 'created_at', p.created_at)),
         now(), null
    from public.payments p
    join public.financial_documents f on f.id = p.document_id
   where p.org_id = p_org
  on conflict (org_id, kind, entity_id) do update
    set label = excluded.label, summary = excluded.summary, state = excluded.state,
        facts = excluded.facts, synced_at = now(), deleted_at = null;
  get diagnostics v_n = row_count; v_nodes := v_nodes + v_n;

  v_removed := v_removed + app.brain_tombstone(p_org, 'payment',
    coalesce((select array_agg(id) from public.payments where org_id = p_org), '{}'::uuid[]));

  insert into public.brain_nodes
    (org_id, kind, entity_id, source_table, source_updated_at, resource, label, summary, state, facts, synced_at, deleted_at)
  select r.org_id, 'recurring_invoice', r.id, 'recurring_invoices', r.updated_at, 'recurring_invoices',
         r.bill_to_name || ' · ' || r.frequency,
         'Recurring ' || r.frequency || ' · next ' || coalesce(to_char(r.next_invoice_date, 'DD Mon YYYY'), 'unscheduled'),
         case when r.active then 'active' else 'paused' end,
         jsonb_strip_nulls(jsonb_build_object(
           'bill_to_name', r.bill_to_name, 'bill_to_email', r.bill_to_email,
           'customer_id', r.customer_id, 'frequency', r.frequency,
           'start_date', r.start_date, 'end_date', r.end_date,
           'next_invoice_date', r.next_invoice_date, 'total_cycles', r.total_cycles,
           'cycles_completed', r.cycles_completed, 'auto_action', r.auto_action,
           'grand_total', r.grand_total, 'active', r.active, 'created_at', r.created_at)),
         now(), null
    from public.recurring_invoices r
   where r.org_id = p_org and (p_since is null or r.updated_at > p_since)
  on conflict (org_id, kind, entity_id) do update
    set label = excluded.label, summary = excluded.summary, state = excluded.state,
        facts = excluded.facts, source_updated_at = excluded.source_updated_at,
        synced_at = now(), deleted_at = null;
  get diagnostics v_n = row_count; v_nodes := v_nodes + v_n;

  v_removed := v_removed + app.brain_tombstone(p_org, 'recurring_invoice',
    coalesce((select array_agg(id) from public.recurring_invoices where org_id = p_org), '{}'::uuid[]));

  return jsonb_build_object('nodes', v_nodes, 'removed', v_removed);
end $$;

-- ─── Spend: vendors, purchase invoices, expenses ─────────────────────────────
create or replace function app.brain_sync_spend(p_org uuid, p_since timestamptz default null)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare v_nodes integer := 0; v_removed integer := 0; v_n integer;
begin
  insert into public.brain_nodes
    (org_id, kind, entity_id, source_table, source_updated_at, resource, label, summary, state, facts, metrics, synced_at, deleted_at)
  select v.org_id, 'vendor', v.id, 'vendors', v.updated_at, 'vendors',
         v.company_name,
         concat_ws(' · ', nullif(v.contact_name,''), nullif(v.category,''),
                   'net ' || v.payment_terms_days),
         case when v.archived_at is null then 'active' else 'archived' end,
         jsonb_strip_nulls(jsonb_build_object(
           'company_name', v.company_name, 'contact_name', v.contact_name,
           'email', v.email, 'phone', v.phone, 'address', v.address, 'state', v.state,
           'gstin', v.gstin, 'payment_terms_days', v.payment_terms_days,
           'category', v.category, 'notes', v.notes, 'created_at', v.created_at)),
         jsonb_build_object(
           'bills', (select count(*) from public.purchase_invoices pi where pi.vendor_id = v.id),
           'billed_total', coalesce((select sum(pi.total) from public.purchase_invoices pi
                                      where pi.vendor_id = v.id and pi.status <> 'void'), 0),
           'outstanding', coalesce((select sum(pi.total - pi.amount_paid) from public.purchase_invoices pi
                                     where pi.vendor_id = v.id and pi.status in ('unpaid','partially_paid')), 0)),
         now(), null
    from public.vendors v
   where v.org_id = p_org and (p_since is null or v.updated_at > p_since)
  on conflict (org_id, kind, entity_id) do update
    set label = excluded.label, summary = excluded.summary, state = excluded.state,
        facts = excluded.facts, metrics = excluded.metrics,
        source_updated_at = excluded.source_updated_at, synced_at = now(), deleted_at = null;
  get diagnostics v_n = row_count; v_nodes := v_nodes + v_n;

  v_removed := v_removed + app.brain_tombstone(p_org, 'vendor',
    coalesce((select array_agg(id) from public.vendors where org_id = p_org), '{}'::uuid[]));

  insert into public.brain_nodes
    (org_id, kind, entity_id, source_table, source_updated_at, resource, label, summary, state, facts, metrics, synced_at, deleted_at)
  select pi.org_id, 'purchase_invoice', pi.id, 'purchase_invoices', pi.updated_at, 'purchase_invoices',
         pi.bill_number,
         concat_ws(' · ', v.company_name, to_char(pi.total, 'FM999999990.00'), pi.status),
         pi.status,
         jsonb_strip_nulls(jsonb_build_object(
           'bill_number', pi.bill_number, 'vendor_id', pi.vendor_id,
           'vendor_name', v.company_name, 'bill_date', pi.bill_date,
           'due_date', pi.due_date, 'category', pi.category, 'description', pi.description,
           'subtotal', pi.subtotal, 'tax_rate', pi.tax_rate, 'tax_amount', pi.tax_amount,
           'total', pi.total, 'amount_paid', pi.amount_paid, 'status', pi.status,
           'paid_on', pi.paid_on, 'created_at', pi.created_at)),
         jsonb_build_object('outstanding', greatest(pi.total - pi.amount_paid, 0)),
         now(), null
    from public.purchase_invoices pi
    join public.vendors v on v.id = pi.vendor_id
   where pi.org_id = p_org and (p_since is null or pi.updated_at > p_since)
  on conflict (org_id, kind, entity_id) do update
    set label = excluded.label, summary = excluded.summary, state = excluded.state,
        facts = excluded.facts, metrics = excluded.metrics,
        source_updated_at = excluded.source_updated_at, synced_at = now(), deleted_at = null;
  get diagnostics v_n = row_count; v_nodes := v_nodes + v_n;

  v_removed := v_removed + app.brain_tombstone(p_org, 'purchase_invoice',
    coalesce((select array_agg(id) from public.purchase_invoices where org_id = p_org), '{}'::uuid[]));

  insert into public.brain_nodes
    (org_id, kind, entity_id, source_table, source_updated_at, resource, label, summary, state, facts, synced_at, deleted_at)
  select x.org_id, 'expense', x.id, 'expenses', x.created_at, 'expenses',
         x.description,
         concat_ws(' · ', x.category, to_char(x.amount, 'FM999999990.00'),
                   to_char(x.incurred_on, 'DD Mon YYYY')),
         x.category,
         jsonb_build_object(
           'description', x.description, 'amount', x.amount, 'category', x.category,
           'incurred_on', x.incurred_on, 'created_at', x.created_at),
         now(), null
    from public.expenses x
   where x.org_id = p_org
  on conflict (org_id, kind, entity_id) do update
    set label = excluded.label, summary = excluded.summary, state = excluded.state,
        facts = excluded.facts, synced_at = now(), deleted_at = null;
  get diagnostics v_n = row_count; v_nodes := v_nodes + v_n;

  v_removed := v_removed + app.brain_tombstone(p_org, 'expense',
    coalesce((select array_agg(id) from public.expenses where org_id = p_org), '{}'::uuid[]));

  return jsonb_build_object('nodes', v_nodes, 'removed', v_removed);
end $$;

-- ─── Operations: tasks, HR documents, announcements, leave, notifications ────
create or replace function app.brain_sync_ops(p_org uuid, p_since timestamptz default null)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare v_nodes integer := 0; v_removed integer := 0; v_n integer;
begin
  insert into public.brain_nodes
    (org_id, kind, entity_id, source_table, source_updated_at, resource, label, summary, state, facts, metrics, synced_at, deleted_at)
  select t.org_id, 'task', t.id, 'tasks', t.updated_at, 'tasks',
         t.title,
         concat_ws(' · ', t.status::text, t.priority::text || ' priority',
                   coalesce(e.full_name, t.assignee_label),
                   case when t.deadline is not null then 'due ' || to_char(t.deadline, 'DD Mon') end),
         t.status::text,
         jsonb_strip_nulls(jsonb_build_object(
           'title', t.title, 'description', t.description, 'status', t.status,
           'priority', t.priority, 'assignee_id', t.assignee_id,
           'assignee_name', coalesce(e.full_name, t.assignee_label),
           'deadline', t.deadline, 'notes', t.notes, 'created_at', t.created_at)),
         jsonb_build_object('days_to_deadline',
           case when t.deadline is null or t.status = 'done' then null
                else t.deadline - current_date end),
         now(), null
    from public.tasks t
    left join public.employees e on e.id = t.assignee_id
   where t.org_id = p_org and (p_since is null or t.updated_at > p_since)
  on conflict (org_id, kind, entity_id) do update
    set label = excluded.label, summary = excluded.summary, state = excluded.state,
        facts = excluded.facts, metrics = excluded.metrics,
        source_updated_at = excluded.source_updated_at, synced_at = now(), deleted_at = null;
  get diagnostics v_n = row_count; v_nodes := v_nodes + v_n;

  v_removed := v_removed + app.brain_tombstone(p_org, 'task',
    coalesce((select array_agg(id) from public.tasks where org_id = p_org), '{}'::uuid[]));

  -- HR documents. `data` holds the whole form — a legal snapshot whose shape
  -- differs per type and which can carry personal detail — so the brain keeps
  -- the queryable columns and the document's own identity, not the blob.
  insert into public.brain_nodes
    (org_id, kind, entity_id, source_table, source_updated_at, resource, label, summary, state, facts, synced_at, deleted_at)
  select r.org_id, 'record', r.id, 'records', r.updated_at, 'records',
         r.doc_number,
         concat_ws(' · ', initcap(r.type::text), r.title,
                   coalesce(r.recipient_name, e.full_name), r.status::text),
         r.status::text,
         jsonb_strip_nulls(jsonb_build_object(
           'doc_number', r.doc_number, 'type', r.type, 'status', r.status,
           'title', r.title, 'employee_id', r.employee_id,
           'recipient_name', coalesce(r.recipient_name, e.full_name),
           'recipient_email', r.recipient_email, 'issue_date', r.issue_date,
           'created_at', r.created_at)),
         now(), null
    from public.records r
    left join public.employees e on e.id = r.employee_id
   where r.org_id = p_org and (p_since is null or r.updated_at > p_since)
  on conflict (org_id, kind, entity_id) do update
    set label = excluded.label, summary = excluded.summary, state = excluded.state,
        facts = excluded.facts, source_updated_at = excluded.source_updated_at,
        synced_at = now(), deleted_at = null;
  get diagnostics v_n = row_count; v_nodes := v_nodes + v_n;

  v_removed := v_removed + app.brain_tombstone(p_org, 'record',
    coalesce((select array_agg(id) from public.records where org_id = p_org), '{}'::uuid[]));

  insert into public.brain_nodes
    (org_id, kind, entity_id, source_table, source_updated_at, resource, label, summary, state, facts, synced_at, deleted_at)
  select a.org_id, 'announcement', a.id, 'announcements', a.updated_at, 'announcements',
         a.title,
         concat_ws(' · ', coalesce(d.name, 'Whole organisation'),
                   to_char(a.published_at, 'DD Mon YYYY')),
         case when a.expires_at is not null and a.expires_at < now() then 'expired' else 'published' end,
         jsonb_strip_nulls(jsonb_build_object(
           'title', a.title, 'body', a.body, 'department_id', a.department_id,
           'department', d.name, 'is_pinned', a.is_pinned,
           'published_at', a.published_at, 'expires_at', a.expires_at)),
         now(), null
    from public.announcements a
    left join public.departments d on d.id = a.department_id
   where a.org_id = p_org and (p_since is null or a.updated_at > p_since)
  on conflict (org_id, kind, entity_id) do update
    set label = excluded.label, summary = excluded.summary, state = excluded.state,
        facts = excluded.facts, source_updated_at = excluded.source_updated_at,
        synced_at = now(), deleted_at = null;
  get diagnostics v_n = row_count; v_nodes := v_nodes + v_n;

  v_removed := v_removed + app.brain_tombstone(p_org, 'announcement',
    coalesce((select array_agg(id) from public.announcements where org_id = p_org), '{}'::uuid[]));

  insert into public.brain_nodes
    (org_id, kind, entity_id, source_table, source_updated_at, resource, label, summary, state, facts, synced_at, deleted_at)
  select lr.org_id, 'leave_request', lr.id, 'leave_requests', lr.updated_at, 'leave_requests',
         coalesce(e.full_name, 'Employee') || ' · ' || lt.name,
         concat_ws(' · ', to_char(lr.start_date, 'DD Mon') || '–' || to_char(lr.end_date, 'DD Mon YYYY'),
                   lr.days || ' day(s)', lr.status::text),
         lr.status::text,
         jsonb_strip_nulls(jsonb_build_object(
           'employee_id', lr.employee_id, 'employee_name', e.full_name,
           'leave_type', lt.name, 'start_date', lr.start_date, 'end_date', lr.end_date,
           'days', lr.days, 'half_day', lr.half_day, 'status', lr.status,
           'reason', lr.reason, 'decided_at', lr.decided_at,
           'decision_comment', lr.decision_comment, 'created_at', lr.created_at)),
         now(), null
    from public.leave_requests lr
    join public.leave_types lt on lt.id = lr.leave_type_id
    left join public.employees e on e.id = lr.employee_id
   where lr.org_id = p_org and (p_since is null or lr.updated_at > p_since)
  on conflict (org_id, kind, entity_id) do update
    set label = excluded.label, summary = excluded.summary, state = excluded.state,
        facts = excluded.facts, source_updated_at = excluded.source_updated_at,
        synced_at = now(), deleted_at = null;
  get diagnostics v_n = row_count; v_nodes := v_nodes + v_n;

  v_removed := v_removed + app.brain_tombstone(p_org, 'leave_request',
    coalesce((select array_agg(id) from public.leave_requests where org_id = p_org), '{}'::uuid[]));

  -- Recent activity only. Notifications are an unbounded stream and the older
  -- ones answer nothing; 200 is the window the shell itself reads from.
  insert into public.brain_nodes
    (org_id, kind, entity_id, source_table, source_updated_at, resource, label, summary, state, facts, synced_at, deleted_at)
  select n.org_id, 'notification', n.id, 'notifications', n.created_at, 'notifications',
         n.title, concat_ws(' · ', n.message, to_char(n.created_at, 'DD Mon YYYY')), n.type,
         jsonb_strip_nulls(jsonb_build_object(
           'type', n.type, 'title', n.title, 'message', n.message,
           'record_id', n.record_id, 'financial_doc_id', n.financial_doc_id,
           'created_at', n.created_at)),
         now(), null
    from (select * from public.notifications
           where org_id = p_org order by created_at desc limit 200) n
  on conflict (org_id, kind, entity_id) do update
    set label = excluded.label, summary = excluded.summary, facts = excluded.facts,
        synced_at = now(), deleted_at = null;
  get diagnostics v_n = row_count; v_nodes := v_nodes + v_n;

  v_removed := v_removed + app.brain_tombstone(p_org, 'notification',
    coalesce((select array_agg(id) from (
      select id from public.notifications where org_id = p_org
       order by created_at desc limit 200) w), '{}'::uuid[]));

  return jsonb_build_object('nodes', v_nodes, 'removed', v_removed);
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- 6. Relationships
-- ═════════════════════════════════════════════════════════════════════════════
-- Rebuilt in full on every sync rather than incrementally. Edges are narrow
-- index joins over one org's rows — cheap next to the jsonb node payloads — and
-- a full rebuild is the only way an edge whose *other* end changed cannot be
-- left behind. Anything not touched by this pass is stale by definition and is
-- deleted at the end (no tombstone: an edge carries no history of its own).
create or replace function app.brain_rebuild_edges(p_org uuid)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare v_t0 timestamptz := clock_timestamp(); v_edges integer := 0; v_n integer; v_stale integer;
begin
  -- employee → department, employee → manager
  insert into public.brain_edges (org_id, src_id, dst_id, rel, src_resource, dst_resource, synced_at)
  select p_org, sn.id, dn.id, 'belongs_to', sn.resource, dn.resource, clock_timestamp()
    from public.employees e
    join public.brain_nodes sn on sn.org_id = p_org and sn.kind = 'employee'   and sn.entity_id = e.id
    join public.brain_nodes dn on dn.org_id = p_org and dn.kind = 'department' and dn.entity_id = e.department_id
   where e.org_id = p_org and e.department_id is not null
  on conflict (org_id, src_id, dst_id, rel) do update set synced_at = clock_timestamp();
  get diagnostics v_n = row_count; v_edges := v_edges + v_n;

  insert into public.brain_edges (org_id, src_id, dst_id, rel, src_resource, dst_resource, synced_at)
  select p_org, sn.id, dn.id, 'reports_to', sn.resource, dn.resource, clock_timestamp()
    from public.employees e
    join public.brain_nodes sn on sn.org_id = p_org and sn.kind = 'employee' and sn.entity_id = e.id
    join public.brain_nodes dn on dn.org_id = p_org and dn.kind = 'employee' and dn.entity_id = e.reports_to
   where e.org_id = p_org and e.reports_to is not null
  on conflict (org_id, src_id, dst_id, rel) do update set synced_at = clock_timestamp();
  get diagnostics v_n = row_count; v_edges := v_edges + v_n;

  -- There is deliberately no membership → employee edge. memberships carries no
  -- employee FK, and an edge matched on email would be an inference rendered in
  -- the graph as a fact. When the schema grows that column, the edge belongs here.

  -- financial document → customer / client
  insert into public.brain_edges (org_id, src_id, dst_id, rel, src_resource, dst_resource, synced_at)
  select p_org, sn.id, dn.id, 'billed_to', sn.resource, dn.resource, clock_timestamp()
    from public.financial_documents f
    join public.brain_nodes sn on sn.org_id = p_org and sn.kind = 'financial_document' and sn.entity_id = f.id
    join public.brain_nodes dn on dn.org_id = p_org and dn.kind in ('customer','client') and dn.entity_id = f.customer_id
   where f.org_id = p_org and f.customer_id is not null
  on conflict (org_id, src_id, dst_id, rel) do update set synced_at = clock_timestamp();
  get diagnostics v_n = row_count; v_edges := v_edges + v_n;

  -- payment → document
  insert into public.brain_edges (org_id, src_id, dst_id, rel, src_resource, dst_resource, facts, synced_at)
  select p_org, sn.id, dn.id, 'pays', sn.resource, dn.resource,
         jsonb_build_object('amount', p.amount, 'paid_on', p.paid_on), clock_timestamp()
    from public.payments p
    join public.brain_nodes sn on sn.org_id = p_org and sn.kind = 'payment'            and sn.entity_id = p.id
    join public.brain_nodes dn on dn.org_id = p_org and dn.kind = 'financial_document' and dn.entity_id = p.document_id
   where p.org_id = p_org
  on conflict (org_id, src_id, dst_id, rel) do update
    set facts = excluded.facts, synced_at = clock_timestamp();
  get diagnostics v_n = row_count; v_edges := v_edges + v_n;

  -- document → product, through the line items. Quantity and value are summed
  -- so one edge carries what that customer bought of that product on that doc.
  insert into public.brain_edges (org_id, src_id, dst_id, rel, src_resource, dst_resource, facts, synced_at)
  select p_org, sn.id, dn.id, 'includes', sn.resource, dn.resource,
         jsonb_build_object('quantity', sum(li.quantity), 'line_total', sum(li.line_total)),
         clock_timestamp()
    from public.document_line_items li
    join public.brain_nodes sn on sn.org_id = p_org and sn.kind = 'financial_document' and sn.entity_id = li.document_id
    join public.brain_nodes dn on dn.org_id = p_org and dn.kind = 'product'             and dn.entity_id = li.catalog_item_id
   where li.org_id = p_org and li.catalog_item_id is not null
   group by sn.id, dn.id, sn.resource, dn.resource
  on conflict (org_id, src_id, dst_id, rel) do update
    set facts = excluded.facts, synced_at = clock_timestamp();
  get diagnostics v_n = row_count; v_edges := v_edges + v_n;

  -- recurring invoice → customer / client
  insert into public.brain_edges (org_id, src_id, dst_id, rel, src_resource, dst_resource, synced_at)
  select p_org, sn.id, dn.id, 'bills', sn.resource, dn.resource, clock_timestamp()
    from public.recurring_invoices r
    join public.brain_nodes sn on sn.org_id = p_org and sn.kind = 'recurring_invoice' and sn.entity_id = r.id
    join public.brain_nodes dn on dn.org_id = p_org and dn.kind in ('customer','client') and dn.entity_id = r.customer_id
   where r.org_id = p_org and r.customer_id is not null
  on conflict (org_id, src_id, dst_id, rel) do update set synced_at = clock_timestamp();
  get diagnostics v_n = row_count; v_edges := v_edges + v_n;

  -- purchase invoice → vendor
  insert into public.brain_edges (org_id, src_id, dst_id, rel, src_resource, dst_resource, synced_at)
  select p_org, sn.id, dn.id, 'billed_by', sn.resource, dn.resource, clock_timestamp()
    from public.purchase_invoices pi
    join public.brain_nodes sn on sn.org_id = p_org and sn.kind = 'purchase_invoice' and sn.entity_id = pi.id
    join public.brain_nodes dn on dn.org_id = p_org and dn.kind = 'vendor'           and dn.entity_id = pi.vendor_id
   where pi.org_id = p_org
  on conflict (org_id, src_id, dst_id, rel) do update set synced_at = clock_timestamp();
  get diagnostics v_n = row_count; v_edges := v_edges + v_n;

  -- task → assignee
  insert into public.brain_edges (org_id, src_id, dst_id, rel, src_resource, dst_resource, synced_at)
  select p_org, sn.id, dn.id, 'assigned_to', sn.resource, dn.resource, clock_timestamp()
    from public.tasks t
    join public.brain_nodes sn on sn.org_id = p_org and sn.kind = 'task'     and sn.entity_id = t.id
    join public.brain_nodes dn on dn.org_id = p_org and dn.kind = 'employee' and dn.entity_id = t.assignee_id
   where t.org_id = p_org and t.assignee_id is not null
  on conflict (org_id, src_id, dst_id, rel) do update set synced_at = clock_timestamp();
  get diagnostics v_n = row_count; v_edges := v_edges + v_n;

  -- HR document → employee
  insert into public.brain_edges (org_id, src_id, dst_id, rel, src_resource, dst_resource, synced_at)
  select p_org, sn.id, dn.id, 'issued_to', sn.resource, dn.resource, clock_timestamp()
    from public.records r
    join public.brain_nodes sn on sn.org_id = p_org and sn.kind = 'record'   and sn.entity_id = r.id
    join public.brain_nodes dn on dn.org_id = p_org and dn.kind = 'employee' and dn.entity_id = r.employee_id
   where r.org_id = p_org and r.employee_id is not null
  on conflict (org_id, src_id, dst_id, rel) do update set synced_at = clock_timestamp();
  get diagnostics v_n = row_count; v_edges := v_edges + v_n;

  -- leave request → employee
  insert into public.brain_edges (org_id, src_id, dst_id, rel, src_resource, dst_resource, synced_at)
  select p_org, sn.id, dn.id, 'requested_by', sn.resource, dn.resource, clock_timestamp()
    from public.leave_requests lr
    join public.brain_nodes sn on sn.org_id = p_org and sn.kind = 'leave_request' and sn.entity_id = lr.id
    join public.brain_nodes dn on dn.org_id = p_org and dn.kind = 'employee'      and dn.entity_id = lr.employee_id
   where lr.org_id = p_org
  on conflict (org_id, src_id, dst_id, rel) do update set synced_at = clock_timestamp();
  get diagnostics v_n = row_count; v_edges := v_edges + v_n;

  -- announcement → department
  insert into public.brain_edges (org_id, src_id, dst_id, rel, src_resource, dst_resource, synced_at)
  select p_org, sn.id, dn.id, 'targets', sn.resource, dn.resource, clock_timestamp()
    from public.announcements a
    join public.brain_nodes sn on sn.org_id = p_org and sn.kind = 'announcement' and sn.entity_id = a.id
    join public.brain_nodes dn on dn.org_id = p_org and dn.kind = 'department'   and dn.entity_id = a.department_id
   where a.org_id = p_org and a.department_id is not null
  on conflict (org_id, src_id, dst_id, rel) do update set synced_at = clock_timestamp();
  get diagnostics v_n = row_count; v_edges := v_edges + v_n;

  -- notification → the document it is about
  insert into public.brain_edges (org_id, src_id, dst_id, rel, src_resource, dst_resource, synced_at)
  select p_org, sn.id, dn.id, 'about', sn.resource, dn.resource, clock_timestamp()
    from public.notifications n
    join public.brain_nodes sn on sn.org_id = p_org and sn.kind = 'notification' and sn.entity_id = n.id
    join public.brain_nodes dn on dn.org_id = p_org
                              and ((dn.kind = 'financial_document' and dn.entity_id = n.financial_doc_id)
                                or (dn.kind = 'record'             and dn.entity_id = n.record_id))
   where n.org_id = p_org
  on conflict (org_id, src_id, dst_id, rel) do update set synced_at = clock_timestamp();
  get diagnostics v_n = row_count; v_edges := v_edges + v_n;

  -- department → organization, so every cluster hangs off one root.
  insert into public.brain_edges (org_id, src_id, dst_id, rel, src_resource, dst_resource, synced_at)
  select p_org, sn.id, dn.id, 'part_of', sn.resource, dn.resource, clock_timestamp()
    from public.brain_nodes sn
    join public.brain_nodes dn on dn.org_id = p_org and dn.kind = 'organization'
   where sn.org_id = p_org and sn.kind = 'department' and sn.deleted_at is null
  on conflict (org_id, src_id, dst_id, rel) do update set synced_at = clock_timestamp();
  get diagnostics v_n = row_count; v_edges := v_edges + v_n;

  -- Anything this pass did not touch no longer reflects a foreign key.
  delete from public.brain_edges where org_id = p_org and synced_at < v_t0;
  get diagnostics v_stale = row_count;

  -- An edge pointing at a tombstoned node is not a relationship any more.
  delete from public.brain_edges e
   where e.org_id = p_org
     and exists (select 1 from public.brain_nodes n
                  where n.id in (e.src_id, e.dst_id) and n.deleted_at is not null);

  return jsonb_build_object('edges', v_edges, 'stale_removed', v_stale);
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- 7. Aggregates
-- ═════════════════════════════════════════════════════════════════════════════
-- Computed here, in SQL, with a written definition attached to each number.
-- The model is handed the result; it is never asked to total transactional rows
-- itself, which is where a language model's arithmetic actually fails.
create or replace function app.brain_refresh_metrics(p_org uuid)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare v_n integer;
begin
  delete from public.brain_metrics where org_id = p_org;

  insert into public.brain_metrics (org_id, key, bucket, value, dims, definition, resource)
  -- People
  select p_org, 'headcount.active', '', count(*), '{}'::jsonb,
         'Employees with no exit date recorded.', 'employees'
    from public.employees where org_id = p_org and exited_at is null
  union all
  select p_org, 'headcount.exited', '', count(*), '{}'::jsonb,
         'Employees with an exit date recorded.', 'employees'
    from public.employees where org_id = p_org and exited_at is not null
  union all
  select p_org, 'headcount.by_employment_type', employment_type::text, count(*), '{}'::jsonb,
         'Active employees by employment type.', 'employees'
    from public.employees where org_id = p_org and exited_at is null
   group by employment_type
  union all
  -- Bucketed on the department id, not its name: (org_id, key, bucket) is the
  -- primary key here, and a department actually called "Unassigned" would
  -- collide with the bucket used for employees who have no department at all.
  -- The name travels in dims, where a collision costs nothing.
  select p_org, 'headcount.by_department', coalesce(d.id::text, 'unassigned'), count(*),
         jsonb_build_object('department_id', d.id, 'department', coalesce(d.name, 'Unassigned')),
         'Active employees per department.', 'employees'
    from public.employees e
    left join public.departments d on d.id = e.department_id
   where e.org_id = p_org and e.exited_at is null
   group by d.id, d.name
  union all
  select p_org, 'departments.count', '', count(*), '{}'::jsonb,
         'Departments defined.', 'departments'
    from public.departments where org_id = p_org

  -- Revenue. "Collected" is amount_paid on non-cancelled invoices, which is the
  -- definition catalog_items.revenue_paid and BillingRevenue already use.
  union all
  select p_org, 'revenue.collected', '', coalesce(sum(amount_paid), 0), '{}'::jsonb,
         'Cash actually received against invoices (sum of amount_paid on non-cancelled invoices).',
         'financial_documents'
    from public.financial_documents
   where org_id = p_org and type = 'invoice' and status <> 'cancelled'
  union all
  select p_org, 'revenue.billed', '', coalesce(sum(grand_total), 0), '{}'::jsonb,
         'Total invoiced, whether or not it has been paid.', 'financial_documents'
    from public.financial_documents
   where org_id = p_org and type = 'invoice' and status <> 'cancelled'
  union all
  select p_org, 'revenue.outstanding', '', coalesce(sum(grand_total - amount_paid), 0), '{}'::jsonb,
         'Invoiced and not yet collected (grand_total minus amount_paid).', 'financial_documents'
    from public.financial_documents
   where org_id = p_org and type = 'invoice' and status <> 'cancelled'
     and amount_paid < grand_total - 0.01
  union all
  select p_org, 'revenue.overdue', '', coalesce(sum(grand_total - amount_paid), 0), '{}'::jsonb,
         'Outstanding on invoices whose due date has passed.', 'financial_documents'
    from public.financial_documents
   where org_id = p_org and type = 'invoice' and status <> 'cancelled'
     and amount_paid < grand_total - 0.01 and due_date is not null and due_date < current_date
  union all
  select p_org, 'revenue.collected_by_month', to_char(issue_date, 'YYYY-MM'),
         coalesce(sum(amount_paid), 0), '{}'::jsonb,
         'Cash collected against invoices issued in that month.', 'financial_documents'
    from public.financial_documents
   where org_id = p_org and type = 'invoice' and status <> 'cancelled'
     and issue_date >= (date_trunc('month', current_date) - interval '11 months')::date
   group by to_char(issue_date, 'YYYY-MM')
  union all
  select p_org, 'documents.count_by_type_status', type::text || ':' || status::text, count(*), '{}'::jsonb,
         'Invoices, quotations and proformas by type and status.', 'financial_documents'
    from public.financial_documents where org_id = p_org group by type, status

  -- Spend
  union all
  select p_org, 'expenses.total', '', coalesce(sum(amount), 0), '{}'::jsonb,
         'All recorded expenses, all time.', 'expenses'
    from public.expenses where org_id = p_org
  union all
  select p_org, 'expenses.by_month', to_char(incurred_on, 'YYYY-MM'), coalesce(sum(amount), 0), '{}'::jsonb,
         'Expenses by the month they were incurred.', 'expenses'
    from public.expenses
   where org_id = p_org and incurred_on >= (date_trunc('month', current_date) - interval '11 months')::date
   group by to_char(incurred_on, 'YYYY-MM')
  union all
  select p_org, 'payables.outstanding', '', coalesce(sum(total - amount_paid), 0), '{}'::jsonb,
         'Owed to vendors on unpaid and partly paid bills.', 'purchase_invoices'
    from public.purchase_invoices
   where org_id = p_org and status in ('unpaid','partially_paid')
  union all
  select p_org, 'vendors.count', '', count(*), '{}'::jsonb,
         'Vendors on the supplier directory, excluding archived.', 'vendors'
    from public.vendors where org_id = p_org and archived_at is null

  -- Clients and catalogue
  union all
  select p_org, 'clients.count_by_status', status::text, count(*), '{}'::jsonb,
         'Clients by pipeline status.', 'clients'
    from public.clients where org_id = p_org and archived_at is null group by status
  union all
  select p_org, 'clients.pipeline_value', '', coalesce(sum(value), 0), '{}'::jsonb,
         'Sum of the value recorded on clients not yet won or lost.', 'clients'
    from public.clients
   where org_id = p_org and archived_at is null and status in ('lead','contacted')
  union all
  select p_org, 'products.count', '', count(*), '{}'::jsonb,
         'Catalogue items, excluding archived.', 'catalog_items'
    from public.catalog_items where org_id = p_org and archived_at is null

  -- Operations
  union all
  select p_org, 'tasks.count_by_status', status::text, count(*), '{}'::jsonb,
         'Tasks by status.', 'tasks'
    from public.tasks where org_id = p_org group by status
  union all
  select p_org, 'tasks.overdue', '', count(*), '{}'::jsonb,
         'Tasks past their deadline and not done.', 'tasks'
    from public.tasks
   where org_id = p_org and status <> 'done' and deadline is not null and deadline < current_date
  union all
  select p_org, 'leave.pending', '', count(*), '{}'::jsonb,
         'Leave requests awaiting a decision.', 'leave_requests'
    from public.leave_requests where org_id = p_org and status = 'pending'
  union all
  select p_org, 'attendance.present_days_30d', '', count(*), '{}'::jsonb,
         'Attendance rows marked present, remote or half day in the last 30 days.', 'attendance_days'
    from public.attendance_days
   where org_id = p_org and work_date >= current_date - 30
     and status in ('present','remote','half_day')
  union all
  select p_org, 'records.count_by_type', type::text, count(*), '{}'::jsonb,
         'HR documents issued, by type.', 'records'
    from public.records where org_id = p_org group by type;

  get diagnostics v_n = row_count;
  return jsonb_build_object('metrics', v_n);
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- 8. The orchestrator
-- ═════════════════════════════════════════════════════════════════════════════
-- One domain failing does not abandon the rest: each runs in its own exception
-- block, the failure is recorded against that domain, and the run finishes as
-- 'partial'. A brain that is 90% fresh and says so is worth more than one that
-- refuses to exist because announcements could not be read.
--
-- SECURITY DEFINER, and executable by the service role only. It reads every
-- tenant table directly, which is precisely why no client role may call it.
create or replace function public.brain_sync(
  p_org uuid,
  p_mode text default 'incremental',
  p_actor uuid default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_run      uuid;
  v_t0       timestamptz := clock_timestamp();
  v_since    timestamptz;
  v_mode     text := case when p_mode = 'full' then 'full' else 'incremental' end;
  v_domains  jsonb := '{}'::jsonb;
  v_errors   jsonb := '[]'::jsonb;
  v_failed   text[] := '{}';
  v_nodes    integer := 0;
  v_removed  integer := 0;
  v_edges    integer := 0;
  v_res      jsonb;
  v_domain   text;
  v_err      text;
  v_state    public.brain_state%rowtype;
begin
  if not exists (select 1 from public.organizations where id = p_org) then
    raise exception 'unknown organization %', p_org using errcode = '23503';
  end if;

  -- One sync per organization at a time. Two runs interleaving would have each
  -- one's tombstone sweep judge the other's half-written state, and the obvious
  -- way to get two is a double-clicked "Build". The lock is per-org and held to
  -- the end of the transaction; a caller who cannot take it is told a sync is
  -- already running rather than left waiting on it.
  if not pg_try_advisory_xact_lock(hashtext('brain_sync:' || p_org::text)) then
    return jsonb_build_object(
      'skipped', true,
      'reason', 'A synchronisation is already running for this organization.');
  end if;

  select * into v_state from public.brain_state where org_id = p_org;

  -- An incremental sync with nothing to be incremental from is a full one.
  if v_state.org_id is null or v_state.last_full_sync_at is null then
    v_mode := 'full';
  end if;
  v_since := case when v_mode = 'full' then null else v_state.last_sync_at end;

  insert into public.brain_sync_runs (org_id, mode, triggered_by)
  values (p_org, v_mode, p_actor)
  returning id into v_run;

  insert into public.brain_state (org_id, status, updated_at)
  values (p_org, 'building', now())
  on conflict (org_id) do update set status = 'building', updated_at = now();

  foreach v_domain in array array['org','people','clients','catalog','finance','spend','ops']
  loop
    begin
      v_res := case v_domain
        when 'org'     then app.brain_sync_org(p_org, v_since)
        when 'people'  then app.brain_sync_people(p_org, v_since)
        when 'clients' then app.brain_sync_clients(p_org, v_since)
        when 'catalog' then app.brain_sync_catalog(p_org, v_since)
        when 'finance' then app.brain_sync_finance(p_org, v_since)
        when 'spend'   then app.brain_sync_spend(p_org, v_since)
        when 'ops'     then app.brain_sync_ops(p_org, v_since)
      end;
      v_nodes   := v_nodes   + coalesce((v_res->>'nodes')::int, 0);
      v_removed := v_removed + coalesce((v_res->>'removed')::int, 0);
      v_domains := v_domains || jsonb_build_object(v_domain, v_res || jsonb_build_object('ok', true));
    exception when others then
      v_err := sqlerrm;
      v_failed  := v_failed || v_domain;
      v_errors  := v_errors  || jsonb_build_array(jsonb_build_object(
                     'domain', v_domain, 'error', v_err, 'at', now()));
      v_domains := v_domains || jsonb_build_object(v_domain,
                     jsonb_build_object('ok', false, 'error', v_err));
    end;
  end loop;

  begin
    v_res := app.brain_rebuild_edges(p_org);
    v_edges := coalesce((v_res->>'edges')::int, 0);
    v_domains := v_domains || jsonb_build_object('edges', v_res || jsonb_build_object('ok', true));
  exception when others then
    v_err := sqlerrm;
    v_failed := v_failed || 'edges';
    v_errors := v_errors || jsonb_build_array(jsonb_build_object('domain','edges','error',v_err,'at',now()));
    v_domains := v_domains || jsonb_build_object('edges', jsonb_build_object('ok', false, 'error', v_err));
  end;

  begin
    v_res := app.brain_refresh_metrics(p_org);
    v_domains := v_domains || jsonb_build_object('metrics', v_res || jsonb_build_object('ok', true));
  exception when others then
    v_err := sqlerrm;
    v_failed := v_failed || 'metrics';
    v_errors := v_errors || jsonb_build_array(jsonb_build_object('domain','metrics','error',v_err,'at',now()));
    v_domains := v_domains || jsonb_build_object('metrics', jsonb_build_object('ok', false, 'error', v_err));
  end;

  update public.brain_sync_runs
     set status = case when array_length(v_failed, 1) is null then 'ok'
                       when array_length(v_failed, 1) >= 9    then 'error'
                       else 'partial' end,
         finished_at = now(),
         duration_ms = (extract(epoch from (clock_timestamp() - v_t0)) * 1000)::int,
         nodes_upserted = v_nodes, nodes_removed = v_removed, edges_upserted = v_edges,
         domains = v_domains, errors = v_errors
   where id = v_run;

  insert into public.brain_state as s (
    org_id, status, initialized_at, last_full_sync_at, last_sync_at, last_sync_mode,
    last_sync_ms, node_count, edge_count, metric_count, coverage, failed_domains,
    last_error, updated_at)
  values (
    p_org,
    case when array_length(v_failed, 1) is null then 'ready' else 'error' end,
    now(),
    case when v_mode = 'full' then now() end,
    now(), v_mode,
    (extract(epoch from (clock_timestamp() - v_t0)) * 1000)::int,
    (select count(*) from public.brain_nodes where org_id = p_org and deleted_at is null),
    (select count(*) from public.brain_edges where org_id = p_org),
    (select count(*) from public.brain_metrics where org_id = p_org),
    v_domains, v_failed,
    case when array_length(v_failed, 1) is not null then v_errors->0->>'error' end,
    now())
  on conflict (org_id) do update set
    -- A partial failure still leaves a usable brain, so the status stays
    -- 'ready' and the failed domains are what the health view reads.
    status            = case when array_length(v_failed, 1) is null then 'ready'
                             when excluded.node_count > 0 then 'ready' else 'error' end,
    initialized_at    = coalesce(s.initialized_at, excluded.initialized_at),
    last_full_sync_at = coalesce(excluded.last_full_sync_at, s.last_full_sync_at),
    last_sync_at      = excluded.last_sync_at,
    last_sync_mode    = excluded.last_sync_mode,
    last_sync_ms      = excluded.last_sync_ms,
    node_count        = excluded.node_count,
    edge_count        = excluded.edge_count,
    metric_count      = excluded.metric_count,
    coverage          = excluded.coverage,
    failed_domains    = excluded.failed_domains,
    last_error        = excluded.last_error,
    updated_at        = now();

  return jsonb_build_object(
    'run_id', v_run, 'mode', v_mode,
    'nodes', v_nodes, 'removed', v_removed, 'edges', v_edges,
    'failed_domains', v_failed, 'domains', v_domains);
end $$;

comment on function public.brain_sync(uuid, text, uuid) is
  'Projects one organization''s Supabase rows into EdgeBrain. Service role only: it reads every tenant table directly.';

revoke all on function public.brain_sync(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.brain_sync(uuid, text, uuid) to service_role;

revoke all on function app.brain_tombstone(uuid, text, uuid[]) from public;
revoke all on function app.brain_rebuild_edges(uuid) from public;
revoke all on function app.brain_refresh_metrics(uuid) from public;


-- ############################################################################
-- ## 0034_edgebrain_autosync.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0034 — EdgeBrain keeps itself current
--
-- 0033 built the brain and the machinery to resynchronise it, but nothing
-- decided WHEN. A derived store that only updates when somebody remembers to
-- press a button is a store that is quietly wrong most of the time, and the
-- fact that it looks authoritative is what makes that dangerous.
--
-- This migration closes the loop in three parts:
--
--   1. CAPTURE   every write to a table the brain projects marks that
--                organization dirty. A trigger, not a poll, so a change made
--                from the SQL editor, a background job or a future service is
--                caught exactly like one made from the app.
--   2. DRAIN     pg_cron runs brain_drain() every few seconds, which
--                resynchronises the dirty organizations and clears their flag.
--                Server-side, so it keeps working when no browser is open.
--   3. PUBLISH   brain_state joins the realtime publication, so an open
--                EdgeBrain page is told the moment its brain changes instead of
--                polling for it.
--
-- ─── Why a queue and not projection inside the trigger ──────────────────────
-- Projecting the node inline would make the brain exactly current, and would
-- also put the brain's correctness inside the user's write transaction: a bug
-- in a projection would roll back the invoice that triggered it. A derived,
-- rebuildable store must never be able to fail an authoritative write. So the
-- trigger does the cheapest possible thing — one upsert of one row keyed by
-- org — and the real work happens outside the writer's transaction.
--
-- ─── What still needs a manual rebuild ──────────────────────────────────────
-- TRUNCATE (no row triggers, no transition table to read an org from) and any
-- load run with session_replication_role = 'replica', which disables triggers
-- by design. Both are bulk operations a person performs deliberately; both are
-- answered by a full rebuild, and Brain Health will show the drift either way
-- because its freshness probe compares against the source tables directly.
-- ─────────────────────────────────────────────────────────────────────────────

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. The dirty queue
-- ═════════════════════════════════════════════════════════════════════════════
-- One row per organization with unprojected changes. Deliberately keyed by org
-- rather than by entity: brain_sync is already incremental (it reprojects only
-- rows whose updated_at moved, and sweeps deletes), so the only thing the
-- trigger has to communicate is "this tenant moved". That keeps the write path
-- to a single upsert however many rows the statement touched.
create table public.brain_dirty (
  org_id     uuid primary key references public.organizations(id) on delete cascade,
  marked_at  timestamptz not null default now(),
  -- Debugging aid: how many statements have piled up since the last drain.
  hits       integer not null default 1
);
comment on table public.brain_dirty is
  'Organizations whose Supabase rows have changed since EdgeBrain last projected them. Drained by brain_drain().';

-- Server-side bookkeeping. No client role reads or writes it.
alter table public.brain_dirty enable row level security;
revoke all on public.brain_dirty from anon, authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Capture
-- ═════════════════════════════════════════════════════════════════════════════
-- Statement-level with a transition table, so a thousand-row insert costs one
-- trigger execution and one upsert — not a thousand of each.
--
-- SECURITY DEFINER because the writer is `authenticated`, which has no grant on
-- brain_dirty and must not be given one: the only thing allowed to write this
-- queue is the act of changing a watched table.
create or replace function app.brain_mark_dirty()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.brain_dirty (org_id, marked_at, hits)
  select distinct org_id, now(), 1 from changed where org_id is not null
  on conflict (org_id) do update
    set marked_at = now(), hits = public.brain_dirty.hits + 1;
  return null;
end $$;

-- organizations names its own key `id`, not `org_id`.
create or replace function app.brain_mark_dirty_org()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.brain_dirty (org_id, marked_at, hits)
  select distinct id, now(), 1 from changed where id is not null
  on conflict (org_id) do update
    set marked_at = now(), hits = public.brain_dirty.hits + 1;
  return null;
end $$;

-- Every table a 0033 projection or aggregate reads. Adding a domain to the
-- brain means adding its table here, or the brain will silently stop tracking it.
--
-- brain_* tables are deliberately absent: a trigger there would mark the org
-- dirty in response to the sync that cleaned it, and the drain would never stop.
do $$
declare
  v_tables text[] := array[
    -- organization
    'public.subscriptions', 'public.usage_counters', 'public.ai_company_memory',
    -- people
    'public.departments', 'public.employees', 'public.memberships',
    -- clients & catalogue
    'public.clients', 'public.customers', 'public.catalog_items',
    -- finance
    'public.financial_documents', 'public.document_line_items',
    'public.payments', 'public.recurring_invoices',
    -- spend
    'public.vendors', 'public.purchase_invoices', 'public.expenses',
    -- operations
    'public.tasks', 'public.records', 'public.announcements',
    'public.leave_requests', 'public.leave_types', 'public.attendance_days',
    'public.notifications'
  ];
  v_t     text;
  v_name  text;
begin
  foreach v_t in array v_tables loop
    -- Skip anything a future migration has dropped rather than failing the deploy.
    if to_regclass(v_t) is null then
      raise notice '0034: % does not exist, not watched', v_t;
      continue;
    end if;
    v_name := replace(split_part(v_t, '.', 2), '"', '');

    execute format('drop trigger if exists brain_dirty_ins on %s', v_t);
    execute format('drop trigger if exists brain_dirty_upd on %s', v_t);
    execute format('drop trigger if exists brain_dirty_del on %s', v_t);

    -- Three triggers rather than one: a statement trigger may reference NEW
    -- TABLE or OLD TABLE, and Postgres will not accept both on one trigger
    -- spanning several events.
    execute format(
      'create trigger brain_dirty_ins after insert on %s
         referencing new table as changed
         for each statement execute function app.brain_mark_dirty()', v_t);
    execute format(
      'create trigger brain_dirty_upd after update on %s
         referencing new table as changed
         for each statement execute function app.brain_mark_dirty()', v_t);
    execute format(
      'create trigger brain_dirty_del after delete on %s
         referencing old table as changed
         for each statement execute function app.brain_mark_dirty()', v_t);
  end loop;

  -- organizations, with its own column name.
  execute 'drop trigger if exists brain_dirty_ins on public.organizations';
  execute 'drop trigger if exists brain_dirty_upd on public.organizations';
  execute 'create trigger brain_dirty_upd after update on public.organizations
             referencing new table as changed
             for each statement execute function app.brain_mark_dirty_org()';
  -- No INSERT trigger: a brand-new organization has no brain to keep current,
  -- and the first build is a full projection that sees everything anyway.
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Drain
-- ═════════════════════════════════════════════════════════════════════════════
create or replace function public.brain_drain(
  p_max_orgs integer  default 25,
  p_settle   interval default '3 seconds'
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r        record;
  v_res    jsonb;
  v_synced integer := 0;
  v_failed integer := 0;
  v_orgs   jsonb   := '[]'::jsonb;
begin
  -- An organization that has never been built is not kept current — the user
  -- has not asked for a brain. Its flag is dropped rather than carried forever;
  -- the first build is a full sync and needs no backlog.
  delete from public.brain_dirty d
   where not exists (select 1 from public.brain_state s
                      where s.org_id = d.org_id and s.status <> 'absent');

  for r in
    select d.org_id, d.marked_at
      from public.brain_dirty d
      join public.brain_state s on s.org_id = d.org_id
     -- `p_settle` coalesces a burst of writes into one sync instead of chasing
     -- each statement in a multi-step save.
     where d.marked_at <= now() - p_settle
     order by d.marked_at
     limit p_max_orgs
  loop
    begin
      v_res := public.brain_sync(r.org_id, 'incremental');

      if coalesce((v_res->>'skipped')::boolean, false) then
        -- Another sync holds the lock; leave the flag for the next pass.
        continue;
      end if;

      -- Clear the flag only if nothing arrived while we were syncing. Comparing
      -- marked_at is what stops a write that landed mid-sync from being marked
      -- clean and never projected — the cause of the silent drift this whole
      -- migration exists to prevent.
      delete from public.brain_dirty
       where org_id = r.org_id and marked_at = r.marked_at;

      v_synced := v_synced + 1;
      v_orgs := v_orgs || jsonb_build_array(jsonb_build_object(
        'org_id', r.org_id, 'nodes', v_res->'nodes', 'edges', v_res->'edges'));
    exception when others then
      -- One tenant's failure must not stop the queue for every other tenant.
      v_failed := v_failed + 1;
      raise warning 'brain_drain: org % failed: %', r.org_id, sqlerrm;
    end;
  end loop;

  return jsonb_build_object(
    'synced', v_synced, 'failed', v_failed,
    'remaining', (select count(*) from public.brain_dirty),
    'orgs', v_orgs);
end $$;

comment on function public.brain_drain(integer, interval) is
  'Resynchronises every organization with pending changes. Run by pg_cron; also callable by the server as a fallback.';

revoke all on function public.brain_drain(integer, interval) from public, anon, authenticated;
grant execute on function public.brain_drain(integer, interval) to service_role;

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. Schedule
-- ═════════════════════════════════════════════════════════════════════════════
-- Guarded end to end. pg_cron needs to be in shared_preload_libraries, which is
-- true on Supabase but is not something a migration can assume — and a missing
-- scheduler must degrade to "the app syncs on open", not fail the deploy.
do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice '0034: pg_cron unavailable; EdgeBrain will sync when opened. Call public.brain_drain() from your own scheduler for background freshness.';
    return;
  end if;

  create extension if not exists pg_cron;

  begin
    perform cron.unschedule('edgebrain-drain');
  exception when others then
    null;  -- not scheduled yet
  end;

  begin
    -- pg_cron 1.5+ accepts an interval; anything older gets the one-minute
    -- crontab form, which is the finest granularity it understands.
    perform cron.schedule('edgebrain-drain', '5 seconds', 'select public.brain_drain()');
  exception when others then
    perform cron.schedule('edgebrain-drain', '* * * * *', 'select public.brain_drain()');
    raise notice '0034: sub-minute scheduling unavailable; EdgeBrain drains once a minute.';
  end;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. Publish
-- ═════════════════════════════════════════════════════════════════════════════
-- brain_state changes on every sync, so it is the one row a client needs to
-- watch to know the brain moved. Realtime applies the table's RLS policy, so a
-- subscriber is told only about an organization it may already read.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public' and tablename = 'brain_state')
  then
    alter publication supabase_realtime add table public.brain_state;
  end if;
end $$;

-- A subscriber has to be able to identify the row that changed; without a
-- replica identity, an UPDATE arrives with no key to match it to.
alter table public.brain_state replica identity full;


-- ############################################################################
-- ## 0035_edgebrain_metric_groups.sql
-- ############################################################################

-- ────────────────────────────────────────────────────────────────────────────────
-- 0035 — EdgeBrain: the error handler that was itself an error
--
-- "Build Company Brain" failed with:
--
--     malformed array literal: "metrics"
--
-- which is not a fault in the brain at all. In
--
--     v_failed text[];  ...  v_failed := v_failed || 'metrics';
--
-- the literal is untyped, so Postgres resolves || as anyarray || anyarray and
-- tries to parse 'metrics' as an array literal. The line only ever runs inside
-- an exception handler, so it stayed invisible until a domain actually failed
-- — and then it threw from inside the handler, aborting brain_sync and
-- replacing the real diagnosis with this one. Every local test passed because
-- no test had ever made a domain fail.
--
-- Two fixes, because the first alone would only have revealed the second:
--
--   1. array['metrics'] instead of 'metrics', so a failing domain is recorded
--      rather than masked.
--   2. app.brain_refresh_metrics() computed all thirty aggregates in one
--      statement, so any single one failing — a table an older tenant has not
--      migrated yet, one unexpected row — lost the whole set. It now computes
--      them in eight independent groups and reports which group failed, the
--      same way the domain projections already do. A brain that is missing its
--      attendance figure is worth far more than one with no figures at all.
--
-- Both functions are CREATE OR REPLACE: no data is touched and nothing is
-- rebuilt. The next sync picks up the new definitions.
-- ────────────────────────────────────────────────────────────────────────────────

create or replace function public.brain_sync(
  p_org uuid,
  p_mode text default 'incremental',
  p_actor uuid default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_run      uuid;
  v_t0       timestamptz := clock_timestamp();
  v_since    timestamptz;
  v_mode     text := case when p_mode = 'full' then 'full' else 'incremental' end;
  v_domains  jsonb := '{}'::jsonb;
  v_errors   jsonb := '[]'::jsonb;
  v_failed   text[] := '{}';
  v_nodes    integer := 0;
  v_removed  integer := 0;
  v_edges    integer := 0;
  v_res      jsonb;
  v_domain   text;
  v_err      text;
  v_state    public.brain_state%rowtype;
begin
  if not exists (select 1 from public.organizations where id = p_org) then
    raise exception 'unknown organization %', p_org using errcode = '23503';
  end if;

  -- One sync per organization at a time. Two runs interleaving would have each
  -- one's tombstone sweep judge the other's half-written state, and the obvious
  -- way to get two is a double-clicked "Build". The lock is per-org and held to
  -- the end of the transaction; a caller who cannot take it is told a sync is
  -- already running rather than left waiting on it.
  if not pg_try_advisory_xact_lock(hashtext('brain_sync:' || p_org::text)) then
    return jsonb_build_object(
      'skipped', true,
      'reason', 'A synchronisation is already running for this organization.');
  end if;

  select * into v_state from public.brain_state where org_id = p_org;

  -- An incremental sync with nothing to be incremental from is a full one.
  if v_state.org_id is null or v_state.last_full_sync_at is null then
    v_mode := 'full';
  end if;
  v_since := case when v_mode = 'full' then null else v_state.last_sync_at end;

  insert into public.brain_sync_runs (org_id, mode, triggered_by)
  values (p_org, v_mode, p_actor)
  returning id into v_run;

  insert into public.brain_state (org_id, status, updated_at)
  values (p_org, 'building', now())
  on conflict (org_id) do update set status = 'building', updated_at = now();

  foreach v_domain in array array['org','people','clients','catalog','finance','spend','ops']
  loop
    begin
      v_res := case v_domain
        when 'org'     then app.brain_sync_org(p_org, v_since)
        when 'people'  then app.brain_sync_people(p_org, v_since)
        when 'clients' then app.brain_sync_clients(p_org, v_since)
        when 'catalog' then app.brain_sync_catalog(p_org, v_since)
        when 'finance' then app.brain_sync_finance(p_org, v_since)
        when 'spend'   then app.brain_sync_spend(p_org, v_since)
        when 'ops'     then app.brain_sync_ops(p_org, v_since)
      end;
      v_nodes   := v_nodes   + coalesce((v_res->>'nodes')::int, 0);
      v_removed := v_removed + coalesce((v_res->>'removed')::int, 0);
      v_domains := v_domains || jsonb_build_object(v_domain, v_res || jsonb_build_object('ok', true));
    exception when others then
      v_err := sqlerrm;
      v_failed  := v_failed || array[v_domain];
      v_errors  := v_errors  || jsonb_build_array(jsonb_build_object(
                     'domain', v_domain, 'error', v_err, 'at', now()));
      v_domains := v_domains || jsonb_build_object(v_domain,
                     jsonb_build_object('ok', false, 'error', v_err));
    end;
  end loop;

  begin
    v_res := app.brain_rebuild_edges(p_org);
    v_edges := coalesce((v_res->>'edges')::int, 0);
    v_domains := v_domains || jsonb_build_object('edges', v_res || jsonb_build_object('ok', true));
  exception when others then
    v_err := sqlerrm;
    v_failed := v_failed || array['edges'];
    v_errors := v_errors || jsonb_build_array(jsonb_build_object('domain','edges','error',v_err,'at',now()));
    v_domains := v_domains || jsonb_build_object('edges', jsonb_build_object('ok', false, 'error', v_err));
  end;

  begin
    v_res := app.brain_refresh_metrics(p_org);
    -- brain_refresh_metrics no longer throws on a single bad group; it returns
    -- what failed. A partial metric refresh is still a partial sync, so it is
    -- reported as one rather than quietly passing.
    if jsonb_array_length(coalesce(v_res->'errors', '[]'::jsonb)) > 0 then
      v_failed  := v_failed || array['metrics'];
      v_errors  := v_errors || (v_res->'errors');
      v_domains := v_domains || jsonb_build_object('metrics',
                     v_res || jsonb_build_object(
                       'ok', false,
                       'error', v_res->'errors'->0->>'error'));
    else
      v_domains := v_domains || jsonb_build_object('metrics', v_res || jsonb_build_object('ok', true));
    end if;
  exception when others then
    v_err := sqlerrm;
    v_failed := v_failed || array['metrics'];
    v_errors := v_errors || jsonb_build_array(jsonb_build_object('domain','metrics','error',v_err,'at',now()));
    v_domains := v_domains || jsonb_build_object('metrics', jsonb_build_object('ok', false, 'error', v_err));
  end;

  update public.brain_sync_runs
     set status = case when array_length(v_failed, 1) is null then 'ok'
                       when array_length(v_failed, 1) >= 9    then 'error'
                       else 'partial' end,
         finished_at = now(),
         duration_ms = (extract(epoch from (clock_timestamp() - v_t0)) * 1000)::int,
         nodes_upserted = v_nodes, nodes_removed = v_removed, edges_upserted = v_edges,
         domains = v_domains, errors = v_errors
   where id = v_run;

  insert into public.brain_state as s (
    org_id, status, initialized_at, last_full_sync_at, last_sync_at, last_sync_mode,
    last_sync_ms, node_count, edge_count, metric_count, coverage, failed_domains,
    last_error, updated_at)
  values (
    p_org,
    case when array_length(v_failed, 1) is null then 'ready' else 'error' end,
    now(),
    case when v_mode = 'full' then now() end,
    now(), v_mode,
    (extract(epoch from (clock_timestamp() - v_t0)) * 1000)::int,
    (select count(*) from public.brain_nodes where org_id = p_org and deleted_at is null),
    (select count(*) from public.brain_edges where org_id = p_org),
    (select count(*) from public.brain_metrics where org_id = p_org),
    v_domains, v_failed,
    case when array_length(v_failed, 1) is not null then v_errors->0->>'error' end,
    now())
  on conflict (org_id) do update set
    -- A partial failure still leaves a usable brain, so the status stays
    -- 'ready' and the failed domains are what the health view reads.
    status            = case when array_length(v_failed, 1) is null then 'ready'
                             when excluded.node_count > 0 then 'ready' else 'error' end,
    initialized_at    = coalesce(s.initialized_at, excluded.initialized_at),
    last_full_sync_at = coalesce(excluded.last_full_sync_at, s.last_full_sync_at),
    last_sync_at      = excluded.last_sync_at,
    last_sync_mode    = excluded.last_sync_mode,
    last_sync_ms      = excluded.last_sync_ms,
    node_count        = excluded.node_count,
    edge_count        = excluded.edge_count,
    metric_count      = excluded.metric_count,
    coverage          = excluded.coverage,
    failed_domains    = excluded.failed_domains,
    last_error        = excluded.last_error,
    updated_at        = now();

  return jsonb_build_object(
    'run_id', v_run, 'mode', v_mode,
    'nodes', v_nodes, 'removed', v_removed, 'edges', v_edges,
    'failed_domains', v_failed, 'domains', v_domains);
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- Aggregates, computed in independent groups
-- ═════════════════════════════════════════════════════════════════════════════
-- Same numbers and the same written definitions as 0033. The only change is
-- that each group is its own statement inside its own exception block, so a
-- group that cannot run — a table a tenant has not migrated to yet, one row
-- that breaks an assumption — costs that group and nothing else. Returns the
-- count written plus whatever failed, which brain_sync folds into the run's
-- errors and Brain Health shows by name.
create or replace function app.brain_refresh_metrics(p_org uuid)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare
  v_total  integer := 0;
  v_n      integer;
  v_failed text[]  := '{}';
  v_errors jsonb   := '[]'::jsonb;
begin
  delete from public.brain_metrics where org_id = p_org;

  -- ── people ────────────────────────────────────────────────────────────────
  begin
    insert into public.brain_metrics (org_id, key, bucket, value, dims, definition, resource)
    select p_org, 'headcount.active', '', count(*), '{}'::jsonb,
           'Employees with no exit date recorded.', 'employees'
      from public.employees where org_id = p_org and exited_at is null
    union all
    select p_org, 'headcount.exited', '', count(*), '{}'::jsonb,
           'Employees with an exit date recorded.', 'employees'
      from public.employees where org_id = p_org and exited_at is not null
    union all
    select p_org, 'headcount.by_employment_type', employment_type::text, count(*), '{}'::jsonb,
           'Active employees by employment type.', 'employees'
      from public.employees where org_id = p_org and exited_at is null
     group by employment_type
    union all
    -- Bucketed on the department id: (org_id, key, bucket) is the primary key,
    -- and a department actually called "Unassigned" would otherwise collide
    -- with the bucket for employees who have no department at all.
    select p_org, 'headcount.by_department', coalesce(d.id::text, 'unassigned'), count(*),
           jsonb_build_object('department_id', d.id, 'department', coalesce(d.name, 'Unassigned')),
           'Active employees per department.', 'employees'
      from public.employees e
      left join public.departments d on d.id = e.department_id
     where e.org_id = p_org and e.exited_at is null
     group by d.id, d.name
    union all
    select p_org, 'departments.count', '', count(*), '{}'::jsonb,
           'Departments defined.', 'departments'
      from public.departments where org_id = p_org;
    get diagnostics v_n = row_count; v_total := v_total + v_n;
  exception when others then
    v_failed := v_failed || array['people'];
    v_errors := v_errors || jsonb_build_array(jsonb_build_object('domain', 'metrics.people', 'error', sqlerrm, 'at', now()));
  end;

  -- ── revenue ───────────────────────────────────────────────────────────────
  begin
    insert into public.brain_metrics (org_id, key, bucket, value, dims, definition, resource)
    select p_org, 'revenue.collected', '', coalesce(sum(amount_paid), 0), '{}'::jsonb,
           'Cash actually received against invoices (sum of amount_paid on non-cancelled invoices).',
           'financial_documents'
      from public.financial_documents
     where org_id = p_org and type = 'invoice' and status <> 'cancelled'
    union all
    select p_org, 'revenue.billed', '', coalesce(sum(grand_total), 0), '{}'::jsonb,
           'Total invoiced, whether or not it has been paid.', 'financial_documents'
      from public.financial_documents
     where org_id = p_org and type = 'invoice' and status <> 'cancelled'
    union all
    select p_org, 'revenue.outstanding', '', coalesce(sum(grand_total - amount_paid), 0), '{}'::jsonb,
           'Invoiced and not yet collected (grand_total minus amount_paid).', 'financial_documents'
      from public.financial_documents
     where org_id = p_org and type = 'invoice' and status <> 'cancelled'
       and amount_paid < grand_total - 0.01
    union all
    select p_org, 'revenue.overdue', '', coalesce(sum(grand_total - amount_paid), 0), '{}'::jsonb,
           'Outstanding on invoices whose due date has passed.', 'financial_documents'
      from public.financial_documents
     where org_id = p_org and type = 'invoice' and status <> 'cancelled'
       and amount_paid < grand_total - 0.01 and due_date is not null and due_date < current_date
    union all
    select p_org, 'revenue.collected_by_month', to_char(issue_date, 'YYYY-MM'),
           coalesce(sum(amount_paid), 0), '{}'::jsonb,
           'Cash collected against invoices issued in that month.', 'financial_documents'
      from public.financial_documents
     where org_id = p_org and type = 'invoice' and status <> 'cancelled'
       and issue_date >= (date_trunc('month', current_date) - interval '11 months')::date
     group by to_char(issue_date, 'YYYY-MM')
    union all
    select p_org, 'documents.count_by_type_status', type::text || ':' || status::text, count(*), '{}'::jsonb,
           'Invoices, quotations and proformas by type and status.', 'financial_documents'
      from public.financial_documents where org_id = p_org group by type, status;
    get diagnostics v_n = row_count; v_total := v_total + v_n;
  exception when others then
    v_failed := v_failed || array['revenue'];
    v_errors := v_errors || jsonb_build_array(jsonb_build_object('domain', 'metrics.revenue', 'error', sqlerrm, 'at', now()));
  end;

  -- ── expenses ──────────────────────────────────────────────────────────────
  begin
    insert into public.brain_metrics (org_id, key, bucket, value, dims, definition, resource)
    select p_org, 'expenses.total', '', coalesce(sum(amount), 0), '{}'::jsonb,
           'All recorded expenses, all time.', 'expenses'
      from public.expenses where org_id = p_org
    union all
    select p_org, 'expenses.by_month', to_char(incurred_on, 'YYYY-MM'), coalesce(sum(amount), 0), '{}'::jsonb,
           'Expenses by the month they were incurred.', 'expenses'
      from public.expenses
     where org_id = p_org and incurred_on >= (date_trunc('month', current_date) - interval '11 months')::date
     group by to_char(incurred_on, 'YYYY-MM');
    get diagnostics v_n = row_count; v_total := v_total + v_n;
  exception when others then
    v_failed := v_failed || array['expenses'];
    v_errors := v_errors || jsonb_build_array(jsonb_build_object('domain', 'metrics.expenses', 'error', sqlerrm, 'at', now()));
  end;

  -- ── payables (0028; absent on a tenant that predates it) ──────────────────
  begin
    insert into public.brain_metrics (org_id, key, bucket, value, dims, definition, resource)
    select p_org, 'payables.outstanding', '', coalesce(sum(total - amount_paid), 0), '{}'::jsonb,
           'Owed to vendors on unpaid and partly paid bills.', 'purchase_invoices'
      from public.purchase_invoices
     where org_id = p_org and status in ('unpaid','partially_paid')
    union all
    select p_org, 'vendors.count', '', count(*), '{}'::jsonb,
           'Vendors on the supplier directory, excluding archived.', 'vendors'
      from public.vendors where org_id = p_org and archived_at is null;
    get diagnostics v_n = row_count; v_total := v_total + v_n;
  exception when others then
    v_failed := v_failed || array['payables'];
    v_errors := v_errors || jsonb_build_array(jsonb_build_object('domain', 'metrics.payables', 'error', sqlerrm, 'at', now()));
  end;

  -- ── clients and catalogue ─────────────────────────────────────────────────
  begin
    insert into public.brain_metrics (org_id, key, bucket, value, dims, definition, resource)
    select p_org, 'clients.count_by_status', status::text, count(*), '{}'::jsonb,
           'Clients by pipeline status.', 'clients'
      from public.clients where org_id = p_org and archived_at is null group by status
    union all
    select p_org, 'clients.pipeline_value', '', coalesce(sum(value), 0), '{}'::jsonb,
           'Sum of the value recorded on clients not yet won or lost.', 'clients'
      from public.clients
     where org_id = p_org and archived_at is null and status in ('lead','contacted')
    union all
    select p_org, 'products.count', '', count(*), '{}'::jsonb,
           'Catalogue items, excluding archived.', 'catalog_items'
      from public.catalog_items where org_id = p_org and archived_at is null;
    get diagnostics v_n = row_count; v_total := v_total + v_n;
  exception when others then
    v_failed := v_failed || array['clients'];
    v_errors := v_errors || jsonb_build_array(jsonb_build_object('domain', 'metrics.clients', 'error', sqlerrm, 'at', now()));
  end;

  -- ── tasks ─────────────────────────────────────────────────────────────────
  begin
    insert into public.brain_metrics (org_id, key, bucket, value, dims, definition, resource)
    select p_org, 'tasks.count_by_status', status::text, count(*), '{}'::jsonb,
           'Tasks by status.', 'tasks'
      from public.tasks where org_id = p_org group by status
    union all
    select p_org, 'tasks.overdue', '', count(*), '{}'::jsonb,
           'Tasks past their deadline and not done.', 'tasks'
      from public.tasks
     where org_id = p_org and status <> 'done' and deadline is not null and deadline < current_date;
    get diagnostics v_n = row_count; v_total := v_total + v_n;
  exception when others then
    v_failed := v_failed || array['tasks'];
    v_errors := v_errors || jsonb_build_array(jsonb_build_object('domain', 'metrics.tasks', 'error', sqlerrm, 'at', now()));
  end;

  -- ── people ops (0029; absent on a tenant that predates it) ────────────────
  begin
    insert into public.brain_metrics (org_id, key, bucket, value, dims, definition, resource)
    select p_org, 'leave.pending', '', count(*), '{}'::jsonb,
           'Leave requests awaiting a decision.', 'leave_requests'
      from public.leave_requests where org_id = p_org and status = 'pending'
    union all
    select p_org, 'attendance.present_days_30d', '', count(*), '{}'::jsonb,
           'Attendance rows marked present, remote or half day in the last 30 days.', 'attendance_days'
      from public.attendance_days
     where org_id = p_org and work_date >= current_date - 30
       and status in ('present','remote','half_day');
    get diagnostics v_n = row_count; v_total := v_total + v_n;
  exception when others then
    v_failed := v_failed || array['people_ops'];
    v_errors := v_errors || jsonb_build_array(jsonb_build_object('domain', 'metrics.people_ops', 'error', sqlerrm, 'at', now()));
  end;

  -- ── HR documents ──────────────────────────────────────────────────────────
  begin
    insert into public.brain_metrics (org_id, key, bucket, value, dims, definition, resource)
    select p_org, 'records.count_by_type', type::text, count(*), '{}'::jsonb,
           'HR documents issued, by type.', 'records'
      from public.records where org_id = p_org group by type;
    get diagnostics v_n = row_count; v_total := v_total + v_n;
  exception when others then
    v_failed := v_failed || array['records'];
    v_errors := v_errors || jsonb_build_array(jsonb_build_object('domain', 'metrics.records', 'error', sqlerrm, 'at', now()));
  end;

  return jsonb_build_object(
    'metrics', v_total,
    'failed_groups', v_failed,
    'errors', v_errors);
end $$;

revoke all on function app.brain_refresh_metrics(uuid) from public;


-- ############################################################################
-- ## 0036_edgebrain_resource_guard.sql
-- ############################################################################

-- ═════════════════════════════════════════════════════════════════════════════
-- 0036 — EdgeBrain: never fail a sync over a resource key this deployment
--        does not have, and never widen access to cover for one.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- THE BUG THIS FIXES
--
-- brain_refresh_metrics writes each metric with the permission_resources key
-- that gates it, and brain_metrics.resource is a foreign key to that table. So
-- a metric naming a key the database does not have does not produce a metric
-- without a gate — it produces
--
--     insert or update on table "brain_metrics"
--     violates foreign key constraint "brain_metrics_resource_fkey"
--
-- and the whole metrics domain reports ok:false with zero rows written. Every
-- aggregate disappears, including headcount.active, which is precisely the row
-- that answers "how many employees do we have?". The brain then hands the model
-- a context whose AUTHORITATIVE AGGREGATES section reads "(none visible to this
-- user)" — and the model, correctly refusing to invent a number, answers zero.
--
-- It was found on a live project whose permission_resources holds the
-- attendance resource under the key `attendance`, where 0029 in this repository
-- seeds it as `attendance_days`. One key, one project, every aggregate gone.
--
-- WHY THE FIX IS NOT "DROP THE FOREIGN KEY"
--
-- The key is what makes a metric gateable. resource IS NULL already means
-- something specific in this schema — org-level, visible to any member — so
-- letting an unresolvable key fall through to NULL would publish a metric
-- computed from attendance records to every member of the organization. A
-- naming mismatch must never become a disclosure. The brain does not get to
-- widen access; that rule is the whole premise of 0033.
--
-- WHAT IT DOES INSTEAD
--
-- One BEFORE INSERT OR UPDATE trigger, applied to the three brain tables that
-- carry a resource, resolving in this order:
--
--   1. the key exists            → keep the row as written;
--   2. a known alias exists      → rewrite to the alias and keep the row;
--   3. neither                   → DROP the row, silently and fail-closed.
--
-- Dropping is the conservative branch, and it is the reason this is a trigger
-- and not a WHERE clause in eight separate inserts: the guarantee holds for
-- every writer, including ones added later, and a sync can no longer be
-- destroyed by a single unmappable row. What is lost is one metric. What is
-- kept is the other twenty-nine, and the boundary.
--
-- The alias table exists because the same concept genuinely carries two names
-- across deployments of this schema. It is for reconciling spellings of one
-- resource, never for pointing a resource at a different, weaker gate.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Alias resolution
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists app.brain_resource_alias (
  wanted  text primary key,
  instead text not null,
  note    text
);

comment on table app.brain_resource_alias is
  'Spellings of one permission resource that differ between deployments of this '
  'schema. Only ever maps a resource onto the same resource under another name — '
  'never onto a different or broader one.';

insert into app.brain_resource_alias (wanted, instead, note) values
  ('attendance_days', 'attendance',
   'Seeded as attendance_days by 0029 here; some projects hold it as attendance.'),
  ('attendance', 'attendance_days',
   'The same reconciliation in the other direction.')
on conflict (wanted) do nothing;

/**
 * The key to store for a wanted resource: itself if it exists, else its alias
 * if that exists, else NULL meaning "this deployment cannot gate it".
 */
create or replace function app.brain_resource(p_key text)
returns text
language sql
stable
set search_path = public, app, pg_temp
as $$
  select case
    when p_key is null then null
    when exists (select 1 from public.permission_resources r where r.key = p_key)
      then p_key
    else (
      select a.instead
        from app.brain_resource_alias a
        join public.permission_resources r on r.key = a.instead
       where a.wanted = p_key
    )
  end;
$$;

comment on function app.brain_resource(text) is
  'Resolves a permission_resources key against this database. NULL means the key '
  'could not be resolved — which callers must treat as "do not publish", never as '
  '"no gate needed".';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The guard
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function app.brain_guard_resource()
returns trigger
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_resolved text;
begin
  -- NULL is a deliberate value here — org-level, no gate needed — and is left
  -- exactly as the projection wrote it. Only a non-null key is resolved.
  if new.resource is not null then
    v_resolved := app.brain_resource(new.resource);
    if v_resolved is null then
      return null;            -- unresolvable: drop the row, keep the boundary
    end if;
    new.resource := v_resolved;
  end if;
  return new;
end;
$$;

drop trigger if exists brain_metrics_guard_resource on public.brain_metrics;
create trigger brain_metrics_guard_resource
  before insert or update on public.brain_metrics
  for each row execute function app.brain_guard_resource();

drop trigger if exists brain_nodes_guard_resource on public.brain_nodes;
create trigger brain_nodes_guard_resource
  before insert or update on public.brain_nodes
  for each row execute function app.brain_guard_resource();

-- brain_edges carries two, denormalised from its endpoints so visibility is a
-- single predicate. An edge whose end cannot be gated is dropped for the same
-- reason a node is: a line the viewer cannot check is a line they should not be
-- shown.
create or replace function app.brain_guard_edge_resource()
returns trigger
language plpgsql
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_src text;
  v_dst text;
begin
  if new.src_resource is not null then
    v_src := app.brain_resource(new.src_resource);
    if v_src is null then return null; end if;
    new.src_resource := v_src;
  end if;
  if new.dst_resource is not null then
    v_dst := app.brain_resource(new.dst_resource);
    if v_dst is null then return null; end if;
    new.dst_resource := v_dst;
  end if;
  return new;
end;
$$;

drop trigger if exists brain_edges_guard_resource on public.brain_edges;
create trigger brain_edges_guard_resource
  before insert or update on public.brain_edges
  for each row execute function app.brain_guard_edge_resource();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Republish the aggregates for every organization that already has a brain
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Without this the fix would only take effect at each org's next sync, and an
-- org whose data is quiet might sit with an empty aggregates section — and so
-- with an AI that says "0 employees" — for as long as nothing changed.

do $$
declare r record;
begin
  for r in select org_id from public.brain_state where status = 'ready' loop
    begin
      perform app.brain_refresh_metrics(r.org_id);
      -- Brain Health reads the count from brain_state, so leaving it at the
      -- zero the failed run wrote would report an outage that no longer exists.
      update public.brain_state s
         set metric_count = (select count(*) from public.brain_metrics m where m.org_id = s.org_id),
             updated_at   = now()
       where s.org_id = r.org_id;
    exception when others then
      raise notice 'brain metrics refresh failed for %: %', r.org_id, sqlerrm;
    end;
  end loop;
end $$;


-- ############################################################################
-- ## 0037_edgebrain_revenue_by_country.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0037 — EdgeBrain knows which country the money came from
--
-- THE BUG THIS FIXES: asked which country generates the most revenue, the
-- assistant answered "India", then "the US", then "AU", then said India had
-- none at all — four answers to one question, in one session.
--
-- None of that was the model inventing figures. It was the context engine
-- handing it no way to answer:
--
--   • brain_refresh_metrics computes revenue.collected, .billed, .outstanding
--     and .collected_by_month — but nothing by country. Rule 1 of the system
--     prompt ("quote the aggregates, never total the entities yourself") had
--     nothing to point at, so the question fell through to the ENTITIES block.
--   • The invoice nodes did not carry country_code either, even though 0013
--     put it on financial_documents precisely so that the country of a sale is
--     a fact of the transaction, frozen at issue time.
--   • So the only country anywhere in the context was clients.country_code —
--     the CRM attribute 0013 exists in order NOT to use. The model joined by
--     hand through a handful of sampled client rows, and a different sample
--     each turn produced a different country each turn.
--
-- The answer is not a better prompt. It is to compute the number in SQL, with
-- its definition attached, the way every other company figure here is computed.
--
--   1. app.brain_sync_finance   invoice facts now carry country_code and
--                               country_source.
--   2. revenue.*_by_country     new aggregates, off the document's own country,
--                               reconciling exactly with the existing org-wide
--                               revenue.* totals.
--
-- The new metrics are added by wrapping brain_refresh_metrics rather than
-- restating it: 0035's body stays the one definition of the other thirty
-- numbers, and this file owns only what it adds.
-- ─────────────────────────────────────────────────────────────────────────────

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. The country of a sale reaches the model
-- ═════════════════════════════════════════════════════════════════════════════
-- Identical to 0033's function but for two keys in the invoice's facts. An
-- invoice that says which country it was issued in can be read against the
-- aggregate below; one that does not is why the two disagreed.
create or replace function app.brain_sync_finance(p_org uuid, p_since timestamptz default null)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare v_nodes integer := 0; v_removed integer := 0; v_n integer;
begin
  -- Line items are folded into the document's facts rather than made nodes:
  -- they have no independent identity, and one node per line would multiply the
  -- graph by an order of magnitude to say nothing a reader asks about on its own.
  insert into public.brain_nodes
    (org_id, kind, entity_id, source_table, source_updated_at, resource, label, summary, state, facts, metrics, synced_at, deleted_at)
  select f.org_id, 'financial_document', f.id, 'financial_documents', f.updated_at, 'financial_documents',
         f.doc_number,
         concat_ws(' · ', initcap(f.type::text), f.bill_to_name,
                   f.currency || ' ' || to_char(f.grand_total, 'FM999999990.00'), f.status::text),
         f.status::text,
         jsonb_strip_nulls(jsonb_build_object(
           'doc_number', f.doc_number, 'type', f.type, 'status', f.status,
           'revision', f.revision, 'customer_id', f.customer_id,
           'bill_to_name', f.bill_to_name, 'bill_to_email', f.bill_to_email,
           'bill_to_state', f.bill_to_state, 'bill_to_gstin', f.bill_to_gstin,
           -- The document's own country, frozen at issue time by 0013 — the
           -- authoritative country of the sale. Left out until now, which is
           -- why a question about revenue by country had nothing to read here.
           'country_code', f.country_code, 'country_source', f.country_source,
           'issue_date', f.issue_date, 'due_date', f.due_date, 'valid_until', f.valid_until,
           'currency', f.currency, 'subtotal', f.subtotal,
           'discount_amount', f.discount_amount, 'taxable_amount', f.taxable_amount,
           'gst_enabled', f.gst_enabled, 'gst_rate', f.gst_rate, 'gst_amount', f.gst_amount,
           'is_inter_state', f.is_inter_state, 'grand_total', f.grand_total,
           'amount_paid', f.amount_paid, 'advance_percent', f.advance_percent,
           'notes', f.notes, 'created_at', f.created_at,
           'line_items', (select jsonb_agg(jsonb_build_object(
                             'position', li.position, 'description', li.description,
                             'quantity', li.quantity, 'unit', li.unit, 'rate', li.rate,
                             'hsn_sac', li.hsn_sac, 'line_total', li.line_total,
                             'catalog_item_id', li.catalog_item_id)
                           order by li.position)
                           from public.document_line_items li where li.document_id = f.id))),
         jsonb_build_object(
           'outstanding', greatest(f.grand_total - f.amount_paid, 0),
           'days_overdue', case
             when f.due_date is not null and f.amount_paid < f.grand_total - 0.01
                  and f.due_date < current_date
             then current_date - f.due_date else 0 end,
           'payment_count', (select count(*) from public.payments p where p.document_id = f.id)),
         now(), null
    from public.financial_documents f
   where f.org_id = p_org and (p_since is null or f.updated_at > p_since)
  on conflict (org_id, kind, entity_id) do update
    set label = excluded.label, summary = excluded.summary, state = excluded.state,
        facts = excluded.facts, metrics = excluded.metrics,
        source_updated_at = excluded.source_updated_at, synced_at = now(), deleted_at = null;
  get diagnostics v_n = row_count; v_nodes := v_nodes + v_n;

  v_removed := v_removed + app.brain_tombstone(p_org, 'financial_document',
    coalesce((select array_agg(id) from public.financial_documents where org_id = p_org), '{}'::uuid[]));

  insert into public.brain_nodes
    (org_id, kind, entity_id, source_table, source_updated_at, resource, label, summary, state, facts, synced_at, deleted_at)
  select p.org_id, 'payment', p.id, 'payments', p.created_at, 'payments',
         to_char(p.amount, 'FM999999990.00') || ' on ' || to_char(p.paid_on, 'DD Mon YYYY'),
         concat_ws(' · ', 'Payment against ' || f.doc_number, nullif(p.method,''), nullif(p.reference,'')),
         case when p.confirmed_at is null then 'unconfirmed' else 'confirmed' end,
         jsonb_strip_nulls(jsonb_build_object(
           'amount', p.amount, 'paid_on', p.paid_on, 'method', p.method,
           'reference', p.reference, 'note', p.note, 'document_id', p.document_id,
           'document_number', f.doc_number,
           'submitted_by_recipient', p.submitted_by_recipient,
           'confirmed_at', p.confirmed_at, 'created_at', p.created_at)),
         now(), null
    from public.payments p
    join public.financial_documents f on f.id = p.document_id
   where p.org_id = p_org
  on conflict (org_id, kind, entity_id) do update
    set label = excluded.label, summary = excluded.summary, state = excluded.state,
        facts = excluded.facts, synced_at = now(), deleted_at = null;
  get diagnostics v_n = row_count; v_nodes := v_nodes + v_n;

  v_removed := v_removed + app.brain_tombstone(p_org, 'payment',
    coalesce((select array_agg(id) from public.payments where org_id = p_org), '{}'::uuid[]));

  insert into public.brain_nodes
    (org_id, kind, entity_id, source_table, source_updated_at, resource, label, summary, state, facts, synced_at, deleted_at)
  select r.org_id, 'recurring_invoice', r.id, 'recurring_invoices', r.updated_at, 'recurring_invoices',
         r.bill_to_name || ' · ' || r.frequency,
         'Recurring ' || r.frequency || ' · next ' || coalesce(to_char(r.next_invoice_date, 'DD Mon YYYY'), 'unscheduled'),
         case when r.active then 'active' else 'paused' end,
         jsonb_strip_nulls(jsonb_build_object(
           'bill_to_name', r.bill_to_name, 'bill_to_email', r.bill_to_email,
           'customer_id', r.customer_id, 'frequency', r.frequency,
           'start_date', r.start_date, 'end_date', r.end_date,
           'next_invoice_date', r.next_invoice_date, 'total_cycles', r.total_cycles,
           'cycles_completed', r.cycles_completed, 'auto_action', r.auto_action,
           'grand_total', r.grand_total, 'active', r.active, 'created_at', r.created_at)),
         now(), null
    from public.recurring_invoices r
   where r.org_id = p_org and (p_since is null or r.updated_at > p_since)
  on conflict (org_id, kind, entity_id) do update
    set label = excluded.label, summary = excluded.summary, state = excluded.state,
        facts = excluded.facts, source_updated_at = excluded.source_updated_at,
        synced_at = now(), deleted_at = null;
  get diagnostics v_n = row_count; v_nodes := v_nodes + v_n;

  v_removed := v_removed + app.brain_tombstone(p_org, 'recurring_invoice',
    coalesce((select array_agg(id) from public.recurring_invoices where org_id = p_org), '{}'::uuid[]));

  return jsonb_build_object('nodes', v_nodes, 'removed', v_removed);
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Revenue by country, computed in PostgreSQL
-- ═════════════════════════════════════════════════════════════════════════════
-- Bucketed on the ISO code so the primary key (org_id, key, bucket) is stable,
-- with the readable name in dims — the same pattern headcount.by_department
-- uses, and for the same reason: the model has to be able to say "India", not
-- "IN".
--
-- The cast to text on that coalesce is not cosmetic: country_code is char(2),
-- and coalescing it against a seven-character literal resolves to char(2) and
-- fails with "value too long" the first time a document has no country.
-- Documents with no country_code get the bucket 'unknown' rather than being
-- dropped. A country breakdown whose parts silently fail to add up to
-- revenue.collected is worse than one that says how much it cannot place, and
-- 'unknown' is also the only honest signal that 0013's backfill has not reached
-- some rows.
--
-- The predicate is the one revenue.collected and revenue.billed already use —
-- invoices, not cancelled — so the buckets sum to the org-wide total the model
-- quotes alongside them. A second meaning for the word "revenue" on the same
-- screen is exactly the confusion this migration exists to end.
create or replace function app.brain_refresh_metrics_geo(p_org uuid)
returns integer language plpgsql set search_path = public, pg_temp as $fn$
declare v_n integer;
begin
  insert into public.brain_metrics (org_id, key, bucket, value, dims, definition, resource)
  select p_org, 'revenue.billed_by_country', coalesce(f.country_code::text, 'unknown'),
         coalesce(sum(f.grand_total), 0),
         jsonb_build_object('country_code', f.country_code,
                            'country', coalesce(cc.name, 'Not recorded on the document')),
         'Invoiced per country. The country is the one stamped on each invoice when it was issued '
         '(financial_documents.country_code) - the company''s definition of where a sale happened. '
         'It is NOT the country_code on the client record: that is only one of the defaults which '
         'may have produced it, and editing a client would otherwise rewrite past sales history. '
         'Where the two disagree, this figure is the correct one. Buckets sum to revenue.billed.',
         'financial_documents'
    from public.financial_documents f
    left join public.country_codes cc on cc.code = f.country_code
   where f.org_id = p_org and f.type = 'invoice' and f.status <> 'cancelled'
   group by f.country_code, cc.name

  union all
  select p_org, 'revenue.collected_by_country', coalesce(f.country_code::text, 'unknown'),
         coalesce(sum(f.amount_paid), 0),
         jsonb_build_object('country_code', f.country_code,
                            'country', coalesce(cc.name, 'Not recorded on the document')),
         'Cash received per country, on the country stamped on the invoice at issue time, not the '
         'country on the client record. This is the figure that answers "which country generates '
         'the most revenue". Buckets sum to revenue.collected.',
         'financial_documents'
    from public.financial_documents f
    left join public.country_codes cc on cc.code = f.country_code
   where f.org_id = p_org and f.type = 'invoice' and f.status <> 'cancelled'
   group by f.country_code, cc.name

  union all
  select p_org, 'revenue.outstanding_by_country', coalesce(f.country_code::text, 'unknown'),
         coalesce(sum(f.grand_total - f.amount_paid), 0),
         jsonb_build_object('country_code', f.country_code,
                            'country', coalesce(cc.name, 'Not recorded on the document')),
         'Invoiced and not yet collected, per country of issue. Buckets sum to revenue.outstanding.',
         'financial_documents'
    from public.financial_documents f
    left join public.country_codes cc on cc.code = f.country_code
   where f.org_id = p_org and f.type = 'invoice' and f.status <> 'cancelled'
     and f.amount_paid < f.grand_total - 0.01
   group by f.country_code, cc.name

  union all
  select p_org, 'invoices.count_by_country', coalesce(f.country_code::text, 'unknown'), count(*),
         jsonb_build_object('country_code', f.country_code,
                            'country', coalesce(cc.name, 'Not recorded on the document')),
         'Non-cancelled invoices issued per country. The denominator behind the revenue split.',
         'financial_documents'
    from public.financial_documents f
    left join public.country_codes cc on cc.code = f.country_code
   where f.org_id = p_org and f.type = 'invoice' and f.status <> 'cancelled'
   group by f.country_code, cc.name;

  get diagnostics v_n = row_count;
  return v_n;
end $fn$;

revoke all on function app.brain_refresh_metrics_geo(uuid) from public;

-- ── Splicing the group into the refresh ──────────────────────────────────────
-- 0035's function is renamed rather than rewritten, and the name it vacates is
-- taken by a wrapper that runs it and then adds this group. brain_sync calls
-- app.brain_refresh_metrics(p_org) and reads 'metrics' and 'errors' off the
-- result, both of which the wrapper preserves, so the caller is untouched.
--
-- Guarded on the rename having already happened, so re-running this migration
-- is safe and cannot nest the wrapper inside itself.
do $mig$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app' and p.proname = 'brain_refresh_metrics_core'
  ) then
    alter function app.brain_refresh_metrics(uuid) rename to brain_refresh_metrics_core;
  end if;
end $mig$;

create or replace function app.brain_refresh_metrics(p_org uuid)
returns jsonb language plpgsql set search_path = public, pg_temp as $fn$
declare
  v_res jsonb;
  v_n   integer := 0;
begin
  -- The core deletes every metric for the org and rewrites them, so it has to
  -- run first: this group is an addition to that pass, not a separate one.
  v_res := app.brain_refresh_metrics_core(p_org);

  begin
    v_n := app.brain_refresh_metrics_geo(p_org);
  exception when others then
    -- Its own exception block, exactly like every group inside the core: a
    -- tenant whose 0013 backfill has not run loses the country split and keeps
    -- the other thirty numbers.
    return jsonb_build_object(
      'metrics', coalesce((v_res->>'metrics')::integer, 0),
      'failed_groups', coalesce(v_res->'failed_groups', '[]'::jsonb) || jsonb_build_array('geo'),
      'errors', coalesce(v_res->'errors', '[]'::jsonb) || jsonb_build_array(
                  jsonb_build_object('domain', 'metrics.geo', 'error', sqlerrm, 'at', now())));
  end;

  return v_res || jsonb_build_object('metrics', coalesce((v_res->>'metrics')::integer, 0) + v_n);
end $fn$;

revoke all on function app.brain_refresh_metrics(uuid) from public;

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Make it true for the rows already in the table
-- ═════════════════════════════════════════════════════════════════════════════
-- 0013 backfilled country_code for the documents that existed when it ran. A
-- document whose customer had no country at the time — and whose org had no
-- country_code either, so the org_default leg of the chain returned nothing —
-- is still null today, and every such row lands in the 'unknown' bucket and
-- makes the split look broken rather than incomplete.
--
-- So: resolve the org's own country from the free text it registered with,
-- then run 0013's chain again over what is still unresolved. Same loop, and
-- for the same reason it gave — this executes once.
update public.organizations
   set country_code = app.country_code_from_name(country)
 where country_code is null and country is not null;

update public.customers
   set country_code = app.country_from_state(state)
 where country_code is null and app.country_from_state(state) is not null;

do $mig$
declare d record; r record;
begin
  for d in
    select id, org_id, customer_id, bill_to_state
      from public.financial_documents
     where country_code is null
  loop
    select * into r
      from app.resolve_document_country(d.org_id, d.customer_id, d.bill_to_state);

    update public.financial_documents
       set country_code = r.code, country_source = r.src
     where id = d.id and r.code is not null;
  end loop;
end $mig$;

-- Nothing above touched a table the brain projects in a way its triggers would
-- notice as new facts worth re-reading, and the metrics only change on a sync.
-- Marking every org that already has a brain hands them to 0034's drain, which
-- rebuilds the invoice facts and the new aggregates within seconds instead of
-- whenever something else next happens to change.
insert into public.brain_dirty (org_id, marked_at, hits)
select s.org_id, now(), 1 from public.brain_state s
on conflict (org_id) do update
  set marked_at = now(), hits = public.brain_dirty.hits + 1;


-- ############################################################################
-- ## 0038_cash_entries.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0038 — money in and money out that no document represents
--
-- THE GAP THIS FILLS: revenue in EdgeOS could only arrive as an invoice. Cash
-- taken over the counter, a retainer paid in advance, interest credited by the
-- bank, a grant, a founder putting money in — none of it could be entered at
-- all, so every figure downstream (Billing & Revenue, Profit & Loss, the
-- Overview, EdgeBrain's revenue.* metrics) answered a narrower question than
-- the one being asked of it. Money out fared slightly better: `expenses` has
-- existed since 0001, but with one free-text category, no payer, no method, no
-- link to the product or the person the money was spent on, and two divergent
-- category lists hard-coded in two React files.
--
-- Three things are added:
--
--   finance_categories  reference data: the whole A–Z of reasons money moves,
--                       each one carrying its ACCOUNTING TREATMENT. This is the
--                       part that matters. "Loan received" is cash in and is
--                       not revenue; "equipment" is cash out and is not an
--                       expense; "owner drawings" is neither. A category list
--                       that does not say so produces a P&L that is wrong in
--                       exactly the way nobody notices.
--   income_entries      money in, with its category, party, method, GST and
--                       receipt — the mirror image of a purchase invoice.
--   expenses (+cols)    method, reference, the employee or product the spend
--                       belongs to, payment status, and the same treatment.
--
-- The treatment lives in the database rather than in JavaScript because three
-- consumers have to agree about it: the finance pages, the Overview, and
-- EdgeBrain's metrics — and the last of those is SQL, so the other two come
-- to it.
--
-- RE-RUNNABLE, throughout. Not a stylistic preference: this file creates two
-- tables, alters a third, seeds ~90 reference rows, adds a permission resource
-- and rewrites three EdgeBrain functions, and a single failure part-way through
-- would otherwise leave the schema in a state where neither finishing nor
-- starting again is possible. Every create is `if not exists` or preceded by a
-- `drop … if exists`, every insert has an `on conflict`, every rename is
-- guarded on not having happened, and the permission fan-out is called
-- explicitly rather than left to a trigger that does nothing on a re-run. Run
-- it as many times as needed.
-- ─────────────────────────────────────────────────────────────────────────────

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. The taxonomy
-- ═════════════════════════════════════════════════════════════════════════════
-- Reference data with no org_id, on the country_codes pattern (0012): every
-- signed-in user reads it, nobody writes it from a browser. A tenant who needs
-- a category that is not here is better served by asking for it than by each
-- org inventing its own spelling of "Salaries" and making any comparison
-- between two orgs — or between two years — impossible.
--
-- `treatment` is the whole point of the table. Its ten values split by
-- direction:
--
--   in   revenue        earned from customers; the top line of the P&L
--        other_income   earned, but not from operating (interest, rent, scrap)
--        capital_in     cash, NOT income (funding, loans, deposits received)
--        cost_recovery  money coming back (vendor refund, reimbursement) —
--                       reduces an expense rather than adding to income
--
--   out  operating      an ordinary cost of running; a P&L expense
--        non_operating  a real expense, below the operating line (interest,
--                       penalties, forex loss)
--        capex          buying an asset. Cash out, not an expense — it would be
--                       depreciated, and EdgeOS keeps no fixed-asset register,
--                       so it stays out of the P&L rather than distorting it.
--        financing      repaying loan principal, placing a deposit. Neither.
--        owner          drawings and dividends. A distribution of profit, not a
--                       cost of making it.
--        tax            income tax, TDS and GST remittances. Settling a
--                       liability the Tax Summary already computed; counting it
--                       as an expense would charge it twice.
--
-- Everything shows in cash flow whatever its treatment. That distinction —
-- cash moved vs. profit changed — is the one a single expenses table with a
-- free-text category could not express.

create table if not exists public.finance_categories (
  key         text primary key check (length(btrim(key)) > 0),
  label       text not null,
  direction   text not null check (direction in ('in', 'out')),
  group_label text not null,
  treatment   text not null check (treatment in (
                'revenue', 'other_income', 'capital_in', 'cost_recovery',
                'operating', 'non_operating', 'capex', 'financing', 'owner', 'tax')),
  hint        text,
  sort_order  integer not null default 500,
  -- Legacy category strings from 0001 and 0028 live here with active = false:
  -- resolvable, so an existing row still has a label and — more to the point —
  -- a treatment, but absent from the pickers so nothing new is filed under them.
  active      boolean not null default true,
  constraint finance_categories_direction_matches_treatment check (
    (direction = 'in'  and treatment in ('revenue','other_income','capital_in','cost_recovery')) or
    (direction = 'out' and treatment in ('operating','non_operating','capex','financing','owner','tax'))
  )
);
create index if not exists finance_categories_pick_idx
  on public.finance_categories (direction, sort_order) where active;

-- ── Money in ─────────────────────────────────────────────────────────────────
insert into public.finance_categories (key, label, direction, group_label, treatment, hint, sort_order) values
  -- Earned from customers
  ('product_sales',        'Product sales',               'in', 'Sales & services', 'revenue',      'Goods sold without raising an invoice — counter sales, marketplace payouts.',        10),
  ('service_income',       'Services & consulting',       'in', 'Sales & services', 'revenue',      'Work delivered and paid for without a document in EdgeOS.',                          20),
  ('subscription_income',  'Subscriptions & retainers',   'in', 'Sales & services', 'revenue',      'Recurring fees collected outside the recurring-invoice engine.',                     30),
  ('project_milestone',    'Project milestone',           'in', 'Sales & services', 'revenue',      'A stage payment on a project.',                                                      40),
  ('advance_received',     'Advance from customer',       'in', 'Sales & services', 'revenue',      'Money taken before the work. If you later invoice it, link the invoice instead.',    50),
  ('training_income',      'Training & workshops',        'in', 'Sales & services', 'revenue',      'Courses, workshops, paid sessions.',                                                 60),
  ('licensing_income',     'Licensing & royalties',       'in', 'Sales & services', 'revenue',      'Licence fees and royalties on your own work.',                                       70),
  ('commission_income',    'Commission & referral',       'in', 'Sales & services', 'revenue',      'Earned for referring or reselling someone else''s product.',                         80),
  ('maintenance_income',   'Maintenance / AMC',           'in', 'Sales & services', 'revenue',      'Annual maintenance and support contracts.',                                          90),
  ('freight_recovered',    'Shipping recovered',          'in', 'Sales & services', 'revenue',      'Delivery charges collected from the customer.',                                     100),
  -- Earned, but not from operating
  ('interest_income',      'Interest & investment',       'in', 'Other income',     'other_income', 'Bank interest, deposits maturing, dividends received.',                             200),
  ('rental_income',        'Rent received',               'in', 'Other income',     'other_income', 'Letting out space or equipment you own.',                                           210),
  ('scrap_sale',           'Scrap & asset sale',          'in', 'Other income',     'other_income', 'Selling off equipment, furniture or scrap.',                                        220),
  ('forex_gain',           'Foreign exchange gain',       'in', 'Other income',     'other_income', 'Gain on converting or settling in another currency.',                               230),
  ('grant_income',         'Grant / subsidy / incentive', 'in', 'Other income',     'other_income', 'Government or institutional support you do not repay.',                             240),
  ('other_income',         'Other income',                'in', 'Other income',     'other_income', 'Anything earned that fits nowhere above.',                                          290),
  -- Cash, not income
  ('capital_contribution', 'Owner / founder capital',     'in', 'Funding',          'capital_in',   'Your own money going in. Cash, not revenue — it never reaches the P&L.',            300),
  ('investment_received',  'Investor funding',            'in', 'Funding',          'capital_in',   'Equity raised. Cash, not revenue.',                                                 310),
  ('loan_received',        'Loan received',               'in', 'Funding',          'capital_in',   'Borrowed money: cash now, a liability until repaid. Never revenue.',                320),
  ('deposit_received',     'Security deposit received',   'in', 'Funding',          'capital_in',   'Held on someone else''s behalf and repayable.',                                     330),
  -- Money coming back
  ('vendor_refund',        'Refund from a vendor',        'in', 'Recoveries',       'cost_recovery','Money back on something you paid for. Reduces that cost; it is not new income.',    400),
  ('reimbursement_in',     'Reimbursement received',      'in', 'Recoveries',       'cost_recovery','A client or employee paying you back for something you covered.',                   410),
  ('tax_refund',           'Tax refund',                  'in', 'Recoveries',       'cost_recovery','Income tax, TDS or GST refunded.',                                                  420)
on conflict (key) do update
  set label = excluded.label, direction = excluded.direction,
      group_label = excluded.group_label, treatment = excluded.treatment,
      hint = excluded.hint, sort_order = excluded.sort_order;

-- ── Money out ────────────────────────────────────────────────────────────────
insert into public.finance_categories (key, label, direction, group_label, treatment, hint, sort_order) values
  -- What the thing you sell costs to make and to deliver
  ('raw_materials',        'Raw materials',               'out', 'Product & delivery', 'operating',     'Inputs consumed making the product.',                                          1000),
  ('inventory_purchase',   'Stock purchased for resale',  'out', 'Product & delivery', 'operating',     'Finished goods bought to sell on.',                                            1010),
  ('manufacturing',        'Manufacturing & job work',    'out', 'Product & delivery', 'operating',     'Fabrication, assembly and job work paid to a third party.',                    1020),
  ('packaging',            'Packaging',                   'out', 'Product & delivery', 'operating',     'Boxes, labels, filler, print on the pack.',                                    1030),
  ('inbound_freight',      'Inbound freight & duty',      'out', 'Product & delivery', 'operating',     'Getting materials to you, customs included.',                                  1040),
  ('shipping_delivery',    'Shipping & delivery',         'out', 'Product & delivery', 'operating',     'Getting the product to the customer.',                                         1050),
  ('subcontracting',       'Subcontracted services',      'out', 'Product & delivery', 'operating',     'Another firm delivering part of what you sold.',                               1060),
  ('hosting_infra',        'Hosting & infrastructure',    'out', 'Product & delivery', 'operating',     'Servers, storage, bandwidth and APIs the product runs on.',                    1070),
  ('payment_fees',         'Payment gateway fees',        'out', 'Product & delivery', 'operating',     'What the processor keeps out of each collection.',                             1080),
  -- Labour
  ('salaries',             'Salaries',                    'out', 'People & labour',    'operating',     'Monthly payroll for employees on the books.',                                  1100),
  ('wages',                'Wages & daily labour',        'out', 'People & labour',    'operating',     'Hourly, daily or piece-rate labour.',                                          1110),
  ('contractor_fees',      'Contractors & freelancers',   'out', 'People & labour',    'operating',     'People paid per engagement rather than on payroll.',                           1120),
  ('intern_stipend',       'Intern stipends',             'out', 'People & labour',    'operating',     'Stipends paid to interns.',                                                    1130),
  ('bonus_incentive',      'Bonus & incentives',          'out', 'People & labour',    'operating',     'Performance pay, festival bonus, sales incentive.',                            1140),
  ('employer_pf_esi',      'PF, ESI & employer dues',     'out', 'People & labour',    'operating',     'The employer''s share of statutory contributions.',                            1150),
  ('gratuity_settlement',  'Gratuity & leave encashment', 'out', 'People & labour',    'operating',     'Settlements paid when someone leaves.',                                        1160),
  ('recruitment',          'Recruitment & hiring',        'out', 'People & labour',    'operating',     'Job boards, agency fees, assessments.',                                        1170),
  ('training_cost',        'Training & development',      'out', 'People & labour',    'operating',     'Courses and certifications for the team.',                                     1180),
  ('employee_benefits',    'Benefits & welfare',          'out', 'People & labour',    'operating',     'Insurance, meals, transport, team welfare.',                                   1190),
  ('reimbursement_out',    'Employee reimbursements',     'out', 'People & labour',    'operating',     'Paying someone back for what they spent on the company.',                      1200),
  -- Winning the work
  ('advertising',          'Advertising & ads',           'out', 'Sales & marketing',  'operating',     'Paid media of any kind.',                                                      1300),
  ('marketing_content',    'Content & creative',          'out', 'Sales & marketing',  'operating',     'Design, video, copy, photography.',                                            1310),
  ('events_exhibitions',   'Events & exhibitions',        'out', 'Sales & marketing',  'operating',     'Stalls, sponsorships, conferences.',                                           1320),
  ('sales_commission',     'Sales commission',            'out', 'Sales & marketing',  'operating',     'Paid out on business that closed.',                                            1330),
  ('client_travel',        'Client travel & hosting',     'out', 'Sales & marketing',  'operating',     'Travel and entertainment for winning or serving a client.',                    1340),
  -- Keeping the lights on
  ('rent',                 'Rent & lease',                'out', 'Operations & admin', 'operating',     'Premises, co-working, equipment leases.',                                      1400),
  ('utilities',            'Utilities',                   'out', 'Operations & admin', 'operating',     'Electricity, water, gas, diesel.',                                             1410),
  ('internet_phone',       'Internet & phone',            'out', 'Operations & admin', 'operating',     'Connectivity and mobile bills.',                                               1420),
  ('software_subs',        'Software & subscriptions',    'out', 'Operations & admin', 'operating',     'The tools the business runs on.',                                              1430),
  ('office_supplies',      'Office supplies',             'out', 'Operations & admin', 'operating',     'Stationery, pantry, consumables.',                                             1440),
  ('repairs_maintenance',  'Repairs & maintenance',       'out', 'Operations & admin', 'operating',     'Fixing what you already own.',                                                 1450),
  ('insurance',            'Insurance',                   'out', 'Operations & admin', 'operating',     'Premiums on any policy.',                                                      1460),
  ('professional_fees',    'Professional fees',           'out', 'Operations & admin', 'operating',     'Accountants, lawyers, consultants, auditors.',                                 1470),
  ('bank_charges',         'Bank charges',                'out', 'Operations & admin', 'operating',     'Account fees, transfer charges, card fees.',                                   1480),
  ('courier_postage',      'Courier & postage',           'out', 'Operations & admin', 'operating',     'Documents and small parcels that are not product delivery.',                   1490),
  ('local_travel',         'Travel & commute',            'out', 'Operations & admin', 'operating',     'Business travel that is not client-facing.',                                   1500),
  ('licences_compliance',  'Licences & compliance',       'out', 'Operations & admin', 'operating',     'Registrations, filings, statutory fees.',                                      1510),
  ('security_housekeeping','Security & housekeeping',     'out', 'Operations & admin', 'operating',     'Guards, cleaning, facility services.',                                         1520),
  ('bad_debt',             'Bad debt written off',        'out', 'Operations & admin', 'operating',     'An invoice accepted as uncollectable.',                                        1530),
  ('donation_csr',         'Donation & CSR',              'out', 'Operations & admin', 'operating',     'Charitable and community spending.',                                           1540),
  ('other_expense',        'Other expense',               'out', 'Operations & admin', 'operating',     'An ordinary running cost that fits nowhere above.',                            1590),
  -- Things you buy and keep
  ('equipment',            'Equipment & machinery',       'out', 'Assets & capital',   'capex',         'Bought, not consumed: cash out, but not a cost — so it does not cut profit.',   1600),
  ('computers',            'Computers & devices',         'out', 'Assets & capital',   'capex',         'Laptops, phones, peripherals.',                                                1610),
  ('furniture',            'Furniture & fittings',        'out', 'Assets & capital',   'capex',         'Desks, chairs, fixtures.',                                                     1620),
  ('vehicle',              'Vehicles',                    'out', 'Assets & capital',   'capex',         'Company vehicles.',                                                            1630),
  ('leasehold_improve',    'Fit-out & improvements',      'out', 'Assets & capital',   'capex',         'Building out a space you lease.',                                              1640),
  ('deposit_paid',         'Security deposit paid',       'out', 'Assets & capital',   'financing',     'Refundable, so not a cost — you still hold the claim.',                        1650),
  -- Money and the taxman
  ('loan_repayment',       'Loan principal repaid',       'out', 'Financing & tax',    'financing',     'Principal only: cash out, but it settles a debt rather than costing you.',     1700),
  ('loan_interest',        'Loan interest',               'out', 'Financing & tax',    'non_operating', 'The cost of borrowing, as opposed to the borrowing itself.',                   1710),
  ('forex_loss',           'Foreign exchange loss',       'out', 'Financing & tax',    'non_operating', 'Loss on converting or settling in another currency.',                          1720),
  ('penalties_fines',      'Penalties & fines',           'out', 'Financing & tax',    'non_operating', 'Late fees, interest on tax, regulatory penalties.',                            1730),
  ('income_tax_paid',      'Income tax paid',             'out', 'Financing & tax',    'tax',           'Advance tax and self-assessment: paid out of profit, not before it.',          1740),
  ('tds_paid',             'TDS deposited',               'out', 'Financing & tax',    'tax',           'Tax withheld on someone else''s behalf and remitted.',                         1750),
  ('gst_paid',             'GST remitted',                'out', 'Financing & tax',    'tax',           'Settling the net liability the Tax Summary computes — not a second cost.',     1760),
  ('owner_drawings',       'Owner drawings',              'out', 'Financing & tax',    'owner',         'Taking money out for yourself: a share of profit, not a cost of earning it.',  1770),
  ('dividend_paid',        'Dividend paid',               'out', 'Financing & tax',    'owner',         'Paid to shareholders out of profit.',                                          1780)
on conflict (key) do update
  set label = excluded.label, direction = excluded.direction,
      group_label = excluded.group_label, treatment = excluded.treatment,
      hint = excluded.hint, sort_order = excluded.sort_order;

-- ── Legacy strings, kept resolvable ──────────────────────────────────────────
-- Every category value an existing expenses or purchase_invoices row can hold,
-- from 0001's list and 0028's. Inactive, so they are never offered again, but
-- present so that history keeps a label and a treatment instead of falling
-- through to a default — which would quietly restate what the P&L says about
-- periods that are already closed.
insert into public.finance_categories (key, label, direction, group_label, treatment, hint, sort_order, active) values
  ('Operations',        'Operations (legacy)',        'out', 'Legacy', 'operating', null, 9000, false),
  ('Marketing',         'Marketing (legacy)',         'out', 'Legacy', 'operating', null, 9010, false),
  ('Salaries',          'Salaries (legacy)',          'out', 'Legacy', 'operating', null, 9020, false),
  ('Tools & Software',  'Tools & Software (legacy)',  'out', 'Legacy', 'operating', null, 9030, false),
  ('Office',            'Office (legacy)',            'out', 'Legacy', 'operating', null, 9040, false),
  ('Travel',            'Travel (legacy)',            'out', 'Legacy', 'operating', null, 9050, false),
  ('Other',             'Other (legacy)',             'out', 'Legacy', 'operating', null, 9060, false),
  ('Inventory',         'Inventory (legacy)',         'out', 'Legacy', 'operating', null, 9070, false),
  ('Software',          'Software (legacy)',          'out', 'Legacy', 'operating', null, 9080, false),
  ('Hardware',          'Hardware (legacy)',          'out', 'Legacy', 'operating', null, 9090, false),
  ('Utilities',         'Utilities (legacy)',         'out', 'Legacy', 'operating', null, 9100, false),
  ('Professional fees', 'Professional fees (legacy)', 'out', 'Legacy', 'operating', null, 9110, false),
  ('Rent',              'Rent (legacy)',              'out', 'Legacy', 'operating', null, 9120, false)
on conflict (key) do nothing;
-- The live keys are snake_case ('rent', 'utilities', 'professional_fees'), so
-- none of these collide — the capitalisation is what marks a value as coming
-- from the old hard-coded lists.

alter table public.finance_categories enable row level security;
alter table public.finance_categories force  row level security;
drop policy if exists finance_categories_select on public.finance_categories;
create policy finance_categories_select on public.finance_categories
  for select to authenticated using (true);
-- No write policy: the taxonomy changes by migration, not from a browser.
revoke all on public.finance_categories from anon;
grant select on public.finance_categories to authenticated;
grant all    on public.finance_categories to service_role;

-- The one place a category is turned into a treatment. A key that is not in the
-- table — only reachable from a client that has not reloaded since this
-- migration — falls back to the neutral treatment for its direction, which is
-- also the treatment every legacy row above was given.
create or replace function app.finance_treatment(p_key text, p_direction text)
returns text language sql stable set search_path = public, pg_temp as $$
  select coalesce(
    (select c.treatment from public.finance_categories c
      where c.key = p_key and c.direction = p_direction),
    case when p_direction = 'in' then 'revenue' else 'operating' end);
$$;

-- Called only from the two guard triggers below, which are SECURITY DEFINER and
-- so reach it as the owner. Nothing else should.
revoke all on function app.finance_treatment(text, text) from public;

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. income_entries — money in
-- ═════════════════════════════════════════════════════════════════════════════
-- Deliberately NOT a second kind of invoice. An invoice is a numbered document
-- issued to a party, printable and owed; this is a line in the cash book saying
-- money arrived and why. Keeping the two apart is what stops one rupee being
-- counted twice, and `document_id` exists so that when an entry IS the receipt
-- of an invoice the link is explicit and the analytics can exclude it.

create table if not exists public.income_entries (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete cascade,
  category       text not null default 'other_income' references public.finance_categories(key),
  -- Derived from category by the guard below. Stored rather than computed on
  -- read, so that re-categorising the taxonomy later cannot restate a period
  -- that has already been reported.
  treatment      text not null default 'revenue',
  description    text not null check (length(btrim(description)) > 0),
  client_id      uuid references public.clients(id) on delete set null,
  received_on    date not null default current_date,
  amount         numeric(14,2) not null check (amount >= 0),               -- gross, as received
  tax_amount     numeric(14,2) not null default 0 check (tax_amount >= 0), -- output GST inside `amount`
  net_amount     numeric(14,2) not null default 0,                         -- amount − tax_amount, derived
  payment_method text not null default 'bank_transfer'
                 check (payment_method in ('cash','bank_transfer','upi','card','cheque','wallet','other')),
  reference      text,                                                     -- UTR, cheque no., payout id
  -- Where the money came from, on 0037's terms, so that a revenue-by-country
  -- answer which includes counter sales still reconciles.
  country_code   char(2) references country_codes(code),
  -- Set when this entry records the receipt of an invoice that is also tracked
  -- as a document; such entries are excluded from revenue so the invoice is not
  -- counted twice.
  document_id    uuid references public.financial_documents(id) on delete set null,
  receipt_path   text,
  notes          text,
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint income_tax_lte_amount check (tax_amount <= amount + 0.01)
);
create index if not exists income_entries_org_date_idx on public.income_entries (org_id, received_on desc);
create index if not exists income_entries_client_idx   on public.income_entries (client_id)   where client_id is not null;
create index if not exists income_entries_doc_idx      on public.income_entries (document_id) where document_id is not null;

-- The same shape as app.purchase_invoice_guard (0028): cross-tenant references
-- are refused here rather than trusted to the foreign key, derived columns are
-- computed here rather than accepted from the client, and the country falls
-- back through the client to the organisation so a row is never needlessly
-- unplaceable on a map.
-- SECURITY DEFINER, and it has to be: the body calls app.finance_treatment(),
-- and `authenticated` has no USAGE on schema app (0002), so as an invoker-rights
-- function every insert would fail with "permission denied for schema app". The
-- pinned search_path is what makes definer rights safe here. It also means the
-- three cross-tenant checks are not themselves subject to RLS, which is correct:
-- they are scoped by new.org_id and either raise or do not, and under the
-- caller's privileges a member without `clients.view` would have been told a
-- client of their own org does not belong to it.
create or replace function app.income_entry_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_country char(2);
begin
  if new.client_id is not null and not exists (
       select 1 from public.clients c where c.id = new.client_id and c.org_id = new.org_id) then
    raise exception 'client % does not belong to this organization', new.client_id
      using errcode = '23503';
  end if;
  if new.document_id is not null and not exists (
       select 1 from public.financial_documents f
        where f.id = new.document_id and f.org_id = new.org_id) then
    raise exception 'document % does not belong to this organization', new.document_id
      using errcode = '23503';
  end if;

  new.treatment  := app.finance_treatment(new.category, 'in');
  new.net_amount := round(new.amount - new.tax_amount, 2);

  if new.country_code is null then
    select coalesce(c.country_code, o.country_code) into v_country
      from public.organizations o
      left join public.clients c on c.id = new.client_id
     where o.id = new.org_id;
    new.country_code := v_country;
  end if;

  new.updated_at := now();
  return new;
end $$;

drop trigger if exists income_entries_guard on public.income_entries;
create trigger income_entries_guard
  before insert or update on public.income_entries
  for each row execute function app.income_entry_guard();

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. expenses grows the fields the money-out story needed
-- ═════════════════════════════════════════════════════════════════════════════
-- Additive and defaulted, so every existing row stays valid and every existing
-- reader keeps working. `treatment` is backfilled through the same function the
-- new rows use — which is why the legacy category strings had to be seeded.
alter table public.expenses
  add column if not exists treatment      text not null default 'operating',
  add column if not exists payment_method text not null default 'bank_transfer',
  add column if not exists reference      text,
  -- Who the money was spent on (payroll, stipend, reimbursement) and what it
  -- was spent on (a product or project). Both optional; both are what turns
  -- "we spent four lakh on labour" into "and here is exactly where".
  add column if not exists employee_id    uuid references public.employees(id) on delete set null,
  add column if not exists product_id     uuid references public.products(id)  on delete set null,
  add column if not exists status         text not null default 'paid',
  add column if not exists paid_on        date,
  add column if not exists notes          text,
  add column if not exists created_by     uuid references auth.users(id) on delete set null,
  add column if not exists updated_at     timestamptz not null default now();

-- Named constraints added conditionally: `add column if not exists` is
-- re-runnable, an unguarded `add constraint` is not.
do $mig$
begin
  if not exists (select 1 from pg_constraint where conname = 'expenses_payment_method_check') then
    alter table public.expenses add constraint expenses_payment_method_check
      check (payment_method in ('cash','bank_transfer','upi','card','cheque','wallet','other'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'expenses_status_check') then
    alter table public.expenses add constraint expenses_status_check
      check (status in ('paid','pending'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'expenses_treatment_check') then
    alter table public.expenses add constraint expenses_treatment_check
      check (treatment in ('operating','non_operating','capex','financing','owner','tax'));
  end if;
  -- 0028 added tax_amount without bounding it against the amount it is supposed
  -- to be part of, so an expense could claim more input GST than it cost. The
  -- UI has always refused it; the table never did.
  if not exists (select 1 from pg_constraint where conname = 'expenses_tax_lte_amount') then
    alter table public.expenses add constraint expenses_tax_lte_amount
      check (tax_amount <= amount + 0.01);
  end if;
end $mig$;

-- SECURITY DEFINER for the same two reasons as app.income_entry_guard() above.
create or replace function app.expense_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.vendor_id is not null and not exists (
       select 1 from public.vendors v where v.id = new.vendor_id and v.org_id = new.org_id) then
    raise exception 'vendor % does not belong to this organization', new.vendor_id
      using errcode = '23503';
  end if;
  if new.employee_id is not null and not exists (
       select 1 from public.employees e where e.id = new.employee_id and e.org_id = new.org_id) then
    raise exception 'employee % does not belong to this organization', new.employee_id
      using errcode = '23503';
  end if;
  if new.product_id is not null and not exists (
       select 1 from public.products p where p.id = new.product_id and p.org_id = new.org_id) then
    raise exception 'product % does not belong to this organization', new.product_id
      using errcode = '23503';
  end if;

  new.treatment := app.finance_treatment(new.category, 'out');
  -- A spend marked paid has a payment date; one still pending must not keep a
  -- stale one, which is how a cash-flow chart starts showing money leaving on a
  -- day it did not.
  if new.status = 'paid' and new.paid_on is null then new.paid_on := new.incurred_on; end if;
  if new.status <> 'paid' then new.paid_on := null; end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists expenses_guard on public.expenses;
create trigger expenses_guard
  before insert or update on public.expenses
  for each row execute function app.expense_guard();

-- Backfill: rows that predate the trigger get the treatment and paid_on it
-- would have given them.
update public.expenses
   set treatment = app.finance_treatment(category, 'out'),
       paid_on   = coalesce(paid_on, incurred_on)
 where paid_on is null or treatment <> app.finance_treatment(category, 'out');

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. Permissions, RLS and audit
-- ═════════════════════════════════════════════════════════════════════════════
-- Every statement in this section is written to be safely re-runnable. The
-- policies 0027 generates are `app.has_permission(org_id, 'income_entries', …)`
-- and nothing else, so a tenant whose role_permissions never received the row
-- gets a bare 403 on the first insert with no hint as to why. Re-running this
-- block is the repair, and it has to work whether the earlier statements landed
-- or not.
insert into public.permission_resources (key, label, category, description, actions, sort_order) values
  ('income_entries', 'Income entries', 'Finance',
   'Money received that no invoice represents — cash sales, retainers, interest, funding.',
   array['view','create','edit','delete'], 425)
on conflict (key) do update
  set label       = excluded.label,
      category    = excluded.category,
      description = excluded.description,
      actions     = excluded.actions,
      sort_order  = excluded.sort_order;

-- Read by everyone, written by members, deleted by admins: the shape `expenses`
-- has had since 0026, because an income entry is the same kind of record seen
-- from the other side.
--
-- Driven off `roles` rather than a literal list, so a tenant on a deployment
-- that has added a role still gets a row for it — a role with no row at all is
-- a role that silently cannot use the feature.
insert into public.role_permission_defaults (role, resource, can_view, can_create, can_edit, can_delete)
select r.key, 'income_entries',
       true,
       r.key in ('owner','admin','member'),
       r.key in ('owner','admin','member'),
       r.key in ('owner','admin')
  from public.roles r
 where r.key in ('owner','admin','member','viewer')
on conflict (role, resource) do nothing;

-- 0026's statement trigger on role_permission_defaults normally fans the new
-- defaults out to every organization. It is called here explicitly as well,
-- because the trigger does nothing when the insert above was a no-op (a partial
-- earlier run), and because a deployment that lost the trigger would otherwise
-- leave every existing org without the row and refuse every insert with a 403.
select app.sync_role_permissions(null);

select app.secure_tenant_table('public.income_entries'::regclass, 'income_entries');

grant select, insert, update, delete on public.income_entries to authenticated;
grant all on public.income_entries to service_role;

drop trigger if exists income_entries_audit on public.income_entries;
create trigger income_entries_audit after insert or update or delete on public.income_entries
  for each row execute function app.write_audit();

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. EdgeBrain reads it too
-- ═════════════════════════════════════════════════════════════════════════════
-- Without this the assistant would answer "what was our revenue?" from invoices
-- alone and be confidently short by whatever came in over the counter — the
-- same class of failure 0037 was written to end, so it is prevented the same
-- way: nodes for the entities, aggregates with their definitions attached for
-- the totals, and the word "revenue" given exactly one meaning.

-- ── Nodes ────────────────────────────────────────────────────────────────────
-- 0033's brain_sync_spend is renamed rather than restated, and the name it
-- vacates is taken by a wrapper that runs it and then adds income entries. The
-- orchestrator calls app.brain_sync_spend(p_org, v_since) and reads 'nodes' and
-- 'removed' off the result; both are preserved. Guarded, so re-running this
-- migration cannot nest the wrapper inside itself.
do $mig$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app' and p.proname = 'brain_sync_spend_core'
  ) then
    alter function app.brain_sync_spend(uuid, timestamptz) rename to brain_sync_spend_core;
  end if;
end $mig$;

create or replace function app.brain_sync_spend(p_org uuid, p_since timestamptz default null)
returns jsonb language plpgsql set search_path = public, pg_temp as $fn$
declare v_res jsonb; v_nodes integer := 0; v_removed integer := 0; v_n integer;
begin
  v_res     := app.brain_sync_spend_core(p_org, p_since);
  v_nodes   := coalesce((v_res->>'nodes')::int, 0);
  v_removed := coalesce((v_res->>'removed')::int, 0);

  insert into public.brain_nodes
    (org_id, kind, entity_id, source_table, source_updated_at, resource, label, summary, state, facts, synced_at, deleted_at)
  select i.org_id, 'income_entry', i.id, 'income_entries', i.updated_at, 'income_entries',
         i.description,
         concat_ws(' · ', coalesce(fc.label, i.category),
                   to_char(i.amount, 'FM999999990.00'),
                   to_char(i.received_on, 'DD Mon YYYY'),
                   nullif(c.name, '')),
         i.treatment,
         jsonb_strip_nulls(jsonb_build_object(
           'description', i.description, 'category', i.category,
           'category_label', fc.label, 'treatment', i.treatment,
           -- Spelled out on every node, because "is this revenue?" is precisely
           -- the question a model gets wrong when left to infer it from a name.
           'counts_as_revenue', i.treatment in ('revenue','other_income')
                                and i.document_id is null,
           'amount', i.amount, 'tax_amount', i.tax_amount, 'net_amount', i.net_amount,
           'received_on', i.received_on, 'payment_method', i.payment_method,
           'reference', i.reference, 'client_id', i.client_id, 'client_name', c.name,
           'country_code', i.country_code, 'document_id', i.document_id,
           'notes', i.notes, 'created_at', i.created_at)),
         now(), null
    from public.income_entries i
    left join public.finance_categories fc on fc.key = i.category
    left join public.clients c on c.id = i.client_id
   where i.org_id = p_org and (p_since is null or i.updated_at > p_since)
  on conflict (org_id, kind, entity_id) do update
    set label = excluded.label, summary = excluded.summary, state = excluded.state,
        facts = excluded.facts, source_updated_at = excluded.source_updated_at,
        synced_at = now(), deleted_at = null;
  get diagnostics v_n = row_count; v_nodes := v_nodes + v_n;

  v_removed := v_removed + app.brain_tombstone(p_org, 'income_entry',
    coalesce((select array_agg(id) from public.income_entries where org_id = p_org), '{}'::uuid[]));

  return jsonb_build_object('nodes', v_nodes, 'removed', v_removed);
end $fn$;

revoke all on function app.brain_sync_spend(uuid, timestamptz) from public;

-- ── Aggregates ───────────────────────────────────────────────────────────────
-- Every figure carries the definition that makes it quotable in a sentence.
-- The pair that matters most is income.direct_revenue against cash_in.total:
-- they differ by exactly the funding and the refunds, and a model that answers
-- a revenue question with the second is the failure this group exists to make
-- impossible.
create or replace function app.brain_refresh_metrics_cash(p_org uuid)
returns integer language plpgsql set search_path = public, pg_temp as $fn$
declare v_n integer;
begin
  insert into public.brain_metrics (org_id, key, bucket, value, dims, definition, resource)
  select p_org, 'income.direct_revenue', '', coalesce(sum(i.net_amount), 0), '{}'::jsonb,
         'Revenue received WITHOUT an invoice - counter sales, retainers, work billed outside '
         'EdgeOS - at net value, excluding the GST collected on it. Entries linked to an invoice are '
         'excluded so nothing counts twice, and funding and refunds are excluded because they are not '
         'earned. Total revenue = revenue.billed (or revenue.collected, on a cash basis) PLUS this '
         'number; quoting revenue.* alone understates any business that also takes money directly.',
         'income_entries'
    from public.income_entries i
   where i.org_id = p_org and i.document_id is null
     and i.treatment in ('revenue', 'other_income')

  union all
  select p_org, 'income.direct_revenue_by_month', to_char(i.received_on, 'YYYY-MM'),
         coalesce(sum(i.net_amount), 0), '{}'::jsonb,
         'Non-invoice revenue by the month the money arrived, net of GST.', 'income_entries'
    from public.income_entries i
   where i.org_id = p_org and i.document_id is null
     and i.treatment in ('revenue', 'other_income')
     and i.received_on >= (date_trunc('month', current_date) - interval '11 months')::date
   group by to_char(i.received_on, 'YYYY-MM')

  union all
  select p_org, 'income.by_category', i.category, coalesce(sum(i.net_amount), 0),
         jsonb_build_object('category', i.category, 'label', coalesce(fc.label, i.category),
                            'treatment', i.treatment,
                            'counts_as_revenue', i.treatment in ('revenue','other_income')),
         'Money in per reason, net of GST. Buckets whose treatment is capital_in (funding, loans, '
         'deposits received) or cost_recovery (refunds) are cash but NOT revenue, and belong in no '
         'revenue total.', 'income_entries'
    from public.income_entries i
    left join public.finance_categories fc on fc.key = i.category
   where i.org_id = p_org
   group by i.category, i.treatment, fc.label

  union all
  select p_org, 'income.funding_received', '', coalesce(sum(i.amount), 0), '{}'::jsonb,
         'Capital put in or borrowed: owner contributions, investor funding, loans and deposits '
         'received. Cash, never revenue, and never to be added to a revenue figure.',
         'income_entries'
    from public.income_entries i
   where i.org_id = p_org and i.treatment = 'capital_in'

  union all
  select p_org, 'cash_in.total', '', coalesce(sum(i.amount), 0), '{}'::jsonb,
         'Every rupee recorded as arriving through the cash book, gross and for any reason - '
         'revenue, funding and refunds together. A cash-flow figure, not an income figure.',
         'income_entries'
    from public.income_entries i where i.org_id = p_org

  -- ── Money out, by what it actually does to profit ──────────────────────────
  union all
  select p_org, 'spend.by_category', e.category, coalesce(sum(e.amount - e.tax_amount), 0),
         jsonb_build_object('category', e.category, 'label', coalesce(fc.label, e.category),
                            'treatment', e.treatment,
                            'group', coalesce(fc.group_label, 'Legacy'),
                            'hits_profit', e.treatment in ('operating','non_operating')),
         'Money out per reason, net of the input GST claimed back. Buckets whose treatment is capex, '
         'financing, owner or tax are cash leaving the business but are NOT expenses: an asset '
         'purchase, a loan repayment, a drawing and a tax remittance each reduce the bank balance '
         'without reducing profit. Only the operating and non_operating buckets sum to the P&L '
         'expense line.', 'expenses'
    from public.expenses e
    left join public.finance_categories fc on fc.key = e.category
   where e.org_id = p_org
   group by e.category, e.treatment, fc.label, fc.group_label

  union all
  select p_org, 'spend.by_group', coalesce(fc.group_label, 'Legacy'),
         coalesce(sum(e.amount - e.tax_amount), 0),
         jsonb_build_object('group', coalesce(fc.group_label, 'Legacy')),
         'Money out rolled up to the reason-group: product and delivery, people and labour, sales and '
         'marketing, operations and admin, assets and capital, financing and tax. This is the answer '
         'to "where does our money go".', 'expenses'
    from public.expenses e
    left join public.finance_categories fc on fc.key = e.category
   where e.org_id = p_org
   group by fc.group_label

  union all
  select p_org, 'spend.labour_total', '', coalesce(sum(e.amount - e.tax_amount), 0), '{}'::jsonb,
         'Everything spent on people: salaries, wages, contractors, stipends, bonuses, statutory '
         'employer dues, recruitment, training, benefits and reimbursements, net of input GST. '
         'Expense entries only - labour billed on a vendor bill sits in payables instead.',
         'expenses'
    from public.expenses e
    join public.finance_categories fc on fc.key = e.category
   where e.org_id = p_org and fc.group_label = 'People & labour'

  union all
  select p_org, 'spend.product_total', '', coalesce(sum(e.amount - e.tax_amount), 0), '{}'::jsonb,
         'Everything spent making and delivering what you sell: materials, stock, manufacturing, '
         'packaging, freight, shipping, subcontracting, hosting and payment fees, net of input GST. '
         'The cost side of gross margin.', 'expenses'
    from public.expenses e
    join public.finance_categories fc on fc.key = e.category
   where e.org_id = p_org and fc.group_label = 'Product & delivery'

  union all
  select p_org, 'spend.operating_total', '', coalesce(sum(e.amount - e.tax_amount), 0), '{}'::jsonb,
         'Expense entries that reduce profit (treatment operating or non_operating), net of input '
         'GST. This is the figure that belongs in a P&L; expenses.total is gross and also contains '
         'asset purchases, loan repayments, drawings and tax remittances, which do not.', 'expenses'
    from public.expenses e
   where e.org_id = p_org and e.treatment in ('operating', 'non_operating')

  union all
  select p_org, 'cash_out.total', '', coalesce(sum(e.amount), 0), '{}'::jsonb,
         'Every rupee recorded as leaving through expense entries, gross and for any reason. A '
         'cash-flow figure, not an expense figure.', 'expenses'
    from public.expenses e where e.org_id = p_org

  union all
  select p_org, 'spend.pending', '', coalesce(sum(e.amount), 0), '{}'::jsonb,
         'Recorded spend that has not actually been paid out yet.', 'expenses'
    from public.expenses e where e.org_id = p_org and e.status = 'pending';

  get diagnostics v_n = row_count;
  return v_n;
end $fn$;

revoke all on function app.brain_refresh_metrics_cash(uuid) from public;

-- The splice 0037 used, one layer further out: the name in use is renamed aside
-- and a new wrapper takes it, so neither 0035's core nor 0037's geo group is
-- restated here and each file still owns only what it added.
do $mig$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app' and p.proname = 'brain_refresh_metrics_with_geo'
  ) then
    alter function app.brain_refresh_metrics(uuid) rename to brain_refresh_metrics_with_geo;
  end if;
end $mig$;

create or replace function app.brain_refresh_metrics(p_org uuid)
returns jsonb language plpgsql set search_path = public, pg_temp as $fn$
declare v_res jsonb; v_n integer := 0;
begin
  -- Runs first: the core inside it deletes every metric for the org before
  -- rewriting them, so this group has to be an addition to that pass.
  v_res := app.brain_refresh_metrics_with_geo(p_org);

  begin
    v_n := app.brain_refresh_metrics_cash(p_org);
  exception when others then
    -- Its own exception block, like every other group: a tenant on whom this
    -- migration has only half applied loses the cash-book numbers and keeps the
    -- other forty.
    return jsonb_build_object(
      'metrics', coalesce((v_res->>'metrics')::integer, 0),
      'failed_groups', coalesce(v_res->'failed_groups', '[]'::jsonb) || jsonb_build_array('cash'),
      'errors', coalesce(v_res->'errors', '[]'::jsonb) || jsonb_build_array(
                  jsonb_build_object('domain', 'metrics.cash', 'error', sqlerrm, 'at', now())));
  end;

  return v_res || jsonb_build_object('metrics', coalesce((v_res->>'metrics')::integer, 0) + v_n);
end $fn$;

revoke all on function app.brain_refresh_metrics(uuid) from public;

-- ── Keep the projection current ──────────────────────────────────────────────
-- 0034 marks an org dirty when a table the brain projects changes. income_entries
-- is new and has to join that list, with the same three statement triggers and
-- for the same reason: one trigger may not reference both NEW TABLE and OLD
-- TABLE. expenses was already watched.
do $mig$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app' and p.proname = 'brain_mark_dirty'
  ) then
    execute 'drop trigger if exists brain_dirty_ins on public.income_entries';
    execute 'drop trigger if exists brain_dirty_upd on public.income_entries';
    execute 'drop trigger if exists brain_dirty_del on public.income_entries';
    execute 'create trigger brain_dirty_ins after insert on public.income_entries
               referencing new table as changed
               for each statement execute function app.brain_mark_dirty()';
    execute 'create trigger brain_dirty_upd after update on public.income_entries
               referencing new table as changed
               for each statement execute function app.brain_mark_dirty()';
    execute 'create trigger brain_dirty_del after delete on public.income_entries
               referencing old table as changed
               for each statement execute function app.brain_mark_dirty()';
  end if;
end $mig$;

-- An existing brain knows none of this until it resyncs. Hand every org that
-- has one to 0034's drain rather than waiting for the next unrelated edit.
insert into public.brain_dirty (org_id, marked_at, hits)
select s.org_id, now(), 1 from public.brain_state s
on conflict (org_id) do update
  set marked_at = now(), hits = public.brain_dirty.hits + 1;


-- ############################################################################
-- ## 0038_repair_income_permissions.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0038 repair — "403 Forbidden" on POST /rest/v1/income_entries
--
-- WHAT THE 403 MEANS. It is not a missing table and not a missing grant: those
-- fail as 404 and 42501-with-a-message. It is the row-level policy 0027
-- generated for income_entries returning false:
--
--     create policy income_entries_insert on public.income_entries
--       for insert to authenticated
--       with check (app.has_permission(org_id, 'income_entries', 'create'))
--
-- app.has_permission joins memberships to role_permissions on
-- (org_id, role, resource) and coalesces a miss to FALSE. So the insert is
-- refused whenever this organization has no role_permissions row for
-- 'income_entries' — the model fails closed, which is right, but it fails
-- closed silently, which is why the browser only sees a bare 403.
--
-- HOW THAT ROW GOES MISSING. 0038 inserts the resource, inserts its defaults,
-- and relies on 0026's statement trigger role_permission_defaults_propagate to
-- copy the defaults into every existing organization. Any of these leaves the
-- row absent:
--   · 0038 was applied in pieces, and the role_permission_defaults insert did
--     not run (or ran, failed on a re-run, and the rest was skipped);
--   · the defaults insert was a no-op on a re-run, so the statement trigger
--     fired with nothing to propagate;
--   · this deployment does not have that trigger.
--
-- This file is the repair and is safe to run any number of times. It only
-- writes permission rows; it creates no tables and touches no data.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. The resource has to exist before anything can reference it.
insert into public.permission_resources (key, label, category, description, actions, sort_order) values
  ('income_entries', 'Income entries', 'Finance',
   'Money received that no invoice represents — cash sales, retainers, interest, funding.',
   array['view','create','edit','delete'], 425)
on conflict (key) do update
  set label = excluded.label, category = excluded.category,
      description = excluded.description, actions = excluded.actions,
      sort_order = excluded.sort_order;

-- 2. The defaults. Read by everyone, written by members, deleted by admins —
--    the same shape `expenses` has had since 0026.
insert into public.role_permission_defaults (role, resource, can_view, can_create, can_edit, can_delete)
select r.key, 'income_entries',
       true,
       r.key in ('owner','admin','member'),
       r.key in ('owner','admin','member'),
       r.key in ('owner','admin')
  from public.roles r
 where r.key in ('owner','admin','member','viewer')
on conflict (role, resource) do nothing;

-- 3. Fan them out to every organization that already exists. Called directly
--    rather than left to the trigger, since the trigger is exactly what may not
--    have fired. Existing customisations are never overwritten: the function
--    inserts only the (org, role, resource) rows that are missing.
select app.sync_role_permissions(null) as rows_added;

-- 4. Rebuild the policies from the resource's action list, in case
--    secure_tenant_table did not run either. Dropping and recreating the four
--    policies is what this function does; it changes no data.
select app.secure_tenant_table('public.income_entries'::regclass, 'income_entries');

grant select, insert, update, delete on public.income_entries to authenticated;
grant all on public.income_entries to service_role;

-- 5. Proof. Every organization should now appear here with can_create true for
--    owner, admin and member. An organization missing from this list is one
--    that still cannot write income entries.
select rp.org_id, o.company_name, rp.role, rp.can_view, rp.can_create, rp.can_edit, rp.can_delete
  from public.role_permissions rp
  join public.organizations o on o.id = rp.org_id
 where rp.resource = 'income_entries'
 order by o.company_name, rp.role;


-- ############################################################################
-- ## 0039_guard_functions_security_definer.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0039 — "permission denied for schema app" on every cash-book write
--
-- THE BUG. 0038's two guard triggers, app.income_entry_guard() and
-- app.expense_guard(), each call app.finance_treatment() to stamp the row's
-- accounting treatment. Neither was declared SECURITY DEFINER, so the body runs
-- as whoever issued the INSERT — `authenticated`, which 0002 deliberately
-- stripped of USAGE on schema app:
--
--     revoke all on schema app from public, anon, authenticated;
--
-- A trigger function's own invocation is not privilege-checked, which is why
-- 0028's app.purchase_invoice_guard() has always worked: its body touches
-- nothing outside `public`. The moment a guard reaches back into `app` for a
-- helper, the caller needs USAGE it does not have, and every insert fails with
-- a bare "permission denied for schema app".
--
-- This broke BOTH sides of the cash book, not only the new table: 0038 attached
-- app.expense_guard() to public.expenses, which had no BEFORE trigger before,
-- so recording an expense started failing the same way.
--
-- THE FIX is the one 0026 already documents for exactly this situation — the
-- trigger functions become SECURITY DEFINER, so the body runs as the owner,
-- which does have USAGE on app. `set search_path = public, pg_temp` was already
-- on both and is what makes that safe: a definer function with a mutable search
-- path is how a definer function becomes a privilege escalation.
--
-- Running as the owner also corrects the cross-tenant checks, which is worth
-- more than the convenience. Those checks read clients, employees and products
-- to prove the referenced row belongs to the same organization. Under the
-- caller's privileges they were also subject to RLS, so a member with no
-- `employees.view` permission would have had the employee row filtered out from
-- under the check and been told "employee … does not belong to this
-- organization" about a colleague sitting in the same org. The checks are
-- explicitly scoped by `new.org_id`, so bypassing RLS to run them leaks
-- nothing: they either raise or they do not.
--
-- Re-runnable: both are `create or replace`, and the bodies are otherwise
-- character-for-character what 0038 defined.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function app.income_entry_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_country char(2);
begin
  if new.client_id is not null and not exists (
       select 1 from public.clients c where c.id = new.client_id and c.org_id = new.org_id) then
    raise exception 'client % does not belong to this organization', new.client_id
      using errcode = '23503';
  end if;
  if new.document_id is not null and not exists (
       select 1 from public.financial_documents f
        where f.id = new.document_id and f.org_id = new.org_id) then
    raise exception 'document % does not belong to this organization', new.document_id
      using errcode = '23503';
  end if;

  new.treatment  := app.finance_treatment(new.category, 'in');
  new.net_amount := round(new.amount - new.tax_amount, 2);

  if new.country_code is null then
    select coalesce(c.country_code, o.country_code) into v_country
      from public.organizations o
      left join public.clients c on c.id = new.client_id
     where o.id = new.org_id;
    new.country_code := v_country;
  end if;

  new.updated_at := now();
  return new;
end $$;

create or replace function app.expense_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.vendor_id is not null and not exists (
       select 1 from public.vendors v where v.id = new.vendor_id and v.org_id = new.org_id) then
    raise exception 'vendor % does not belong to this organization', new.vendor_id
      using errcode = '23503';
  end if;
  if new.employee_id is not null and not exists (
       select 1 from public.employees e where e.id = new.employee_id and e.org_id = new.org_id) then
    raise exception 'employee % does not belong to this organization', new.employee_id
      using errcode = '23503';
  end if;
  if new.product_id is not null and not exists (
       select 1 from public.products p where p.id = new.product_id and p.org_id = new.org_id) then
    raise exception 'product % does not belong to this organization', new.product_id
      using errcode = '23503';
  end if;

  new.treatment := app.finance_treatment(new.category, 'out');
  -- A spend marked paid has a payment date; one still pending must not keep a
  -- stale one, which is how a cash-flow chart starts showing money leaving on a
  -- day it did not.
  if new.status = 'paid' and new.paid_on is null then new.paid_on := new.incurred_on; end if;
  if new.status <> 'paid' then new.paid_on := null; end if;
  new.updated_at := now();
  return new;
end $$;

-- Both are reached only by firing their trigger. Nothing should be able to call
-- them directly, least of all now that they are definer.
revoke all on function app.income_entry_guard() from public;
revoke all on function app.expense_guard() from public;
revoke all on function app.finance_treatment(text, text) from public;

-- The triggers themselves are unchanged and keep pointing at these names, but
-- recreate them anyway so this file repairs a deployment where 0038 stopped
-- before attaching them.
drop trigger if exists income_entries_guard on public.income_entries;
create trigger income_entries_guard
  before insert or update on public.income_entries
  for each row execute function app.income_entry_guard();

drop trigger if exists expenses_guard on public.expenses;
create trigger expenses_guard
  before insert or update on public.expenses
  for each row execute function app.expense_guard();


-- ############################################################################
-- ## 0041_cash_entry_dimensions.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0041 — the cash book records enough to be analysed
--
-- 0038 got the money and the treatment right and stopped there. What it left
-- out is everything you would want to GROUP BY, and one thing it got quietly
-- wrong.
--
-- THE WRONG THING FIRST. income_entries has carried country_code since 0038 and
-- the form never showed it, so it was only ever the fallback the trigger
-- inferred. Worse, 0037's revenue.*_by_country aggregates read
-- financial_documents alone. So a business taking counter sales had a country
-- breakdown that silently excluded them — the exact failure 0037 exists to
-- prevent, reintroduced one table over. Fixed here, and the definitions now say
-- which aggregate reconciles with which.
--
-- Then the dimensions. Each column below answers a question the cash book
-- could not answer at all:
--
--   country_code, place_of_supply, is_inter_state
--       Where the money came from or went. is_inter_state also settles the GST
--       split, which taxSummary had been ASSUMING was intra-state for every
--       cash-book row — wrong on every export, and 0038's own comment admitted
--       it.
--   tax_rate
--       A GST return is filed rate-wise. `tax_amount` alone cannot be grouped
--       into 5% / 12% / 18% / 28% buckets, so the Tax Summary could total the
--       tax but never break it up the way the return asks for.
--   currency, fx_rate, original_amount
--       A payment received as USD 500 was recorded as its rupee value and the
--       USD 500 was lost. `amount` stays the base-currency figure every
--       aggregate already sums — these three are the provenance of how it was
--       arrived at, never a second version of it.
--   catalog_item_id, quantity, unit
--       Which product, and how many. catalog_items.revenue is maintained by
--       trigger from invoices only, so counter sales of a catalogue product were
--       invisible to every product ranking in the app.
--   department_id  (spend)
--       Which team spent it. EdgeOS has had departments since 0001 and no way
--       to attribute a rupee to one.
--   client_id, billable  (spend)
--       Cost per client, and which of it is re-billable. An agency cannot read
--       project margin without this.
--
-- Re-runnable throughout, same as 0038.
-- ─────────────────────────────────────────────────────────────────────────────

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Columns
-- ═════════════════════════════════════════════════════════════════════════════

alter table public.income_entries
  add column if not exists place_of_supply text,
  add column if not exists is_inter_state  boolean not null default false,
  add column if not exists tax_rate        numeric(5,2) not null default 0,
  -- `amount` remains the org's base currency, because every aggregate in the
  -- app and in EdgeBrain already sums it. These describe the money as it
  -- actually arrived.
  add column if not exists currency        char(3) not null default 'INR',
  add column if not exists fx_rate         numeric(14,6) not null default 1,
  add column if not exists original_amount numeric(14,2),
  add column if not exists catalog_item_id uuid references public.catalog_items(id) on delete set null,
  add column if not exists quantity        numeric(14,3),
  add column if not exists unit            text;

alter table public.expenses
  add column if not exists country_code    char(2) references country_codes(code),
  add column if not exists place_of_supply text,
  add column if not exists is_inter_state  boolean not null default false,
  add column if not exists tax_rate        numeric(5,2) not null default 0,
  add column if not exists currency        char(3) not null default 'INR',
  add column if not exists fx_rate         numeric(14,6) not null default 1,
  add column if not exists original_amount numeric(14,2),
  add column if not exists department_id   uuid references public.departments(id) on delete set null,
  add column if not exists client_id       uuid references public.clients(id) on delete set null,
  add column if not exists billable        boolean not null default false,
  add column if not exists quantity        numeric(14,3),
  add column if not exists unit            text;

-- `amount` becomes a DERIVED column: base currency, computed by the guard from
-- original_amount × fx_rate. It needs a default so a writer can omit it, which
-- the client now does.
--
-- That the client must omit it is not a detail. orgStore.updateItem merges the
-- cached row with the edit and sends the whole thing, so if it sent both amount
-- and original_amount the guard would recompute amount from the UNCHANGED
-- original and the edit would vanish without an error. One field is the input;
-- the other is derived from it. A caller that sends only `amount` — the ETL, a
-- server-side path — still works, because the fx helper falls back to it.
alter table public.income_entries alter column amount set default 0;
alter table public.expenses       alter column amount set default 0;

do $mig$
declare t text;
begin
  foreach t in array array['income_entries', 'expenses'] loop
    if not exists (select 1 from pg_constraint where conname = t || '_tax_rate_check') then
      execute format('alter table public.%I add constraint %I check (tax_rate between 0 and 100)',
                     t, t || '_tax_rate_check');
    end if;
    if not exists (select 1 from pg_constraint where conname = t || '_fx_rate_check') then
      execute format('alter table public.%I add constraint %I check (fx_rate > 0)',
                     t, t || '_fx_rate_check');
    end if;
    if not exists (select 1 from pg_constraint where conname = t || '_quantity_check') then
      execute format('alter table public.%I add constraint %I check (quantity is null or quantity >= 0)',
                     t, t || '_quantity_check');
    end if;
    if not exists (select 1 from pg_constraint where conname = t || '_original_amount_check') then
      execute format('alter table public.%I add constraint %I check (original_amount is null or original_amount >= 0)',
                     t, t || '_original_amount_check');
    end if;
  end loop;
end $mig$;

create index if not exists income_entries_country_idx on public.income_entries (org_id, country_code);
create index if not exists income_entries_catalog_idx on public.income_entries (catalog_item_id)
  where catalog_item_id is not null;
create index if not exists expenses_department_idx on public.expenses (department_id) where department_id is not null;
create index if not exists expenses_client_idx     on public.expenses (client_id)     where client_id is not null;

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. The derivations, in one place
-- ═════════════════════════════════════════════════════════════════════════════
-- Shared by both guards so the two sides of the ledger cannot disagree about
-- what a rate or an exchange rate means.
--
--   tax    `amount` is GST-INCLUSIVE — that is what the form asks for ("the tax
--          portion of the amount above, not on top of it"). So the tax inside a
--          gross amount at rate r is amount − amount/(1+r/100), NOT amount·r.
--          Getting that backwards overstates the tax on an 18% entry by 18%.
--          Either field fills the other: a typed rate produces the amount, a
--          typed amount produces the rate, so rate-wise grouping works whichever
--          way it was entered.
--
--   fx     `amount` is always base currency. Given an original and a rate, it is
--          their product; given neither, the entry was already in base currency
--          and the original is the amount at a rate of 1.
create or replace function app.cash_entry_tax(p_amount numeric, p_tax numeric, p_rate numeric,
                                              out o_tax numeric, out o_rate numeric)
language plpgsql immutable set search_path = public, pg_temp as $$
begin
  o_tax  := coalesce(p_tax, 0);
  o_rate := coalesce(p_rate, 0);
  if o_rate > 0 and o_tax = 0 then
    o_tax := round(p_amount - (p_amount / (1 + o_rate / 100)), 2);
  elsif o_tax > 0 and o_rate = 0 and p_amount - o_tax > 0 then
    o_rate := round((o_tax / (p_amount - o_tax)) * 100, 2);
    -- A hand-typed amount rarely lands exactly on a slab. Snap to the nearest
    -- statutory rate when it is within a rupee's worth of rounding, and leave the
    -- computed figure alone when it is genuinely something else — a wrong rate
    -- on a return is worse than an unusual one.
    o_rate := coalesce((select r from unnest(array[0.25,3,5,12,18,28]::numeric[]) r
                         where abs(r - o_rate) < 0.5 order by abs(r - o_rate) limit 1), o_rate);
  end if;
end $$;

create or replace function app.cash_entry_fx(p_amount numeric, p_original numeric, p_rate numeric,
                                             out o_amount numeric, out o_original numeric, out o_rate numeric)
language plpgsql immutable set search_path = public, pg_temp as $$
begin
  o_rate := coalesce(nullif(p_rate, 0), 1);
  if p_original is not null then
    o_original := p_original;
    o_amount   := round(p_original * o_rate, 2);
  else
    o_amount   := coalesce(p_amount, 0);
    o_original := o_amount;
    o_rate     := 1;
  end if;
end $$;

revoke all on function app.cash_entry_tax(numeric, numeric, numeric) from public;
revoke all on function app.cash_entry_fx(numeric, numeric, numeric) from public;

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Guards
-- ═════════════════════════════════════════════════════════════════════════════
-- SECURITY DEFINER for the reasons 0039 sets out: the bodies call app.* helpers,
-- and `authenticated` has no USAGE on schema app.

create or replace function app.income_entry_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_org_country char(2);
  v_client_country char(2);
begin
  if new.client_id is not null and not exists (
       select 1 from public.clients c where c.id = new.client_id and c.org_id = new.org_id) then
    raise exception 'client % does not belong to this organization', new.client_id
      using errcode = '23503';
  end if;
  if new.document_id is not null and not exists (
       select 1 from public.financial_documents f
        where f.id = new.document_id and f.org_id = new.org_id) then
    raise exception 'document % does not belong to this organization', new.document_id
      using errcode = '23503';
  end if;
  if new.catalog_item_id is not null and not exists (
       select 1 from public.catalog_items ci
        where ci.id = new.catalog_item_id and ci.org_id = new.org_id) then
    raise exception 'catalogue item % does not belong to this organization', new.catalog_item_id
      using errcode = '23503';
  end if;

  new.treatment := app.finance_treatment(new.category, 'in');

  select o.country_code, c.country_code into v_org_country, v_client_country
    from public.organizations o
    left join public.clients c on c.id = new.client_id
   where o.id = new.org_id;

  new.country_code := coalesce(new.country_code, v_client_country, v_org_country);

  select o_amount, o_original, o_rate
    into new.amount, new.original_amount, new.fx_rate
    from app.cash_entry_fx(new.amount, new.original_amount, new.fx_rate);
  -- Base currency by definition means an exchange rate of one; a stored 1.0
  -- against a foreign currency code is the combination that would silently
  -- halve a dollar figure.
  if new.currency is null then new.currency := 'INR'; end if;

  select o_tax, o_rate into new.tax_amount, new.tax_rate
    from app.cash_entry_tax(new.amount, new.tax_amount, new.tax_rate);

  new.net_amount := round(new.amount - new.tax_amount, 2);

  -- A party in another country is an inter-state supply whatever the state
  -- boxes say, and the state boxes only list Indian states — so a foreign buyer
  -- leaves place_of_supply empty and a state comparison alone would charge
  -- CGST+SGST on an export. This is the same correction InvoiceForm makes for
  -- invoices, applied here so the two agree.
  if new.country_code is not null and v_org_country is not null
     and new.country_code <> v_org_country then
    new.is_inter_state := true;
  end if;

  new.updated_at := now();
  return new;
end $$;

create or replace function app.expense_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_org_country    char(2);
  v_client_country char(2);
begin
  if new.vendor_id is not null and not exists (
       select 1 from public.vendors v where v.id = new.vendor_id and v.org_id = new.org_id) then
    raise exception 'vendor % does not belong to this organization', new.vendor_id
      using errcode = '23503';
  end if;
  if new.employee_id is not null and not exists (
       select 1 from public.employees e where e.id = new.employee_id and e.org_id = new.org_id) then
    raise exception 'employee % does not belong to this organization', new.employee_id
      using errcode = '23503';
  end if;
  if new.product_id is not null and not exists (
       select 1 from public.products p where p.id = new.product_id and p.org_id = new.org_id) then
    raise exception 'product % does not belong to this organization', new.product_id
      using errcode = '23503';
  end if;
  if new.department_id is not null and not exists (
       select 1 from public.departments d where d.id = new.department_id and d.org_id = new.org_id) then
    raise exception 'department % does not belong to this organization', new.department_id
      using errcode = '23503';
  end if;
  if new.client_id is not null and not exists (
       select 1 from public.clients c where c.id = new.client_id and c.org_id = new.org_id) then
    raise exception 'client % does not belong to this organization', new.client_id
      using errcode = '23503';
  end if;

  new.treatment := app.finance_treatment(new.category, 'out');

  select o.country_code, c.country_code into v_org_country, v_client_country
    from public.organizations o
    left join public.clients c on c.id = new.client_id
   where o.id = new.org_id;

  new.country_code := coalesce(new.country_code, v_client_country, v_org_country);

  select o_amount, o_original, o_rate
    into new.amount, new.original_amount, new.fx_rate
    from app.cash_entry_fx(new.amount, new.original_amount, new.fx_rate);
  if new.currency is null then new.currency := 'INR'; end if;

  select o_tax, o_rate into new.tax_amount, new.tax_rate
    from app.cash_entry_tax(new.amount, new.tax_amount, new.tax_rate);

  if new.country_code is not null and v_org_country is not null
     and new.country_code <> v_org_country then
    new.is_inter_state := true;
  end if;

  -- Only spend on behalf of somebody can be billed to them.
  if new.client_id is null then new.billable := false; end if;

  -- A spend marked paid has a payment date; one still pending must not keep a
  -- stale one, which is how a cash-flow chart starts showing money leaving on a
  -- day it did not.
  if new.status = 'paid' and new.paid_on is null then new.paid_on := new.incurred_on; end if;
  if new.status <> 'paid' then new.paid_on := null; end if;
  new.updated_at := now();
  return new;
end $$;

revoke all on function app.income_entry_guard() from public;
revoke all on function app.expense_guard() from public;

drop trigger if exists income_entries_guard on public.income_entries;
create trigger income_entries_guard
  before insert or update on public.income_entries
  for each row execute function app.income_entry_guard();

drop trigger if exists expenses_guard on public.expenses;
create trigger expenses_guard
  before insert or update on public.expenses
  for each row execute function app.expense_guard();

-- ── Backfill ─────────────────────────────────────────────────────────────────
-- Existing rows get the country, rate and original-amount the guard would give
-- them. A no-op UPDATE would do it via the trigger, but stating the values makes
-- the intent readable and the result checkable.
-- Scalar subqueries rather than an UPDATE ... FROM with a join: in an UPDATE the
-- target table may not be referenced from a join condition in the FROM list, so
-- `left join clients c on c.id = i.client_id` is rejected outright. Correlated
-- subselects say the same thing and are legal here.
update public.income_entries i
   set country_code    = coalesce(
                           i.country_code,
                           (select c.country_code from public.clients c where c.id = i.client_id),
                           (select o.country_code from public.organizations o where o.id = i.org_id)),
       original_amount = coalesce(i.original_amount, i.amount),
       tax_rate        = case when i.tax_rate = 0 and i.tax_amount > 0 and i.amount - i.tax_amount > 0
                              then (select o_rate from app.cash_entry_tax(i.amount, i.tax_amount, 0))
                              else i.tax_rate end
 where i.country_code is null or i.original_amount is null
    or (i.tax_rate = 0 and i.tax_amount > 0);

update public.expenses e
   set country_code    = coalesce(
                           e.country_code,
                           (select o.country_code from public.organizations o where o.id = e.org_id)),
       original_amount = coalesce(e.original_amount, e.amount),
       tax_rate        = case when e.tax_rate = 0 and e.tax_amount > 0 and e.amount - e.tax_amount > 0
                              then (select o_rate from app.cash_entry_tax(e.amount, e.tax_amount, 0))
                              else e.tax_rate end
 where e.country_code is null or e.original_amount is null
    or (e.tax_rate = 0 and e.tax_amount > 0);

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. EdgeBrain sees the new dimensions
-- ═════════════════════════════════════════════════════════════════════════════
-- Replaces 0038's wrapper in place. The core it calls is still 0033's, renamed
-- by 0038; only the income-entry block below changes.
create or replace function app.brain_sync_spend(p_org uuid, p_since timestamptz default null)
returns jsonb language plpgsql set search_path = public, pg_temp as $fn$
declare v_res jsonb; v_nodes integer := 0; v_removed integer := 0; v_n integer;
begin
  v_res     := app.brain_sync_spend_core(p_org, p_since);
  v_nodes   := coalesce((v_res->>'nodes')::int, 0);
  v_removed := coalesce((v_res->>'removed')::int, 0);

  insert into public.brain_nodes
    (org_id, kind, entity_id, source_table, source_updated_at, resource, label, summary, state, facts, synced_at, deleted_at)
  select i.org_id, 'income_entry', i.id, 'income_entries', i.updated_at, 'income_entries',
         i.description,
         concat_ws(' · ', coalesce(fc.label, i.category),
                   case when i.currency = 'INR' then to_char(i.amount, 'FM999999990.00')
                        else i.currency || ' ' || to_char(i.original_amount, 'FM999999990.00')
                             || ' (INR ' || to_char(i.amount, 'FM999999990.00') || ')' end,
                   to_char(i.received_on, 'DD Mon YYYY'),
                   nullif(c.name, ''), cc.name),
         i.treatment,
         jsonb_strip_nulls(jsonb_build_object(
           'description', i.description, 'category', i.category,
           'category_label', fc.label, 'treatment', i.treatment,
           -- Spelled out on every node, because "is this revenue?" is precisely
           -- the question a model gets wrong when left to infer it from a name.
           'counts_as_revenue', i.treatment in ('revenue','other_income')
                                and i.document_id is null,
           'amount', i.amount, 'tax_amount', i.tax_amount, 'tax_rate', i.tax_rate,
           'net_amount', i.net_amount,
           'currency', i.currency, 'original_amount', i.original_amount, 'fx_rate', i.fx_rate,
           'received_on', i.received_on, 'payment_method', i.payment_method,
           'reference', i.reference, 'client_id', i.client_id, 'client_name', c.name,
           'country_code', i.country_code, 'country', cc.name,
           'place_of_supply', i.place_of_supply, 'is_inter_state', i.is_inter_state,
           'catalog_item_id', i.catalog_item_id, 'product_name', ci.name,
           'quantity', i.quantity, 'unit', i.unit,
           'document_id', i.document_id,
           'notes', i.notes, 'created_at', i.created_at)),
         now(), null
    from public.income_entries i
    left join public.finance_categories fc on fc.key = i.category
    left join public.clients c            on c.id = i.client_id
    left join public.country_codes cc     on cc.code = i.country_code
    left join public.catalog_items ci     on ci.id = i.catalog_item_id
   where i.org_id = p_org and (p_since is null or i.updated_at > p_since)
  on conflict (org_id, kind, entity_id) do update
    set label = excluded.label, summary = excluded.summary, state = excluded.state,
        facts = excluded.facts, source_updated_at = excluded.source_updated_at,
        synced_at = now(), deleted_at = null;
  get diagnostics v_n = row_count; v_nodes := v_nodes + v_n;

  v_removed := v_removed + app.brain_tombstone(p_org, 'income_entry',
    coalesce((select array_agg(id) from public.income_entries where org_id = p_org), '{}'::uuid[]));

  return jsonb_build_object('nodes', v_nodes, 'removed', v_removed);
end $fn$;

revoke all on function app.brain_sync_spend(uuid, timestamptz) from public;

-- ── The new aggregates ───────────────────────────────────────────────────────
-- Added to 0038's group rather than spliced as another layer: this file owns
-- that function, so it is replaced whole.
create or replace function app.brain_refresh_metrics_cash(p_org uuid)
returns integer language plpgsql set search_path = public, pg_temp as $fn$
declare v_n integer;
begin
  insert into public.brain_metrics (org_id, key, bucket, value, dims, definition, resource)
  select p_org, 'income.direct_revenue', '', coalesce(sum(i.net_amount), 0), '{}'::jsonb,
         'Revenue received WITHOUT an invoice - counter sales, retainers, work billed outside '
         'EdgeOS - at net value, excluding the GST collected on it. Entries linked to an invoice are '
         'excluded so nothing counts twice, and funding and refunds are excluded because they are not '
         'earned. Total revenue = revenue.billed (or revenue.collected, on a cash basis) PLUS this '
         'number; quoting revenue.* alone understates any business that also takes money directly.',
         'income_entries'
    from public.income_entries i
   where i.org_id = p_org and i.document_id is null
     and i.treatment in ('revenue', 'other_income')

  union all
  select p_org, 'income.direct_revenue_by_month', to_char(i.received_on, 'YYYY-MM'),
         coalesce(sum(i.net_amount), 0), '{}'::jsonb,
         'Non-invoice revenue by the month the money arrived, net of GST.', 'income_entries'
    from public.income_entries i
   where i.org_id = p_org and i.document_id is null
     and i.treatment in ('revenue', 'other_income')
     and i.received_on >= (date_trunc('month', current_date) - interval '11 months')::date
   group by to_char(i.received_on, 'YYYY-MM')

  -- The gap 0037 left. revenue.collected_by_country reads invoices only, so on
  -- its own it answers "which country generates the most revenue" wrongly for
  -- anyone taking money without invoicing. The two must be ADDED per country.
  union all
  select p_org, 'income.direct_revenue_by_country', coalesce(i.country_code::text, 'unknown'),
         coalesce(sum(i.net_amount), 0),
         jsonb_build_object('country_code', i.country_code,
                            'country', coalesce(cc.name, 'Not recorded on the entry')),
         'Non-invoice revenue per country, net of GST, on the country stamped on each cash-book '
         'entry. This is the OTHER HALF of revenue by country: add it to '
         'revenue.collected_by_country (invoices) for the same bucket to get the whole figure for a '
         'country. Quoting either alone understates it.', 'income_entries'
    from public.income_entries i
    left join public.country_codes cc on cc.code = i.country_code
   where i.org_id = p_org and i.document_id is null
     and i.treatment in ('revenue', 'other_income')
   group by i.country_code, cc.name

  union all
  select p_org, 'income.by_category', i.category, coalesce(sum(i.net_amount), 0),
         jsonb_build_object('category', i.category, 'label', coalesce(fc.label, i.category),
                            'treatment', i.treatment,
                            'counts_as_revenue', i.treatment in ('revenue','other_income')),
         'Money in per reason, net of GST. Buckets whose treatment is capital_in (funding, loans, '
         'deposits received) or cost_recovery (refunds) are cash but NOT revenue, and belong in no '
         'revenue total.', 'income_entries'
    from public.income_entries i
    left join public.finance_categories fc on fc.key = i.category
   where i.org_id = p_org
   group by i.category, i.treatment, fc.label

  union all
  select p_org, 'income.by_product', i.catalog_item_id::text, coalesce(sum(i.net_amount), 0),
         jsonb_build_object('catalog_item_id', i.catalog_item_id, 'product', ci.name,
                            'units', coalesce(sum(i.quantity), 0)),
         'Non-invoice revenue per catalogue product, net of GST. catalog_items.revenue is maintained '
         'from INVOICES only, so this is the counter-sales half of a product''s takings and has to be '
         'added to it for the product''s true total.', 'income_entries'
    from public.income_entries i
    join public.catalog_items ci on ci.id = i.catalog_item_id
   where i.org_id = p_org and i.treatment in ('revenue', 'other_income')
   group by i.catalog_item_id, ci.name

  union all
  select p_org, 'income.funding_received', '', coalesce(sum(i.amount), 0), '{}'::jsonb,
         'Capital put in or borrowed: owner contributions, investor funding, loans and deposits '
         'received. Cash, never revenue, and never to be added to a revenue figure.',
         'income_entries'
    from public.income_entries i
   where i.org_id = p_org and i.treatment = 'capital_in'

  union all
  select p_org, 'cash_in.total', '', coalesce(sum(i.amount), 0), '{}'::jsonb,
         'Every rupee recorded as arriving through the cash book, gross and for any reason - '
         'revenue, funding and refunds together. A cash-flow figure, not an income figure.',
         'income_entries'
    from public.income_entries i where i.org_id = p_org

  union all
  select p_org, 'cash_in.by_method', i.payment_method, coalesce(sum(i.amount), 0), '{}'::jsonb,
         'Money in by how it was received. Gross, all reasons.', 'income_entries'
    from public.income_entries i where i.org_id = p_org group by i.payment_method

  -- ── Money out, by what it actually does to profit ──────────────────────────
  union all
  select p_org, 'spend.by_category', e.category, coalesce(sum(e.amount - e.tax_amount), 0),
         jsonb_build_object('category', e.category, 'label', coalesce(fc.label, e.category),
                            'treatment', e.treatment,
                            'group', coalesce(fc.group_label, 'Legacy'),
                            'hits_profit', e.treatment in ('operating','non_operating')),
         'Money out per reason, net of the input GST claimed back. Buckets whose treatment is capex, '
         'financing, owner or tax are cash leaving the business but are NOT expenses: an asset '
         'purchase, a loan repayment, a drawing and a tax remittance each reduce the bank balance '
         'without reducing profit. Only the operating and non_operating buckets sum to the P&L '
         'expense line.', 'expenses'
    from public.expenses e
    left join public.finance_categories fc on fc.key = e.category
   where e.org_id = p_org
   group by e.category, e.treatment, fc.label, fc.group_label

  union all
  select p_org, 'spend.by_group', coalesce(fc.group_label, 'Legacy'),
         coalesce(sum(e.amount - e.tax_amount), 0),
         jsonb_build_object('group', coalesce(fc.group_label, 'Legacy')),
         'Money out rolled up to the reason-group: product and delivery, people and labour, sales and '
         'marketing, operations and admin, assets and capital, financing and tax. This is the answer '
         'to "where does our money go".', 'expenses'
    from public.expenses e
    left join public.finance_categories fc on fc.key = e.category
   where e.org_id = p_org
   group by fc.group_label

  union all
  select p_org, 'spend.by_department', coalesce(d.id::text, 'unassigned'),
         coalesce(sum(e.amount - e.tax_amount), 0),
         jsonb_build_object('department_id', d.id, 'department', coalesce(d.name, 'Not attributed')),
         'Money out per department, net of input GST. Bucketed on the department id, so a department '
         'actually named "Unassigned" cannot collide with spend attributed to nobody. Expense entries '
         'only - a vendor bill carries no department.', 'expenses'
    from public.expenses e
    left join public.departments d on d.id = e.department_id
   where e.org_id = p_org
   group by d.id, d.name

  union all
  select p_org, 'spend.by_client', c.id::text, coalesce(sum(e.amount - e.tax_amount), 0),
         jsonb_build_object('client_id', c.id, 'client', c.name,
                            'billable', coalesce(sum(case when e.billable then e.amount - e.tax_amount end), 0)),
         'Money out incurred for a specific client, net of input GST, with the re-billable part in '
         'dims. Against that client''s revenue.billed this is project margin.', 'expenses'
    from public.expenses e
    join public.clients c on c.id = e.client_id
   where e.org_id = p_org
   group by c.id, c.name

  union all
  select p_org, 'spend.labour_total', '', coalesce(sum(e.amount - e.tax_amount), 0), '{}'::jsonb,
         'Everything spent on people: salaries, wages, contractors, stipends, bonuses, statutory '
         'employer dues, recruitment, training, benefits and reimbursements, net of input GST. '
         'Expense entries only - labour billed on a vendor bill sits in payables instead.',
         'expenses'
    from public.expenses e
    join public.finance_categories fc on fc.key = e.category
   where e.org_id = p_org and fc.group_label = 'People & labour'

  union all
  select p_org, 'spend.product_total', '', coalesce(sum(e.amount - e.tax_amount), 0), '{}'::jsonb,
         'Everything spent making and delivering what you sell: materials, stock, manufacturing, '
         'packaging, freight, shipping, subcontracting, hosting and payment fees, net of input GST. '
         'The cost side of gross margin.', 'expenses'
    from public.expenses e
    join public.finance_categories fc on fc.key = e.category
   where e.org_id = p_org and fc.group_label = 'Product & delivery'

  union all
  select p_org, 'spend.operating_total', '', coalesce(sum(e.amount - e.tax_amount), 0), '{}'::jsonb,
         'Expense entries that reduce profit (treatment operating or non_operating), net of input '
         'GST. This is the figure that belongs in a P&L; expenses.total is gross and also contains '
         'asset purchases, loan repayments, drawings and tax remittances, which do not.', 'expenses'
    from public.expenses e
   where e.org_id = p_org and e.treatment in ('operating', 'non_operating')

  union all
  select p_org, 'cash_out.total', '', coalesce(sum(e.amount), 0), '{}'::jsonb,
         'Every rupee recorded as leaving through expense entries, gross and for any reason. A '
         'cash-flow figure, not an expense figure.', 'expenses'
    from public.expenses e where e.org_id = p_org

  union all
  select p_org, 'spend.pending', '', coalesce(sum(e.amount), 0), '{}'::jsonb,
         'Recorded spend that has not actually been paid out yet.', 'expenses'
    from public.expenses e where e.org_id = p_org and e.status = 'pending'

  -- ── GST, rate-wise, which is how a return is actually filed ───────────────
  union all
  select p_org, 'gst.output_by_rate', i.tax_rate::text, coalesce(sum(i.tax_amount), 0),
         jsonb_build_object('rate', i.tax_rate,
                            'taxable', coalesce(sum(i.net_amount), 0),
                            'inter_state', bool_or(i.is_inter_state)),
         'Output GST collected on cash-book sales, grouped by rate. Cash book only - invoice GST is '
         'in the financial_documents figures. A return is filed rate-wise, which a single total '
         'cannot support.', 'income_entries'
    from public.income_entries i
   where i.org_id = p_org and i.document_id is null and i.tax_amount > 0
   group by i.tax_rate

  union all
  select p_org, 'gst.input_by_rate', e.tax_rate::text, coalesce(sum(e.tax_amount), 0),
         jsonb_build_object('rate', e.tax_rate,
                            'taxable', coalesce(sum(e.amount - e.tax_amount), 0)),
         'Input GST on expense entries, grouped by rate. Purchase-invoice input GST is separate.',
         'expenses'
    from public.expenses e
   where e.org_id = p_org and e.tax_amount > 0
   group by e.tax_rate;

  get diagnostics v_n = row_count;
  return v_n;
end $fn$;

revoke all on function app.brain_refresh_metrics_cash(uuid) from public;

-- Every brain has to read these rows again: the nodes gained facts and the
-- aggregates gained five keys.
insert into public.brain_dirty (org_id, marked_at, hits)
select s.org_id, now(), 1 from public.brain_state s
on conflict (org_id) do update
  set marked_at = now(), hits = public.brain_dirty.hits + 1;


-- ############################################################################
-- ## 0042_geo_includes_cash_entries.sql
-- ############################################################################

-- ============================================================================
-- EdgeOS · 0042_geo_includes_cash_entries.sql
--
-- THE BUG THIS FIXES:
--
--   0038 gave the product a cash book — money received without an invoice and
--   money paid out — and 0041 put a country on every row of it. But
--   public.sales_by_country(), which is the ONLY source for "Revenue by
--   Geography" on the Hub and for "Sales by Countries" on the dashboard, still
--   read financial_documents and nothing else. So a counter sale of ₹80,000
--   recorded in the cash book with country IN added ₹0 to India on the map,
--   while the same row showed up in Revenue, in the Overview and in the P&L.
--   The map disagreed with every other screen.
--
--   This file makes the aggregation read all three sources — documents,
--   income_entries and expenses — and return the cash book's detail alongside
--   the document detail rather than melted into one number.
--
-- WHAT "revenue" MEANS HERE, unchanged in spirit from 0013:
--
--   revenue = invoiced + direct_revenue
--
--     invoiced        issued documents in a sold state, at grand_total
--     direct_revenue  cash-book receipts that were EARNED - treatment
--                     'revenue' or 'other_income' - and whose document_id is
--                     null
--
--   The document_id test is the whole reason a receipt can be recorded against
--   an invoice without inflating anything: such a row is the collection of
--   revenue that `invoiced` already counted, so it is money in but not revenue.
--
--   Gross on both sides. A document contributes grand_total, which includes
--   GST, so a cash receipt contributes `amount`, which also includes GST.
--   Mixing a gross figure with a net one is the single easiest way to produce a
--   total that is wrong by exactly the tax, so output GST is returned in its
--   own column instead of being netted off silently.
--
--   'revenue' or 'other_income' is not an arbitrary pair: it is exactly
--   INCOME_TREATMENTS in src/services/financeCategories.js, which is what
--   countsAsIncome() tests and therefore what the Hub's Revenue tile, the
--   Overview and the P&L have already counted as income since 0038. The map
--   using a narrower definition than the rest of the product is how this bug
--   started; one definition, in one place, is the fix.
--
--   Money in that was never earned stays OUT of revenue and is reported
--   separately: capital_in (funding, a loan, owner's money) and cost_recovery
--   (a refund, a reimbursement). Putting a seed round on the map as Indian
--   revenue would make the growth figure meaningless.
--
-- Re-runnable: every statement is guarded or idempotent.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Country on rows written before 0041
--
-- 0041's guards resolve a country for every new cash-book row (explicit →
-- client → org). Rows written before it ran have none, and would sit in the
-- map's "Unspecified" bucket forever. Resolve them the same way the guard
-- would have, once, here.
--
-- Only NULLs are touched: a country somebody set by hand is an observation and
-- this migration has no business overwriting it.
-- ─────────────────────────────────────────────────────────────────────────────

update public.income_entries i
   set country_code = coalesce(
         (select c.country_code from public.clients c where c.id = i.client_id),
         (select o.country_code from public.organizations o where o.id = i.org_id)
       )
 where i.country_code is null
   and coalesce(
         (select c.country_code from public.clients c where c.id = i.client_id),
         (select o.country_code from public.organizations o where o.id = i.org_id)
       ) is not null;

update public.expenses e
   set country_code = coalesce(
         (select c.country_code from public.clients c where c.id = e.client_id),
         (select o.country_code from public.organizations o where o.id = e.org_id)
       )
 where e.country_code is null
   and coalesce(
         (select c.country_code from public.clients c where c.id = e.client_id),
         (select o.country_code from public.organizations o where o.id = e.org_id)
       ) is not null;

-- The aggregation groups by country inside a date window, per org — the same
-- access pattern fin_docs_country_idx serves for documents.
create index if not exists income_entries_country_idx
  on public.income_entries (org_id, country_code, received_on desc);

create index if not exists expenses_country_idx
  on public.expenses (org_id, country_code, incurred_on desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The aggregation
--
-- The return type gains columns, so this is a DROP and CREATE rather than a
-- CREATE OR REPLACE: Postgres will not let a replacement change the shape of
-- RETURNS TABLE. The signature is unchanged, so every existing caller — the
-- widget, the Hub, the isolation test — keeps working and simply sees more
-- columns than it reads.
-- ─────────────────────────────────────────────────────────────────────────────

drop function if exists public.sales_by_country(uuid, date, date, uuid);

create function public.sales_by_country(
  p_org          uuid,
  p_from         date default null,
  p_to           date default null,
  p_catalog_item uuid default null
)
-- `iso2` rather than `country_code` for the same reason as 0013: a RETURNS
-- TABLE column of that name would shadow the real column inside the body.
returns table (
  iso2           char(2),
  -- The headline, and the only column the map draws: invoiced + direct.
  revenue        numeric,
  collected      numeric,
  pipeline       numeric,
  doc_count      bigint,
  customer_count bigint,
  prev_revenue   numeric,
  -- The split behind `revenue`, so a country's figure can always be explained.
  invoiced       numeric,
  direct_revenue numeric,
  -- Sub-slices, for explaining a figure rather than adding to it. other_income
  -- is the part of direct_revenue that is earned but not a sale - interest,
  -- scrap, a commission - and is ALREADY inside direct_revenue above.
  other_income   numeric,
  capital_in     numeric,
  cost_recovery  numeric,
  -- Literal cash movement. cash_in counts EVERY receipt including those booked
  -- against an invoice, because they are money that actually arrived; that is
  -- why it can exceed revenue and why it is not a substitute for it.
  cash_in        numeric,
  cash_out       numeric,
  net_cash       numeric,
  income_count   bigint,
  expense_count  bigint,
  -- Spend by what it does to the P&L. operating is a cost; capex buys an asset;
  -- financing repays a loan; owner is a drawing. Only the first is a cost.
  spend_operating numeric,
  spend_capex     numeric,
  spend_other     numeric,
  -- GST inside the cash-book figures above. Output tax on money in, input tax
  -- on money out.
  tax_collected  numeric,
  tax_paid       numeric,
  prev_cash_out  numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with bounds as (
    select
      p_from as cur_from,
      p_to   as cur_to,
      case when p_from is null or p_to is null then null
           else p_from - (p_to - p_from + 1) end as prev_from,
      case when p_from is null then null else p_from - 1 end as prev_to
  ),

  -- ── documents ───────────────────────────────────────────────────────────
  scoped as (
    select
      d.id, d.country_code, d.type, d.status, d.issue_date, d.customer_id,
      case
        when p_catalog_item is null then d.grand_total
        else coalesce((
          select sum(li.line_total)
            from public.document_line_items li
           where li.document_id = d.id
             and li.catalog_item_id = p_catalog_item
        ), 0)
      end as amount
    from public.financial_documents d
    where d.org_id = p_org
      and (
        p_catalog_item is null
        or exists (
          select 1 from public.document_line_items li
           where li.document_id = d.id
             and li.catalog_item_id = p_catalog_item
        )
      )
  ),
  docs as (
    select
      s.country_code as code,
      coalesce(sum(s.amount) filter (
        where app.catalog_is_sold(s.type, s.status)
          and (b.cur_from is null or s.issue_date >= b.cur_from)
          and (b.cur_to   is null or s.issue_date <= b.cur_to)), 0) as invoiced,
      coalesce(sum(s.amount) filter (
        where app.catalog_is_collected(s.type, s.status)
          and (b.cur_from is null or s.issue_date >= b.cur_from)
          and (b.cur_to   is null or s.issue_date <= b.cur_to)), 0) as collected,
      -- Quotations and proformas still live. Kept out of revenue: an offer is
      -- not a sale, and folding the two together would make this widget
      -- disagree with every other total in the product.
      coalesce(sum(s.amount) filter (
        where s.type in ('quotation', 'proforma')
          and s.status not in ('cancelled', 'expired', 'declined', 'draft')
          and (b.cur_from is null or s.issue_date >= b.cur_from)
          and (b.cur_to   is null or s.issue_date <= b.cur_to)), 0) as pipeline,
      count(distinct s.id) filter (
        where app.catalog_is_sold(s.type, s.status)
          and (b.cur_from is null or s.issue_date >= b.cur_from)
          and (b.cur_to   is null or s.issue_date <= b.cur_to)) as doc_count,
      count(distinct s.customer_id) filter (
        where s.customer_id is not null
          and app.catalog_is_sold(s.type, s.status)
          and (b.cur_from is null or s.issue_date >= b.cur_from)
          and (b.cur_to   is null or s.issue_date <= b.cur_to)) as customer_count,
      coalesce(sum(s.amount) filter (
        where app.catalog_is_sold(s.type, s.status)
          and b.prev_from is not null
          and s.issue_date >= b.prev_from
          and s.issue_date <= b.prev_to), 0) as prev_invoiced
    from scoped s
    cross join bounds b
    group by s.country_code
  ),

  -- ── cash book: money in ─────────────────────────────────────────────────
  -- A product filter means "this catalogue item only". income_entries carries
  -- catalog_item_id (0041), so a filtered call narrows to the receipts tagged
  -- with that item — rows with no item are not guesses and are left out.
  inc as (
    select
      i.country_code as code,
      coalesce(sum(i.amount) filter (
        where i.treatment in ('revenue', 'other_income')
          and i.document_id is null and cur), 0) as direct_revenue,
      coalesce(sum(i.amount) filter (
        where i.treatment = 'other_income' and i.document_id is null and cur), 0) as other_income,
      coalesce(sum(i.amount) filter (where i.treatment = 'capital_in'    and cur), 0) as capital_in,
      coalesce(sum(i.amount) filter (where i.treatment = 'cost_recovery' and cur), 0) as cost_recovery,
      coalesce(sum(i.amount)      filter (where cur), 0) as cash_in,
      coalesce(sum(i.tax_amount)  filter (where cur), 0) as tax_collected,
      count(*) filter (where cur) as income_count,
      coalesce(sum(i.amount) filter (
        where i.treatment in ('revenue', 'other_income')
          and i.document_id is null and prv), 0) as prev_direct
    from (
      select
        e.*,
        (b.cur_from is null or e.received_on >= b.cur_from)
          and (b.cur_to is null or e.received_on <= b.cur_to) as cur,
        b.prev_from is not null and e.received_on >= b.prev_from
          and e.received_on <= b.prev_to as prv
      from public.income_entries e
      cross join bounds b
      where e.org_id = p_org
        and (p_catalog_item is null or e.catalog_item_id = p_catalog_item)
    ) i
    group by i.country_code
  ),

  -- ── cash book: money out ────────────────────────────────────────────────
  -- Pending rows are excluded: an expense that has not been paid has not moved
  -- any cash, and this side of the report is about cash that moved.
  --
  -- A product filter switches spend off entirely. expenses.product_id points at
  -- public.products, a different table from catalog_items, so there is no
  -- honest way to answer "spend on THIS catalogue item" — and inventing one by
  -- matching names would be worse than an empty column.
  exp as (
    select
      x.country_code as code,
      coalesce(sum(x.amount)     filter (where cur), 0) as cash_out,
      coalesce(sum(x.tax_amount) filter (where cur), 0) as tax_paid,
      coalesce(sum(x.amount) filter (where cur and x.treatment = 'operating'), 0) as spend_operating,
      coalesce(sum(x.amount) filter (where cur and x.treatment = 'capex'), 0)     as spend_capex,
      coalesce(sum(x.amount) filter (
        where cur and x.treatment not in ('operating', 'capex')), 0) as spend_other,
      count(*) filter (where cur) as expense_count,
      coalesce(sum(x.amount) filter (where prv), 0) as prev_cash_out
    from (
      select
        e.*,
        coalesce(e.paid_on, e.incurred_on) as on_date,
        (b.cur_from is null or coalesce(e.paid_on, e.incurred_on) >= b.cur_from)
          and (b.cur_to is null or coalesce(e.paid_on, e.incurred_on) <= b.cur_to) as cur,
        b.prev_from is not null
          and coalesce(e.paid_on, e.incurred_on) >= b.prev_from
          and coalesce(e.paid_on, e.incurred_on) <= b.prev_to as prv
      from public.expenses e
      cross join bounds b
      where e.org_id = p_org
        and e.status = 'paid'
        and p_catalog_item is null
    ) x
    group by x.country_code
  ),

  -- Every country any of the three sources mentions. A full outer join would
  -- do this too, but a key set reads as what it is and stays correct when a
  -- fourth source arrives.
  keys as (
    select code from docs
    union select code from inc
    union select code from exp
  )

  select
    k.code,
    coalesce(d.invoiced, 0) + coalesce(i.direct_revenue, 0),
    -- Collected: what actually landed. Documents contribute their collected
    -- figure; direct receipts are cash by definition, so they contribute in
    -- full. Receipts booked against an invoice are deliberately not added —
    -- the document's own collected figure already counts them.
    coalesce(d.collected, 0) + coalesce(i.direct_revenue, 0),
    coalesce(d.pipeline, 0),
    coalesce(d.doc_count, 0),
    coalesce(d.customer_count, 0),
    coalesce(d.prev_invoiced, 0) + coalesce(i.prev_direct, 0),
    coalesce(d.invoiced, 0),
    coalesce(i.direct_revenue, 0),
    coalesce(i.other_income, 0),
    coalesce(i.capital_in, 0),
    coalesce(i.cost_recovery, 0),
    coalesce(i.cash_in, 0),
    coalesce(e.cash_out, 0),
    coalesce(i.cash_in, 0) - coalesce(e.cash_out, 0),
    coalesce(i.income_count, 0),
    coalesce(e.expense_count, 0),
    coalesce(e.spend_operating, 0),
    coalesce(e.spend_capex, 0),
    coalesce(e.spend_other, 0),
    coalesce(i.tax_collected, 0),
    coalesce(e.tax_paid, 0),
    coalesce(e.prev_cash_out, 0)
  from keys k
  left join docs d on d.code is not distinct from k.code
  left join inc  i on i.code is not distinct from k.code
  left join exp  e on e.code is not distinct from k.code
  where app.is_member(p_org)
    -- Drop countries with nothing at all to show. The previous window is part
    -- of the test on purpose: a country that sold last quarter and nothing this
    -- one is exactly the country the growth figure needs to see, and filtering
    -- on the current window alone would hide it and overstate growth.
    and (
      coalesce(d.invoiced, 0) <> 0
      or coalesce(d.pipeline, 0) <> 0
      or coalesce(d.prev_invoiced, 0) <> 0
      or coalesce(i.cash_in, 0) <> 0
      or coalesce(i.prev_direct, 0) <> 0
      or coalesce(e.cash_out, 0) <> 0
      or coalesce(e.prev_cash_out, 0) <> 0
    )
  order by 2 desc, 1;
$$;

revoke execute on function public.sales_by_country(uuid, date, date, uuid) from public, anon;
grant  execute on function public.sales_by_country(uuid, date, date, uuid) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. EdgeBrain
--
-- 0041 added income.direct_revenue_by_country and said in so many words that a
-- country answer has to ADD it to revenue.collected_by_country. Mark the geo
-- metrics dirty so the next sync restates them over the rows this file just
-- gave a country to.
-- ─────────────────────────────────────────────────────────────────────────────

insert into public.brain_dirty (org_id, marked_at, hits)
select s.org_id, now(), 1 from public.brain_state s
on conflict (org_id) do update
  set marked_at = now(), hits = public.brain_dirty.hits + 1;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Proof
--
-- Run this after the migration. For each org and country it shows what the map
-- will now draw and where the number came from. If `revenue` does not equal
-- `invoiced + direct_revenue`, something above is wrong.
-- ─────────────────────────────────────────────────────────────────────────────

-- select o.company_name,
--        g.iso2, g.revenue, g.invoiced, g.direct_revenue,
--        g.cash_in, g.cash_out, g.net_cash, g.income_count, g.expense_count
--   from public.organizations o
--   cross join lateral public.sales_by_country(o.id, null, null, null) g
--  order by o.company_name, g.revenue desc;

-- Cash-book rows still with no country, which the map shows as Unspecified.
-- A non-zero count here is a real answer, not a bug: it means the org has no
-- country on its profile and the client had none either.
-- select org_id, count(*), sum(amount)
--   from public.income_entries where country_code is null group by org_id;


-- ############################################################################
-- ## 0043_clients_notes.sql
-- ############################################################################

-- ============================================================================
-- EdgeOS · 0043_clients_notes.sql
--
-- WHAT THIS IS FOR:
--
--   The Add Client / Edit Client dialog now has a free-text "Note" field. It
--   writes through orgStore's `customers` adapter, whose toRow() has always
--   mapped `notes` -> clients.notes — the same column CRM.jsx writes for a
--   lead, which is correct: since 0016 a lead and a billing client are one
--   row seen through two adapters, so one note follows the party across both
--   screens rather than splitting in two.
--
--   clients.notes was declared in 0016_clients.sql, so on a database that
--   replayed every migration in order this file is a no-op. It exists because
--   the live schema has drifted from the repo before: a column the UI now
--   depends on should be asserted, not assumed. IF NOT EXISTS makes running it
--   against an already-correct database harmless.
-- ============================================================================

alter table public.clients
  add column if not exists notes text;

comment on column public.clients.notes is
  'Free-text note on the client. Shared by the Client Directory form and the CRM board — one party, one note.';


-- ############################################################################
-- ## 0044_projects_permissions.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0044 — Projects: permission resources and default matrix
--
-- First of the Projects migrations, and first on purpose: app.secure_tenant_table
-- refuses a resource that is not in permission_resources, and a new table with
-- no role_permissions rows answers every request with a bare 403 (see 0038's
-- repair). So the resources, their defaults and the fan-out to every existing
-- organization all land before any table does.
--
-- Keys checked against the live project by supabase/checks/projects_preflight.sql
-- (2026-09-25): none of these exist yet, the verbs are view/create/edit/delete,
-- and the roles are owner/admin/member/viewer/employee.
--
-- The matrix, by role:
--
--   owner, admin  everything.
--   member        projects, members, milestones: view/create/edit. Documents:
--                 view/create (links, nothing to edit). Allocations:
--                 view/create/edit in the matrix, but every allocation policy
--                 also requires project_financials.view (0049), which a member
--                 does not have by default — so out of the box a member cannot
--                 see or write one. Granting project_financials is the switch.
--   viewer        view projects, members, milestones, documents.
--   employee      nothing. Their access is the self-scoped my_projects() and
--                 project_team_public_v (0052), never the matrix.
--
-- project_financials has one verb, view. It is not a table: it gates the
-- allocation table and the money-returning RPCs (0051).
--
-- New organizations: app.seed_org_permissions (0026) copies every default row
-- into an organization when it is created, so create_organization needs no
-- change of its own.
--
-- Idempotent throughout; ends with the explicit fan-out rather than trusting the
-- statement trigger, which does nothing when the defaults insert is a no-op.
-- ─────────────────────────────────────────────────────────────────────────────

insert into public.permission_resources (key, label, category, description, actions, sort_order) values
  ('projects',            'Projects',             'Projects',
   'Client and internal projects: status, dates, contract value and budget.',
   array['view','create','edit','delete'], 270),
  ('project_members',     'Project team',         'Projects',
   'Who works on each project, in what role, at what allocation.',
   array['view','create','edit','delete'], 272),
  ('project_milestones',  'Milestones',           'Projects',
   'Project stages, due dates and the share of the contract each one bills.',
   array['view','create','edit','delete'], 274),
  ('project_documents',   'Project documents',    'Projects',
   'Links from a project to its NDAs, MoUs, quotations and proformas.',
   array['view','create','delete'], 276),
  ('project_allocations', 'Project money links',  'Projects',
   'Which invoices, bills, expenses and income belong to which project. Also needs Project financials.',
   array['view','create','edit','delete'], 278),
  ('project_financials',  'Project financials',   'Projects',
   'Project profit and loss, labour cost and margins. Labour cost is derived from pay.',
   array['view'], 280)
on conflict (key) do update
  set label = excluded.label, category = excluded.category,
      description = excluded.description, actions = excluded.actions,
      sort_order = excluded.sort_order;

insert into public.role_permission_defaults (role, resource, can_view, can_create, can_edit, can_delete)
select r.key, x.resource,
       -- view
       case when r.key in ('owner','admin') then true
            when x.resource in ('project_allocations','project_financials') then r.key = 'member'
                                                                                and x.resource = 'project_allocations'
            else r.key in ('member','viewer') end,
       -- create
       case when x.resource = 'project_financials' then false
            else r.key in ('owner','admin','member') end,
       -- edit
       case when x.resource in ('project_financials','project_documents') then false
            else r.key in ('owner','admin','member') end,
       -- delete
       case when x.resource = 'project_financials' then false
            else r.key in ('owner','admin') end
  from public.roles r
 cross join (values ('projects'), ('project_members'), ('project_milestones'),
                    ('project_documents'), ('project_allocations'), ('project_financials')) x(resource)
 where r.key in ('owner','admin','member','viewer','employee')
on conflict (role, resource) do nothing;

-- The employee role gets explicit all-false rows (above: every case is false
-- for it) so the grid shows a row rather than a gap, and so has_permission's
-- answer for them is a stored "no" rather than a missing row.

select app.sync_role_permissions(null) as rows_added;


-- ############################################################################
-- ## 0045_projects.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0045 — Projects: the enums, the projects table and its numbering
--
-- A project is a unit of work the company delivers, for a client (client_id
-- set) or for itself (client_id null). Its money, people, plan and work hang
-- off it in 0046–0050; this file is only the project row itself.
--
-- ─── Numbering ──────────────────────────────────────────────────────────────
-- PRJ-YYYY-NNN, unique per organization, immutable. document_counters is keyed
-- by the doc_type enum (verified live by the preflight), and a project is not a
-- document, so it gets its own counter table and its own row-locking allocator
-- rather than a new doc_type value that every document query would then have
-- to exclude. The code is always assigned by the database: a client cannot
-- choose one, so two browsers creating projects at once cannot collide.
--
-- ─── Closing ────────────────────────────────────────────────────────────────
-- Moving to completed or cancelled stamps closed_at/closed_by (and
-- actual_end_date, if nobody set one). A closed project locks its members,
-- milestones and money links (the triggers are attached in 0046–0049). Coming
-- back out of a closed state is only possible through public.reopen_project
-- (0052), which is owner/admin only and writes an audit row: an ordinary UPDATE
-- of status from completed to active is refused here.
--
-- ─── Derived columns ────────────────────────────────────────────────────────
-- manager_employee_id is maintained from project_members (0046) — whoever
-- holds the `manager` role there. A value sent by a client is ignored, the same
-- way app.income_entry_guard ignores a client-sent treatment.
-- ─────────────────────────────────────────────────────────────────────────────

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Enums (all six, so later files only reference them)
-- ═════════════════════════════════════════════════════════════════════════════

do $mig$
begin
  if not exists (select 1 from pg_type where typname = 'project_status' and typnamespace = 'public'::regnamespace) then
    create type public.project_status as enum ('planned', 'active', 'on_hold', 'completed', 'cancelled');
  end if;
  if not exists (select 1 from pg_type where typname = 'project_billing_type' and typnamespace = 'public'::regnamespace) then
    create type public.project_billing_type as enum ('fixed_price', 'time_materials', 'retainer');
  end if;
  if not exists (select 1 from pg_type where typname = 'project_member_role' and typnamespace = 'public'::regnamespace) then
    create type public.project_member_role as enum ('manager', 'lead', 'member');
  end if;
  if not exists (select 1 from pg_type where typname = 'milestone_status' and typnamespace = 'public'::regnamespace) then
    create type public.milestone_status as enum ('pending', 'in_progress', 'completed', 'invoiced', 'cancelled');
  end if;
  if not exists (select 1 from pg_type where typname = 'allocation_source' and typnamespace = 'public'::regnamespace) then
    create type public.allocation_source as enum ('invoice', 'income_entry', 'expense', 'purchase_invoice');
  end if;
  if not exists (select 1 from pg_type where typname = 'allocation_mode' and typnamespace = 'public'::regnamespace) then
    create type public.allocation_mode as enum ('full', 'amount');
  end if;
end $mig$;

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Numbering
-- ═════════════════════════════════════════════════════════════════════════════

create table if not exists public.project_code_counters (
  org_id   uuid not null references public.organizations(id) on delete cascade,
  year     integer not null check (year between 2000 and 2200),
  last_num integer not null default 0 check (last_num >= 0),
  primary key (org_id, year)
);

-- Readable like document_counters (anyone who may see projects may see how far
-- the numbering has got); written only by app.next_project_code.
alter table public.project_code_counters enable row level security;
alter table public.project_code_counters force row level security;
revoke all on public.project_code_counters from anon, authenticated;
grant select on public.project_code_counters to authenticated;
grant all on public.project_code_counters to service_role;
drop policy if exists project_code_counters_select on public.project_code_counters;
create policy project_code_counters_select on public.project_code_counters
  for select to authenticated using (app.has_permission(org_id, 'projects', 'view'));

-- The same shape as public.next_document_number (0002): an upsert on the
-- counter row takes its row lock, so concurrent callers serialize on it and
-- each gets the next number. Gap-free as long as the insert that asked for the
-- number commits; a rolled-back insert leaves a gap, which is acceptable for a
-- project code in a way it is not for a tax invoice.
create or replace function app.next_project_code(p_org uuid, p_date date default current_date)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_year integer := extract(year from coalesce(p_date, current_date))::integer;
  v_num  integer;
begin
  insert into public.project_code_counters (org_id, year, last_num)
  values (p_org, v_year, 1)
  on conflict (org_id, year)
    do update set last_num = public.project_code_counters.last_num + 1
  returning last_num into v_num;
  return format('PRJ-%s-%s', v_year, lpad(v_num::text, 3, '0'));
end $$;

revoke execute on function app.next_project_code(uuid, date) from public;

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. projects
-- ═════════════════════════════════════════════════════════════════════════════

create table if not exists public.projects (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.organizations(id) on delete cascade,
  code                 text not null,
  name                 text not null check (length(btrim(name)) > 0),
  description          text,
  client_id            uuid references public.clients(id) on delete restrict,
  status               public.project_status not null default 'planned',
  billing_type         public.project_billing_type not null default 'fixed_price',
  currency             char(3) not null default 'INR',
  contract_value       numeric(14,2) not null default 0 check (contract_value >= 0),
  budget_labour        numeric(14,2) not null default 0 check (budget_labour >= 0),
  budget_vendor        numeric(14,2) not null default 0 check (budget_vendor >= 0),
  budget_other         numeric(14,2) not null default 0 check (budget_other >= 0),
  start_date           date,
  target_end_date      date,
  actual_end_date      date,
  manager_employee_id  uuid references public.employees(id) on delete set null,
  source_quotation_id  uuid references public.financial_documents(id) on delete set null,
  source_client_stage  text,
  tags                 text[] not null default '{}',
  closed_at            timestamptz,
  closed_by            uuid references auth.users(id) on delete set null,
  archived_at          timestamptz,
  created_by           uuid references auth.users(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint projects_org_code_key unique (org_id, code),
  constraint projects_target_after_start check (target_end_date is null or start_date is null or target_end_date >= start_date),
  constraint projects_actual_after_start check (actual_end_date is null or start_date is null or actual_end_date >= start_date)
);
create index if not exists projects_org_status_idx on public.projects (org_id, status) where archived_at is null;
create index if not exists projects_client_idx     on public.projects (client_id) where client_id is not null;
create index if not exists projects_manager_idx    on public.projects (manager_employee_id) where manager_employee_id is not null;
create index if not exists projects_quotation_idx  on public.projects (source_quotation_id) where source_quotation_id is not null;

-- ─── Helpers the child tables use ────────────────────────────────────────────

create or replace function app.project_is_closed_status(p_status public.project_status)
returns boolean language sql immutable as $$
  select p_status in ('completed', 'cancelled')
$$;

-- A project that no longer exists is not closed: that is the cascade from a
-- project delete, which must be allowed to remove the children it owns.
create or replace function app.project_is_closed(p_project uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select app.project_is_closed_status(p.status)
                     from public.projects p where p.id = p_project), false)
$$;

-- Writes the database makes on its own behalf — an employee's exit ending
-- their memberships, a source delete removing its allocations, a contract
-- change repricing milestones — set this for the rest of their statement so a
-- closed project's lock does not refuse them. Transaction-local, and only ever
-- set from SECURITY DEFINER code: a client cannot call set_config on the
-- server's behalf through PostgREST.
create or replace function app.project_system_write()
returns boolean language sql stable as $$
  select coalesce(current_setting('app.project_system_write', true), '') = 'on'
$$;

-- The closed-project lock, attached to members, milestones and allocations.
create or replace function app.project_lock_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_project uuid;
begin
  if app.project_system_write() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  v_project := case when tg_op = 'DELETE' then old.project_id else new.project_id end;
  if app.project_is_closed(v_project)
     or (tg_op = 'UPDATE' and old.project_id is distinct from new.project_id
         and app.project_is_closed(old.project_id)) then
    raise exception 'PROJECT_CLOSED: this project is closed; reopen it to change its %', replace(tg_table_name, 'project_', '')
      using errcode = 'check_violation';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

-- True when a signed-in caller could not make this write anyway. The guards
-- below return early in that case and let RLS refuse it: a guard runs BEFORE
-- the policy check and as definer, so if it validated first, its errors
-- ("already on the project", "exceeds the source") would describe rows in an
-- organization the caller cannot see. The database's own writes (no auth.uid())
-- are never deferred.
create or replace function app.defer_to_rls(p_org uuid, p_resource text, p_op text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null
     and not app.has_permission(p_org, p_resource,
                                case p_op when 'INSERT' then 'create' when 'DELETE' then 'delete' else 'edit' end)
$$;

-- ─── The row guard ───────────────────────────────────────────────────────────
-- SECURITY DEFINER for the reason 0039 gives: the body calls app.* helpers and
-- `authenticated` has no USAGE on schema app. It also makes the cross-tenant
-- checks immune to the writer's own RLS view (a member without clients.view
-- must still be told the truth about whether a client is theirs).
create or replace function app.project_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if app.defer_to_rls(new.org_id, 'projects', tg_op) then return new; end if;
  if new.client_id is not null and not exists (
       select 1 from public.clients c where c.id = new.client_id and c.org_id = new.org_id) then
    raise exception 'client % does not belong to this organization', new.client_id using errcode = '23503';
  end if;
  if new.manager_employee_id is not null and not exists (
       select 1 from public.employees e where e.id = new.manager_employee_id and e.org_id = new.org_id) then
    raise exception 'employee % does not belong to this organization', new.manager_employee_id using errcode = '23503';
  end if;
  if new.source_quotation_id is not null and not exists (
       select 1 from public.financial_documents f
        where f.id = new.source_quotation_id and f.org_id = new.org_id and f.type = 'quotation') then
    raise exception 'quotation % does not belong to this organization', new.source_quotation_id using errcode = '23503';
  end if;

  new.currency := upper(coalesce(nullif(btrim(new.currency), ''), 'INR'));
  new.tags     := coalesce(new.tags, '{}');

  if tg_op = 'INSERT' then
    -- Always the database's number, whatever the client sent.
    new.code := app.next_project_code(new.org_id, coalesce(new.created_at, now())::date);
    new.created_by := coalesce(new.created_by, auth.uid());
    -- Derived from project_members; there are none yet.
    if not app.project_system_write() then new.manager_employee_id := null; end if;
    if app.project_is_closed_status(new.status) then
      new.closed_at := coalesce(new.closed_at, now());
      new.closed_by := coalesce(new.closed_by, auth.uid());
    else
      new.closed_at := null; new.closed_by := null;
    end if;
    return new;
  end if;

  -- UPDATE
  if new.code is distinct from old.code then
    raise exception 'project code is immutable (% -> %)', old.code, new.code using errcode = 'check_violation';
  end if;
  if not app.project_system_write() then
    new.manager_employee_id := old.manager_employee_id;
  end if;
  new.created_by := old.created_by;

  if new.status is distinct from old.status then
    if app.project_is_closed_status(old.status) and not app.project_is_closed_status(new.status)
       and coalesce(current_setting('app.project_reopening', true), '') <> 'on' then
      raise exception 'PROJECT_CLOSED: a closed project can only be reopened by an owner or admin'
        using errcode = 'insufficient_privilege';
    end if;
    if app.project_is_closed_status(new.status) and not app.project_is_closed_status(old.status) then
      new.closed_at := now();
      new.closed_by := auth.uid();
      new.actual_end_date := coalesce(new.actual_end_date, current_date);
    elsif not app.project_is_closed_status(new.status) then
      new.closed_at := null; new.closed_by := null;
    end if;
  else
    new.closed_at := old.closed_at; new.closed_by := old.closed_by;
  end if;

  new.updated_at := now();
  return new;
end $$;

drop trigger if exists projects_guard on public.projects;
create trigger projects_guard
  before insert or update on public.projects
  for each row execute function app.project_guard();

drop trigger if exists projects_freeze_org on public.projects;
create trigger projects_freeze_org
  before update on public.projects
  for each row execute function app.freeze_org_id();

drop trigger if exists projects_touch on public.projects;
create trigger projects_touch
  before update on public.projects
  for each row execute function app.touch_updated_at();

drop trigger if exists projects_audit on public.projects;
create trigger projects_audit
  after insert or update or delete on public.projects
  for each row execute function app.write_audit();

-- An explicit, human-readable row for every status move, on top of the generic
-- diff write_audit records: the Activity tab and the reopen rule both key on it.
create or replace function app.project_status_audit()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status is distinct from old.status then
    insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, diff)
    values (new.org_id, auth.uid(), 'projects.status_change', 'projects', new.id,
            jsonb_build_object('from', old.status, 'to', new.status, 'code', new.code,
                               'reason', nullif(current_setting('app.project_status_reason', true), '')));
  end if;
  return null;
exception when others then
  raise warning 'project status audit failed: %', sqlerrm;
  return null;
end $$;

drop trigger if exists projects_status_audit on public.projects;
create trigger projects_status_audit
  after update of status on public.projects
  for each row execute function app.project_status_audit();

-- A client with projects is not deleted out from under them (the FK is
-- RESTRICT); archive the client instead, as the CRM already does.

select app.secure_tenant_table('public.projects'::regclass, 'projects');
grant select, insert, update, delete on public.projects to authenticated;
grant all on public.projects to service_role;

-- ─── Realtime ────────────────────────────────────────────────────────────────
do $mig$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'projects') then
    alter publication supabase_realtime add table public.projects;
  end if;
end $mig$;


-- ############################################################################
-- ## 0046_project_members.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0046 — Projects: members
--
-- Who works on a project, in what role, at what share of their time, over what
-- dates. Labour cost (0051) is compensation × this allocation, so the dates are
-- load-bearing: a membership is never hard-deleted in the UI, it is ended.
--
-- Rules, each a trigger rather than a hope:
--
--   · No overlapping date ranges for the same project + employee. Checked in
--     app.project_member_guard with daterange overlap. The live project does
--     not have btree_gist installed (preflight, 2026-09-25), so this is a
--     trigger under a per-project advisory lock rather than an exclusion
--     constraint; the lock is what makes it race-free.
--   · At most one manager at a time on a project (overlapping manager ranges
--     are refused). projects.manager_employee_id follows whoever that is.
--   · Over 100% across projects is ALLOWED and reported by
--     public.employee_allocation (0051) — people do get overbooked, and the
--     point is to see it, not to make the second assignment impossible.
--   · An employee's exit ends their open memberships on the exit date.
--   · A closed project's team is locked (app.project_lock_guard, 0045).
--
-- bill_rate is a client-facing rate for time-and-materials work, not pay. It is
-- readable by anyone with project_members.view; the UI shows it only with
-- project_financials. Pay itself never leaves employee_compensation except as
-- an aggregate from a SECURITY DEFINER function.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.project_members (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  project_id      uuid not null references public.projects(id) on delete cascade,
  employee_id     uuid not null references public.employees(id) on delete cascade,
  role            public.project_member_role not null default 'member',
  allocation_pct  numeric(5,2) not null default 100 check (allocation_pct > 0 and allocation_pct <= 100),
  start_date      date not null default current_date,
  end_date        date,
  bill_rate       numeric(12,2) check (bill_rate is null or bill_rate >= 0),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint project_members_dates_ordered check (end_date is null or end_date >= start_date)
);
create index if not exists project_members_project_idx  on public.project_members (project_id, start_date);
create index if not exists project_members_employee_idx on public.project_members (employee_id, start_date);
create index if not exists project_members_org_idx      on public.project_members (org_id);

create or replace function app.project_member_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- A missing reference is left to NOT NULL, which runs after RLS: raising
  -- here would answer a caller RLS is about to refuse with a constraint error
  -- instead (tests/04_role_smoke_test.sql holds every guard to that).
  if new.project_id is null or new.employee_id is null
     or app.defer_to_rls(new.org_id, 'project_members', tg_op) then return new; end if;
  if not exists (select 1 from public.projects p where p.id = new.project_id and p.org_id = new.org_id) then
    raise exception 'project % does not belong to this organization', new.project_id using errcode = '23503';
  end if;
  if not exists (select 1 from public.employees e where e.id = new.employee_id and e.org_id = new.org_id) then
    raise exception 'employee % does not belong to this organization', new.employee_id using errcode = '23503';
  end if;
  if tg_op = 'UPDATE' and (new.project_id <> old.project_id or new.employee_id <> old.employee_id) then
    raise exception 'a membership cannot move to another project or person; end it and add a new one'
      using errcode = 'check_violation';
  end if;

  -- Serialize writers on this project so the two checks below cannot both pass
  -- for concurrent inserts.
  perform pg_advisory_xact_lock(hashtextextended('project_members:' || new.project_id::text, 0));

  if exists (
       select 1 from public.project_members m
        where m.project_id = new.project_id
          and m.employee_id = new.employee_id
          and m.id <> new.id
          and daterange(m.start_date, m.end_date, '[]') && daterange(new.start_date, new.end_date, '[]')) then
    raise exception 'MEMBER_OVERLAP: this person is already on the project for part of those dates'
      using errcode = 'exclusion_violation';
  end if;

  if new.role = 'manager' and exists (
       select 1 from public.project_members m
        where m.project_id = new.project_id
          and m.role = 'manager'
          and m.id <> new.id
          and daterange(m.start_date, m.end_date, '[]') && daterange(new.start_date, new.end_date, '[]')) then
    raise exception 'MANAGER_EXISTS: the project already has a manager for those dates; end that role first'
      using errcode = 'exclusion_violation';
  end if;

  new.updated_at := now();
  return new;
end $$;

-- Runs after the membership lands (or goes), and points the project at its
-- current manager: the manager-role membership that is live today, else the
-- most recently started one that has not ended, else nobody.
create or replace function app.project_member_sync_manager()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_project uuid := case when tg_op = 'DELETE' then old.project_id else new.project_id end;
  v_manager uuid;
  v_prev    text := coalesce(current_setting('app.project_system_write', true), '');
begin
  select m.employee_id into v_manager
    from public.project_members m
   where m.project_id = v_project and m.role = 'manager'
     and (m.end_date is null or m.end_date >= current_date)
   order by (m.start_date <= current_date) desc, m.start_date desc
   limit 1;

  perform set_config('app.project_system_write', 'on', true);
  update public.projects set manager_employee_id = v_manager
   where id = v_project and manager_employee_id is distinct from v_manager;
  perform set_config('app.project_system_write', v_prev, true);
  return null;
end $$;

drop trigger if exists project_members_lock on public.project_members;
create trigger project_members_lock
  before insert or update or delete on public.project_members
  for each row execute function app.project_lock_guard();

drop trigger if exists project_members_guard on public.project_members;
create trigger project_members_guard
  before insert or update on public.project_members
  for each row execute function app.project_member_guard();

drop trigger if exists project_members_freeze_org on public.project_members;
create trigger project_members_freeze_org
  before update on public.project_members
  for each row execute function app.freeze_org_id();

drop trigger if exists project_members_touch on public.project_members;
create trigger project_members_touch
  before update on public.project_members
  for each row execute function app.touch_updated_at();

drop trigger if exists project_members_manager_sync on public.project_members;
create trigger project_members_manager_sync
  after insert or update or delete on public.project_members
  for each row execute function app.project_member_sync_manager();

drop trigger if exists project_members_audit on public.project_members;
create trigger project_members_audit
  after insert or update or delete on public.project_members
  for each row execute function app.write_audit();

-- ─── Exit ends memberships ───────────────────────────────────────────────────
-- AFTER the exit lands, in the same transaction. A membership that had not
-- started by the exit date ends on its own start date rather than violating
-- dates_ordered; it contributed nothing and now never will.
create or replace function app.end_memberships_on_exit()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_exit date := (new.exited_at at time zone 'UTC')::date;
  v_prev text := coalesce(current_setting('app.project_system_write', true), '');
begin
  perform set_config('app.project_system_write', 'on', true);
  update public.project_members m
     set end_date = greatest(m.start_date, v_exit)
   where m.employee_id = new.id
     and (m.end_date is null or m.end_date > v_exit);
  perform set_config('app.project_system_write', v_prev, true);
  return null;
end $$;

drop trigger if exists employees_end_project_memberships on public.employees;
create trigger employees_end_project_memberships
  after update of exited_at on public.employees
  for each row when (old.exited_at is null and new.exited_at is not null)
  execute function app.end_memberships_on_exit();

select app.secure_tenant_table('public.project_members'::regclass, 'project_members');
grant select, insert, update, delete on public.project_members to authenticated;
grant all on public.project_members to service_role;

do $mig$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'project_members') then
    alter publication supabase_realtime add table public.project_members;
  end if;
end $mig$;


-- ############################################################################
-- ## 0047_project_milestones.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0047 — Projects: milestones
--
-- Stages of a project, each optionally billing a share of the contract. A
-- milestone bills either a percentage (billing_pct) or a fixed amount
-- (billing_amount); when the percentage is set, the amount is DERIVED from it
-- and the contract value, here, so the two can never disagree — and repriced
-- when the contract value changes, unless the milestone has already been
-- invoiced (the invoice is the fact then, not the plan).
--
-- invoice_id is set by the invoice flow (Phase 2): linking an invoice moves the
-- milestone to `invoiced`; losing the invoice (it was deleted, the FK nulled the
-- link) moves it back to `completed`. That link is the one write a closed
-- project still accepts on its milestones — invoicing the final milestone is
-- often what happens right after a project is marked complete.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.project_milestones (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  project_id      uuid not null references public.projects(id) on delete cascade,
  title           text not null check (length(btrim(title)) > 0),
  description     text,
  due_date        date,
  sort_order      integer not null default 0,
  status          public.milestone_status not null default 'pending',
  billing_pct     numeric(5,2) check (billing_pct is null or (billing_pct > 0 and billing_pct <= 100)),
  billing_amount  numeric(14,2) check (billing_amount is null or billing_amount >= 0),
  invoice_id      uuid references public.financial_documents(id) on delete set null,
  completed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists project_milestones_project_idx on public.project_milestones (project_id, sort_order);
create index if not exists project_milestones_due_idx     on public.project_milestones (org_id, due_date)
  where status in ('pending', 'in_progress');
create index if not exists project_milestones_invoice_idx on public.project_milestones (invoice_id) where invoice_id is not null;

-- The lock, with the invoice-link exception. Everything except invoice_id, the
-- status it implies, and the derived columns must be unchanged for a write to a
-- closed project's milestone to pass.
create or replace function app.project_milestone_lock_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_project uuid := case when tg_op = 'DELETE' then old.project_id else new.project_id end;
begin
  if app.project_system_write() or not app.project_is_closed(v_project) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'UPDATE'
     and new.invoice_id is distinct from old.invoice_id
     and (to_jsonb(new) - array['invoice_id','status','completed_at','billing_amount','updated_at'])
       = (to_jsonb(old) - array['invoice_id','status','completed_at','billing_amount','updated_at']) then
    return new;
  end if;
  raise exception 'PROJECT_CLOSED: this project is closed; reopen it to change its milestones'
    using errcode = 'check_violation';
end $$;

create or replace function app.project_milestone_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_contract numeric(14,2);
begin
  -- A missing reference is left to NOT NULL, which runs after RLS: raising
  -- here would answer a caller RLS is about to refuse with a constraint error
  -- instead (tests/04_role_smoke_test.sql holds every guard to that).
  if new.project_id is null or app.defer_to_rls(new.org_id, 'project_milestones', tg_op) then return new; end if;
  select p.contract_value into v_contract
    from public.projects p where p.id = new.project_id and p.org_id = new.org_id;
  if not found then
    raise exception 'project % does not belong to this organization', new.project_id using errcode = '23503';
  end if;
  if tg_op = 'UPDATE' and new.project_id <> old.project_id then
    raise exception 'a milestone cannot move to another project' using errcode = 'check_violation';
  end if;
  if new.invoice_id is not null and not exists (
       select 1 from public.financial_documents f
        where f.id = new.invoice_id and f.org_id = new.org_id and f.type = 'invoice') then
    raise exception 'invoice % does not belong to this organization', new.invoice_id using errcode = '23503';
  end if;

  if new.billing_pct is not null then
    new.billing_amount := round(coalesce(v_contract, 0) * new.billing_pct / 100, 2);
  end if;

  -- The invoice link drives the invoiced state in both directions.
  if new.invoice_id is not null and (tg_op = 'INSERT' or old.invoice_id is null) then
    new.status := 'invoiced';
  elsif new.invoice_id is null and tg_op = 'UPDATE' and old.invoice_id is not null
        and new.status = 'invoiced' then
    new.status := 'completed';
  elsif new.status = 'invoiced' and new.invoice_id is null then
    raise exception 'a milestone is invoiced by linking its invoice, not by setting the status'
      using errcode = 'check_violation';
  end if;

  if new.status in ('completed', 'invoiced') then
    new.completed_at := coalesce(new.completed_at, case when tg_op = 'UPDATE' then old.completed_at end, now());
  else
    new.completed_at := null;
  end if;

  new.updated_at := now();
  return new;
end $$;

drop trigger if exists project_milestones_lock on public.project_milestones;
create trigger project_milestones_lock
  before insert or update or delete on public.project_milestones
  for each row execute function app.project_milestone_lock_guard();

drop trigger if exists project_milestones_guard on public.project_milestones;
create trigger project_milestones_guard
  before insert or update on public.project_milestones
  for each row execute function app.project_milestone_guard();

drop trigger if exists project_milestones_freeze_org on public.project_milestones;
create trigger project_milestones_freeze_org
  before update on public.project_milestones
  for each row execute function app.freeze_org_id();

drop trigger if exists project_milestones_touch on public.project_milestones;
create trigger project_milestones_touch
  before update on public.project_milestones
  for each row execute function app.touch_updated_at();

drop trigger if exists project_milestones_audit on public.project_milestones;
create trigger project_milestones_audit
  after insert or update or delete on public.project_milestones
  for each row execute function app.write_audit();

-- Contract value changed: reprice the percentage milestones not yet invoiced.
create or replace function app.project_reprice_milestones()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_prev text := coalesce(current_setting('app.project_system_write', true), '');
begin
  perform set_config('app.project_system_write', 'on', true);
  update public.project_milestones m
     set billing_amount = round(new.contract_value * m.billing_pct / 100, 2)
   where m.project_id = new.id and m.billing_pct is not null and m.invoice_id is null;
  perform set_config('app.project_system_write', v_prev, true);
  return null;
end $$;

drop trigger if exists projects_reprice_milestones on public.projects;
create trigger projects_reprice_milestones
  after update of contract_value on public.projects
  for each row when (old.contract_value is distinct from new.contract_value)
  execute function app.project_reprice_milestones();

select app.secure_tenant_table('public.project_milestones'::regclass, 'project_milestones');
grant select, insert, update, delete on public.project_milestones to authenticated;
grant all on public.project_milestones to service_role;

do $mig$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'project_milestones') then
    alter publication supabase_realtime add table public.project_milestones;
  end if;
end $mig$;


-- ############################################################################
-- ## 0048_project_documents.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0048 — Projects: document links (no money)
--
-- A project's paperwork: the NDA, the MoU, the offer letters (records), and the
-- quotations and proformas that led to it (financial_documents). Exactly one of
-- the two targets per row. Invoices are deliberately NOT linkable here — an
-- invoice's relationship to a project is money, and money goes through
-- project_allocations (0049), where it is counted exactly once.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.project_documents (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references public.organizations(id) on delete cascade,
  project_id             uuid not null references public.projects(id) on delete cascade,
  record_id              uuid references public.records(id) on delete cascade,
  financial_document_id  uuid references public.financial_documents(id) on delete cascade,
  created_by             uuid references auth.users(id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint project_documents_one_target check (num_nonnulls(record_id, financial_document_id) = 1)
);
create unique index if not exists project_documents_record_key
  on public.project_documents (project_id, record_id) where record_id is not null;
create unique index if not exists project_documents_findoc_key
  on public.project_documents (project_id, financial_document_id) where financial_document_id is not null;
create index if not exists project_documents_record_idx on public.project_documents (record_id) where record_id is not null;
create index if not exists project_documents_findoc_idx on public.project_documents (financial_document_id) where financial_document_id is not null;

create or replace function app.project_document_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- A missing reference is left to NOT NULL, which runs after RLS: raising
  -- here would answer a caller RLS is about to refuse with a constraint error
  -- instead (tests/04_role_smoke_test.sql holds every guard to that).
  if new.project_id is null or app.defer_to_rls(new.org_id, 'project_documents', tg_op) then return new; end if;
  if not exists (select 1 from public.projects p where p.id = new.project_id and p.org_id = new.org_id) then
    raise exception 'project % does not belong to this organization', new.project_id using errcode = '23503';
  end if;
  if new.record_id is not null and not exists (
       select 1 from public.records r where r.id = new.record_id and r.org_id = new.org_id) then
    raise exception 'document % does not belong to this organization', new.record_id using errcode = '23503';
  end if;
  if new.financial_document_id is not null and not exists (
       select 1 from public.financial_documents f
        where f.id = new.financial_document_id and f.org_id = new.org_id
          and f.type in ('quotation', 'proforma')) then
    raise exception 'only a quotation or proforma of this organization can be linked; invoices are allocated'
      using errcode = '23503';
  end if;
  if tg_op = 'INSERT' then new.created_by := coalesce(new.created_by, auth.uid()); end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists project_documents_guard on public.project_documents;
create trigger project_documents_guard
  before insert or update on public.project_documents
  for each row execute function app.project_document_guard();

drop trigger if exists project_documents_freeze_org on public.project_documents;
create trigger project_documents_freeze_org
  before update on public.project_documents
  for each row execute function app.freeze_org_id();

drop trigger if exists project_documents_touch on public.project_documents;
create trigger project_documents_touch
  before update on public.project_documents
  for each row execute function app.touch_updated_at();

drop trigger if exists project_documents_audit on public.project_documents;
create trigger project_documents_audit
  after insert or update or delete on public.project_documents
  for each row execute function app.write_audit();

select app.secure_tenant_table('public.project_documents'::regclass, 'project_documents');
grant select, insert, delete on public.project_documents to authenticated;
grant all on public.project_documents to service_role;

do $mig$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'project_documents') then
    alter publication supabase_realtime add table public.project_documents;
  end if;
end $mig$;


-- ############################################################################
-- ## 0049_project_allocations.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0049 — Projects: allocations (the money link)
--
-- Which money belongs to which project. One row says "this much of that source
-- is this project's", where the source is an invoice, a cash-book income entry,
-- an expense or a purchase bill. A source can be split across projects; what is
-- not allocated is overhead. Nothing here moves money or changes a source row:
-- the source stays exactly what it was, and the P&L keeps counting it once.
--
-- ─── What a source is worth ─────────────────────────────────────────────────
-- app.allocation_source() is the one definition, used by the cap below and by
-- every report in 0051. Net of GST, in INR, on the same terms the app's P&L
-- already uses (src/services/financeAnalytics.js):
--
--   invoice           financial_documents.taxable_amount — after discount and
--                     making charges, before GST (0002 recompute_document_totals).
--                     Only type = 'invoice'. Counts unless draft / cancelled /
--                     declined / expired, the P&L's DEAD set; a cancelled
--                     invoice keeps its allocations but stops being revenue.
--                     financial_documents has no FX column (preflight): the
--                     P&L treats taxable_amount as base currency and so does
--                     this. When invoices gain an fx_rate this is the one place
--                     to apply it.
--   income_entry      amount − tax_amount. `amount` is already INR (0041 derives
--                     it from original_amount × fx_rate). Computed rather than
--                     read from net_amount, for the reason financeAnalytics.net()
--                     gives: a row written without the trigger kept a zero there.
--   expense           amount − tax_amount, as above. expenses has no net_amount
--                     column at all on the live project.
--   purchase_invoice  subtotal (the taxable value; tax_amount is input GST).
--                     Counts unless void.
--
-- ─── Rules ──────────────────────────────────────────────────────────────────
--   · mode 'full' = the whole net amount, and then it is the only allocation of
--     that source. mode 'amount' rows for one source sum to ≤ its net amount.
--   · Editing a cash-book entry or a bill below what is allocated from it fails
--     with ALLOCATION_EXCEEDS_SOURCE; the UI turns that into "adjust the project
--     split first". Invoices are the exception: orgStore rewrites an invoice's
--     line items as a delete then an insert in two requests, so between them
--     the invoice is honestly worth zero and a hard check would break every
--     invoice edit. For invoices the reports scale amount-allocations down to
--     the invoice's value instead (app.project_allocation_rows), and the UI
--     flags the invoice as over-allocated.
--   · Deleting a source deletes its allocations (there is no polymorphic FK, so
--     each source table gets an AFTER DELETE trigger).
--   · A closed project's allocations are locked (0045's guard) — except that a
--     source being deleted still takes its allocations with it.
--
-- ─── Who can see them ───────────────────────────────────────────────────────
-- Every policy is the matrix verb on project_allocations AND view on
-- project_financials. A member holds the first by default and not the second,
-- so a member sees no allocations until an admin grants Project financials.
-- NOTE: app.secure_tenant_table() drops and rebuilds a table's policies from
-- the matrix alone; re-running it on this table would silently drop the
-- financials clause. Section 5 below is what has to be re-run after it.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.project_allocations (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  project_id   uuid not null references public.projects(id) on delete restrict,
  source_type  public.allocation_source not null,
  source_id    uuid not null,
  mode         public.allocation_mode not null default 'full',
  amount       numeric(14,2) check (amount is null or amount > 0),
  note         text,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint project_allocations_source_project_key unique (source_type, source_id, project_id),
  constraint project_allocations_amount_matches_mode check (
    (mode = 'full' and amount is null) or (mode = 'amount' and amount is not null))
);
create index if not exists project_allocations_project_idx on public.project_allocations (project_id);
create index if not exists project_allocations_source_idx  on public.project_allocations (source_type, source_id);
create index if not exists project_allocations_org_idx     on public.project_allocations (org_id);

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. What a source is worth
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function app.allocation_source(p_type public.allocation_source, p_id uuid)
returns table (org_id uuid, net numeric, on_date date, client_id uuid, counts boolean,
               label text, category text, treatment text, gross numeric, amount_paid numeric,
               due_date date, status text)
language sql stable security definer set search_path = public, pg_temp as $$
  select f.org_id, f.taxable_amount, f.issue_date, f.customer_id,
         f.status not in ('draft', 'cancelled', 'declined', 'expired'),
         f.doc_number, null::text, 'revenue'::text, f.grand_total, f.amount_paid,
         f.due_date, f.status::text
    from public.financial_documents f
   where p_type = 'invoice' and f.id = p_id and f.type = 'invoice'
  union all
  select i.org_id, round(i.amount - i.tax_amount, 2), i.received_on, i.client_id, true,
         i.description, i.category, i.treatment, i.amount, i.amount,
         null::date, null::text
    from public.income_entries i
   where p_type = 'income_entry' and i.id = p_id
  union all
  select e.org_id, round(e.amount - e.tax_amount, 2), e.incurred_on, e.client_id, true,
         e.description, e.category, e.treatment, e.amount,
         case when e.status = 'paid' then e.amount else 0 end,
         null::date, e.status
    from public.expenses e
   where p_type = 'expense' and e.id = p_id
  union all
  select b.org_id, b.subtotal, b.bill_date, null::uuid, b.status <> 'void',
         b.bill_number, b.category, 'operating'::text, b.total, b.amount_paid,
         b.due_date, b.status
    from public.purchase_invoices b
   where p_type = 'purchase_invoice' and b.id = p_id
$$;

create or replace function app.allocation_source_net(p_type public.allocation_source, p_id uuid)
returns numeric language sql stable security definer set search_path = public, pg_temp as $$
  select net from app.allocation_source(p_type, p_id)
$$;

revoke execute on function app.allocation_source(public.allocation_source, uuid) from public;
revoke execute on function app.allocation_source_net(public.allocation_source, uuid) from public;

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. The row guard: cap, exclusivity, same tenant
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function app.project_allocation_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_src_org uuid;
  v_net     numeric;
  v_others  numeric;
begin
  -- A missing reference is left to NOT NULL, which runs after RLS: raising
  -- here would answer a caller RLS is about to refuse with a constraint error
  -- instead (tests/04_role_smoke_test.sql holds every guard to that).
  if new.project_id is null or new.source_id is null or new.source_type is null
     or app.defer_to_rls(new.org_id, 'project_allocations', tg_op)
     or (auth.uid() is not null and not app.has_permission(new.org_id, 'project_financials', 'view')) then
    return new;
  end if;
  if tg_op = 'UPDATE' and (new.source_type <> old.source_type or new.source_id <> old.source_id) then
    raise exception 'an allocation cannot be pointed at a different source; remove it and allocate again'
      using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.projects p where p.id = new.project_id and p.org_id = new.org_id) then
    raise exception 'project % does not belong to this organization', new.project_id using errcode = '23503';
  end if;

  select s.org_id, s.net into v_src_org, v_net
    from app.allocation_source(new.source_type, new.source_id) s;
  if v_src_org is null or v_src_org <> new.org_id then
    raise exception 'ALLOCATION_SOURCE_NOT_FOUND: that % does not exist in this organization', new.source_type
      using errcode = '23503';
  end if;

  -- One writer per source at a time, so two splits cannot both fit.
  perform pg_advisory_xact_lock(hashtextextended('project_allocations:' || new.source_id::text, 0));

  if new.mode = 'full' then
    new.amount := null;
    if exists (select 1 from public.project_allocations a
                where a.source_type = new.source_type and a.source_id = new.source_id and a.id <> new.id) then
      raise exception 'ALLOCATION_FULL_CONFLICT: this entry is already split across projects; a whole-entry allocation must be the only one'
        using errcode = 'check_violation';
    end if;
  else
    if new.amount is null or new.amount <= 0 then
      raise exception 'an amount allocation needs an amount above zero' using errcode = 'check_violation';
    end if;
    if exists (select 1 from public.project_allocations a
                where a.source_type = new.source_type and a.source_id = new.source_id
                  and a.id <> new.id and a.mode = 'full') then
      raise exception 'ALLOCATION_FULL_CONFLICT: this entry is already allocated in full to a project'
        using errcode = 'check_violation';
    end if;
    select coalesce(sum(a.amount), 0) into v_others
      from public.project_allocations a
     where a.source_type = new.source_type and a.source_id = new.source_id and a.id <> new.id;
    if v_others + new.amount > coalesce(v_net, 0) + 0.005 then
      raise exception 'ALLOCATION_EXCEEDS_SOURCE: % allocated against a net value of %', v_others + new.amount, coalesce(v_net, 0)
        using errcode = 'check_violation';
    end if;
  end if;

  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, auth.uid());
  else
    new.created_by := old.created_by;
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists project_allocations_lock on public.project_allocations;
create trigger project_allocations_lock
  before insert or update or delete on public.project_allocations
  for each row execute function app.project_lock_guard();

drop trigger if exists project_allocations_guard on public.project_allocations;
create trigger project_allocations_guard
  before insert or update on public.project_allocations
  for each row execute function app.project_allocation_guard();

drop trigger if exists project_allocations_freeze_org on public.project_allocations;
create trigger project_allocations_freeze_org
  before update on public.project_allocations
  for each row execute function app.freeze_org_id();

drop trigger if exists project_allocations_touch on public.project_allocations;
create trigger project_allocations_touch
  before update on public.project_allocations
  for each row execute function app.touch_updated_at();

drop trigger if exists project_allocations_audit on public.project_allocations;
create trigger project_allocations_audit
  after insert or update or delete on public.project_allocations
  for each row execute function app.write_audit();

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. The source tables: delete cascades, edits respect the cap
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function app.allocation_source_deleted()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_type public.allocation_source := tg_argv[0]::public.allocation_source;
  v_prev text := coalesce(current_setting('app.project_system_write', true), '');
begin
  perform set_config('app.project_system_write', 'on', true);
  delete from public.project_allocations a where a.source_type = v_type and a.source_id = old.id;
  perform set_config('app.project_system_write', v_prev, true);
  return null;
end $$;

-- AFTER UPDATE, so the row's own BEFORE guard has already derived its final
-- amounts (expense_guard computes amount from original_amount × fx_rate).
create or replace function app.allocation_source_updated()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_type public.allocation_source := tg_argv[0]::public.allocation_source;
  v_net  numeric;
  v_sum  numeric;
begin
  select coalesce(sum(a.amount), 0) into v_sum
    from public.project_allocations a
   where a.source_type = v_type and a.source_id = new.id and a.mode = 'amount';
  if v_sum = 0 then return null; end if;

  v_net := app.allocation_source_net(v_type, new.id);
  if v_sum > coalesce(v_net, 0) + 0.005 then
    raise exception 'ALLOCATION_EXCEEDS_SOURCE: % is allocated to projects from this entry, more than its new net value of %', v_sum, coalesce(v_net, 0)
      using errcode = 'check_violation';
  end if;
  return null;
end $$;

do $mig$
declare r record;
begin
  for r in select * from (values
      ('financial_documents', 'invoice'),
      ('income_entries',      'income_entry'),
      ('expenses',            'expense'),
      ('purchase_invoices',   'purchase_invoice')) v(tbl, src)
  loop
    execute format('drop trigger if exists %I on public.%I', r.tbl || '_project_allocations_delete', r.tbl);
    execute format(
      'create trigger %I after delete on public.%I for each row execute function app.allocation_source_deleted(%L)',
      r.tbl || '_project_allocations_delete', r.tbl, r.src);
    -- Invoices are left out of the edit check; see the header.
    if r.tbl <> 'financial_documents' then
      execute format('drop trigger if exists %I on public.%I', r.tbl || '_project_allocations_cap', r.tbl);
      execute format(
        'create trigger %I after update on public.%I for each row execute function app.allocation_source_updated(%L)',
        r.tbl || '_project_allocations_cap', r.tbl, r.src);
    end if;
  end loop;
end $mig$;

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. A project with history is archived, not deleted
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function app.project_delete_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if exists (select 1 from public.project_allocations a where a.project_id = old.id)
     or exists (select 1 from public.project_milestones m where m.project_id = old.id and m.invoice_id is not null)
     or exists (select 1 from public.project_documents d where d.project_id = old.id) then
    raise exception 'PROJECT_HAS_HISTORY: this project has money or documents linked to it; archive it instead'
      using errcode = 'foreign_key_violation';
  end if;
  return old;
end $$;

drop trigger if exists projects_delete_guard on public.projects;
create trigger projects_delete_guard
  before delete on public.projects
  for each row execute function app.project_delete_guard();

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. Policies: the matrix AND project_financials
-- ═════════════════════════════════════════════════════════════════════════════

select app.secure_tenant_table('public.project_allocations'::regclass, 'project_allocations');

drop policy if exists project_allocations_select on public.project_allocations;
drop policy if exists project_allocations_insert on public.project_allocations;
drop policy if exists project_allocations_update on public.project_allocations;
drop policy if exists project_allocations_delete on public.project_allocations;

create policy project_allocations_select on public.project_allocations for select to authenticated
  using (app.has_permission(org_id, 'project_allocations', 'view')
         and app.has_permission(org_id, 'project_financials', 'view'));
create policy project_allocations_insert on public.project_allocations for insert to authenticated
  with check (app.has_permission(org_id, 'project_allocations', 'create')
              and app.has_permission(org_id, 'project_financials', 'view'));
create policy project_allocations_update on public.project_allocations for update to authenticated
  using      (app.has_permission(org_id, 'project_allocations', 'edit')
              and app.has_permission(org_id, 'project_financials', 'view'))
  with check (app.has_permission(org_id, 'project_allocations', 'edit')
              and app.has_permission(org_id, 'project_financials', 'view'));
create policy project_allocations_delete on public.project_allocations for delete to authenticated
  using (app.has_permission(org_id, 'project_allocations', 'delete')
         and app.has_permission(org_id, 'project_financials', 'view'));

grant select, insert, update, delete on public.project_allocations to authenticated;
grant all on public.project_allocations to service_role;

-- ═════════════════════════════════════════════════════════════════════════════
-- 6. Saving a split in one transaction
-- ═════════════════════════════════════════════════════════════════════════════
-- The pickers in the invoice, cash-book and bill forms hand over the whole
-- split for one source: [{ "project_id": …, "amount": null | n }], where a
-- single row with a null amount means "all of it". This makes the source's
-- allocations equal to that list — unchanged rows are left alone (so a closed
-- project's untouched share is not rewritten and refused), shrinking rows are
-- applied before growing ones, and new rows last, so the cap is never tripped
-- by the order of the edit. An empty list removes every allocation of the
-- source: "rest is overhead".
--
-- SECURITY INVOKER on purpose: every row it touches passes the caller's own
-- policies, exactly as if the browser had written them one by one — it only
-- adds atomicity.
create or replace function public.set_project_allocations(
  p_source_type public.allocation_source, p_source_id uuid, p_splits jsonb)
returns setof public.project_allocations
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_splits jsonb := coalesce(p_splits, '[]'::jsonb);
  v_split  jsonb;
  v_full   boolean;
  r        record;
begin
  if jsonb_typeof(v_splits) <> 'array' then
    raise exception 'splits must be a JSON array' using errcode = '22023';
  end if;
  v_full := jsonb_array_length(v_splits) = 1 and (v_splits -> 0 ->> 'amount') is null;
  if jsonb_array_length(v_splits) > 1
     and exists (select 1 from jsonb_array_elements(v_splits) e where (e ->> 'amount') is null) then
    raise exception 'ALLOCATION_FULL_CONFLICT: a split across several projects needs an amount on every line'
      using errcode = 'check_violation';
  end if;

  -- 1. Rows whose project is no longer in the split.
  delete from public.project_allocations a
   where a.source_type = p_source_type and a.source_id = p_source_id
     and not exists (select 1 from jsonb_array_elements(v_splits) e
                      where (e ->> 'project_id')::uuid = a.project_id);

  -- 2. Changed rows, shrinking first.
  for r in
    select a.id, a.mode, a.amount,
           (e ->> 'amount')::numeric as new_amount
      from public.project_allocations a
      join jsonb_array_elements(v_splits) e
        on (e ->> 'project_id')::uuid = a.project_id
     where a.source_type = p_source_type and a.source_id = p_source_id
     order by coalesce((e ->> 'amount')::numeric, 0) - coalesce(a.amount, 0)
  loop
    if v_full and r.mode <> 'full' then
      update public.project_allocations set mode = 'full', amount = null where id = r.id;
    elsif not v_full and (r.mode <> 'amount' or r.amount is distinct from r.new_amount) then
      update public.project_allocations set mode = 'amount', amount = r.new_amount where id = r.id;
    end if;
  end loop;

  -- 3. New rows. The org is the project's (read through the caller's own
  -- RLS); the row guard then refuses a source from any other organization.
  for v_split in select * from jsonb_array_elements(v_splits) loop
    if not exists (select 1 from public.project_allocations a
                    where a.source_type = p_source_type and a.source_id = p_source_id
                      and a.project_id = (v_split ->> 'project_id')::uuid) then
      insert into public.project_allocations (org_id, project_id, source_type, source_id, mode, amount, note)
      values ((select p.org_id from public.projects p where p.id = (v_split ->> 'project_id')::uuid),
              (v_split ->> 'project_id')::uuid, p_source_type, p_source_id,
              case when v_full then 'full' else 'amount' end::public.allocation_mode,
              case when v_full then null else (v_split ->> 'amount')::numeric end,
              nullif(v_split ->> 'note', ''));
    end if;
  end loop;

  return query select * from public.project_allocations a
                where a.source_type = p_source_type and a.source_id = p_source_id;
end $$;

revoke execute on function public.set_project_allocations(public.allocation_source, uuid, jsonb) from public, anon;
grant execute on function public.set_project_allocations(public.allocation_source, uuid, jsonb) to authenticated;

do $mig$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'project_allocations') then
    alter publication supabase_realtime add table public.project_allocations;
  end if;
end $mig$;


-- ############################################################################
-- ## 0050_tasks_project_link.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0050 — Tasks belong to projects (optionally)
--
-- Two nullable columns. A task with no project is "General", which is every
-- task that exists today; nothing is backfilled and nothing about an unlinked
-- task changes. A milestone must belong to the task's project, and a task given
-- only a milestone takes the milestone's project, so the pair can never
-- disagree.
--
-- ON DELETE SET NULL on both: deleting a project that has no money history
-- (0049's guard) returns its tasks to General rather than deleting work.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.tasks
  add column if not exists project_id   uuid references public.projects(id) on delete set null,
  add column if not exists milestone_id uuid references public.project_milestones(id) on delete set null;

create index if not exists tasks_project_idx   on public.tasks (project_id, status) where project_id is not null;
create index if not exists tasks_milestone_idx on public.tasks (milestone_id) where milestone_id is not null;

-- Only what changed is checked. The FK actions of a project delete arrive here
-- as UPDATEs (milestone_id nulled, project_id nulled) while the project row is
-- already gone; re-validating the untouched column on those would refuse the
-- cascade.
create or replace function app.task_project_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ms_project   uuid;
  v_ms_changed   boolean := tg_op = 'INSERT' or new.milestone_id is distinct from old.milestone_id;
  v_proj_changed boolean := tg_op = 'INSERT' or new.project_id is distinct from old.project_id;
begin
  -- Taking a task out of its project takes it out of the milestone too.
  if tg_op = 'UPDATE' and v_proj_changed and new.project_id is null then
    new.milestone_id := null;
    return new;
  end if;

  if new.milestone_id is not null and (v_ms_changed or v_proj_changed) then
    select m.project_id into v_ms_project
      from public.project_milestones m
     where m.id = new.milestone_id and m.org_id = new.org_id;
    if v_ms_project is null then
      raise exception 'milestone % does not belong to this organization', new.milestone_id using errcode = '23503';
    end if;
    if new.project_id is null then
      new.project_id := v_ms_project;
      v_proj_changed := true;
    elsif new.project_id <> v_ms_project then
      raise exception 'TASK_MILESTONE_MISMATCH: that milestone belongs to a different project'
        using errcode = 'check_violation';
    end if;
  end if;

  if new.project_id is not null and v_proj_changed and not exists (
       select 1 from public.projects p where p.id = new.project_id and p.org_id = new.org_id) then
    raise exception 'project % does not belong to this organization', new.project_id using errcode = '23503';
  end if;
  return new;
end $$;

drop trigger if exists tasks_project_guard on public.tasks;
create trigger tasks_project_guard
  before insert or update of project_id, milestone_id on public.tasks
  for each row execute function app.task_project_guard();


-- ############################################################################
-- ## 0051_project_reporting.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0051 — Projects: reporting functions
--
-- The only way project money leaves the database in aggregate. All of them are
-- SECURITY DEFINER with a pinned search_path, and every public one checks the
-- caller's permission itself before reading anything — a definer function is
-- outside RLS, so the check here IS the boundary.
--
--   app.project_labour_cost        internal; not executable by any client role
--   app.project_allocation_rows    internal; one row per allocation, valued
--   app.project_financials_calc    internal; the P&L, no permission check
--   public.project_financials      one project; needs project_financials.view
--   public.project_portfolio       every visible project; money columns null
--                                  without project_financials.view
--   public.employee_allocation     who is booked where today; no money at all
--
-- ─── The P&L, in the P&L's own terms ────────────────────────────────────────
-- Accrual: revenue is what was invoiced, collected cash is shown next to it.
-- Everything is net of GST and in INR (see 0049 for what "net" means per
-- source). Treatments decide what counts, exactly as financeAnalytics does:
--
--   revenue_invoiced   allocated invoices that count (not draft/cancelled/
--                      declined/expired), by issue_date
--   revenue_collected  confirmed payments on those invoices in the period,
--                      pro-rata by the project's share, converted to net
--                      (payment × allocated ÷ invoice grand total)
--   other_income       allocated income entries treated revenue/other_income
--                      and not the receipt of an invoice (document_id null)
--   vendor_costs       allocated purchase bills that are not void
--   expense_costs      allocated expenses treated operating/non_operating,
--                      less allocated cost_recovery income. capex, financing,
--                      owner and tax are cash, not cost, and are left out.
--   labour_cost        members' pay × allocation over the overlap of member,
--                      project and period dates, clipped at exit
--
-- The budget figures (cost_to_date, budget_burn_pct) and the billing figures
-- (billed_pct, unbilled_value, receivables) are always to date, whatever
-- period is asked for: burn is a statement about now.
--
-- ─── Labour cost ────────────────────────────────────────────────────────────
-- Monthly pay × 12 / 365 per day × days × allocation %. employee_compensation
-- stores `amount` with a `payment_frequency`; the app offers Monthly, Yearly
-- and One-time (EmployeeForm.jsx). Monthly is taken as is, Yearly is ÷ 12,
-- Weekly × 52 / 12 if one ever appears. One-time pay and unpaid people
-- (is_paid = false) contribute nothing: a one-off payment has no daily rate to
-- spread. Compensation is taken as INR; the table records a currency but no
-- rate, and the preflight could not show whether any non-INR pay exists.
-- ─────────────────────────────────────────────────────────────────────────────

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Labour cost (internal)
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function app.monthly_pay(p_amount numeric, p_frequency text, p_is_paid boolean)
returns numeric language sql immutable as $$
  select case
    when p_amount is null or coalesce(p_is_paid, true) = false then 0
    when lower(btrim(coalesce(p_frequency, 'monthly'))) in ('monthly', 'month', 'per month') then p_amount
    when lower(btrim(p_frequency)) in ('yearly', 'annual', 'annually', 'year', 'per annum') then p_amount / 12
    when lower(btrim(p_frequency)) in ('weekly', 'week') then p_amount * 52 / 12
    else 0
  end
$$;

create or replace function app.project_labour_cost(p_project_id uuid, p_from date default null, p_to date default null)
returns numeric language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(round(sum(
           app.monthly_pay(c.amount, c.payment_frequency, c.is_paid) * 12 / 365
           * (w.hi - w.lo + 1) * m.allocation_pct / 100), 2), 0)
    from public.project_members m
    join public.projects  p on p.id = m.project_id
    join public.employees e on e.id = m.employee_id
    left join public.employee_compensation c on c.employee_id = e.id
   cross join lateral (
     select greatest(m.start_date,
                     coalesce(p.start_date, m.start_date),
                     coalesce(p_from, m.start_date)) as lo,
            least(coalesce(m.end_date, 'infinity'::date),
                  coalesce(p.actual_end_date, 'infinity'::date),
                  coalesce(p_to, current_date),
                  coalesce((e.exited_at at time zone 'UTC')::date, 'infinity'::date)) as hi
   ) w
   where m.project_id = p_project_id
     and w.hi >= w.lo
$$;

revoke execute on function app.monthly_pay(numeric, text, boolean) from public;
revoke execute on function app.project_labour_cost(uuid, date, date) from public;

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Allocations, valued
-- ═════════════════════════════════════════════════════════════════════════════
-- `allocated` is what the project's share is worth in INR net: the whole net
-- value for a 'full' allocation, the amount for an 'amount' one — scaled down
-- pro rata if the source is now worth less than was allocated from it (only
-- possible for invoices, see 0049).

create or replace function app.project_allocation_rows(p_project_id uuid)
returns table (allocation_id uuid, source_type public.allocation_source, source_id uuid,
               mode public.allocation_mode, allocated numeric, source_net numeric,
               share numeric, on_date date, counts boolean, category text, treatment text,
               gross numeric, amount_paid numeric, due_date date, status text, label text,
               linked_document uuid)
language sql stable security definer set search_path = public, pg_temp as $$
  select a.id, a.source_type, a.source_id, a.mode,
         round(case when a.mode = 'full' then s.net
                    else a.amount * least(1, coalesce(s.net, 0) / nullif(t.total_amount, 0)) end, 2),
         s.net,
         case when coalesce(s.net, 0) = 0 then 0
              else least(1, case when a.mode = 'full' then 1
                                 else a.amount * least(1, s.net / nullif(t.total_amount, 0)) / s.net end) end,
         s.on_date, s.counts, s.category, s.treatment, s.gross, s.amount_paid, s.due_date, s.status, s.label,
         case when a.source_type = 'income_entry'
              then (select i.document_id from public.income_entries i where i.id = a.source_id) end
    from public.project_allocations a
   cross join lateral app.allocation_source(a.source_type, a.source_id) s
    left join lateral (
      select sum(x.amount) as total_amount
        from public.project_allocations x
       where x.source_type = a.source_type and x.source_id = a.source_id and x.mode = 'amount'
    ) t on true
   where a.project_id = p_project_id
$$;

revoke execute on function app.project_allocation_rows(uuid) from public;

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. The project P&L (internal)
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function app.project_financials_calc(p_project_id uuid, p_from date default null, p_to date default null)
returns table (
  project_id uuid,
  revenue_invoiced numeric, revenue_collected numeric, other_income numeric,
  direct_costs numeric, vendor_costs numeric, expense_costs numeric, costs_by_category jsonb,
  labour_cost numeric,
  gross_margin numeric, gross_margin_pct numeric, net_margin numeric, net_margin_pct numeric,
  budget_total numeric, cost_to_date numeric, budget_burn_pct numeric,
  contract_value numeric, billed_to_date numeric, billed_pct numeric, unbilled_value numeric,
  outstanding_receivable numeric, overdue_receivable numeric,
  over_allocated_sources integer)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_p            public.projects;
  v_in_period    boolean;
  r              record;
  v_rev          numeric := 0;
  v_collected    numeric := 0;
  v_other        numeric := 0;
  v_vendor       numeric := 0;
  v_expense      numeric := 0;
  v_cats         jsonb := '{}'::jsonb;
  v_labour       numeric;
  v_costs_all    numeric := 0;   -- to date, for burn
  v_billed_all   numeric := 0;
  v_outstanding  numeric := 0;
  v_overdue      numeric := 0;
  v_over_alloc   integer := 0;
  v_paid_period  numeric;
  v_budget       numeric;
  v_revenue      numeric;
  v_gross        numeric;
  v_net          numeric;
  v_cat          text;
begin
  select * into v_p from public.projects p where p.id = p_project_id;
  if not found then return; end if;

  for r in select * from app.project_allocation_rows(p_project_id) loop
    v_in_period := r.on_date is not null
                   and (p_from is null or r.on_date >= p_from)
                   and (p_to   is null or r.on_date <= p_to);

    if r.mode = 'amount' and r.allocated + 0.005 < coalesce(
         (select a.amount from public.project_allocations a where a.id = r.allocation_id), 0) then
      v_over_alloc := v_over_alloc + 1;
    end if;

    if r.source_type = 'invoice' then
      if not r.counts then continue; end if;
      v_billed_all := v_billed_all + r.allocated;
      if v_in_period then v_rev := v_rev + r.allocated; end if;
      -- Collections: confirmed payments dated in the period, the project's
      -- share of them, net of GST.
      select coalesce(sum(pm.amount), 0) into v_paid_period
        from public.payments pm
       where pm.document_id = r.source_id and pm.confirmed_at is not null
         and (p_from is null or pm.paid_on >= p_from)
         and (p_to   is null or pm.paid_on <= p_to);
      if coalesce(r.gross, 0) > 0 then
        v_collected := v_collected + v_paid_period * r.allocated / r.gross;
        -- Receivables are what the client owes, GST included, pro rata.
        v_outstanding := v_outstanding + greatest(r.gross - r.amount_paid, 0) * r.share;
        if r.due_date is not null and r.due_date < current_date and r.status <> 'paid' then
          v_overdue := v_overdue + greatest(r.gross - r.amount_paid, 0) * r.share;
        end if;
      end if;

    elsif r.source_type = 'income_entry' then
      if r.treatment in ('revenue', 'other_income') and r.linked_document is null then
        if v_in_period then v_other := v_other + r.allocated; end if;
      elsif r.treatment = 'cost_recovery' then
        v_costs_all := v_costs_all - r.allocated;
        if v_in_period then
          v_expense := v_expense - r.allocated;
          v_cats := jsonb_set(v_cats, '{Recoveries}',
                      to_jsonb(coalesce((v_cats ->> 'Recoveries')::numeric, 0) - r.allocated));
        end if;
      end if;
      -- capital_in: cash, never income.

    elsif r.source_type = 'expense' then
      if r.treatment in ('operating', 'non_operating') then
        v_costs_all := v_costs_all + r.allocated;
        if v_in_period then
          v_expense := v_expense + r.allocated;
          v_cat := coalesce(r.category, 'Other');
          v_cats := jsonb_set(v_cats, array[v_cat],
                      to_jsonb(coalesce((v_cats ->> v_cat)::numeric, 0) + r.allocated));
        end if;
      end if;

    elsif r.source_type = 'purchase_invoice' then
      if r.counts then
        v_costs_all := v_costs_all + r.allocated;
        if v_in_period then
          v_vendor := v_vendor + r.allocated;
          v_cat := coalesce(r.category, 'Other');
          v_cats := jsonb_set(v_cats, array[v_cat],
                      to_jsonb(coalesce((v_cats ->> v_cat)::numeric, 0) + r.allocated));
        end if;
      end if;
    end if;
  end loop;

  v_labour    := app.project_labour_cost(p_project_id, p_from, p_to);
  v_costs_all := v_costs_all + app.project_labour_cost(p_project_id, null, current_date);
  v_budget    := v_p.budget_labour + v_p.budget_vendor + v_p.budget_other;
  v_revenue   := v_rev + v_other;
  v_gross     := v_revenue - (v_vendor + v_expense);
  v_net       := v_gross - v_labour;

  project_id             := p_project_id;
  revenue_invoiced       := round(v_rev, 2);
  revenue_collected      := round(v_collected, 2);
  other_income           := round(v_other, 2);
  vendor_costs           := round(v_vendor, 2);
  expense_costs          := round(v_expense, 2);
  direct_costs           := round(v_vendor + v_expense, 2);
  costs_by_category      := v_cats;
  labour_cost            := v_labour;
  gross_margin           := round(v_gross, 2);
  gross_margin_pct       := case when v_revenue > 0 then round(v_gross / v_revenue * 100, 1) end;
  net_margin             := round(v_net, 2);
  net_margin_pct         := case when v_revenue > 0 then round(v_net / v_revenue * 100, 1) end;
  budget_total           := v_budget;
  cost_to_date           := round(v_costs_all, 2);
  budget_burn_pct        := case when v_budget > 0 then round(v_costs_all / v_budget * 100, 1) end;
  contract_value         := v_p.contract_value;
  billed_to_date         := round(v_billed_all, 2);
  billed_pct             := case when v_p.contract_value > 0 then round(v_billed_all / v_p.contract_value * 100, 1) end;
  unbilled_value         := greatest(round(v_p.contract_value - v_billed_all, 2), 0);
  outstanding_receivable := round(v_outstanding, 2);
  overdue_receivable     := round(v_overdue, 2);
  over_allocated_sources := v_over_alloc;
  return next;
end $$;

revoke execute on function app.project_financials_calc(uuid, date, date) from public;

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. Public entry points
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function public.project_financials(p_project_id uuid, p_from date default null, p_to date default null)
returns table (
  project_id uuid,
  revenue_invoiced numeric, revenue_collected numeric, other_income numeric,
  direct_costs numeric, vendor_costs numeric, expense_costs numeric, costs_by_category jsonb,
  labour_cost numeric,
  gross_margin numeric, gross_margin_pct numeric, net_margin numeric, net_margin_pct numeric,
  budget_total numeric, cost_to_date numeric, budget_burn_pct numeric,
  contract_value numeric, billed_to_date numeric, billed_pct numeric, unbilled_value numeric,
  outstanding_receivable numeric, overdue_receivable numeric,
  over_allocated_sources integer)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_org uuid;
begin
  select p.org_id into v_org from public.projects p where p.id = p_project_id;
  -- Same answer for "no such project" and "not yours": neither leaks existence.
  if v_org is null or not app.has_permission(v_org, 'project_financials', 'view') then
    raise exception 'PERMISSION_DENIED: project financials are not available to you'
      using errcode = 'insufficient_privilege';
  end if;
  return query select * from app.project_financials_calc(p_project_id, p_from, p_to);
end $$;

create or replace function public.project_portfolio(p_from date default null, p_to date default null, p_org uuid default null)
returns table (
  project_id uuid, org_id uuid, code text, name text, client_id uuid,
  status public.project_status, archived boolean,
  milestones_total integer, milestones_done integer, open_tasks integer,
  has_financials boolean,
  revenue_invoiced numeric, revenue_collected numeric, other_income numeric,
  direct_costs numeric, labour_cost numeric, net_margin numeric, net_margin_pct numeric,
  budget_total numeric, cost_to_date numeric, budget_burn_pct numeric,
  contract_value numeric, billed_pct numeric, unbilled_value numeric,
  outstanding_receivable numeric, overdue_receivable numeric)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  p  record;
  f  record;
  v_fin boolean;
begin
  for p in
    select pr.*
      from public.projects pr
     where (p_org is null or pr.org_id = p_org)
       and app.has_permission(pr.org_id, 'projects', 'view')
     order by pr.created_at desc
  loop
    v_fin := app.has_permission(p.org_id, 'project_financials', 'view');
    project_id := p.id; org_id := p.org_id; code := p.code; name := p.name;
    client_id := p.client_id; status := p.status; archived := p.archived_at is not null;
    select count(*)::int, count(*) filter (where m.status in ('completed', 'invoiced'))::int
      into milestones_total, milestones_done
      from public.project_milestones m where m.project_id = p.id and m.status <> 'cancelled';
    select count(*)::int into open_tasks
      from public.tasks t where t.project_id = p.id and t.status <> 'done';
    has_financials := v_fin;

    if v_fin then
      select * into f from app.project_financials_calc(p.id, p_from, p_to);
      revenue_invoiced := f.revenue_invoiced; revenue_collected := f.revenue_collected;
      other_income := f.other_income; direct_costs := f.direct_costs; labour_cost := f.labour_cost;
      net_margin := f.net_margin; net_margin_pct := f.net_margin_pct;
      budget_total := f.budget_total; cost_to_date := f.cost_to_date; budget_burn_pct := f.budget_burn_pct;
      contract_value := f.contract_value; billed_pct := f.billed_pct; unbilled_value := f.unbilled_value;
      outstanding_receivable := f.outstanding_receivable; overdue_receivable := f.overdue_receivable;
    else
      revenue_invoiced := null; revenue_collected := null; other_income := null;
      direct_costs := null; labour_cost := null; net_margin := null; net_margin_pct := null;
      budget_total := null; cost_to_date := null; budget_burn_pct := null;
      contract_value := null; billed_pct := null; unbilled_value := null;
      outstanding_receivable := null; overdue_receivable := null;
    end if;
    return next;
  end loop;
end $$;

-- Who is booked where on a date, and how full they are. Every active employee
-- is listed, the unbooked with a total of zero, so under-allocation is as
-- visible as over-allocation. Only open projects count. No money.
create or replace function public.employee_allocation(p_date date default current_date, p_org uuid default null)
returns table (org_id uuid, employee_id uuid, full_name text, total_pct numeric, projects jsonb)
language sql stable security definer set search_path = public, pg_temp as $$
  select e.org_id, e.id, e.full_name,
         coalesce(sum(m.allocation_pct), 0),
         coalesce(jsonb_agg(jsonb_build_object(
                    'project_id', p.id, 'code', p.code, 'name', p.name,
                    'role', m.role, 'allocation_pct', m.allocation_pct,
                    'start_date', m.start_date, 'end_date', m.end_date)
                  order by m.allocation_pct desc) filter (where m.id is not null), '[]'::jsonb)
    from public.employees e
    left join public.project_members m
      on m.employee_id = e.id
     and m.start_date <= coalesce(p_date, current_date)
     and (m.end_date is null or m.end_date >= coalesce(p_date, current_date))
     and exists (select 1 from public.projects px
                  where px.id = m.project_id and px.archived_at is null
                    and px.status not in ('completed', 'cancelled'))
    left join public.projects p on p.id = m.project_id
   where e.exited_at is null
     and (p_org is null or e.org_id = p_org)
     and app.has_permission(e.org_id, 'project_members', 'view')
   group by e.org_id, e.id, e.full_name
$$;

revoke execute on function public.project_financials(uuid, date, date) from public, anon;
revoke execute on function public.project_portfolio(date, date, uuid) from public, anon;
revoke execute on function public.employee_allocation(date, uuid) from public, anon;
grant execute on function public.project_financials(uuid, date, date) to authenticated;
grant execute on function public.project_portfolio(date, date, uuid) to authenticated;
grant execute on function public.employee_allocation(date, uuid) to authenticated;


-- ############################################################################
-- ## 0052_project_access.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0052 — Projects: self-service reads, reopening, and the audit trail
--
-- 1. Employees. The `employee` role holds nothing on the project resources
--    (0044), and it stays that way: projects carry contract values and budgets,
--    milestones carry billing amounts, members carry allocation % and bill
--    rates. An RLS "self" policy would hand all of that over with the row. So an
--    employee reads projects through two narrow, money-free surfaces instead:
--
--      public.project_team_public_v   co-members of projects you are on —
--                                     name, role, dates. No allocation %, no
--                                     bill rate.
--      public.my_projects()           your projects, your role on each, the
--                                     manager, the upcoming milestones (title,
--                                     due, status) and your own tasks in them.
--
--    "On a project" means an active membership: not ended before today.
--
-- 2. public.reopen_project — the only way out of completed/cancelled (0045
--    refuses an ordinary status update). Owner/admin only; writes an audit row
--    carrying the reason.
--
-- 3. audit_log. 0021 lets any member read every audit row except the admin-only
--    entities. Project rows are narrower: you see a project table's history only
--    if you may view that table now, and allocation history additionally needs
--    project_financials — otherwise the Activity tab would leak the amounts the
--    allocation policies hide.
-- ─────────────────────────────────────────────────────────────────────────────

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Self-service
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function app.is_on_project(p_project uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1
      from public.project_members m
      join public.projects p on p.id = m.project_id
     where m.project_id = p_project
       and m.employee_id = app.my_employee_id(p.org_id)
       and (m.end_date is null or m.end_date >= current_date)
  )
$$;

-- A plain (definer-rights) view: it reads project_members and employees as its
-- owner, and its WHERE clause is the whole access rule. security_barrier keeps
-- a caller's own predicates from being pushed below that rule and probing rows
-- it filters out.
create or replace view public.project_team_public_v with (security_barrier = true) as
  select m.id, m.org_id, m.project_id, m.employee_id, e.full_name, m.role, m.start_date, m.end_date
    from public.project_members m
    join public.employees e on e.id = m.employee_id
   where app.has_permission(m.org_id, 'project_members', 'view')
      or app.is_on_project(m.project_id);

-- Default privileges (0022, and Supabase's own) grant every table verb on a
-- new relation in public to anon and authenticated. A view is a relation: take
-- them all back and give read only.
revoke all on public.project_team_public_v from anon, authenticated, public;
grant select on public.project_team_public_v to authenticated;
grant select on public.project_team_public_v to service_role;

create or replace function public.my_projects(p_org uuid default null)
returns table (
  project_id uuid, org_id uuid, code text, name text, client_name text,
  status public.project_status, start_date date, target_end_date date,
  my_role public.project_member_role, my_allocation_pct numeric, my_start date, my_end date,
  manager_name text, milestones jsonb, my_tasks jsonb)
language sql stable security definer set search_path = public, pg_temp as $$
  select p.id, p.org_id, p.code, p.name, c.name, p.status, p.start_date, p.target_end_date,
         m.role, m.allocation_pct, m.start_date, m.end_date,
         mgr.full_name,
         coalesce((select jsonb_agg(jsonb_build_object(
                     'id', ms.id, 'title', ms.title, 'due_date', ms.due_date, 'status', ms.status)
                     order by ms.sort_order, ms.due_date nulls last)
                     from public.project_milestones ms
                    where ms.project_id = p.id and ms.status <> 'cancelled'), '[]'::jsonb),
         coalesce((select jsonb_agg(jsonb_build_object(
                     'id', t.id, 'title', t.title, 'status', t.status, 'priority', t.priority,
                     'deadline', t.deadline, 'milestone_id', t.milestone_id)
                     order by t.deadline nulls last)
                     from public.tasks t
                    where t.project_id = p.id and t.assignee_id = m.employee_id), '[]'::jsonb)
    from public.project_members m
    join public.projects p on p.id = m.project_id
    left join public.clients c on c.id = p.client_id
    left join public.employees mgr on mgr.id = p.manager_employee_id
   where m.employee_id = app.my_employee_id(p.org_id)
     and (p_org is null or p.org_id = p_org)
     and (m.end_date is null or m.end_date >= current_date)
     and p.archived_at is null
   order by p.status, p.name
$$;

revoke execute on function public.my_projects(uuid) from public, anon;
grant execute on function public.my_projects(uuid) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Reopen
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function public.reopen_project(p_project_id uuid, p_reason text)
returns public.projects language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_p   public.projects;
  v_out public.projects;
begin
  select * into v_p from public.projects p where p.id = p_project_id for update;
  if not found or not app.is_admin(v_p.org_id) then
    raise exception 'PERMISSION_DENIED: only an owner or admin can reopen a project'
      using errcode = 'insufficient_privilege';
  end if;
  if not app.project_is_closed_status(v_p.status) then
    raise exception 'project % is not closed', v_p.code using errcode = 'check_violation';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'a reason is required to reopen a project' using errcode = 'check_violation';
  end if;

  perform set_config('app.project_reopening', 'on', true);
  perform set_config('app.project_status_reason', btrim(p_reason), true);
  update public.projects set status = 'active', actual_end_date = null
   where id = p_project_id
  returning * into v_out;
  perform set_config('app.project_reopening', '', true);
  perform set_config('app.project_status_reason', '', true);

  insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, diff)
  values (v_p.org_id, auth.uid(), 'projects.reopen', 'projects', v_p.id,
          jsonb_build_object('code', v_p.code, 'from', v_p.status, 'reason', btrim(p_reason)));
  return v_out;
end $$;

revoke execute on function public.reopen_project(uuid, text) from public, anon;
grant execute on function public.reopen_project(uuid, text) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Audit visibility
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function app.audit_entity_visible(p_org uuid, p_entity text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when p_entity in ('projects', 'project_members', 'project_milestones', 'project_documents')
      then app.has_permission(p_org, p_entity, 'view')
    when p_entity = 'project_allocations'
      then app.has_permission(p_org, 'project_allocations', 'view')
       and app.has_permission(p_org, 'project_financials', 'view')
    else true
  end
$$;

-- 0021's policy, plus the project clause. Everything else it allowed, it still
-- allows (tests/02_access_matrix.sql's audit probes do not change).
drop policy if exists audit_log_select on public.audit_log;
create policy audit_log_select on public.audit_log for select to authenticated
  using (
    app.is_admin(org_id)
    or (
      app.is_member(org_id)
      and entity_type is not null
      and not (entity_type = any(app.audit_admin_only_entities()))
      and app.audit_entity_visible(org_id, entity_type)
    )
  );


-- ############################################################################
-- ## 0053_project_health.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0053 — Projects: health
--
-- public.project_health(project) → (health, reasons[]). Closed projects have no
-- health (null). Reason codes are translated for people by
-- src/services/projectAnalytics.js formatHealthReasons().
--
--   at_risk    burn ahead of elapsed time by > 10 points  burn_ahead_of_time
--              a milestone overdue ≤ 14 days              milestone_overdue
--              any overdue invoice on the project         invoice_overdue
--              projected end after the target            projected_late
--   off_track  burn over 100% of budget                   burn_over_budget
--              a milestone overdue > 14 days              milestone_overdue_long
--              past target end and still open            past_target
--              net margin < 0 with > 50% billed           losing_money
--
-- Progress (for the projection) mirrors projectAnalytics.projectProgress: each
-- live milestone is the share of its tasks done, or 1/0 from its status when it
-- has none; with no milestones, the share of the project's tasks done.
--
-- The chip is shown to anyone who may view the project. The reasons are words,
-- never amounts, so nobody learns a figure they could not see otherwise.
--
-- project_portfolio gains health + reasons; its return type changes, so it is
-- dropped and recreated.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function app.project_progress(p_project_id uuid)
returns numeric language sql stable security definer set search_path = public, pg_temp as $$
  with ms as (
    select m.id, m.status,
           (select count(*) from public.tasks t where t.milestone_id = m.id) as n,
           (select count(*) from public.tasks t where t.milestone_id = m.id and t.status = 'done') as d
      from public.project_milestones m
     where m.project_id = p_project_id and m.status <> 'cancelled'
  )
  select case
    when exists (select 1 from ms) then
      (select avg(case when n > 0 then d::numeric / n
                       when status in ('completed', 'invoiced') then 1 else 0 end) from ms)
    else (select case when count(*) = 0 then null
                      else count(*) filter (where t.status = 'done')::numeric / count(*) end
            from public.tasks t where t.project_id = p_project_id)
  end
$$;

create or replace function app.project_health_calc(p_project_id uuid)
returns table (health text, reasons text[])
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_p        public.projects;
  f          record;
  v_reasons  text[] := '{}';
  v_off      boolean := false;
  v_time     numeric;
  v_progress numeric;
  v_proj_end date;
  v_worst    integer;
begin
  select * into v_p from public.projects p where p.id = p_project_id;
  if not found or app.project_is_closed_status(v_p.status) then return; end if;

  select * into f from app.project_financials_calc(p_project_id, null, null);

  if v_p.start_date is not null and v_p.target_end_date is not null and v_p.target_end_date > v_p.start_date then
    v_time := greatest(0, least(100,
      (current_date - v_p.start_date)::numeric / (v_p.target_end_date - v_p.start_date) * 100));
  end if;

  if f.budget_burn_pct is not null and f.budget_burn_pct > 100 then
    v_reasons := array_append(v_reasons, 'burn_over_budget'); v_off := true;
  elsif f.budget_burn_pct is not null and v_time is not null and f.budget_burn_pct - v_time > 10 then
    v_reasons := array_append(v_reasons, 'burn_ahead_of_time');
  end if;

  select max(current_date - m.due_date) into v_worst
    from public.project_milestones m
   where m.project_id = p_project_id and m.status in ('pending', 'in_progress')
     and m.due_date < current_date;
  if v_worst > 14 then v_reasons := array_append(v_reasons, 'milestone_overdue_long'); v_off := true;
  elsif v_worst > 0 then v_reasons := array_append(v_reasons, 'milestone_overdue');
  end if;

  if coalesce(f.overdue_receivable, 0) > 0 then v_reasons := array_append(v_reasons, 'invoice_overdue'); end if;

  if v_p.target_end_date is not null and v_p.target_end_date < current_date then
    v_reasons := array_append(v_reasons, 'past_target'); v_off := true;
  else
    v_progress := app.project_progress(p_project_id);
    if v_p.start_date is not null and v_p.target_end_date is not null
       and v_progress > 0 and v_progress < 1 and current_date > v_p.start_date then
      v_proj_end := v_p.start_date + round((current_date - v_p.start_date) / v_progress)::integer;
      if v_proj_end > v_p.target_end_date then v_reasons := array_append(v_reasons, 'projected_late'); end if;
    end if;
  end if;

  if coalesce(f.net_margin, 0) < 0 and coalesce(f.billed_pct, 0) > 50 then
    v_reasons := array_append(v_reasons, 'losing_money'); v_off := true;
  end if;

  health  := case when v_off then 'off_track' when cardinality(v_reasons) > 0 then 'at_risk' else 'on_track' end;
  reasons := v_reasons;
  return next;
end $$;

revoke execute on function app.project_progress(uuid) from public;
revoke execute on function app.project_health_calc(uuid) from public;

create or replace function public.project_health(p_project_id uuid)
returns table (health text, reasons text[])
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_org uuid;
begin
  select p.org_id into v_org from public.projects p where p.id = p_project_id;
  if v_org is null or not (app.has_permission(v_org, 'projects', 'view') or app.is_on_project(p_project_id)) then
    raise exception 'PERMISSION_DENIED: project health is not available to you' using errcode = 'insufficient_privilege';
  end if;
  return query select * from app.project_health_calc(p_project_id);
end $$;

revoke execute on function public.project_health(uuid) from public, anon;
grant execute on function public.project_health(uuid) to authenticated;

-- ─── Portfolio, now with health ──────────────────────────────────────────────
drop function if exists public.project_portfolio(date, date, uuid);
create function public.project_portfolio(p_from date default null, p_to date default null, p_org uuid default null)
returns table (
  project_id uuid, org_id uuid, code text, name text, client_id uuid,
  status public.project_status, archived boolean,
  milestones_total integer, milestones_done integer, open_tasks integer,
  health text, health_reasons text[],
  has_financials boolean,
  revenue_invoiced numeric, revenue_collected numeric, other_income numeric,
  direct_costs numeric, labour_cost numeric, net_margin numeric, net_margin_pct numeric,
  budget_total numeric, cost_to_date numeric, budget_burn_pct numeric,
  contract_value numeric, billed_pct numeric, unbilled_value numeric,
  outstanding_receivable numeric, overdue_receivable numeric)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  p  record;
  f  record;
  h  record;
  v_fin boolean;
begin
  for p in
    select pr.* from public.projects pr
     where (p_org is null or pr.org_id = p_org)
       and app.has_permission(pr.org_id, 'projects', 'view')
     order by pr.created_at desc
  loop
    v_fin := app.has_permission(p.org_id, 'project_financials', 'view');
    project_id := p.id; org_id := p.org_id; code := p.code; name := p.name;
    client_id := p.client_id; status := p.status; archived := p.archived_at is not null;
    select count(*)::int, count(*) filter (where m.status in ('completed', 'invoiced'))::int
      into milestones_total, milestones_done
      from public.project_milestones m where m.project_id = p.id and m.status <> 'cancelled';
    select count(*)::int into open_tasks from public.tasks t where t.project_id = p.id and t.status <> 'done';
    health := null; health_reasons := null;
    for h in select * from app.project_health_calc(p.id) loop
      health := h.health; health_reasons := h.reasons;
    end loop;
    has_financials := v_fin;
    if v_fin then
      select * into f from app.project_financials_calc(p.id, p_from, p_to);
      revenue_invoiced := f.revenue_invoiced; revenue_collected := f.revenue_collected;
      other_income := f.other_income; direct_costs := f.direct_costs; labour_cost := f.labour_cost;
      net_margin := f.net_margin; net_margin_pct := f.net_margin_pct;
      budget_total := f.budget_total; cost_to_date := f.cost_to_date; budget_burn_pct := f.budget_burn_pct;
      contract_value := f.contract_value; billed_pct := f.billed_pct; unbilled_value := f.unbilled_value;
      outstanding_receivable := f.outstanding_receivable; overdue_receivable := f.overdue_receivable;
    else
      revenue_invoiced := null; revenue_collected := null; other_income := null;
      direct_costs := null; labour_cost := null; net_margin := null; net_margin_pct := null;
      budget_total := null; cost_to_date := null; budget_burn_pct := null;
      contract_value := null; billed_pct := null; unbilled_value := null;
      outstanding_receivable := null; overdue_receivable := null;
    end if;
    return next;
  end loop;
end $$;

revoke execute on function public.project_portfolio(date, date, uuid) from public, anon;
grant execute on function public.project_portfolio(date, date, uuid) to authenticated;


-- ############################################################################
-- ## 0054_project_commercial_links.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0054 — Projects: invoices that arrive already knowing their project
--
-- Three ways an invoice can be born belonging to a project, all handled here,
-- AFTER INSERT on financial_documents, so no client path can forget them:
--
--   1. A milestone's "Create invoice". The form puts milestone_id into the
--      document's payload (unmapped keys land there, orgStore finDocToRow). The
--      milestone's invoice_id is set (0047 then moves it to `invoiced`) and the
--      invoice is allocated in full to the milestone's project. Honoured only
--      for a writer who may edit that project's milestones.
--   2. A conversion. InvoiceList stores payload.converted_from on every
--      quotation → proforma → invoice step. The chain is walked back (at most
--      three hops) to a quotation that a project was started from
--      (projects.source_quotation_id) or has linked (project_documents).
--   3. A recurring invoice. recurring_invoices.project_id (new here) is the
--      template's project; an invoice whose payload carries
--      recurring_invoice_id is allocated to it. (No generator exists in the
--      codebase yet; whichever one is written gets this for free.)
--
-- In every case: only an invoice, only when it has no allocation yet, only to
-- an open project in the same organization, and always `full`.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.recurring_invoices
  add column if not exists project_id uuid references public.projects(id) on delete set null;
create index if not exists recurring_invoices_project_idx on public.recurring_invoices (project_id) where project_id is not null;

create or replace function app.recurring_project_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.project_id is not null and not exists (
       select 1 from public.projects p where p.id = new.project_id and p.org_id = new.org_id) then
    raise exception 'project % does not belong to this organization', new.project_id using errcode = '23503';
  end if;
  return new;
end $$;

drop trigger if exists recurring_invoices_project_guard on public.recurring_invoices;
create trigger recurring_invoices_project_guard
  before insert or update of project_id on public.recurring_invoices
  for each row execute function app.recurring_project_guard();

-- The project a quotation (or anything converted from one) belongs to.
create or replace function app.project_of_document(p_doc uuid)
returns uuid language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_doc     uuid := p_doc;
  v_project uuid;
  v_hops    integer := 0;
begin
  while v_doc is not null and v_hops < 4 loop
    select p.id into v_project from public.projects p where p.source_quotation_id = v_doc limit 1;
    if v_project is null then
      select d.project_id into v_project from public.project_documents d
       where d.financial_document_id = v_doc order by d.created_at limit 1;
    end if;
    if v_project is not null then return v_project; end if;
    select nullif(f.payload ->> 'converted_from', '')::uuid into v_doc
      from public.financial_documents f where f.id = v_doc;
    v_hops := v_hops + 1;
  end loop;
  return null;
exception when invalid_text_representation then
  return null;
end $$;

create or replace function app.invoice_project_links()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_project   uuid;
  v_milestone uuid;
  v_prev      text := coalesce(current_setting('app.project_system_write', true), '');
begin
  if new.type <> 'invoice' then return null; end if;

  begin
    v_milestone := nullif(new.payload ->> 'milestone_id', '')::uuid;
  exception when invalid_text_representation then v_milestone := null;
  end;

  if v_milestone is not null then
    select m.project_id into v_project from public.project_milestones m
     where m.id = v_milestone and m.org_id = new.org_id and m.invoice_id is null;
    if v_project is not null and (auth.uid() is null or app.has_permission(new.org_id, 'project_milestones', 'edit')) then
      update public.project_milestones set invoice_id = new.id where id = v_milestone;
    else
      v_project := null;
    end if;
  end if;

  if v_project is null then
    begin
      v_project := app.project_of_document(nullif(new.payload ->> 'converted_from', '')::uuid);
    exception when invalid_text_representation then v_project := null;
    end;
  end if;

  if v_project is null and new.payload ? 'recurring_invoice_id' then
    begin
      select r.project_id into v_project from public.recurring_invoices r
       where r.id = (new.payload ->> 'recurring_invoice_id')::uuid and r.org_id = new.org_id;
    exception when invalid_text_representation then v_project := null;
    end;
  end if;

  if v_project is null
     or not exists (select 1 from public.projects p where p.id = v_project and p.org_id = new.org_id
                     and not app.project_is_closed_status(p.status))
     or exists (select 1 from public.project_allocations a where a.source_type = 'invoice' and a.source_id = new.id) then
    return null;
  end if;

  perform set_config('app.project_system_write', 'on', true);
  insert into public.project_allocations (org_id, project_id, source_type, source_id, mode, note)
  values (new.org_id, v_project, 'invoice', new.id, 'full', 'Linked automatically');
  perform set_config('app.project_system_write', v_prev, true);
  return null;
end $$;

drop trigger if exists financial_documents_project_links on public.financial_documents;
create trigger financial_documents_project_links
  after insert on public.financial_documents
  for each row execute function app.invoice_project_links();


-- ############################################################################
-- ## 0055_project_plan_limit.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0055 — Projects: the active-project quota
--
-- planConfig.js limits.activeProjects: Free 3, Pro 25, Max unlimited. An
-- "active" project is one still open (planned, active, on hold) and not
-- archived. The quota is checked whenever a project becomes active in that
-- sense — created open, reopened, or unarchived — against the plan in
-- `subscriptions` (0001), which no client can write.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function app.active_project_limit(p_org uuid)
returns integer language sql stable security definer set search_path = public, pg_temp as $$
  select case coalesce((select s.plan::text from public.subscriptions s where s.org_id = p_org), 'free')
           when 'max' then null
           when 'pro' then 25
           else 3
         end
$$;

create or replace function app.project_plan_limit_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_limit integer;
  v_count integer;
begin
  if app.project_is_closed_status(new.status) or new.archived_at is not null then return new; end if;
  if tg_op = 'UPDATE' and not app.project_is_closed_status(old.status) and old.archived_at is null then
    return new;   -- was already counted
  end if;
  v_limit := app.active_project_limit(new.org_id);
  if v_limit is null then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('project_quota:' || new.org_id::text, 0));
  select count(*) into v_count from public.projects p
   where p.org_id = new.org_id and p.id <> new.id and p.archived_at is null
     and not app.project_is_closed_status(p.status);
  if v_count >= v_limit then
    raise exception 'PLAN_LIMIT_PROJECTS: your plan allows % active projects', v_limit
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists projects_plan_limit on public.projects;
create trigger projects_plan_limit
  before insert or update of status, archived_at on public.projects
  for each row execute function app.project_plan_limit_guard();


-- ############################################################################
-- ## 0056_project_reminders.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0056 — Projects: notifications and reminders
--
-- notifications.project_id lets the bell deep-link to the project.
--
-- Sent once per threshold; what has been sent is remembered in reminder_state
-- (jsonb) on the project or milestone itself, the way follow_up_sent_at works
-- for tasks. The sweep is public.project_reminders_run(org), called by the
-- app's one scheduler (hooks/useTaskDeadlineMonitor.ts); it is idempotent, so
-- two open tabs running it cost nothing but a query.
--
--   to the manager      milestone due within 3 days       project_milestone_due
--                       milestone overdue                  project_milestone_overdue
--                       past the target end, still open    project_past_target
--   to owners/admins    budget burn crosses 80% / 100%     project_budget_80 / _100
--   to the employee     added to a project (trigger)       project_member_added
--
-- A manager with no login gets an org-wide notification instead (user_id null),
-- so the reminder is not lost.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.notifications
  add column if not exists project_id uuid references public.projects(id) on delete cascade;
create index if not exists notifications_project_idx on public.notifications (project_id) where project_id is not null;

alter table public.projects           add column if not exists reminder_state jsonb not null default '{}'::jsonb;
alter table public.project_milestones add column if not exists reminder_state jsonb not null default '{}'::jsonb;

-- The login behind an employee, or null.
create or replace function app.employee_user(p_employee uuid)
returns uuid language sql stable security definer set search_path = public, pg_temp as $$
  select e.user_id from public.employees e where e.id = p_employee and e.exited_at is null
$$;

-- ─── Added to a project ──────────────────────────────────────────────────────
create or replace function app.notify_member_added()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user uuid := app.employee_user(new.employee_id);
  v_name text;
begin
  if v_user is null then return null; end if;
  select p.name into v_name from public.projects p where p.id = new.project_id;
  insert into public.notifications (org_id, type, title, message, user_id, employee_id, project_id)
  values (new.org_id, 'project_member_added', format('You were added to %s', v_name),
          format('Role: %s · %s%% of your time from %s', new.role, round(new.allocation_pct), new.start_date),
          v_user, new.employee_id, new.project_id);
  return null;
exception when others then
  raise warning 'member-added notification failed: %', sqlerrm;
  return null;
end $$;

drop trigger if exists project_members_notify on public.project_members;
create trigger project_members_notify
  after insert on public.project_members
  for each row execute function app.notify_member_added();

-- ─── The sweep ───────────────────────────────────────────────────────────────
create or replace function public.project_reminders_run(p_org uuid)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare
  p       record;
  m       record;
  f       record;
  v_mgr   uuid;
  v_sent  integer := 0;
  v_state jsonb;
  v_prev  text := coalesce(current_setting('app.project_system_write', true), '');
begin
  if not app.is_member(p_org) then
    raise exception 'PERMISSION_DENIED' using errcode = 'insufficient_privilege';
  end if;
  perform set_config('app.project_system_write', 'on', true);

  for p in select * from public.projects
            where org_id = p_org and archived_at is null and not app.project_is_closed_status(status) loop
    v_mgr := app.employee_user(p.manager_employee_id);
    v_state := p.reminder_state;

    -- Milestones: due soon, overdue.
    for m in select * from public.project_milestones
              where project_id = p.id and status in ('pending', 'in_progress') and due_date is not null loop
      if m.due_date < current_date and not (m.reminder_state ? 'overdue') then
        insert into public.notifications (org_id, type, title, message, user_id, project_id)
        values (p_org, 'project_milestone_overdue', format('Milestone overdue: %s', m.title),
                format('%s · due %s', p.name, m.due_date), v_mgr, p.id);
        update public.project_milestones set reminder_state = reminder_state || jsonb_build_object('overdue', now())
         where id = m.id;
        v_sent := v_sent + 1;
      elsif m.due_date between current_date and current_date + 3 and not (m.reminder_state ? 'due3') then
        insert into public.notifications (org_id, type, title, message, user_id, project_id)
        values (p_org, 'project_milestone_due', format('Milestone due %s: %s', m.due_date, m.title),
                p.name, v_mgr, p.id);
        update public.project_milestones set reminder_state = reminder_state || jsonb_build_object('due3', now())
         where id = m.id;
        v_sent := v_sent + 1;
      end if;
    end loop;

    -- Past the target end.
    if p.target_end_date is not null and p.target_end_date < current_date and not (v_state ? 'past_target') then
      insert into public.notifications (org_id, type, title, message, user_id, project_id)
      values (p_org, 'project_past_target', format('%s is past its target end', p.name),
              format('Target was %s', p.target_end_date), v_mgr, p.id);
      v_state := v_state || jsonb_build_object('past_target', now());
      v_sent := v_sent + 1;
    end if;

    -- Budget burn, to owners and admins. Percentages only in the text.
    if p.budget_labour + p.budget_vendor + p.budget_other > 0 then
      select * into f from app.project_financials_calc(p.id, null, null);
      if f.budget_burn_pct >= 100 and not (v_state ? 'burn100') then
        insert into public.notifications (org_id, type, title, message, user_id, project_id)
        select p_org, 'project_budget_100', format('%s has used its whole budget', p.name),
               format('%s%% of budget used', round(f.budget_burn_pct)), mb.user_id, p.id
          from public.memberships mb where mb.org_id = p_org and mb.role in ('owner', 'admin');
        v_state := v_state || jsonb_build_object('burn100', now(), 'burn80', coalesce(v_state -> 'burn80', to_jsonb(now())));
        v_sent := v_sent + 1;
      elsif f.budget_burn_pct >= 80 and not (v_state ? 'burn80') then
        insert into public.notifications (org_id, type, title, message, user_id, project_id)
        select p_org, 'project_budget_80', format('%s has used 80%% of its budget', p.name),
               format('%s%% of budget used', round(f.budget_burn_pct)), mb.user_id, p.id
          from public.memberships mb where mb.org_id = p_org and mb.role in ('owner', 'admin');
        v_state := v_state || jsonb_build_object('burn80', now());
        v_sent := v_sent + 1;
      end if;
    end if;

    if v_state is distinct from p.reminder_state then
      update public.projects set reminder_state = v_state where id = p.id;
    end if;
  end loop;

  perform set_config('app.project_system_write', v_prev, true);
  return v_sent;
end $$;

revoke execute on function public.project_reminders_run(uuid) from public, anon;
grant execute on function public.project_reminders_run(uuid) to authenticated;

-- Reminder bookkeeping is not an edit anyone made; keep it out of audit diffs
-- (and so out of the Activity tab).
create or replace function app.audit_ignored_columns()
returns text[] language sql immutable as $$
  select array['updated_at', 'created_at', 'status_changed_at', 'reminder_state']::text[]
$$;


-- ############################################################################
-- ## 0057_employee_project_tasks.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0057 — Employees move their own project tasks
--
-- The employee role has no `tasks` access in the matrix (preflight), and gets
-- none here. my_projects() (0052) already lists their own tasks; this is the
-- one write that goes with it: the assignee changes a task's status, and
-- nothing else, on a task assigned to them.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.set_my_task_status(p_task_id uuid, p_status text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_task public.tasks;
begin
  select * into v_task from public.tasks t where t.id = p_task_id;
  if not found or v_task.assignee_id is null
     or v_task.assignee_id is distinct from app.my_employee_id(v_task.org_id) then
    raise exception 'PERMISSION_DENIED: only the assignee can move this task' using errcode = 'insufficient_privilege';
  end if;
  if p_status not in ('pending', 'in_progress', 'done') then
    raise exception 'unknown task status %', p_status using errcode = '22023';
  end if;
  update public.tasks set status = p_status::public.task_status where id = p_task_id;
end $$;

revoke execute on function public.set_my_task_status(uuid, text) from public, anon;
grant execute on function public.set_my_task_status(uuid, text) to authenticated;


-- ############################################################################
-- ## 0058_timesheets_permissions.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0058 — Timesheets: permission resource (Max plan feature)
--
--   owner, admin  everything
--   member        view / create / edit (log time, see the team's)
--   viewer        view
--   employee      nothing in the matrix; their own rows arrive through the
--                 self policies in 0059, like attendance (0029)
--
-- Approving is not a matrix verb: it is public.decide_timesheets (0059), for
-- owners/admins and the project's manager, never for your own time.
-- ─────────────────────────────────────────────────────────────────────────────

insert into public.permission_resources (key, label, category, description, actions, sort_order) values
  ('timesheets', 'Timesheets', 'Projects',
   'Hours logged against projects. Approval is by the project manager or an admin, never your own.',
   array['view','create','edit','delete'], 282)
on conflict (key) do update
  set label = excluded.label, category = excluded.category,
      description = excluded.description, actions = excluded.actions, sort_order = excluded.sort_order;

insert into public.role_permission_defaults (role, resource, can_view, can_create, can_edit, can_delete)
select r.key, 'timesheets',
       r.key in ('owner','admin','member','viewer'),
       r.key in ('owner','admin','member'),
       r.key in ('owner','admin','member'),
       r.key in ('owner','admin')
  from public.roles r
 where r.key in ('owner','admin','member','viewer','employee')
on conflict (role, resource) do nothing;

select app.sync_role_permissions(null) as rows_added;


-- ############################################################################
-- ## 0059_timesheets.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0059 — Timesheets
--
-- Minutes a person worked on a project on a day. Lifecycle:
--
--   draft ──submit──▶ submitted ──decide──▶ approved (locked) │ rejected ──▶ draft
--
--   · Employees log and edit their own drafts (self policies, as attendance).
--   · Approval is public.decide_timesheets: owners/admins, or the project's
--     manager; never your own entries (the rule leave approval follows, 0029).
--     A status of approved/rejected cannot be written any other way.
--   · An approved entry is locked; the only later change is its invoice_id,
--     set by the database when it is billed (0060).
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.timesheet_entries (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  employee_id  uuid not null references public.employees(id) on delete cascade,
  project_id   uuid not null references public.projects(id) on delete cascade,
  task_id      uuid references public.tasks(id) on delete set null,
  work_date    date not null,
  minutes      integer not null check (minutes > 0 and minutes <= 1440),
  note         text,
  billable     boolean not null default true,
  status       text not null default 'draft' check (status in ('draft', 'submitted', 'approved', 'rejected')),
  approved_by  uuid references auth.users(id) on delete set null,
  approved_at  timestamptz,
  decision_note text,
  invoice_id   uuid references public.financial_documents(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists timesheet_entries_emp_idx     on public.timesheet_entries (employee_id, work_date);
create index if not exists timesheet_entries_project_idx on public.timesheet_entries (project_id, status);
create index if not exists timesheet_entries_org_idx     on public.timesheet_entries (org_id, work_date);

create or replace function app.timesheet_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_system   boolean := app.project_system_write();
  v_deciding boolean := coalesce(current_setting('app.timesheet_deciding', true), '') = 'on';
begin
  if tg_op = 'DELETE' then
    if old.status = 'approved' and not v_system then
      raise exception 'TIMESHEET_LOCKED: approved time cannot be deleted' using errcode = 'check_violation';
    end if;
    return old;
  end if;

  if new.project_id is null or new.employee_id is null then return new; end if;
  -- Leave a caller who could not write this row anyway to RLS (see 0045).
  if app.defer_to_rls(new.org_id, 'timesheets', tg_op)
     and new.employee_id is distinct from app.my_employee_id(new.org_id) then
    return new;
  end if;
  if not exists (select 1 from public.projects p where p.id = new.project_id and p.org_id = new.org_id) then
    raise exception 'project % does not belong to this organization', new.project_id using errcode = '23503';
  end if;
  if not exists (select 1 from public.employees e where e.id = new.employee_id and e.org_id = new.org_id) then
    raise exception 'employee % does not belong to this organization', new.employee_id using errcode = '23503';
  end if;
  if new.task_id is not null and not exists (
       select 1 from public.tasks t where t.id = new.task_id and t.org_id = new.org_id
          and (t.project_id is null or t.project_id = new.project_id)) then
    raise exception 'that task belongs to a different project' using errcode = '23503';
  end if;

  if tg_op = 'INSERT' then
    if new.status not in ('draft', 'submitted') and not v_system then
      raise exception 'new time is logged as draft or submitted' using errcode = 'check_violation';
    end if;
    if not v_system then new.approved_by := null; new.approved_at := null; new.invoice_id := null; end if;
    return new;
  end if;

  -- UPDATE
  if old.status = 'approved' and not v_system then
    raise exception 'TIMESHEET_LOCKED: approved time is locked' using errcode = 'check_violation';
  end if;
  if new.status is distinct from old.status and new.status in ('approved', 'rejected') and not v_deciding then
    raise exception 'TIMESHEET_DECISION: time is approved or rejected through decide_timesheets'
      using errcode = 'insufficient_privilege';
  end if;
  if not v_deciding and not v_system then
    new.approved_by := old.approved_by; new.approved_at := old.approved_at;
    new.invoice_id := old.invoice_id; new.decision_note := old.decision_note;
  end if;
  -- Editing a rejected entry puts it back to draft.
  if old.status = 'rejected' and new.status = 'rejected' and not v_deciding then new.status := 'draft'; end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists timesheet_entries_guard on public.timesheet_entries;
create trigger timesheet_entries_guard
  before insert or update or delete on public.timesheet_entries
  for each row execute function app.timesheet_guard();
drop trigger if exists timesheet_entries_freeze_org on public.timesheet_entries;
create trigger timesheet_entries_freeze_org before update on public.timesheet_entries
  for each row execute function app.freeze_org_id();
drop trigger if exists timesheet_entries_touch on public.timesheet_entries;
create trigger timesheet_entries_touch before update on public.timesheet_entries
  for each row execute function app.touch_updated_at();
drop trigger if exists timesheet_entries_audit on public.timesheet_entries;
create trigger timesheet_entries_audit after insert or update or delete on public.timesheet_entries
  for each row execute function app.write_audit();

-- ─── Policies: the matrix, then self and manager ─────────────────────────────
select app.secure_tenant_table('public.timesheet_entries'::regclass, 'timesheets');

create policy timesheet_entries_self_select on public.timesheet_entries for select to authenticated
  using (employee_id = app.my_employee_id(org_id));
create policy timesheet_entries_self_insert on public.timesheet_entries for insert to authenticated
  with check (employee_id = app.my_employee_id(org_id) and status in ('draft', 'submitted'));
create policy timesheet_entries_self_update on public.timesheet_entries for update to authenticated
  using (employee_id = app.my_employee_id(org_id) and status in ('draft', 'submitted', 'rejected'))
  with check (employee_id = app.my_employee_id(org_id) and status in ('draft', 'submitted'));
create policy timesheet_entries_self_delete on public.timesheet_entries for delete to authenticated
  using (employee_id = app.my_employee_id(org_id) and status in ('draft', 'rejected'));
-- A project's manager sees the time logged on it, whatever their role.
create policy timesheet_entries_manager_select on public.timesheet_entries for select to authenticated
  using (exists (select 1 from public.projects p
                  where p.id = project_id and p.manager_employee_id = app.my_employee_id(org_id)));

grant select, insert, update, delete on public.timesheet_entries to authenticated;
grant all on public.timesheet_entries to service_role;

do $mig$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'timesheet_entries') then
    alter publication supabase_realtime add table public.timesheet_entries;
  end if;
end $mig$;

-- ─── Approval ────────────────────────────────────────────────────────────────
create or replace function public.decide_timesheets(p_ids uuid[], p_decision text, p_note text default null)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r    record;
  v_n  integer := 0;
  v_me uuid;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'decision must be approved or rejected' using errcode = '22023';
  end if;
  for r in
    select te.*, p.manager_employee_id
      from public.timesheet_entries te join public.projects p on p.id = te.project_id
     where te.id = any(p_ids) for update of te
  loop
    v_me := app.my_employee_id(r.org_id);
    if not (app.is_admin(r.org_id) or (v_me is not null and v_me = r.manager_employee_id)) then
      raise exception 'PERMISSION_DENIED: only the project manager or an admin approves time' using errcode = 'insufficient_privilege';
    end if;
    if v_me is not null and v_me = r.employee_id then
      raise exception 'TIMESHEET_SELF_APPROVAL: nobody approves their own time' using errcode = 'insufficient_privilege';
    end if;
    if r.status <> 'submitted' then continue; end if;
    perform set_config('app.timesheet_deciding', 'on', true);
    update public.timesheet_entries
       set status = p_decision, approved_by = auth.uid(), approved_at = now(), decision_note = nullif(btrim(p_note), '')
     where id = r.id;
    perform set_config('app.timesheet_deciding', '', true);
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

revoke execute on function public.decide_timesheets(uuid[], text, text) from public, anon;
grant execute on function public.decide_timesheets(uuid[], text, text) to authenticated;


-- ############################################################################
-- ## 0060_timesheet_costing_billing.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0060 — Timesheets: labour cost and time-and-materials billing
--
-- projects.cost_method
--   allocation (default)  labour = pay × share of time × days (0051)
--   timesheet             labour = approved minutes × hourly cost, where hourly
--                         cost = monthly pay × 12 / (52 × 40)
--
-- Billing hours: public.unbilled_hours(project) lists approved, billable,
-- not-yet-invoiced time per person at their bill rate (needs Project
-- financials — rates are commercial). The invoice form sends the entry ids in
-- the document payload (timesheet_ids); on insert the database stamps those
-- entries with the invoice and allocates the invoice to the project, so the
-- same hour is never billed twice.
--
-- public.project_hours(project): logged vs planned hours per member for the
-- Team tab. Hours only — no money.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.projects
  add column if not exists cost_method text not null default 'allocation';
do $mig$
begin
  if not exists (select 1 from pg_constraint where conname = 'projects_cost_method_check') then
    alter table public.projects add constraint projects_cost_method_check
      check (cost_method in ('allocation', 'timesheet'));
  end if;
end $mig$;

-- ─── Labour cost, either way ─────────────────────────────────────────────────
create or replace function app.project_labour_cost(p_project_id uuid, p_from date default null, p_to date default null)
returns numeric language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_method text;
begin
  select p.cost_method into v_method from public.projects p where p.id = p_project_id;

  if v_method = 'timesheet' then
    return (
      select coalesce(round(sum(
               te.minutes / 60.0 * app.monthly_pay(c.amount, c.payment_frequency, c.is_paid) * 12 / (52 * 40)), 2), 0)
        from public.timesheet_entries te
        left join public.employee_compensation c on c.employee_id = te.employee_id
       where te.project_id = p_project_id and te.status = 'approved'
         and (p_from is null or te.work_date >= p_from)
         and te.work_date <= coalesce(p_to, current_date));
  end if;

  return (
    select coalesce(round(sum(
             app.monthly_pay(c.amount, c.payment_frequency, c.is_paid) * 12 / 365
             * (w.hi - w.lo + 1) * m.allocation_pct / 100), 2), 0)
      from public.project_members m
      join public.projects  p on p.id = m.project_id
      join public.employees e on e.id = m.employee_id
      left join public.employee_compensation c on c.employee_id = e.id
     cross join lateral (
       select greatest(m.start_date, coalesce(p.start_date, m.start_date), coalesce(p_from, m.start_date)) as lo,
              least(coalesce(m.end_date, 'infinity'::date), coalesce(p.actual_end_date, 'infinity'::date),
                    coalesce(p_to, current_date),
                    coalesce((e.exited_at at time zone 'UTC')::date, 'infinity'::date)) as hi
     ) w
     where m.project_id = p_project_id and w.hi >= w.lo);
end $$;

revoke execute on function app.project_labour_cost(uuid, date, date) from public;

-- ─── Hours for the Team tab ──────────────────────────────────────────────────
-- Planned: share of a 40-hour week over the membership so far (to today).
create or replace function public.project_hours(p_project_id uuid)
returns table (employee_id uuid, planned_hours numeric, logged_hours numeric, approved_hours numeric)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_org uuid;
begin
  select p.org_id into v_org from public.projects p where p.id = p_project_id;
  if v_org is null or not app.has_permission(v_org, 'project_members', 'view') then
    raise exception 'PERMISSION_DENIED' using errcode = 'insufficient_privilege';
  end if;
  return query
  with planned as (
    select m.employee_id,
           sum(greatest(0, least(coalesce(m.end_date, current_date), current_date) - m.start_date + 1)
               / 7.0 * 40 * m.allocation_pct / 100) as h
      from public.project_members m where m.project_id = p_project_id group by m.employee_id
  ), logged as (
    select te.employee_id,
           sum(te.minutes) filter (where te.status in ('submitted', 'approved')) / 60.0 as l,
           sum(te.minutes) filter (where te.status = 'approved') / 60.0 as a
      from public.timesheet_entries te where te.project_id = p_project_id group by te.employee_id
  )
  select coalesce(pl.employee_id, lg.employee_id), round(coalesce(pl.h, 0), 1),
         round(coalesce(lg.l, 0), 1), round(coalesce(lg.a, 0), 1)
    from planned pl full join logged lg on lg.employee_id = pl.employee_id;
end $$;

revoke execute on function public.project_hours(uuid) from public, anon;
grant execute on function public.project_hours(uuid) to authenticated;

-- ─── Unbilled hours ──────────────────────────────────────────────────────────
create or replace function public.unbilled_hours(p_project_id uuid)
returns table (employee_id uuid, full_name text, hours numeric, bill_rate numeric, amount numeric, entry_ids uuid[])
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_org uuid;
begin
  select p.org_id into v_org from public.projects p where p.id = p_project_id;
  if v_org is null or not app.has_permission(v_org, 'project_financials', 'view') then
    raise exception 'PERMISSION_DENIED' using errcode = 'insufficient_privilege';
  end if;
  return query
  select te.employee_id, e.full_name, round(sum(te.minutes) / 60.0, 2),
         max(r.bill_rate), round(sum(te.minutes) / 60.0 * coalesce(max(r.bill_rate), 0), 2),
         array_agg(te.id)
    from public.timesheet_entries te
    join public.employees e on e.id = te.employee_id
    left join lateral (
      select m.bill_rate from public.project_members m
       where m.project_id = te.project_id and m.employee_id = te.employee_id and m.bill_rate is not null
       order by m.start_date desc limit 1) r on true
   where te.project_id = p_project_id and te.status = 'approved' and te.billable and te.invoice_id is null
   group by te.employee_id, e.full_name;
end $$;

revoke execute on function public.unbilled_hours(uuid) from public, anon;
grant execute on function public.unbilled_hours(uuid) to authenticated;

-- ─── Billing on invoice insert ───────────────────────────────────────────────
create or replace function app.invoice_timesheet_links()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ids     uuid[];
  v_project uuid;
  v_prev    text := coalesce(current_setting('app.project_system_write', true), '');
begin
  if new.type <> 'invoice' or not (new.payload ? 'timesheet_ids')
     or jsonb_typeof(new.payload -> 'timesheet_ids') <> 'array' then
    return null;
  end if;
  if auth.uid() is not null and not app.has_permission(new.org_id, 'project_financials', 'view') then
    return null;
  end if;
  begin
    select array_agg(x::uuid) into v_ids from jsonb_array_elements_text(new.payload -> 'timesheet_ids') x;
  exception when invalid_text_representation then return null;
  end;

  perform set_config('app.project_system_write', 'on', true);
  update public.timesheet_entries te set invoice_id = new.id
   where te.id = any(v_ids) and te.org_id = new.org_id and te.status = 'approved'
     and te.billable and te.invoice_id is null;
  select te.project_id into v_project from public.timesheet_entries te where te.invoice_id = new.id limit 1;

  if v_project is not null
     and not exists (select 1 from public.project_allocations a where a.source_type = 'invoice' and a.source_id = new.id) then
    insert into public.project_allocations (org_id, project_id, source_type, source_id, mode, note)
    values (new.org_id, v_project, 'invoice', new.id, 'full', 'Billed hours');
  end if;
  perform set_config('app.project_system_write', v_prev, true);
  return null;
end $$;

drop trigger if exists financial_documents_timesheet_links on public.financial_documents;
create trigger financial_documents_timesheet_links
  after insert on public.financial_documents
  for each row execute function app.invoice_timesheet_links();


-- ############################################################################
-- ## 0061_edgebrain_projects.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0061 — EdgeBrain learns about projects
--
-- Nodes   project (resource projects), milestone (resource project_milestones).
--         Facts and node metrics carry no money: counts, dates, status, health.
-- Edges   project → client            for_client
--         employee → project          works_on     {role}
--         task / milestone → project  part_of
--         invoice / expense / bill / income → project
--                                     allocated_to {amount, mode}, gated by
--                                     project_financials through the edge's
--                                     dst_resource
--         record / quotation → project document_of
-- Metrics project.* per project (bucket = code), resource project_financials
--         via the alias app.brain_resource_alias('project_metrics'); plus
--         projects.active and projects.at_risk counts under `projects`.
--
-- Wiring, without rewriting the sync (the pattern 0037 used for metrics):
--   app.brain_sync_ops       → renamed _core; the new one runs it, then
--                              app.brain_sync_projects
--   app.brain_rebuild_edges  → renamed _core; the new one runs it, then the
--                              project edges (the core's stale sweep has
--                              already run, so these survive it)
--   app.brain_refresh_metrics → re-defined with a projects group in its own
--                              exception block
-- brain_sync and brain_drain call those names, so projects are part of every
-- sync. The project tables get the brain_dirty_* triggers (0034) so a change
-- marks the org for the next drain.
-- ─────────────────────────────────────────────────────────────────────────────

insert into app.brain_resource_alias (wanted, instead, note)
values ('project_metrics', 'project_financials', 'Project money in EdgeBrain is gated like the project P&L.')
on conflict (wanted) do update set instead = excluded.instead, note = excluded.note;

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Nodes
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function app.brain_sync_projects(p_org uuid, p_since timestamptz default null)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare v_nodes integer := 0; v_removed integer := 0; v_n integer;
begin
  insert into public.brain_nodes
    (org_id, kind, entity_id, source_table, source_updated_at, resource, label, summary, state, facts, metrics, synced_at, deleted_at)
  select p.org_id, 'project', p.id, 'projects', p.updated_at, app.brain_resource('projects'),
         p.name,
         concat_ws(' · ', p.code, coalesce(c.name, 'internal'), p.status::text),
         p.status::text,
         jsonb_strip_nulls(jsonb_build_object(
           'code', p.code, 'name', p.name, 'client', c.name, 'status', p.status,
           'billing_type', p.billing_type, 'start_date', p.start_date,
           'target_end_date', p.target_end_date, 'actual_end_date', p.actual_end_date,
           'manager', mgr.full_name, 'tags', p.tags, 'archived_at', p.archived_at,
           'health', (select h.health from app.project_health_calc(p.id) h),
           'health_reasons', (select to_jsonb(h.reasons) from app.project_health_calc(p.id) h))),
         jsonb_build_object(
           'members', (select count(*) from public.project_members m where m.project_id = p.id
                        and (m.end_date is null or m.end_date >= current_date)),
           'open_tasks', (select count(*) from public.tasks t where t.project_id = p.id and t.status <> 'done'),
           'milestones', (select count(*) from public.project_milestones m where m.project_id = p.id and m.status <> 'cancelled'),
           'milestones_done', (select count(*) from public.project_milestones m where m.project_id = p.id
                                and m.status in ('completed', 'invoiced'))),
         now(), null
    from public.projects p
    left join public.clients c on c.id = p.client_id
    left join public.employees mgr on mgr.id = p.manager_employee_id
   where p.org_id = p_org and (p_since is null or p.updated_at > p_since)
  on conflict (org_id, kind, entity_id) do update
    set label = excluded.label, summary = excluded.summary, state = excluded.state,
        facts = excluded.facts, metrics = excluded.metrics,
        source_updated_at = excluded.source_updated_at, synced_at = now(), deleted_at = null;
  get diagnostics v_n = row_count; v_nodes := v_nodes + v_n;

  insert into public.brain_nodes
    (org_id, kind, entity_id, source_table, source_updated_at, resource, label, summary, state, facts, metrics, synced_at, deleted_at)
  select m.org_id, 'milestone', m.id, 'project_milestones', m.updated_at, app.brain_resource('project_milestones'),
         m.title, concat_ws(' · ', p.name, m.status::text, m.due_date::text), m.status::text,
         jsonb_strip_nulls(jsonb_build_object(
           'title', m.title, 'project', p.name, 'project_code', p.code, 'status', m.status,
           'due_date', m.due_date, 'billing_pct', m.billing_pct, 'completed_at', m.completed_at)),
         '{}'::jsonb, now(), null
    from public.project_milestones m join public.projects p on p.id = m.project_id
   where m.org_id = p_org and (p_since is null or m.updated_at > p_since)
  on conflict (org_id, kind, entity_id) do update
    set label = excluded.label, summary = excluded.summary, state = excluded.state,
        facts = excluded.facts, source_updated_at = excluded.source_updated_at, synced_at = now(), deleted_at = null;
  get diagnostics v_n = row_count; v_nodes := v_nodes + v_n;

  v_removed := v_removed
    + app.brain_tombstone(p_org, 'project',
        coalesce((select array_agg(id) from public.projects where org_id = p_org), '{}'::uuid[]))
    + app.brain_tombstone(p_org, 'milestone',
        coalesce((select array_agg(id) from public.project_milestones where org_id = p_org), '{}'::uuid[]));

  return jsonb_build_object('nodes', v_nodes, 'removed', v_removed);
end $$;

revoke all on function app.brain_sync_projects(uuid, timestamptz) from public;

do $mig$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'app' and p.proname = 'brain_sync_ops_core') then
    alter function app.brain_sync_ops(uuid, timestamptz) rename to brain_sync_ops_core;
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'app' and p.proname = 'brain_rebuild_edges_core') then
    alter function app.brain_rebuild_edges(uuid) rename to brain_rebuild_edges_core;
  end if;
end $mig$;

create or replace function app.brain_sync_ops(p_org uuid, p_since timestamptz default null)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare a jsonb; b jsonb;
begin
  a := app.brain_sync_ops_core(p_org, p_since);
  b := app.brain_sync_projects(p_org, p_since);
  return a || jsonb_build_object(
    'nodes',   coalesce((a->>'nodes')::int, 0) + coalesce((b->>'nodes')::int, 0),
    'removed', coalesce((a->>'removed')::int, 0) + coalesce((b->>'removed')::int, 0),
    'projects', b);
end $$;

revoke all on function app.brain_sync_ops(uuid, timestamptz) from public;

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Edges
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function app.brain_rebuild_edges(p_org uuid)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare
  v_res   jsonb;
  v_edges integer := 0;
  v_n     integer;
  v_money text := app.brain_resource('project_metrics');
begin
  v_res := app.brain_rebuild_edges_core(p_org);

  -- project → client
  insert into public.brain_edges (org_id, src_id, dst_id, rel, src_resource, dst_resource, synced_at)
  select p_org, sn.id, dn.id, 'for_client', sn.resource, dn.resource, clock_timestamp()
    from public.projects p
    join public.brain_nodes sn on sn.org_id = p_org and sn.kind = 'project' and sn.entity_id = p.id
    join public.brain_nodes dn on dn.org_id = p_org and dn.kind = 'client'  and dn.entity_id = p.client_id
   where p.org_id = p_org and p.client_id is not null
  on conflict (org_id, src_id, dst_id, rel) do update set synced_at = clock_timestamp();
  get diagnostics v_n = row_count; v_edges := v_edges + v_n;

  -- employee → project (current and past), with role
  insert into public.brain_edges (org_id, src_id, dst_id, rel, src_resource, dst_resource, facts, synced_at)
  select distinct on (sn.id, dn.id) p_org, sn.id, dn.id, 'works_on', sn.resource, app.brain_resource('project_members'),
         jsonb_strip_nulls(jsonb_build_object('role', m.role, 'since', m.start_date, 'until', m.end_date)), clock_timestamp()
    from public.project_members m
    join public.brain_nodes sn on sn.org_id = p_org and sn.kind = 'employee' and sn.entity_id = m.employee_id
    join public.brain_nodes dn on dn.org_id = p_org and dn.kind = 'project'  and dn.entity_id = m.project_id
   where m.org_id = p_org
   order by sn.id, dn.id, m.start_date desc
  on conflict (org_id, src_id, dst_id, rel) do update set facts = excluded.facts, synced_at = clock_timestamp();
  get diagnostics v_n = row_count; v_edges := v_edges + v_n;

  -- task → project, milestone → project
  insert into public.brain_edges (org_id, src_id, dst_id, rel, src_resource, dst_resource, synced_at)
  select p_org, sn.id, dn.id, 'part_of', sn.resource, dn.resource, clock_timestamp()
    from public.tasks t
    join public.brain_nodes sn on sn.org_id = p_org and sn.kind = 'task'    and sn.entity_id = t.id
    join public.brain_nodes dn on dn.org_id = p_org and dn.kind = 'project' and dn.entity_id = t.project_id
   where t.org_id = p_org and t.project_id is not null
  union all
  select p_org, sn.id, dn.id, 'part_of', sn.resource, dn.resource, clock_timestamp()
    from public.project_milestones m
    join public.brain_nodes sn on sn.org_id = p_org and sn.kind = 'milestone' and sn.entity_id = m.id
    join public.brain_nodes dn on dn.org_id = p_org and dn.kind = 'project'   and dn.entity_id = m.project_id
   where m.org_id = p_org
  on conflict (org_id, src_id, dst_id, rel) do update set synced_at = clock_timestamp();
  get diagnostics v_n = row_count; v_edges := v_edges + v_n;

  -- money → project. Gated by project_financials (dst_resource), and the
  -- amount only ever lives on the edge.
  if v_money is not null then
    insert into public.brain_edges (org_id, src_id, dst_id, rel, src_resource, dst_resource, facts, synced_at)
    select p_org, sn.id, dn.id, 'allocated_to', sn.resource, v_money,
           jsonb_strip_nulls(jsonb_build_object('mode', a.mode, 'amount', a.amount)), clock_timestamp()
      from public.project_allocations a
      join public.brain_nodes sn on sn.org_id = p_org and sn.entity_id = a.source_id
       and sn.kind = case a.source_type when 'invoice' then 'financial_document' else a.source_type::text end
      join public.brain_nodes dn on dn.org_id = p_org and dn.kind = 'project' and dn.entity_id = a.project_id
     where a.org_id = p_org
    on conflict (org_id, src_id, dst_id, rel) do update set facts = excluded.facts, synced_at = clock_timestamp();
    get diagnostics v_n = row_count; v_edges := v_edges + v_n;
  end if;

  -- record / quotation / proforma → project
  insert into public.brain_edges (org_id, src_id, dst_id, rel, src_resource, dst_resource, synced_at)
  select p_org, sn.id, dn.id, 'document_of', sn.resource, dn.resource, clock_timestamp()
    from public.project_documents d
    join public.brain_nodes sn on sn.org_id = p_org
     and ((sn.kind = 'record' and sn.entity_id = d.record_id)
       or (sn.kind = 'financial_document' and sn.entity_id = d.financial_document_id))
    join public.brain_nodes dn on dn.org_id = p_org and dn.kind = 'project' and dn.entity_id = d.project_id
   where d.org_id = p_org
  on conflict (org_id, src_id, dst_id, rel) do update set synced_at = clock_timestamp();
  get diagnostics v_n = row_count; v_edges := v_edges + v_n;

  return v_res || jsonb_build_object('edges', coalesce((v_res->>'edges')::int, 0) + v_edges, 'project_edges', v_edges);
end $$;

revoke all on function app.brain_rebuild_edges(uuid) from public;

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Metrics
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function app.brain_refresh_metrics_projects(p_org uuid)
returns integer language plpgsql set search_path = public, pg_temp as $$
declare
  p       record;
  f       record;
  v_n     integer := 0;
  v_money text := app.brain_resource('project_metrics');
  v_proj  text := app.brain_resource('projects');
begin
  if v_proj is not null then
    insert into public.brain_metrics (org_id, key, bucket, value, dims, definition, resource)
    values
      (p_org, 'projects.active', '',
       (select count(*) from public.projects where org_id = p_org and archived_at is null
          and status not in ('completed', 'cancelled')), '{}'::jsonb,
       'Open projects (planned, active, on hold), not archived.', v_proj),
      (p_org, 'projects.at_risk', '',
       (select count(*) from public.projects pr
          cross join lateral app.project_health_calc(pr.id) h
         where pr.org_id = p_org and pr.archived_at is null and h.health <> 'on_track'),
       '{}'::jsonb, 'Open projects whose health is at risk or off track.', v_proj)
    on conflict (org_id, key, bucket) do update set value = excluded.value, computed_at = now();
    v_n := v_n + 2;
  end if;

  if v_money is null then return v_n; end if;
  for p in select * from public.projects where org_id = p_org and archived_at is null loop
    select * into f from app.project_financials_calc(p.id, null, null);
    insert into public.brain_metrics (org_id, key, bucket, value, dims, definition, resource)
    select p_org, x.k, p.code, x.v, jsonb_build_object('project_id', p.id, 'name', p.name), x.d, v_money
      from (values
        ('project.contract_value',   f.contract_value,   'Contract value, before GST.'),
        ('project.revenue_invoiced', f.revenue_invoiced, 'Invoiced revenue allocated to the project, before GST.'),
        ('project.revenue_collected',f.revenue_collected,'Cash collected on the project''s invoices, before GST.'),
        ('project.direct_costs',     f.direct_costs,     'Vendor bills and expenses allocated to the project.'),
        ('project.labour_cost',      f.labour_cost,      'Pay × time on the project.'),
        ('project.net_margin',       f.net_margin,       'Revenue less direct costs and labour.'),
        ('project.net_margin_pct',   f.net_margin_pct,   'Net margin as a percentage of revenue.'),
        ('project.budget_burn_pct',  f.budget_burn_pct,  'Cost to date as a percentage of budget.'),
        ('project.billed_pct',       f.billed_pct,       'Share of the contract invoiced.')
      ) x(k, v, d)
     where x.v is not null
    on conflict (org_id, key, bucket) do update set value = excluded.value, dims = excluded.dims, computed_at = now();
  end loop;
  return v_n + (select count(*) from public.brain_metrics where org_id = p_org and key like 'project.%')::int;
end $$;

revoke all on function app.brain_refresh_metrics_projects(uuid) from public;

create or replace function app.brain_refresh_metrics(p_org uuid)
returns jsonb language plpgsql set search_path = public, pg_temp as $fn$
declare
  v_res    jsonb;
  v_n      integer := 0;
  v_failed jsonb := '[]'::jsonb;
  v_errors jsonb := '[]'::jsonb;
begin
  v_res := app.brain_refresh_metrics_core(p_org);

  begin
    v_n := v_n + app.brain_refresh_metrics_geo(p_org);
  exception when others then
    v_failed := v_failed || jsonb_build_array('geo');
    v_errors := v_errors || jsonb_build_array(jsonb_build_object('domain', 'metrics.geo', 'error', sqlerrm, 'at', now()));
  end;

  begin
    v_n := v_n + app.brain_refresh_metrics_projects(p_org);
  exception when others then
    v_failed := v_failed || jsonb_build_array('projects');
    v_errors := v_errors || jsonb_build_array(jsonb_build_object('domain', 'metrics.projects', 'error', sqlerrm, 'at', now()));
  end;

  return v_res || jsonb_build_object(
    'metrics', coalesce((v_res->>'metrics')::integer, 0) + v_n,
    'failed_groups', coalesce(v_res->'failed_groups', '[]'::jsonb) || v_failed,
    'errors', coalesce(v_res->'errors', '[]'::jsonb) || v_errors);
end $fn$;

revoke all on function app.brain_refresh_metrics(uuid) from public;

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. Dirty marking
-- ═════════════════════════════════════════════════════════════════════════════

do $mig$
declare v_t text;
begin
  foreach v_t in array array['public.projects', 'public.project_members', 'public.project_milestones',
                             'public.project_allocations', 'public.project_documents', 'public.timesheet_entries'] loop
    execute format('drop trigger if exists brain_dirty_ins on %s', v_t);
    execute format('drop trigger if exists brain_dirty_upd on %s', v_t);
    execute format('drop trigger if exists brain_dirty_del on %s', v_t);
    execute format('create trigger brain_dirty_ins after insert on %s referencing new table as changed
                      for each statement execute function app.brain_mark_dirty()', v_t);
    execute format('create trigger brain_dirty_upd after update on %s referencing new table as changed
                      for each statement execute function app.brain_mark_dirty()', v_t);
    execute format('create trigger brain_dirty_del after delete on %s referencing old table as changed
                      for each statement execute function app.brain_mark_dirty()', v_t);
  end loop;
end $mig$;


-- ############################################################################
-- ## 0062_member_permissions.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0062 — permissions per person, not only per role
--
-- Until now what someone could do was decided entirely by their role: 0026's
-- role_permissions matrix, one row per (org, role, resource). Giving one member
-- access to Expenses meant giving it to every member.
--
-- This adds an override layer on top of the matrix:
--
--   member_permissions   one row per (membership, resource) that differs from
--                        the role. The row holds all four flags, so it replaces
--                        the role's row for that resource outright — there is
--                        no mixing of "view from the role, edit from the
--                        person", and a row is coherent on its own.
--
-- app.has_permission() reads the person's row first and falls back to the
-- role's, so every configurable RLS policy (0027 onward) honours overrides
-- without being rewritten.
--
-- Rules the database enforces, whoever is writing:
--   · flags for actions a resource does not have are always false
--   · no create/edit/delete without view, where view exists
--   · an owner cannot be overridden: the owner role always holds everything
-- And for writes from the browser (authenticated), on top of RLS (admins only):
--   · nobody changes their own permissions
--   · only an owner changes what an admin may do
-- Changing someone's role clears their overrides: the new role is a fresh
-- starting point, not the old role's exceptions carried across.
--
-- Pay, banking and email credentials are not in permission_resources, so no
-- override can reach them, exactly as with the role matrix.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.member_permissions (
  org_id        uuid not null references public.organizations(id) on delete cascade,
  membership_id uuid not null references public.memberships(id)   on delete cascade,
  resource      text not null references public.permission_resources(key) on delete cascade,
  can_view      boolean not null default false,
  can_create    boolean not null default false,
  can_edit      boolean not null default false,
  can_delete    boolean not null default false,
  updated_at    timestamptz not null default now(),
  updated_by    uuid references auth.users(id) on delete set null,
  primary key (membership_id, resource)
);
comment on table public.member_permissions is
  'Per-person exceptions to role_permissions. A row replaces the role''s row for that resource; '
  'no row means the person has exactly what their role has. Read by app.has_permission().';

create index if not exists member_permissions_org_idx on public.member_permissions (org_id);

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Integrity, for every writer
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function app.check_member_permission()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_actions text[];
  v_role    text;
  v_org     uuid;
begin
  select m.role, m.org_id into v_role, v_org from public.memberships m where m.id = new.membership_id;
  -- The organization is the membership's, never whatever the writer sent. No
  -- such membership: RLS, then the foreign key, refuse the row on their own.
  if v_org is null then return new; end if;
  new.org_id := v_org;

  if v_role = 'owner' then
    raise exception 'an owner always holds every permission and cannot be given exceptions'
      using errcode = 'check_violation';
  end if;

  select pr.actions into v_actions from public.permission_resources pr where pr.key = new.resource;

  -- An action the resource does not have is never granted.
  if not ('view'   = any(v_actions)) then new.can_view   := false; end if;
  if not ('create' = any(v_actions)) then new.can_create := false; end if;
  if not ('edit'   = any(v_actions)) then new.can_edit   := false; end if;
  if not ('delete' = any(v_actions)) then new.can_delete := false; end if;

  if 'view' = any(v_actions) and not new.can_view
     and (new.can_create or new.can_edit or new.can_delete) then
    raise exception 'cannot create, edit or delete % without viewing it', new.resource
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

drop trigger if exists member_permissions_check on public.member_permissions;
create trigger member_permissions_check
  before insert or update on public.member_permissions
  for each row execute function app.check_member_permission();

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Browser writes: who may change whose permissions
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function app.member_permissions_client_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_target  uuid := coalesce(new.membership_id, old.membership_id);
  v_role    text;
  v_user    uuid;
  v_org     uuid;
begin
  select m.role, m.user_id, m.org_id into v_role, v_user, v_org
    from public.memberships m where m.id = v_target;

  if tg_op = 'UPDATE' and (new.membership_id <> old.membership_id or new.resource <> old.resource) then
    raise exception 'an exception cannot be moved to another person or resource' using errcode = 'insufficient_privilege';
  end if;

  -- Otherwise an admin could grant themselves whatever the admin role lacks.
  if v_user = auth.uid() then
    raise exception 'you cannot change your own permissions' using errcode = 'insufficient_privilege';
  end if;

  if v_role = 'admin' and not app.is_owner(v_org) then
    raise exception 'only an owner can change what an admin may do' using errcode = 'insufficient_privilege';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;

drop trigger if exists member_permissions_client_guard on public.member_permissions;
create trigger member_permissions_client_guard
  before insert or update or delete on public.member_permissions
  for each row
  when (current_user in ('authenticated', 'anon'))
  execute function app.member_permissions_client_guard();

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. A role change is a fresh start
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function app.clear_member_permissions_on_role_change()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from public.member_permissions where membership_id = new.id;
  return null;
end $$;

drop trigger if exists memberships_clear_overrides on public.memberships;
create trigger memberships_clear_overrides
  after update of role on public.memberships
  for each row when (old.role is distinct from new.role)
  execute function app.clear_member_permissions_on_role_change();

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. Activity log
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function app.audit_member_permissions()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r public.member_permissions := coalesce(new, old);
begin
  if tg_op = 'UPDATE' and (old.can_view, old.can_create, old.can_edit, old.can_delete)
     is not distinct from (new.can_view, new.can_create, new.can_edit, new.can_delete) then
    return null;
  end if;
  -- The organization itself is being deleted and this row goes with it.
  if not exists (select 1 from public.organizations o where o.id = r.org_id) then
    return null;
  end if;
  insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, diff)
  values (r.org_id, auth.uid(),
          'member_permissions.' || lower(tg_op), 'memberships', r.membership_id,
          jsonb_build_object(
            'resource', r.resource,
            'from', case when tg_op = 'INSERT' then null else jsonb_build_object(
                      'view', old.can_view, 'create', old.can_create, 'edit', old.can_edit, 'delete', old.can_delete) end,
            'to',   case when tg_op = 'DELETE' then null else jsonb_build_object(
                      'view', new.can_view, 'create', new.can_create, 'edit', new.can_edit, 'delete', new.can_delete) end));
  return null;
end $$;

drop trigger if exists member_permissions_audit on public.member_permissions;
create trigger member_permissions_audit
  after insert or update or delete on public.member_permissions
  for each row execute function app.audit_member_permissions();

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. The check every configurable policy calls, now person-aware
-- ═════════════════════════════════════════════════════════════════════════════

-- Same contract as 0026: true iff the caller is a member of p_org and holds
-- p_action on p_resource; false on every unknown. The person's row, when there
-- is one, replaces the role's row whole.
create or replace function app.has_permission(p_org uuid, p_resource text, p_action text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select case p_action
             when 'view'   then coalesce(mp.can_view,   rp.can_view)
             when 'create' then coalesce(mp.can_create, rp.can_create)
             when 'edit'   then coalesce(mp.can_edit,   rp.can_edit)
             when 'delete' then coalesce(mp.can_delete, rp.can_delete)
           end
      from public.memberships m
      left join public.member_permissions mp
        on mp.membership_id = m.id and mp.resource = p_resource
      left join public.role_permissions rp
        on rp.org_id = m.org_id and rp.role = m.role and rp.resource = p_resource
     where m.org_id = p_org
       and m.user_id = auth.uid()
  ), false);
$$;

-- What one person may do, resource by resource, with which rows are their own.
create or replace function app.effective_permissions(p_org uuid, p_user uuid)
returns table (resource text, can_view boolean, can_create boolean, can_edit boolean, can_delete boolean, custom boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select pr.key,
         coalesce(mp.can_view,   rp.can_view,   false),
         coalesce(mp.can_create, rp.can_create, false),
         coalesce(mp.can_edit,   rp.can_edit,   false),
         coalesce(mp.can_delete, rp.can_delete, false),
         mp.membership_id is not null
    from public.memberships m
    cross join public.permission_resources pr
    left join public.role_permissions rp
      on rp.org_id = m.org_id and rp.role = m.role and rp.resource = pr.key
    left join public.member_permissions mp
      on mp.membership_id = m.id and mp.resource = pr.key
   where m.org_id = p_org and m.user_id = p_user
     and (rp.resource is not null or mp.resource is not null);
$$;
revoke execute on function app.effective_permissions(uuid, uuid) from public;

-- The caller's own permissions, for the app to decide what to show.
create or replace function public.my_permissions(p_org uuid)
returns table (resource text, can_view boolean, can_create boolean, can_edit boolean, can_delete boolean, custom boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select * from app.effective_permissions(p_org, auth.uid());
$$;
revoke execute on function public.my_permissions(uuid) from public, anon;
grant  execute on function public.my_permissions(uuid) to authenticated;

-- Any user's permissions, for server code that already verified who is asking.
create or replace function public.user_permissions(p_org uuid, p_user uuid)
returns table (resource text, can_view boolean, can_create boolean, can_edit boolean, can_delete boolean, custom boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select * from app.effective_permissions(p_org, p_user);
$$;
revoke execute on function public.user_permissions(uuid, uuid) from public, anon, authenticated;
grant  execute on function public.user_permissions(uuid, uuid) to service_role;

-- ═════════════════════════════════════════════════════════════════════════════
-- 6. RLS and grants
-- ═════════════════════════════════════════════════════════════════════════════

alter table public.member_permissions enable row level security;
alter table public.member_permissions force  row level security;

-- Read: whoever may see team access, and each person their own exceptions.
-- Write: owner or admin, hardcoded for the same reason as role_permissions —
-- if editing permissions were itself a permission, it could grant itself.
drop policy if exists member_permissions_select on public.member_permissions;
create policy member_permissions_select on public.member_permissions
  for select to authenticated using (
    app.is_member(org_id) and (
      app.has_permission(org_id, 'memberships', 'view')
      or exists (select 1 from public.memberships m where m.id = membership_id and m.user_id = auth.uid())));

drop policy if exists member_permissions_insert on public.member_permissions;
create policy member_permissions_insert on public.member_permissions
  for insert to authenticated with check (app.is_admin(org_id));

drop policy if exists member_permissions_update on public.member_permissions;
create policy member_permissions_update on public.member_permissions
  for update to authenticated using (app.is_admin(org_id)) with check (app.is_admin(org_id));

drop policy if exists member_permissions_delete on public.member_permissions;
create policy member_permissions_delete on public.member_permissions
  for delete to authenticated using (app.is_admin(org_id));

revoke all on public.member_permissions from anon;
revoke all on public.member_permissions from authenticated;
grant select, insert, delete on public.member_permissions to authenticated;
grant update (can_view, can_create, can_edit, can_delete) on public.member_permissions to authenticated;


-- ############################################################################
-- ## 0063_document_library.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0063 — General document library (Documents → General Documents)
--
-- Any file the company wants to keep: PDFs, decks, spreadsheets, text, images.
-- The file itself lives in the private `library` bucket. What it SAYS is read
-- server-side by /api/library and stored twice, for two different readers:
--
--   library_documents.content_md   the whole document as one Markdown file —
--                                  what a person views or downloads, and the
--                                  unit that is re-extracted when a file is
--                                  replaced. One Markdown per document, never
--                                  one file for the whole library: a document
--                                  can then be re-read, deleted or permission-
--                                  checked on its own, and retrieval never has
--                                  to parse a monolith to find one passage.
--   library_chunks                 the same Markdown cut into passages of about
--                                  a page, each with the heading it sits under
--                                  (page / slide / sheet / section), and a
--                                  full-text index. This is what the AI reads:
--                                  the few passages a question matches, with
--                                  the file and page they came from.
--
-- EdgeBrain gets one node per document (kind `library_document`), so the
-- library appears in the graph and — more importantly — in INVENTORY, the
-- counts that stop the assistant from claiming a document does not exist.
--
-- Permissions: one resource, `library_documents`, gates the table, the chunks,
-- the bucket and the brain nodes alike.
--   owner, admin   everything
--   member         view, upload, edit details
--   viewer         view
-- ─────────────────────────────────────────────────────────────────────────────

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Tables
-- ═════════════════════════════════════════════════════════════════════════════

create table if not exists public.library_documents (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations(id) on delete cascade,
  title              text not null check (length(btrim(title)) between 1 and 200),
  description        text check (description is null or length(description) <= 2000),
  category           text not null default 'general' check (category ~ '^[a-z][a-z0-9_]{1,30}$'),
  tags               text[] not null default '{}',

  file_name          text not null check (length(file_name) between 1 and 255),
  mime_type          text not null default 'application/octet-stream',
  size_bytes         bigint not null check (size_bytes > 0),
  -- '<org_id>/<uuid>.<ext>' — the layout app.storage_org() reads.
  storage_path       text not null unique,

  -- pending → processing → ready | partial | failed | unsupported
  extraction_status  text not null default 'pending'
                       check (extraction_status in ('pending','processing','ready','partial','failed','unsupported')),
  extraction_method  text,
  extraction_error   text,
  content_md         text,
  summary            text,
  page_count         integer,
  char_count         integer,
  chunk_count        integer not null default 0,
  extracted_at       timestamptz,

  created_by         uuid references auth.users(id) on delete set null default auth.uid(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists library_documents_org_idx
  on public.library_documents (org_id, created_at desc);

create table if not exists public.library_chunks (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  document_id  uuid not null references public.library_documents(id) on delete cascade,
  seq          integer not null check (seq >= 0),
  heading      text,
  content      text not null,
  -- `simple`, like brain_nodes.search_text: no stemming, so a company's own
  -- vocabulary — product names, clause numbers, codes — matches as written.
  search_text  tsvector generated always as (
                 to_tsvector('simple'::regconfig, coalesce(heading, '') || ' ' || content)
               ) stored,
  created_at   timestamptz not null default now(),
  unique (document_id, seq)
);

create index if not exists library_chunks_search_idx on public.library_chunks using gin (search_text);
create index if not exists library_chunks_org_idx    on public.library_chunks (org_id, document_id);

drop trigger if exists library_documents_touch on public.library_documents;
create trigger library_documents_touch before update on public.library_documents
  for each row execute function app.touch_updated_at();

-- The org on a chunk is the org of its document, whoever writes it.
create or replace function app.library_chunk_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  select d.org_id into new.org_id from public.library_documents d where d.id = new.document_id;
  if new.org_id is null then
    raise exception 'library document % does not exist', new.document_id using errcode = '23503';
  end if;
  return new;
end $$;

drop trigger if exists library_chunks_guard on public.library_chunks;
create trigger library_chunks_guard before insert or update on public.library_chunks
  for each row execute function app.library_chunk_guard();

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Permissions — idempotent, with an explicit fan-out (see 0039)
-- ═════════════════════════════════════════════════════════════════════════════

insert into public.permission_resources (key, label, category, description, actions, sort_order) values
  ('library_documents', 'General documents', 'Documents',
   'The document library: any file the company stores, and the text EdgeBrain reads out of it.',
   array['view','create','edit','delete'], 335)
on conflict (key) do update
  set label = excluded.label, category = excluded.category,
      description = excluded.description, actions = excluded.actions, sort_order = excluded.sort_order;

insert into public.role_permission_defaults (role, resource, can_view, can_create, can_edit, can_delete)
select r.key, 'library_documents',
       r.key in ('owner','admin','member','viewer'),
       r.key in ('owner','admin','member'),
       r.key in ('owner','admin','member'),
       r.key in ('owner','admin')
  from public.roles r
 where r.key in ('owner','admin','member','viewer','employee')
on conflict (role, resource) do nothing;

select app.sync_role_permissions(null) as rows_added;

select app.secure_tenant_table('public.library_documents'::regclass, 'library_documents');
select app.secure_tenant_table('public.library_chunks'::regclass,    'library_documents');

grant select, insert, update, delete on public.library_documents to authenticated;
-- Chunks are written only by the extractor, which runs as the service role.
-- Members may read them (in-document search), never forge them. The revoke is
-- explicit because 0022's default privileges already granted everything.
revoke insert, update, delete, truncate on public.library_chunks from authenticated;
grant select on public.library_chunks to authenticated;
grant all on public.library_documents, public.library_chunks to service_role;

create trigger library_documents_audit after insert or update of title, description, category, tags, storage_path
  or delete on public.library_documents
  for each row execute function app.write_audit();

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Bucket — private, 25 MB, any type
-- ─────────────────────────────────────────────────────────────────────────────
-- No MIME allow-list on purpose: the library is for "whatever the company has".
-- Files are only ever served through five-minute signed URLs from the storage
-- origin, never inlined into the app.
-- ═════════════════════════════════════════════════════════════════════════════

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('library', 'library', false, 26214400, null)
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = null;

drop policy if exists library_select on storage.objects;
drop policy if exists library_insert on storage.objects;
drop policy if exists library_delete on storage.objects;

create policy library_select on storage.objects for select to authenticated
  using (bucket_id = 'library'
         and app.has_permission(app.storage_org(name), 'library_documents', 'view'));
create policy library_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'library'
              and app.has_permission(app.storage_org(name), 'library_documents', 'create'));
create policy library_delete on storage.objects for delete to authenticated
  using (bucket_id = 'library'
         and app.has_permission(app.storage_org(name), 'library_documents', 'delete'));

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. Ranked passage search (server only)
-- ─────────────────────────────────────────────────────────────────────────────
-- PostgREST's textSearch filters but cannot rank, and an OR-query over a few
-- question words without a rank returns whichever passages Postgres met first.
-- The caller is /api/_lib/brainRetrieval.js on the service role, which has
-- already checked library_documents:view for this user.
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function public.library_search(p_org uuid, p_query text, p_limit integer default 8)
returns table (
  chunk_id uuid, document_id uuid, seq integer, heading text, content text, rank real,
  title text, file_name text, category text, extracted_at timestamptz
)
language sql stable set search_path = public, pg_temp as $$
  with q as (select to_tsquery('simple'::regconfig, p_query) as tsq)
  select c.id, c.document_id, c.seq, c.heading, c.content,
         ts_rank_cd(c.search_text, q.tsq, 32) as rank,
         d.title, d.file_name, d.category, d.extracted_at
    from public.library_chunks c
    join public.library_documents d on d.id = c.document_id
    cross join q
   where c.org_id = p_org and d.org_id = p_org
     and c.search_text @@ q.tsq
   order by rank desc, c.seq
   limit least(greatest(coalesce(p_limit, 8), 1), 40)
$$;

revoke all on function public.library_search(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.library_search(uuid, text, integer) to service_role;

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. EdgeBrain — one node per document
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function app.brain_sync_library(p_org uuid, p_since timestamptz default null)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare
  v_res   text := app.brain_resource('library_documents');
  v_nodes integer := 0;
  v_removed integer := 0;
begin
  -- Fail closed: an unresolved resource key means no gate, so no nodes.
  if v_res is null then
    return jsonb_build_object('nodes', 0, 'removed', 0, 'skipped', 'library_documents resource missing');
  end if;

  insert into public.brain_nodes
    (org_id, kind, entity_id, source_table, source_updated_at, resource, label, summary, state, facts, metrics, synced_at, deleted_at)
  select d.org_id, 'library_document', d.id, 'library_documents', d.updated_at, v_res,
         d.title,
         concat_ws(' · ', d.category, d.file_name, left(coalesce(d.summary, d.description), 400)),
         d.extraction_status,
         jsonb_strip_nulls(jsonb_build_object(
           'title', d.title, 'name', d.file_name, 'type', d.mime_type, 'category', d.category,
           'tags', case when cardinality(d.tags) > 0 then array_to_string(d.tags, ', ') end,
           'description', d.description, 'summary', left(d.summary, 600),
           'pages', d.page_count, 'status', d.extraction_status,
           'size_kb', round(d.size_bytes / 1024.0), 'created_at', d.created_at,
           'extracted_at', d.extracted_at)),
         jsonb_build_object('passages', d.chunk_count, 'characters', coalesce(d.char_count, 0)),
         now(), null
    from public.library_documents d
   where d.org_id = p_org and (p_since is null or d.updated_at > p_since)
  on conflict (org_id, kind, entity_id) do update
    set label = excluded.label, summary = excluded.summary, state = excluded.state,
        facts = excluded.facts, metrics = excluded.metrics, resource = excluded.resource,
        source_updated_at = excluded.source_updated_at, synced_at = now(), deleted_at = null;
  get diagnostics v_nodes = row_count;

  v_removed := app.brain_tombstone(p_org, 'library_document',
    coalesce((select array_agg(id) from public.library_documents where org_id = p_org), '{}'::uuid[]));

  return jsonb_build_object('nodes', v_nodes, 'removed', v_removed);
end $$;

revoke all on function app.brain_sync_library(uuid, timestamptz) from public;

-- 0061's wrapper, with the library added. brain_sync and brain_drain call this
-- name, so documents are part of every sync. Each domain in its own block, so
-- a library failure narrows the brain instead of failing the run.
create or replace function app.brain_sync_ops(p_org uuid, p_since timestamptz default null)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare a jsonb; b jsonb; c jsonb;
begin
  a := app.brain_sync_ops_core(p_org, p_since);
  b := app.brain_sync_projects(p_org, p_since);
  begin
    c := app.brain_sync_library(p_org, p_since);
  exception when others then
    c := jsonb_build_object('nodes', 0, 'removed', 0, 'error', sqlerrm);
  end;
  return a || jsonb_build_object(
    'nodes',   coalesce((a->>'nodes')::int, 0) + coalesce((b->>'nodes')::int, 0) + coalesce((c->>'nodes')::int, 0),
    'removed', coalesce((a->>'removed')::int, 0) + coalesce((b->>'removed')::int, 0) + coalesce((c->>'removed')::int, 0),
    'projects', b,
    'library', c);
end $$;

revoke all on function app.brain_sync_ops(uuid, timestamptz) from public;

do $mig$
begin
  execute 'drop trigger if exists brain_dirty_ins on public.library_documents';
  execute 'drop trigger if exists brain_dirty_upd on public.library_documents';
  execute 'drop trigger if exists brain_dirty_del on public.library_documents';
  execute 'create trigger brain_dirty_ins after insert on public.library_documents referencing new table as changed
             for each statement execute function app.brain_mark_dirty()';
  execute 'create trigger brain_dirty_upd after update on public.library_documents referencing new table as changed
             for each statement execute function app.brain_mark_dirty()';
  execute 'create trigger brain_dirty_del after delete on public.library_documents referencing old table as changed
             for each statement execute function app.brain_mark_dirty()';
end $mig$;


-- ############################################################################
-- ## 0064_document_versions.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0064 — Document versions and client negotiation
--
-- Quotations, proformas (until an advance is paid), offer letters, NDAs and
-- MoUs become versioned documents. Invoices are deliberately NOT: an invoice is
-- corrected with a credit note, never re-issued in place.
--
--   document_versions            an immutable snapshot of what the recipient was
--                                shown: parties, line items, totals, terms and
--                                clauses, with a sha-256 content_hash.
--   document_negotiation_events  the thread: comments, change requests (pinned
--                                to a line item or clause), counter proposals,
--                                and the system's own entries — published,
--                                accepted, locked, reopened.
--   <parent>.current_version_id  the version the recipient sees.
--   <parent>.locked_version_id   the version that was accepted or signed. Once
--                                set, the document's content cannot change.
--
-- The lifecycle, enforced here rather than trusted to the app:
--
--   draft      never sent: edited in place, no versions.
--   published  current_version_id is set. The first version is taken
--              automatically when a portal link is issued or the status leaves
--              draft. From then on content changes ONLY through
--              public.document_publish_version(), which applies the edit and
--              snapshots version N+1 in one transaction. Any other write that
--              changes content is refused (DOCUMENT_VERSIONED).
--   locked     locked_version_id is set, automatically when the status becomes
--              accepted / signed / fully signed / order confirmed / converted /
--              paid, or when a proforma takes money. Every content write is
--              refused (DOCUMENT_LOCKED), including publish. Status still moves
--              (converted, paid) — that is the life of the deal, not an edit.
--   reopen     public.document_reopen(), owner/admin only, with a reason,
--              written to audit_log. Refused once a proforma holds money or a
--              document has been converted: something downstream already
--              depends on the locked version.
--
-- "Content" is the snapshot, not the row. Status, payment fields, view stamps,
-- the portal's response fields (accepted_by, revision_notes, …) and the
-- signature blocks the signer fills in are not content, so the portal and the
-- payment triggers keep working on a locked document.
--
-- Written against the live schema (supabase/checks/versioning_preflight.sql,
-- result01.md), which differs from the repo in ways this file avoids:
--   · pgcrypto lives in `extensions` on live, `public` locally — hashing uses
--     the built-in sha256() instead of digest().
--   · live has no app.defer_to_rls() (its project guards use a different
--     helper) — the RLS deferral here is written inline.
-- ─────────────────────────────────────────────────────────────────────────────

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Tables
-- ═════════════════════════════════════════════════════════════════════════════

create table if not exists public.document_versions (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references public.organizations(id) on delete cascade,
  financial_document_id  uuid references public.financial_documents(id) on delete cascade,
  record_id              uuid references public.records(id) on delete cascade,
  version_no             integer not null check (version_no >= 1),
  payload                jsonb not null,
  change_summary         text check (change_summary is null or length(change_summary) <= 2000),
  -- Who published it. created_by_type says what kind of actor: a member of the
  -- org, the recipient (reserved: recipients propose, they do not publish), or
  -- the database itself (the automatic first version, the backfill).
  created_by             uuid references auth.users(id) on delete set null,
  created_by_type        text not null default 'member'
                           check (created_by_type in ('member', 'recipient', 'system')),
  created_at             timestamptz not null default now(),
  content_hash           text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint document_versions_one_target check (num_nonnulls(financial_document_id, record_id) = 1)
);

create unique index if not exists document_versions_findoc_no
  on public.document_versions (financial_document_id, version_no) where financial_document_id is not null;
create unique index if not exists document_versions_record_no
  on public.document_versions (record_id, version_no) where record_id is not null;
create index if not exists document_versions_org_idx
  on public.document_versions (org_id, created_at desc);

alter table public.financial_documents
  add column if not exists current_version_id uuid references public.document_versions(id) on delete set null,
  add column if not exists locked_version_id  uuid references public.document_versions(id) on delete set null;
alter table public.records
  add column if not exists current_version_id uuid references public.document_versions(id) on delete set null,
  add column if not exists locked_version_id  uuid references public.document_versions(id) on delete set null;

-- A signature is evidence about one exact text. It names the version and
-- carries that version's hash, so "what did they sign" survives any reopen.
alter table public.document_signatures
  add column if not exists version_id   uuid references public.document_versions(id) on delete cascade,
  add column if not exists content_hash text;

create table if not exists public.document_negotiation_events (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references public.organizations(id) on delete cascade,
  financial_document_id  uuid references public.financial_documents(id) on delete cascade,
  record_id              uuid references public.records(id) on delete cascade,
  version_id             uuid not null references public.document_versions(id) on delete cascade,
  kind                   text not null check (kind in (
                           'comment', 'change_request', 'counter_proposal',
                           'version_published', 'accepted', 'locked', 'reopened')),
  actor_type             text not null check (actor_type in ('member', 'recipient', 'system')),
  actor_id               uuid references auth.users(id) on delete set null,
  actor_name             text check (actor_name is null or length(actor_name) <= 200),
  actor_email            citext,
  body                   text check (body is null or length(body) <= 5000),
  -- What a change request or counter proposal is about:
  --   {"type":"line_item","position":2,"description":"Design"}
  --   {"type":"clause","key":"confidentiality","label":"3. Confidentiality"}
  --   {"type":"field","key":"valid_until"}
  target                 jsonb check (target is null or (jsonb_typeof(target) = 'object'
                                      and target ->> 'type' in ('line_item', 'clause', 'field'))),
  -- A counter proposal's numbers or text: {"rate":45000,"quantity":1} or {"text":"…"}.
  proposal               jsonb check (proposal is null or jsonb_typeof(proposal) = 'object'),
  -- System entries' detail: version_no, the requests a version resolves, reasons.
  meta                   jsonb not null default '{}'::jsonb,
  reply_to_id            uuid references public.document_negotiation_events(id) on delete cascade,
  portal_token_jti       uuid references public.portal_tokens(jti) on delete set null,
  created_at             timestamptz not null default now(),
  constraint negotiation_events_one_target check (num_nonnulls(financial_document_id, record_id) = 1)
);

create index if not exists negotiation_events_findoc_idx
  on public.document_negotiation_events (financial_document_id, created_at) where financial_document_id is not null;
create index if not exists negotiation_events_record_idx
  on public.document_negotiation_events (record_id, created_at) where record_id is not null;
create index if not exists negotiation_events_version_idx
  on public.document_negotiation_events (version_id);
create index if not exists negotiation_events_org_idx
  on public.document_negotiation_events (org_id, created_at desc);

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Helpers: scope, context flags, snapshots, hashing
-- ═════════════════════════════════════════════════════════════════════════════

-- 'financial' | 'record' — which parent table a document lives in.
create or replace function app.doc_versionable(p_kind text, p_type public.doc_type)
returns boolean language sql immutable as $$
  select case p_kind
           when 'financial' then p_type::text in ('quotation', 'proforma')
           when 'record'    then p_type::text in ('offer', 'nda', 'mou')
           else false end
$$;

-- Writes the database makes on its own behalf (setting the version pointers,
-- the automatic first version, locks) and the document currently being
-- published. Transaction-local and only ever set from SECURITY DEFINER code: a
-- client cannot call set_config through PostgREST.
create or replace function app.doc_system_write()
returns boolean language sql stable as $$
  select coalesce(current_setting('app.doc_system_write', true), '') = 'on'
$$;

create or replace function app.doc_publishing()
returns text language sql stable as $$
  select coalesce(current_setting('app.doc_publishing', true), '')
$$;

-- Keys the portal and the app write into records.data / financial_documents.payload
-- that record what HAPPENED to a document, not what it SAYS. They are left out
-- of every snapshot, so viewing, reminding, verifying a payment or responding
-- never counts as an edit.
create or replace function app.doc_response_keys()
returns text[] language sql immutable as $$
  select array[
    'first_viewed_at', 'last_viewed_at', 'responded_at', 'sent_at',
    'accepted_by', 'accepted_at', 'signed_at', 'candidate_name', 'candidate_signature',
    'signature_path', 'signature_method', 'decline_reason', 'revision_notes',
    'payment_confirmation', 'verified_at', 'payment_rejected', 'rejection_reason',
    'acknowledged_by', 'acknowledged_at', 'employee_synced',
    'reminder_count', 'last_reminder_at',
    'converted_from', 'converted_from_version_id', 'converted_to',
    -- App-side echoes of the columns, in case a cached object is spread back.
    'current_version_id', 'locked_version_id', 'version_no', 'versions'
  ]::text[]
$$;

-- The object restricted to the given keys.
create or replace function app.jsonb_pick(p_obj jsonb, p_keys text[])
returns jsonb language sql immutable as $$
  select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
    from jsonb_each(coalesce(p_obj, '{}'::jsonb)) e
   where e.key = any(p_keys)
$$;

create or replace function app.doc_hash(p_payload jsonb)
returns text language sql immutable as $$
  -- jsonb's text form is canonical (keys ordered, whitespace fixed), so equal
  -- content always hashes equal. sha256() is core Postgres (11+).
  select encode(sha256(convert_to(p_payload::text, 'UTF8')), 'hex')
$$;

-- Line items as they appear in a snapshot. No row ids: replacing the items
-- with identical ones must hash identically.
create or replace function app.fin_doc_items(p_doc uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'position', li.position, 'description', li.description, 'hsn_sac', li.hsn_sac,
           'quantity', li.quantity, 'unit', li.unit, 'rate', li.rate, 'gst_rate', li.gst_rate,
           'line_total', li.line_total, 'catalog_item_id', li.catalog_item_id)
         order by li.position), '[]'::jsonb)
    from public.document_line_items li
   where li.document_id = p_doc
$$;

-- The snapshot builders. Mirror src/services/versioning.js
-- (buildFinancialSnapshot / buildRecordSnapshot); the Vitest suite pins the
-- shape both sides agree on.
create or replace function app.fin_doc_snapshot(f public.financial_documents, p_items jsonb)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'schema', 1, 'kind', 'financial', 'type', f.type, 'doc_number', f.doc_number,
    'currency', f.currency,
    'issue_date', f.issue_date, 'due_date', f.due_date, 'valid_until', f.valid_until,
    'parties', jsonb_build_object(
      'issuer', coalesce(f.company_snapshot, '{}'::jsonb),
      'recipient', jsonb_build_object(
        'customer_id', f.customer_id, 'name', f.bill_to_name, 'email', f.bill_to_email,
        'address', f.bill_to_address, 'gstin', f.bill_to_gstin, 'state', f.bill_to_state)),
    'pricing', jsonb_build_object(
      'discount_type', f.discount_type, 'discount_value', f.discount_value,
      'gst_enabled', f.gst_enabled, 'gst_rate', f.gst_rate, 'is_inter_state', f.is_inter_state,
      'making_charges', f.making_charges, 'advance_percent', f.advance_percent),
    'totals', jsonb_build_object(
      'subtotal', f.subtotal, 'discount_amount', f.discount_amount,
      'taxable_amount', f.taxable_amount, 'gst_amount', f.gst_amount,
      'grand_total', f.grand_total, 'amount_in_words', f.amount_in_words),
    'line_items', coalesce(p_items, '[]'::jsonb),
    'terms', f.terms, 'notes', f.notes, 'payment_instructions', f.payment_instructions,
    'extra', coalesce(f.payload, '{}'::jsonb) - app.doc_response_keys())
$$;

-- The recipient falls back into data exactly as orgStore's records.fromRow
-- does, so the app's whole-row status updates (which fill recipient_name from
-- data.studentName on their first round trip) never read as a content change.
create or replace function app.record_snapshot(r public.records)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'schema', 1, 'kind', 'record', 'type', r.type, 'doc_number', r.doc_number,
    'title', r.title, 'issue_date', r.issue_date,
    'parties', jsonb_build_object(
      'issuer', coalesce(r.company_snapshot, '{}'::jsonb),
      'recipient', jsonb_build_object(
        'name',  coalesce(nullif(r.recipient_name, ''), r.data ->> 'studentName',
                          r.data ->> 'recipientName', r.data ->> 'name'),
        'email', coalesce(nullif(r.recipient_email::text, ''), r.data ->> 'email'))),
    'body', coalesce(r.data, '{}'::jsonb) - app.doc_response_keys())
$$;

-- What the edit guard compares: the snapshot minus what follows from other
-- content (totals, which follow the line items; the line items themselves,
-- which have their own guard) and minus the signature blocks a signer fills in
-- when they sign an MoU.
create or replace function app.doc_guard_view(p_snapshot jsonb)
returns jsonb language sql immutable as $$
  select (p_snapshot - 'totals' - 'line_items')
    #- '{body,party_a,signed_at}' #- '{body,party_a,signature}' #- '{body,party_a,signature_path}'
    #- '{body,party_b,signed_at}' #- '{body,party_b,signature}' #- '{body,party_b,signature_path}'
    #- '{body,party_b,representative}' #- '{body,party_b,designation}'
    #- '{extra,party_b,signed_at}' #- '{extra,party_b,representative}' #- '{extra,party_b,designation}'
$$;

-- The statuses that mean "the recipient has agreed to this version" (or money
-- has moved on it). Entering one locks the current version.
create or replace function app.doc_lock_status(p_status public.doc_status)
returns boolean language sql immutable as $$
  select p_status::text in ('accepted', 'signed', 'fully_signed', 'acknowledged', 'order_confirmed',
                            'advance_paid', 'payment_submitted', 'converted', 'paid', 'partially_paid')
$$;

create or replace function app.doc_accept_status(p_status public.doc_status)
returns boolean language sql immutable as $$
  select p_status::text in ('accepted', 'signed', 'fully_signed', 'acknowledged', 'order_confirmed')
$$;

-- One place that knows both parent tables. Row-locks the parent when asked, so
-- version numbers are allocated one publisher at a time.
create or replace function app.doc_locate(p_document_id uuid, p_lock boolean default false,
  out kind text, out org_id uuid, out doc_type public.doc_type, out status public.doc_status,
  out current_version_id uuid, out locked_version_id uuid, out amount_paid numeric)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_lock then
    select 'financial', f.org_id, f.type, f.status, f.current_version_id, f.locked_version_id, f.amount_paid
      into kind, org_id, doc_type, status, current_version_id, locked_version_id, amount_paid
      from public.financial_documents f where f.id = p_document_id for update;
  else
    select 'financial', f.org_id, f.type, f.status, f.current_version_id, f.locked_version_id, f.amount_paid
      into kind, org_id, doc_type, status, current_version_id, locked_version_id, amount_paid
      from public.financial_documents f where f.id = p_document_id;
  end if;
  if found then return; end if;

  if p_lock then
    select 'record', r.org_id, r.type, r.status, r.current_version_id, r.locked_version_id, 0
      into kind, org_id, doc_type, status, current_version_id, locked_version_id, amount_paid
      from public.records r where r.id = p_document_id for update;
  else
    select 'record', r.org_id, r.type, r.status, r.current_version_id, r.locked_version_id, 0
      into kind, org_id, doc_type, status, current_version_id, locked_version_id, amount_paid
      from public.records r where r.id = p_document_id;
  end if;
  if not found then kind := null; end if;
end $$;

-- The snapshot of a document as it stands right now.
create or replace function app.doc_current_snapshot(p_kind text, p_document_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare f public.financial_documents; r public.records;
begin
  if p_kind = 'financial' then
    select * into f from public.financial_documents where id = p_document_id;
    return app.fin_doc_snapshot(f, app.fin_doc_items(p_document_id));
  end if;
  select * into r from public.records where id = p_document_id;
  return app.record_snapshot(r);
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Internal operations (called by the RPCs, the triggers and the backfill)
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function app.doc_event(
  p_version public.document_versions, p_kind text, p_actor_type text,
  p_meta jsonb default '{}'::jsonb, p_body text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_prev  text := current_setting('app.doc_system_write', true);
  v_actor jsonb := coalesce(nullif(current_setting('app.doc_actor', true), '')::jsonb, '{}'::jsonb);
begin
  perform set_config('app.doc_system_write', 'on', true);
  insert into public.document_negotiation_events
    (org_id, financial_document_id, record_id, version_id, kind, actor_type, actor_id,
     actor_name, actor_email, body, meta, portal_token_jti)
  values
    (p_version.org_id, p_version.financial_document_id, p_version.record_id, p_version.id, p_kind,
     p_actor_type, case when p_actor_type = 'member' then coalesce(auth.uid(), p_version.created_by) end,
     case when p_actor_type = 'recipient' then v_actor ->> 'name' end,
     case when p_actor_type = 'recipient' then nullif(v_actor ->> 'email', '')::citext end,
     p_body, coalesce(p_meta, '{}'::jsonb) || jsonb_build_object('version_no', p_version.version_no),
     case when p_actor_type = 'recipient' then nullif(v_actor ->> 'jti', '')::uuid end);
  perform set_config('app.doc_system_write', coalesce(v_prev, ''), true);
end $$;

-- Snapshot the document as it stands into version N+1 and point the parent at
-- it. The caller holds the parent's row lock.
create or replace function app.doc_create_version(
  p_kind text, p_document_id uuid, p_summary text, p_created_by uuid, p_created_by_type text,
  p_meta jsonb default '{}'::jsonb)
returns public.document_versions
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_prev text := current_setting('app.doc_system_write', true);
  v_org  uuid;
  v_snap jsonb := app.doc_current_snapshot(p_kind, p_document_id);
  v_ver  public.document_versions;
begin
  perform set_config('app.doc_system_write', 'on', true);

  if p_kind = 'financial' then
    select org_id into v_org from public.financial_documents where id = p_document_id;
    insert into public.document_versions (org_id, financial_document_id, version_no, payload, change_summary,
                                          created_by, created_by_type, content_hash)
    values (v_org, p_document_id, 0, v_snap, nullif(btrim(p_summary), ''), p_created_by, p_created_by_type,
            app.doc_hash(v_snap))
    returning * into v_ver;
    update public.financial_documents
       set current_version_id = v_ver.id, revision = 'v' || v_ver.version_no
     where id = p_document_id;
  else
    select org_id into v_org from public.records where id = p_document_id;
    insert into public.document_versions (org_id, record_id, version_no, payload, change_summary,
                                          created_by, created_by_type, content_hash)
    values (v_org, p_document_id, 0, v_snap, nullif(btrim(p_summary), ''), p_created_by, p_created_by_type,
            app.doc_hash(v_snap))
    returning * into v_ver;
    update public.records set current_version_id = v_ver.id where id = p_document_id;
  end if;

  perform app.doc_event(v_ver, 'version_published',
    case p_created_by_type when 'member' then 'member' else 'system' end,
    coalesce(p_meta, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object('summary', nullif(btrim(p_summary), ''))));

  perform set_config('app.doc_system_write', coalesce(v_prev, ''), true);
  return v_ver;
end $$;

-- The current version, taking version 1 first if the document has none.
create or replace function app.doc_ensure_version(p_kind text, p_document_id uuid, p_summary text default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare d record; v public.document_versions;
begin
  select * into d from app.doc_locate(p_document_id, true);
  if d.current_version_id is not null then return d.current_version_id; end if;
  v := app.doc_create_version(p_kind, p_document_id, coalesce(p_summary, 'First version sent'),
                              auth.uid(), case when auth.uid() is null then 'system' else 'member' end);
  return v.id;
end $$;

-- Lock the current version (taking v1 first if needed). p_accepted adds the
-- "accepted" entry to the thread before the "locked" one.
create or replace function app.doc_lock(p_kind text, p_document_id uuid, p_reason text, p_accepted boolean)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_prev  text := current_setting('app.doc_system_write', true);
  v_id    uuid := app.doc_ensure_version(p_kind, p_document_id);
  v_ver   public.document_versions;
  v_actor text := case when auth.uid() is not null then 'member'
                       when coalesce(current_setting('app.doc_actor', true), '') <> '' then 'recipient'
                       else 'system' end;
begin
  select * into v_ver from public.document_versions where id = v_id;
  perform set_config('app.doc_system_write', 'on', true);
  if p_kind = 'financial' then
    update public.financial_documents set locked_version_id = v_id where id = p_document_id and locked_version_id is null;
  else
    update public.records set locked_version_id = v_id where id = p_document_id and locked_version_id is null;
  end if;
  if found then
    if p_accepted then
      perform app.doc_event(v_ver, 'accepted', v_actor, jsonb_build_object('reason', p_reason));
    end if;
    perform app.doc_event(v_ver, 'locked', case when v_actor = 'recipient' then 'system' else v_actor end,
                          jsonb_build_object('reason', p_reason));
  end if;
  perform set_config('app.doc_system_write', coalesce(v_prev, ''), true);
  return v_id;
end $$;

revoke all on function app.doc_locate(uuid, boolean), app.doc_current_snapshot(text, uuid),
  app.doc_event(public.document_versions, text, text, jsonb, text),
  app.doc_create_version(text, uuid, text, uuid, text, jsonb),
  app.doc_ensure_version(text, uuid, text), app.doc_lock(text, uuid, text, boolean),
  app.fin_doc_items(uuid) from public;

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. Guards
-- ═════════════════════════════════════════════════════════════════════════════

-- ─── document_versions: append-only, org and number from the parent ─────────
create or replace function app.document_version_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_org uuid; v_type public.doc_type; v_kind text;
begin
  if tg_op = 'INSERT' then
    if not app.doc_system_write() then
      raise exception 'document versions are created by publishing, not written directly'
        using errcode = 'insufficient_privilege';
    end if;
    if new.financial_document_id is not null then
      v_kind := 'financial';
      select org_id, type into v_org, v_type from public.financial_documents where id = new.financial_document_id;
    else
      v_kind := 'record';
      select org_id, type into v_org, v_type from public.records where id = new.record_id;
    end if;
    if v_org is null then
      raise exception 'document % does not exist', coalesce(new.financial_document_id, new.record_id) using errcode = '23503';
    end if;
    if not app.doc_versionable(v_kind, v_type) then
      raise exception '% documents are not versioned%', v_type,
        case when v_type::text = 'invoice' then ' — correct an invoice with a credit note' else '' end
        using errcode = 'check_violation';
    end if;
    new.org_id := v_org;
    new.version_no := 1 + coalesce((select max(v.version_no) from public.document_versions v
                                     where v.financial_document_id is not distinct from new.financial_document_id
                                       and v.record_id is not distinct from new.record_id), 0);
    new.content_hash := app.doc_hash(new.payload);
    new.created_at := now();
    return new;
  end if;

  -- A version outlives nothing: the only delete allowed is the cascade from its
  -- document (or organization) being deleted, when the parent is already gone.
  if tg_op = 'DELETE'
     and not exists (select 1 from public.financial_documents where id = old.financial_document_id)
     and not exists (select 1 from public.records where id = old.record_id) then
    return old;
  end if;
  raise exception 'document versions are immutable' using errcode = 'insufficient_privilege';
end $$;

drop trigger if exists document_versions_guard on public.document_versions;
create trigger document_versions_guard
  before insert or update or delete on public.document_versions
  for each row execute function app.document_version_guard();


-- ─── document_negotiation_events: append-only, scoped by its version ────────
create or replace function app.negotiation_event_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v   public.document_versions;
  d   record;
  r   public.document_negotiation_events;
begin
  if tg_op <> 'INSERT' then
    -- The cascade from the document (or its version) being deleted.
    if tg_op = 'DELETE'
       and (not exists (select 1 from public.document_versions where id = old.version_id)
            or (not exists (select 1 from public.financial_documents where id = old.financial_document_id)
                and not exists (select 1 from public.records where id = old.record_id))) then
      return old;
    end if;
    raise exception 'the negotiation thread is append-only' using errcode = 'insufficient_privilege';
  end if;

  select * into v from public.document_versions where id = new.version_id;
  if not found then
    -- Nothing to say about a version to a caller who could not post in the
    -- org they named anyway: RLS answers them.
    if auth.uid() is not null and not app.has_permission(new.org_id, 'document_negotiation', 'create') then
      return new;
    end if;
    raise exception 'version % does not exist', new.version_id using errcode = '23503';
  end if;
  -- Everything about where the event lives comes from its version.
  new.org_id := v.org_id;
  new.financial_document_id := v.financial_document_id;
  new.record_id := v.record_id;
  new.created_at := now();

  -- A signed-in caller who could not write here anyway is left to RLS, so the
  -- checks below never describe another organization's document.
  if auth.uid() is not null and not app.has_permission(new.org_id, 'document_negotiation', 'create') then
    return new;
  end if;

  if not app.doc_system_write() then
    if new.kind not in ('comment', 'change_request', 'counter_proposal') then
      raise exception '% entries are written by the database', new.kind using errcode = 'insufficient_privilege';
    end if;
    if auth.uid() is not null then
      -- A member speaks as themselves, never as the recipient.
      new.actor_type := 'member';
      new.actor_id := auth.uid();
      new.portal_token_jti := null;
    elsif new.actor_type <> 'recipient' then
      -- The server writes on a recipient's behalf (api/portal.js) and nothing else.
      raise exception 'server-written thread entries must be the recipient''s' using errcode = 'check_violation';
    else
      new.actor_id := null;
    end if;
  end if;

  select * into d from app.doc_locate(coalesce(v.financial_document_id, v.record_id));

  -- A request or proposal is about the version on the table, and only while
  -- there is still something to negotiate.
  if new.kind in ('change_request', 'counter_proposal') then
    if d.locked_version_id is not null then
      raise exception 'DOCUMENT_LOCKED: this document has been accepted; an owner or admin must reopen it first'
        using errcode = 'check_violation';
    end if;
    if d.current_version_id is distinct from new.version_id then
      raise exception 'STALE_VERSION: requests must be made against the current version'
        using errcode = 'check_violation';
    end if;
    if coalesce(btrim(new.body), '') = '' and new.proposal is null then
      raise exception 'a change request needs a description or a proposal' using errcode = 'check_violation';
    end if;
  end if;

  if new.target is not null then
    if new.target ->> 'type' = 'line_item' then
      if v.financial_document_id is null then
        raise exception 'only quotations and proformas have line items' using errcode = 'check_violation';
      end if;
      if not exists (select 1 from jsonb_array_elements(v.payload -> 'line_items') li
                      where li ->> 'position' = new.target ->> 'position') then
        raise exception 'line item % is not in version %', new.target ->> 'position', v.version_no
          using errcode = 'check_violation';
      end if;
    elsif coalesce(new.target ->> 'key', '') = '' then
      raise exception 'a clause or field target needs a key' using errcode = 'check_violation';
    end if;
  end if;

  if new.reply_to_id is not null then
    select * into r from public.document_negotiation_events where id = new.reply_to_id;
    if not found
       or r.financial_document_id is distinct from new.financial_document_id
       or r.record_id is distinct from new.record_id then
      raise exception 'a reply must stay on the same document' using errcode = '23503';
    end if;
  end if;

  return new;
end $$;

drop trigger if exists negotiation_events_guard on public.document_negotiation_events;
create trigger negotiation_events_guard
  before insert or update or delete on public.document_negotiation_events
  for each row execute function app.negotiation_event_guard();

-- TRUNCATE is not guarded by a trigger: no client role holds it (revoked in
-- §6), and a superuser truncating a table is not an edit this layer can stop.
drop trigger if exists document_versions_no_truncate on public.document_versions;
drop trigger if exists negotiation_events_no_truncate on public.document_negotiation_events;

-- ─── The parents: the edit rule ──────────────────────────────────────────────
create or replace function app.document_parent_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_kind text := case tg_table_name when 'records' then 'record' else 'financial' end;
  v_res  text := case tg_table_name when 'records' then 'records' else 'financial_documents' end;
  v_src  record;
  v_old  jsonb;
  v_new  jsonb;
  v_no   integer;
begin
  if tg_op = 'DELETE' then
    -- The accepted text is evidence. Reopen first; an organization being
    -- deleted takes its documents with it.
    if old.locked_version_id is not null
       and exists (select 1 from public.organizations where id = old.org_id)
       and not app.doc_system_write() then
      raise exception 'DOCUMENT_LOCKED: an accepted document cannot be deleted; an owner or admin must reopen it first'
        using errcode = 'check_violation';
    end if;
    return old;
  end if;

  -- Left to RLS when the caller could not make this write anyway.
  if auth.uid() is not null
     and not app.has_permission(new.org_id, v_res, case tg_op when 'INSERT' then 'create' else 'edit' end) then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if not app.doc_system_write() then
      new.current_version_id := null;
      new.locked_version_id := null;
    end if;
    -- A conversion is built from the version the client agreed to. The source
    -- must be locked, and the new document records which version it came from.
    if v_kind = 'financial' then
      if coalesce(new.payload ->> 'converted_from', '') <> '' then
        select f.org_id, f.type, f.locked_version_id into v_src
          from public.financial_documents f where f.id = (new.payload ->> 'converted_from')::uuid;
        if not found or v_src.org_id <> new.org_id then
          raise exception 'the document this was converted from does not belong to this organization' using errcode = '23503';
        end if;
        if app.doc_versionable('financial', v_src.type) then
          if v_src.locked_version_id is null then
            raise exception 'SOURCE_NOT_LOCKED: a % must be accepted (locked) before it is converted', v_src.type
              using errcode = 'check_violation';
          end if;
          new.payload := new.payload || jsonb_build_object('converted_from_version_id', v_src.locked_version_id);
        end if;
      end if;
    end if;
    return new;
  end if;

  -- UPDATE
  if not app.doc_versionable(v_kind, old.type) and not app.doc_versionable(v_kind, new.type) then
    return new;
  end if;

  if (new.current_version_id is distinct from old.current_version_id
      or new.locked_version_id is distinct from old.locked_version_id)
     and not app.doc_system_write() then
    raise exception 'current_version_id and locked_version_id are set by publishing, locking and reopening'
      using errcode = 'insufficient_privilege';
  end if;

  -- A version pointer must name a version of THIS document.
  if new.current_version_id is not null and new.current_version_id is distinct from old.current_version_id
     and not exists (select 1 from public.document_versions v where v.id = new.current_version_id
                      and (v.financial_document_id = new.id or v.record_id = new.id)) then
    raise exception 'version % does not belong to this document', new.current_version_id using errcode = '23503';
  end if;
  if new.locked_version_id is not null and new.locked_version_id is distinct from old.locked_version_id
     and not exists (select 1 from public.document_versions v where v.id = new.locked_version_id
                      and (v.financial_document_id = new.id or v.record_id = new.id)) then
    raise exception 'version % does not belong to this document', new.locked_version_id using errcode = '23503';
  end if;

  -- Never sent: a draft is edited in place.
  if old.current_version_id is null then
    return new;
  end if;

  -- The revision label follows the version, whatever a stale client sends back.
  if v_kind = 'financial' then
    select version_no into v_no from public.document_versions where id = new.current_version_id;
    new.revision := 'v' || v_no;
  end if;

  if v_kind = 'financial' then
    v_old := app.doc_guard_view(app.fin_doc_snapshot(old, '[]'::jsonb));
    v_new := app.doc_guard_view(app.fin_doc_snapshot(new, '[]'::jsonb));
  else
    v_old := app.doc_guard_view(app.record_snapshot(old));
    v_new := app.doc_guard_view(app.record_snapshot(new));
  end if;

  if v_old is distinct from v_new then
    if old.locked_version_id is not null then
      raise exception 'DOCUMENT_LOCKED: the accepted version is locked; an owner or admin must reopen it before it can change'
        using errcode = 'check_violation';
    end if;
    if app.doc_publishing() <> new.id::text then
      raise exception 'DOCUMENT_VERSIONED: this document has been sent; publish the change as a new version'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end $$;

drop trigger if exists financial_documents_version_guard on public.financial_documents;
create trigger financial_documents_version_guard
  before insert or update or delete on public.financial_documents
  for each row execute function app.document_parent_guard();

drop trigger if exists records_version_guard on public.records;
create trigger records_version_guard
  before insert or update or delete on public.records
  for each row execute function app.document_parent_guard();

-- ─── The parents: first version and lock follow the status ───────────────────
create or replace function app.document_parent_after()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_kind text := case tg_table_name when 'records' then 'record' else 'financial' end;
  v_paid_now boolean := false;
begin
  if not app.doc_versionable(v_kind, new.type) then return null; end if;

  if v_kind = 'financial' then
    v_paid_now := new.type::text = 'proforma'
                  and coalesce(new.amount_paid, 0) > 0 and coalesce(old.amount_paid, 0) = 0;
  end if;

  -- Leaving draft is sending: take version 1.
  if new.current_version_id is null and new.status is distinct from old.status
     and new.status::text not in ('draft', 'pending', 'cancelled', 'expired') then
    perform app.doc_ensure_version(v_kind, new.id);
  end if;

  -- Agreeing to it, or paying against it, locks it.
  if new.locked_version_id is null
     and ((new.status is distinct from old.status and app.doc_lock_status(new.status)) or v_paid_now) then
    perform app.doc_lock(v_kind, new.id,
      case when v_paid_now and not app.doc_lock_status(new.status) then 'payment' else new.status::text end,
      new.status is distinct from old.status and app.doc_accept_status(new.status));
  end if;

  return null;
end $$;

drop trigger if exists financial_documents_version_after on public.financial_documents;
create trigger financial_documents_version_after
  after update of status, amount_paid on public.financial_documents
  for each row execute function app.document_parent_after();

drop trigger if exists records_version_after on public.records;
create trigger records_version_after
  after update of status on public.records
  for each row execute function app.document_parent_after();

-- ─── Line items of a sent quotation / proforma ───────────────────────────────
create or replace function app.document_line_item_version_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_doc uuid;
  d     record;
begin
  foreach v_doc in array array_remove(array[
      case when tg_op <> 'INSERT' then old.document_id end,
      case when tg_op <> 'DELETE' then new.document_id end], null) loop
    select f.org_id, f.type, f.current_version_id, f.locked_version_id into d
      from public.financial_documents f where f.id = v_doc;
    -- The parent is gone: this is its cascade.
    continue when not found;
    continue when not app.doc_versionable('financial', d.type) or d.current_version_id is null;
    -- Left to RLS when the caller could not make this write anyway.
    if auth.uid() is not null and not app.has_permission(d.org_id, 'document_line_items',
         case tg_op when 'INSERT' then 'create' when 'DELETE' then 'delete' else 'edit' end) then
      continue;
    end if;
    if d.locked_version_id is not null then
      raise exception 'DOCUMENT_LOCKED: the accepted version is locked; an owner or admin must reopen it before it can change'
        using errcode = 'check_violation';
    end if;
    if app.doc_publishing() <> v_doc::text then
      raise exception 'DOCUMENT_VERSIONED: this document has been sent; publish the change as a new version'
        using errcode = 'check_violation';
    end if;
  end loop;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

drop trigger if exists document_line_items_version_guard on public.document_line_items;
create trigger document_line_items_version_guard
  before insert or update or delete on public.document_line_items
  for each row execute function app.document_line_item_version_guard();

-- ─── Signatures name the version they signed ─────────────────────────────────
create or replace function app.document_signature_version_guard()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_kind text := case when new.record_id is not null then 'record' else 'financial' end;
  v_doc  uuid := coalesce(new.record_id, new.financial_doc_id);
  d      record;
  v      public.document_versions;
begin
  if tg_op = 'UPDATE' then
    -- Pinned once; only the backfill fills a pin that was never set.
    if (old.version_id is not null or not app.doc_system_write())
       and (new.version_id is distinct from old.version_id or new.content_hash is distinct from old.content_hash) then
      raise exception 'a signature''s version cannot change' using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  select * into d from app.doc_locate(v_doc);
  if d.kind is null or not app.doc_versionable(v_kind, d.doc_type) then
    new.version_id := null;
    new.content_hash := null;
    return new;
  end if;

  if auth.uid() is not null and not app.has_permission(new.org_id, 'document_signatures', 'create') then
    return new;
  end if;

  -- A caller that names no version is signing the one on the table.
  new.version_id := coalesce(new.version_id, d.current_version_id, app.doc_ensure_version(v_kind, v_doc));
  select * into v from public.document_versions where id = new.version_id;
  if not found or (v.financial_document_id is distinct from new.financial_doc_id
                   or v.record_id is distinct from new.record_id) then
    raise exception 'version % does not belong to this document', new.version_id using errcode = '23503';
  end if;
  if new.version_id is distinct from coalesce(d.current_version_id, new.version_id) then
    raise exception 'STALE_VERSION: v% is no longer the current version of this document', v.version_no
      using errcode = 'check_violation';
  end if;
  new.content_hash := v.content_hash;
  return new;
end $$;

drop trigger if exists document_signatures_version_guard on public.document_signatures;
create trigger document_signatures_version_guard
  before insert or update on public.document_signatures
  for each row execute function app.document_signature_version_guard();

-- One response per version (was: one per document). A reopened document can be
-- signed again, and each signature stays attached to the text it signed.
-- Unversioned documents (invoices, certificates, HR notices) keep one per
-- document: their version_id is null, and NULLS NOT DISTINCT treats the nulls
-- as equal.
drop index if exists public.sig_one_per_record;
drop index if exists public.sig_one_per_findoc;
create unique index if not exists sig_one_per_record_version
  on public.document_signatures (record_id, version_id) nulls not distinct where record_id is not null;
create unique index if not exists sig_one_per_findoc_version
  on public.document_signatures (financial_doc_id, version_id) nulls not distinct where financial_doc_id is not null;

-- ─── Issuing a portal link is sending ────────────────────────────────────────
create or replace function app.portal_token_publishes()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_kind text := case when new.record_id is not null then 'record' else 'financial' end;
  v_doc  uuid := coalesce(new.record_id, new.financial_doc_id);
  d      record;
  v      public.document_versions;
begin
  select * into d from app.doc_locate(v_doc, true);
  if d.kind is null or not app.doc_versionable(v_kind, d.doc_type) or d.current_version_id is not null then
    return null;
  end if;
  v := app.doc_create_version(v_kind, v_doc, 'First version sent', new.issued_by,
                              case when new.issued_by is null then 'system' else 'member' end);
  return null;
end $$;

drop trigger if exists portal_tokens_publish_version on public.portal_tokens;
create trigger portal_tokens_publish_version
  after insert on public.portal_tokens
  for each row execute function app.portal_token_publishes();

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. The API: publish, lock, reopen (members) and respond (the portal server)
-- ═════════════════════════════════════════════════════════════════════════════

-- Apply an edit to a document and publish it as version N+1, atomically.
--
--   p_changes     the parent's columns, as the app's row mappers produce them
--                 (orgStore finDocToRow / records.toRow). Unknown and system
--                 columns are ignored. The response keys already on the
--                 document's payload / data are kept, whatever is sent.
--   p_line_items  quotations and proformas: the full item list, replacing the
--                 current one (null leaves the items alone).
--   p_resolves    the change requests / counter proposals this version answers.
--
-- A draft that has never been sent is published as v1. Publishing content
-- identical to the current version is refused (NO_CHANGES).
create or replace function public.document_publish_version(
  p_document_id uuid,
  p_changes     jsonb default '{}'::jsonb,
  p_line_items  jsonb default null,
  p_summary     text default null,
  p_resolves    uuid[] default '{}'::uuid[])
returns public.document_versions
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  d        record;
  v_res    text;
  v_keep   text[] := app.doc_response_keys();
  f_old    public.financial_documents;
  f_new    public.financial_documents;
  r_old    public.records;
  r_new    public.records;
  v_cur    public.document_versions;
  v_ver    public.document_versions;
  v_snap   jsonb;
  v_bad    integer;
  v_prev   text := current_setting('app.doc_publishing', true);
  p        jsonb := coalesce(p_changes, '{}'::jsonb)
                    - array['id', 'org_id', 'doc_number', 'type', 'status', 'created_by', 'created_at',
                            'updated_at', 'current_version_id', 'locked_version_id', 'revision',
                            'amount_paid', 'subtotal', 'discount_amount', 'taxable_amount', 'gst_amount',
                            'grand_total', 'employee_id', 'pdf_path'];
begin
  select * into d from app.doc_locate(p_document_id, true);
  if d.kind is null then
    raise exception 'document % not found', p_document_id using errcode = 'no_data_found';
  end if;
  v_res := case d.kind when 'record' then 'records' else 'financial_documents' end;
  if not app.has_permission(d.org_id, v_res, 'edit') then
    raise exception 'PERMISSION_DENIED: you cannot edit this document' using errcode = 'insufficient_privilege';
  end if;
  if not app.doc_versionable(d.kind, d.doc_type) then
    raise exception '% documents are not versioned%', d.doc_type,
      case when d.doc_type::text = 'invoice' then ' — correct an invoice with a credit note' else '' end
      using errcode = 'check_violation';
  end if;
  if d.locked_version_id is not null then
    raise exception 'DOCUMENT_LOCKED: the accepted version is locked; an owner or admin must reopen it before it can change'
      using errcode = 'check_violation';
  end if;
  if d.kind = 'record' and p_line_items is not null then
    raise exception 'only quotations and proformas have line items' using errcode = 'check_violation';
  end if;

  -- The requests this version answers must be open requests on this document.
  select count(*) into v_bad
    from unnest(coalesce(p_resolves, '{}'::uuid[])) rid
   where not exists (select 1 from public.document_negotiation_events e
                      where e.id = rid and e.kind in ('change_request', 'counter_proposal')
                        and (e.financial_document_id = p_document_id or e.record_id = p_document_id));
  if v_bad > 0 then
    raise exception 'p_resolves names % entries that are not requests on this document', v_bad
      using errcode = 'check_violation';
  end if;

  perform set_config('app.doc_publishing', p_document_id::text, true);

  if d.kind = 'financial' then
    select * into f_old from public.financial_documents where id = p_document_id;
    f_new := jsonb_populate_record(f_old, p);
    update public.financial_documents set
      customer_id = f_new.customer_id, bill_to_name = f_new.bill_to_name, bill_to_email = f_new.bill_to_email,
      bill_to_address = f_new.bill_to_address, bill_to_gstin = f_new.bill_to_gstin,
      bill_to_state = f_new.bill_to_state, issue_date = f_new.issue_date, due_date = f_new.due_date,
      valid_until = f_new.valid_until, currency = f_new.currency, discount_type = f_new.discount_type,
      discount_value = f_new.discount_value, gst_enabled = f_new.gst_enabled, gst_rate = f_new.gst_rate,
      is_inter_state = f_new.is_inter_state, making_charges = f_new.making_charges,
      amount_in_words = f_new.amount_in_words, advance_percent = f_new.advance_percent,
      payment_instructions = f_new.payment_instructions, terms = f_new.terms, notes = f_new.notes,
      company_snapshot = f_new.company_snapshot,
      payload = (coalesce(f_new.payload, '{}'::jsonb) - v_keep) || app.jsonb_pick(f_old.payload, v_keep)
     where id = p_document_id;

    if p_line_items is not null then
      if jsonb_typeof(p_line_items) <> 'array' then
        raise exception 'p_line_items must be an array' using errcode = 'check_violation';
      end if;
      delete from public.document_line_items where document_id = p_document_id;
      insert into public.document_line_items
        (document_id, org_id, position, description, hsn_sac, quantity, unit, rate, gst_rate, catalog_item_id)
      select p_document_id, d.org_id, (x.ord - 1)::integer,
             coalesce(x.item ->> 'description', ''),
             nullif(x.item ->> 'hsn_sac', ''),
             coalesce(nullif(x.item ->> 'quantity', '')::numeric, 1),
             coalesce(nullif(x.item ->> 'unit', ''), 'Nos'),
             coalesce(nullif(x.item ->> 'rate', '')::numeric, 0),
             nullif(x.item ->> 'gst_rate', '')::numeric,
             nullif(x.item ->> 'catalog_item_id', '')::uuid
        from jsonb_array_elements(p_line_items) with ordinality as x(item, ord);
    end if;
  else
    select * into r_old from public.records where id = p_document_id;
    r_new := jsonb_populate_record(r_old, p);
    update public.records set
      title = r_new.title, recipient_name = r_new.recipient_name, recipient_email = r_new.recipient_email,
      issue_date = r_new.issue_date, company_snapshot = r_new.company_snapshot,
      data = (coalesce(r_new.data, '{}'::jsonb) - v_keep) || app.jsonb_pick(r_old.data, v_keep)
     where id = p_document_id;
  end if;

  v_snap := app.doc_current_snapshot(d.kind, p_document_id);
  if d.current_version_id is not null then
    select * into v_cur from public.document_versions where id = d.current_version_id;
    if v_cur.content_hash = app.doc_hash(v_snap) then
      raise exception 'NO_CHANGES: this is identical to v%', v_cur.version_no using errcode = 'check_violation';
    end if;
  end if;

  v_ver := app.doc_create_version(d.kind, p_document_id,
             coalesce(nullif(btrim(p_summary), ''), case when d.current_version_id is null then 'First version sent' end),
             auth.uid(), 'member',
             case when cardinality(coalesce(p_resolves, '{}'::uuid[])) > 0
                  then jsonb_build_object('resolves', to_jsonb(p_resolves)) else '{}'::jsonb end);

  -- A new version is a new offer: it goes back to the recipient to answer.
  -- An offer letter keeps 'pending', which is its word for the same thing.
  if d.kind = 'financial' then
    update public.financial_documents set status = 'sent' where id = p_document_id and status::text <> 'sent';
  else
    update public.records
       set status = case when d.doc_type::text = 'offer' and d.status::text = 'pending' then 'pending' else 'sent' end
     where id = p_document_id and status::text not in ('sent', 'pending');
  end if;

  perform set_config('app.doc_publishing', coalesce(v_prev, ''), true);
  return v_ver;
end $$;

-- Lock the current version by hand — what "Convert" does before building the
-- next document from it. p_version_id must be the current version.
create or replace function public.document_lock_version(p_document_id uuid, p_version_id uuid)
returns public.document_versions
language plpgsql security definer set search_path = public, pg_temp as $$
declare d record; v public.document_versions;
begin
  select * into d from app.doc_locate(p_document_id, true);
  if d.kind is null
     or not app.has_permission(d.org_id, case d.kind when 'record' then 'records' else 'financial_documents' end, 'edit') then
    raise exception 'PERMISSION_DENIED: you cannot lock this document' using errcode = 'insufficient_privilege';
  end if;
  if not app.doc_versionable(d.kind, d.doc_type) then
    raise exception '% documents are not versioned', d.doc_type using errcode = 'check_violation';
  end if;
  if d.locked_version_id is not null then
    if d.locked_version_id = p_version_id then
      select * into v from public.document_versions where id = p_version_id;
      return v;
    end if;
    raise exception 'DOCUMENT_LOCKED: another version is already locked' using errcode = 'check_violation';
  end if;
  if p_version_id is distinct from d.current_version_id then
    raise exception 'STALE_VERSION: only the current version can be locked' using errcode = 'check_violation';
  end if;
  perform app.doc_lock(d.kind, p_document_id, 'locked by a member', false);
  select * into v from public.document_versions where id = p_version_id;
  return v;
end $$;

-- Unlock an accepted document so it can be renegotiated. Owner/admin only, a
-- reason is required, and it is written to audit_log. The document returns to
-- revision_requested; the old signature stays, attached to the old version.
create or replace function public.document_reopen(p_document_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  d      record;
  v      public.document_versions;
  v_prev text := current_setting('app.doc_system_write', true);
begin
  select * into d from app.doc_locate(p_document_id, true);
  if d.kind is null or not app.is_admin(d.org_id) then
    raise exception 'PERMISSION_DENIED: only an owner or admin can reopen an accepted document'
      using errcode = 'insufficient_privilege';
  end if;
  if d.locked_version_id is null then
    raise exception 'this document is not locked' using errcode = 'check_violation';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'a reason is required to reopen a document' using errcode = 'check_violation';
  end if;
  if d.status::text = 'converted' then
    raise exception 'REOPEN_REFUSED: this document has been converted; the next document was built from the locked version'
      using errcode = 'check_violation';
  end if;
  if d.kind = 'financial' and d.doc_type::text = 'proforma' and coalesce(d.amount_paid, 0) > 0 then
    raise exception 'REOPEN_REFUSED: an advance has been paid against this proforma'
      using errcode = 'check_violation';
  end if;

  select * into v from public.document_versions where id = d.locked_version_id;

  perform set_config('app.doc_system_write', 'on', true);
  if d.kind = 'financial' then
    update public.financial_documents set locked_version_id = null, status = 'revision_requested' where id = p_document_id;
  else
    update public.records set locked_version_id = null, status = 'revision_requested' where id = p_document_id;
  end if;
  perform app.doc_event(v, 'reopened', 'member', jsonb_build_object('reason', btrim(p_reason)), btrim(p_reason));
  perform set_config('app.doc_system_write', coalesce(v_prev, ''), true);

  insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, diff)
  values (d.org_id, auth.uid(), 'document_versions.reopen',
          case d.kind when 'record' then 'records' else 'financial_documents' end, p_document_id,
          jsonb_build_object('version_no', v.version_no, 'version_id', v.id, 'content_hash', v.content_hash,
                             'from_status', d.status, 'reason', btrim(p_reason)));
end $$;

-- The portal's claim on a response: moves the status only if the recipient is
-- answering the CURRENT version and nobody has answered yet. A recipient
-- looking at v2 while v3 was published gets STALE_VERSION, never an accepted
-- v3 they did not read. Service role only (api/portal.js).
create or replace function public.document_claim_response(
  p_document_id uuid, p_version_id uuid, p_status public.doc_status, p_terminal text[],
  p_actor jsonb default '{}'::jsonb)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare d record; v_versioned boolean;
begin
  select * into d from app.doc_locate(p_document_id, true);
  if d.kind is null then
    raise exception 'document % not found', p_document_id using errcode = 'no_data_found';
  end if;
  v_versioned := app.doc_versionable(d.kind, d.doc_type);
  if v_versioned and p_version_id is distinct from d.current_version_id then
    raise exception 'STALE_VERSION: a newer version of this document has been published'
      using errcode = 'check_violation';
  end if;
  if d.status::text = any(coalesce(p_terminal, '{}'::text[])) then
    return false;
  end if;
  -- Who is answering, for the thread entries the status change writes.
  perform set_config('app.doc_actor', coalesce(p_actor, '{}'::jsonb)::text, true);
  if d.kind = 'financial' then
    update public.financial_documents set status = p_status where id = p_document_id;
  else
    update public.records set status = p_status where id = p_document_id;
  end if;
  perform set_config('app.doc_actor', '', true);
  return true;
end $$;

-- Undo a claim when the work after it failed: the status goes back and a lock
-- the claim took is released, so the recipient can try again.
create or replace function public.document_release_response(p_document_id uuid, p_status public.doc_status)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare d record; v public.document_versions; v_prev text := current_setting('app.doc_system_write', true);
begin
  select * into d from app.doc_locate(p_document_id, true);
  if d.kind is null then return; end if;
  perform set_config('app.doc_system_write', 'on', true);
  if d.kind = 'financial' then
    update public.financial_documents set status = p_status, locked_version_id = null where id = p_document_id;
  else
    update public.records set status = p_status, locked_version_id = null where id = p_document_id;
  end if;
  if d.locked_version_id is not null then
    select * into v from public.document_versions where id = d.locked_version_id;
    perform app.doc_event(v, 'reopened', 'system', jsonb_build_object('reason', 'response could not be recorded'));
  end if;
  perform set_config('app.doc_system_write', coalesce(v_prev, ''), true);
end $$;

revoke all on function public.document_publish_version(uuid, jsonb, jsonb, text, uuid[]) from public, anon;
revoke all on function public.document_lock_version(uuid, uuid) from public, anon;
revoke all on function public.document_reopen(uuid, text) from public, anon;
revoke all on function public.document_claim_response(uuid, uuid, public.doc_status, text[], jsonb) from public, anon, authenticated;
revoke all on function public.document_release_response(uuid, public.doc_status) from public, anon, authenticated;
grant execute on function public.document_publish_version(uuid, jsonb, jsonb, text, uuid[]) to authenticated, service_role;
grant execute on function public.document_lock_version(uuid, uuid) to authenticated, service_role;
grant execute on function public.document_reopen(uuid, text) to authenticated, service_role;
grant execute on function public.document_claim_response(uuid, uuid, public.doc_status, text[], jsonb) to service_role;
grant execute on function public.document_release_response(uuid, public.doc_status) to service_role;

-- ═════════════════════════════════════════════════════════════════════════════
-- 6. Permissions — idempotent, with an explicit fan-out (see the 0038 repair)
-- ═════════════════════════════════════════════════════════════════════════════
-- Two resources. Versions are view-only to everyone: they are written by
-- publishing, which is gated on editing the document itself. The thread is
-- read by whoever can read documents and written by whoever can edit them.
-- On top of its own resource, each row also needs view on its PARENT's
-- resource (restrictive policies below): someone who cannot see HR documents
-- cannot read an offer letter's versions through the back door.

insert into public.permission_resources (key, label, category, description, actions, sort_order) values
  ('document_versions', 'Document versions', 'Documents',
   'Immutable snapshots of every version sent to a client or candidate, and which one was accepted.',
   array['view'], 342),
  ('document_negotiation', 'Document negotiation', 'Documents',
   'The comment and change-request thread on quotations, proformas, offers, NDAs and MoUs.',
   array['view','create'], 344)
on conflict (key) do update
  set label = excluded.label, category = excluded.category,
      description = excluded.description, actions = excluded.actions, sort_order = excluded.sort_order;

insert into public.role_permission_defaults (role, resource, can_view, can_create, can_edit, can_delete)
select r.key, 'document_versions',
       r.key in ('owner','admin','member','viewer'), false, false, false
  from public.roles r
 where r.key in ('owner','admin','member','viewer','employee')
on conflict (role, resource) do nothing;

insert into public.role_permission_defaults (role, resource, can_view, can_create, can_edit, can_delete)
select r.key, 'document_negotiation',
       r.key in ('owner','admin','member','viewer'),
       r.key in ('owner','admin','member'),
       false, false
  from public.roles r
 where r.key in ('owner','admin','member','viewer','employee')
on conflict (role, resource) do nothing;

select app.sync_role_permissions(null) as rows_added;

select app.secure_tenant_table('public.document_versions'::regclass, 'document_versions');
select app.secure_tenant_table('public.document_negotiation_events'::regclass, 'document_negotiation');

-- The parent rule is folded into the policies secure_tenant_table just made
-- rather than added as RESTRICTIVE policies: tests/02_access_matrix.sql (and
-- every policy reader since 0027) models permissive policies only.
create or replace function app.doc_parent_visible(p_org uuid, p_financial boolean)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select app.has_permission(p_org, case when p_financial then 'financial_documents' else 'records' end, 'view')
$$;

drop policy if exists document_versions_parent_view on public.document_versions;
drop policy if exists negotiation_events_parent_view on public.document_negotiation_events;
drop policy if exists negotiation_events_parent_view_insert on public.document_negotiation_events;

drop policy if exists document_versions_select on public.document_versions;
create policy document_versions_select on public.document_versions for select to authenticated
  using (app.has_permission(org_id, 'document_versions', 'view')
         and app.doc_parent_visible(org_id, financial_document_id is not null));

drop policy if exists document_negotiation_events_select on public.document_negotiation_events;
create policy document_negotiation_events_select on public.document_negotiation_events for select to authenticated
  using (app.has_permission(org_id, 'document_negotiation', 'view')
         and app.doc_parent_visible(org_id, financial_document_id is not null));

drop policy if exists document_negotiation_events_insert on public.document_negotiation_events;
create policy document_negotiation_events_insert on public.document_negotiation_events for insert to authenticated
  with check (app.has_permission(org_id, 'document_negotiation', 'create')
              and app.doc_parent_visible(org_id, financial_document_id is not null));

-- Versions are written only by the functions above; the thread only grows.
-- The revokes are explicit because 0022's default privileges granted everything.
revoke insert, update, delete, truncate on public.document_versions from authenticated;
revoke update, delete, truncate on public.document_negotiation_events from authenticated;
grant select on public.document_versions to authenticated;
grant select, insert on public.document_negotiation_events to authenticated;
grant all on public.document_versions, public.document_negotiation_events to service_role;

-- ═════════════════════════════════════════════════════════════════════════════
-- 7. Audit and Realtime
-- ═════════════════════════════════════════════════════════════════════════════

drop trigger if exists document_versions_audit on public.document_versions;
create trigger document_versions_audit
  after insert on public.document_versions
  for each row execute function app.write_audit();

drop trigger if exists document_negotiation_events_audit on public.document_negotiation_events;
create trigger document_negotiation_events_audit
  after insert on public.document_negotiation_events
  for each row execute function app.write_audit();

do $mig$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['document_versions', 'document_negotiation_events'] loop
      if not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $mig$;

-- ═════════════════════════════════════════════════════════════════════════════
-- 8. Backfill — every document already sent gets its v1; accepted ones are
--    locked on it; existing signatures are pinned to it. Safe to re-run: each
--    step only touches rows it has not done yet.
-- ═════════════════════════════════════════════════════════════════════════════

do $mig$
declare d record;
begin
  perform set_config('app.doc_system_write', 'on', true);

  for d in
    select 'financial' as kind, f.id, f.status, f.type, f.amount_paid, f.created_by
      from public.financial_documents f
     where f.type::text in ('quotation', 'proforma') and f.current_version_id is null
       and (f.status::text <> 'draft'
            or exists (select 1 from public.portal_tokens t where t.financial_doc_id = f.id)
            or exists (select 1 from public.document_signatures s where s.financial_doc_id = f.id))
    union all
    select 'record', r.id, r.status, r.type, 0, r.created_by
      from public.records r
     where r.type::text in ('offer', 'nda', 'mou') and r.current_version_id is null
       and (r.status::text <> 'draft'
            or exists (select 1 from public.portal_tokens t where t.record_id = r.id)
            or exists (select 1 from public.document_signatures s where s.record_id = r.id))
  loop
    perform app.doc_create_version(d.kind, d.id, 'Version 1 — recorded when versioning was introduced',
                                   d.created_by, 'system', jsonb_build_object('backfill', true));
  end loop;

  for d in
    select 'financial' as kind, f.id, f.status from public.financial_documents f
     where f.current_version_id is not null and f.locked_version_id is null
       and (app.doc_lock_status(f.status) or (f.type::text = 'proforma' and f.amount_paid > 0))
    union all
    select 'record', r.id, r.status from public.records r
     where r.current_version_id is not null and r.locked_version_id is null
       and app.doc_lock_status(r.status)
  loop
    perform app.doc_lock(d.kind, d.id, 'backfill: ' || d.status::text, false);
  end loop;

  update public.document_signatures s
     set version_id = v.id, content_hash = v.content_hash
    from public.document_versions v
   where s.version_id is null
     and v.id = coalesce((select f.current_version_id from public.financial_documents f where f.id = s.financial_doc_id),
                         (select r.current_version_id from public.records r where r.id = s.record_id));

  perform set_config('app.doc_system_write', '', true);
end $mig$;

-- Proof: every versionable document past draft has a current version, and
-- every document in an accepted state is locked. Both counts should be 0.
select
  (select count(*) from public.financial_documents
    where type::text in ('quotation','proforma') and status::text <> 'draft' and current_version_id is null)
+ (select count(*) from public.records
    where type::text in ('offer','nda','mou') and status::text <> 'draft' and current_version_id is null)
    as sent_without_version,
  (select count(*) from public.financial_documents
    where type::text in ('quotation','proforma') and app.doc_lock_status(status) and locked_version_id is null)
+ (select count(*) from public.records
    where type::text in ('offer','nda','mou') and app.doc_lock_status(status) and locked_version_id is null)
    as accepted_without_lock;


-- ############################################################################
-- ## 0065_contract_value_from_locked_version.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0065 — A project's contract value is the accepted quotation's, exactly
--
-- projects.source_quotation_id has always carried a contract_value the browser
-- copied from the quotation when the form opened (projectService
-- prefillFromQuotation), then let anyone edit. With versioning (0064) there is
-- one authoritative figure: the taxable amount of the quotation's LOCKED
-- version — what the client actually agreed to, before GST (0061 labels
-- contract value "before GST").
--
--   · Linking a quotation requires it to be locked (accepted).
--   · While linked, contract_value is the locked version's taxable_amount,
--     whatever the client sends.
--   · If the quotation is reopened and a new version accepted, the linked
--     projects follow the new lock — unless the project is closed, whose
--     figures are history.
--
-- Milestones reprice themselves on a contract change (0047), so a relock flows
-- through to percentage milestones not yet invoiced.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function app.locked_contract_value(p_quotation uuid)
returns numeric language sql stable security definer set search_path = public, pg_temp as $$
  select (v.payload -> 'totals' ->> 'taxable_amount')::numeric
    from public.financial_documents f
    join public.document_versions v on v.id = f.locked_version_id
   where f.id = p_quotation
$$;

revoke all on function app.locked_contract_value(uuid) from public;

create or replace function app.project_contract_from_quotation()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_value numeric;
begin
  if new.source_quotation_id is null then return new; end if;
  -- Left to RLS when the caller could not make this write anyway.
  if auth.uid() is not null
     and not app.has_permission(new.org_id, 'projects', case tg_op when 'INSERT' then 'create' else 'edit' end) then
    return new;
  end if;
  -- An unchanged link on a closed project keeps its historical figure.
  if tg_op = 'UPDATE' and new.source_quotation_id is not distinct from old.source_quotation_id
     and new.status::text in ('completed', 'cancelled') then
    new.contract_value := old.contract_value;
    return new;
  end if;

  v_value := app.locked_contract_value(new.source_quotation_id);
  if v_value is null then
    raise exception 'QUOTATION_NOT_LOCKED: a project can only be started from an accepted quotation'
      using errcode = 'check_violation';
  end if;
  new.contract_value := v_value;
  return new;
end $$;

drop trigger if exists projects_contract_from_quotation on public.projects;
create trigger projects_contract_from_quotation
  before insert or update of source_quotation_id, contract_value, status on public.projects
  for each row execute function app.project_contract_from_quotation();

-- The quotation was (re)locked: every open project built on it takes the new figure.
create or replace function app.quotation_lock_reprices_projects()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_value numeric := app.locked_contract_value(new.id);
begin
  if v_value is null then return null; end if;
  update public.projects p
     set contract_value = v_value
   where p.source_quotation_id = new.id and p.org_id = new.org_id
     and p.status::text not in ('completed', 'cancelled')
     and p.contract_value is distinct from v_value;
  return null;
end $$;

drop trigger if exists financial_documents_lock_reprices_projects on public.financial_documents;
create trigger financial_documents_lock_reprices_projects
  after update of locked_version_id on public.financial_documents
  for each row
  when (new.type = 'quotation' and new.locked_version_id is not null
        and new.locked_version_id is distinct from old.locked_version_id)
  execute function app.quotation_lock_reprices_projects();


-- ############################################################################
-- ## 0066_edgebrain_headline_totals.sql
-- ############################################################################

-- ─────────────────────────────────────────────────────────────────────────────
-- 0066 — EdgeBrain headline totals
--
-- Asked "what is the net cash?", the assistant answered −₹81,550 while the
-- dashboard said +₹16,450. Nothing it was given was wrong; what it was given
-- was incomplete. There was no net-cash figure, so it assembled one from
-- revenue.collected (invoice money only — ₹0) minus expenses, and never saw the
-- ₹98,000 that arrived through the cash book. The same gap sat under "total
-- revenue": invoices and direct takings lived in two aggregates on two bases
-- (with GST and without), and the model had to add them itself.
--
-- The fix is not a better prompt but the missing numbers. This group computes
-- the totals people actually ask for, each once, in SQL, on stated rules:
--
--   cash.received  = confirmed payments on documents (invoice receipts AND
--                    proforma advances), less the advance COPIED onto an
--                    invoice at conversion (it is the proforma's money)
--                  + cash-book money in not tied to a document
--                  + cash-book money in tied to a document that has no
--                    confirmed payment (the receipt was only logged there)
--                    — for any reason: sales, funding, refunds. It is cash.
--   cash.paid_out  = expenses actually paid (not 'pending'), gross
--                  + what has been paid against vendor bills
--   cash.net       = cash.received − cash.paid_out
--   revenue.total  = issued invoices (not draft, not cancelled), net of GST
--                  + cash-book revenue not tied to an invoice, net of GST
--
-- src/services/financeAnalytics.js cashPosition() applies the same rules to the
-- dashboard, and its tests pin them, so the tile and the answer cannot drift.
--
-- Two existing aggregates are corrected here too: revenue.billed and
-- revenue.outstanding counted DRAFT invoices — money nobody has been asked for.
--
-- A figure built from several tables must not reach a user who may not see one
-- of them (net cash minus money in IS the spend total). Each row names every
-- resource it depends on in dims.requires; api/_lib/brainRetrieval.js drops the
-- row unless the caller holds all of them.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function app.brain_refresh_metrics_totals(p_org uuid)
returns integer language plpgsql set search_path = public, pg_temp as $fn$
declare
  v_pay_docs  numeric;  -- confirmed payments on invoices
  v_pay_adv   numeric;  -- confirmed payments on proformas (advances)
  v_book_rev  numeric;  -- cash book, revenue treatments
  v_book_cap  numeric;  -- cash book, funding / loans / deposits
  v_book_oth  numeric;  -- cash book, refunds and anything else
  v_exp_paid  numeric;
  v_bills     numeric;
  v_in        numeric;
  v_out       numeric;
  v_inv_net   numeric;
  v_direct    numeric;
  v_n_in      integer;
  v_n_out     integer;
  v_all       jsonb;
begin
  v_all := jsonb_build_array(
    coalesce(app.brain_resource('financial_documents'), 'financial_documents'),
    coalesce(app.brain_resource('income_entries'), 'income_entries'),
    coalesce(app.brain_resource('expenses'), 'expenses'),
    coalesce(app.brain_resource('purchase_invoices'), 'purchase_invoices'));

  -- ── money in ──
  select coalesce(sum(p.amount) filter (where f.type <> 'proforma'), 0),
         coalesce(sum(p.amount) filter (where f.type = 'proforma'), 0),
         count(*)
    into v_pay_docs, v_pay_adv, v_n_in
    from public.payments p
    join public.financial_documents f on f.id = p.document_id
   where p.org_id = p_org and p.confirmed_at is not null
     -- the proforma's advance, copied onto its tax invoice at conversion
     and not (f.type = 'invoice' and p.method = 'Advance'
              and coalesce(p.note, '') like 'Advance received against proforma %'
              and coalesce(f.payload ->> 'converted_from', '') <> '');

  select coalesce(sum(i.amount) filter (where i.treatment in ('revenue', 'other_income')), 0),
         coalesce(sum(i.amount) filter (where i.treatment = 'capital_in'), 0),
         coalesce(sum(i.amount) filter (where i.treatment not in ('revenue', 'other_income', 'capital_in')), 0),
         v_n_in + count(*)
    into v_book_rev, v_book_cap, v_book_oth, v_n_in
    from public.income_entries i
   where i.org_id = p_org
     and (i.document_id is null
          or not exists (select 1 from public.payments p
                          where p.document_id = i.document_id and p.confirmed_at is not null));

  -- ── money out ──
  select coalesce(sum(e.amount), 0), count(*) into v_exp_paid, v_n_out
    from public.expenses e
   where e.org_id = p_org and coalesce(e.status, 'paid') <> 'pending';

  select coalesce(sum(b.amount_paid), 0), v_n_out + count(*) filter (where b.amount_paid > 0)
    into v_bills, v_n_out
    from public.purchase_invoices b
   where b.org_id = p_org and b.status <> 'void';

  v_in  := v_pay_docs + v_pay_adv + v_book_rev + v_book_cap + v_book_oth;
  v_out := v_exp_paid + v_bills;

  -- ── revenue ──
  select coalesce(sum(coalesce(f.taxable_amount, f.grand_total)), 0) into v_inv_net
    from public.financial_documents f
   where f.org_id = p_org and f.type = 'invoice' and f.status not in ('draft', 'cancelled');

  select coalesce(sum(i.net_amount), 0) into v_direct
    from public.income_entries i
   where i.org_id = p_org and i.document_id is null and i.treatment in ('revenue', 'other_income');

  insert into public.brain_metrics (org_id, key, bucket, value, dims, definition, resource)
  values
    (p_org, 'cash.net', '', v_in - v_out,
     jsonb_build_object('requires', v_all, 'received', v_in, 'paid_out', v_out),
     'NET CASH — the answer to "net cash", "cash position", "how much money have we made or lost '
     'in cash". All money received less all money paid out, all time: cash.received minus '
     'cash.paid_out. The same figure as the Net cash tile on the dashboard. Quote it as given.',
     'financial_documents'),
    (p_org, 'cash.received', '', v_in,
     jsonb_build_object('requires', v_all, 'entries', v_n_in),
     'All money received, all time, gross: confirmed invoice payments, proforma advances and every '
     'cash-book receipt (sales, funding, refunds). Each rupee once — a cash-book line that records an '
     'invoice payment already counted is not added again. Split in cash.received_by_source.',
     'financial_documents'),
    (p_org, 'cash.paid_out', '', v_out,
     jsonb_build_object('requires', v_all, 'entries', v_n_out),
     'All money paid out, all time, gross: expenses actually paid (pending ones excluded) plus what has '
     'been paid against vendor bills. Split in cash.paid_out_by_source.',
     'financial_documents'),
    (p_org, 'cash.received_by_source', 'invoice_payments', v_pay_docs, jsonb_build_object('requires', v_all),
     'Money in: confirmed payments against invoices.', 'financial_documents'),
    (p_org, 'cash.received_by_source', 'proforma_advances', v_pay_adv, jsonb_build_object('requires', v_all),
     'Money in: advances confirmed against proforma invoices.', 'financial_documents'),
    (p_org, 'cash.received_by_source', 'cash_book_revenue', v_book_rev, jsonb_build_object('requires', v_all),
     'Money in: cash-book receipts that are earned revenue (sales, services, training, other income).',
     'financial_documents'),
    (p_org, 'cash.received_by_source', 'cash_book_funding', v_book_cap, jsonb_build_object('requires', v_all),
     'Money in: funding, loans and deposits received. Cash, not revenue.', 'financial_documents'),
    (p_org, 'cash.received_by_source', 'cash_book_other', v_book_oth, jsonb_build_object('requires', v_all),
     'Money in: refunds and other receipts that are neither revenue nor funding.', 'financial_documents'),
    (p_org, 'cash.paid_out_by_source', 'expenses', v_exp_paid, jsonb_build_object('requires', v_all),
     'Money out: expense entries actually paid.', 'financial_documents'),
    (p_org, 'cash.paid_out_by_source', 'vendor_bills', v_bills, jsonb_build_object('requires', v_all),
     'Money out: payments made against vendor (purchase) bills.', 'financial_documents'),
    (p_org, 'revenue.total', '', v_inv_net + v_direct,
     jsonb_build_object('requires', jsonb_build_array(v_all -> 0, v_all -> 1),
                        'invoiced_net', v_inv_net, 'direct_net', v_direct),
     'TOTAL REVENUE — the answer to "total revenue", "how much have we earned", "sales". Everything '
     'earned, all time, net of GST: issued invoices (drafts and cancelled excluded) plus revenue '
     'received without an invoice. Funding and refunds are not revenue and are not in it. Whether the '
     'invoices are paid is a separate question — see revenue.outstanding.',
     'financial_documents');

  -- ── corrections: a draft has not been billed to anyone ──
  update public.brain_metrics m
     set value = s.billed,
         definition = 'Total invoiced, including GST, whether or not it has been paid. Issued invoices '
                      'only: drafts and cancelled invoices are excluded.'
    from (select coalesce(sum(grand_total), 0) as billed
            from public.financial_documents
           where org_id = p_org and type = 'invoice' and status not in ('draft', 'cancelled')) s
   where m.org_id = p_org and m.key = 'revenue.billed' and m.bucket = '';

  update public.brain_metrics m
     set value = s.owed,
         definition = 'Invoiced and not yet collected (grand_total minus amount_paid) on issued invoices. '
                      'Drafts and cancelled invoices are excluded: nobody owes those.'
    from (select coalesce(sum(greatest(grand_total - amount_paid, 0)), 0) as owed
            from public.financial_documents
           where org_id = p_org and type = 'invoice' and status not in ('draft', 'cancelled')) s
   where m.org_id = p_org and m.key = 'revenue.outstanding' and m.bucket = '';

  return 11;
end $fn$;

revoke all on function app.brain_refresh_metrics_totals(uuid) from public;

-- The orchestrator, as 0061 left it, plus the totals group — last, so its
-- corrections land on the rows the core group has just written.
create or replace function app.brain_refresh_metrics(p_org uuid)
returns jsonb language plpgsql set search_path = public, pg_temp as $fn$
declare
  v_res    jsonb;
  v_n      integer := 0;
  v_failed jsonb := '[]'::jsonb;
  v_errors jsonb := '[]'::jsonb;
begin
  v_res := app.brain_refresh_metrics_core(p_org);

  begin
    v_n := v_n + app.brain_refresh_metrics_geo(p_org);
  exception when others then
    v_failed := v_failed || jsonb_build_array('geo');
    v_errors := v_errors || jsonb_build_array(jsonb_build_object('domain', 'metrics.geo', 'error', sqlerrm, 'at', now()));
  end;

  begin
    v_n := v_n + app.brain_refresh_metrics_projects(p_org);
  exception when others then
    v_failed := v_failed || jsonb_build_array('projects');
    v_errors := v_errors || jsonb_build_array(jsonb_build_object('domain', 'metrics.projects', 'error', sqlerrm, 'at', now()));
  end;

  begin
    v_n := v_n + app.brain_refresh_metrics_totals(p_org);
  exception when others then
    v_failed := v_failed || jsonb_build_array('totals');
    v_errors := v_errors || jsonb_build_array(jsonb_build_object('domain', 'metrics.totals', 'error', sqlerrm, 'at', now()));
  end;

  return v_res || jsonb_build_object(
    'metrics', coalesce((v_res->>'metrics')::integer, 0) + v_n,
    'failed_groups', coalesce(v_res->'failed_groups', '[]'::jsonb) || v_failed,
    'errors', coalesce(v_res->'errors', '[]'::jsonb) || v_errors);
end $fn$;

revoke all on function app.brain_refresh_metrics(uuid) from public;

-- payments and purchase_invoices already mark the brain dirty (0034), so a
-- payment or a bill paid refreshes these totals on the next sync.


-- ############################################################################
-- ## 0067_ai_usage_events.sql
-- ############################################################################

-- ============================================================================
-- 0067_ai_usage_events.sql — one row per AI call, for the Usage dashboard.
--
-- usage_counters.ai_messages (0010) is a single running total: it can say
-- "37 of 50" but not when, where or by whom. The Usage page needs all three —
-- a daily chart, the split between Copilot / EdgeBrain / document reading, and
-- who in the team is spending the allowance — so every metered call now also
-- leaves an event here.
--
-- The counter stays the source of truth for the LIMIT. It is atomic and it is
-- what the server enforces; this table is history, written best-effort after
-- the fact, and a missing row must never refuse or bill anything. That is why
-- the page reads the total from usage_counters and only the breakdowns from
-- here, and why history "starts" on the day this migration is applied.
--
-- Written only by the API with the service role. Read by exactly the audience
-- that reads usage_counters — its `usage_counters` row in the permission matrix
-- (0026/0027), which every role holds by default — and
-- nobody can write, edit or delete one from the browser: a usage log the
-- metered party can edit is not a usage log.
-- ============================================================================

create table if not exists public.ai_usage_events (
  id                bigint generated always as identity primary key,
  org_id            uuid not null references public.organizations(id) on delete cascade,
  user_id           uuid references auth.users(id) on delete set null,
  -- Denormalised on purpose: the member list (org_members) is admin-only, and
  -- the Usage page is for everyone. The address the call was made from is
  -- also what a reader expects to see after the person has left.
  actor_email       text,
  surface           text not null check (surface in ('copilot', 'brain', 'library')),
  -- ok      the model was called
  -- blocked refused at the plan limit (usage_counters still moved — 0010
  --         meters before it checks)
  -- failed  the provider returned an error
  outcome           text not null default 'ok' check (outcome in ('ok', 'blocked', 'failed')),
  model             text,
  prompt_tokens     integer check (prompt_tokens is null or prompt_tokens >= 0),
  completion_tokens integer check (completion_tokens is null or completion_tokens >= 0),
  created_at        timestamptz not null default now()
);

create index if not exists ai_usage_events_org_time_idx
  on public.ai_usage_events (org_id, created_at desc);

alter table public.ai_usage_events enable row level security;

drop policy if exists ai_usage_events_select on public.ai_usage_events;
create policy ai_usage_events_select on public.ai_usage_events
  for select to authenticated
  using (app.has_permission(org_id, 'usage_counters', 'view'));

-- 0022 hands authenticated default privileges on new tables; take the writes
-- back so the policy above is not the only thing standing in the way.
revoke all on public.ai_usage_events from anon;
revoke insert, update, delete, truncate on public.ai_usage_events from authenticated;
grant select on public.ai_usage_events to authenticated;
grant all on public.ai_usage_events to service_role;


-- ############################################################################
-- ## 0068_ai_actions.sql
-- ############################################################################

-- ============================================================================
-- 0068_ai_actions.sql — the EdgeAI agent's action log and its audit attribution.
--
-- EdgeAI (api/agent.js) now operates the app: it proposes changes as cards,
-- and executes one only after the user taps Confirm. Two things follow.
--
-- 1. public.ai_actions — one row per proposed change, carrying what was
--    proposed (tool, resolved args, the preview the user saw), what became
--    of it (proposed → confirmed → executed / failed / cancelled / expired /
--    undone) and the before/after state that Undo restores. The row id is
--    the idempotency key for the confirm tap.
--
--    Written ONLY by the API with the service role. The browser may read its
--    own rows (and owner/admin every row in the org, for the AI activity
--    log); nobody may insert, edit or delete one from the client.
--
-- 2. Attribution. The agent writes business rows through PostgREST with the
--    user's own token, so the audit trigger already records the user as the
--    actor. A confirmed write also sends `x-edgeos-agent-action: <id>`, which
--    PostgREST exposes as request.headers; app.write_audit now stamps such
--    rows `via = 'edgeai'` with the action id — but only when that id is a
--    confirmed/executed action belonging to auth.uid(). A client forging the
--    header can at most mislabel its own edit, never anybody else's.
--
-- PREFLIGHT: supabase/checks/agent_preflight.sql. Apply only once it shows
-- app.write_audit unchanged from 0020 (section 86: lf_md5 ee442a92…), no
-- ai_actions collision (18) and no extra audit_log columns (133). If the live
-- body differs, supabase/checks/write_audit_live.sql returns it: whatever it
-- does beyond 0020 must be carried into section 4 below before applying.
--
-- Idempotent: safe to run more than once.
-- ============================================================================

-- ─── 1. The table ────────────────────────────────────────────────────────────

create table if not exists public.ai_actions (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,
  user_id        uuid not null references auth.users(id) on delete cascade,
  chat_id        text,
  message_id     text,
  tool           text not null,
  module         text,
  risk           text not null check (risk in ('low', 'high')),
  args           jsonb not null default '{}'::jsonb,
  target_ref     jsonb,
  preview        jsonb,
  status         text not null default 'proposed'
                 check (status in ('proposed', 'confirmed', 'executed', 'failed', 'cancelled', 'expired', 'undone')),
  before_state   jsonb,
  after_state    jsonb,
  result         jsonb,
  error          text,
  prompt_version text,
  proposed_at    timestamptz not null default now(),
  decided_at     timestamptz,
  executed_at    timestamptz,
  undone_at      timestamptz,
  expires_at     timestamptz not null default (now() + interval '30 minutes'),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists ai_actions_org_time_idx  on public.ai_actions (org_id, proposed_at desc);
create index if not exists ai_actions_user_chat_idx on public.ai_actions (user_id, chat_id, status);

drop trigger if exists ai_actions_touch on public.ai_actions;
create trigger ai_actions_touch before update on public.ai_actions
  for each row execute function app.touch_updated_at();

comment on table public.ai_actions is
  'Every change EdgeAI proposed and what became of it. Written by /api/agent with the service role only.';

-- ─── 2. Permission resource (the 0038 repair pattern, idempotent) ────────────

insert into public.permission_resources (key, label, category, description, actions, sort_order) values
  ('ai_actions', 'AI activity', 'Settings',
   'Changes EdgeAI proposed and made. Everyone sees their own; owners and admins see the whole organization''s.',
   array['view'], 905)
on conflict (key) do update
  set label = excluded.label, category = excluded.category,
      description = excluded.description, actions = excluded.actions;

insert into public.role_permission_defaults (role, resource, can_view, can_create, can_edit, can_delete)
select r.key, 'ai_actions', true, false, false, false
  from public.roles r
on conflict (role, resource) do nothing;

select app.sync_role_permissions(null);

-- ─── 3. Row-level security ───────────────────────────────────────────────────
-- secure_tenant_table enables and forces RLS and builds the matrix policy
-- (view only — the resource's only action). Its select policy is then
-- narrowed to the reader's own rows unless they are an owner or admin.
-- One permissive policy rather than an extra RESTRICTIVE one, because the
-- access-matrix evaluator (tests/02) models permissive policies only.
-- NOTE: re-running secure_tenant_table on this table would widen it again;
-- re-run this block after any such repair.

select app.secure_tenant_table('public.ai_actions'::regclass, 'ai_actions');

drop policy if exists ai_actions_own_rows on public.ai_actions;
drop policy if exists ai_actions_select on public.ai_actions;
create policy ai_actions_select on public.ai_actions
  for select to authenticated
  using (app.has_permission(org_id, 'ai_actions', 'view')
         and (user_id = auth.uid() or app.is_admin(org_id)));

revoke all on public.ai_actions from anon;
revoke insert, update, delete, truncate on public.ai_actions from authenticated;
grant select on public.ai_actions to authenticated;
grant all on public.ai_actions to service_role;

-- ─── 4. Audit attribution ────────────────────────────────────────────────────

alter table public.audit_log add column if not exists via text;
alter table public.audit_log add column if not exists ai_action_id uuid;
comment on column public.audit_log.via is
  'null = written directly by the actor; ''edgeai'' = written by EdgeAI on the actor''s behalf after they confirmed it.';

-- The agent action behind the current request, if it is one this user
-- confirmed. Never raises: an audit row with no attribution beats a failed write.
create or replace function app.agent_action_id()
returns uuid language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_raw text;
  v_id  uuid;
begin
  begin
    v_raw := nullif(current_setting('request.headers', true), '')::json ->> 'x-edgeos-agent-action';
  exception when others then
    return null;
  end;
  if v_raw is null or v_raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  select a.id into v_id
    from public.ai_actions a
   where a.id = v_raw::uuid
     and a.user_id = auth.uid()
     and a.status in ('confirmed', 'executed');
  return v_id;
end $$;

revoke execute on function app.agent_action_id() from public;

-- 0020's trigger, unchanged except for the two attribution columns.
create or replace function app.write_audit()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_org       uuid;
  v_entity    uuid;
  v_action    text;
  v_diff      jsonb := '{}'::jsonb;
  v_old       jsonb;
  v_new       jsonb;
  v_key       text;
  v_ignored   text[] := app.audit_ignored_columns();
  v_agent     uuid;
begin
  if tg_op = 'DELETE' then
    v_old := to_jsonb(old);
    v_new := '{}'::jsonb;
    v_org := (v_old ->> 'org_id')::uuid;
    v_entity := app.audit_entity_id(v_old);
    v_action := tg_table_name || '.delete';
  elsif tg_op = 'INSERT' then
    v_old := '{}'::jsonb;
    v_new := to_jsonb(new);
    v_org := (v_new ->> 'org_id')::uuid;
    v_entity := app.audit_entity_id(v_new);
    v_action := tg_table_name || '.insert';
  else
    v_old := to_jsonb(old);
    v_new := to_jsonb(new);
    v_org := (v_new ->> 'org_id')::uuid;
    v_entity := app.audit_entity_id(v_new);
    v_action := tg_table_name || '.update';
  end if;

  if tg_op = 'UPDATE' then
    for v_key in select jsonb_object_keys(v_new) loop
      if v_key = any(v_ignored) then
        continue;
      end if;
      if (v_new -> v_key) is distinct from (v_old -> v_key) then
        v_diff := v_diff || jsonb_build_object(
          v_key, jsonb_build_object('from', v_old -> v_key, 'to', v_new -> v_key)
        );
      end if;
    end loop;

    if v_diff = '{}'::jsonb then
      return null;
    end if;
  else
    v_diff := jsonb_strip_nulls(jsonb_build_object(
      'name',       coalesce(v_new -> 'name',       v_old -> 'name'),
      'title',      coalesce(v_new -> 'title',      v_old -> 'title'),
      'full_name',  coalesce(v_new -> 'full_name',  v_old -> 'full_name'),
      'doc_number', coalesce(v_new -> 'doc_number', v_old -> 'doc_number'),
      'status',     coalesce(v_new -> 'status',     v_old -> 'status'),
      'amount',     coalesce(v_new -> 'amount',     v_old -> 'amount')
    ));
  end if;

  v_agent := app.agent_action_id();

  insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, diff, via, ai_action_id)
  values (v_org, auth.uid(), v_action, tg_table_name, v_entity, v_diff,
          case when v_agent is not null then 'edgeai' end, v_agent);

  return null;
exception when others then
  raise warning 'audit trigger on % failed: %', tg_table_name, sqlerrm;
  return null;
end $$;

drop trigger if exists ai_actions_audit on public.ai_actions;
create trigger ai_actions_audit after insert or update or delete on public.ai_actions
  for each row execute function app.write_audit();

-- ─── 5. Realtime for what the agent changes ─────────────────────────────────
-- A confirmed change must reach every open screen. orgStore already listens
-- for postgres_changes on these sections, but the live publication (preflight
-- 2026-09-27) carries only the brain, project, timesheet and version tables —
-- so an edit to a task, a client, a cash entry, an invoice, a payment, a bill
-- or a vendor reached other tabs and other people only on reload, whoever made
-- it. Same idempotent block as 0045.
-- Realtime applies each table's RLS, so nobody receives a row they could not read.
do $mig$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;
  foreach t in array array['tasks', 'clients', 'expenses', 'income_entries',
                           'financial_documents', 'payments', 'purchase_invoices', 'vendors'] loop
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $mig$;

