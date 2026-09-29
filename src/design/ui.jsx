import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { pixelRuns } from './personas';
import { IconClose } from './icons';

/* ══════════════════════════════════════════════════════════════════════════
   StartupBuddy primitives. Each mirrors one class family in the mockup, so a
   screen reads like the mockup's markup: <Card>, <ListRow>, <Badge tone="g">.
   ══════════════════════════════════════════════════════════════════════════ */

const cx = (...a) => a.filter(Boolean).join(' ');

/* ── Button ─────────────────────────────────────────────────────────────── */

/** variant: primary | secondary | ghost | danger · size: sm | md | lg */
export const Button = React.forwardRef(function Button(
    { variant = 'secondary', size = 'md', block, iconOnly, className, type = 'button', as: As = 'button', children, ...rest }, ref,
) {
    const cls = cx('sb-btn',
        variant === 'primary' && 'p', variant === 'ghost' && 'ghost', variant === 'danger' && 'danger',
        size === 'sm' && 'sm', size === 'lg' && 'lg', block && 'w', iconOnly && 'icon', className);
    return As === 'button'
        ? <button ref={ref} type={type} className={cls} {...rest}>{children}</button>
        : <As ref={ref} className={cls} {...rest}>{children}</As>;
});

/* ── Badge / Dot ────────────────────────────────────────────────────────── */

/** tone: g (good) · a (attention) · r (risk) · b (info) · n (neutral) */
export function Badge({ tone = 'n', plain, className, children, ...rest }) {
    return <span className={cx('sb-bd', tone, plain && 'plain', className)} {...rest}>{children}</span>;
}
export const Dot = ({ tone = 'n' }) => <i className={`sb-dot ${tone}`} aria-hidden="true" />;

/* ── Card / list ────────────────────────────────────────────────────────── */

export function Card({ as: As = 'div', list, className, children, ...rest }) {
    return <As className={cx('sb-cd', list && 'sb-list', className)} {...rest}>{children}</As>;
}

/**
 * One row of a list. `onClick` or `href` makes it interactive (a real button
 * or link); otherwise it is a plain row. `lead` is the icon/avatar on the left,
 * `trail` anything on the right, `amount` a right-aligned mono figure.
 */
export function ListRow({ lead, title, sub, trail, amount, amountIn, onClick, as, className, children, ...rest }) {
    const As = as || (onClick ? 'button' : 'div');
    const extra = As === 'button' ? { type: 'button' } : {};
    return (
        <As className={cx('sb-lr', className)} onClick={onClick} {...extra} {...rest}>
            {lead}
            {(title || sub) && (
                <span className="t">
                    {title && <b>{title}</b>}
                    {sub && <small>{sub}</small>}
                </span>
            )}
            {children}
            {trail}
            {amount !== undefined && <span className={cx('amt', amountIn && 'in')}>{amount}</span>}
        </As>
    );
}

export const ListHeader = ({ children, count }) => (
    <div className="sb-lh"><span>{children}</span>{count !== undefined && <span>{count}</span>}</div>
);

export const Initials = ({ name = '', className, style }) => {
    const ini = String(name).trim().split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '·';
    return <span className={cx('sb-ini', className)} style={style} aria-hidden="true">{ini}</span>;
};

export const IconTile = ({ tone = 'n', children, className, style }) => (
    <span className={cx('sb-ico', tone, className)} style={style} aria-hidden="true">{children}</span>
);

/* ── Tabs (underline) ───────────────────────────────────────────────────── */

/**
 * items: [{ id, label, count?, href? }]. With `href` each tab is a link (the
 * route is the state); otherwise `onChange(id)` and a tablist.
 */
export function Tabs({ items, value, onChange, label, renderLink }) {
    const isLinks = items.some((i) => i.href);
    return (
        <div className="sb-tabs" role={isLinks ? undefined : 'tablist'} aria-label={label}>
            {items.map((it) => {
                const body = <>{it.label}{it.count !== undefined && it.count !== null && <span className="c">{it.count}</span>}</>;
                if (isLinks && renderLink) return renderLink(it, it.id === value, body);
                return (
                    <button key={it.id} type="button" role="tab" aria-selected={it.id === value}
                        onClick={() => onChange?.(it.id)}>{body}</button>
                );
            })}
        </div>
    );
}

/* ── Segmented / Switch ─────────────────────────────────────────────────── */

export function Segmented({ options, value, onChange, label, block }) {
    return (
        <div className={cx('sb-seg', block && 'w')} role="radiogroup" aria-label={label}>
            {options.map((o) => {
                const v = typeof o === 'string' ? o : o.value;
                const l = typeof o === 'string' ? o : o.label;
                return (
                    <button key={v} type="button" role="radio" aria-checked={v === value} onClick={() => onChange(v)}>{l}</button>
                );
            })}
        </div>
    );
}

export function Switch({ checked, onChange, label, disabled }) {
    return (
        <button type="button" role="switch" aria-checked={!!checked} aria-label={label} disabled={disabled}
            className="sb-switch-btn" onClick={() => onChange(!checked)}>
            <i className="sb-switch" aria-hidden="true" />
        </button>
    );
}

/* ── Page header / KPIs ─────────────────────────────────────────────────── */

export function PageHeader({ title, sub, actions }) {
    return (
        <div className="sb-ph">
            <div><h1>{title}</h1>{sub && <p>{sub}</p>}</div>
            {actions && <div className="acts">{actions}</div>}
        </div>
    );
}

/** items: [{ label, value, sub?, tone?, onClick? }] */
export function KpiStrip({ items }) {
    return (
        <div className="sb-kpis">
            {items.map((k) => {
                const As = k.onClick ? 'button' : 'div';
                return (
                    <As key={k.label} type={k.onClick ? 'button' : undefined} className="sb-cd sb-kpi" onClick={k.onClick}>
                        <span className="kl">{k.label}</span>
                        <span className="kv sb-num">{k.value}</span>
                        {k.sub && <span className="ks">{k.tone && <i className={`sb-dot ${k.tone}`} aria-hidden="true" />}{k.sub}</span>}
                    </As>
                );
            })}
        </div>
    );
}

/* ── Field ──────────────────────────────────────────────────────────────── */

/** A labelled control. Pass the control as the child; its id is wired up. */
export function Field({ label, hint, error, children, select }) {
    const id = useId();
    const child = React.Children.only(children);
    const control = React.cloneElement(child, {
        id: child.props.id || id,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': error || hint ? `${id}-d` : undefined,
    });
    return (
        <div className="sb-field">
            <label htmlFor={child.props.id || id}>{label}</label>
            {select ? <div className="sb-selwrap">{control}</div> : control}
            {(error || hint) && <span id={`${id}-d`} className={error ? 'err' : 'hint'}>{error || hint}</span>}
        </div>
    );
}

/* ── PixelAvatar ────────────────────────────────────────────────────────── */

const INK = '#111113';

/**
 * A portrait: `spec` is a persona or any { h, x, acc }. A persona shows its
 * character image (`img`); anything else, or an image that fails to load, is
 * drawn as the pixel SVG. Sized by `size` (the tile, in px) or by its container.
 */
export const PixelAvatar = React.memo(function PixelAvatar({ spec, size, round, className, style, label }) {
    const [failed, setFailed] = useState(null);
    const showImg = spec.img && failed !== spec.img;
    const runs = showImg ? null : pixelRuns(spec.h, spec.x || []);
    const colors = { 1: INK, 2: '#fff', 3: spec.acc };
    return (
        <span className={cx('sb-ava', round && 'round', showImg && 'photo', className)}
            style={{ '--a': spec.acc, ...(size ? { width: size, height: size } : null), ...style }}
            role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
            {showImg
                ? <img src={spec.img} alt="" draggable={false} decoding="async" onError={() => setFailed(spec.img)} />
                : (
                    <svg viewBox="0 0 24 24" shapeRendering="crispEdges" aria-hidden="true" focusable="false">
                        {runs.map((r) => <rect key={`${r.y}-${r.x}`} x={r.x} y={r.y} width={r.w} height="1" fill={colors[r.v]} />)}
                    </svg>
                )}
        </span>
    );
});

/* ── Sheet ──────────────────────────────────────────────────────────────── */

// Sheets can stack (a sheet that opens another). Only the top one answers
// Escape and holds focus.
const stack = [];
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A right-hand drawer on desktop, a bottom sheet on phones. Portaled to
 * <body> (with the `sb` class, so it carries the tokens), focus-trapped,
 * closes on Escape and on the scrim, and returns focus to whatever opened it.
 *
 * `size`: default | wide | full (full is full-screen on phones).
 */
export function Sheet({ open, onClose, title, children, footer, size, labelledBy, className }) {
    const ref = useRef(null);
    const headingId = useId();
    const token = useMemo(() => ({}), []);

    useLayoutEffect(() => {
        if (!open) return undefined;
        const opener = document.activeElement;
        stack.push(token);
        const el = ref.current;
        (el?.querySelector('[data-autofocus]') || el)?.focus({ preventScroll: true });
        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            stack.splice(stack.indexOf(token), 1);
            if (!stack.length) document.body.style.overflow = prevOverflow;
            if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus({ preventScroll: true });
        };
    }, [open, token]);

    useEffect(() => {
        if (!open) return undefined;
        const onKey = (e) => {
            if (stack[stack.length - 1] !== token) return;
            if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); onClose?.(); return; }
            if (e.key !== 'Tab') return;
            const nodes = Array.from(ref.current?.querySelectorAll(FOCUSABLE) || []).filter((n) => n.offsetParent !== null);
            if (!nodes.length) { e.preventDefault(); return; }
            const first = nodes[0];
            const last = nodes[nodes.length - 1];
            if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [open, onClose, token]);

    if (!open) return null;
    return createPortal(
        <>
            <div className="sb sb-scrim" onClick={onClose} aria-hidden="true" />
            <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={labelledBy || headingId} tabIndex={-1}
                className={cx('sb sb-sheet', size === 'wide' && 'wide', size === 'full' && 'full', className)}>
                <div className="grab" aria-hidden="true" />
                <div className="dh">
                    <h2 id={headingId}>{title}</h2>
                    <Button variant="ghost" size="sm" iconOnly onClick={onClose} aria-label="Close"><IconClose /></Button>
                </div>
                <div className="db">{children}</div>
                {footer && <div className="df">{footer}</div>}
            </div>
        </>,
        document.body,
    );
}
