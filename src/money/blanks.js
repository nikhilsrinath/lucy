import { todayIso, isOverdue } from '../services/financeAnalytics';

/* Empty records for the Money sheets, and a document's status as a badge. */

const COMMON = () => ({
    description: '', original_amount: '', currency: 'INR', fx_rate: 1,
    tax_amount: '', tax_rate: 0, date: todayIso(),
    payment_method: 'bank_transfer', reference: '',
    country_code: '', place_of_supply: '', is_inter_state: false,
    quantity: '', unit: '', receipt_path: null, notes: '',
});
export const blankEntry = (direction) => (direction === 'in'
    ? { ...COMMON(), direction: 'in', category: 'product_sales', client_id: '', catalog_item_id: '' }
    : { ...COMMON(), direction: 'out', category: 'other_expense', vendor_id: '', employee_id: '', product_id: '', department_id: '', client_id: '', billable: false, status: 'paid' });


export const blankBill = () => ({
    vendor_id: '', bill_number: '', bill_date: todayIso(), due_date: '', category: 'Operations',
    description: '', subtotal: '', tax_rate: 18, amount_paid: 0, receipt_path: null, notes: '',
});


export const blankItem = () => ({
    name: '', sku: '', description: '', category: '', unit_price: '', unit: 'Nos', hsn_sac: '', tax_rate: 18,
    track_inventory: false, stock_qty: '', low_stock_at: '',
});


const STATUS = {
    draft: ['n', 'Draft'], sent: ['a', 'Sent'], viewed: ['b', 'Viewed'], accepted: ['g', 'Accepted'], declined: ['r', 'Declined'],
    paid: ['g', 'Paid'], partially_paid: ['a', 'Part paid'], overdue: ['r', 'Overdue'], cancelled: ['n', 'Cancelled'],
    expired: ['n', 'Expired'], payment_submitted: ['b', 'Payment claimed'], revision_requested: ['a', 'Changes asked'],
    converted: ['n', 'Converted'], order_confirmed: ['b', 'Order confirmed'], advance_paid: ['g', 'Advance paid'],
};
export function statusOf(d) {
    if (d.type === 'invoice' && isOverdue(d)) return ['r', 'Overdue'];
    return STATUS[d.status] || ['n', String(d.status || '').replace(/_/g, ' ')];
}

