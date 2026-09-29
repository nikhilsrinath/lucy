import React from 'react';
import { IconInvoice, IconDoc, IconIn, IconOut, IconTask, IconClients, IconClose, IconCheck, IconAlert } from '../design/icons';
import { wizardOptions, formatWizardValue } from './slashCommands';

/* The step-by-step card a create command (/invoice, /expense, /task …) opens
   above the message box. The box itself takes the typed answer; this card
   shows the question, one-tap answers, what has been answered so far and,
   once complete, a review with Create. */

const KIND_ICON = {
    invoice: IconInvoice, quotation: IconInvoice, offer: IconDoc,
    expense: IconOut, income: IconIn, task: IconTask, client: IconClients,
};

export default function SlashWizard({ wizard, error, busy, onAnswer, onEdit, onCreate, onCancel }) {
    const { definition, index, values, ready } = wizard;
    const { questions } = definition;
    const total = questions.length;
    const question = ready ? null : questions[index];
    const Icon = KIND_ICON[definition.kind] || IconDoc;
    const answered = questions.filter((q) => q.key in values);
    const options = question ? wizardOptions(question) : [];

    return (
        <section className="sb-wiz" aria-label={definition.title || `New ${definition.label}`}>
            <header className="sb-wiz-head">
                <span className="sb-wiz-ico"><Icon size={14} /></span>
                <span className="sb-wiz-title">{definition.title || `New ${definition.label}`}</span>
                <span className="sb-wiz-step">{ready ? 'Review' : `${index + 1} of ${total}`}</span>
                <button type="button" className="sb-wiz-x" onClick={onCancel} aria-label="Cancel" title="Cancel (Esc)">
                    <IconClose size={12} />
                </button>
            </header>

            <div className="sb-wiz-prog" aria-hidden="true">
                {questions.map((q, i) => (
                    <i key={q.key} className={ready || i < index ? 'done' : i === index ? 'cur' : ''} />
                ))}
            </div>

            {ready ? (
                <div className="sb-wiz-body">
                    <div className="sb-wiz-review">
                        {questions.map((q, i) => (
                            <button type="button" key={q.key} className="row" onClick={() => onEdit(i)} disabled={busy} title={`Change ${q.name.toLowerCase()}`}>
                                <span className="k">{q.name}</span>
                                <span className="v">{formatWizardValue(q.key, values[q.key])}</span>
                                <span className="edit">Edit</span>
                            </button>
                        ))}
                    </div>
                    {error && <p className="sb-wiz-err" role="alert"><IconAlert size={13} />{error}</p>}
                    <div className="sb-wiz-actions">
                        <button type="button" className="sb-btn ghost sm" onClick={onCancel} disabled={busy}>Cancel</button>
                        <button type="button" className="sb-btn p sm" onClick={onCreate} disabled={busy}>
                            {busy ? 'Creating…' : <>Create {definition.label}</>}
                        </button>
                    </div>
                </div>
            ) : (
                <div className="sb-wiz-body">
                    {answered.length > 0 && (
                        <div className="sb-wiz-chips">
                            {answered.map((q) => (
                                <button type="button" key={q.key} onClick={() => onEdit(questions.indexOf(q))} title={`Change ${q.name.toLowerCase()}`}>
                                    <IconCheck size={10} />
                                    <span className="k">{q.name}</span>
                                    <span className="v">{formatWizardValue(q.key, values[q.key])}</span>
                                </button>
                            ))}
                        </div>
                    )}
                    <p className="sb-wiz-q" role="status" aria-live="polite">{question.label}</p>
                    {error && <p className="sb-wiz-err" role="alert"><IconAlert size={13} />{error}</p>}
                    {options.length > 0 && (
                        <div className="sb-wiz-opts" role="group" aria-label="Quick answers">
                            {options.map((o) => (
                                <button type="button" key={o.label} onClick={() => onAnswer(o.value)}>{o.label}</button>
                            ))}
                        </div>
                    )}
                    <p className="sb-wiz-hint"><kbd>Enter</kbd> to answer · <kbd>Esc</kbd> to cancel</p>
                </div>
            )}
        </section>
    );
}
