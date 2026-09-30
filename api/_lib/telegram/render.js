import { esc, mdToHtml } from './bot.js';

/**
 * Buddy's events and cards, as Telegram messages. Display only: every button
 * here is a request the webhook re-checks from scratch (callbacks in
 * handler.js); nothing a message says is taken as fact on the way back.
 *
 * Callback data (≤ 64 bytes):
 *   a:c:<action id>  confirm      a:x:<id> cancel     a:u:<id> undo
 *   a:r:<id>         retry        k:<nonce>:<i>       pick option i of the
 *                                                     conversation's offers
 *   s:<org id>       switch company (DM)
 *
 * Risk decides the buttons. A low-risk card or a plan (plans hold only
 * low-risk steps) gets Confirm/Approve. A high-risk card — money, anything
 * leaving the company, deletes — never gets one: it gets "Review in
 * StartupBuddy", and the confirm callback refuses high risk anyway.
 */

/** The app's public URL, for "View in StartupBuddy" buttons; null if unknown or not https. */
export function appUrl() {
  const raw = process.env.APP_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '');
  const url = String(raw).trim().replace(/\/+$/, '');
  return /^https:\/\/[^\s/]+/.test(url) ? url : null;
}

const link = (path) => { const base = appUrl(); return base ? `${base}${path.startsWith('/') ? path : `/${path}`}` : null; };
export const reviewUrl = (actionId) => link(`/chat?action=${encodeURIComponent(actionId)}`);
const urlButton = (text, url) => (url ? { text, url } : null);
const rows = (...list) => list.map((r) => r.filter(Boolean)).filter((r) => r.length);

/* ── cards ────────────────────────────────────────────────────────────────── */

function diffLines(diff = []) {
  return diff.slice(0, 8).map((d) => (d.from && d.from !== '—'
    ? `• ${esc(d.label)}: ${esc(d.from)} → <b>${esc(d.to)}</b>`
    : `• ${esc(d.label)}: <b>${esc(d.to)}</b>`));
}

function planLines(card) {
  const results = new Map((card.step_results || []).map((r) => [r.n, r]));
  return (card.steps || []).slice(0, 12).map((s) => {
    const r = results.get(s.n);
    const mark = !r ? `${s.n}.` : r.skipped ? '–' : r.ok === false ? '✗' : '✓';
    const what = s.diff?.length === 1 && s.title ? `${s.title} — ${s.diff[0].to}` : s.title || s.tool;
    return `${mark} ${esc(what)}${s.why ? ` <i>(${esc(s.why)})</i>` : ''}${r?.error ? `\n   ⚠️ ${esc(r.error)}` : ''}`;
  });
}

function body(card) {
  const lines = [];
  if (card.kind === 'plan') {
    lines.push(`🗂 <b>Plan: ${esc(card.goal || card.title)}</b>`);
    if (card.approach) lines.push(esc(card.approach));
    lines.push('', ...planLines(card));
    return lines;
  }
  lines.push(`${card.risk === 'high' ? '🔒' : '📝'} <b>${esc(card.title)}</b>${card.target?.label ? ` — ${esc(card.target.label)}` : ''}`);
  lines.push(...diffLines(card.diff));
  if (card.items?.length) {
    lines.push(...card.items.slice(0, 8).map((it) => `• ${esc(it.label)}${it.sub ? ` <i>(${esc(it.sub)})</i>` : ''}`));
    if (card.items.length > 8) lines.push(`…and ${card.items.length - 8} more`);
  }
  if (card.preview?.rows?.length && !card.diff?.length) {
    lines.push(...card.preview.rows.slice(0, 6).map((r) => `• ${r.map(esc).join(' — ')}`));
  }
  if (card.reason) lines.push(`<i>Why: ${esc(card.reason)}</i>`);
  for (const n of (card.notes || []).slice(0, 2)) lines.push(`<i>${esc(n)}</i>`);
  if (card.irreversible) lines.push(`⚠️ ${esc(card.irreversible)}`);
  return lines;
}

/**
 * A card in its current state: { html, buttons }. `now` for the undo window.
 */
export function renderCard(card, now = Date.now()) {
  const lines = body(card);
  const id = card.action_id;
  const review = reviewUrl(id);
  let buttons = [];

  switch (card.status) {
    case 'proposed': {
      if (card.expires_at && Date.parse(card.expires_at) < now) {
        lines.push('', '⌛ <i>Expired — nothing was changed. Ask again and I\'ll prepare it fresh.</i>');
        break;
      }
      if (card.risk === 'high') {
        lines.push('', review
          ? '🔒 <b>Needs your approval in StartupBuddy.</b> This kind of change is never confirmed from Telegram.'
          : '🔒 <b>Needs your approval in StartupBuddy</b> (open Buddy in the app). This kind of change is never confirmed from Telegram.');
        buttons = rows([urlButton('Review in StartupBuddy', review)], [{ text: 'Cancel', callback_data: `a:x:${id}` }]);
      } else if (card.kind === 'plan') {
        lines.push('', '<i>Nothing happens until you approve. To untick or edit steps, review it in StartupBuddy.</i>');
        buttons = rows(
          [{ text: `✅ ${card.confirmLabel || 'Approve plan'}`, callback_data: `a:c:${id}` }, { text: 'Cancel', callback_data: `a:x:${id}` }],
          [urlButton('Review in StartupBuddy', review)],
        );
      } else {
        lines.push('', '<i>Not done yet — confirm to apply.</i>');
        buttons = rows(
          [{ text: `✅ ${card.confirmLabel || 'Confirm'}`, callback_data: `a:c:${id}` }, { text: 'Cancel', callback_data: `a:x:${id}` }],
          [urlButton('Edit in StartupBuddy', card.fields?.length ? review : null)],
        );
      }
      break;
    }
    case 'confirmed':
      lines.push('', '⏳ <i>Working on it…</i>');
      break;
    case 'executed': {
      lines.push('', `✅ ${mdToHtml(card.summary || 'Done.')}`);
      if (card.partial) lines.push('<i>Some steps did not go through — see above.</i>');
      if (card.followUp) lines.push(`<i>${esc(card.followUp)}</i>`);
      const canUndo = card.undo_until && Date.parse(card.undo_until) > now;
      buttons = rows(
        [canUndo ? { text: '↩️ Undo (10 min)', callback_data: `a:u:${id}` } : null, card.partial ? { text: 'Retry failed steps', callback_data: `a:r:${id}` } : null],
        [urlButton('View in StartupBuddy', link(card.href || '/chat'))],
      );
      break;
    }
    case 'failed':
      lines.push('', `⚠️ <b>Didn't go through:</b> ${esc(card.error || 'the change could not be saved.')}`, '<i>Nothing was changed.</i>');
      buttons = rows([{ text: 'Try again', callback_data: `a:r:${id}` }]);
      break;
    case 'cancelled':
      lines.push('', '✖️ <i>Cancelled — nothing was changed.</i>');
      break;
    case 'expired':
      lines.push('', '⌛ <i>Expired — nothing was changed.</i>');
      break;
    case 'undone':
      lines.push('', '↩️ <i>Undone.</i>');
      break;
    default:
      break;
  }
  return { html: lines.join('\n'), buttons };
}

/* ── the other events ─────────────────────────────────────────────────────── */

export function renderView(view) {
  if (!view) return null;
  const lines = [`<b>${esc(view.title || 'Details')}</b>`];
  if (view.type === 'metrics') {
    for (const it of view.items || []) lines.push(`• ${esc(it.label)}: <b>${esc(it.value)}</b>${it.sub ? ` <i>(${esc(it.sub)})</i>` : ''}`);
  } else if (view.type === 'timeline') {
    for (const it of view.items || []) lines.push(`• ${esc(it.title)}${it.sub ? ` — ${esc(it.sub)}` : ''}`);
  } else if (view.type === 'insights') {
    for (const it of view.items || []) lines.push(`• <b>${esc(it.title || '')}</b>${it.reason ? `\n  ${esc(it.reason)}` : ''}`);
  } else {
    for (const it of view.items || []) {
      const extra = [it.value, it.badge].filter(Boolean).map(esc).join(' · ');
      lines.push(`• ${esc(it.title)}${it.sub ? ` <i>(${esc(it.sub)})</i>` : ''}${extra ? ` — ${extra}` : ''}`);
    }
  }
  if (view.warning) lines.push(`⚠️ ${esc(view.warning)}`);
  if (view.more) lines.push(`…and ${view.more} more`);
  if (lines.length === 1) lines.push('<i>Nothing to show.</i>');
  return { html: lines.join('\n'), buttons: rows([urlButton('Open in StartupBuddy', view.href ? link(view.href) : null)]) };
}

/** Choice / question chips as buttons, bound to this conversation's offer nonce. */
export function renderOptions(question, options, n, { hint = null } = {}) {
  const lines = [`❓ ${esc(question)}`];
  if (hint) lines.push(`<i>${esc(hint)}</i>`);
  if (!options.length) lines.push('<i>Just reply with the answer.</i>');
  const buttons = options.slice(0, 8).map((o, i) => [{
    text: `${o.label}${o.sub ? ` · ${o.sub}` : ''}`.slice(0, 60),
    callback_data: `k:${n}:${i}`,
  }]);
  return { html: lines.join('\n'), buttons };
}

export function renderNotice(text, offer, n) {
  return {
    html: `ℹ️ ${mdToHtml(text || '')}`,
    buttons: offer ? [[{ text: String(offer.label || 'Do it').slice(0, 60), callback_data: `k:${n}:0` }]] : [],
  };
}

export function renderNavigate(nav) {
  const url = link(nav?.href || '/');
  return url
    ? { html: `🔗 ${esc(nav?.label ? `Open ${nav.label}` : 'Open in StartupBuddy')}`, buttons: [[{ text: 'Open in StartupBuddy', url }]] }
    : null;
}
