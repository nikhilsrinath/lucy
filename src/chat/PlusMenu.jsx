import React, { useState, useEffect, useRef } from 'react';
import {
    IconAttach, IconDoc, IconTask, IconIn, IconOut, IconCall,
    IconChevronRight, IconCheck, IconBolt
} from '../design/icons';

// High-fidelity custom SVG icons for the plus menu matching screenshot
const IconCamera = () => (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14.5 12.5a1.5 1.5 0 0 1-1.5 1.5H3a1.5 1.5 0 0 1-1.5-1.5V5.5A1.5 1.5 0 0 1 3 4h2l1.5-2h3l1.5 2h2a1.5 1.5 0 0 1 1.5 1.5v7z" />
        <circle cx="8" cy="8.5" r="2.5" />
    </svg>
);

const IconFolder = () => (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M1.5 3.5a1 1 0 0 1 1-1h3.5l1.5 2h6.5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-12a1 1 0 0 1-1-1v-9z" />
    </svg>
);

const IconSpark = () => (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 1v3M8 12v3M1 8h3M12 8h3M3 3l2.2 2.2M10.8 10.8l2.2 2.2M3 13l2.2-2.2M10.8 5.2l2.2-2.2" />
    </svg>
);

const IconGrid = () => (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="2" width="4.5" height="4.5" rx="1" />
        <rect x="9.5" y="2" width="4.5" height="4.5" rx="1" />
        <rect x="2" y="9.5" width="4.5" height="4.5" rx="1" />
        <rect x="9.5" y="9.5" width="4.5" height="4.5" rx="1" />
    </svg>
);

const IconGlobe = () => (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="8" cy="8" r="6.5" />
        <path d="M1.5 8h13M8 1.5a10 10 0 0 1 0 13 10 10 0 0 1 0-13z" />
    </svg>
);

const IconLegal = () => (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2.5 13.5h11M8 2.5v11M4 4.5l8 2M4 8.5l-2-4h4l-2 4zM12 10.5l-2-4h4l-2 4z" />
    </svg>
);

export default function PlusMenu({
    isOpen,
    onClose,
    onUpload,
    onCapture,
    onRunInstant,
    onNavigate,
    onStartCall,
    webSearchEnabled = true,
    onToggleWebSearch,
}) {
    const menuRef = useRef(null);
    const [activeSubmenu, setActiveSubmenu] = useState(null); // 'actions' | 'metrics' | 'team' | 'connectors'

    useEffect(() => {
        if (!isOpen) {
            setActiveSubmenu(null);
            return;
        }

        const handleDown = (e) => {
            if (menuRef.current && !menuRef.current.contains(e.target)) {
                onClose();
            }
        };

        const handleKey = (e) => {
            if (e.key === 'Escape') onClose();
        };

        document.addEventListener('mousedown', handleDown);
        document.addEventListener('keydown', handleKey);
        return () => {
            document.removeEventListener('mousedown', handleDown);
            document.removeEventListener('keydown', handleKey);
        };
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    const submenus = {
        actions: {
            title: 'Quick Actions',
            items: [
                { label: 'Create Tax Invoice', icon: <IconDoc size={14} />, to: '/money/invoices/new' },
                { label: 'Create Quotation', icon: <IconDoc size={14} />, to: '/money/quotations/new' },
                { label: 'Log Cash Out (Expense)', icon: <IconOut size={14} />, prompt: 'Log an expense' },
                { label: 'Log Cash In (Income)', icon: <IconIn size={14} />, prompt: 'Record money received' },
                { label: 'Add New Task', icon: <IconTask size={14} />, prompt: 'Add a new task' },
                { label: 'Add Client / Lead', icon: <IconFolder />, prompt: 'Add a new client' },
            ],
        },
        metrics: {
            title: 'Financial Intelligence',
            items: [
                { label: 'Net Cash Position', icon: <IconBolt size={14} />, instant: 'netcash', badge: '0ms' },
                { label: 'Monthly Revenue & P&L', icon: <IconBolt size={14} />, instant: 'revenue', badge: '0ms' },
                { label: 'Overdue Invoices', icon: <IconBolt size={14} />, instant: 'overdue', badge: '0ms' },
                { label: 'Tax & GST Summary', icon: <IconBolt size={14} />, instant: 'tax', badge: '0ms' },
            ],
        },
        team: {
            title: 'Team & Legal',
            items: [
                { label: 'New Offer Letter', icon: <IconLegal />, to: '/team/letters/offer/new' },
                { label: 'New NDA Agreement', icon: <IconLegal />, to: '/team/letters/nda/new' },
                { label: 'Add Team Member', icon: <IconFolder />, to: '/employees/new' },
            ],
        },
        connectors: {
            title: 'Connectors & Integrations',
            items: [
                { label: 'Gmail Integration', icon: <IconGrid />, to: '/settings' },
                { label: 'WhatsApp Alerts', icon: <IconGrid />, prompt: 'Setup WhatsApp notifications' },
                { label: 'Bank & Razorpay Sync', icon: <IconGrid />, to: '/settings' },
            ],
        },
    };

    const handleItemClick = (item) => {
        onClose();
        if (item.to) {
            onNavigate(item.to);
        } else if (item.instant) {
            onRunInstant(item.instant);
        } else if (item.prompt) {
            onRunInstant('prompt', item.prompt);
        }
    };

    return (
        <div className="sb-plus-popover" ref={menuRef} role="menu" aria-label="Action and folder options">
            {/* Main Menu Panel */}
            <div className="sb-plus-menu">
                {/* 1. Files / Media Upload */}
                <button
                    type="button"
                    className="sb-pitem"
                    onClick={() => { onClose(); onUpload(); }}
                >
                    <span className="sb-picon"><IconAttach size={15} /></span>
                    <span className="sb-plabel">Add files or photos</span>
                    <span className="sb-pbadge">Ctrl+U</span>
                </button>

                <button
                    type="button"
                    className="sb-pitem"
                    onClick={() => { onClose(); onCapture?.(); }}
                >
                    <span className="sb-picon"><IconCamera /></span>
                    <span className="sb-plabel">Take a screenshot</span>
                </button>

                <div className="sb-pdivider" />

                {/* 2. Folders with Submenus */}
                <button
                    type="button"
                    className={`sb-pitem sb-has-sub ${activeSubmenu === 'actions' ? 'active' : ''}`}
                    onClick={() => setActiveSubmenu(activeSubmenu === 'actions' ? null : 'actions')}
                    onMouseEnter={() => setActiveSubmenu('actions')}
                >
                    <span className="sb-picon"><IconFolder /></span>
                    <span className="sb-plabel">Add to project</span>
                    <span className="sb-pchev"><IconChevronRight size={12} /></span>
                </button>

                <button
                    type="button"
                    className={`sb-pitem sb-has-sub ${activeSubmenu === 'metrics' ? 'active' : ''}`}
                    onClick={() => setActiveSubmenu(activeSubmenu === 'metrics' ? null : 'metrics')}
                    onMouseEnter={() => setActiveSubmenu('metrics')}
                >
                    <span className="sb-picon"><IconSpark /></span>
                    <span className="sb-plabel">Skills & Metrics</span>
                    <span className="sb-pchev"><IconChevronRight size={12} /></span>
                </button>

                <button
                    type="button"
                    className={`sb-pitem sb-has-sub ${activeSubmenu === 'connectors' ? 'active' : ''}`}
                    onClick={() => setActiveSubmenu(activeSubmenu === 'connectors' ? null : 'connectors')}
                    onMouseEnter={() => setActiveSubmenu('connectors')}
                >
                    <span className="sb-picon"><IconGrid /></span>
                    <span className="sb-plabel">Connectors</span>
                    <span className="sb-pwarn">⚠ 1</span>
                    <span className="sb-pchev"><IconChevronRight size={12} /></span>
                </button>

                <button
                    type="button"
                    className={`sb-pitem sb-has-sub ${activeSubmenu === 'team' ? 'active' : ''}`}
                    onClick={() => setActiveSubmenu(activeSubmenu === 'team' ? null : 'team')}
                    onMouseEnter={() => setActiveSubmenu('team')}
                >
                    <span className="sb-picon"><IconLegal /></span>
                    <span className="sb-plabel">Team & Legal</span>
                    <span className="sb-pchev"><IconChevronRight size={12} /></span>
                </button>

                <div className="sb-pdivider" />

                {/* 3. Utility Toggles */}
                <button
                    type="button"
                    className="sb-pitem"
                    onClick={() => { onClose(); onStartCall?.(); }}
                >
                    <span className="sb-picon"><IconCall size={14} outline /></span>
                    <span className="sb-plabel">Voice Call Co-founder</span>
                </button>

                <button
                    type="button"
                    className="sb-pitem"
                    onClick={() => onToggleWebSearch?.()}
                >
                    <span className="sb-picon"><IconGlobe /></span>
                    <span className="sb-plabel">Web search</span>
                    {webSearchEnabled && <span className="sb-pcheck"><IconCheck size={14} /></span>}
                </button>
            </div>

            {/* Flyout Submenu Panel */}
            {activeSubmenu && submenus[activeSubmenu] && (
                <div
                    className="sb-plus-subpanel"
                    onMouseEnter={() => {}}
                    onMouseLeave={() => {}}
                >
                    <div className="sb-sub-header">
                        <span>{submenus[activeSubmenu].title}</span>
                    </div>
                    <div className="sb-sub-list">
                        {submenus[activeSubmenu].items.map((it, idx) => (
                            <button
                                key={idx}
                                type="button"
                                className="sb-sub-item"
                                onClick={() => handleItemClick(it)}
                            >
                                <span className="sb-sub-icon">{it.icon}</span>
                                <span className="sb-sub-label">{it.label}</span>
                                {it.badge && <span className="sb-sub-badge">{it.badge}</span>}
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
