import React from 'react';

/* The mockup's own icon set, as components. Decorative by default
   (aria-hidden): the control that holds an icon carries the label. */

const S = { stroke: 'currentColor', fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round' };
const svg = (size, vb, children) => (
    <svg width={size} height={size} viewBox={vb} aria-hidden="true" focusable="false">{children}</svg>
);

export const IconChat = ({ size = 18 }) => svg(size, '0 0 18 18',
    <path d="M3 4.5A2.5 2.5 0 0 1 5.5 2h7A2.5 2.5 0 0 1 15 4.5v5a2.5 2.5 0 0 1-2.5 2.5H7l-4 3.5v-11z" {...S} strokeWidth="1.6" />);
export const IconMoney = ({ size = 18 }) => svg(size, '0 0 18 18',
    <path d="M5 3h9M5 7h9M8.5 3c4.5 0 4.5 7 0 7H6l6.5 6" {...S} strokeWidth="1.6" />);
export const IconClients = ({ size = 18 }) => svg(size, '0 0 18 18', <>
    <circle cx="9" cy="6" r="3" {...S} strokeWidth="1.6" />
    <path d="M3 16c.8-3.2 3.2-5 6-5s5.2 1.8 6 5" {...S} strokeWidth="1.6" />
</>);
export const IconWork = ({ size = 18 }) => svg(size, '0 0 18 18', <>
    <rect x="2.5" y="2.5" width="13" height="13" rx="3.5" {...S} strokeWidth="1.6" />
    <path d="M6 9.2l2.2 2.2L12.5 7" {...S} strokeWidth="1.6" />
</>);
export const IconTeam = ({ size = 18 }) => svg(size, '0 0 18 18', <>
    <circle cx="6.5" cy="6" r="2.6" {...S} strokeWidth="1.6" />
    <circle cx="13" cy="7" r="2.1" {...S} strokeWidth="1.6" />
    <path d="M1.8 15.5c.6-2.6 2.5-4 4.7-4s4.1 1.4 4.7 4M11.5 12.2c2.4-.6 4.2.5 4.8 3" {...S} strokeWidth="1.6" />
</>);
export const IconSettings = ({ size = 18 }) => svg(size, '0 0 18 18', <>
    <circle cx="9" cy="9" r="2.5" {...S} strokeWidth="1.6" />
    <path d="M9 1.8v2M9 14.2v2M1.8 9h2M14.2 9h2M3.9 3.9l1.4 1.4M12.7 12.7l1.4 1.4M3.9 14.1l1.4-1.4M12.7 5.3l1.4-1.4" {...S} strokeWidth="1.6" />
</>);
const PHONE = 'M4 2h3l1.5 4-2 1.2a9 9 0 0 0 4.3 4.3l1.2-2 4 1.5v3a2 2 0 0 1-2 2A14 14 0 0 1 2 4a2 2 0 0 1 2-2z';
export const IconCall = ({ size = 15, outline = false }) => svg(size, '0 0 18 18',
    outline ? <path d={PHONE} {...S} strokeWidth="1.5" /> : <path d={PHONE} fill="currentColor" />);
export const IconHangUp = ({ size = 20 }) => svg(size, '0 0 18 18',
    <path d={PHONE} fill="currentColor" transform="rotate(135 9 9)" />);
export const IconFile = ({ size = 14 }) => svg(size, '0 0 16 16',
    <path d="M3.5 1.5h6l3 3v10h-9z" {...S} strokeWidth="1.5" />);
export const IconDoc = ({ size = 15 }) => svg(size, '0 0 16 16', <>
    <path d="M4 1.8h5.5L12.5 5v9.2H4z" {...S} strokeWidth="1.5" />
    <path d="M6.3 8.5h4M6.3 11h4" {...S} strokeWidth="1.5" />
</>);
export const IconIn = ({ size = 15 }) => svg(size, '0 0 16 16',
    <path d="M11 5L5 11M5 6v5h5" {...S} strokeWidth="1.7" />);
export const IconOut = ({ size = 15 }) => svg(size, '0 0 16 16',
    <path d="M5 11l6-6M6 5h5v5" {...S} strokeWidth="1.7" />);
export const IconMail = ({ size = 14 }) => svg(size, '0 0 16 16', <>
    <rect x="1.5" y="3" width="13" height="10" rx="2" {...S} strokeWidth="1.5" />
    <path d="M2 4l6 5 6-5" {...S} strokeWidth="1.5" />
</>);
export const IconTask = ({ size = 14 }) => svg(size, '0 0 16 16', <>
    <rect x="2" y="2" width="12" height="12" rx="3" {...S} strokeWidth="1.5" />
    <path d="M5 8.2l2 2L11 6" {...S} strokeWidth="1.5" />
</>);
export const IconClock = ({ size = 15 }) => svg(size, '0 0 16 16', <>
    <circle cx="8" cy="8" r="6" {...S} strokeWidth="1.5" />
    <path d="M8 5v3.2l2 1.4" {...S} strokeWidth="1.5" />
</>);
export const IconPlus = ({ size = 13 }) => svg(size, '0 0 14 14',
    <path d="M7 2v10M2 7h10" {...S} strokeWidth="1.8" />);
export const IconClose = ({ size = 14 }) => svg(size, '0 0 14 14',
    <path d="M3 3l8 8M11 3l-8 8" {...S} strokeWidth="1.6" />);
export const IconChevronDown = ({ size = 14 }) => svg(size, '0 0 14 14',
    <path d="M4 5.5l3 3 3-3" {...S} strokeWidth="1.6" />);
export const IconChevronRight = ({ size = 14 }) => svg(size, '0 0 14 14',
    <path d="M5 3l4 4-4 4" {...S} strokeWidth="1.6" />);
export const IconChevronLeft = ({ size = 16 }) => svg(size, '0 0 16 16',
    <path d="M10 3L5 8l5 5" {...S} strokeWidth="1.8" />);
export const IconPrev = ({ size = 18 }) => svg(size, '0 0 18 18', <path d="M11 4L6 9l5 5" {...S} strokeWidth="1.8" />);
export const IconNext = ({ size = 18 }) => svg(size, '0 0 18 18', <path d="M7 4l5 5-5 5" {...S} strokeWidth="1.8" />);
export const IconAttach = ({ size = 18 }) => svg(size, '0 0 18 18',
    <path d="M11.5 5.5L6.4 10.6a1.6 1.6 0 0 0 2.3 2.3l5.4-5.4a3.2 3.2 0 0 0-4.5-4.5L4.1 8.5a4.8 4.8 0 0 0 6.8 6.8l3.6-3.6" {...S} strokeWidth="1.5" />);
export const IconSend = ({ size = 16 }) => svg(size, '0 0 16 16',
    <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" {...S} strokeWidth="1.8" />);
export const IconCheck = ({ size = 16 }) => svg(size, '0 0 16 16', <path d="M3 8.5l3.2 3L13 4.5" {...S} strokeWidth="2" />);
export const IconCheckCircle = ({ size = 16 }) => svg(size, '0 0 16 16', <>
    <circle cx="8" cy="8" r="7" fill="currentColor" />
    <path d="M5 8.2l2 2L11 6" stroke="#fff" strokeWidth="1.6" fill="none" />
</>);
export const IconMic = ({ size = 20 }) => svg(size, '0 0 20 20', <>
    <rect x="7" y="2.5" width="6" height="10" rx="3" {...S} strokeWidth="1.6" />
    <path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v3" {...S} strokeWidth="1.6" />
</>);
export const IconSpeaker = ({ size = 20 }) => svg(size, '0 0 20 20', <>
    <path d="M3 7.5h3l4.5-3.5v12L6 12.5H3z" {...S} strokeWidth="1.6" />
    <path d="M13.5 7.5a3.5 3.5 0 0 1 0 5M15.5 5a7 7 0 0 1 0 10" {...S} strokeWidth="1.6" />
</>);
export const IconCaptions = ({ size = 20 }) => svg(size, '0 0 20 20', <>
    <rect x="2.5" y="4" width="15" height="12" rx="2.5" {...S} strokeWidth="1.6" />
    <path d="M5.5 9h3.5M11 9h3.5M5.5 12h6" {...S} strokeWidth="1.6" />
</>);
export const IconLock = ({ size = 14 }) => svg(size, '0 0 16 16', <>
    <rect x="3" y="7" width="10" height="7" rx="2" {...S} strokeWidth="1.4" />
    <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" {...S} strokeWidth="1.4" />
</>);
export const IconBolt = ({ size = 14 }) => svg(size, '0 0 14 14', <path d="M8 1L2 8h4l-1 5 6-7H7z" fill="currentColor" />);
export const IconBank = ({ size = 16 }) => svg(size, '0 0 20 20',
    <path d="M2 8l8-5 8 5M4 8v7M8 8v7M12 8v7M16 8v7M2 17h16" {...S} strokeWidth="1.8" />);
export const IconInvoice = ({ size = 16 }) => svg(size, '0 0 20 20', <>
    <path d="M5 2h7l4 4v12H5z" {...S} strokeWidth="1.8" />
    <path d="M8 10h5M8 14h5" {...S} strokeWidth="1.8" />
</>);
export const IconUndo = ({ size = 14 }) => svg(size, '0 0 16 16', <path d="M5 4L2 7l3 3M2.5 7H10a4 4 0 0 1 0 8H7" {...S} strokeWidth="1.6" />);
export const IconAlert = ({ size = 14 }) => svg(size, '0 0 16 16', <>
    <path d="M8 1.8l6.5 11.4H1.5z" {...S} strokeWidth="1.5" />
    <path d="M8 6.2v3.3M8 11.6v.1" {...S} strokeWidth="1.7" />
</>);
export const IconExternal = ({ size = 12 }) => svg(size, '0 0 14 14', <path d="M8 2h4v4M12 2L6.5 7.5M10 8.5V12H2V4h3.5" {...S} strokeWidth="1.5" />);
export const IconRefresh = ({ size = 14 }) => svg(size, '0 0 16 16', <path d="M13.5 7.5A5.5 5.5 0 1 1 11.8 3.5M13.5 2v3.5H10" {...S} strokeWidth="1.6" />);
export const IconSearch = ({ size = 15 }) => svg(size, '0 0 16 16', <><circle cx="7" cy="7" r="4.8" {...S} strokeWidth="1.6" /><path d="M10.5 10.5L14 14" {...S} strokeWidth="1.6" /></>);
export const IconMore = ({ size = 16 }) => svg(size, '0 0 16 16', <><circle cx="3.5" cy="8" r="1.3" fill="currentColor" /><circle cx="8" cy="8" r="1.3" fill="currentColor" /><circle cx="12.5" cy="8" r="1.3" fill="currentColor" /></>);
export const IconTrash = ({ size = 14 }) => svg(size, '0 0 16 16', <path d="M2.5 4.5h11M6 4.5V2.8h4v1.7M4 4.5l.7 9h6.6l.7-9" {...S} strokeWidth="1.5" />);
export const IconDownload = ({ size = 14 }) => svg(size, '0 0 16 16', <path d="M8 2v8M4.5 6.8L8 10.3l3.5-3.5M2.5 13.5h11" {...S} strokeWidth="1.6" />);
export const IconLink = ({ size = 14 }) => svg(size, '0 0 16 16', <path d="M6.8 9.2a3 3 0 0 0 4.2 0l2.2-2.2a3 3 0 0 0-4.2-4.2l-.9.9M9.2 6.8a3 3 0 0 0-4.2 0L2.8 9a3 3 0 0 0 4.2 4.2l.9-.9" {...S} strokeWidth="1.5" />);
export const IconHome = ({ size = 18 }) => svg(size, '0 0 18 18', <>
    <path d="M2.8 8L9 2.8 15.2 8v6.2a1.3 1.3 0 0 1-1.3 1.3H4.1a1.3 1.3 0 0 1-1.3-1.3z" {...S} strokeWidth="1.6" />
    <path d="M7 15.5v-4.2h4v4.2" {...S} strokeWidth="1.6" />
</>);
export const IconBusiness = ({ size = 18 }) => svg(size, '0 0 18 18', <>
    <rect x="2" y="5.2" width="14" height="10.3" rx="2.4" {...S} strokeWidth="1.6" />
    <path d="M6.5 5.2V4a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 11.5 4v1.2M2 9.5h14" {...S} strokeWidth="1.6" />
</>);
export const IconSparkle = ({ size = 14 }) => svg(size, '0 0 16 16',
    <path d="M8 1.5l1.5 4.2L13.8 7.3 9.5 8.8 8 13l-1.5-4.2L2.2 7.3l4.3-1.6z" fill="currentColor" />);
