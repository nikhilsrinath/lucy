import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Upload, CheckCircle, Eye } from 'lucide-react';
import { pdfService } from '../services/pdfService';
import { saveLetter, loadLetterDraft } from '../services/letterSave';
import { useToast } from './shared/Toast';
import DocSteps, { Step } from './shared/DocSteps';
import { useAuth } from '../context/AuthContext';
import { useOrg } from '../context/OrgContext';
import { usePlanStatus } from '../hooks/usePlanStatus';
import NdaPreview from './NdaPreview';
import { resolveFormImages, generateStampPng } from '../utils/imageUtils';
import A4Stage from './shared/A4Stage';

export default function NdaForm() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { activeOrg } = useOrg();
  const { currentPlan, planConfig, usage, canCreate, getRemainingCount, getUsagePercent, isAtLimit, refreshUsage } = usePlanStatus();
  const org = activeOrg || {};
  const [formData, setFormData] = useState({
    effectiveDate: '',
    executionCity: '',
    executionState: '',
    companyLogo: org.logo_url || null,
    companyTagline: org.company_tagline || '',
    cin: org.cin || '',
    companyPhone: org.company_phone || '',
    companyEmail: org.company_email || '',
    companyWebsite: org.company_website || '',
    stampType: org.stamp_type || 'generated',
    stampUrl: org.stamp_url || '',
    stampCity: org.stamp_city || '',
    showStamp: true,
    disclosingPartyName: org.company_name || '',
    disclosingPartyIncorporation: 'India',
    disclosingPartyAddress: org.company_address || '',
    receivingPartyName: '',
    receivingPartyIncorporation: 'India',
    receivingPartyAddress: '',
    proposedTransaction: '',
    purposeOfDisclosure: '',
    specificConfidentialItems: '',
    obligationYears: '5',
    nonSolicitationYears: '1',
    arbitrationCity: '',
    arbitrationState: '',
    disclosingSignatoryName: org.owner_full_name || '',
    disclosingSignatoryDesignation: org.document_designation || '',
    disclosingSignatoryDate: '',
    disclosingSignature: org.signature_url || null,
    receivingSignatoryName: '',
    receivingSignatoryDesignation: '',
    receivingSignatoryDate: '',
    receivingSignature: null,
  });

  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleFileUpload = (e, field) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => setFormData(prev => ({ ...prev, [field]: reader.result }));
      reader.readAsDataURL(file);
    }
  };

  const toast = useToast();
  // ?draft=<id>: carrying on from a draft NDA saved on Team.
  const [params] = useSearchParams();
  const draftId = params.get('draft');
  useEffect(() => {
    if (!draftId || !activeOrg?.id) return undefined;
    let cancelled = false;
    loadLetterDraft(draftId, 'nda', activeOrg.id).then((form) => {
      if (cancelled) return;
      if (form) setFormData((prev) => ({ ...prev, ...form }));
      else toast('That draft could not be found, so this is a new NDA.', 'error');
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId, activeOrg?.id]);

  const saveAs = async (status) => {
    if (!draftId && !canCreate('nda')) {
      toast(`You've reached your ${planConfig.name} plan limit of ${planConfig.limits.nda} NDAs. Upgrade to continue.`, 'error');
      return null;
    }
    setIsSubmitting(true);
    try {
      const id = await saveLetter({ kind: 'nda', form: formData, status, draftId, orgId: activeOrg?.id, userId: user?.id });
      await refreshUsage();
      return id;
    } catch (err) {
      console.error(err);
      toast('Could not save the NDA: ' + err.message, 'error');
      return null;
    } finally {
      setIsSubmitting(false);
    }
  };

  // Create: saved once, then opened on Team, where it is sent, linked and downloaded.
  const handleSubmit = async () => {
    const id = await saveAs('pending');
    if (!id) return;
    toast('NDA created', 'success');
    navigate(`/team?letter=${id}`);
  };

  const handleSaveDraft = async () => {
    const id = await saveAs('draft');
    if (!id) return;
    toast('NDA saved as a draft. Open it on Team to carry on.', 'success');
    navigate('/team');
  };

  const handlePreview = async () => {
    const resolved = await resolveFormImages(formData, ['disclosingSignature', 'receivingSignature', 'companyLogo', 'stampUrl']);
    if (resolved.stampType === 'generated') {
      resolved.stampPng = await generateStampPng(resolved.disclosingPartyName, resolved.stampCity);
    }
    await pdfService.generateNda(resolved, true);
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
              border: isAtLimit('nda') ? '1px solid rgba(239,68,68,0.3)' : '1px solid var(--border-subtle)'
            }}>
              <span style={{ fontWeight: 600, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>NDA Documents</span>
              <div style={{ flex: 1, height: '4px', background: 'var(--bg-raised)', borderRadius: '2px', overflow: 'hidden' }}>
                <div style={{
                  height: '100%',
                  borderRadius: '2px',
                  background: isAtLimit('nda') ? 'var(--error)' : getUsagePercent('nda') > 80 ? 'var(--text-primary)' : 'var(--text-secondary)',
                  transition: 'width 0.3s',
                  width: `${Math.min(getUsagePercent('nda'), 100)}%`
                }} />
              </div>
              <span style={{ fontWeight: 700, color: isAtLimit('nda') ? 'var(--error)' : 'var(--text-primary)', whiteSpace: 'nowrap' }}>
                {usage.nda}/{planConfig.limits.nda === Infinity ? '∞' : planConfig.limits.nda}
              </span>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>({getRemainingCount('nda')} remaining)</span>
            </div>
          )}

          {isAtLimit('nda') && (
            <div style={{
              textAlign: 'center',
              padding: '1.5rem',
              background: 'rgba(239,68,68,0.04)',
              border: '1px solid rgba(239,68,68,0.15)',
              borderRadius: '12px',
              marginBottom: '1.5rem'
            }}>
              <div style={{ fontSize: '1.25rem', marginBottom: '0.5rem' }}>⚠️</div>
              <h3 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '0.5rem' }}>NDA Limit Reached</h3>
              <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
                You've used all {planConfig.limits.nda} NDAs in your {planConfig.name} plan.
              </p>
              <a href="mailto:edgeossuite@gmail.com" className="btn-cinematic" style={{ textDecoration: 'none', padding: '0.75rem 1.5rem', fontSize: '0.875rem' }}>
                Upgrade to {currentPlan === 'free' ? 'Pro' : 'Max'}
              </a>
            </div>
          )}

          <DocSteps
            onDraft={handleSaveDraft}
            onCreate={handleSubmit}
            createLabel={isSubmitting ? 'Saving…' : isAtLimit('nda') && !draftId ? 'Limit reached' : 'Create NDA'}
            busy={isSubmitting}
            createDisabled={isAtLimit('nda') && !draftId}
            onPreview={handlePreview}
            finalNote="It opens on Team, where you can email it, copy its signing link or download the PDF."
          >
          <Step title="Agreement">
            <div className="easy-row">
              <div className="easy-field">
                <label className="easy-lbl">Effective date</label>
                <input aria-label="Effective date" type="date" name="effectiveDate" value={formData.effectiveDate} onChange={handleChange} className="easy-inp" required />
              </div>
              <div className="easy-field">
                <label className="easy-lbl">City of execution</label>
                <input aria-label="City of execution" name="executionCity" value={formData.executionCity} onChange={handleChange} placeholder="e.g. Chennai" className="easy-inp" required />
              </div>
              <div className="easy-field">
                <label className="easy-lbl">State</label>
                <input aria-label="State" name="executionState" value={formData.executionState} onChange={handleChange} placeholder="e.g. Tamil Nadu" className="easy-inp" required />
              </div>
            </div>
          </Step>

          <Step title="Disclosing party">
            <div className="easy-row">
              <div className="easy-field full">
                <label className="easy-lbl">Company / entity name</label>
                <input aria-label="Company / entity name" name="disclosingPartyName" value={formData.disclosingPartyName} onChange={handleChange} placeholder="e.g. Acme Technologies Pvt Ltd" className="easy-inp" required />
              </div>
              <div className="easy-field">
                <label className="easy-lbl">Country of incorporation</label>
                <input aria-label="Country of incorporation" name="disclosingPartyIncorporation" value={formData.disclosingPartyIncorporation} onChange={handleChange} placeholder="India" className="easy-inp" required />
              </div>
              <div className="easy-field">
                <label className="easy-lbl">Registered office address</label>
                <textarea aria-label="Registered office address" name="disclosingPartyAddress" value={formData.disclosingPartyAddress} onChange={handleChange} placeholder="Full address with PIN code" rows={2} className="easy-inp" style={{ resize: 'none' }} required />
              </div>
            </div>
          </Step>

          <Step title="Receiving party">
            <div className="easy-row">
              <div className="easy-field full">
                <label className="easy-lbl">Company / entity name</label>
                <input aria-label="Company / entity name" name="receivingPartyName" value={formData.receivingPartyName} onChange={handleChange} placeholder="e.g. Beta Labs Private Limited" className="easy-inp" required />
              </div>
              <div className="easy-field">
                <label className="easy-lbl">Country of incorporation</label>
                <input aria-label="Country of incorporation" name="receivingPartyIncorporation" value={formData.receivingPartyIncorporation} onChange={handleChange} placeholder="India" className="easy-inp" required />
              </div>
              <div className="easy-field">
                <label className="easy-lbl">Registered office address</label>
                <textarea aria-label="Registered office address" name="receivingPartyAddress" value={formData.receivingPartyAddress} onChange={handleChange} placeholder="Full address with PIN code" rows={2} className="easy-inp" style={{ resize: 'none' }} required />
              </div>
            </div>
          </Step>

          <Step title="Purpose">
            <div className="easy-row">
              <div className="easy-field full">
                <label className="easy-lbl">Proposed transaction</label>
                <textarea aria-label="Proposed transaction" name="proposedTransaction" value={formData.proposedTransaction} onChange={handleChange}
                  placeholder="e.g. proposes to provide [Receiving Party Name] with a sample unit of its product for evaluation..."
                  rows={3} className="easy-inp" style={{ resize: 'none' }} required />
              </div>
              <div className="easy-field full">
                <label className="easy-lbl">Purpose of disclosure</label>
                <textarea aria-label="Purpose of disclosure" name="purposeOfDisclosure" value={formData.purposeOfDisclosure} onChange={handleChange}
                  placeholder="e.g. sharing confidential information solely to enable evaluation..."
                  rows={3} className="easy-inp" style={{ resize: 'none' }} required />
              </div>
            </div>
          </Step>

          <Step title="What stays confidential">
            <div className="easy-field">
              <label className="easy-lbl">Enter each item on a new line</label>
              <textarea aria-label="Enter each item on a new line" name="specificConfidentialItems" value={formData.specificConfidentialItems} onChange={handleChange}
                placeholder={"e.g.\nThe physical product sample provided for evaluation\nProprietary hardware architecture and board design\nInternal circuit design concepts\nFirmware behavior and system functionality\nTechnical documentation and user guides\nCommercial pricing and business discussions"}
                rows={6} className="easy-inp" style={{ resize: 'vertical', lineHeight: '1.6' }} required />
            </div>
          </Step>

          <Step title="Terms">
            <div className="easy-row">
              <div className="easy-field">
                <label className="easy-lbl">Confidentiality obligation (years)</label>
                <select aria-label="Confidentiality obligation (years)" name="obligationYears" value={formData.obligationYears} onChange={handleChange} className="easy-inp">
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => <option key={n} value={n}>{n} {n === 1 ? 'Year' : 'Years'}</option>)}
                </select>
              </div>
              <div className="easy-field">
                <label className="easy-lbl">Non-solicitation period (years)</label>
                <select aria-label="Non-solicitation period (years)" name="nonSolicitationYears" value={formData.nonSolicitationYears} onChange={handleChange} className="easy-inp">
                  {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n} {n === 1 ? 'Year' : 'Years'}</option>)}
                </select>
              </div>
            </div>
            <div className="easy-party-label sb-sub">If there is a dispute</div>
            <div className="easy-row">
              <div className="easy-field">
                <label className="easy-lbl">Arbitration city</label>
                <input aria-label="Arbitration city" name="arbitrationCity" value={formData.arbitrationCity} onChange={handleChange} placeholder="e.g. Chennai" className="easy-inp" required />
              </div>
              <div className="easy-field">
                <label className="easy-lbl">Arbitration state</label>
                <input aria-label="Arbitration state" name="arbitrationState" value={formData.arbitrationState} onChange={handleChange} placeholder="e.g. Tamil Nadu" className="easy-inp" required />
              </div>
            </div>
          </Step>

          <Step title="Disclosing party signs">

            <div className="easy-row">
              <div className="easy-field">
                <label className="easy-lbl">Name</label>
                <input aria-label="Name" name="disclosingSignatoryName" value={formData.disclosingSignatoryName} onChange={handleChange} placeholder="Full name" className="easy-inp" required />
              </div>
              <div className="easy-field">
                <label className="easy-lbl">Designation</label>
                <input aria-label="Designation" name="disclosingSignatoryDesignation" value={formData.disclosingSignatoryDesignation} onChange={handleChange} placeholder="e.g. CEO / Director" className="easy-inp" required />
              </div>
              <div className="easy-field">
                <label className="easy-lbl">Signing date</label>
                <input aria-label="Signing date" type="date" name="disclosingSignatoryDate" value={formData.disclosingSignatoryDate} onChange={handleChange} className="easy-inp" required />
              </div>
              <div className="easy-field">
                <label className="easy-lbl">Signature</label>
                <div className="easy-upload-wrap">
                  <input aria-label="Signature" type="file" onChange={(e) => handleFileUpload(e, 'disclosingSignature')} accept="image/*" />
                  <div className={`easy-upload ${formData.disclosingSignature ? 'done' : ''}`}>
                    {formData.disclosingSignature ? <><CheckCircle size={16} /> Uploaded</> : <><Upload size={16} /> Upload signature</>}
                  </div>
                </div>
                {formData.disclosingSignature && <img src={formData.disclosingSignature} alt="Signature" className="sb-sig" />}
              </div>
            </div>

          </Step>

          <Step title="Receiving party signs">


            <div className="easy-row">
              <div className="easy-field">
                <label className="easy-lbl">Name</label>
                <input aria-label="Name" name="receivingSignatoryName" value={formData.receivingSignatoryName} onChange={handleChange} placeholder="Full name" className="easy-inp" required />
              </div>
              <div className="easy-field">
                <label className="easy-lbl">Designation</label>
                <input aria-label="Designation" name="receivingSignatoryDesignation" value={formData.receivingSignatoryDesignation} onChange={handleChange} placeholder="e.g. CEO / Director" className="easy-inp" required />
              </div>
              <div className="easy-field">
                <label className="easy-lbl">Signing date</label>
                <input aria-label="Signing date" type="date" name="receivingSignatoryDate" value={formData.receivingSignatoryDate} onChange={handleChange} className="easy-inp" required />
              </div>
              <div className="easy-field">
                <label className="easy-lbl">Signature</label>
                <div className="easy-upload-wrap">
                  <input aria-label="Signature" type="file" onChange={(e) => handleFileUpload(e, 'receivingSignature')} accept="image/*" />
                  <div className={`easy-upload ${formData.receivingSignature ? 'done' : ''}`}>
                    {formData.receivingSignature ? <><CheckCircle size={16} /> Uploaded</> : <><Upload size={16} /> Upload signature</>}
                  </div>
                </div>
                {formData.receivingSignature && <img src={formData.receivingSignature} alt="Signature" className="sb-sig" />}
              </div>
              <div className="easy-field full">
                <button
                  type="button" role="switch" aria-checked={!!formData.showStamp}
                  className={`easy-switch-row ${formData.showStamp ? 'active' : ''}`}
                  onClick={() => handleChange({ target: { name: 'showStamp', checked: !formData.showStamp, type: 'checkbox' } })}
                >
                  <span className="easy-switch-label">Include company stamp</span>
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
          <span className="mou-preview-toolbar-label">
            Live Preview
          </span>
          <button type="button" onClick={handlePreview} className="easy-submit-outline" style={{ padding: '0.375rem 0.875rem', fontSize: '0.75rem', width: 'auto' }}>
            <Eye size={14} /> Open PDF
          </button>
        </div>
        <A4Stage>
          <NdaPreview formData={formData} />
        </A4Stage>
      </div>

    </div>
  );
}
