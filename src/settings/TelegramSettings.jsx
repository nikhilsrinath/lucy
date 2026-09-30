import React, { useCallback, useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { supabase } from '../lib/supabase';
import { confirmDialog } from '../services/confirm';
import { Button, Badge, Card, Sheet, Switch } from '../design/ui';

/* ══════════════════════════════════════════════════════════════════════════
   Settings → Telegram. Talks only to /api/telegram (api/_lib/telegram/
   manage.js); the bot token never reaches the browser — only the bot's public
   username and one-time t.me links, each shown once.

     everyone   link / unlink my own Telegram, see my status
     admins     Telegram on/off, connect a group, see every member's link,
                send a member an invite link, Daily Pulse on/off + send now
   ══════════════════════════════════════════════════════════════════════════ */

async function api(body) {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Your session has expired. Sign in again.');
    const res = await fetch('/api/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify(body),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || out.success === false) throw new Error(out.error || `Request failed (${res.status})`);
    return out;
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hourLabel = (h) => new Date(2000, 0, 1, h).toLocaleTimeString('en-IN', { hour: 'numeric', hour12: true });
const tgName = (t) => (t?.telegram_username ? `@${t.telegram_username}` : t?.telegram_name || 'Telegram');
const until = (iso) => new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

export default function TelegramSettings({ orgId }) {
    const [s, setS] = useState(null);
    const [error, setError] = useState('');
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState('');
    const [linkSheet, setLinkSheet] = useState(null); // { title, url, expires_at, note }

    const load = useCallback(async () => {
        if (!orgId) return;
        try { setS(await api({ mode: 'status', org_id: orgId })); setError(''); }
        catch (e) {
            setError(/^Requires /.test(e.message) ? 'Your role does not include Buddy, so Telegram is not available to you.' : e.message);
            setS((x) => x || { unavailable: true });
        }
    }, [orgId]);
    useEffect(() => { const t = setTimeout(load, 0); return () => clearTimeout(t); }, [load]);

    const run = async (key, fn) => {
        setBusy(key); setError(''); setNote('');
        try { await fn(); await load(); } catch (e) { setError(e.message); } finally { setBusy(''); }
    };
    const showLink = async (key, body, title, hint) => run(key, async () => {
        const r = await api({ org_id: orgId, ...body });
        setLinkSheet({ title, url: r.url, expires_at: r.expires_at, note: hint });
    });

    if (!s) return (
        <section className="sb-sec" id="set-telegram"><h3>Telegram</h3><Card><div className="sb-empty">Checking…</div></Card></section>
    );

    const ready = s.configured && s.bot_username;
    return (
        <section className="sb-sec" id="set-telegram">
            <h3>Telegram</h3>
            {error && <div className="sb-err" role="alert" style={{ marginBottom: 8 }}>{error}</div>}
            {note && <div className="sb-acnote" role="status" style={{ marginBottom: 8 }}>{note}</div>}
            {s.unavailable ? null : (
                <>
                    <Card list>
                        <div className="sb-kvr">
                            <span>
                                Buddy on Telegram
                                <small style={{ display: 'block', color: 'var(--muted)', fontSize: 12 }}>
                                    {ready ? `Your team talks to the same Buddy through @${s.bot_username}, with their own permissions.` : 'The Telegram bot is not configured on the server yet.'}
                                </small>
                            </span>
                            {s.admin
                                ? <Switch label="Telegram for this company" checked={s.enabled} disabled={!ready || !!busy}
                                    onChange={(v) => run('enable', () => api({ mode: 'settings', org_id: orgId, enabled: v }))} />
                                : <Badge tone={s.enabled ? 'g' : 'n'}>{s.enabled ? 'On' : 'Off'}</Badge>}
                        </div>

                        {s.enabled && ready && (
                            <div className="sb-kvr">
                                <span>
                                    {s.me ? <>Linked as <b>{tgName(s.me)}</b></> : 'Your Telegram'}
                                    <small style={{ display: 'block', color: 'var(--muted)', fontSize: 12 }}>
                                        {s.me ? `Since ${until(s.me.linked_at)}${s.me.pulse_opt_out ? ' · daily check-ins off' : ''}` : 'Link it to ask Buddy from Telegram.'}
                                    </small>
                                </span>
                                {s.me
                                    ? <Button size="sm" variant="ghost" disabled={!!busy} onClick={async () => {
                                        if (await confirmDialog({ title: 'Unlink Telegram', message: 'Buddy will stop answering your Telegram account for this company.', confirmLabel: 'Unlink' })) run('unlink-me', () => api({ mode: 'unlink', org_id: orgId }));
                                    }}>Unlink</Button>
                                    : <Button size="sm" variant="primary" disabled={!!busy} onClick={() => showLink('link-me', { mode: 'link_token' }, 'Link your Telegram',
                                        'Open this on the phone or computer where you use Telegram and press Start. The link works once.')}>{busy === 'link-me' ? 'Creating…' : 'Link my Telegram'}</Button>}
                            </div>
                        )}
                        {s.enabled && ready && !s.app_url && s.admin && (
                            <div className="sb-kvr"><span style={{ color: 'var(--muted)', fontSize: 13 }}>Set APP_URL on the server so Telegram can offer "Review in StartupBuddy" buttons.</span></div>
                        )}
                    </Card>

                    {s.admin && s.enabled && ready && (
                        <>
                            <Card list style={{ marginTop: 10 }}>
                                <div className="sb-kvr">
                                    <span>
                                        <b style={{ fontSize: 14 }}>Company groups</b>
                                        <small style={{ display: 'block', color: 'var(--muted)', fontSize: 12 }}>Buddy answers in a group only when mentioned, and keeps money and personal details out of it.</small>
                                    </span>
                                    <Button size="sm" disabled={!!busy || !s.me} title={!s.me ? 'Link your own Telegram first' : undefined}
                                        onClick={() => showLink('group', { mode: 'group_token' }, 'Connect a group',
                                            'Open this in Telegram, pick your company group, and add Buddy. It must be you, from your linked Telegram. The link works once.')}>
                                        {busy === 'group' ? 'Creating…' : 'Connect a group'}
                                    </Button>
                                </div>
                                {!s.me && <div className="sb-kvr"><span style={{ color: 'var(--muted)', fontSize: 13 }}>Link your own Telegram first — groups are connected from your account.</span></div>}
                                {(s.groups || []).map((g) => (
                                    <div key={g.id} className="sb-kvr">
                                        <span>{g.title}<small style={{ display: 'block', color: 'var(--muted)', fontSize: 12 }}>Connected {until(g.connected_at)}</small></span>
                                        <Button size="sm" variant="ghost" disabled={!!busy} onClick={async () => {
                                            if (await confirmDialog({ title: 'Disconnect group', message: `Buddy will stop answering in “${g.title}”.`, confirmLabel: 'Disconnect' })) run(`g-${g.id}`, () => api({ mode: 'disconnect_group', org_id: orgId, id: g.id }));
                                        }}>Disconnect</Button>
                                    </div>
                                ))}
                            </Card>

                            <Card list style={{ marginTop: 10 }}>
                                <div className="sb-kvr"><span><b style={{ fontSize: 14 }}>Team on Telegram</b>
                                    <small style={{ display: 'block', color: 'var(--muted)', fontSize: 12 }}>Only StartupBuddy members can link. Their role and permissions apply on Telegram too, and removing someone here ends their Telegram access.</small></span></div>
                                {(s.members || []).map((m) => (
                                    <div key={m.user_id} className="sb-kvr">
                                        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                            {m.email || 'Member'}{m.you ? ' (you)' : ''}
                                            <small style={{ display: 'block', color: 'var(--muted)', fontSize: 12 }}>
                                                {m.role}{m.telegram ? ` · ${tgName(m.telegram)}${m.telegram.linked_via === 'invite' ? ' (invite)' : ''}` : ' · not linked'}
                                                {!m.buddy_access && ' · this role has no Buddy access (change it under Members)'}
                                            </small>
                                        </span>
                                        <span style={{ display: 'flex', gap: 6 }}>
                                            {m.telegram ? <Badge tone="g">Linked</Badge> : null}
                                            {!m.you && (m.telegram
                                                ? <Button size="sm" variant="ghost" disabled={!!busy} onClick={async () => {
                                                    if (await confirmDialog({ title: 'Unlink Telegram', message: `Buddy will stop answering ${m.email || 'this member'} on Telegram.`, confirmLabel: 'Unlink' })) run(`u-${m.user_id}`, () => api({ mode: 'unlink', org_id: orgId, user_id: m.user_id }));
                                                }}>Unlink</Button>
                                                : <Button size="sm" disabled={!!busy} onClick={() => showLink(`i-${m.user_id}`, { mode: 'invite_token', user_id: m.user_id }, `Invite ${m.email || 'member'}`,
                                                    'Send this privately to them only — whoever opens it first is linked as them. It works once and expires in 48 hours.')}>Invite link</Button>)}
                                        </span>
                                    </div>
                                ))}
                            </Card>

                            <Card list style={{ marginTop: 10 }}>
                                <div className="sb-kvr">
                                    <span>
                                        <b style={{ fontSize: 14 }}>Daily Pulse</b>
                                        <small style={{ display: 'block', color: 'var(--muted)', fontSize: 12 }}>Buddy asks linked teammates how their day went, in a private chat, and turns replies into updates they confirm. Ask Buddy “how did the team's day go?” to see it.</small>
                                    </span>
                                    <Switch label="Daily Pulse" checked={s.pulse_enabled} disabled={!!busy}
                                        onChange={(v) => run('pulse', () => api({ mode: 'settings', org_id: orgId, pulse_enabled: v }))} />
                                </div>
                                <div className="sb-kvr">
                                    <span style={{ color: 'var(--muted)', fontSize: 13 }}>Send from</span>
                                    <select aria-label="Daily Pulse hour" value={s.pulse_hour} disabled={!!busy}
                                        onChange={(e) => run('hour', () => api({ mode: 'settings', org_id: orgId, pulse_hour: Number(e.target.value) }))}
                                        style={{ height: 36, border: '1px solid var(--line)', borderRadius: 8, padding: '0 8px', font: 'inherit', fontSize: 14, width: 'auto', background: 'var(--surface)' }}>
                                        {HOURS.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
                                    </select>
                                </div>
                                <div className="sb-kvr">
                                    <span style={{ color: 'var(--muted)', fontSize: 13 }}>Goes out on the next scheduled run after this hour (company time zone). Once a day per person.</span>
                                    <Button size="sm" disabled={!!busy} onClick={() => run('pulse-now', async () => {
                                        const r = await api({ mode: 'pulse_now', org_id: orgId });
                                        setNote(r.reason || `Check-in sent to ${r.sent} ${r.sent === 1 ? 'person' : 'people'}${r.skipped ? `, ${r.skipped} skipped (already asked today or no private chat)` : ''}.`);
                                    })}>{busy === 'pulse-now' ? 'Sending…' : 'Send now'}</Button>
                                </div>
                            </Card>
                        </>
                    )}
                </>
            )}

            {linkSheet && (
                <Sheet open onClose={() => { setLinkSheet(null); load(); }} title={linkSheet.title}
                    footer={<Button variant="primary" block size="lg" as="a" href={linkSheet.url} target="_blank" rel="noopener noreferrer">Open Telegram</Button>}>
                    <p className="sb-acnote">{linkSheet.note}</p>
                    <div style={{ display: 'grid', placeItems: 'center', padding: 12 }}>
                        <QRCodeSVG value={linkSheet.url} size={180} />
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <code style={{ fontSize: 12, wordBreak: 'break-all', flex: 1 }}>{linkSheet.url}</code>
                        <Button size="sm" onClick={() => navigator.clipboard?.writeText(linkSheet.url)}>Copy</Button>
                    </div>
                    <p className="sb-acnote">Expires {until(linkSheet.expires_at)}.</p>
                </Sheet>
            )}
        </section>
    );
}
