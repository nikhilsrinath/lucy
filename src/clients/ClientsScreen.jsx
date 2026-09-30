import React, { useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useOrg } from '../context/OrgContext';
import { orgStore } from '../services/orgStore';
import { docNumber as docNo } from '../services/documentStore';
import { balanceOf, isOverdue, issuedInvoices } from '../services/financeAnalytics';
import { formatDate, todayIn } from '../shared/dates';
import { canCreateProjects } from '../services/projectService';
import { confirmDialog } from '../services/confirm';
import { customerService } from '../services/customerService';
import { useSectionList } from '../shell/useSectionList';
import { Button, Badge, Card, ListRow, PageHeader, Sheet, Field, Initials, IconTile } from '../design/ui';
import { IconPlus, IconDoc } from '../design/icons';
import { inr } from '../chat/brief';
import { statusOf } from '../money/blanks';
import BusinessNav from '../business/BusinessNav';
import '../money/money.css';
import './clients.css';
import '../business/business.css';
import '../business/business-tabs.css';

/* ══════════════════════════════════════════════════════════════════════════
   Clients — the Business hub's pipeline board and client sheet (BusinessNav
   joins it with the overview and the money tabs), over one `clients` row
   per client (0016), exactly as the CRM and the directory read it:

     column      Lead     In talks     Won       Lost
     stage       lead     contacted    deal      not_deal
     status      lead     contacted    active    lost        (orgStore maps)

   Archived clients stay off the board (a toggle shows them). A stage tap is
   one orgStore update, as a drag on the old board was. Notes append a dated
   line — the same format the agent's add_client_note writes.
   ══════════════════════════════════════════════════════════════════════════ */

const STAGES = [
    { id: 'lead', label: 'Lead', tone: 'b' },
    { id: 'contacted', label: 'In talks', tone: 'a' },
    { id: 'deal', label: 'Won', tone: 'g' },
    { id: 'not_deal', label: 'Lost', tone: 'n' },
];
const place = (c) => [c?.state, c?.address && !c?.state ? String(c.address).split(',').slice(-1)[0].trim() : ''].filter(Boolean)[0] || '';

export default function ClientsScreen() {
    const { activeOrg } = useOrg();
    const orgId = activeOrg?.id || null;
    const [params, setParams] = useSearchParams();
    const leads = useSectionList('crm_leads', orgId);
    const customers = useSectionList('customers', orgId);
    const docs = useSectionList('fin_docs', orgId);
    const [adding, setAdding] = useState(false);
    const [showArchived, setShowArchived] = useState(false);
    const [note, setNote] = useState('');
    const notify = (m) => { setNote(m); setTimeout(() => setNote(''), 2600); };

    const byCustomer = useMemo(() => Object.fromEntries(customers.map((c) => [c.id, c])), [customers]);
    // A client's documents: the customer_id link, else the billed-to name —
    // the directory's own rule (customerService.documentsFor).
    const docsOf = useMemo(() => {
        const FIN = new Set(['invoice', 'quotation', 'proforma']);
        const out = {};
        for (const l of leads) out[l.id] = customerService.documentsFor(docs, byCustomer[l.id] || { id: l.id, clientName: l.name }, FIN);
        for (const c of customers) if (!out[c.id]) out[c.id] = customerService.documentsFor(docs, c, FIN);
        return out;
    }, [docs, leads, customers, byCustomer]);
    const money = useMemo(() => {
        const m = {};
        for (const [id, list] of Object.entries(docsOf)) {
            const inv = issuedInvoices(list);
            if (!inv.length) continue;
            m[id] = {
                owed: inv.reduce((s, d) => s + balanceOf(d), 0),
                paid: inv.reduce((s, d) => s + (Number(d.amount_paid) || 0), 0),
                late: inv.some((d) => isOverdue(d)),
            };
        }
        return m;
    }, [docsOf]);

    const owedTotal = Object.values(money).reduce((s, x) => s + x.owed, 0);
    const owedCount = Object.values(money).filter((x) => x.owed > 0.009).length;
    const archived = customers.filter((c) => c.status === 'archived' || c.archived_at);

    const openId = params.get('client');
    const open = openId ? (leads.find((l) => l.id === openId) || byCustomer[openId]) : null;
    const setOpen = (id) => setParams(id ? { client: id } : {});
    // ?addLead=1 — the Business overview's and the Add sheet's "Lead".
    const addOpen = adding || params.get('addLead') === '1';
    // A lead just added opens its sheet (?client=), which already drops ?addLead.
    const justAdded = useRef(false);
    const closeAdd = () => {
        setAdding(false);
        if (params.has('addLead') && !justAdded.current) setParams({}, { replace: true });
        justAdded.current = false;
    };
    const lateCount = Object.values(money).filter((x) => x.late).length;

    return (
        <div className="sb-scroll nb nbx">
            <div className="sb-page" style={{ maxWidth: 1200 }}>
                <PageHeader title="Business"
                    sub={`Clients · ${owedTotal > 0 ? `${inr(owedTotal)} owed across ${owedCount} ${owedCount === 1 ? 'client' : 'clients'}` : 'nobody owes you money right now'}`}
                    actions={orgStore.can('clients', 'create') && <Button variant="primary" onClick={() => setAdding(true)}><IconPlus /><span className="lbl">Add lead</span></Button>} />
                <BusinessNav counts={{ clients: leads.length, invoices: lateCount || null }} />

                <div className="sb-board">
                    {STAGES.map((s) => {
                        const lane = leads.filter((l) => (l.stage || 'lead') === s.id);
                        return (
                            <section key={s.id} className="sb-lane" aria-label={`${s.label}, ${lane.length}`}>
                                <h4><Badge tone={s.tone} plain>{s.label}</Badge><em>{lane.length}</em></h4>
                                {lane.map((l) => {
                                    const c = byCustomer[l.id];
                                    const m = money[l.id];
                                    return (
                                        <button key={l.id} type="button" className="sb-cd sb-pc" onClick={() => setOpen(l.id)}>
                                            <div className="pt">
                                                <Initials name={l.name} />
                                                <span style={{ minWidth: 0 }}><b>{l.name}</b><small>{place(c) || l.person_name || l.email || ''}</small></span>
                                            </div>
                                            <div className="pf">
                                                <span className={m?.late ? 'late' : undefined}>
                                                    {m?.owed > 0.009 ? `${inr(m.owed)} ${m.late ? 'overdue' : 'owed'}` : l.value ? `Worth ${inr(l.value)}` : lastNote(l.notes) || 'No notes yet'}
                                                </span>
                                            </div>
                                        </button>
                                    );
                                })}
                                {!lane.length && <p className="sb-lane-empty">None</p>}
                            </section>
                        );
                    })}
                </div>

                {archived.length > 0 && (
                    <div style={{ marginTop: 20 }}>
                        <Button variant="ghost" onClick={() => setShowArchived((v) => !v)}>{showArchived ? 'Hide archived' : `Show archived (${archived.length})`}</Button>
                        {showArchived && (
                            <Card list style={{ marginTop: 10 }}>
                                {archived.map((c) => <ListRow key={c.id} lead={<Initials name={c.name} />} title={c.name} sub={place(c)} onClick={() => setOpen(c.id)} />)}
                            </Card>
                        )}
                    </div>
                )}
            </div>

            {open && <ClientSheet key={open.id} lead={open} client={byCustomer[open.id]} docs={docsOf[open.id] || []}
                money={money[open.id]} onClose={() => setOpen(null)} notify={notify} tz={activeOrg?.timezone} />}
            {addOpen && <ClientForm onClose={closeAdd} notify={notify} onCreated={(id) => { justAdded.current = true; setOpen(id); }} />}
            {note && <div className="sb sb-toast nbx-toast" role="status">{note}</div>}
        </div>
    );
}

/**
 * One client row, updated through whichever orgStore view already holds it.
 * The `customers` adapter writes its legacy names first (clientName over
 * name, clientEmail over email…), so both spellings are set; a client that
 * view has not loaded yet goes through the pipeline adapter instead, rather
 * than being written from an empty cache entry.
 */
async function updateClient(id, patch) {
    const both = { ...patch };
    const pairs = [['name', 'clientName'], ['email', 'clientEmail'], ['phone', 'contactPhone'], ['address', 'clientAddress'], ['gstin', 'buyerGSTIN'], ['state', 'buyerState']];
    for (const [a, b] of pairs) if (a in patch) both[b] = patch[a];
    if (orgStore.getItem('customers', id)) return orgStore.updateItem('customers', id, { ...both, updated_at: new Date().toISOString() });
    if (orgStore.getItem('crm_leads', id)) {
        const { status: _s, archived_at: _a, gstin: _g, state: _st, address: _ad, ...rest } = patch;
        if (Object.keys(rest).length) return orgStore.updateItem('crm_leads', id, { ...rest, company_name: rest.name ?? undefined, updated_at: new Date().toISOString() });
    }
    throw new Error('This client is still loading. Try again in a moment.');
}

const lastNote = (notes) => String(notes || '').trim().split('\n').filter(Boolean).slice(-1)[0] || '';

function ClientSheet({ lead, client, docs, money, onClose, notify, tz }) {
    const navigate = useNavigate();
    const [editing, setEditing] = useState(false);
    const [noteText, setNoteText] = useState('');
    const [error, setError] = useState('');
    const canEdit = orgStore.can('clients', 'edit');
    const stage = lead.stage || (client?.status === 'active' ? 'deal' : client?.status === 'lost' ? 'not_deal' : client?.status) || 'lead';
    const at = STAGES.findIndex((s) => s.id === stage);
    const notes = String(lead.notes ?? client?.notes ?? '').trim();
    const isArchived = client?.status === 'archived' || client?.archived_at;

    const move = async (to) => {
        if (to === stage || !canEdit) return;
        setError('');
        try {
            await orgStore.updateItem('crm_leads', lead.id, { stage: to, updated_at: new Date().toISOString() });
            notify(`${lead.name} moved to ${STAGES.find((s) => s.id === to).label}.`);
        } catch (err) { setError(err.message); }
    };
    const addNote = async () => {
        const text = noteText.trim();
        if (!text) return;
        const line = `${formatDate(todayIn(tz))} — ${text}`;
        try {
            await updateClient(lead.id, { notes: notes ? `${notes.replace(/\s+$/, '')}\n${line}` : line });
            setNoteText('');
            notify('Note added.');
        } catch (err) { setError(err.message); }
    };
    const archive = async () => {
        if (!(await confirmDialog({ title: isArchived ? 'Restore client' : 'Archive client', message: isArchived ? `Put ${lead.name} back on the board?` : `Archive ${lead.name}? Their documents stay; they leave the board.`, confirmLabel: isArchived ? 'Restore' : 'Archive', tone: 'default' }))) return;
        try {
            await updateClient(lead.id, isArchived ? { status: 'lead', archived_at: null } : { status: 'archived', archived_at: new Date().toISOString() });
            notify(isArchived ? 'Client restored.' : 'Client archived.');
            onClose();
        } catch (err) { setError(err.message); }
    };
    const remove = async () => {
        if (!(await confirmDialog({ title: 'Delete client', message: `Delete ${lead.name}? This cannot be undone.` }))) return;
        try { await orgStore.removeItem('customers', lead.id); notify('Client deleted.'); onClose(); }
        catch (err) { setError(/foreign key|violates/i.test(err.message) ? 'This client has documents, so it can be archived but not deleted.' : err.message); }
    };

    return (
        <Sheet open onClose={onClose} className="nb-sheet" title="Client">
            {error && <div className="sb-err" role="alert">{error}</div>}
            <Card className="sb-dsum">
                <div className="top2">
                    <Initials name={lead.name} style={{ width: 44, height: 44, borderRadius: 12, fontSize: 14 }} />
                    <div><b>{lead.name}</b><small>{[lead.person_name || client?.person_name, place(client), client?.gstin ? `GSTIN ${client.gstin}` : ''].filter(Boolean).join(' · ') || 'No details yet'}</small></div>
                </div>
                {!isArchived && (
                    <div className="sb-prog" role="group" aria-label="Stage">
                        {STAGES.map((s, i) => (
                            <button key={s.id} type="button" disabled={!canEdit} aria-pressed={s.id === stage}
                                className={(stage === 'not_deal' ? i === 3 : i <= at) ? 'on' : undefined} onClick={() => move(s.id)}>
                                <i />{s.label}
                            </button>
                        ))}
                    </div>
                )}
                <div className="sb-two">
                    <div><small>Paid to date</small><b>{inr(money?.paid || 0)}</b></div>
                    <div><small>Outstanding</small><b style={money?.owed > 0.009 ? { color: 'var(--r-tx)' } : undefined}>{inr(money?.owed || 0)}</b></div>
                </div>
            </Card>

            <div className="sb-dsec">
                <h5>Documents</h5>
                <Card list>
                    {!docs.length && <div className="sb-lr"><span className="t"><small>No documents yet</small></span></div>}
                    {docs.map((d) => {
                        const [tone, label] = statusOf(d);
                        return (
                            <ListRow key={d.id} lead={<IconTile><IconDoc /></IconTile>} onClick={() => navigate(`/money/invoices?doc=${d.id}`)}
                                title={`${d.type === 'quotation' ? 'Quote' : d.type === 'proforma' ? 'Proforma' : 'Invoice'} ${docNo(d) || '(draft)'}`}
                                sub={d.issue_date ? formatDate(String(d.issue_date).slice(0, 10)) : ''}
                                trail={<Badge tone={tone} className="hide-m">{label}</Badge>} amount={inr(d.grand_total ?? d.amount)} />
                        );
                    })}
                </Card>
            </div>

            {notes && (
                <div className="sb-note" style={{ whiteSpace: 'pre-wrap' }}>{notes}<small>Notes</small></div>
            )}
            {canEdit && (
                <div className="sb-inline">
                    <Field label="Add a note"><input value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="e.g. Budget approved for Q4" onKeyDown={(e) => { if (e.key === 'Enter') addNote(); }} /></Field>
                    <Button onClick={addNote} disabled={!noteText.trim()}>Add</Button>
                </div>
            )}

            <div className="sb-dacts">
                {orgStore.can('financial_documents', 'create') && <Button variant="primary" onClick={() => navigate('/money/invoices/new?type=quotation')}>New quote</Button>}
                {orgStore.can('financial_documents', 'create') && <Button onClick={() => navigate('/money/invoices/new?type=invoice', { state: { clientId: lead.id } })}>New invoice</Button>}
                {canCreateProjects() && <Button onClick={() => navigate(`/work?newProject=1&client=${lead.id}`)}>Start project</Button>}
                {canEdit && <Button onClick={() => setEditing(true)}>Edit details</Button>}
                {canEdit && <Button variant="ghost" onClick={archive}>{isArchived ? 'Restore' : 'Archive'}</Button>}
                {orgStore.can('clients', 'delete') && !docs.length && <Button variant="danger" onClick={remove}>Delete</Button>}
            </div>
            {editing && <ClientForm existing={{ ...client, ...lead, name: lead.name }} onClose={() => setEditing(false)} notify={notify} />}
        </Sheet>
    );
}

/** Add a lead, or edit a client's details. */
function ClientForm({ existing, onClose, notify, onCreated }) {
    const [f, setF] = useState(() => ({
        name: existing?.name || '', person_name: existing?.person_name || '', email: existing?.email || '',
        phone: existing?.phone || '', gstin: existing?.gstin || '', state: existing?.state || '', address: existing?.address || '',
        notes: '',
    }));
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const set = (k, v) => setF((x) => ({ ...x, [k]: v }));

    const save = async () => {
        if (!f.name.trim() && !f.person_name.trim()) { setError('Give the company or the person a name.'); return; }
        const gstin = f.gstin.trim().toUpperCase();
        if (gstin && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(gstin)) { setError('GSTIN must be 15 letters and digits.'); return; }
        setSaving(true);
        setError('');
        const now = new Date().toISOString();
        try {
            if (existing?.id) {
                await updateClient(existing.id, {
                    name: f.name.trim() || f.person_name.trim(), person_name: f.person_name, email: f.email, phone: f.phone,
                    gstin, state: f.state, address: f.address,
                });
                notify('Details saved.');
            } else {
                // A lead is added through the pipeline's adapter, as the board did.
                const row = await orgStore.addItem('crm_leads', {
                    company_name: f.name.trim(), person_name: f.person_name, email: f.email, phone: f.phone,
                    notes: f.notes, stage: 'lead', created_at: now, updated_at: now,
                });
                // GSTIN, state and address are columns the pipeline adapter
                // does not carry; they go on through the directory's, in full
                // so nothing is taken from an empty cache entry.
                if (row?.id && (gstin || f.state || f.address)) {
                    const name = f.name.trim() || f.person_name.trim();
                    await orgStore.updateItem('customers', row.id, {
                        name, clientName: name, person_name: f.person_name, email: f.email, clientEmail: f.email,
                        phone: f.phone, contactPhone: f.phone, gstin, buyerGSTIN: gstin, state: f.state, buyerState: f.state,
                        address: f.address, clientAddress: f.address, notes: f.notes, status: 'lead', source: 'crm', updated_at: now,
                    });
                }
                notify('Lead added.');
                if (row?.id) onCreated?.(row.id);
            }
            onClose();
        } catch (err) { setError(err.message); }
        finally { setSaving(false); }
    };

    return (
        <Sheet open onClose={onClose} className="nb-sheet" title={existing?.id ? 'Edit client' : 'Add lead'}
            footer={<Button variant="primary" block onClick={save} disabled={saving}>{saving ? 'Saving…' : existing?.id ? 'Save' : 'Add lead'}</Button>}>
            {error && <div className="sb-err" role="alert">{error}</div>}
            <Field label="Company"><input value={f.name} data-autofocus onChange={(e) => set('name', e.target.value)} /></Field>
            <div className="sb-grid2">
                <Field label="Contact person"><input value={f.person_name} onChange={(e) => set('person_name', e.target.value)} /></Field>
                <Field label="Email"><input type="email" value={f.email} onChange={(e) => set('email', e.target.value)} /></Field>
                <Field label="Phone"><input type="tel" value={f.phone} onChange={(e) => set('phone', e.target.value)} /></Field>
                <Field label="GSTIN"><input value={f.gstin} maxLength={15} onChange={(e) => set('gstin', e.target.value.toUpperCase())} /></Field>
                <Field label="State"><input value={f.state} onChange={(e) => set('state', e.target.value)} /></Field>
            </div>
            <Field label="Address"><textarea rows={2} value={f.address} onChange={(e) => set('address', e.target.value)} /></Field>
            {!existing?.id && <Field label="Notes"><textarea rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Where you met, what they need" /></Field>}
        </Sheet>
    );
}
