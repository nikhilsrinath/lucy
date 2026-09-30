import { IconDoc, IconOut, IconTask, IconClients, IconMail, IconSparkle, IconSend } from '../design/icons';

/* How each agent tool's card is labelled: the type line in the card's header
   and its icon. Risk is not decided here — it comes on the card itself. */

// tool → [type label, icon, tile tone]. Risk is not here: it comes from the card.
const TOOL = {
    create_task: ['New task', 'task', 'n'], update_task: ['Task change', 'task', 'n'], complete_task: ['Complete task', 'task', 'g'],
    reopen_task: ['Reopen task', 'task', 'n'], delete_task: ['Delete task', 'task', 'r'],
    create_client: ['New client', 'client', 'b'], update_client: ['Client change', 'client', 'b'], move_client_stage: ['Client stage', 'client', 'b'],
    add_client_note: ['Client note', 'client', 'b'], delete_client: ['Delete client', 'client', 'r'],
    create_cash_entry: ['Money entry', 'cash', 'a'], record_payment: ['Payment', 'cash', 'g'], mark_invoice_paid: ['Mark paid', 'cash', 'g'],
    create_invoice_draft: ['Invoice draft', 'doc', 'b'], create_quotation_draft: ['Quote draft', 'doc', 'b'], create_proforma_draft: ['Proforma draft', 'doc', 'b'],
    convert_quotation: ['Quote to invoice', 'doc', 'b'], issue_document: ['Issue document', 'doc', 'a'],
    cancel_financial_document: ['Cancel document', 'doc', 'r'], delete_financial_document: ['Delete document', 'doc', 'r'],
    create_vendor: ['New vendor', 'client', 'n'], create_purchase_bill: ['Vendor bill', 'doc', 'a'],
    create_project: ['New project', 'task', 'b'], send_payment_reminder: ['Payment reminder', 'mail', 'a'],
    send_telegram_message: ['Telegram message', 'send', 'b'],
    plan: ['Plan', 'plan', 'b'],
};
const ICON = { task: IconTask, client: IconClients, cash: IconOut, doc: IconDoc, mail: IconMail, plan: IconSparkle, send: IconSend };

export const cardMeta = (card) => {
    const [label, icon, tone] = TOOL[card.tool] || ['Proposed change', 'doc', 'n'];
    return { label, Icon: ICON[icon], tone };
};

