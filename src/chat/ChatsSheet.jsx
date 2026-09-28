import React, { useState } from 'react';
import { useAssistant } from '../components/assistant/assistantStore';
import { confirmDialog } from '../services/confirm';
import { Sheet, Button } from '../design/ui';
import { IconMore } from '../design/icons';

/** "just now", "12m ago", "Tue", "4 Sept". */
function when(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const min = Math.floor((Date.now() - d.getTime()) / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min}m ago`;
    if (min < 24 * 60 && new Date().getDate() === d.getDate()) return `${Math.floor(min / 60)}h ago`;
    if (min < 6 * 24 * 60) return d.toLocaleDateString('en-IN', { weekday: 'short' });
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

/* Recent chats on a phone (the sidebar lists them on wider screens), with
   the history's own tools: search, rename, pin, share, delete. */
export default function ChatsSheet({ open, onClose }) {
    const a = useAssistant();
    const [q, setQ] = useState('');
    const [renaming, setRenaming] = useState(null);
    const [more, setMore] = useState(null);
    const needle = q.trim().toLowerCase();
    const used = a.chats.filter((c) => c.messages.length || c.titled)
        .sort((x, y) => (y.pinned ? 1 : 0) - (x.pinned ? 1 : 0) || (y.at || 0) - (x.at || 0));
    const list = needle
        ? used.filter((c) => c.title.toLowerCase().includes(needle) || c.messages.some((m) => String(m.content || '').toLowerCase().includes(needle)))
        : used;

    const remove = async (c) => {
        const ok = await confirmDialog({ title: 'Delete chat', message: `Delete “${c.title}”? This cannot be undone.` });
        if (ok) a.removeChat(c.id);
    };

    return (
        <Sheet open={open} onClose={onClose} title="Recent chats">
            <div className="sb-field" style={{ marginTop: 0 }}>
                <label htmlFor="sb-chat-search">Search chats</label>
                <input id="sb-chat-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" />
            </div>
            <div className="sb-cd sb-list">
                {list.length === 0 && <div className="sb-empty">{needle ? `No chats match “${q.trim()}”.` : 'No conversations yet.'}</div>}
                {list.map((c) => (
                    <div key={c.id}>
                        <div className="sb-lr">
                            {renaming === c.id ? (
                                <input className="t" defaultValue={c.title} aria-label="Chat name" maxLength={60} autoFocus
                                    style={{ height: 40, border: '1px solid var(--line)', borderRadius: 10, padding: '0 12px', fontSize: 16 }}
                                    onBlur={(e) => { a.renameChat(c.id, e.target.value); setRenaming(null); }}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') e.currentTarget.blur();
                                        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRenaming(null); }
                                    }} />
                            ) : (
                                <button type="button" className="t" style={{ textAlign: 'left' }} aria-current={c.id === a.activeId ? 'true' : undefined}
                                    onClick={() => { a.pickChat(c.id); onClose(); }}>
                                    <b>{c.title}</b>
                                    <small>{c.pinned ? 'Pinned · ' : ''}{when(c.at)}</small>
                                </button>
                            )}
                            <Button variant="ghost" size="sm" iconOnly aria-expanded={more === c.id}
                                onClick={() => setMore((m) => (m === c.id ? null : c.id))} aria-label={`More for ${c.title}`}><IconMore /></Button>
                        </div>
                        {more === c.id && (
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '0 14px 12px' }}>
                                <Button size="sm" onClick={() => { setRenaming(c.id); setMore(null); }}>Rename</Button>
                                <Button size="sm" onClick={() => { a.togglePin(c.id); setMore(null); }}>{c.pinned ? 'Unpin' : 'Pin'}</Button>
                                <Button size="sm" onClick={() => { a.shareChat(c); setMore(null); }}>Share</Button>
                                <Button size="sm" variant="danger" onClick={() => { setMore(null); remove(c); }}>Delete</Button>
                            </div>
                        )}
                    </div>
                ))}
            </div>
            <p className="sb-acnote">Chats are saved in this browser, for you and this company only.</p>
        </Sheet>
    );
}
