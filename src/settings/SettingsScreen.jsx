import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useOrg } from '../context/OrgContext';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { orgStore } from '../services/orgStore';
import { emailService } from '../services/emailService';
import { uploadOrgImage } from '../services/imageUploadService';
import { getPlanConfig, DEFAULT_PLAN } from '../services/planConfig';
import { listMembers, setMemberRole, getMyMembership, loadMemberOverrides } from '../services/permissionService';
import { portalAccessService, joinUrl } from '../services/portalAccessService';
import { getStatus as brainStatus, buildBrain, syncBrain } from '../services/brainService';
import { confirmDialog } from '../services/confirm';
import { useCofounder } from '../design/useCofounder';
import { useShell } from '../shell/shellContext';
import { Button, Badge, Card, PageHeader, Sheet, Field, Segmented, PixelAvatar } from '../design/ui';
import CofounderCarousel from '../design/CofounderCarousel';
import { introGreeting } from '../call/greeting';
import '../money/money.css';

/* ══════════════════════════════════════════════════════════════════════════
   Settings — one page, in the mockup's sections, over the same saves as the
   old company profile:
     company, branding, getting paid, Gmail   updateOrganization() → orgStore
        splits the fields to organizations / org_banking (owner & admin only,
        as before) / org_secrets (encrypted by /api/org-secrets)
     members                                  org_members, memberships.role
     knowledge                                /api/brain status | build | sync
     plan                                     subscriptions + usage_counters
     data                                     /api/export
   Only owners and admins can change company settings (RLS decides; the page
   just doesn't offer what would be refused).
   ══════════════════════════════════════════════════════════════════════════ */

const PROFILE = [
    'company_name', 'company_tagline', 'company_address', 'owner_full_name', 'document_designation',
    'company_email', 'company_phone', 'company_website', 'gstin', 'cin',
    'upi_id', 'bank_name', 'bank_account_number', 'bank_ifsc', 'bank_account_type',
    'logo_url', 'logo_path', 'signature_url', 'signature_path', 'stamp_type', 'stamp_url', 'stamp_path', 'stamp_city',
    'gmail_user', 'gmail_app_password',
];
const CHECKS = {
    company_email: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'This does not look like an email address.'],
    gmail_user: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'This does not look like an email address.'],
    gstin: [/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'A GSTIN is 15 characters, e.g. 22AAAAA0000A1Z5.'],
    cin: [/^[LU]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}$/, 'A CIN is 21 characters.'],
    upi_id: [/^[\w.-]{2,}@[a-z][\w]{1,}$/i, 'A UPI ID looks like name@bank.'],
    bank_ifsc: [/^[A-Z]{4}0[A-Z0-9]{6}$/, 'An IFSC is 11 characters, e.g. HDFC0001234.'],
    bank_account_number: [/^\d{6,18}$/, 'Account numbers are 6–18 digits.'],
};
const UPPER = new Set(['gstin', 'cin', 'bank_ifsc']);
const ROLES = ['owner', 'admin', 'member', 'viewer', 'employee'];
const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', member: 'Member', viewer: 'Viewer', employee: 'Employee' };

async function authed(path, init = {}) {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Your session has expired. Sign in again.');
    return fetch(path, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${session.access_token}` } });
}

export default function SettingsScreen() {
    const { activeOrg, updateOrganization } = useOrg();
    const { user, logout, updatePassword, reauthenticate } = useAuth();
    const { persona } = useCofounder();
    const shell = useShell();
    const { hash } = useLocation();
    const orgId = activeOrg?.id;
    const role = orgStore.getRole();
    const admin = role === 'owner' || role === 'admin';

    const fromOrg = useCallback((org) => Object.fromEntries(PROFILE.map((k) => [k, org?.[k] || (k === 'stamp_type' ? 'generated' : k === 'bank_account_type' ? 'Current' : '')])), []);
    const [form, setForm] = useState(() => fromOrg(activeOrg));
    const [base, setBase] = useState(() => fromOrg(activeOrg));
    const [saving, setSaving] = useState(false);
    const [msg, setMsg] = useState('');
    const [err, setErr] = useState('');
    const [switching, setSwitching] = useState(false);
    const [gmail, setGmail] = useState({ loading: true });
    const [testing, setTesting] = useState(false);
    const [uploading, setUploading] = useState('');

    const dirty = useMemo(() => PROFILE.some((k) => (form[k] || '') !== (base[k] || '')), [form, base]);
    const set = (k) => (e) => setForm((f) => ({ ...f, [k]: UPPER.has(k) ? e.target.value.toUpperCase() : e.target.value }));
    const warn = (k) => (form[k] && CHECKS[k] && !CHECKS[k][0].test(String(form[k]).trim()) ? CHECKS[k][1] : undefined);
    const flash = (m) => { setMsg(m); setTimeout(() => setMsg(''), 3000); };

    // A different company loaded, or its profile changed elsewhere: follow it
    // unless there are unsaved edits.
    const [seenOrg, setSeenOrg] = useState(activeOrg);
    if (seenOrg !== activeOrg) {
        setSeenOrg(activeOrg);
        if (!dirty) { setForm(fromOrg(activeOrg)); setBase(fromOrg(activeOrg)); }
    }

    const refreshGmail = useCallback(async () => {
        if (!orgId || !admin) { setGmail({ loading: false, allowed: false }); return; }
        try {
            const res = await authed(`/api/org-secrets?org_id=${encodeURIComponent(orgId)}`);
            const data = await res.json().catch(() => ({}));
            setGmail(res.ok && data.success ? { loading: false, allowed: true, configured: !!data.configured, user: data.gmail_user || '' } : { loading: false, allowed: false });
        } catch { setGmail({ loading: false, allowed: false }); }
    }, [orgId, admin]);
    useEffect(() => { refreshGmail(); }, [refreshGmail]);

    useEffect(() => {
        const id = (hash || '').replace('#', '');
        if (!id) return undefined;
        const t = setTimeout(() => document.getElementById(`set-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120);
        return () => clearTimeout(t);
    }, [hash]);

    const save = async () => {
        if (!form.company_name.trim()) { setErr('Company name is required.'); return; }
        const bad = Object.keys(CHECKS).find((k) => warn(k));
        if (bad) { setErr(CHECKS[bad][1]); return; }
        setSaving(true);
        setErr('');
        try {
            await updateOrganization(orgId, form);
            const next = { ...form, gmail_app_password: '' };
            setForm(next);
            setBase(next);
            flash('Saved.');
            if (form.gmail_app_password || form.gmail_user !== gmail.user) refreshGmail();
        } catch (e) { setErr(`Could not save: ${e.message}`); }
        finally { setSaving(false); }
    };

    const upload = async (field, kind, file) => {
        if (!file) return;
        if (!file.type.startsWith('image/')) { setErr('Choose an image file: PNG, JPG or WebP.'); return; }
        setUploading(field);
        setErr('');
        try {
            const { path, url } = await uploadOrgImage({ orgId, kind, source: file });
            setForm((f) => ({ ...f, [`${kind}_path`]: path, [field]: url }));
        } catch (e) { setErr(e.message || 'Could not upload that image.'); }
        finally { setUploading(''); }
    };

    const testGmail = async () => {
        setTesting(true);
        setErr('');
        try {
            if (form.gmail_app_password || (form.gmail_user && form.gmail_user !== gmail.user)) {
                if (!form.gmail_user || !form.gmail_app_password) throw new Error('Enter both your Gmail address and App Password.');
                await updateOrganization(orgId, form);
                const next = { ...form, gmail_app_password: '' };
                setForm(next);
                setBase(next);
                await refreshGmail();
            }
            const r = await emailService.testConnection({ orgId, gmailUser: form.gmail_user || gmail.user });
            if (!r.success) throw new Error(r.message || 'The test email did not send.');
            flash(r.message || 'Test email sent. Check your inbox.');
        } catch (e) { setErr(e.message); }
        finally { setTesting(false); }
    };

    const plan = getPlanConfig(activeOrg?.plan || DEFAULT_PLAN);

    return (
        <div className="sb-scroll">
            <div className="sb-page" style={{ maxWidth: 760 }}>
                <PageHeader title="Settings" sub={activeOrg?.company_name} />
                {err && <div className="sb-err" role="alert" style={{ marginBottom: 16 }}>{err}</div>}

                <section className="sb-sec" id="set-cofounder">
                    <h3>Cofounder</h3>
                    <Card style={{ display: 'flex', alignItems: 'center', gap: 14, padding: 16 }}>
                        <PixelAvatar spec={persona} size={56} />
                        <div style={{ flex: 1, minWidth: 0 }}><b style={{ display: 'block', fontSize: 16 }}>{persona.name}</b><small style={{ color: 'var(--muted)' }}>{persona.role}</small></div>
                        <Button size="sm" onClick={() => setSwitching(true)}>Change</Button>
                    </Card>
                    <div style={{ marginTop: 8 }}>
                        <Button variant="ghost" size="sm" onClick={() => shell.startCall('incoming', { greeting: introGreeting(persona, activeOrg?.company_name) })}>Replay the intro call</Button>
                    </div>
                </section>

                <section className="sb-sec" id="set-company">
                    <h3>Company</h3>
                    <Card style={{ padding: '4px 16px 16px' }}>
                        <fieldset disabled={!admin} style={{ border: 0, padding: 0, margin: 0 }}>
                            <div className="sb-grid2">
                                <Field label="Company name"><input value={form.company_name} onChange={set('company_name')} /></Field>
                                <Field label="Tagline"><input value={form.company_tagline} onChange={set('company_tagline')} /></Field>
                                <Field label="Email" error={warn('company_email')}><input type="email" value={form.company_email} onChange={set('company_email')} /></Field>
                                <Field label="Phone"><input type="tel" value={form.company_phone} onChange={set('company_phone')} /></Field>
                                <Field label="Website"><input value={form.company_website} onChange={set('company_website')} /></Field>
                                <Field label="GSTIN" error={warn('gstin')} hint={!warn('gstin') && form.gstin ? 'Added (not verified with the GST portal)' : undefined}><input value={form.gstin} maxLength={15} onChange={set('gstin')} /></Field>
                                <Field label="CIN" error={warn('cin')}><input value={form.cin} maxLength={21} onChange={set('cin')} /></Field>
                                <Field label="Signs documents"><input value={form.owner_full_name} onChange={set('owner_full_name')} placeholder="Full name" /></Field>
                                <Field label="Their title"><input value={form.document_designation} onChange={set('document_designation')} placeholder="e.g. Founder & CEO" /></Field>
                            </div>
                            <Field label="Registered address"><textarea rows={2} value={form.company_address} onChange={set('company_address')} /></Field>
                            <div className="sb-grid2" style={{ marginTop: 6 }}>
                                <ImageSlot label="Logo" url={form.logo_url} busy={uploading === 'logo_url'} disabled={!admin}
                                    onPick={(f) => upload('logo_url', 'logo', f)} onClear={() => setForm((x) => ({ ...x, logo_url: '', logo_path: '' }))} />
                                <ImageSlot label="Signature" url={form.signature_url} busy={uploading === 'signature_url'} disabled={!admin}
                                    onPick={(f) => upload('signature_url', 'signature', f)} onClear={() => setForm((x) => ({ ...x, signature_url: '', signature_path: '' }))} />
                            </div>
                            <div className="sb-field">
                                <label>Company stamp</label>
                                <Segmented label="Stamp" value={form.stamp_type} onChange={(v) => setForm((x) => ({ ...x, stamp_type: v }))}
                                    options={[{ value: 'generated', label: 'Generate for me' }, { value: 'uploaded', label: 'Upload my own' }]} />
                            </div>
                            {form.stamp_type === 'generated'
                                ? <Field label="City on the stamp"><input value={form.stamp_city} onChange={set('stamp_city')} /></Field>
                                : <ImageSlot label="Stamp image" url={form.stamp_url} busy={uploading === 'stamp_url'} disabled={!admin}
                                    onPick={(f) => upload('stamp_url', 'stamp', f)} onClear={() => setForm((x) => ({ ...x, stamp_url: '', stamp_path: '' }))} />}
                        </fieldset>
                    </Card>
                </section>

                <section className="sb-sec" id="set-paid">
                    <h3>Getting paid</h3>
                    {admin ? (
                        <Card style={{ padding: '4px 16px 16px' }}>
                            <div className="sb-grid2">
                                <Field label="UPI ID" error={warn('upi_id')} hint="Adds a pay QR to invoices and the client link."><input value={form.upi_id} onChange={set('upi_id')} /></Field>
                                <Field label="Bank"><input value={form.bank_name} onChange={set('bank_name')} /></Field>
                                <Field label="Account number" error={warn('bank_account_number')}><input inputMode="numeric" value={form.bank_account_number} onChange={set('bank_account_number')} /></Field>
                                <Field label="IFSC" error={warn('bank_ifsc')}><input value={form.bank_ifsc} maxLength={11} onChange={set('bank_ifsc')} /></Field>
                            </div>
                        </Card>
                    ) : <Card><div className="sb-empty">Only owners and admins can see or change bank details.</div></Card>}
                </section>

                <section className="sb-sec" id="set-email">
                    <h3>Email sending</h3>
                    {gmail.allowed ? (
                        <Card style={{ padding: '4px 16px 16px' }}>
                            <div className="sb-kvr" style={{ padding: '14px 0 0' }}>
                                <span>Gmail for invoices, reminders and letters</span>
                                <Badge tone={gmail.configured ? 'g' : 'a'}>{gmail.configured ? 'Connected' : 'Not connected'}</Badge>
                            </div>
                            <div className="sb-grid2">
                                <Field label="Gmail address" error={warn('gmail_user')}><input type="email" value={form.gmail_user || gmail.user || ''} onChange={set('gmail_user')} /></Field>
                                <Field label="App password" hint="From Google Account → Security → App passwords. Stored encrypted; never shown again.">
                                    <input type="password" autoComplete="new-password" value={form.gmail_app_password} onChange={set('gmail_app_password')} placeholder={gmail.configured ? '••••••••' : ''} />
                                </Field>
                            </div>
                            <div style={{ marginTop: 12 }}><Button onClick={testGmail} disabled={testing}>{testing ? 'Sending a test…' : gmail.configured && !form.gmail_app_password ? 'Send a test email' : 'Connect and test'}</Button></div>
                        </Card>
                    ) : <Card><div className="sb-empty">{gmail.loading ? 'Checking…' : 'Only owners and admins can connect Gmail.'}</div></Card>}
                </section>

                <Members orgId={orgId} admin={admin} me={user?.id} />
                <Knowledge orgId={orgId} />
                <Plan orgId={orgId} plan={plan} />

                <section className="sb-sec" id="set-data">
                    <h3>Data and account</h3>
                    <Card list>
                        {admin && <ExportRow orgId={orgId} />}
                        <PasswordRow updatePassword={updatePassword} reauthenticate={reauthenticate} email={user?.email} />
                        <div className="sb-kvr"><span>Signed in as {user?.email}</span><Button size="sm" onClick={async () => {
                            if (await confirmDialog({ title: 'Sign out', message: 'Sign out of StartupBuddy on this device?', confirmLabel: 'Sign out', tone: 'default' })) logout();
                        }}>Sign out</Button></div>
                    </Card>
                </section>
            </div>

            {dirty && admin && (
                <div className="sb-savebar" role="region" aria-label="Unsaved changes">
                    <span>Unsaved changes</span>
                    <Button variant="ghost" size="sm" onClick={() => { setForm(base); setErr(''); }}>Discard</Button>
                    <Button variant="primary" size="sm" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
                </div>
            )}
            {msg && <div className="sb sb-toast" role="status">{msg}</div>}
            {switching && <SwitchSheet onClose={() => setSwitching(false)} onDone={(name) => flash(`${name} is now your cofounder.`)} />}
        </div>
    );
}

function ImageSlot({ label, url, busy, disabled, onPick, onClear }) {
    const ref = useRef(null);
    return (
        <div className="sb-field">
            <label>{label}</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ width: 64, height: 44, border: '1px solid var(--line)', borderRadius: 10, display: 'grid', placeItems: 'center', background: 'var(--bg)', overflow: 'hidden', flex: 'none' }}>
                    {url ? <img src={url} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} /> : <small style={{ color: 'var(--faint)' }}>None</small>}
                </span>
                <input ref={ref} type="file" accept="image/*" hidden onChange={(e) => { onPick(e.target.files?.[0]); e.target.value = ''; }} />
                <Button size="sm" disabled={disabled || busy} onClick={() => ref.current?.click()}>{busy ? 'Uploading…' : url ? 'Replace' : 'Upload'}</Button>
                {url && !disabled && <Button size="sm" variant="ghost" onClick={onClear}>Remove</Button>}
            </div>
        </div>
    );
}

function SwitchSheet({ onClose, onDone }) {
    const { persona, setCofounder } = useCofounder();
    const [pick, setPick] = useState(persona);
    const [error, setError] = useState('');
    const go = async () => {
        if (pick.id === persona.id) { onClose(); return; }
        try { await setCofounder(pick.id); onDone(pick.name); onClose(); }
        catch (e) { setError(e.message || 'Could not switch.'); }
    };
    return (
        <Sheet open onClose={onClose} title="Change cofounder"
            footer={<Button variant="primary" block size="lg" onClick={go}>{pick.id === persona.id ? `${pick.name} is your cofounder` : `Switch to ${pick.name}`}</Button>}>
            {error && <div className="sb-err" role="alert">{error}</div>}
            <CofounderCarousel compact value={persona.id} onChange={setPick} />
            <p className="sb-acnote" style={{ textAlign: 'center' }}>Your chats, files and data stay the same. Only the personality changes.</p>
        </Sheet>
    );
}

function Members({ orgId, admin, me }) {
    const [members, setMembers] = useState(null);
    const [mine, setMine] = useState(null);
    const [custom, setCustom] = useState({});
    const [join, setJoin] = useState(null);
    const [error, setError] = useState('');
    const load = useCallback(async () => {
        if (!orgId) return;
        try {
            const [list, my] = await Promise.all([listMembers(orgId), getMyMembership(orgId)]);
            setMembers(list);
            setMine(my);
            if (admin) {
                const pairs = await Promise.all(list.map(async (m) => [m.membership_id, Object.keys((await loadMemberOverrides(m.membership_id).catch(() => ({}))) || {}).length]));
                setCustom(Object.fromEntries(pairs));
                setJoin(await portalAccessService.getJoinCode(orgId).catch(() => null));
            }
        } catch (e) { setError(e.message); }
    }, [orgId, admin]);
    useEffect(() => { const t = setTimeout(load, 0); return () => clearTimeout(t); }, [load]);

    const change = async (m, role) => {
        setError('');
        try { await setMemberRole(m.membership_id, role); await load(); }
        catch (e) { setError(e.message); }
    };
    const rotate = async () => { try { await portalAccessService.rotateJoinCode(orgId, true); await load(); } catch (e) { setError(e.message); } };
    const toggleJoin = async () => { try { await portalAccessService.setJoinEnabled(orgId, !join.portal_join_enabled); await load(); } catch (e) { setError(e.message); } };
    const canGrant = mine?.role === 'owner' || mine?.role === 'admin';

    return (
        <section className="sb-sec" id="set-members">
            <h3>Members</h3>
            {error && <div className="sb-err" role="alert" style={{ marginBottom: 8 }}>{error}</div>}
            <Card list>
                {!members && <div className="sb-empty">Loading…</div>}
                {(members || []).map((m) => (
                    <div key={m.membership_id} className="sb-kvr">
                        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {m.email}{m.user_id === me ? ' (you)' : ''}
                            {custom[m.membership_id] > 0 && <small style={{ display: 'block', color: 'var(--muted)', fontSize: 12 }}>Has custom access, managed by an owner</small>}
                        </span>
                        {canGrant && m.user_id !== me && m.role !== 'owner' ? (
                            <select aria-label={`Role for ${m.email}`} value={m.role} onChange={(e) => change(m, e.target.value)}
                                style={{ height: 36, border: '1px solid var(--line)', borderRadius: 8, padding: '0 8px', font: 'inherit', fontSize: 14, width: 'auto', background: 'var(--surface)' }}>
                                {ROLES.filter((r) => r !== 'owner' || mine?.role === 'owner').map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                            </select>
                        ) : <Badge tone="n" plain>{ROLE_LABEL[m.role] || m.role}</Badge>}
                    </div>
                ))}
            </Card>
            {admin && (
                <Card style={{ padding: 16, marginTop: 10 }}>
                    <b style={{ fontSize: 14 }}>Invite your team</b>
                    <p className="sb-acnote">People you add on Team can be sent a personal portal invite from their page. Or share a join code: they sign in and join as employees, and you can change their role here.</p>
                    {join?.portal_join_code ? (
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                            <code className="sb-num" style={{ fontSize: 18, padding: '6px 10px', border: '1px solid var(--line)', borderRadius: 8 }}>{join.portal_join_code}</code>
                            <Button size="sm" onClick={() => navigator.clipboard.writeText(joinUrl({ code: join.portal_join_code }))}>Copy link</Button>
                            <Button size="sm" variant="ghost" onClick={rotate}>New code</Button>
                            <Button size="sm" variant="ghost" onClick={toggleJoin}>{join.portal_join_enabled ? 'Turn off' : 'Turn on'}</Button>
                        </div>
                    ) : <Button size="sm" onClick={rotate}>Create a join code</Button>}
                </Card>
            )}
        </section>
    );
}

function Knowledge({ orgId }) {
    const [s, setS] = useState(null);
    const [busy, setBusy] = useState('');
    const [error, setError] = useState('');
    const load = useCallback(async () => {
        if (!orgId || !orgStore.can('edgebrain', 'view')) { setS({ hidden: true }); return; }
        try { setS(await brainStatus(orgId)); } catch (e) { setError(e.message); setS({}); }
    }, [orgId]);
    useEffect(() => { load(); }, [load]);
    if (s?.hidden) return null;
    const st = s?.state?.status;
    const run = async (key, fn) => { setBusy(key); setError(''); try { await fn(orgId); await load(); } catch (e) { setError(e.message); } finally { setBusy(''); } };
    return (
        <section className="sb-sec" id="set-ai">
            <h3>What your cofounder knows</h3>
            <Card list>
                <div className="sb-kvr">
                    <span>{!s ? 'Checking…' : st === 'ready' ? `${s.visibleNodeCount || s.state.node_count || 0} records learned${s.state.last_sync_at ? `, updated ${new Date(s.state.last_sync_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}` : ''}` : st === 'building' ? 'Learning your company now…' : st === 'error' ? 'The last build had problems' : 'Not built yet'}</span>
                    <Badge tone={st === 'ready' ? 'g' : st === 'building' ? 'b' : 'a'}>{st === 'ready' ? 'Ready' : st === 'building' ? 'Building' : 'Needs a build'}</Badge>
                </div>
                {s && (s.can?.build || s.can?.sync) && (
                    <div className="sb-kvr">
                        <span style={{ color: 'var(--muted)', fontSize: 13 }}>It keeps itself up to date after the first build.{s.pendingChanges ? ` ${s.pendingChanges} changes are waiting.` : ''}</span>
                        <span style={{ display: 'flex', gap: 6 }}>
                            {s.can?.build && <Button size="sm" onClick={() => run('build', buildBrain)} disabled={!!busy}>{busy === 'build' ? 'Building…' : st === 'ready' ? 'Rebuild' : 'Build'}</Button>}
                            {s.can?.sync && st === 'ready' && <Button size="sm" variant="ghost" onClick={() => run('sync', syncBrain)} disabled={!!busy}>{busy === 'sync' ? 'Syncing…' : 'Sync now'}</Button>}
                        </span>
                    </div>
                )}
                {error && <div className="sb-kvr"><span className="sb-acerr">{error}</span></div>}
            </Card>
        </section>
    );
}

function Plan({ orgId, plan }) {
    const [used, setUsed] = useState(null);
    useEffect(() => {
        if (!orgId) return undefined;
        let gone = false;
        supabase.from('usage_counters').select('ai_messages').eq('org_id', orgId).maybeSingle()
            .then(({ data }) => { if (!gone) setUsed(Number(data?.ai_messages ?? orgStore.getUsage().ai_messages) || 0); })
            .catch(() => { if (!gone) setUsed(Number(orgStore.getUsage().ai_messages) || 0); });
        return () => { gone = true; };
    }, [orgId]);
    const limit = plan.limits?.aiMessages;
    return (
        <section className="sb-sec" id="set-plan">
            <h3>Plan and usage</h3>
            <Card list>
                <div className="sb-kvr">
                    <span>{plan.displayName}</span>
                    <span className="sb-num" style={{ fontSize: 13, color: 'var(--muted)' }}>
                        {used === null ? '…' : Number.isFinite(limit) ? `${used} of ${limit} AI messages used` : `${used} AI messages used, no limit`}
                    </span>
                </div>
            </Card>
        </section>
    );
}

function ExportRow({ orgId }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const go = async () => {
        setBusy(true);
        setError('');
        try {
            const res = await authed(`/api/export?org_id=${encodeURIComponent(orgId)}`);
            if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || `Export failed (${res.status})`); }
            const url = URL.createObjectURL(await res.blob());
            const a = document.createElement('a');
            a.href = url;
            a.download = `startupbuddy-export-${new Date().toISOString().slice(0, 10)}.json`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 10000);
        } catch (e) { setError(e.message); }
        finally { setBusy(false); }
    };
    return (
        <div className="sb-kvr">
            <span>Export all company data{error && <small style={{ display: 'block', color: 'var(--r-tx)' }}>{error}</small>}</span>
            <Button size="sm" onClick={go} disabled={busy}>{busy ? 'Preparing…' : 'Download'}</Button>
        </div>
    );
}

function PasswordRow({ updatePassword, reauthenticate }) {
    const [open, setOpen] = useState(false);
    const [p, setP] = useState({ current: '', next: '', confirm: '' });
    const [error, setError] = useState('');
    const [ok, setOk] = useState('');
    const [busy, setBusy] = useState(false);
    const submit = async () => {
        if (p.next.length < 6) { setError('The new password must be at least 6 characters.'); return; }
        if (p.next !== p.confirm) { setError('The two new passwords do not match.'); return; }
        setBusy(true);
        setError('');
        try {
            await reauthenticate(p.current);
            await updatePassword(p.next);
            setOk('Password updated.');
            setP({ current: '', next: '', confirm: '' });
            setTimeout(() => { setOk(''); setOpen(false); }, 2000);
        } catch (e) { setError(e.message || 'Could not update the password.'); }
        finally { setBusy(false); }
    };
    return (
        <>
            <div className="sb-kvr"><span>Password</span><Button size="sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>{open ? 'Close' : 'Change'}</Button></div>
            {open && (
                <div style={{ padding: '0 16px 16px' }}>
                    {error && <div className="sb-err" role="alert">{error}</div>}
                    {ok && <div className="sb-ok" role="status">{ok}</div>}
                    <Field label="Current password"><input type="password" autoComplete="current-password" value={p.current} onChange={(e) => setP((x) => ({ ...x, current: e.target.value }))} /></Field>
                    <div className="sb-grid2">
                        <Field label="New password"><input type="password" autoComplete="new-password" value={p.next} onChange={(e) => setP((x) => ({ ...x, next: e.target.value }))} /></Field>
                        <Field label="Again"><input type="password" autoComplete="new-password" value={p.confirm} onChange={(e) => setP((x) => ({ ...x, confirm: e.target.value }))} /></Field>
                    </div>
                    <div style={{ marginTop: 12 }}><Button variant="primary" size="sm" onClick={submit} disabled={busy}>{busy ? 'Updating…' : 'Update password'}</Button></div>
                </div>
            )}
        </>
    );
}
