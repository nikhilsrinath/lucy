import React, { useEffect, useRef } from 'react';
import { IconBolt, IconDoc, IconTask, IconCall, IconIn, IconOut, IconChevronRight } from '../design/icons';

function CommandIcon({ icon }) {
    switch (icon) {
        case 'cash':
        case 'chart':
        case 'tax':
            return <IconBolt size={14} />;
        case 'invoice':
        case 'quote':
        case 'letter':
        case 'shield':
            return <IconDoc size={14} />;
        case 'expense':
            return <IconOut size={14} />;
        case 'income':
            return <IconIn size={14} />;
        case 'task':
            return <IconTask size={14} />;
        case 'call':
            return <IconCall size={14} outline />;
        default:
            return <IconBolt size={14} />;
    }
}

export default function SlashPalette({
    commands,
    selectedIndex,
    onSelect,
    onClose,
}) {
    const listRef = useRef(null);

    useEffect(() => {
        const activeEl = listRef.current?.querySelector('.sel');
        if (activeEl) {
            activeEl.scrollIntoView({ block: 'nearest' });
        }
    }, [selectedIndex]);

    if (!commands || commands.length === 0) return null;

    return (
        <div className="sb-slash-palette" role="listbox" aria-label="Slash commands" ref={listRef}>
            <div className="sb-slash-header">
                <span>Commands</span>
                <kbd>Esc to dismiss</kbd>
            </div>
            <div className="sb-slash-list">
                {commands.map((cmd, idx) => (
                    <button
                        key={cmd.name}
                        type="button"
                        role="option"
                        aria-selected={idx === selectedIndex}
                        className={`sb-slash-item ${idx === selectedIndex ? 'sel' : ''}`}
                        onClick={() => onSelect(cmd)}
                        onMouseEnter={() => {}}
                    >
                        <span className="sb-slash-icon">
                            <CommandIcon icon={cmd.icon} />
                        </span>
                        <div className="sb-slash-info">
                            <div className="sb-slash-name-row">
                                <span className="sb-slash-name">/{cmd.name}</span>
                                {cmd.instant && <span className="sb-slash-badge instant">Instant ⚡</span>}
                                {cmd.category && <span className="sb-slash-cat">{cmd.category}</span>}
                            </div>
                            <span className="sb-slash-desc">{cmd.description}</span>
                        </div>
                        <span className="sb-slash-chev">
                            <IconChevronRight size={12} />
                        </span>
                    </button>
                ))}
            </div>
        </div>
    );
}
