-- ============================================================================
-- EdgeOS · the agent's finance writes: totals agree, and the status writes pass the version guard
--
-- EdgeAI shows the total of an invoice before it exists, computed by
-- documentTotals() in src/shared/finDocs.js. The stored figure comes from
-- app.recompute_document_totals() (0002). This is the same fixture as
-- api/_lib/agent/finance.test.js, with the same expected numbers, so the two
-- cannot drift apart: a change to either rounding rule fails one of them.
-- ============================================================================

\set QUIET on
\pset pager off
\pset tuples_only on
set client_min_messages = notice;

begin;

create or replace function pg_temp.check(p_cond boolean, p_label text) returns void language plpgsql as $$
begin
  if coalesce(p_cond, false) then raise notice '  PASS  %', p_label;
  else raise exception 'FAIL  %', p_label; end if;
end $$;

insert into auth.users (id, email) values ('e1400000-0000-0000-0000-000000000001', 'owner@t.test');
insert into organizations (id, company_name, owner_uid)
values ('e1410000-0000-0000-0000-00000000000a', 'Org T', 'e1400000-0000-0000-0000-000000000001');

insert into financial_documents (id, org_id, type, status, doc_number, bill_to_name,
                                 discount_type, discount_value, making_charges, gst_enabled, gst_rate)
values ('e1420000-0000-0000-0000-000000000001', 'e1410000-0000-0000-0000-00000000000a', 'invoice', 'draft',
        'T-1', 'Client', 'percent', 10, 150, true, 18);
insert into document_line_items (document_id, org_id, position, description, quantity, rate) values
  ('e1420000-0000-0000-0000-000000000001', 'e1410000-0000-0000-0000-00000000000a', 0, 'A', 3, 1234.56),
  ('e1420000-0000-0000-0000-000000000001', 'e1410000-0000-0000-0000-00000000000a', 1, 'B', 1, 999.99),
  ('e1420000-0000-0000-0000-000000000001', 'e1410000-0000-0000-0000-00000000000a', 2, 'C', 2.5, 333.33);

select pg_temp.check(subtotal = 5537.00 and discount_amount = 553.70 and taxable_amount = 5133.30
                     and gst_amount = 923.99 and grand_total = 6057.29,
       format('totals match documentTotals(): %s / %s / %s / %s / %s',
              subtotal, discount_amount, taxable_amount, gst_amount, grand_total))
  from financial_documents where id = 'e1420000-0000-0000-0000-000000000001';

-- A flat discount larger than the subtotal stops at the subtotal; no GST when disabled.
insert into financial_documents (id, org_id, type, status, doc_number, bill_to_name,
                                 discount_type, discount_value, gst_enabled, gst_rate)
values ('e1420000-0000-0000-0000-000000000002', 'e1410000-0000-0000-0000-00000000000a', 'invoice', 'draft',
        'T-2', 'Client', 'flat', 500, false, 18);
insert into document_line_items (document_id, org_id, position, description, quantity, rate)
values ('e1420000-0000-0000-0000-000000000002', 'e1410000-0000-0000-0000-00000000000a', 0, 'A', 1, 100);
select pg_temp.check(subtotal = 100 and discount_amount = 100 and taxable_amount = 0 and gst_amount = 0 and grand_total = 0,
       'flat discount capped, GST off')
  from financial_documents where id = 'e1420000-0000-0000-0000-000000000002';

-- ── The agent's status writes, as a member, through the version guard (0064) ──
create or replace function pg_temp.err_as(p_user uuid, p_sql text) returns text language plpgsql as $f$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user)::text, true);
  perform set_config('role', 'authenticated', true);
  begin
    execute p_sql;
    reset role;
    return null;
  exception when others then
    reset role;
    return sqlerrm;
  end;
end $f$;

insert into auth.users (id, email) values ('e1400000-0000-0000-0000-000000000002', 'member@t.test');
insert into memberships (org_id, user_id, role)
values ('e1410000-0000-0000-0000-00000000000a', 'e1400000-0000-0000-0000-000000000002', 'member');

-- issue_document: draft → sent takes version 1.
select pg_temp.check(pg_temp.err_as('e1400000-0000-0000-0000-000000000002',
  $q$update financial_documents set status = 'sent' where id = 'e1420000-0000-0000-0000-000000000001'$q$) is null,
  'issue: a member can move a draft to sent');
-- (Invoices are not versioned — they are cancelled, never edited or deleted.
-- Quotations and proformas are: the quotation below takes v1 when sent.)

-- convert_quotation: an accepted (locked) quotation marked converted, with
-- converted_to added to its stored payload — the exempt response keys.
insert into financial_documents (id, org_id, type, status, doc_number, bill_to_name, payload)
values ('e1420000-0000-0000-0000-000000000003', 'e1410000-0000-0000-0000-00000000000a', 'quotation', 'draft',
        'T-3', 'Client', '{"title": "Quotation"}');
insert into document_line_items (document_id, org_id, position, description, quantity, rate)
values ('e1420000-0000-0000-0000-000000000003', 'e1410000-0000-0000-0000-00000000000a', 0, 'A', 1, 1000);
select pg_temp.check(pg_temp.err_as('e1400000-0000-0000-0000-000000000002',
  $q$update financial_documents set status = 'sent' where id = 'e1420000-0000-0000-0000-000000000003'$q$) is null,
  'issue: a member sends a quotation draft');
select pg_temp.check(current_version_id is not null, 'issue: sending the quotation took version 1')
  from financial_documents where id = 'e1420000-0000-0000-0000-000000000003';
update financial_documents set status = 'accepted' where id = 'e1420000-0000-0000-0000-000000000003';
select pg_temp.check(locked_version_id is not null, 'convert: the accepted quotation is locked')
  from financial_documents where id = 'e1420000-0000-0000-0000-000000000003';
select pg_temp.check(pg_temp.err_as('e1400000-0000-0000-0000-000000000002',
  $q$update financial_documents set status = 'converted',
       payload = payload || '{"converted_to": "e1420000-0000-0000-0000-000000000009"}'
     where id = 'e1420000-0000-0000-0000-000000000003'$q$) is null,
  'convert: status + converted_to pass the guard on a locked quotation');
select pg_temp.check(pg_temp.err_as('e1400000-0000-0000-0000-000000000002',
  $q$update financial_documents set payload = payload || '{"cancel_reason": "x"}'
     where id = 'e1420000-0000-0000-0000-000000000003'$q$) like '%DOCUMENT_%',
  'a content key in the payload of a sent document IS refused (why cancel writes status only)');

-- cancel_financial_document: status only, on a sent document.
select pg_temp.check(pg_temp.err_as('e1400000-0000-0000-0000-000000000002',
  $q$update financial_documents set status = 'cancelled' where id = 'e1420000-0000-0000-0000-000000000001'$q$) is null,
  'cancel: a member can cancel a sent invoice');

rollback;
