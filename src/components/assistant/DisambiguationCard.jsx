import React, { useId } from 'react';

/* Several records matched what was said. The agent does not guess: it asks,
   and each candidate is a button carrying enough to tell them apart. */
export default function DisambiguationCard({ message, onPick, disabled }) {
    const id = useId();
    const { choice } = message;
    return (
        <div role="group" aria-labelledby={id} className="cp-choice">
            <div id={id} className="cp-choice-q">{choice.question}</div>
            {!message.resolved && (
                <div className="cp-chips">
                    {choice.options.map((o) => (
                        <button key={o.value} type="button" className="cp-chip is-tall" disabled={disabled}
                            onClick={() => onPick(o)} aria-label={o.sub ? `${o.label}, ${o.sub}` : o.label}>
                            <span>{o.label}</span>
                            {o.sub && <span className="cp-chip-sub">{o.sub}</span>}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
