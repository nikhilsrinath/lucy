import React, { Suspense, lazy, useLayoutEffect, useRef, useState } from 'react';
import { toInvoiceForm } from './invoiceForm';

/* The real invoice, drawn inside a chat card.

   InvoicePreview renders at true A4 pixel width (the PDF capture depends on
   it), so it is scaled down to the card here rather than restyled: what the
   card shows is the component the invoice screen and the PDF use, fed the
   figures the database will store. Loaded on demand — most chats never open
   one. */

const InvoicePreview = lazy(() => import('../InvoicePreview'));

const SHEET_W = 794; // A4 at 96 dpi

export default function DocPaper({ doc }) {
    const box = useRef(null);
    const sheet = useRef(null);
    const [scale, setScale] = useState(0.5);
    const [height, setHeight] = useState(560);

    useLayoutEffect(() => {
        const el = box.current;
        if (!el) return undefined;
        const fit = () => {
            const s = Math.min(1, (el.clientWidth || SHEET_W) / SHEET_W);
            setScale(s);
            setHeight(Math.ceil((sheet.current?.scrollHeight || 1123) * s));
        };
        fit();
        const ro = new ResizeObserver(fit);
        ro.observe(el);
        if (sheet.current) ro.observe(sheet.current);
        return () => ro.disconnect();
    }, []);

    const props = toInvoiceForm(doc);
    return (
        <div ref={box} className="cp-paper" style={{ height }} aria-label={`Preview of ${doc.title} ${doc.number}`}>
            <div ref={sheet} className="cp-paper-sheet" style={{ width: SHEET_W, transform: `scale(${scale})` }}>
                <Suspense fallback={<div className="cp-paper-loading">Loading the invoice…</div>}>
                    <InvoicePreview {...props} />
                </Suspense>
            </div>
        </div>
    );
}
