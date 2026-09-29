import { Children, cloneElement, isValidElement, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Eye } from 'lucide-react';

/* ══════════════════════════════════════════════════════════════════════════
   One section at a time.

   The document editors (invoice, quotation, proforma, offer letter, NDA) used
   to be one long scroll of sections with a stack of buttons at the foot. Here
   each <Step> is a screen: Next checks that step's fields before moving on,
   Back never checks, and the last step ends on exactly two actions — save it
   as a draft, or create it.

   · Every step stays mounted (hidden, not unmounted), so pickers and
     dropdowns keep their own state, and Create can check every step's
     fields, jumping to the first one with something missing.
   · A step's own checks: the browser's (required, type="email", min…) plus
     an optional `validate()` returning a message, or '' when it is fine.
   · Draft checks nothing: a draft is by definition unfinished.
   · Steps already reached can be revisited from the progress bar.

   Styles: docEditor.css (.sb-steps*), inside the editors' .sb-doced frame.
   ══════════════════════════════════════════════════════════════════════════ */

const FIELDS = 'input, select, textarea';

/** A section of the form. Rendered by DocSteps, which passes the private props. */
export function Step({ title, children, _n, _active }) {
    return (
        <div className="easy-section sb-step" hidden={!_active} data-step={_n}>
            <div className="easy-section-head">
                <div className="easy-num">{_n}</div>
                <h2 className="easy-section-title" tabIndex={-1}>{title}</h2>
            </div>
            {children}
        </div>
    );
}

/** The first field in `root` that fails the browser's checks, or null. */
const firstInvalid = (root) => [...(root?.querySelectorAll(FIELDS) || [])].find((el) => !el.disabled && !el.checkValidity()) || null;

export default function DocSteps({
    children,
    onCreate, onDraft,
    createLabel = 'Create', draftLabel = 'Save draft',
    busy = false, createDisabled = false,
    onPreview,
    finalNote,
}) {
    const steps = Children.toArray(children).filter(isValidElement);
    const [at, setAt] = useState(0);
    const [reached, setReached] = useState(0);
    const [error, setError] = useState('');
    const rootRef = useRef(null);
    const moved = useRef(false);
    const pendingReport = useRef(false);

    const last = steps.length - 1;
    const cur = Math.min(at, last);

    const stepEl = (i) => rootRef.current?.querySelector(`[data-step="${i + 1}"]`);

    // A move puts the new step at the top of whatever scrolls, and focus on its
    // title, so a screen reader hears where it landed.
    useEffect(() => {
        if (!moved.current) return;
        const root = rootRef.current;
        root?.closest('.mou-form-pane')?.scrollTo?.({ top: 0 });
        root?.closest('.mou-split-layout')?.scrollTo?.({ top: 0 });
        if (pendingReport.current) {
            pendingReport.current = false;
            firstInvalid(stepEl(cur))?.reportValidity();
        } else {
            stepEl(cur)?.querySelector('.easy-section-title')?.focus({ preventScroll: true });
        }
    }, [cur]);

    const go = (i) => {
        moved.current = true;
        setError('');
        setAt(i);
        setReached((r) => Math.max(r, i));
    };

    /** '' when step i is complete, otherwise what is wrong (and the browser shows it). */
    const check = (i, { report = true } = {}) => {
        const bad = firstInvalid(stepEl(i));
        if (bad) {
            if (report) bad.reportValidity();
            return bad.validationMessage || 'Something here needs attention.';
        }
        return steps[i].props.validate?.() || '';
    };

    const next = () => {
        const msg = check(cur);
        if (msg) { setError(msg); return; }
        go(cur + 1);
    };

    const create = () => {
        for (let i = 0; i <= last; i += 1) {
            const msg = check(i, { report: i === cur });
            if (!msg) continue;
            if (i !== cur) {
                pendingReport.current = true;
                go(i);
            }
            setError(msg);
            return;
        }
        onCreate?.();
    };

    // Enter in a field moves on rather than submitting the whole document.
    const onKeyDown = (e) => {
        if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
        const t = e.target;
        if (t.tagName !== 'INPUT' || ['button', 'submit', 'checkbox', 'radio', 'file'].includes(t.type)) return;
        e.preventDefault();
        if (cur < last) next();
    };

    const title = steps[cur]?.props.title;

    return (
        <div className="sb-steps" ref={rootRef} onKeyDown={onKeyDown} data-at={cur}>
            <div className="sb-steps-top">
                <div className="sb-steps-meta">
                    <span className="n">Step {cur + 1} of {steps.length}</span>
                    {onPreview && (
                        <button type="button" className="sb-steps-prev" onClick={onPreview}>
                            <Eye size={14} aria-hidden="true" /> Preview
                        </button>
                    )}
                </div>
                <ol className="sb-steps-bar" aria-label="Steps">
                    {steps.map((s, i) => (
                        <li key={s.key ?? i}>
                            <button type="button" disabled={i > reached || busy} onClick={() => go(i)}
                                aria-current={i === cur ? 'step' : undefined}
                                className={i < cur ? 'done' : i === cur ? 'on' : undefined}
                                aria-label={`Step ${i + 1}: ${s.props.title}${i > reached ? ' (not reached yet)' : ''}`}>
                                <span />
                            </button>
                        </li>
                    ))}
                </ol>
            </div>

            {steps.map((s, i) => cloneElement(s, { _n: i + 1, _active: i === cur }))}

            {error && <p className="sb-steps-err" role="alert">{error}</p>}
            {cur === last && finalNote && <p className="sb-steps-note">{finalNote}</p>}

            <div className="sb-steps-foot">
                {cur > 0 && (
                    <button type="button" className="sb-steps-back" onClick={() => go(cur - 1)} disabled={busy}
                        aria-label={`Back to ${steps[cur - 1].props.title}`}>
                        <ChevronLeft size={18} aria-hidden="true" />
                        {cur < last && <span>Back</span>}
                    </button>
                )}
                {cur < last ? (
                    <button type="button" className="easy-submit sb-steps-next" onClick={next} disabled={busy}>
                        Next: {steps[cur + 1].props.title} <ChevronRight size={18} aria-hidden="true" />
                    </button>
                ) : (
                    <>
                        {onDraft && (
                            <button type="button" className="easy-submit-outline sb-steps-draft" onClick={onDraft} disabled={busy}>
                                {draftLabel}
                            </button>
                        )}
                        <button type="button" className="easy-submit sb-steps-create" onClick={create} disabled={busy || createDisabled}>
                            {createLabel}
                        </button>
                    </>
                )}
            </div>
            <span className="sb-sr" aria-live="polite">{title ? `Step ${cur + 1} of ${steps.length}: ${title}` : ''}</span>
        </div>
    );
}
