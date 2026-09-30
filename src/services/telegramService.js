import { supabase } from '../lib/supabase';

/**
 * /api/telegram's app side (api/_lib/telegram/manage.js), with the signed-in
 * user's token. The bot token never reaches the browser — only the bot's
 * public username and one-time t.me links, each shown once.
 */
export async function telegramApi(body) {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Your session has expired. Sign in again.');
    const res = await fetch('/api/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify(body),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || out.success === false) throw new Error(out.error || `Request failed (${res.status})`);
    return out;
}

export const tgName = (t) => (t?.telegram_username ? `@${t.telegram_username}` : t?.telegram_name || 'Telegram');
export const tgWhen = (iso) => new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
