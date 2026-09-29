import { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { Upload, CheckCircle, Eye, GraduationCap, Briefcase, Handshake } from 'lucide-react';
import { pdfService } from '../services/pdfService';
import { storageService } from '../services/storageService';
import { useAuth } from '../context/AuthContext';
import { useOrg } from '../context/OrgContext';
import { usePlanStatus } from '../hooks/usePlanStatus';
import { resolveFormImages, generateStampPng } from '../utils/imageUtils';
import { saveLetter, loadLetterDraft } from '../services/letterSave';
import { useToast } from './shared/Toast';
import DocSteps, { Step } from './shared/DocSteps';
import OfferPreview from './OfferPreview';
import A4Stage from './shared/A4Stage';

function getDisplayName(emp) {
  if (emp.studentName) return emp.studentName;
  const f = (emp.first_name || '').trim();
  const l = (emp.last_name || '').trim();
  return `${f} ${l}`.trim() || emp.email || '';
}

const OFFER_TYPES = [
  { id: 'internship', label: 'Internship', sub: 'A fixed period, with or without a stipend', Icon: GraduationCap },
  { id: 'fulltime', label: 'Full-time', sub: 'A permanent role with a salary', Icon: Briefcase },
  { id: 'collaboration', label: 'Collaboration', sub: 'A project partnership, paid by fee or milestone', Icon: Handshake },
];

export default function OfferForm() {
  const navigate = useNavigate();
  const location = useLocation();
  const slashPrefill = location.state?.slashPrefill;
  const autoSubmitRef = useRef(false);
  const { user } = useAuth();
  const { activeOrg } = useOrg();
  const [employees, setEmployees] = useState([]);
  const [deptOptions, setDeptOptions] = useState([]);

  useEffect(() => {
    if (!activeOrg?.id) return;
    Promise.all([
      storageService.getEmployees(activeOrg.id),
      storageService.getDepartments(activeOrg.id),
    ]).then(([emps, fbDepts]) => {
      setEmployees(emps);
      // Derive dept names from employees and merge with any Firebase-stored ones
      const fromEmps = emps.map(e => e.department).filter(Boolean);
      const fromFb   = fbDepts.map(d => d.name);
      setDeptOptions([...new Set([...fromEmps, ...fromFb])].sort());
    });
  }, [activeOrg?.id]);
  
  const { currentPlan, planConfig, usage, canCreate, getRemainingCount, getUsagePercent, isAtLimit, refreshUsage } = usePlanStatus();
  const org = activeOrg || {};
  const [formData, setFormData] = useState({
    offerType: 'internship',
    companyName: org.company_name || '',
    companyTagline: org.company_tagline || '',
    companyAddress: org.company_address || '',
    companyLogo: org.logo_url || null,
    cin: org.cin || '',
    companyWebsite: org.company_website || '',
    authorizedPersonName: org.owner_full_name || '',
    authorizedPersonDesignation: org.document_designation || '',
    contactEmail: org.company_email || '',
    contactPhone: org.company_phone || '',
    stampType: org.stamp_type || 'generated',
    stampUrl: org.stamp_url || '',
    stampCity: org.stamp_city || '',
    showStamp: true,
    studentName: slashPrefill?.studentName || '',
    signature: org.signature_url || null,
    studentAddress: '',
    email: '',
    phone: '',
    role: slashPrefill?.role || '',
    department: slashPrefill?.department || '',
    supervisorName: '',
    responsibilities: '',
    startDate: slashPrefill?.startDate || '',
    endDate: '',
    acceptanceDeadline: '',
    isPaid: false,
    stipend: slashPrefill?.stipend || 0,
    currency: 'INR',
    paymentFrequency: 'Monthly'
  });

  const [isSubmitting, setIsSubmitting] = useState(false);
  const toast = useToast();
  // ?draft=<id>: carrying on from a draft letter saved on Team.
  const [params] = useSearchParams();
  const draftId = params.get('draft');
  useEffect(() => {
    if (!draftId || !activeOrg?.id) return undefined;
    let cancelled = false;
    loadLetterDraft(draftId, 'offer', activeOrg.id).then((form) => {
      if (cancelled) return;
      if (form) setFormData((prev) => ({ ...prev, ...form }));
      else toast('That draft could not be found, so this is a new offer letter.', 'error');
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId, activeOrg?.id]);

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value
    }));
  };

  const setOfferType = (type) => setFormData(prev => ({ ...prev, offerType: type }));
  const who = formData.offerType === 'internship' ? 'Intern' : formData.offerType === 'collaboration' ? 'Collaborator' : 'Employee';
  const payLabel = formData.offerType === 'internship' ? 'Stipend' : formData.offerType === 'collaboration' ? 'Fee' : 'Salary';

  const handleLogoUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => setFormData(prev => ({ ...prev, companyLogo: reader.result }));
      reader.readAsDataURL(file);
    }
  };

  const handleSignatureUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => setFormData(prev => ({ ...prev, signature: reader.result }));
      reader.readAsDataURL(file);
    }
  };

  const saveAs = async (status) => {
    setIsSubmitting(true);
    try {
      const id = await saveLetter({ kind: 'offer', form: formData, status, draftId, orgId: activeOrg?.id, userId: user?.id });
      return id;
    } catch (err) {
      console.error(err);
      toast('Could not save the offer letter: ' + err.message, 'error');
      return null;
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmit = async (e) => {
    e?.preventDefault?.();
    if (!draftId && !canCreate('offerLetters')) {
      toast(`You've reached your ${planConfig.name} plan limit of ${planConfig.limits.offerLetters} offer letters. Upgrade to continue.`, 'error');
      return;
    }
    const id = await saveAs('pending');
    if (!id) return;
    await refreshUsage();
    toast(`Offer letter for ${formData.studentName} created`, 'success');
    // Its sheet on Team has the signing link, the email and the PDF.
    navigate(`/team?letter=${id}`);
  };

  const handleSaveDraft = async () => {
    if (!draftId && !canCreate('offerLetters')) {
      toast(`You've reached your ${planConfig.name} plan limit of ${planConfig.limits.offerLetters} offer letters.`, 'error');
      return;
    }
    const id = await saveAs('draft');
    if (!id) return;
    await refreshUsage();
    toast('Offer letter saved as a draft. Open it on Team to carry on.', 'success');
    navigate('/team');
  };

  useEffect(() => {
    if (!location.state?.autoSubmit || autoSubmitRef.current || !slashPrefill?.studentName || !slashPrefill?.role) return;
    autoSubmitRef.current = true;
    const timer = setTimeout(() => handleSubmit({ preventDefault() {} }), 0);
    return () => clearTimeout(timer);
  }, [location.state?.autoSubmit, slashPrefill?.studentName, slashPrefill?.role]);

  const handlePreview = async () => {
    const resolved = await resolveFormImages(formData, ['companyLogo', 'signature', 'stampUrl']);
    if (resolved.stampType === 'generated') {
      resolved.stampPng = await generateStampPng(resolved.companyName, resolved.stampCity);
    }
    await pdfService.generateOfferLetter(resolved, true);
  };

  return (
    <div className="mou-split-layout">

      {/* LEFT: Form */}
      <div className="mou-form-pane">
        <form onSubmit={(e) => e.preventDefault()} className="easy-form animate-in" style={{ maxWidth: '100%' }}>

          {/* Plan Usage */}
          {currentPlan !== 'max' && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
              padding: '0.75rem 1rem',
              background: 'var(--bg-elevated)',
              borderRadius: '10px',
              marginBottom: '1.5rem',
              fontSize: '0.8125rem',
              border: isAtLimit('offerLetters') ? '1px solid rgba(239,68,68,0.3)' : '1px solid var(--border-subtle)'
            }}>
              <span style={{ fontWeight: 600, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>Offer Letters</span>
              <div style={{ flex: 1, height: '4px', background: 'var(--bg-raised)', borderRadius: '2px', overflow: 'hidden' }}>
                <div style={{
                  height: '100%',
                  borderRadius: '2px',
                  background: isAtLimit('offerLetters') ? 'var(--error)' : getUsagePercent('offerLetters') > 80 ? 'var(--text-primary)' : 'var(--text-secondary)',
                  transition: 'width 0.3s',
                  width: `${Math.min(getUsagePercent('offerLetters'), 100)}%`
                }} />
              </div>
              <span style={{ fontWeight: 700, color: isAtLimit('offerLetters') ? 'var(--error)' : 'var(--text-primary)', whiteSpace: 'nowrap' }}>
                {usage.offerLetters}/{planConfig.limits.offerLetters === Infinity ? '∞' : planConfig.limits.offerLetters}
              </span>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>({getRemainingCount('offerLetters')} remaining)</span>
            </div>
          )}

          {isAtLimit('offerLetters') && (
            <div style={{
              textAlign: 'center',
              padding: '1.5rem',
              background: 'rgba(239,68,68,0.04)',
              border: '1px solid rgba(239,68,68,0.15)',
              borderRadius: '12px',
              marginBottom: '1.5rem'
            }}>
              <div style={{ fontSize: '1.25rem', marginBottom: '0.5rem' }}>⚠️</div>
              <h3 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '0.5rem' }}>Offer Letter Limit Reached</h3>
              <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
                You've used all {planConfig.limits.offerLetters} offer letters in your {planConfig.name} plan.
              </p>
              <a href="mailto:edgeossuite@gmail.com" className="btn-cinematic" style={{ textDecoration: 'none', padding: '0.75rem 1.5rem', fontSize: '0.875rem' }}>
                Upgrade to {currentPlan === 'free' ? 'Pro' : 'Max'}
              </a>
            </div>
          )}

          <DocSteps
            onDraft={handleSaveDraft}
            onCreate={handleSubmit}
            createLabel={isSubmitting ? 'Saving…' : isAtLimit('offerLetters') && !draftId ? 'Limit reached' : 'Create offer letter'}
            busy={isSubmitting}
            createDisabled={isAtLimit('offerLetters') && !draftId}
            onPreview={handlePreview}
            finalNote="It opens on Team, where you can email it, copy its signing link or download the PDF."
          >
          <Step title="Type of offer">
            <div className="sb-choices" role="radiogroup" aria-label="Type of offer">
              {OFFER_TYPES.map((t) => (
                <button key={t.id} type="button" role="radio" aria-checked={formData.offerType === t.id}
                  className={`sb-choice${formData.offerType === t.id ? ' on' : ''}`} onClick={() => setOfferType(t.id)}>
                  <span className="ic" aria-hidden="true"><t.Icon size={20} /></span>
                  <span className="tx"><b>{t.label}</b><small>{t.sub}</small></span>
                  <span className="rd" aria-hidden="true" />
                </button>
              ))}
            </div>
          </Step>

          <Step title={`${who} details`}>
            <div className="easy-row">
              <div className="easy-field full">
                <label className="easy-lbl">Full name</label>
                <input aria-label="Full name" name="studentName" value={formData.studentName} onChange={handleChange} required placeholder="Full name" className="easy-inp" autoComplete="off" />
              </div>
              <div className="easy-field">
                <label className="easy-lbl">Email</label>
                <input aria-label="Email" type="email" name="email" value={formData.email} onChange={handleChange} placeholder="name@example.com" className="easy-inp" />
              </div>
              <div className="easy-field">
                <label className="easy-lbl">Phone</label>
                <input aria-label="Phone" type="tel" name="phone" value={formData.phone} onChange={handleChange} placeholder="+91 …" className="easy-inp" />
              </div>
              <div className="easy-field full">
                <label className="easy-lbl">Address</label>
                <input aria-label="Address" name="studentAddress" value={formData.studentAddress} onChange={handleChange} required placeholder="Street, city" className="easy-inp" />
              </div>
            </div>
          </Step>

          <Step title="Role">
            <div className="easy-row">
              <div className="easy-field">
                <label className="easy-lbl">Job title</label>
                <input aria-label="Job title" name="role" value={formData.role} onChange={handleChange} required placeholder="e.g. Finance Manager" className="easy-inp" />
              </div>
              <div className="easy-field">
                <label className="easy-lbl">Department</label>
                {deptOptions.length > 0 ? (
                  <select aria-label="Department" name="department" value={formData.department} onChange={handleChange} required className="easy-inp">
                    <option value="">Select department…</option>
                    {deptOptions.map(name => <option key={name} value={name}>{name}</option>)}
                  </select>
                ) : (
                  <input aria-label="Department" name="department" value={formData.department} onChange={handleChange} required placeholder="e.g. Operations" className="easy-inp" />
                )}
              </div>
              <div className="easy-field full">
                <label className="easy-lbl">Reports to</label>
                {employees.length > 0 ? (
                  <select aria-label="Reports to" name="supervisorName" value={formData.supervisorName} onChange={handleChange} required className="easy-inp">
                    <option value="">Select supervisor…</option>
                    {employees.map(e => {
                      const name = getDisplayName(e);
                      return name ? <option key={e.id} value={name}>{name}{e.role ? ` — ${e.role}` : ''}</option> : null;
                    })}
                  </select>
                ) : (
                  <input aria-label="Reports to" name="supervisorName" value={formData.supervisorName} onChange={handleChange} required placeholder="Their manager's name" className="easy-inp" />
                )}
              </div>
              <div className="easy-field full">
                <label className="easy-lbl">Responsibilities</label>
                <textarea aria-label="Responsibilities" name="responsibilities" value={formData.responsibilities} onChange={handleChange} required placeholder="Key responsibilities and goals…" rows="3" className="easy-inp sb-short" />
              </div>
            </div>
          </Step>

          <Step title="Dates">
            <div className="easy-row">
              <div className="easy-field">
                <label className="easy-lbl">Start date</label>
                <input aria-label="Start date" type="date" name="startDate" value={formData.startDate} onChange={handleChange} required className="easy-inp" />
              </div>
              {(formData.offerType === 'internship' || formData.offerType === 'collaboration') && (
                <div className="easy-field">
                  <label className="easy-lbl">End date</label>
                  <input aria-label="End date" type="date" name="endDate" value={formData.endDate} onChange={handleChange} required min={formData.startDate || undefined} className="easy-inp" />
                </div>
              )}
              <div className="easy-field">
                <label className="easy-lbl">Reply by</label>
                <input aria-label="Reply by" type="date" name="acceptanceDeadline" value={formData.acceptanceDeadline} onChange={handleChange} required className="easy-inp" />
                <span className="sb-hint">The last day they can accept the offer.</span>
              </div>
            </div>
          </Step>

          <Step title="Pay">
            <button
              type="button" role="switch" aria-checked={!!formData.isPaid}
              className={`easy-switch-row ${formData.isPaid ? 'active' : ''}`}
              onClick={() => handleChange({ target: { name: 'isPaid', checked: !formData.isPaid, type: 'checkbox' } })}
            >
              <span className="easy-switch-label">
                {formData.offerType === 'internship' ? 'Paid internship' : formData.offerType === 'collaboration' ? 'Paid collaboration' : 'Paid position'}
              </span>
              <span className="easy-switch-dot" aria-hidden="true" />
            </button>

            {formData.isPaid ? (
              <div className="easy-row" style={{ marginTop: 16 }}>
                <div className="easy-field full">
                  <label className="easy-lbl">{payLabel}</label>
                  <input aria-label={payLabel} type="number" inputMode="decimal" min="0" name="stipend" value={formData.stipend} onChange={handleChange} required placeholder="0" className="easy-inp" />
                </div>
                <div className="easy-field">
                  <label className="easy-lbl">Currency</label>
                  <select aria-label="Currency" name="currency" value={formData.currency} onChange={handleChange} className="easy-inp">
                    <option value="INR">INR</option>
                    <option value="USD">USD</option>
                    <option value="EUR">EUR</option>
                  </select>
                </div>
                <div className="easy-field">
                  <label className="easy-lbl">Paid</label>
                  <select aria-label="Paid" name="paymentFrequency" value={formData.paymentFrequency} onChange={handleChange} className="easy-inp">
                    <option value="Monthly">Monthly</option>
                    {formData.offerType === 'fulltime' ? (
                      <option value="Annual">Annual (CTC)</option>
                    ) : formData.offerType === 'collaboration' ? (
                      <>
                        <option value="Once">One-time</option>
                        <option value="Milestone">By milestone</option>
                      </>
                    ) : (
                      <option value="Once">One-time</option>
                    )}
                  </select>
                </div>
              </div>
            ) : (
              <p className="sb-hint" style={{ marginTop: 12 }}>Turn this on to add a {payLabel.toLowerCase()}.</p>
            )}
          </Step>

          <Step title="Company">
            <div className="easy-row">
              <div className="easy-field full">
                <label className="easy-lbl">Company name</label>
                <input aria-label="Company name" name="companyName" value={formData.companyName} onChange={handleChange} required placeholder="Acme International Ltd." className="easy-inp" />
              </div>
              <div className="easy-field full">
                <label className="easy-lbl">Registered address</label>
                <input aria-label="Registered address" name="companyAddress" value={formData.companyAddress} onChange={handleChange} required placeholder="Full registered address" className="easy-inp" />
              </div>
              <div className="easy-field">
                <label className="easy-lbl">Signed by</label>
                <input aria-label="Signed by" name="authorizedPersonName" value={formData.authorizedPersonName} onChange={handleChange} required placeholder="John Doe" className="easy-inp" />
              </div>
              <div className="easy-field">
                <label className="easy-lbl">Their title</label>
                <input aria-label="Their title" name="authorizedPersonDesignation" value={formData.authorizedPersonDesignation} onChange={handleChange} required placeholder="CEO / Manager" className="easy-inp" />
              </div>
            </div>
          </Step>

          <Step title="Logo & signature">
            <div className="easy-row">
              <div className="easy-field">
                <label className="easy-lbl">Company logo</label>
                <div className="easy-upload-wrap">
                  <input aria-label="Company logo" type="file" onChange={handleLogoUpload} accept="image/*" />
                  <div className={`easy-upload ${formData.companyLogo ? 'done' : ''}`}>
                    {formData.companyLogo ? <><CheckCircle size={16} /> Logo added</> : <><Upload size={16} /> Choose a file</>}
                  </div>
                </div>
              </div>
              <div className="easy-field">
                <label className="easy-lbl">Signature</label>
                <div className="easy-upload-wrap">
                  <input aria-label="Signature" type="file" onChange={handleSignatureUpload} accept="image/*" />
                  <div className={`easy-upload ${formData.signature ? 'done' : ''}`}>
                    {formData.signature ? <><CheckCircle size={16} /> Signature added</> : <><Upload size={16} /> Choose a file</>}
                  </div>
                </div>
                {formData.signature && <img src={formData.signature} alt="Signature" className="sb-sig" />}
              </div>
              <div className="easy-field full">
                <button
                  type="button" role="switch" aria-checked={!!formData.showStamp}
                  className={`easy-switch-row ${formData.showStamp ? 'active' : ''}`}
                  onClick={() => handleChange({ target: { name: 'showStamp', checked: !formData.showStamp, type: 'checkbox' } })}
                >
                  <span className="easy-switch-label">Add the company stamp</span>
                  <span className="easy-switch-dot" aria-hidden="true" />
                </button>
              </div>
            </div>
          </Step>
          </DocSteps>
        </form>
      </div>

      {/* RIGHT: Live Preview */}
      <div className="mou-preview-pane">
        <div className="mou-preview-toolbar">
          <span className="mou-preview-toolbar-label">Live Preview</span>
          <button type="button" onClick={handlePreview} className="easy-submit-outline" style={{ padding: '0.375rem 0.875rem', fontSize: '0.75rem', width: 'auto' }}>
            <Eye size={14} /> Open PDF
          </button>
        </div>
        <A4Stage>
          <OfferPreview formData={formData} />
        </A4Stage>
      </div>

    </div>
  );
}
