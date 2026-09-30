// How a card reads as text — spoken on a call, copied into a shared
// transcript, and sent back to the agent as the conversation so far.

/** What a card says when it is read aloud, copied, or sent back as history. */
export function cardLine(card) {
    if (!card) return '';
    if (card.kind === 'plan') return planLine(card);
    if (card.status === 'executed') return card.summary || 'Done.';
    if (card.status === 'undone') return `Undone: ${card.title}.`;
    if (card.status === 'cancelled') return `Cancelled: ${card.title}. Nothing was changed.`;
    if (card.status === 'expired') return `Expired: ${card.title}. Nothing was changed.`;
    if (card.status === 'failed') return `Failed: ${card.title}. ${card.error || ''}`.trim();
    const diff = (card.diff || []).map((d) => `${d.label} ${d.from} → ${d.to}`).join('; ');
    const items = card.items?.length ? `${card.items.length} items` : '';
    return `Proposed: ${card.title}${card.target ? ` — ${card.target.label}` : ''}${diff ? ` (${diff})` : items ? ` (${items})` : ''}. Not done until confirmed.`;
}


/** A plan, as one line per state — what the model reads back as history. */
function planLine(card) {
    const n = (card.steps || []).length;
    if (card.status === 'executed') {
        const bad = (card.step_results || []).filter((r) => r.ok === false);
        return `Plan “${card.title}”: ${card.summary || 'done'}${bad.length ? ` Failed: ${bad.map((r) => `step ${r.n} (${r.error})`).join('; ')}.` : ''}`;
    }
    if (card.status === 'undone') return `Undone: plan “${card.title}”.`;
    if (card.status === 'cancelled') return `Cancelled: plan “${card.title}”. Nothing was changed.`;
    if (card.status === 'expired') return `Expired: plan “${card.title}”. Nothing was changed.`;
    if (card.status === 'failed') return `Failed: plan “${card.title}”. ${card.error || ''}`.trim();
    const steps = (card.steps || []).map((s) => `${s.n}. ${s.title}${(s.diff || [])[0] ? ` ${s.diff[0].to}` : ''}`).join('; ');
    return `Proposed plan “${card.title}” (${n} steps: ${steps}). Not done until approved.`;
}
