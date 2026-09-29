import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useOrg } from '../context/OrgContext';
import { createOrganization } from '../services/orgProvisioning';
import { libraryService, validateLibraryFile } from '../services/libraryService';
import { buildBrain } from '../services/brainService';
import { orgStore } from '../services/orgStore';
import { authErrorMessage } from '../lib/authErrors';
import { displayNameOf } from '../lib/user';
import { PERSONAS } from '../design/personas';
import { useCofounder } from '../design/useCofounder';
import { Button, Field, Segmented, PixelAvatar, Card, Switch, IconTile } from '../design/ui';
import CofounderCarousel from '../design/CofounderCarousel';
import { IconChevronLeft, IconChat, IconCheck, IconCall, IconInvoice, IconMail, IconBank } from '../design/icons';
import { introGreeting } from '../call/greeting';
import { setOnboardingStep, INTRO_CALL_KEY } from './onboardingState';
import '../design/sb.css';
import './onboarding.css';

/* ══════════════════════════════════════════════════════════════════════════
   Onboarding — new screens over the existing sign-up and provisioning.

     Welcome → Account → Company → Cofounder → Head start → Setting up → call

   Account uses the same Supabase email/password and Google flows as before.
   Company provisions through the unchanged create_organization RPC (via
   orgProvisioning): first name → owner_full_name, team size → company_size,
   what you sell → account_usage (decision D4; "state for GST" has no column
   and is asked where it's used, on the invoice). Head start opens the real
   flows inline — the library upload, the Gmail secret, the bank details —
   and Setting up is a checklist of what actually happened, ending with the
   first knowledge-base build. The intro call's greeting is spoken locally.
   ══════════════════════════════════════════════════════════════════════════ */

const STACK = [3, 4, 0, 5, 2, 1].map((i) => PERSONAS[i]);
const SIZES = ['Just me', '2–5', '6–20', '20+'];
const SELLS = [{ value: 'services', label: 'Services' }, { value: 'products', label: 'Products' }, { value: 'both', label: 'Both' }];
const STEPS = { account: 1, company: 2, cofounder: 3, headstart: 4 };

function Frame({ step, children }) {
    const n = STEPS[step];
    return (
        <div className="sb sb-onb">
            <div className="sb-obar">
                <Link to="/" className="sb-logo"><img src="/startupbuddy-wordmark.png" alt="StartupBuddy" /></Link>
                {n && (
                    <div className="sb-ostep" aria-label={`Step ${n} of 4`}>
                        <span>Step {n} of 4</span>
                        <span className="sb-pbars" aria-hidden="true">{[1, 2, 3, 4].map((i) => <i key={i} className={i <= n ? 'on' : undefined} />)}</span>
                    </div>
                )}
            </div>
            <div className="sb-oscroll">{children}</div>
        </div>
    );
}

const Back = ({ onClick }) => (
    <button type="button" className="sb-back" onClick={onClick}><IconChevronLeft />Back</button>
);

/* ── signed out ────────────────────────────────────────────────────────── */

export function Welcome() {
    const navigate = useNavigate();
    return (
        <Frame>
            <section className="sb-os">
                <div className="sb-ow" style={{ maxWidth: 720 }}>
                    <div className="sb-stack" aria-hidden="true">{STACK.map((p) => <PixelAvatar key={p.id} spec={p} />)}</div>
                    <h1>Meet your AI cofounder.</h1>
                    <p className="lede center" style={{ maxWidth: 540, margin: '10px auto 0' }}>
                        StartupBuddy handles the busywork of a small company, from invoices and GST to payments and follow-ups, while you talk to it like a partner.
                    </p>
                    <div className="sb-feat">
                        <div className="sb-cd"><b><IconTile tone="b" style={{ width: 26, height: 26, borderRadius: 7 }}><IconChat size={14} /></IconTile>Talk</b><p>Say what happened. It becomes an entry, invoice or task.</p></div>
                        <div className="sb-cd"><b><IconTile tone="g" style={{ width: 26, height: 26, borderRadius: 7 }}><IconCheck size={14} /></IconTile>Review</b><p>Every change is a card. Nothing happens until you tap.</p></div>
                        <div className="sb-cd"><b><IconTile tone="a" style={{ width: 26, height: 26, borderRadius: 7 }}><IconCall size={14} /></IconTile>Call</b><p>Talk it through by voice when typing is slower.</p></div>
                    </div>
                    <div className="sb-oacts" style={{ maxWidth: 360, width: '100%', margin: '0 auto' }}>
                        <Button variant="primary" size="lg" block onClick={() => navigate('/signup')}>Get started</Button>
                        <Button variant="ghost" block onClick={() => navigate('/login')}>I already have an account</Button>
                    </div>
                </div>
            </section>
        </Frame>
    );
}

export function SignIn() {
    const navigate = useNavigate();
    const { login, loginWithGoogle } = useAuth();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const submit = async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try { await login(email, password); navigate('/chat', { replace: true }); }
        catch (err) { setError(authErrorMessage(err)); }
        finally { setBusy(false); }
    };
    return (
        <Frame>
            <section className="sb-os">
                <form className="sb-ow" onSubmit={submit}>
                    <Back onClick={() => navigate('/')} />
                    <h2>Welcome back</h2>
                    <p className="lede">Sign in to your company.</p>
                    <Button size="lg" block style={{ marginTop: 26 }} onClick={() => loginWithGoogle(`${window.location.origin}/chat`).catch((err) => setError(authErrorMessage(err)))}>
                        <GoogleMark />Continue with Google
                    </Button>
                    <div className="sb-or">or</div>
                    {error && <div className="sb-err" role="alert" style={{ marginTop: 12 }}>{error}</div>}
                    <Field label="Email"><input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
                    <Field label="Password"><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
                    <div className="sb-oacts">
                        <Button variant="primary" size="lg" block type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</Button>
                        <Button variant="ghost" block onClick={() => navigate('/signup')}>New here? Create an account</Button>
                    </div>
                </form>
            </section>
        </Frame>
    );
}

/* ── the flow ──────────────────────────────────────────────────────────── */

/**
 * @param {string} initial  account | company | cofounder | headstart | setup
 */
export default function Onboarding({ initial = 'account' }) {
    const navigate = useNavigate();
    const { user, signup, completeOnboarding, logout, loginWithGoogle } = useAuth();
    const { activeOrg, updateOrganization } = useOrg();
    const { persona, setCofounder } = useCofounder();
    const [step, setStep] = useState(initial);
    const [account, setAccount] = useState({ email: '', password: '' });
    const [company, setCompany] = useState(() => ({
        first: (displayNameOf(user) || '').split(/\s+/)[0] || '', name: '', sells: 'services', size: '2–5',
    }));
    const [pick, setPick] = useState(persona);
    const [head, setHead] = useState({ files: false, gmail: false, bank: false });
    const [fileList, setFileList] = useState([]);
    const [gmail, setGmail] = useState({ user: '', pass: '' });
    const [bank, setBank] = useState({ upi_id: '', bank_name: '', bank_account_number: '', bank_ifsc: '' });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const fileRef = useRef(null);

    const go = (s) => { setError(''); setStep(s); };

    /* Account: nothing is created yet — the email and password are used at
       the Company step, in one go with the organization (as before). */
    const accountNext = (e) => {
        e?.preventDefault();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.email)) { setError('Enter a valid email address.'); return; }
        if (account.password.length < 6) { setError('Use at least 6 characters for the password.'); return; }
        go('company');
    };

    const provision = async (e) => {
        e?.preventDefault();
        if (!company.first.trim()) { setError('What should we call you?'); return; }
        if (!company.name.trim()) { setError('What is your company called?'); return; }
        setBusy(true);
        setError('');
        const profile = (email) => ({
            company_email: email, owner_full_name: company.first.trim(), owner_role: 'Founder',
            company_size: company.size, account_usage: company.sells, include_logo: true,
        });
        try {
            if (user) {
                // Signed in with Google already: just the company.
                await createOrganization(company.name.trim(), profile(user.email));
                await setOnboardingStep(user.id, 'cofounder');
                completeOnboarding();
            } else {
                await signup(account.email, account.password, async (uid) => {
                    await createOrganization(company.name.trim(), profile(account.email));
                    await setOnboardingStep(uid, 'cofounder');
                });
            }
            go('cofounder');
        } catch (err) {
            setError(authErrorMessage(err));
        } finally { setBusy(false); }
    };

    const chooseCofounder = async () => {
        setBusy(true);
        try {
            await setCofounder(pick.id);
            await setOnboardingStep(user.id, 'headstart');
            go('headstart');
        } catch (err) { setError(err.message || 'Could not save your choice.'); }
        finally { setBusy(false); }
    };

    const headNext = async () => {
        if (!activeOrg?.id) { setError('Still setting up your company. One moment.'); return; }
        if (head.gmail && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(gmail.user) || !gmail.pass)) { setError('Enter your Gmail address and its App Password, or switch Gmail off for now.'); return; }
        if (head.bank && !bank.upi_id && !(bank.bank_name && bank.bank_account_number && bank.bank_ifsc)) { setError('Add a UPI ID or the bank details, or switch this off for now.'); return; }
        await setOnboardingStep(user.id, 'setup');
        go('setup');
    };

    const finish = async (facts) => {
        await setOnboardingStep(user.id, 'done');
        try {
            localStorage.setItem(INTRO_CALL_KEY(user.id), introGreeting(persona, activeOrg?.company_name || company.name, facts));
        } catch { /* no intro call, then */ }
        navigate('/chat', { replace: true });
    };

    /* ── screens ── */

    if (step === 'account') {
        return (
            <Frame step="account">
                <section className="sb-os">
                    <form className="sb-ow" onSubmit={accountNext}>
                        <Back onClick={() => navigate('/')} />
                        <h2>Create your account</h2>
                        <p className="lede">Free to start. No card needed.</p>
                        <Button size="lg" block style={{ marginTop: 26 }} onClick={() => loginWithGoogle(`${window.location.origin}/`).catch((err) => setError(authErrorMessage(err)))}><GoogleMark />Continue with Google</Button>
                        <div className="sb-or">or</div>
                        {error && <div className="sb-err" role="alert" style={{ marginTop: 12 }}>{error}</div>}
                        <Field label="Work email"><input type="email" autoComplete="email" value={account.email} onChange={(e) => setAccount((a) => ({ ...a, email: e.target.value }))} data-autofocus /></Field>
                        <Field label="Password" hint="At least 6 characters."><input type="password" autoComplete="new-password" value={account.password} onChange={(e) => setAccount((a) => ({ ...a, password: e.target.value }))} /></Field>
                        <div className="sb-oacts">
                            <Button variant="primary" size="lg" block type="submit">Continue</Button>
                            <p className="sb-fine">By continuing you agree to the <a href="/terms">Terms</a> and <a href="/privacy">Privacy Policy</a>.</p>
                        </div>
                    </form>
                </section>
            </Frame>
        );
    }

    if (step === 'company') {
        return (
            <Frame step="company">
                <section className="sb-os">
                    <form className="sb-ow" onSubmit={provision}>
                        <Back onClick={() => (user ? logout() : go('account'))} />
                        <h2>Tell us about your company</h2>
                        <p className="lede">It goes on your invoices and letters.</p>
                        {error && <div className="sb-err" role="alert" style={{ marginTop: 16 }}>{error}</div>}
                        <Field label="Your first name"><input autoComplete="given-name" value={company.first} onChange={(e) => setCompany((c) => ({ ...c, first: e.target.value }))} /></Field>
                        <Field label="Company name"><input autoComplete="organization" value={company.name} onChange={(e) => setCompany((c) => ({ ...c, name: e.target.value }))} /></Field>
                        <div className="sb-field"><label>What do you sell?</label><Segmented block label="What do you sell" value={company.sells} onChange={(v) => setCompany((c) => ({ ...c, sells: v }))} options={SELLS} /></div>
                        <div className="sb-field"><label>Team size</label><Segmented block label="Team size" value={company.size} onChange={(v) => setCompany((c) => ({ ...c, size: v }))} options={SIZES} /></div>
                        <div className="sb-oacts"><Button variant="primary" size="lg" block type="submit" disabled={busy}>{busy ? 'Creating your company…' : 'Continue'}</Button></div>
                    </form>
                </section>
            </Frame>
        );
    }

    if (step === 'cofounder') {
        return (
            <Frame step="cofounder">
                <section className="sb-os">
                    <div className="sb-ow wide">
                        <h2 className="center">Choose your cofounder</h2>
                        <p className="lede center">Same skills, different personalities. You can switch anytime.</p>
                        {error && <div className="sb-err" role="alert" style={{ marginTop: 16 }}>{error}</div>}
                        <CofounderCarousel value={pick.id} onChange={setPick} />
                        <div className="sb-pickcta"><Button variant="primary" size="lg" block onClick={chooseCofounder} disabled={busy}>Continue with {pick.name}</Button></div>
                    </div>
                </section>
            </Frame>
        );
    }

    if (step === 'headstart') {
        const toggle = (k) => setHead((h) => ({ ...h, [k]: !h[k] }));
        const onFiles = (e) => {
            const picked = [...(e.target.files || [])];
            e.target.value = '';
            const bad = picked.map(validateLibraryFile).find(Boolean);
            if (bad) setError(bad);
            setFileList((l) => [...l, ...picked.filter((f) => !validateLibraryFile(f))]);
            if (picked.length) setHead((h) => ({ ...h, files: true }));
        };
        const admin = ['owner', 'admin'].includes(orgStore.getRole() || 'owner');
        return (
            <Frame step="headstart">
                <section className="sb-os">
                    <div className="sb-ow">
                        <Back onClick={() => go('cofounder')} />
                        <h2>Give {persona.name} a head start</h2>
                        <p className="lede">Optional. You can do all of this later from Settings or the chat.</p>
                        {error && <div className="sb-err" role="alert" style={{ marginTop: 16 }}>{error}</div>}

                        <Card style={{ marginTop: 18 }}>
                            <div className="sb-toggle"><IconTile tone="a"><IconInvoice /></IconTile>
                                <span className="t"><b>Share past invoices and documents</b><small>PDFs, spreadsheets or photos. {persona.name} can read them to answer your questions.</small></span>
                                <Switch checked={head.files} onChange={() => (fileList.length ? toggle('files') : fileRef.current?.click())} label="Share documents" />
                            </div>
                            <input ref={fileRef} type="file" multiple hidden onChange={onFiles} />
                            {head.files && (
                                <div className="sb-toggle-body">
                                    <p className="sb-acnote">{fileList.length ? `${fileList.length} ${fileList.length === 1 ? 'file' : 'files'} chosen: ${fileList.map((f) => f.name).slice(0, 3).join(', ')}${fileList.length > 3 ? '…' : ''}` : 'No files chosen yet.'}</p>
                                    <Button size="sm" onClick={() => fileRef.current?.click()}>Add files</Button>
                                </div>
                            )}
                        </Card>

                        {admin && (
                            <Card style={{ marginTop: 10 }}>
                                <div className="sb-toggle"><IconTile tone="b"><IconMail /></IconTile>
                                    <span className="t"><b>Connect Gmail</b><small>Send invoices, reminders and letters from your own address.</small></span>
                                    <Switch checked={head.gmail} onChange={() => toggle('gmail')} label="Connect Gmail" />
                                </div>
                                {head.gmail && (
                                    <div className="sb-toggle-body">
                                        <Field label="Gmail address"><input type="email" value={gmail.user} onChange={(e) => setGmail((g) => ({ ...g, user: e.target.value }))} /></Field>
                                        <Field label="App password" hint="Google Account → Security → App passwords. Stored encrypted."><input type="password" autoComplete="new-password" value={gmail.pass} onChange={(e) => setGmail((g) => ({ ...g, pass: e.target.value }))} /></Field>
                                    </div>
                                )}
                            </Card>
                        )}

                        {admin && (
                            <Card style={{ marginTop: 10 }}>
                                <div className="sb-toggle"><IconTile tone="g"><IconBank /></IconTile>
                                    <span className="t"><b>Add bank and UPI</b><small>Adds a pay QR to every invoice and client link.</small></span>
                                    <Switch checked={head.bank} onChange={() => toggle('bank')} label="Add bank and UPI" />
                                </div>
                                {head.bank && (
                                    <div className="sb-toggle-body">
                                        <Field label="UPI ID"><input value={bank.upi_id} onChange={(e) => setBank((b) => ({ ...b, upi_id: e.target.value }))} placeholder="name@bank" /></Field>
                                        <Field label="Bank"><input value={bank.bank_name} onChange={(e) => setBank((b) => ({ ...b, bank_name: e.target.value }))} /></Field>
                                        <Field label="Account number"><input inputMode="numeric" value={bank.bank_account_number} onChange={(e) => setBank((b) => ({ ...b, bank_account_number: e.target.value }))} /></Field>
                                        <Field label="IFSC"><input value={bank.bank_ifsc} maxLength={11} onChange={(e) => setBank((b) => ({ ...b, bank_ifsc: e.target.value.toUpperCase() }))} /></Field>
                                    </div>
                                )}
                            </Card>
                        )}

                        <div className="sb-oacts"><Button variant="primary" size="lg" block onClick={headNext} disabled={!activeOrg?.id}>{activeOrg?.id ? 'Finish setup' : 'Setting up your company…'}</Button></div>
                    </div>
                </section>
            </Frame>
        );
    }

    return (
        <Setup persona={persona} companyName={activeOrg?.company_name || company.name} orgId={activeOrg?.id}
            head={head} files={fileList} gmail={gmail} bank={bank} updateOrganization={updateOrganization} onDone={finish} />
    );
}

/* ── setting up: a checklist of what really happened ──────────────────── */

function Setup({ persona, companyName, orgId, head, files, gmail, bank, updateOrganization, onDone }) {
    const [items, setItems] = useState(() => [
        { id: 'org', label: `Created ${companyName}`, state: 'on' },
        head.bank && { id: 'bank', label: 'Adding your pay details', state: 'wait' },
        head.gmail && { id: 'gmail', label: 'Connecting Gmail', state: 'wait' },
        head.files && files.length && { id: 'files', label: `Reading ${files.length} ${files.length === 1 ? 'file' : 'files'}`, state: 'wait' },
        { id: 'brain', label: `${persona.name} is learning your company`, state: 'wait' },
        { id: 'ready', label: `${persona.name} is ready`, state: 'wait' },
    ].filter(Boolean));
    const [finished, setFinished] = useState(false);
    const ran = useRef(false);
    const facts = useRef([]);
    const mark = (id, state, label, note) => setItems((l) => l.map((x) => (x.id === id ? { ...x, state, ...(label ? { label } : {}), note } : x)));

    useEffect(() => {
        if (ran.current || !orgId) return;
        ran.current = true;
        (async () => {
            if (head.bank) {
                mark('bank', 'run');
                try { await updateOrganization(orgId, bank); mark('bank', 'on', 'Pay details saved'); }
                catch (e) { mark('bank', 'warn', 'Pay details not saved', `${e.message}. Add them in Settings.`); }
            }
            if (head.gmail) {
                mark('gmail', 'run');
                try { await updateOrganization(orgId, { gmail_user: gmail.user, gmail_app_password: gmail.pass }); mark('gmail', 'on', 'Gmail connected'); }
                catch (e) { mark('gmail', 'warn', 'Gmail not connected', `${e.message}. Try again in Settings.`); }
            }
            if (head.files && files.length) {
                mark('files', 'run');
                let ok = 0;
                for (const f of files) {
                    try { const row = await libraryService.upload(orgId, f); if (['ready', 'partial'].includes(row?.extraction_status)) ok += 1; } catch { /* counted below */ }
                }
                if (ok) facts.current.push(`I've read ${ok} of the ${files.length === 1 ? 'file' : `${files.length} files`} you shared.`);
                mark('files', ok === files.length ? 'on' : 'warn', `Read ${ok} of ${files.length} ${files.length === 1 ? 'file' : 'files'}`,
                    ok === files.length ? undefined : 'The rest are stored; see Files in the chat.');
            }
            mark('brain', 'run');
            try {
                if (!orgStore.can('edgebrain', 'create')) throw new Error('skip');
                await buildBrain(orgId);
                mark('brain', 'on', `${persona.name} knows your company`);
            } catch (e) {
                mark('brain', 'warn', 'Learning will finish later', e.message === 'skip' ? undefined : 'You can run it again from Settings.');
            }
            mark('ready', 'on');
            setFinished(true);
        })();
    }, [orgId]); // eslint-disable-line react-hooks/exhaustive-deps -- runs once, when the org exists

    return (
        <Frame>
            <section className="sb-os sb-setup">
                <div className="sb-ow" style={{ justifyContent: 'center' }}>
                    <PixelAvatar spec={persona} className="bob" />
                    <h2 className="center" style={{ marginTop: 26 }}>{persona.name} is setting up {companyName}</h2>
                    <p className="lede center">{orgId ? 'This takes a few seconds.' : 'Loading your company…'}</p>
                    <div className="sb-chk" role="list" aria-live="polite">
                        {items.map((x) => (
                            <div key={x.id} role="listitem" className={x.state}>
                                <i aria-hidden="true" />
                                <span>{x.label}{x.note && <small>{x.note}</small>}</span>
                            </div>
                        ))}
                    </div>
                    {finished && (
                        <div className="sb-oacts" style={{ maxWidth: 320, width: '100%', margin: '28px auto 0' }}>
                            <Button variant="primary" size="lg" block autoFocus onClick={() => onDone(facts.current.join(' '))}>Meet {persona.name}</Button>
                        </div>
                    )}
                </div>
            </section>
        </Frame>
    );
}

const GoogleMark = () => (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <path d="M16.5 9.2c0-.6 0-1.1-.1-1.6H9v3h4.2a3.6 3.6 0 0 1-1.6 2.4v2h2.6c1.5-1.4 2.3-3.4 2.3-5.8z" fill="#4285F4" />
        <path d="M9 17c2.2 0 4-.7 5.3-1.9l-2.6-2c-.7.5-1.6.8-2.7.8a4.7 4.7 0 0 1-4.4-3.3H2v2.1A8 8 0 0 0 9 17z" fill="#34A853" />
        <path d="M4.6 10.6a4.8 4.8 0 0 1 0-3.1V5.4H2a8 8 0 0 0 0 7.3z" fill="#FBBC05" />
        <path d="M9 4.2c1.2 0 2.3.4 3.1 1.2l2.3-2.3A8 8 0 0 0 2 5.4l2.6 2.1A4.7 4.7 0 0 1 9 4.2z" fill="#EA4335" />
    </svg>
);
