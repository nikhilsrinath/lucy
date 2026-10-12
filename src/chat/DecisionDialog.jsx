import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { CofounderAvatar, MoodBackground } from '../design/art/Art';
import ActionCard from './ActionCard';
import PlanCard from './PlanCard';
import { decisionTitle } from './exchange';

/* ══════════════════════════════════════════════════════════════════════════
   A decision, in the middle of the screen. Whatever waits for the person to
   choose (exchange.pendingDecision) — a proposed change, a plan, a question
   with quick picks — is shown here over the blurred screen, never inline.

   Top: the cofounder's mood as it stands — the scene, the headline word, the
   tag and the sticker. Below: the thing to choose, using the same card and
   the same buttons as before. Nothing here decides anything; the buttons call
   the store with the message's id and the server re-checks.

   Tapping outside, Escape and "Decide later" all put it away without
   cancelling: the panel keeps a button that opens it again.
   ══════════════════════════════════════════════════════════════════════════ */

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])';

/** Records the card is about — only what the card itself references. */
function ContextChips({ card, onOpen }) {
    const chips = [];
    const seen = new Set();
    for (const e of card.entities || []) {
        if (!e?.id || seen.has(e.id) || !e.href) continue;
        seen.add(e.id);
        chips.push({ key: e.id, label: e.label, href: e.href });
    }
    if (card.target?.href && card.target.label && !chips.some((c) => c.label === card.target.label)) {
        chips.unshift({ key: 'target', label: card.target.label, href: card.target.href });
    }
    if (!chips.length || card.status !== 'proposed') return null;
    return (
        <div className="sb-ctx">
            {chips.slice(0, 3).map((c) => (
                <button key={c.key} type="button" onClick={() => onOpen(c.href, card)}>{c.label}</button>
            ))}
        </div>
    );
}

/** The dialog's two parts, without the overlay: the mood, then the choice. */
export function DecisionBody({ m, a, persona, stage, onOpen, onLater }) {
    const isCard = m.kind === 'action';
    const Card = isCard && m.card.kind === 'plan' ? PlanCard : ActionCard;
    const options = m.choice?.options || m.input?.options || [];
    return (
        <>
            <div className="mcd-scene">
                <MoodBackground id={persona.art} mood={stage.mood} className="on" />
                <div className="mcd-head">
                    <div className="word">{stage.word}</div>
                    <span className="tag">{stage.tag}</span>
                </div>
                <CofounderAvatar id={persona.art} mood={stage.mood} className="mcd-avatar pop" />
            </div>
            <div className="mcd-body">
                {isCard ? (
                    <>
                        <ContextChips card={m.card} onOpen={onOpen} />
                        <Card
                            card={m.card}
                            onConfirm={(opts) => a.confirmCard(m.id, opts)}
                            onCancel={() => a.cancelCard(m.id)}
                            onUndo={() => a.undoCard(m.id)}
                            onRetry={() => a.retryCard(m.id)}
                            onOpen={onOpen}
                        />
                    </>
                ) : (
                    <div className="mcd-ask" role="group" aria-label={decisionTitle(m)}>
                        <p className="q">{decisionTitle(m)}{m.hint && <small className="mc-hint">{m.hint}</small>}</p>
                        <div className="mc-picks">
                            {options.map((o) => (
                                <button key={`${o.value}`} type="button" className="mc-pick" disabled={a.streaming}
                                    onClick={() => a.answer(m.id, o)} aria-label={o.sub ? `${o.label}, ${o.sub}` : o.label}>
                                    {o.label}{o.sub && <small>{o.sub}</small>}
                                </button>
                            ))}
                        </div>
                    </div>
                )}
            </div>
            <div className="mcd-foot">
                <button type="button" className="mcd-later" onClick={onLater}>{m.kind === 'input' ? 'Type it instead' : 'Decide later'}</button>
            </div>
        </>
    );
}

export default function DecisionDialog({ m, a, persona, stage, onOpen, onLater }) {
    const ref = useRef(null);

    // Focus moves into the dialog and goes back to where it was.
    useLayoutEffect(() => {
        const opener = document.activeElement;
        ref.current?.focus({ preventScroll: true });
        return () => {
            if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus({ preventScroll: true });
        };
    }, [m.id]);

    useEffect(() => {
        const onKey = (e) => {
            const box = ref.current;
            if (!box) return;
            // Escape puts the decision away; it never cancels it.
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onLater(); return; }
            if (e.key !== 'Tab') return;
            const nodes = Array.from(box.querySelectorAll(FOCUSABLE)).filter((n) => n.offsetParent !== null);
            if (!nodes.length) { e.preventDefault(); return; }
            const first = nodes[0];
            const last = nodes[nodes.length - 1];
            if (!box.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
            else if (e.shiftKey && (document.activeElement === first || document.activeElement === box)) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        };
        // Capture: the card's own Escape (cancel) must not see it first.
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
    }, [onLater]);

    return createPortal(
        <div className={`sb mc mcd mood-${stage.mood}`}>
            <div className="mcd-scrim" onClick={onLater} aria-hidden="true" />
            <div ref={ref} className="mcd-box" role="dialog" aria-modal="true" tabIndex={-1}
                aria-label={`${persona.name} needs your decision: ${decisionTitle(m)}`}>
                <DecisionBody m={m} a={a} persona={persona} stage={stage} onOpen={onOpen} onLater={onLater} />
            </div>
        </div>,
        document.body,
    );
}
