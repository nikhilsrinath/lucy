import React, { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useOrg } from '../context/OrgContext';
import { useAuth } from '../context/AuthContext';
import { orgStore } from '../services/orgStore';
import { storageService } from '../services/storageService';
import { documentStore } from '../services/documentStore';
import { emailService } from '../services/emailService';
import { createPortalLink } from '../services/portalService';
import { portalAccessService } from '../services/portalAccessService';
import { confirmDialog } from '../services/confirm';
import { useSectionList } from '../shell/useSectionList';
import { Button, Badge, Card, ListRow, PageHeader, Sheet, Field, Segmented, PixelAvatar, IconTile } from '../design/ui';
import { personAvatar } from '../design/personas';
import { IconDoc, IconPlus, IconChevronRight } from '../design/icons';
import { inr } from '../chat/brief';
import '../money/money.css';

/* ══════════════════════════════════════════════════════════════════════════
   Team — people and their letters.

   People are the employees section (exited people under "Past"). Pay shows
   only where the database returns it (employee_compensation is owner/admin
   under RLS). Letters are the records table: offer letters and NDAs are
   written in their own editors (/team/letters/:kind/new); certificates and
   MoUs already issued stay listed and downloadable, read-only. Status is the
   portal's: sent → opened → accepted / declined.
   ══════════════════════════════════════════════════════════════════════════ */

const KIND = { offer: 'Offer letter', nda: 'NDA', certificate: 'Certificate', mou: 'MoU', role_change: 'Role change', termination: 'Termination notice' };
const LETTER_STATUS = {
    draft: ['n', 'Draft'], pending: ['n', 'Not sent'], sent: ['a', 'Sent'], viewed: ['b', 'Opened'],
    signed: ['g', 'Signed'], accepted: ['g', 'Accepted'], acknowledged: ['g', 'Acknowledged'], fully_signed: ['g', 'Signed'],
    declined: ['r', 'Declined'], cancelled: ['n', 'Cancelled'], issued: ['g', 'Issued'],
};
const letterStatus = (r) => LETTER_STATUS[r.status] || ['n', r.status || 'Draft'];
const fmt = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const TYPE_LABEL = { fulltime: 'Full-time', parttime: 'Part-time', intern: 'Intern', internship: 'Intern', contract: 'Contract', collaboration: 'Collaboration' };

export default function TeamScreen() {
    const { activeOrg } = useOrg();
    const orgId = activeOrg?.id || null;
    const navigate = useNavigate();
    const [params, setParams] = useSearchParams();
    const people = useSectionList('employees', orgId);
    const past = useSectionList('ex_employees', orgId);
    const records = useSectionList('records', orgId);
    const [view, setView] = useState('current');
    const [adding, setAdding] = useState(false);
    const [letter, setLetter] = useState(null);
    const [note, setNote] = useState('');
    const notify = (m) => { setNote(m); setTimeout(() => setNote(''), 2600); };

    const letters = useMemo(() => records
        .filter((r) => KIND[r.type])
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))), [records]);
    const personId = params.get('person');
    const person = personId ? (people.find((p) => p.id === personId) || past.find((p) => p.id === personId)) : null;
    const openAdd = adding || params.get('addPerson') === '1';
    const closeAdd = () => { setAdding(false); if (params.has('addPerson')) setParams({}, { replace: true }); };
    const list = view === 'current' ? people : past;
    const joining = people.filter((p) => p.startDate && p.startDate > new Date().toISOString().slice(0, 10));

    return (
        <div className="sb-scroll">
            <div className="sb-page">
                <PageHeader title="Team"
                    sub={`${people.length} ${people.length === 1 ? 'person' : 'people'}${joining.length ? `. ${joining[0].name.split(' ')[0]} joins ${fmt(joining[0].startDate)}.` : ''}`}
                    actions={orgStore.can('records', 'create') && (
                        <>
                            <Button onClick={() => navigate('/team/letters/nda/new')}><IconDoc size={14} /><span className="lbl">NDA</span></Button>
                            <Button variant="primary" onClick={() => navigate('/team/letters/offer/new')}><IconPlus /><span className="lbl">Offer letter</span></Button>
                        </>
                    )} />

                <div className="sb-split">
                    <div>
                        <div className="sb-lh" style={{ alignItems: 'center' }}>
                            <span>People</span>
                            {past.length > 0 && <Segmented label="People" value={view} onChange={setView} options={[{ value: 'current', label: 'Current' }, { value: 'past', label: `Past ${past.length}` }]} />}
                        </div>
                        <Card list>
                            {list.map((p) => (
                                <ListRow key={p.id} onClick={() => setParams({ person: p.id })}
                                    lead={<PixelAvatar spec={personAvatar(p.name)} round size={36} />}
                                    title={p.is_owner ? `${p.name} (owner)` : p.name}
                                    sub={[p.role, view === 'past' ? `Left ${fmt(p.exited_at)}` : p.startDate ? (p.startDate > new Date().toISOString().slice(0, 10) ? `Joins ${fmt(p.startDate)}` : `Since ${fmt(p.startDate)}`) : ''].filter(Boolean).join(' · ')}
                                    trail={<span style={{ color: 'var(--faint)' }}><IconChevronRight /></span>} />
                            ))}
                            {!list.length && <div className="sb-empty">{view === 'past' ? 'No one has left.' : 'No one yet.'}</div>}
                        </Card>
                        {orgStore.can('employees', 'create') && view === 'current' && (
                            <div style={{ marginTop: 12 }}><Button variant="ghost" onClick={() => setAdding(true)}><IconPlus /> Add a person</Button></div>
                        )}
                    </div>
                    <div>
                        <div className="sb-lh"><span>Letters</span><span>{letters.length}</span></div>
                        <Card list>
                            {letters.slice(0, 40).map((r) => {
                                const [tone, label] = letterStatus(r);
                                return (
                                    <ListRow key={r.id} onClick={() => setLetter(r)} lead={<IconTile><IconDoc /></IconTile>}
                                        title={KIND[r.type]} sub={`${r.issued_to || 'Unaddressed'} · ${fmt(r.issue_date || r.created_at)}`}
                                        trail={<Badge tone={tone}>{label}</Badge>} />
                                );
                            })}
                            {!letters.length && <div className="sb-empty">No letters yet.</div>}
                        </Card>
                    </div>
                </div>
            </div>

            {person && <PersonSheet key={person.id} person={person} letters={letters.filter((r) => r.employee_id === person.id || (person.email && r.recipient_email === person.email))}
                onClose={() => setParams({})} onLetter={setLetter} notify={notify} />}
            {letter && <LetterSheet letter={letter} onClose={() => setLetter(null)} notify={notify} />}
            {openAdd && <PersonForm onClose={closeAdd} notify={notify} />}
            {note && <div className="sb sb-toast" role="status">{note}</div>}
        </div>
    );
}

function PersonSheet({ person, letters, onClose, onLetter, notify }) {
    const [editing, setEditing] = useState(false);
    const { activeOrg } = useOrg();
    const exited = !!person.exited_at;
    const pay = person.salary !== undefined && person.salary !== null && person.salary !== ''
        ? (person.isPaid === false ? 'Unpaid' : `${inr(person.salary)} / ${String(person.paymentFrequency || 'month').toLowerCase().replace('monthly', 'month').replace('yearly', 'year')}`)
        : null;
    const exit = async () => {
        if (!(await confirmDialog({ title: 'Mark as left', message: `Mark ${person.name} as having left? Their portal access is revoked. Their tasks and documents stay.`, confirmLabel: 'Mark as left' }))) return;
        try {
            await storageService.deleteEmployee(person.id, activeOrg?.id, 'Left the company');
            notify(`${person.name} marked as left.`);
            onClose();
        } catch (err) { notify(err.message); }
    };
    return (
        <Sheet open onClose={onClose} title="Person">
            <Card className="sb-dsum">
                <div className="top2">
                    <PixelAvatar spec={personAvatar(person.name)} round size={52} />
                    <div><b>{person.name}</b><small>{[person.role, person.department, TYPE_LABEL[person.offerType]].filter(Boolean).join(' · ')}</small></div>
                </div>
                <div className="sb-two">
                    <div><small>{exited ? 'Left' : 'Joined'}</small><b style={{ fontSize: 14 }}>{fmt(exited ? person.exited_at : person.startDate) || '—'}</b></div>
                    <div><small>Pay{pay ? ', visible to admins' : ''}</small><b style={{ fontSize: 14 }}>{pay || 'Not shown to your role'}</b></div>
                </div>
            </Card>
            {(person.email || person.phone) && (
                <Card list>
                    {person.email && <div className="sb-kvr"><span>Email</span><span>{person.email}</span></div>}
                    {person.phone && <div className="sb-kvr"><span>Phone</span><span>{person.phone}</span></div>}
                </Card>
            )}
            <div className="sb-dsec">
                <h5>Letters</h5>
                <Card list>
                    {letters.map((r) => {
                        const [tone, label] = letterStatus(r);
                        return <ListRow key={r.id} onClick={() => onLetter(r)} title={KIND[r.type]} sub={fmt(r.issue_date || r.created_at)} trail={<Badge tone={tone}>{label}</Badge>} />;
                    })}
                    {!letters.length && <div className="sb-lr"><span className="t"><small>No letters yet</small></span></div>}
                </Card>
            </div>
            {!exited && orgStore.can('employees', 'edit') && (
                <div className="sb-dacts">
                    <Button variant="primary" onClick={() => setEditing(true)}>Edit details</Button>
                    {!person.user_id && person.email && !person.is_owner && (
                        <Button onClick={async () => {
                            try {
                                const r = await portalAccessService.invite(person.id, { orgProfile: activeOrg });
                                if (r.sent) notify(`Portal invite sent to ${r.email}.`);
                                else {
                                    // The invite exists even when the email fails: hand over the link.
                                    await navigator.clipboard.writeText(r.link).catch(() => {});
                                    notify(`${r.sendError} The invite link is copied instead.`);
                                }
                            } catch (e) { notify(e.message || 'The invite could not be sent.'); }
                        }}>Invite to portal</Button>
                    )}
                    {!person.is_owner && <Button variant="danger" onClick={exit}>Mark as left</Button>}
                </div>
            )}
            {editing && <PersonForm existing={person} onClose={() => setEditing(false)} notify={notify} />}
        </Sheet>
    );
}

function LetterSheet({ letter, onClose, notify }) {
    const { activeOrg } = useOrg();
    const [busy, setBusy] = useState('');
    const [tone, label] = letterStatus(letter);
    const readOnlyKind = letter.type === 'certificate' || letter.type === 'mou';
    const link = async () => (await createPortalLink({ orgId: activeOrg?.id, documentId: letter.id, recipientEmail: letter.recipient_email })).url;
    const run = async (key, fn) => {
        setBusy(key);
        try { const m = await fn(); if (m) notify(m); } catch (err) { notify(err.message || 'That did not work.'); } finally { setBusy(''); }
    };
    const download = () => run('pdf', async () => {
        const { pdfService } = await import('../services/pdfService');
        const d = letter.data || letter;
        if (letter.type === 'offer') await pdfService.generateOfferLetter(d);
        else if (letter.type === 'certificate') pdfService.generateCertificate(d);
        else if (letter.type === 'nda') await pdfService.generateNda(d);
        else if (letter.type === 'mou') await pdfService.generateMoU(d);
        else throw new Error('This kind of letter has no PDF.');
        return '';
    });
    const email = () => run('email', async () => {
        if (!letter.recipient_email) throw new Error('No email address saved for this person.');
        const result = await emailService.sendPortalLink({
            recipientEmail: letter.recipient_email, recipientName: letter.issued_to, role: letter.new_role || letter.role,
            companyName: letter.company_profile?.company_name || activeOrg?.company_name || 'Company',
            portalUrl: await link(), deadline: letter.valid_until || letter.effective_date, orgProfile: activeOrg,
        });
        if (!result.success) throw new Error(result.message || 'The email could not be sent.');
        // Sending is what moves a letter out of draft (as the tracker did).
        if (['draft', 'pending'].includes(letter.status)) {
            documentStore.setContext(activeOrg?.id);
            await documentStore.updateStatus(letter.id, 'sent').catch(() => {});
        }
        return `Sent to ${letter.recipient_email}.`;
    });
    return (
        <Sheet open onClose={onClose} title={KIND[letter.type]}>
            <Card className="sb-dsum">
                <div className="top2">
                    <div><b>{letter.issued_to || 'Unaddressed'}</b><small>{[letter.doc_number, fmt(letter.issue_date || letter.created_at)].filter(Boolean).join(' · ')}</small></div>
                    <Badge tone={tone}>{label}</Badge>
                </div>
            </Card>
            {readOnlyKind && <div className="sb-note b">New {KIND[letter.type].toLowerCase()}s aren't made here any more. This one stays available to download.</div>}
            <div className="sb-dacts">
                <Button variant="primary" onClick={download} disabled={!!busy}>{busy === 'pdf' ? 'Preparing…' : 'Download PDF'}</Button>
                {!readOnlyKind && <Button onClick={() => run('copy', async () => { await navigator.clipboard.writeText(await link()); return 'Link copied. It opens only this letter.'; })} disabled={!!busy}>Copy signing link</Button>}
                {letter.type === 'offer' && letter.recipient_email && <Button onClick={email} disabled={!!busy}>{busy === 'email' ? 'Sending…' : 'Email the link'}</Button>}
                {!readOnlyKind && <Button onClick={() => run('view', async () => { window.open(await link(), '_blank', 'noopener'); return ''; })} disabled={!!busy}>Their view</Button>}
            </div>
        </Sheet>
    );
}

const TYPES = [{ value: 'fulltime', label: 'Full-time' }, { value: 'parttime', label: 'Part-time' }, { value: 'internship', label: 'Intern' }, { value: 'collaboration', label: 'Collab' }];

/**
 * Add or edit a person (decision D7). Adding files an accepted offer record
 * with them, exactly as the old employee form did, so the Recruitment status
 * stays consistent and the acceptance sync never creates them twice.
 */
function PersonForm({ existing, onClose, notify }) {
    const { activeOrg } = useOrg();
    const { user } = useAuth();
    const org = activeOrg || {};
    const [f, setF] = useState(() => ({
        offerType: existing?.offerType === 'intern' ? 'internship' : existing?.offerType || 'fulltime',
        studentName: existing?.name || '', email: existing?.email || '', phone: existing?.phone || '',
        role: existing?.role || '', department: existing?.department || '', startDate: existing?.startDate || '',
        stipend: existing?.salary ?? '', isPaid: existing?.isPaid ?? true, currency: existing?.currency || 'INR',
        paymentFrequency: existing?.paymentFrequency || 'Monthly',
    }));
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const set = (k) => (v) => setF((x) => ({ ...x, [k]: v?.target ? v.target.value : v }));

    const save = async () => {
        if (!f.studentName.trim() || !f.email.trim() || !f.role.trim() || !f.startDate) { setError('Name, email, role and start date are needed.'); return; }
        setSaving(true);
        setError('');
        try {
            if (existing?.id) {
                await storageService.updateEmployee(existing.id, { ...existing, ...f }, activeOrg?.id);
                notify('Details saved.');
            } else {
                const form = {
                    ...f,
                    companyName: org.company_name || '', companyAddress: org.company_address || '', companyLogo: org.logo_url || null,
                    cin: org.cin || '', companyWebsite: org.company_website || '',
                    authorizedPersonName: org.owner_full_name || '', authorizedPersonDesignation: org.document_designation || '',
                    contactEmail: org.company_email || '', contactPhone: org.company_phone || '',
                    signature: org.signature_url || null, stampType: org.stamp_type || 'generated', stampCity: org.stamp_city || '', showStamp: true,
                };
                const saved = await storageService.saveEmployee(form, activeOrg?.id);
                await storageService.save({ ...form, source: 'employee_form', employee_synced: true }, 'offer', activeOrg?.id, user?.id,
                    { status: 'accepted', employee_id: saved?.id || null });
                notify(`${f.studentName} is on the team.`);
            }
            onClose();
        } catch (err) { setError(err.message); }
        finally { setSaving(false); }
    };

    return (
        <Sheet open onClose={onClose} title={existing ? 'Edit person' : 'Add a person'}
            footer={<Button variant="primary" block onClick={save} disabled={saving}>{saving ? 'Saving…' : existing ? 'Save' : 'Add to the team'}</Button>}>
            {error && <div className="sb-err" role="alert">{error}</div>}
            {!existing && <div className="sb-note b">To hire with a signed offer, use Offer letter instead. This adds someone who has already joined.</div>}
            <div className="sb-field"><label>Type</label><Segmented block label="Type" value={f.offerType} onChange={set('offerType')} options={TYPES} /></div>
            <div className="sb-grid2">
                <Field label="Name"><input value={f.studentName} data-autofocus onChange={set('studentName')} /></Field>
                <Field label="Email"><input type="email" value={f.email} onChange={set('email')} /></Field>
                <Field label="Role"><input value={f.role} onChange={set('role')} placeholder="e.g. Designer" /></Field>
                <Field label="Department"><input value={f.department} onChange={set('department')} /></Field>
                <Field label="Phone"><input type="tel" value={f.phone} onChange={set('phone')} /></Field>
                <Field label="Start date"><input type="date" value={f.startDate} onChange={set('startDate')} /></Field>
                <Field label={`Pay (${f.currency})`} hint="Only owners and admins can see pay.">
                    <input type="number" inputMode="decimal" min="0" value={f.stipend} onChange={set('stipend')} />
                </Field>
                <Field label="Per" select>
                    <select value={f.paymentFrequency} onChange={set('paymentFrequency')}>
                        {['Monthly', 'Yearly', 'Weekly', 'Hourly', 'One-time'].map((x) => <option key={x}>{x}</option>)}
                    </select>
                </Field>
            </div>
        </Sheet>
    );
}
