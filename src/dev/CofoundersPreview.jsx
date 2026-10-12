import React, { useState } from 'react';
import { PERSONAS, SITUATIONS, ACTIONS } from '../design/personas';
import CofounderChooser from '../design/CofounderChooser';
import { CofounderAvatar, CofounderFace, MoodBackground, MoodBackdrop } from '../design/art/Art';
import { backgroundSvg, BG_MOODS } from '../design/art/backgrounds';
import DecisionDialog from '../chat/DecisionDialog';
import { decisionTitle } from '../chat/exchange';
import '../chat/chat.css';
import '../chat/mood.css';
import './preview.css';

/* /dev/cofounders — the three cofounders × eight moods, and one situation
   answered by all three side by side. Reads the cofounder files and the
   drawings only: no sign-in, no model, no data.

   /dev/cofounders?shot=<id>-<mood> shows one chat screen frame on its own,
   which is what the screenshots are taken from. Add &decide to open that
   frame's decision dialog over it. */

const MEANING = new Map(ACTIONS.map((a) => [a.id, a.meaning]));
const kb = (s) => `${(new Blob([s]).size / 1024).toFixed(1)} KB`;

// One illustrative exchange per mood (made-up figures: this page shows no real data).
// `situation` supplies the cofounder's own words; `say` is used where no situation applies.
const DEMO = {
    neutral: { q: 'How many tasks are open?', tag: 'Here you go', say: 'Seven open, two of them due this week.' },
    explaining: { q: 'How should I price the retainer?', tag: "Here's how", say: 'Start from what a month of the work costs you, add your margin, then check it against what they pay today.' },
    surprised: { q: 'How much did we spend this month?', situation: 'unusual_spend' },
    disappointed: { q: 'Kite went with someone else.', situation: 'deal_lost' },
    serious: { q: 'Who owes me money?', situation: 'overdue_invoice', card: { type: 'Payment reminder', title: 'Kite Retail', amt: '₹62,000', cls: 'neg', meta: 'INV-0038 · 14 days overdue', p: 'Review email' } },
    happy: { q: 'Did Nova Foods pay?', situation: 'payment_received', card: { type: 'Record payment', title: 'Nova Foods', amt: '+₹1,20,000', cls: 'pos', meta: 'INV-0031 · UPI', p: 'Confirm' } },
    thinking: { q: 'Log ₹12k I paid yesterday', situation: 'missing_info', picks: ['Team lunch', 'Software', 'Travel', 'Something else'] },
    laughing: { q: 'Did Zephyr accept the quote?', situation: 'deal_won', card: { type: 'Convert to invoice', title: 'Zephyr Health', amt: '₹1,77,000', cls: '', meta: 'QT-0012 · IGST 18% included', p: 'Create invoice' } },
};

const TOOL = { 'Payment reminder': 'send_payment_reminder', 'Record payment': 'record_payment', 'Convert to invoice': 'convert_quotation' };
const noop = () => {};
const FAKE = { streaming: false, confirmCard: noop, cancelCard: noop, undoCard: noop, retryCard: noop, answer: noop };

/** The demo's card or picks as the message the decision dialog is handed. */
function demoDecision(demo, say) {
    if (demo.card) {
        return {
            id: 'demo', kind: 'action', card: {
                status: 'proposed', tool: TOOL[demo.card.type], title: demo.card.title, confirmLabel: demo.card.p, reason: say,
                preview: { rows: [['Amount', demo.card.amt], ['Reference', demo.card.meta]] }, fields: [{ key: 'note', label: 'Note', value: '' }],
            },
        };
    }
    if (demo.picks) return { id: 'demo', kind: 'input', content: say, input: { options: demo.picks.map((p) => ({ label: p, value: p })) } };
    return null;
}

/** A static frame of the chat screen, built from the same pieces and styles. */
export function Frame({ persona, mood, decide = false }) {
    const demo = DEMO[mood];
    const stage = { headline_word: persona.headlines[mood], tag: demo.tag || SITUATIONS.find((x) => x.id === demo.situation)?.tag };
    const say = demo.say || persona.playbooks[demo.situation].summary;
    const decision = demoDecision(demo, say);
    const size = say.length <= 90 ? 'xl' : say.length <= 240 ? 'lg' : 'md';
    return (
        <div className="pv-phone">
            <section className={`sb-chat mc mood-${mood}`}>
                <div className="mc-stage">
                    <MoodBackdrop id={persona.art} mood={mood} />
                    <div className="mc-in">
                        <header className="mc-top">
                            <span className="mc-pill"><CofounderFace id={persona.art} mood={mood} size={24} />{persona.name} <small>· {persona.role}</small></span>
                            <span className="mc-ib" aria-hidden="true">☎</span>
                        </header>
                        <div className="mc-head"><div className="word">{stage.headline_word}</div><span className="tag">{stage.tag}</span></div>
                        <CofounderAvatar id={persona.art} mood={mood} className="mc-avatar" />
                    </div>
                </div>
                <div className="mc-panel">
                    <div className="mc-scroll">
                        <div className="mc-x">
                            <p className="mc-q"><span>You asked</span>{demo.q}</p>
                            <div className="mc-a">
                                <div className={`sb-say mc-say ${size}`}>{say}</div>
                                {decision && (
                                    <span className="mc-wait">
                                        <span><small>Needs your decision</small><b>{decisionTitle(decision)}</b></span>
                                        <em>{demo.card ? 'Review' : 'Choose'}</em>
                                    </span>
                                )}
                            </div>
                        </div>
                    </div>
                    <div className="pv-composer"><span>Ask {persona.name} anything…</span><i>↑</i></div>
                </div>
            </section>
            {decide && decision && (
                <DecisionDialog m={decision} a={FAKE} persona={persona} onOpen={noop} onLater={noop}
                    stage={{ mood, word: stage.headline_word, tag: stage.tag }} />
            )}
        </div>
    );
}

export default function CofoundersPreview() {
    const shot = new URLSearchParams(window.location.search).get('shot');
    const [situation, setSituation] = useState('overdue_invoice');

    if (shot) {
        const [id, mood] = shot.split('-');
        const persona = PERSONAS.find((p) => p.id === id);
        const decide = new URLSearchParams(window.location.search).has('decide');
        if (persona && BG_MOODS.includes(mood)) return <div className="pv pv-shot"><Frame persona={persona} mood={mood} decide={decide} /></div>;
    }

    const s = SITUATIONS.find((x) => x.id === situation);
    return (
        <div className="pv">
            <h1>Cofounders</h1>
            <p className="pv-lede">Three cofounders × eight moods. The avatars are stickers in <code>src/design/art/stickers</code>; the backgrounds are SVG, with their size under each.</p>

            <div className="pv-grid">
                <div />
                {BG_MOODS.map((m) => <div key={m} className="pv-col">{m}</div>)}
                {PERSONAS.map((p) => (
                    <React.Fragment key={p.id}>
                        <div className="pv-row"><CofounderFace id={p.art} size={44} /><b>{p.name}</b><small>{p.title}</small></div>
                        {BG_MOODS.map((m) => (
                            <figure key={m} className="pv-cell">
                                <div className="art"><MoodBackground id={p.art} mood={m} /><CofounderAvatar id={p.art} mood={m} label={`${p.name}, ${m}`} /></div>
                                <figcaption>“{p.headlines[m]}” <span>bg {kb(backgroundSvg(p.art, m))}</span></figcaption>
                            </figure>
                        ))}
                    </React.Fragment>
                ))}
            </div>

            <h2>Choosing a cofounder</h2>
            <div className="pv-choose sb">
                <CofounderChooser value="steve" answers={{ stage: 'first_customers', problem: 'product', risk: 'bold', pushback: 'hard' }} onPick={() => {}} />
                <CofounderChooser value="elon" answers={{ stage: 'steady', problem: 'cash', risk: 'careful', pushback: 'gentle' }} onPick={() => {}} startFlipped />
            </div>

            <h2>One situation, three answers</h2>
            <div className="pv-pick">
                <label htmlFor="pv-sit">Situation</label>
                <select id="pv-sit" value={situation} onChange={(e) => setSituation(e.target.value)}>
                    {SITUATIONS.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
                </select>
                <span className={`pv-mood ${s.mood}`}>{s.mood}</span>
            </div>
            <div className="pv-three">
                {PERSONAS.map((p) => {
                    const pb = p.playbooks[situation];
                    return (
                        <article key={p.id} className="pv-answer">
                            <header><CofounderFace id={p.art} mood={s.mood} size={40} /><div><b>{p.name}</b><small>{p.title}</small></div><span className="word">{p.headlines[s.mood]}</span></header>
                            <p className="sum">{pb.summary}</p>
                            <ol>{pb.actions.map((a) => <li key={a}><b>{a.replace(/_/g, ' ')}</b><small>{MEANING.get(a)}</small></li>)}</ol>
                            {p.examples[situation] && <pre>{p.examples[situation]}</pre>}
                        </article>
                    );
                })}
            </div>

            <h2>Chat screen frames</h2>
            <div className="pv-frames">
                {PERSONAS.flatMap((p) => BG_MOODS.map((m) => (
                    <figure key={`${p.id}-${m}`}><Frame persona={p} mood={m} /><figcaption>{p.name} · {m}</figcaption></figure>
                )))}
            </div>
        </div>
    );
}
