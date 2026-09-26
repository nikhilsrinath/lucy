// How a card reads as text — spoken on a call, copied into a shared
// transcript, and sent back to the agent as the conversation so far.

/** What a card says when it is read aloud, copied, or sent back as history. */
export function cardLine(card) {
    if (!card) return '';
    if (card.status === 'executed') return card.summary || 'Done.';
    if (card.status === 'undone') return `Undone: ${card.title}.`;
    if (card.status === 'cancelled') return `Cancelled: ${card.title}. Nothing was changed.`;
    if (card.status === 'expired') return `Expired: ${card.title}. Nothing was changed.`;
    if (card.status === 'failed') return `Failed: ${card.title}. ${card.error || ''}`.trim();
    const diff = (card.diff || []).map((d) => `${d.label} ${d.from} → ${d.to}`).join('; ');
    const items = card.items?.length ? `${card.items.length} items` : '';
    return `Proposed: ${card.title}${card.target ? ` — ${card.target.label}` : ''}${diff ? ` (${diff})` : items ? ` (${items})` : ''}. Not done until confirmed.`;
}

