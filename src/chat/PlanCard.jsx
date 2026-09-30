import React, { useEffect, useId, useState } from 'react';
import { Badge, Button, IconTile } from '../design/ui';
import { IconSparkle, IconClock, IconCheckCircle, IconAlert, IconUndo, IconRefresh, IconClose } from '../design/icons';
import { EditField } from './ActionCard';
import './operator.css';

/* ══════════════════════════════════════════════════════════════════════════
   A plan Buddy proposed for a goal — several changes, one approval
   (api/_lib/agent/plans.js). Same contract as ActionCard: the server stored
   the proposal, this shows it, the buttons send confirm / cancel / undo /
   retry with the plan's id, and the server re-checks every step when it runs.

     proposed   the goal, Buddy's approach, the steps (untick to leave one
                out, Edit to change a step's fields), Approve · Edit · Cancel
     executing  Working… while the steps run
     executed   each step ✓ / ✗ with what happened; Undo for 10 minutes;
                "Retry failed steps" when some did not go through
     failed     what went wrong, Try again
     cancelled / expired / undone   one quiet strip
   ══════════════════════════════════════════════════════════════════════════ */

function Rich({ text }) {
    return String(text || '').split(/(\*\*[^*]+\*\*)/g).map((p, i) => (p.startsWith('**') && p.endsWith('**')
        ? <strong key={i}>{p.slice(2, -2)}</strong>
        : <React.Fragment key={i}>{p}</React.Fragment>));
}

function useNow(active) {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!active) return undefined;
        const id = setInterval(() => setNow(Date.now()), 15000);
        return () => clearInterval(id);
    }, [active]);
    return now;
}

/** "Title · 12 Oct · Ravi" — the new values of a step, in one line. */
const detailOf = (s) => {
    const vals = (s.diff || []).filter((d) => d.key !== 'title' && d.key !== 'name').map((d) => d.to).filter((v) => v && v !== '—');
    if (vals.length) return vals.slice(0, 4).join(' · ');
    if (s.items?.length) return `${s.items.length} records`;
    return null;
};
const nameOf = (s) => (s.diff || []).find((d) => d.key === 'title' || d.key === 'name')?.to || null;

export default function PlanCard({ card, onConfirm, onCancel, onUndo, onRetry, onOpen }) {
    const headingId = useId();
    const steps = card.steps || [];
    const [chosen, setChosen] = useState(() => new Set(steps.map((s) => s.n)));
    const [editing, setEditing] = useState(false);
    const [edits, setEdits] = useState({});
    const status = card.status;
    const now = useNow(status === 'executed' || status === 'proposed');
    const minutesLeft = status === 'proposed' && card.expires_at ? Math.max(0, Math.round((Date.parse(card.expires_at) - now) / 60000)) : null;
    const lapsed = minutesLeft === 0;
    const busy = status === 'executing' || status === 'confirmed';
    const canUndo = status === 'executed' && card.undo_until && Date.parse(card.undo_until) > now;
    const results = new Map((card.step_results || []).map((r) => [r.n, r]));

    const approve = () => {
        if (status !== 'proposed' || lapsed || !chosen.size) return;
        const stepEdits = Object.fromEntries(Object.entries(edits).filter(([, v]) => v && Object.keys(v).length));
        onConfirm({
            selected: chosen.size === steps.length ? undefined : [...chosen],
            edits: Object.keys(stepEdits).length ? stepEdits : undefined,
        });
        setEditing(false);
    };
    const onKeyDown = (e) => {
        if (status !== 'proposed') return;
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); approve(); }
        if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); if (editing) setEditing(false); else onCancel(); }
    };

    const header = (
        <div className="sb-ach">
            <IconTile tone="b"><IconSparkle size={14} /></IconTile>
            <span>Plan · {steps.length} steps</span>
            <span className="right">
                {minutesLeft !== null && !lapsed && <span className="exp" title="Minutes left to approve"><IconClock size={12} />{minutesLeft} min</span>}
                {(status === 'proposed' || busy) && <Badge tone="a">Review first</Badge>}
                {status === 'executed' && (card.partial ? <Badge tone="a">Partly done</Badge> : <Badge tone="g">Done</Badge>)}
            </span>
        </div>
    );

    const quiet = status === 'cancelled' || status === 'expired' || status === 'undone' || (status === 'proposed' && lapsed);
    if (quiet) {
        return (
            <section className="sb-cd sb-ac sb-plan dim" aria-labelledby={headingId}>
                {header}
                <div className="sb-acb"><h4 id={headingId}>{card.title}</h4></div>
                <div className="sb-acdone x">
                    {status === 'undone' && <IconUndo />}
                    <span className="txt">{status === 'undone' ? (card.summary?.includes('left as they are') ? card.summary.slice(card.summary.indexOf('Undone ')) : 'Undone. Everything the plan created or changed was put back.')
                        : status === 'cancelled' ? 'Cancelled. Nothing was changed.' : 'Expired. Nothing was changed — ask again and I will prepare it fresh.'}</span>
                </div>
            </section>
        );
    }

    const ran = status === 'executed' || status === 'failed';
    return (
        <section className="sb-cd sb-ac sb-plan" aria-labelledby={headingId} onKeyDown={onKeyDown}>
            {header}
            <div className="sb-acb">
                <h4 id={headingId}>{card.goal || card.title}</h4>
                {(card.approach || card.reason) && !ran && <p className="sb-why"><b>Why this plan</b>{card.approach || card.reason}</p>}

                <ol className="sb-steps">
                    {steps.map((s) => {
                        const r = results.get(s.n);
                        const on = chosen.has(s.n);
                        const name = nameOf(s);
                        const detail = detailOf(s);
                        const state = !ran ? null : r?.skipped ? 'skip' : r?.ok ? 'ok' : r ? 'bad' : 'skip';
                        return (
                            <li key={s.n} className={`${!ran && !on ? 'off' : ''} ${state ? `st-${state}` : ''}`.trim()}>
                                {!ran ? (
                                    <input type="checkbox" checked={on} disabled={busy} aria-label={`Include step ${s.n}: ${s.title}${name ? ` ${name}` : ''}`}
                                        onChange={(e) => setChosen((c) => { const n = new Set(c); if (e.target.checked) n.add(s.n); else n.delete(s.n); return n; })} />
                                ) : (
                                    <span className="mk" aria-hidden="true">{state === 'ok' ? <IconCheckCircle size={15} /> : state === 'bad' ? <IconAlert size={15} /> : <IconClose size={11} />}</span>
                                )}
                                <div className="sb-step">
                                    <div className="h"><span className="num sb-num">{s.n}</span><b>{s.title}</b>{name && <span className="nm">{name}</span>}</div>
                                    {!ran && detail && <div className="d">{detail}</div>}
                                    {!ran && s.why && <div className="w">{s.why}</div>}
                                    {ran && r && <div className={`d ${state}`}><Rich text={r.ok ? r.summary : r.skipped ? 'Left out.' : r.error} /></div>}
                                    {editing && on && !ran && (s.fields || []).length > 0 && (
                                        <div className="sb-acedit">
                                            {s.fields.map((f) => (
                                                <EditField key={f.key} field={f} value={edits[s.n]?.[f.key] ?? f.value ?? ''}
                                                    onChange={(v) => setEdits((e) => ({ ...e, [s.n]: { ...(e[s.n] || {}), [f.key]: v } }))} />
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </li>
                        );
                    })}
                </ol>
                {card.error && status === 'proposed' && <p className="sb-acerr" role="alert">{card.error}</p>}
            </div>

            {status === 'executed' && (
                <div className={`sb-acdone${card.partial ? ' warn' : ''}`}>
                    {card.partial ? <IconAlert /> : <IconCheckCircle />}
                    <span className="txt"><Rich text={card.summary || 'Done.'} /></span>
                    {canUndo && <button type="button" className="lnk" onClick={onUndo}>Undo all</button>}
                    {card.href && <button type="button" className="lnk" onClick={() => onOpen(card.href, card)}>Open</button>}
                </div>
            )}
            {status === 'executed' && card.partial && (
                <div className="sb-acf"><Button size="sm" onClick={onRetry}><IconRefresh /> Retry failed steps</Button></div>
            )}
            {status === 'failed' && (
                <>
                    <div className="sb-acdone bad" role="alert"><IconAlert /><span className="txt">{card.error || 'The plan could not be carried out.'} Nothing was changed.</span></div>
                    <div className="sb-acf"><Button size="sm" onClick={onRetry}><IconRefresh /> Try again</Button></div>
                </>
            )}
            {(status === 'proposed' || busy) && (
                <div className="sb-acf">
                    <Button variant="primary" size="sm" onClick={approve} disabled={busy || !chosen.size} aria-keyshortcuts="Control+Enter Meta+Enter">
                        {busy ? `Working… ${chosen.size} steps` : chosen.size === steps.length ? (card.confirmLabel || `Approve ${steps.length} steps`) : `Approve ${chosen.size} of ${steps.length}`}
                    </Button>
                    {steps.some((s) => (s.fields || []).length) && !busy && (
                        <Button size="sm" aria-pressed={editing} onClick={() => setEditing((v) => !v)}>{editing ? 'Done editing' : 'Edit'}</Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy} aria-keyshortcuts="Escape">Cancel</Button>
                </div>
            )}
            <span className="sb-sr" aria-live="polite">
                {busy ? 'Working…' : status === 'proposed' ? 'Waiting for your approval. Nothing has changed yet.' : status === 'executed' ? card.summary : ''}
            </span>
        </section>
    );
}
