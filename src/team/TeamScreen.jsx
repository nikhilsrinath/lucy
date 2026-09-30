import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
import { telegramApi, tgName } from '../services/telegramService';
import TelegramLinkSheet from '../settings/TelegramLinkSheet';
import { useSectionList } from '../shell/useSectionList';
import { Button, Badge, Card, ListRow, Sheet, Field, Segmented, PixelAvatar } from '../design/ui';
import { personAvatar } from '../design/personas';
import { IconDoc, IconPlus, IconSparkle, IconLock } from '../design/icons';
import { useAssistant } from '../components/assistant/assistantStore';
import { useCofounder } from '../design/useCofounder';
import { inr } from '../chat/brief';
import '../money/money.css';
import './team.css';

/* ══════════════════════════════════════════════════════════════════════════
   Team — people, their details, and their letters (offer letters, NDAs and
   what was issued before), with a summary on top and the letters that are
   still waiting on someone first.

   People are the employees section (exited people under "Past"). Pay shows
   only where the database returns it (employee_compensation is owner/admin
   under RLS). Letters are the records table: offer letters and NDAs are
   written in their own editors (/team/letters/:kind/new); certificates and
   MoUs already issued stay listed and downloadable, read-only. Status is the
   portal's: sent → opened → accepted / declined.

   Telegram (owners/admins): each person's Telegram connection. Anyone in
   Team can use Buddy on Telegram without a StartupBuddy login — an admin
   sends them a private one-time link (api/_lib/telegram/manage.js,
   person_invite) and can revoke it here at any time.
   ══════════════════════════════════════════════════════════════════════════ */

const KIND = { offer: 'Offer letter', nda: 'NDA', certificate: 'Certificate', mou: 'MoU', role_change: 'Role change', termination: 'Termination notice' };
const LETTER_STATUS = {
    draft: ['n', 'Draft'], pending: ['n', 'Not sent'], sent: ['a', 'Sent'], viewed: ['b', 'Opened'],
    signed: ['g', 'Signed'], accepted: ['g', 'Accepted'], acknowledged: ['g', 'Acknowledged'], fully_signed: ['g', 'Signed'],
    declined: ['r', 'Declined'], cancelled: ['n', 'Cancelled'], issued: ['g', 'Issued'],
};
const letterStatus = (r) => LETTER_STATUS[r.status] || ['n', r.status || 'Draft'];
// Letters still waiting on someone: not sent yet, or sent and not answered.
const WAITING = new Set(['draft', 'pending', 'sent', 'viewed']);
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
    const [letterView, setLetterView] = useState('all');
    const assistant = useAssistant();
    const { persona } = useCofounder();
    const ask = (text) => { navigate('/chat'); assistant.send(text); };
    const [note, setNote] = useState('');
    const notify = (m) => { setNote(m); setTimeout(() => setNote(''), 2600); };

    const letters = useMemo(() => records
        .filter((r) => KIND[r.type])
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))), [records]);
    const letterId = params.get('letter');
    const shownLetter = letter || (letterId ? records.find((r) => r.id === letterId) || null : null);
    const closeLetter = () => {
        setLetter(null);
        if (letterId) { const n = new URLSearchParams(params); n.delete('letter'); setParams(n, { replace: true }); }
    };
    const personId = params.get('person');
    const person = personId ? (people.find((p) => p.id === personId) || past.find((p) => p.id === personId)) : null;
    const openAdd = adding || params.get('addPerson') === '1';
    const closeAdd = () => { setAdding(false); if (params.has('addPerson')) setParams({}, { replace: true }); };
    const list = view === 'current' ? people : past;
    const joining = people.filter((p) => p.startDate && p.startDate > new Date().toISOString().slice(0, 10));
    const waiting = letters.filter((r) => WAITING.has(r.status) && (r.type === 'offer' || r.type === 'nda'));
    const signedThisMonth = letters.filter((r) => ['signed', 'accepted', 'fully_signed', 'acknowledged'].includes(r.status)
        && String(r.updated_at || r.created_at || '').slice(0, 7) === new Date().toISOString().slice(0, 7)).length;
    const shownLetters = letterView === 'waiting' ? waiting : letters;
    const canLetters = orgStore.can('records', 'create');
    const canPeople = orgStore.can('employees', 'create');

    // Telegram connection per person — owners and admins only.
    const admin = ['owner', 'admin'].includes(orgStore.getRole());
    const [tg, setTg] = useState(null); // { on, people: Map(employee_id → status) }
    const loadTg = useCallback(async () => {
        if (!admin || !orgId) return;
        try {
            const s = await telegramApi({ mode: 'status', org_id: orgId });
            setTg({ on: !!(s.enabled && s.configured && s.bot_username), people: new Map((s.people || []).map((p) => [p.employee_id, p])) });
        } catch { setTg(null); }
    }, [admin, orgId]);
    useEffect(() => { const t = setTimeout(loadTg, 0); return () => clearTimeout(t); }, [loadTg]);

    const today = new Date().toISOString().slice(0, 10);
    const firstName = (n) => String(n || '').split(' ')[0];
    const showLetters = (v) => { setLetterView(v); document.getElementById('tm-letters')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };

    return (
        <div className="sb-scroll tm">
            <div className="sb-page tm-page">
                <header className="tm-hero">
                    <div className="tm-title">
                        <h1>Team</h1>
                        <p>
                            {people.length ? `${people.length} ${people.length === 1 ? 'person' : 'people'} on board.` : 'Nobody on board yet.'}
                            {joining.length > 0 && ` ${firstName(joining[0].name)} joins ${fmt(joining[0].startDate)}.`}
                        </p>
                    </div>
                    <nav className="tm-acts" aria-label="Team actions">
                        {canLetters && <button type="button" className="tm-act y" onClick={() => navigate('/team/letters/offer/new')}><IconDoc /><span>Offer letter</span></button>}
                        {canLetters && <button type="button" className="tm-act" onClick={() => navigate('/team/letters/nda/new')}><IconLock /><span>NDA</span></button>}
                        {canPeople && <button type="button" className="tm-act" onClick={() => setAdding(true)}><IconPlus /><span>Add a person</span></button>}
                        <button type="button" className="tm-act k" onClick={() => ask('Who on the team has the most open tasks?')}><IconSparkle /><span>Ask {persona.name}</span></button>
                    </nav>
                </header>

                <section className="tm-stats" aria-label="Summary">
                    <button type="button" className="tm-stat m" onClick={() => setView('current')}>
                        <span className="n">{people.length}</span>
                        <span className="l">People</span>
                        <small>{past.length ? `${past.length} have left` : 'Everyone is current'}</small>
                    </button>
                    <div className="tm-stat b">
                        <span className="n">{joining.length}</span>
                        <span className="l">Joining soon</span>
                        <small>{joining.length ? `${firstName(joining[0].name)} on ${fmt(joining[0].startDate)}` : 'No start dates ahead'}</small>
                    </div>
                    <button type="button" className="tm-stat p" onClick={() => showLetters('waiting')}>
                        <span className="n">{waiting.length}</span>
                        <span className="l">Awaiting signature</span>
                        <small>{signedThisMonth ? `${signedThisMonth} signed this month` : 'Offer letters and NDAs'}</small>
                    </button>
                </section>

                <section className="tm-sec" aria-labelledby="tm-people-h">
                    <div className="tm-sh">
                        <h2 id="tm-people-h">People</h2>
                        {past.length > 0 && <Toggle label="People" value={view} onChange={setView}
                            options={[{ value: 'current', label: 'Current', count: people.length }, { value: 'past', label: 'Past', count: past.length }]} />}
                    </div>
                    <ul className="tm-wall">
                        {list.map((p) => {
                            const exited = view === 'past';
                            const soon = !exited && p.startDate && p.startDate > today;
                            const onTg = !exited && tg?.on && tg.people.get(p.id)?.telegram;
                            return (
                                <li key={p.id}>
                                    <button type="button" className={`tm-badge ${exited ? 'x' : p.is_owner ? 'o' : typeTone(p.offerType)}`} onClick={() => setParams({ person: p.id })}>
                                        <span className="strip">
                                            <span className="hole" aria-hidden="true" />
                                            <span>{p.is_owner ? 'Owner' : exited ? 'Former' : TYPE_LABEL[p.offerType] || 'Team'}</span>
                                        </span>
                                        <span className="body">
                                            <PixelAvatar spec={personAvatar(p.name)} size={60} />
                                            <span className="who">
                                                <b>{p.name}</b>
                                                <span>{p.role || 'No role yet'}</span>
                                                {p.department && <small>{p.department}</small>}
                                            </span>
                                        </span>
                                        <span className="foot">
                                            <span className={soon ? 'soon' : undefined}>
                                                {exited ? `Left ${fmt(p.exited_at)}` : p.startDate ? `${soon ? 'Joins' : 'Since'} ${fmt(p.startDate)}` : 'Start date not set'}
                                            </span>
                                            {onTg && <span className="tg">Telegram</span>}
                                        </span>
                                    </button>
                                </li>
                            );
                        })}
                        {view === 'current' && canPeople && (
                            <li>
                                <button type="button" className="tm-badge add" onClick={() => setAdding(true)}>
                                    <span className="plus"><IconPlus /></span>
                                    <b>Add a person</b>
                                    <small>Someone who has already joined</small>
                                </button>
                            </li>
                        )}
                    </ul>
                    {!list.length && !(view === 'current' && canPeople) && (
                        <div className="tm-empty">{view === 'past' ? 'No one has left.' : 'No one on the team yet.'}</div>
                    )}
                </section>

                <section className="tm-sec" id="tm-letters" aria-labelledby="tm-letters-h">
                    <div className="tm-sh">
                        <h2 id="tm-letters-h">Letters</h2>
                        <Toggle label="Letters" value={letterView} onChange={setLetterView}
                            options={[{ value: 'all', label: 'All', count: letters.length }, { value: 'waiting', label: 'Waiting', count: waiting.length }]} />
                    </div>
                    <div className="tm-tray">
                        {shownLetters.slice(0, 40).map((r) => {
                            const [tone, label] = letterStatus(r);
                            return (
                                <button type="button" key={r.id} className="tm-letter" onClick={() => setLetter(r)}>
                                    <span className={`kind k-${r.type}`}>{KIND[r.type]}</span>
                                    <span className="to">
                                        <b>{r.issued_to || 'Unaddressed'}</b>
                                        <small>{fmt(r.issue_date || r.created_at)}</small>
                                    </span>
                                    <span className={`tm-stamp ${tone}`}>{label}</span>
                                </button>
                            );
                        })}
                        {!shownLetters.length && (
                            <div className="tm-empty">
                                <span>{letterView === 'waiting' ? 'Nothing is waiting on anyone.' : 'No letters yet.'}</span>
                                {letterView === 'all' && canLetters && (
                                    <button type="button" className="tm-act y" onClick={() => navigate('/team/letters/offer/new')}><IconDoc /><span>Write an offer letter</span></button>
                                )}
                            </div>
                        )}
                    </div>
                </section>
            </div>

            {person && <PersonSheet key={person.id} person={person} letters={letters.filter((r) => r.employee_id === person.id || (person.email && r.recipient_email === person.email))}
                onClose={() => setParams({})} onLetter={setLetter} notify={notify}
                telegram={tg ? { on: tg.on, status: tg.people.get(person.id) || null } : null} onTelegramChange={loadTg} />}
            {shownLetter && <LetterSheet key={shownLetter.id} letter={shownLetter} onClose={closeLetter} notify={notify} />}
            {openAdd && <PersonForm onClose={closeAdd} notify={notify} />}
            {note && <div className="sb sb-toast tm-toast" role="status">{note}</div>}
        </div>
    );
}

// Badge colour by how someone is engaged.
const typeTone = (t) => ({ fulltime: 'c', parttime: 'm', intern: 'y', internship: 'y', contract: 'p', collaboration: 'p' }[t] || 'c');

function Toggle({ label, value, onChange, options }) {
    return (
        <div className="tm-toggle" role="radiogroup" aria-label={label}>
            {options.map((o) => (
                <button key={o.value} type="button" role="radio" aria-checked={o.value === value} onClick={() => onChange(o.value)}>
                    {o.label}<span className="c">{o.count}</span>
                </button>
            ))}
        </div>
    );
}

function PersonSheet({ person, letters, onClose, onLetter, notify, telegram, onTelegramChange }) {
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
        <Sheet open onClose={onClose} title="Person" className="tm-sheet">
            <div className={`tm-id ${exited ? 'x' : person.is_owner ? 'o' : typeTone(person.offerType)}`}>
                <div className="strip"><span className="hole" aria-hidden="true" /><span>{person.is_owner ? 'Owner' : exited ? 'Former' : TYPE_LABEL[person.offerType] || 'Team'}</span></div>
                <div className="body">
                    <PixelAvatar spec={personAvatar(person.name)} size={76} />
                    <div className="who">
                        <b>{person.name}</b>
                        <span>{person.role || 'No role yet'}</span>
                        {person.department && <small>{person.department}</small>}
                    </div>
                </div>
                <div className="facts">
                    <div><small>{exited ? 'Left' : 'Joined'}</small><b>{fmt(exited ? person.exited_at : person.startDate) || 'Not set'}</b></div>
                    <div><small>Pay{pay ? ', visible to admins' : ''}</small><b>{pay || 'Not shown to your role'}</b></div>
                </div>
            </div>
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
                        return <ListRow key={r.id} onClick={() => onLetter(r)} title={KIND[r.type]} sub={fmt(r.issue_date || r.created_at)} trail={<span className={`tm-stamp ${tone}`}>{label}</span>} />;
                    })}
                    {!letters.length && <div className="sb-lr"><span className="t"><small>No letters yet</small></span></div>}
                </Card>
            </div>
            {telegram && !exited && (
                <PersonTelegram person={person} telegram={telegram} orgId={activeOrg?.id} notify={notify} onChange={onTelegramChange} />
            )}
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

/**
 * Team → person → Telegram. Connect sends a private one-time link for THIS
 * person (they need no StartupBuddy login); Revoke ends their Telegram
 * access at once. Both are owner/admin only, checked by the server.
 */
function PersonTelegram({ person, telegram, orgId, notify, onChange }) {
    const [busy, setBusy] = useState(false);
    const [sheet, setSheet] = useState(null);
    const link = telegram.status?.telegram || null;
    const connect = async () => {
        setBusy(true);
        try {
            const r = await telegramApi({ mode: 'person_invite', org_id: orgId, employee_id: person.id });
            setSheet({
                title: `Connect ${person.name}`, url: r.url, expires_at: r.expires_at,
                note: `Send this privately to ${person.name} only — whoever opens it first is connected as them. It works once and expires in 48 hours. They don't need a StartupBuddy login.`,
            });
        } catch (e) { notify(e.message); } finally { setBusy(false); }
    };
    const revoke = async () => {
        if (!(await confirmDialog({ title: 'Revoke Telegram', message: `Buddy will stop answering ${person.name} on Telegram right away.`, confirmLabel: 'Revoke' }))) return;
        setBusy(true);
        try {
            await telegramApi({ mode: 'person_unlink', org_id: orgId, employee_id: person.id });
            notify(`${person.name}'s Telegram is disconnected.`);
            await onChange();
        } catch (e) { notify(e.message); } finally { setBusy(false); }
    };
    return (
        <div className="sb-dsec">
            <h5>Telegram</h5>
            <Card list>
                <div className="sb-kvr">
                    <span>
                        {link ? <>● Connected</> : '○ Not connected'}
                        <small style={{ display: 'block', color: 'var(--muted)', fontSize: 12 }}>
                            {link
                                ? `${tgName(link)} · can use Buddy on Telegram`
                                : telegram.on ? 'Lets them use Buddy on Telegram, no login needed.' : 'Turn Telegram on in Settings → Telegram first.'}
                        </small>
                    </span>
                    {telegram.on && (link
                        ? <Button size="sm" variant="ghost" onClick={revoke} disabled={busy}>Revoke</Button>
                        : <Button size="sm" onClick={connect} disabled={busy}>{busy ? 'Creating…' : 'Connect Telegram'}</Button>)}
                </div>
            </Card>
            <TelegramLinkSheet sheet={sheet} onClose={() => { setSheet(null); onChange(); }} />
        </div>
    );
}

function LetterSheet({ letter, onClose, notify }) {
    const { activeOrg } = useOrg();
    const navigate = useNavigate();
    const isDraft = letter.status === 'draft' && (letter.type === 'offer' || letter.type === 'nda');
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
        <Sheet open onClose={onClose} title={KIND[letter.type]} className="tm-sheet">
            <div className="tm-doc">
                <span className={`kind k-${letter.type}`}>{KIND[letter.type]}</span>
                <b>{letter.issued_to || 'Unaddressed'}</b>
                <small>{letter.doc_number ? `${letter.doc_number}, ` : ''}{fmt(letter.issue_date || letter.created_at)}</small>
                <span className={`tm-stamp big ${tone}`}>{label}</span>
            </div>
            {readOnlyKind && <div className="sb-note b">New {KIND[letter.type].toLowerCase()}s aren't made here any more. This one stays available to download.</div>}
            <div className="sb-dacts">
                {isDraft && <Button variant="primary" onClick={() => navigate(`/team/letters/${letter.type}/new?draft=${letter.id}`)}>Continue editing</Button>}
                <Button variant={isDraft ? undefined : 'primary'} onClick={download} disabled={!!busy}>{busy === 'pdf' ? 'Preparing…' : 'Download PDF'}</Button>
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
        <Sheet open onClose={onClose} title={existing ? 'Edit person' : 'Add a person'} className="tm-sheet"
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
