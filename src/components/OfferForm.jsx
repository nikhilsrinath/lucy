import { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Upload, CheckCircle, ChevronRight, Eye, Send, Loader, ExternalLink, Copy, X } from 'lucide-react';
import { pdfService } from '../services/pdfService';
import { storageService } from '../services/storageService';
import { documentStore } from '../services/documentStore';
import { emailService } from '../services/emailService';
import { useAuth } from '../context/AuthContext';
import { useOrg } from '../context/OrgContext';
import { usePlanStatus } from '../hooks/usePlanStatus';
import { resolveFormImages, generateStampPng } from '../utils/imageUtils';
import { createPortalLink } from '../services/portalService';
import OfferPreview from './OfferPreview';
import A4Stage from './shared/A4Stage';

function getDisplayName(emp) {
  if (emp.studentName) return emp.studentName;
  const f = (emp.first_name || '').trim();
  const l = (emp.last_name || '').trim();
  return `${f} ${l}`.trim() || emp.email || '';
}

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
  const [isSendingEmail, setIsSendingEmail] = useState(false);
  const [emailResult, setEmailResult] = useState(null);
  const [showPortalModal, setShowPortalModal] = useState(false);
  const [portalUrl, setPortalUrl] = useState('');
  const [portalLinkLoading, setPortalLinkLoading] = useState(false);
  const [portalCopied, setPortalCopied] = useState(false);

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value
    }));
  };

  const setOfferType = (type) => setFormData(prev => ({ ...prev, offerType: type }));

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

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!canCreate('offerLetters')) {
      alert(`You've reached your ${planConfig.name} plan limit of ${planConfig.limits.offerLetters} offer letters. Please upgrade to continue.`);
      return;
    }
    setIsSubmitting(true);
    try {
      const resolved = await resolveFormImages(formData, ['companyLogo', 'signature', 'stampUrl']);
      if (resolved.stampType === 'generated') {
        resolved.stampPng = await generateStampPng(resolved.companyName, resolved.stampCity);
      }
      await storageService.save(formData, 'offer', activeOrg?.id, user?.id);
      await pdfService.generateOfferLetter(resolved);
      await refreshUsage();
      setTimeout(() => {
        setIsSubmitting(false);
        navigate('/records');
      }, 800);
    } catch (err) {
      console.error(err);
      alert("Error saving offer: " + err.message);
      setIsSubmitting(false);
    }
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

  const handleCreatePortalLink = async () => {
    if (!formData.studentName || !formData.role) {
      alert('Please fill in at least the candidate name and role before creating a portal link.');
      return;
    }
    setPortalLinkLoading(true);
    try {
      documentStore.setContext(activeOrg?.id);
      await documentStore.init();
      const today = new Date().toISOString().split('T')[0];
      // The document number is allocated by the database on save.
      const doc = {
        type: 'offer_letter',
        status: 'pending',
        issued_to: formData.studentName,
        recipient_email: formData.email || '',
        role: formData.role,
        department: formData.department || '',
        offer_type: formData.offerType,
        start_date: formData.startDate || '',
        end_date: formData.endDate || '',
        salary: formData.isPaid ? formData.stipend : null,
        currency: formData.currency || 'INR',
        payment_frequency: formData.paymentFrequency || 'Monthly',
        is_paid: formData.isPaid,
        responsibilities: formData.responsibilities || '',
        supervisor: formData.supervisorName || '',
        valid_until: formData.acceptanceDeadline || '',
        issue_date: today,
        created_at: new Date().toISOString(),
        company_profile: {
          company_name: activeOrg?.company_name || formData.companyName || '',
          address: activeOrg?.company_address || formData.companyAddress || '',
          email: activeOrg?.company_email || formData.contactEmail || '',
          phone: activeOrg?.company_phone || formData.contactPhone || '',
          logo_url: activeOrg?.logo_url || formData.companyLogo || '',
          signature_url: activeOrg?.signature_url || formData.signature || '',
          company_tagline: activeOrg?.company_tagline || formData.companyTagline || '',
          authorized_person: formData.authorizedPersonName || '',
          authorized_designation: formData.authorizedPersonDesignation || '',
        },
      };
      const saved = await documentStore.save(doc);
      const { url } = await createPortalLink({
        orgId: activeOrg?.id,
        documentId: saved.id,
        recipientEmail: formData.email,
      });
      setPortalUrl(url);
      setShowPortalModal(true);
    } catch (err) {
      console.error('Portal link error:', err);
      alert('Failed to create portal link: ' + err.message);
    } finally {
      setPortalLinkLoading(false);
    }
  };

  const handleCopyPortalLink = async () => {
    await navigator.clipboard.writeText(portalUrl);
    setPortalCopied(true);
    setTimeout(() => setPortalCopied(false), 2000);
  };

  const handleNotifyEmployee = async () => {
    if (!formData.email) {
      setEmailResult({ success: false, message: 'Please enter the employee\'s email address first.' });
      setTimeout(() => setEmailResult(null), 4000);
      return;
    }
    setIsSendingEmail(true);
    setEmailResult(null);
    try {
      const resolved = await resolveFormImages(formData, ['companyLogo', 'signature', 'stampUrl']);
      if (resolved.stampType === 'generated') {
        resolved.stampPng = await generateStampPng(resolved.companyName, resolved.stampCity);
      }
      const result = await emailService.sendOfferNotification({
        recordData: resolved,
        orgProfile: activeOrg,
        companyName: activeOrg?.company_name || formData.companyName || 'Company',
      });
      setEmailResult(result);
      setTimeout(() => setEmailResult(null), 5000);
    } catch {
      setEmailResult({ success: false, message: 'Failed to send email.' });
      setTimeout(() => setEmailResult(null), 5000);
    } finally {
      setIsSendingEmail(false);
    }
  };

  return (
    <div className="mou-split-layout">

      {/* LEFT: Form */}
      <div className="mou-form-pane">
        <form onSubmit={handleSubmit} className="easy-form animate-in" style={{ maxWidth: '100%' }}>

          {/* Type Toggle */}
          <div className="easy-toggle-bar">
            {['internship', 'fulltime', 'collaboration'].map((type) => (
              <button key={type} type="button" onClick={() => setOfferType(type)}
                className={`easy-toggle-btn ${formData.offerType === type ? 'active' : ''}`}>
                {type === 'internship' ? 'Internship' : type === 'fulltime' ? 'Full-Time' : 'Collaboration'}
              </button>
            ))}
          </div>

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

          {/* 1. Company */}
          <div className="easy-section">
            <div className="easy-section-head">
              <div className="easy-num">1</div>
              <span className="easy-section-title">Company details</span>
            </div>
            <div className="easy-row">
              <div className="easy-field full">
                <label className="easy-lbl">Company name</label>
                <input aria-label="Company name" name="companyName" value={formData.companyName} onChange={handleChange} required placeholder="Acme International Ltd." className="easy-inp" />
              </div>
              <div className="easy-field full">
                <label className="easy-lbl">Company address</label>
                <textarea aria-label="Company address" name="companyAddress" value={formData.companyAddress} onChange={handleChange} required placeholder="Full registered address" rows="2" className="easy-inp" style={{ resize: 'none' }} />
              </div>
              <div className="easy-field">
                <label className="easy-lbl">Authorized person</label>
                <input aria-label="Authorized person" name="authorizedPersonName" value={formData.authorizedPersonName} onChange={handleChange} required placeholder="John Doe" className="easy-inp" />
              </div>
              <div className="easy-field">
                <label className="easy-lbl">Their title</label>
                <input aria-label="Their title" name="authorizedPersonDesignation" value={formData.authorizedPersonDesignation} onChange={handleChange} required placeholder="CEO / Manager" className="easy-inp" />
              </div>
              <div className="easy-field">
                <label className="easy-lbl">Company logo</label>
                <div className="easy-upload-wrap">
                  <input aria-label="Company logo" type="file" onChange={handleLogoUpload} accept="image/*" />
                  <div className={`easy-upload ${formData.companyLogo ? 'done' : ''}`}>
                    {formData.companyLogo ? <><CheckCircle size={16} /> Logo uploaded</> : <><Upload size={16} /> Choose file</>}
                  </div>
                </div>
              </div>
              <div className="easy-field">
                <label className="easy-lbl">Digital signature</label>
                <div className="easy-upload-wrap">
                  <input aria-label="Digital signature" type="file" onChange={handleSignatureUpload} accept="image/*" />
                  <div className={`easy-upload ${formData.signature ? 'done' : ''}`}>
                    {formData.signature ? <><CheckCircle size={16} /> Signature uploaded</> : <><Upload size={16} /> Choose file</>}
                  </div>
                </div>
                {formData.signature && <img src={formData.signature} alt="Signature" style={{ height: '28px', marginTop: '0.25rem' }} />}
              </div>
              <div className="easy-field full">
                <button
                  type="button" role="switch" aria-checked={!!formData.showStamp}
                  className={`easy-switch-row ${formData.showStamp ? 'active' : ''}`}
                  onClick={() => handleChange({ target: { name: 'showStamp', checked: !formData.showStamp, type: 'checkbox' } })}
                  style={{ marginTop: '0.5rem' }}
                >
                  <span className="easy-switch-label">Include company stamp</span>
                  <span className="easy-switch-dot" aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>

          {/* 2. Candidate */}
          <div className="easy-section">
            <div className="easy-section-head">
              <div className="easy-num">2</div>
              <span className="easy-section-title">{formData.offerType === 'internship' ? 'Intern' : formData.offerType === 'collaboration' ? 'Collaborator' : 'Employee'} details</span>
            </div>
            <div className="easy-row">
              <div className="easy-field">
                <label className="easy-lbl">Full name</label>
                <input aria-label="Full name" name="studentName" value={formData.studentName} onChange={handleChange} required placeholder="Full Name" className="easy-inp" />
              </div>
              <div className="easy-field">
                <label className="easy-lbl">Address</label>
                <input aria-label="Address" name="studentAddress" value={formData.studentAddress} onChange={handleChange} required placeholder="Street / City" className="easy-inp" />
              </div>
              <div className="easy-field">
                <label className="easy-lbl">Email</label>
                <input aria-label="Email" type="email" name="email" value={formData.email} onChange={handleChange} placeholder="example@gmail.com" className="easy-inp" />
              </div>
              <div className="easy-field">
                <label className="easy-lbl">Phone</label>
                <input aria-label="Phone" name="phone" value={formData.phone} onChange={handleChange} placeholder="+91 ..." className="easy-inp" />
              </div>
            </div>
          </div>

          {/* 3. Role & Dates */}
          <div className="easy-section">
            <div className="easy-section-head">
              <div className="easy-num">3</div>
              <span className="easy-section-title">Role & timeline</span>
            </div>
            <div className="easy-row">
              <div className="easy-field">
                <label className="easy-lbl">Job title / role</label>
                <input aria-label="Job title / role" name="role" value={formData.role} onChange={handleChange} required placeholder="e.g. Finance Manager" className="easy-inp" />
              </div>
              <div className="easy-field">
                <label className="easy-lbl">Department</label>
                {deptOptions.length > 0 ? (
                  <select aria-label="Department" name="department" value={formData.department} onChange={handleChange} required className="easy-inp">
                    <option value="">Select department…</option>
                    {deptOptions.map(name => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                  </select>
                ) : (
                  <input aria-label="Department" name="department" value={formData.department} onChange={handleChange} required placeholder="e.g. Operations" className="easy-inp" />
                )}
              </div>
              <div className="easy-field">
                <label className="easy-lbl">Start date</label>
                <input aria-label="Start date" type="date" name="startDate" value={formData.startDate} onChange={handleChange} required className="easy-inp" />
              </div>
              {(formData.offerType === 'internship' || formData.offerType === 'collaboration') && (
                <div className="easy-field">
                  <label className="easy-lbl">End date</label>
                  <input aria-label="End date" type="date" name="endDate" value={formData.endDate} onChange={handleChange} required className="easy-inp" />
                </div>
              )}
              <div className="easy-field">
                <label className="easy-lbl">Reporting supervisor</label>
                {employees.length > 0 ? (
                  <select aria-label="Reporting supervisor" name="supervisorName" value={formData.supervisorName} onChange={handleChange} required className="easy-inp">
                    <option value="">Select supervisor…</option>
                    {employees.map(e => {
                      const name = getDisplayName(e);
                      return name ? <option key={e.id} value={name}>{name}{e.role ? ` — ${e.role}` : ''}</option> : null;
                    })}
                  </select>
                ) : (
                  <input aria-label="Reporting supervisor" name="supervisorName" value={formData.supervisorName} onChange={handleChange} required placeholder="Reports to..." className="easy-inp" />
                )}
              </div>
              <div className="easy-field">
                <label className="easy-lbl">Reply deadline</label>
                <input aria-label="Reply deadline" type="date" name="acceptanceDeadline" value={formData.acceptanceDeadline} onChange={handleChange} required className="easy-inp" />
              </div>
              <div className="easy-field full">
                <label className="easy-lbl">Responsibilities</label>
                <textarea aria-label="Responsibilities" name="responsibilities" value={formData.responsibilities} onChange={handleChange} required placeholder="Key responsibilities and goals..." rows="3" className="easy-inp" style={{ resize: 'none' }} />
              </div>
            </div>
          </div>

          {/* 4. Compensation */}
          <div className="easy-section">
            <div className="easy-section-head">
              <div className="easy-num">4</div>
              <span className="easy-section-title">Compensation</span>
            </div>

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

            {formData.isPaid && (
              <div className="easy-row animate-in" style={{ marginTop: '1.25rem' }}>
                <div className="easy-field">
                  <label className="easy-lbl">{formData.offerType === 'internship' ? 'Stipend amount' : formData.offerType === 'collaboration' ? 'Collaboration fee' : 'Salary amount'}</label>
                  <input aria-label={formData.offerType === 'internship' ? 'Stipend amount' : formData.offerType === 'collaboration' ? 'Collaboration fee' : 'Salary amount'} type="number" name="stipend" value={formData.stipend} onChange={handleChange} required placeholder="0.00" className="easy-inp" />
                </div>
                <div className="easy-field">
                  <label className="easy-lbl">Currency & frequency</label>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <select name="currency" value={formData.currency} onChange={handleChange} className="easy-inp" style={{ flex: 1 }}>
                      <option value="INR">INR</option>
                      <option value="USD">USD</option>
                      <option value="EUR">EUR</option>
                    </select>
                    <select name="paymentFrequency" value={formData.paymentFrequency} onChange={handleChange} className="easy-inp" style={{ flex: 1.5 }}>
                      <option value="Monthly">Monthly</option>
                      {formData.offerType === 'fulltime' ? (
                        <option value="Annual">Annual (CTC)</option>
                      ) : formData.offerType === 'collaboration' ? (
                        <>
                          <option value="Once">One-time</option>
                          <option value="Milestone">Milestone</option>
                        </>
                      ) : (
                        <option value="Once">One-time</option>
                      )}
                    </select>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Submit */}
          <button type="submit" className="easy-submit" disabled={isSubmitting || isAtLimit('offerLetters')}>
            {isSubmitting ? 'Generating...' : isAtLimit('offerLetters') ? 'Limit Reached' : 'Finalize & Download'}
            {!isSubmitting && !isAtLimit('offerLetters') && <ChevronRight size={18} />}
          </button>

          {/* Notify Employee */}
          <button
            type="button"
            onClick={handleNotifyEmployee}
            disabled={isSendingEmail || isAtLimit('offerLetters')}
            className="offer-notify-btn"
            style={{ marginTop: '0.75rem' }}
          >
            {isSendingEmail ? <><Loader size={16} className="spin-icon" /> Sending Email...</>
              : emailResult?.success ? <><CheckCircle size={16} /> Sent to {formData.email}</>
                : <><Send size={16} /> Send Offer to Employee</>}
          </button>

          {emailResult && !emailResult.success && (
            <div className="offer-notify-error">
              {emailResult.message}
            </div>
          )}

          {/* Portal Link */}
          <button
            type="button"
            onClick={handleCreatePortalLink}
            disabled={portalLinkLoading}
            className="offer-notify-btn"
            style={{ marginTop: '0.75rem' }}
          >
            {portalLinkLoading
              ? <><Loader size={16} className="spin-icon" /> Creating Link...</>
              : <><ExternalLink size={16} /> Create Recipient Portal Link</>}
          </button>

          {/* Mobile preview */}
          <button type="button" onClick={handlePreview} className="easy-submit-outline mou-mobile-preview-btn" style={{ marginTop: '0.75rem' }}>
            <Eye size={16} /> Preview as PDF
          </button>

        </form>
      </div>

      {/* Portal Link Modal */}
      {showPortalModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border-default)', borderRadius: '1rem', padding: '2rem', maxWidth: '480px', width: '100%' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)' }}>Recipient Portal Link</h3>
              <button type="button" aria-label="Close" title="Close" onClick={() => setShowPortalModal(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: '0.25rem' }}>
                <X size={18} />
              </button>
            </div>
            <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '1rem', lineHeight: 1.6 }}>
              Share this link with <strong style={{ color: 'var(--text-primary)' }}>{formData.studentName}</strong> so they can view and e-sign the offer letter online.
            </p>
            <div style={{ background: 'var(--background)', border: '1px solid var(--border-default)', borderRadius: '0.5rem', padding: '0.75rem 1rem', fontFamily: 'monospace', fontSize: '0.72rem', color: 'var(--text-primary)', wordBreak: 'break-all', marginBottom: '1.25rem', lineHeight: 1.5 }}>
              {portalUrl}
            </div>
            <button onClick={handleCopyPortalLink} className="easy-submit" style={{ margin: 0 }}>
              {portalCopied ? <><CheckCircle size={16} /> Copied!</> : <><Copy size={16} /> Copy Link</>}
            </button>
          </div>
        </div>
      )}

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
