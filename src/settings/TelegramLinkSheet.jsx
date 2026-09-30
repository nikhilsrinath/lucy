import React from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Button, Sheet } from '../design/ui';
import { tgWhen } from '../services/telegramService';

/** A one-time t.me link, shown once: open, scan, or copy. */
export default function TelegramLinkSheet({ sheet, onClose }) {
    if (!sheet) return null;
    return (
        <Sheet open onClose={onClose} title={sheet.title}
            footer={<Button variant="primary" block size="lg" as="a" href={sheet.url} target="_blank" rel="noopener noreferrer">Open Telegram</Button>}>
            <p className="sb-acnote">{sheet.note}</p>
            <div style={{ display: 'grid', placeItems: 'center', padding: 12 }}>
                <QRCodeSVG value={sheet.url} size={180} />
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <code style={{ fontSize: 12, wordBreak: 'break-all', flex: 1 }}>{sheet.url}</code>
                <Button size="sm" onClick={() => navigator.clipboard?.writeText(sheet.url)}>Copy</Button>
            </div>
            <p className="sb-acnote">Expires {tgWhen(sheet.expires_at)}.</p>
        </Sheet>
    );
}
