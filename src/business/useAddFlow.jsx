import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { orgStore } from '../services/orgStore';
import { Card, ListRow, Sheet, IconTile } from '../design/ui';
import { IconDoc, IconIn, IconOut, IconInvoice, IconClients, IconPlus } from '../design/icons';
import EntrySheet from '../money/EntrySheet';
import BillSheet from '../money/BillSheet';
import ItemSheet from '../money/ItemSheet';
import { blankEntry, blankBill, blankItem } from '../money/blanks';

/* ══════════════════════════════════════════════════════════════════════════
   "Add to Business": every record the hub can start, in one list — the
   documents open their editors, money and bills open their sheets, a lead
   opens the Clients form. Used by the overview's quick actions and by the
   New button on every Business screen, so both offer exactly the same.
   Each entry is shown only to a role that may create it.
   ══════════════════════════════════════════════════════════════════════════ */

export function useAddFlow({ data, notify }) {
    const navigate = useNavigate();
    const [chooser, setChooser] = useState(false);
    const [sheet, setSheet] = useState(null);   // { kind, value }

    const ACTIONS = [
        { id: 'invoice', title: 'Invoice', short: 'Invoice', sub: 'A tax invoice to bill a client', tone: 'n', icon: IconDoc, resource: 'financial_documents', run: () => navigate('/money/invoices/new?type=invoice') },
        { id: 'quote', title: 'Quote', short: 'Quote', sub: 'A quotation the client can accept online', tone: 'n', icon: IconDoc, resource: 'financial_documents', run: () => navigate('/money/invoices/new?type=quotation') },
        { id: 'proforma', title: 'Proforma', short: 'Proforma', sub: 'Ask for an advance before the tax invoice', tone: 'n', icon: IconDoc, resource: 'financial_documents', run: () => navigate('/money/invoices/new?type=proforma') },
        { id: 'in', title: 'Money in', short: 'Money in', sub: 'Anything received without an invoice', tone: 'g', icon: IconIn, resource: 'income_entries', run: () => setSheet({ kind: 'entry', value: blankEntry('in') }) },
        { id: 'expense', title: 'Expense', short: 'Expense', sub: 'Anything paid without a vendor bill', tone: 'n', icon: IconOut, resource: 'expenses', run: () => setSheet({ kind: 'entry', value: blankEntry('out') }) },
        { id: 'bill', title: 'Bill', short: 'Vendor bill', sub: 'A bill from a vendor, to pay later', tone: 'a', icon: IconInvoice, resource: 'purchase_invoices', run: () => setSheet({ kind: 'bill', value: blankBill() }) },
        { id: 'lead', title: 'Client lead', short: 'Lead', sub: 'Someone who might buy, onto the pipeline', tone: 'b', icon: IconClients, resource: 'clients', run: () => navigate('/clients?addLead=1') },
        { id: 'item', title: 'Item', short: 'Item', sub: 'Something you sell, with its price and GST', tone: 'n', icon: IconPlus, resource: 'catalog_items', run: () => setSheet({ kind: 'item', value: blankItem() }) },
    ];
    const actions = ACTIONS.filter((x) => orgStore.can(x.resource, 'create'));
    const start = (id) => actions.find((x) => x.id === id)?.run();

    const element = (
        <>
            <Sheet open={chooser} onClose={() => setChooser(false)} title="Add to Business">
                <Card list>
                    {actions.map((x) => {
                        const Icon = x.icon;
                        return <ListRow key={x.id} lead={<IconTile tone={x.tone}><Icon /></IconTile>} title={x.title} sub={x.sub} onClick={() => { setChooser(false); x.run(); }} />;
                    })}
                    {!actions.length && <div className="sb-empty">Your role can't add records here.</div>}
                </Card>
                <p className="sb-acnote">Or tell your cofounder in Buddy, for example “spent 4,500 on chairs yesterday”.</p>
            </Sheet>
            {sheet?.kind === 'entry' && <EntrySheet entry={sheet.value} data={data} onClose={() => setSheet(null)} onSaved={notify} />}
            {sheet?.kind === 'bill' && <BillSheet bill={sheet.value} vendors={data.vendors} onClose={() => setSheet(null)} notify={notify} />}
            {sheet?.kind === 'item' && <ItemSheet item={sheet.value} onClose={() => setSheet(null)} notify={notify} />}
        </>
    );

    return { open: () => setChooser(true), start, actions, element };
}
