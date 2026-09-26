import React from 'react';

/* One missing detail, asked as one question. The chips are the likely
   answers; typing any other answer works too — the next message is read as
   the answer first (api/agent.js `pending`), and only reaches the model if
   it cannot be. */
export default function FollowUpChips({ options, onPick, disabled, label }) {
    if (!options?.length) return null;
    return (
        <div className="cp-chips" role="group" aria-label={label || 'Suggested answers'}>
            {options.map((o) => (
                <button key={`${o.value}`} type="button" className="cp-chip" disabled={disabled} onClick={() => onPick(o)}>
                    {o.label}
                </button>
            ))}
        </div>
    );
}
