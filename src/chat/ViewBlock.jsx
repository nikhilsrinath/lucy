import React from 'react';
import { Badge, Button, IconTile } from '../design/ui';
import { IconDoc, IconMail, IconTask, IconBolt, IconClose, IconChevronRight, IconAlert } from '../design/icons';
import './operator.css';

/* ══════════════════════════════════════════════════════════════════════════
   Structured blocks under Buddy's words — figures, lists, a timeline,
   "Buddy noticed". Built on the server from the read tool's own result
   (api/_lib/agent/views.js); this only lays them out. Display-only: nothing
   here changes data. An insight's buttons ask Buddy (which proposes a card)
   or open a page.
   ══════════════════════════════════════════════════════════════════════════ */

const INSIGHT_ICON = {
    overdue_invoices: IconDoc, stale_quotes: IconDoc, bills_due: IconDoc, spend_spike: IconBolt,
    due_soon: IconTask, overdue_tasks: IconTask, slipping_task: IconTask, project_risk: IconTask, inactive_leads: IconMail,
};

/** One "Buddy noticed" card: what, why, and one or two next steps. */
export function InsightRow({ insight, onAction, onDismiss, compact = false, disabled = false }) {
    const Icon = INSIGHT_ICON[insight.kind] || IconBolt;
    const actions = (insight.actions || []).slice(0, 2);
    return (
        <div className={`sb-ins${compact ? ' compact' : ''}`} role="group" aria-label={insight.title}>
            <IconTile tone={insight.tone || 'n'}><Icon /></IconTile>
            <div className="sb-ins-b">
                <div className="sb-ins-t">
                    <b>{insight.title}</b>
                    {insight.severity === 'high' && <Badge tone="r">Urgent</Badge>}
                </div>
                {insight.reason && <p className="sb-ins-r">{insight.reason}</p>}
                {actions.length > 0 && (
                    <div className="sb-ins-a">
                        {actions.map((a, i) => (
                            <Button key={a.label} size="sm" variant={i === 0 ? 'primary' : 'ghost'} disabled={disabled && a.kind === 'ask'}
                                onClick={() => onAction?.(insight, a)}>
                                {a.label}{a.kind === 'open' && <IconChevronRight size={12} />}
                            </Button>
                        ))}
                    </div>
                )}
            </div>
            {onDismiss && (
                <button type="button" className="sb-ins-x" onClick={() => onDismiss(insight.id)} aria-label={`Hide “${insight.title}” for 3 days`} title="Hide for 3 days">
                    <IconClose size={12} />
                </button>
            )}
        </div>
    );
}

function Metrics({ view, onOpen }) {
    return (
        <div className={`sb-vmet n${Math.min(view.items.length, 4)}`}>
            {view.items.map((m) => (
                <div key={m.label} className="sb-vm">
                    <span className="kl">{m.label}</span>
                    <span className="kv sb-num">{m.value}</span>
                    {m.sub && <span className="ks"><i className={`sb-dot ${m.tone || 'n'}`} aria-hidden="true" />{m.sub}</span>}
                    {!m.sub && m.tone && m.tone !== 'n' && <span className="ks"><i className={`sb-dot ${m.tone}`} aria-hidden="true" />{m.tone === 'g' ? 'Healthy' : m.tone === 'r' ? 'Needs attention' : 'Watch'}</span>}
                </div>
            ))}
            {view.href && <button type="button" className="sb-vlink" onClick={() => onOpen(view.href)}>Open<IconChevronRight size={12} /></button>}
        </div>
    );
}

function List({ view, onOpen }) {
    return (
        <>
            {view.warning && <p className="sb-vwarn"><IconAlert size={13} /> {view.warning}</p>}
            <ul className="sb-vlist">
                {view.items.map((it, i) => {
                    const body = (
                        <>
                            <span className="t"><b>{it.title}</b>{it.sub && <small>{it.sub}</small>}</span>
                            <span className="r">
                                {it.value && <span className="v sb-num">{it.value}</span>}
                                {it.badge && <Badge tone={it.tone || 'n'} plain={!it.tone || it.tone === 'n'}>{it.badge}</Badge>}
                            </span>
                        </>
                    );
                    return (
                        <li key={`${it.title}-${i}`}>
                            {it.href ? <button type="button" onClick={() => onOpen(it.href)}>{body}</button> : <div>{body}</div>}
                        </li>
                    );
                })}
            </ul>
            {(view.more > 0 || view.href) && (
                <div className="sb-vfoot">
                    {view.more > 0 && <span>{view.more} more</span>}
                    {view.href && <button type="button" className="sb-vlink" onClick={() => onOpen(view.href)}>See all<IconChevronRight size={12} /></button>}
                </div>
            )}
        </>
    );
}

function Timeline({ view }) {
    return (
        <ol className="sb-vtime">
            {view.items.map((it, i) => (
                <li key={i}>
                    <i className={`sb-dot ${it.tone || 'n'}`} aria-hidden="true" />
                    <span><b>{it.title}</b>{it.sub && <small>{it.sub}</small>}</span>
                    {it.at && <time className="sb-num" dateTime={it.at}>{new Date(it.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</time>}
                </li>
            ))}
        </ol>
    );
}

export default function ViewBlock({ view, onOpen, onInsight, busy }) {
    if (!view?.items?.length) {
        return view?.type === 'insights'
            ? <div className="sb-cd sb-view"><div className="sb-vh"><span>{view.title}</span></div><p className="sb-vempty">Nothing needs you right now — no overdue invoices, slipping work or risks found.</p></div>
            : null;
    }
    return (
        <section className={`sb-cd sb-view t-${view.type}`} aria-label={view.title}>
            <div className="sb-vh">
                <span>{view.title}</span>
                {view.type !== 'metrics' && (view.total ?? view.items.length) > 0 && <span className="c sb-num">{view.total ?? view.items.length}</span>}
            </div>
            {view.type === 'metrics' && <Metrics view={view} onOpen={onOpen} />}
            {view.type === 'list' && <List view={view} onOpen={onOpen} />}
            {view.type === 'timeline' && <Timeline view={view} />}
            {view.type === 'insights' && (
                <div className="sb-vins">
                    {view.items.map((ins) => <InsightRow key={ins.id} insight={ins} compact onAction={onInsight} disabled={busy} />)}
                </div>
            )}
        </section>
    );
}
