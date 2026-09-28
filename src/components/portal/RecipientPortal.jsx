import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Download, Check, X, ShieldCheck, Building2, FileText, CheckCircle2,
  AlertCircle, Calendar, Clock, Lock, User, ZoomIn, ZoomOut,
  Copy, CreditCard, Banknote, MessageSquare, ExternalLink, Shield,
  Sparkles, ArrowRight, Eye, Hash, Mail
} from 'lucide-react';
import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';
import {
  fetchPortalDocument, submitPortalAction, portalTokenFromUrl,
} from '../../services/portalService';
import SignatureCapture from '../shared/SignatureCapture';
import UPIQRGenerator from '../shared/UPIQRGenerator';
import PaymentConfirmationForm from '../shared/PaymentConfirmationForm';
import DocumentStatusBadge from '../shared/DocumentStatusBadge';
import { advanceOf } from '../../services/proformaAdvance';

const fadeUp = {
  initial: { opacity: 0, y: 20 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1] },
};

const stagger = {
  animate: { transition: { staggerChildren: 0.08 } },
};

function fmtSignedAt(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleString('en-IN'); } catch { return String(d); }
}

function fmtOfferDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }); }
  catch { return d; }
}

function formatDocType(type) {
  const map = {
    offer_letter: 'Offer Letter',
    mou: 'Memorandum of Understanding',
    nda: 'Non-Disclosure Agreement',
    invoice: 'Tax Invoice',
    quotation: 'Quotation',
    proforma: 'Proforma Invoice',
    role_change: 'Role Change Notice',
    termination: 'Termination Notice',
  };
  return map[type] || type?.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) || 'Document';
}

function DetailRow({ label, value, highlight, isRed }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '0.5rem 0.75rem', borderRadius: 8,
      background: highlight ? (isRed ? 'rgba(239,68,68,0.08)' : 'rgba(99,102,241,0.08)') : 'rgba(255,255,255,0.04)',
      border: `1px solid ${highlight ? (isRed ? 'rgba(239,68,68,0.2)' : 'rgba(99,102,241,0.2)') : 'rgba(255,255,255,0.06)'}`,
      gap: '0.75rem',
    }}>
      <span style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.4)', fontWeight: 500 }}>{label}</span>
      <span style={{ fontSize: '0.8rem', fontWeight: 700, color: highlight ? (isRed ? '#f87171' : '#a5b4fc') : 'rgba(255,255,255,0.8)', textAlign: 'right' }}>{value}</span>
    </div>
  );
}

export default function RecipientPortal({ documentId }) {
  const [loading, setLoading] = useState(true);
  const [docData, setDocData] = useState(null);
  const [status, setStatus] = useState('pending');
  const [zoom, setZoom] = useState(100);
  const [signature, setSignature] = useState(null);
  const [signatureMethod, setSignatureMethod] = useState(null);
  const [agreed, setAgreed] = useState(false);
  const [showDeclineModal, setShowDeclineModal] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const [showBankDetails, setShowBankDetails] = useState(false);
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [paymentSubmitted, setPaymentSubmitted] = useState(false);
  const [revisionText, setRevisionText] = useState('');
  const [showRevisionModal, setShowRevisionModal] = useState(false);
  const [orderConfirmed, setOrderConfirmed] = useState(false);
  const [candidateName, setCandidateName] = useState('');
  const [candidateDesignation, setCandidateDesignation] = useState('');
  const [candidateDate, setCandidateDate] = useState(new Date().toISOString().split('T')[0]);
  const [partyBSignature, setPartyBSignature] = useState(null);
  const [partyBAgreed, setPartyBAgreed] = useState(false);
  const [copied, setCopied] = useState('');
  const [downloading, setDownloading] = useState(false);
  // The live company profile now arrives with the document from /api/portal —
  // the recipient has no database access to look it up with.
  const [company, setCompany] = useState({});
  const [portalError, setPortalError] = useState('');
  const [actionError, setActionError] = useState('');
  const [submitting, setSubmitting] = useState(null);
  const [readOnly, setReadOnly] = useState(false);
  const a4Ref = useRef(null);

  useEffect(() => {
    let cancelled = false;

    const loadDocument = async () => {
      const token = portalTokenFromUrl();
      if (!token) {
        // Links issued before portal tokens existed carried only ?org= and a
        // random string; they no longer open anything.
        if (!cancelled) { setPortalError('This link is missing its access token. Ask the sender for a new one.'); setLoading(false); }
        return;
      }

      try {
        const { document: loaded, company: liveCompany, scope } = await fetchPortalDocument(token);
        if (cancelled) return;
        // Normalize once, at the boundary:
        //  • the database stores offers as 'offer'; this screen keys everything
        //    off 'offer_letter';
        //  • documents saved from the form pages keep the recipient inside
        //    `data` (studentName), so `issued_to` can be empty on older rows —
        //    without this the letter is addressed to nobody.
        setDocData({
          ...loaded,
          type: loaded.type === 'offer' ? 'offer_letter' : loaded.type,
          issued_to: loaded.issued_to || loaded.studentName || loaded.recipientName || loaded.name || '',
        });
        setCompany(liveCompany);
        setReadOnly(scope !== 'sign');
        setStatus(loaded.status);
        setOrderConfirmed(loaded.status === 'order_confirmed');
        const recipient = loaded.issued_to || loaded.studentName || loaded.recipientName || loaded.name;
        if (recipient) setCandidateName(recipient);
      } catch (err) {
        if (!cancelled) setPortalError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    // Small delay for loading animation
    const timer = setTimeout(loadDocument, 1200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [documentId]);

  /**
   * Every response goes through the same server call: the recipient names an
   * action, not a status, and /api/portal decides what that action is allowed
   * to write.
   */
  const respond = async (action, payload, nextStatus) => {
    if (submitting) return false;
    setSubmitting(action);
    setActionError('');
    try {
      await submitPortalAction(portalTokenFromUrl(), action, payload);
      setStatus(nextStatus);
      return true;
    } catch (err) {
      setActionError(err.message);
      return false;
    } finally {
      setSubmitting(null);
    }
  };

  // ── Handlers ──
  //
  // The status each one lands on is decided by the server; the second argument
  // here only keeps the local UI in step with what the server will have written.
  const handleAcceptOffer = async () => {
    if (!signature || !agreed) return;
    await respond('accept_offer', {
      signature,
      signature_method: signatureMethod,
      name: candidateName,
    }, 'signed');
  };

  const handleDecline = async () => {
    const ok = await respond('decline', { reason: declineReason }, 'declined');
    if (ok) setShowDeclineModal(false);
  };

  const handleMoUSign = async () => {
    if (!partyBSignature || !partyBAgreed) return;
    await respond('mou_sign', {
      signature: partyBSignature,
      signature_method: signatureMethod,
      name: candidateName || docData.party_b?.representative,
      designation: candidateDesignation || docData.party_b?.designation,
    }, 'fully_signed');
  };

  const handlePaymentConfirmation = async (data) => {
    const ok = await respond('payment_confirmation', { payment: data }, 'payment_submitted');
    if (ok) setPaymentSubmitted(true);
  };

  const handleAcceptQuotation = async () => {
    if (!signature || !agreed) return;
    await respond('accept_quotation', {
      signature,
      signature_method: signatureMethod,
      name: candidateName,
    }, 'accepted');
  };

  const handleRevisionRequest = async () => {
    const ok = await respond('request_revision', { notes: revisionText }, 'revision_requested');
    if (ok) setShowRevisionModal(false);
  };

  const handleConfirmOrder = async () => {
    const ok = await respond('confirm_order', {}, 'order_confirmed');
    if (ok) setOrderConfirmed(true);
  };

  const handleProformaPayment = async (data) => {
    const ok = await respond('proforma_payment', { payment: data }, 'payment_submitted');
    if (ok) setPaymentSubmitted(true);
  };
  const handleCopy = async (text, label) => {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(''), 2000);
  };

  const handleDownloadPDF = async () => {
    if (!a4Ref.current || downloading) return;
    setDownloading(true);
    const element = a4Ref.current;

    // Save original styles
    const origTransform = element.style.transform;
    const origWidth = element.style.width;
    const origMinWidth = element.style.minWidth;
    const origMaxWidth = element.style.maxWidth;
    const origPosition = element.style.position;
    const origLeft = element.style.left;

    // Force a fixed A4-like width and reset zoom so the capture matches the preview exactly
    const captureWidth = 794; // 210mm at 96dpi
    element.style.transform = 'none';
    element.style.width = captureWidth + 'px';
    element.style.minWidth = captureWidth + 'px';
    element.style.maxWidth = captureWidth + 'px';
    element.style.position = 'absolute';
    element.style.left = '-9999px';

    // Fix logo dimensions explicitly before capture so html2canvas gets correct aspect ratio
    const logoImg = element.querySelector('.rp-letterhead-logo');
    const origLogoStyle = logoImg ? { w: logoImg.style.width, h: logoImg.style.height, of: logoImg.style.objectFit } : null;
    if (logoImg && logoImg.naturalWidth && logoImg.naturalHeight) {
      const ratio = logoImg.naturalWidth / logoImg.naturalHeight;
      const maxH = 56;
      const maxW = 140;
      let w = maxH * ratio;
      let h = maxH;
      if (w > maxW) { w = maxW; h = maxW / ratio; }
      logoImg.style.width = Math.round(w) + 'px';
      logoImg.style.height = Math.round(h) + 'px';
      logoImg.style.objectFit = 'none';
    }

    // Collect Y positions of keep-together sections (relative to element top, in CSS px)
    const keepTogetherSections = [];
    element.querySelectorAll('.rp-doc-signoff-block, .rp-doc-sig-section').forEach((sec) => {
      const elRect = element.getBoundingClientRect();
      const secRect = sec.getBoundingClientRect();
      keepTogetherSections.push({
        top: secRect.top - elRect.top,
        bottom: secRect.bottom - elRect.top,
      });
    });

    // Let browser reflow
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    try {
      const canvas = await html2canvas(element, {
        scale: 2,
        useCORS: true,
        allowTaint: true,
        backgroundColor: '#fff',
        width: captureWidth,
        windowWidth: captureWidth,
      });
      const pdf = new jsPDF('p', 'mm', 'a4');
      const pdfW = pdf.internal.pageSize.getWidth();
      const pdfH = pdf.internal.pageSize.getHeight();
      const imgAspect = canvas.height / canvas.width;
      const totalH = pdfW * imgAspect;
      const scaleFactor = canvas.width / captureWidth; // css-px to canvas-px

      if (totalH <= pdfH) {
        const imgData = canvas.toDataURL('image/png');
        pdf.addImage(imgData, 'PNG', 0, 0, pdfW, totalH);
      } else {
        const pageCanvasH = Math.floor(canvas.width * (pdfH / pdfW));

        // Convert keep-together sections from CSS px to canvas px
        const protectedRanges = keepTogetherSections.map((s) => ({
          top: Math.floor(s.top * scaleFactor),
          bottom: Math.ceil(s.bottom * scaleFactor),
        }));

        // Check if a break point falls inside a protected section
        const getAdjustedBreak = (targetY) => {
          for (const range of protectedRanges) {
            if (targetY > range.top && targetY < range.bottom) {
              // Break would split this section — move break to just before it
              return Math.max(0, range.top - Math.floor(4 * scaleFactor));
            }
          }
          return targetY;
        };

        // Find the best blank row near a target Y
        const ctx0 = canvas.getContext('2d', { willReadFrequently: true });
        const findBlankRow = (targetY) => {
          const scanRange = Math.floor(pageCanvasH * 0.06);
          const lo = Math.max(0, targetY - scanRange);
          const hi = Math.min(canvas.height, targetY + Math.floor(scanRange * 0.3));
          let bestY = targetY;
          let bestScore = -1;
          for (let row = lo; row < hi; row++) {
            const rowData = ctx0.getImageData(0, row, canvas.width, 1).data;
            let whitePixels = 0;
            for (let i = 0; i < rowData.length; i += 4) {
              if (rowData[i] > 240 && rowData[i + 1] > 240 && rowData[i + 2] > 240) whitePixels++;
            }
            const score = whitePixels / canvas.width;
            if (score > bestScore) { bestScore = score; bestY = row; }
            if (score >= 0.99) break;
          }
          return bestY;
        };

        // Build break points: first check protected sections, then find blank rows
        const breaks = [0];
        let cursor = 0;
        while (cursor + pageCanvasH < canvas.height) {
          let raw = cursor + pageCanvasH;
          raw = getAdjustedBreak(raw); // avoid splitting keep-together sections
          const bp = findBlankRow(raw);
          if (bp <= cursor) break; // safety
          breaks.push(bp);
          cursor = bp;
        }
        breaks.push(canvas.height);

        for (let p = 0; p < breaks.length - 1; p++) {
          const sliceTop = breaks[p];
          const sliceH = breaks[p + 1] - sliceTop;
          const pageCanvas = document.createElement('canvas');
          pageCanvas.width = canvas.width;
          pageCanvas.height = sliceH;
          const ctx = pageCanvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, sliceH);
          ctx.drawImage(canvas, 0, -sliceTop);
          const pageImg = pageCanvas.toDataURL('image/png');
          if (p > 0) pdf.addPage();
          pdf.addImage(pageImg, 'PNG', 0, 0, pdfW, (sliceH / canvas.width) * pdfW);
        }
      }
      const clientName = (docData.issued_to || docData.client?.name || 'Client').replace(/\s+/g, '_');
      pdf.save(`${formatDocType(docData.type).replace(/\s+/g, '_')}_${docData.id}_${clientName}.pdf`);
    } catch (err) {
      console.error('PDF generation failed:', err);
    } finally {
      // Restore logo styles
      if (logoImg && origLogoStyle) {
        logoImg.style.width = origLogoStyle.w;
        logoImg.style.height = origLogoStyle.h;
        logoImg.style.objectFit = origLogoStyle.of;
      }
      // Restore all original styles
      element.style.transform = origTransform;
      element.style.width = origWidth;
      element.style.minWidth = origMinWidth;
      element.style.maxWidth = origMaxWidth;
      element.style.position = origPosition;
      element.style.left = origLeft;
      setDownloading(false);
    }
  };

  // ── Loading ──
  if (loading) {
    return (
      <div className="rp-loading">
        <div className="rp-loading-inner">
          <div className="rp-loading-spinner" />
          <div className="rp-loading-text">
            <Shield size={14} />
            <span>Establishing secure connection...</span>
          </div>
        </div>
        <footer className="rp-footer">
          <div className="rp-footer-inner">
            <div className="rp-footer-brand"><Shield size={13} /><span>Powered by <strong>StartupBuddy</strong></span></div>
            <p className="rp-footer-tagline">Secure document management for businesses</p>
          </div>
        </footer>
      </div>
    );
  }

  // ── Not Found ──
  if (!docData) {
    return (
      <div className="rp-loading">
        <div className="rp-loading-inner">
          <div className="rp-notfound-icon"><AlertCircle size={32} /></div>
          <h2>Document Unavailable</h2>
          <p>{portalError || 'This link may have expired or the document ID is invalid.'}</p>
        </div>
        <footer className="rp-footer">
          <div className="rp-footer-inner">
            <div className="rp-footer-brand"><Shield size={13} /><span>Powered by <strong>StartupBuddy</strong></span></div>
            <p className="rp-footer-tagline">Secure document management for businesses</p>
          </div>
        </footer>
      </div>
    );
  }

  // A cancelled quotation, proforma or invoice is shown, marked, with nothing to
  // act on. The server refuses every action on it anyway (api/portal.js).
  const isCancelled = status === 'cancelled' && ['invoice', 'quotation', 'proforma'].includes(docData?.type);
  const isActionTaken = ['signed', 'declined', 'paid', 'payment_submitted', 'accepted', 'fully_signed', 'advance_paid', 'revision_requested', 'acknowledged'].includes(status);

  // ── HR Notice acknowledge (role_change / termination) ──
  //
  // The employee-record change that follows an acknowledgement is applied by
  // /api/portal under the service role. It used to be written from here
  // straight into RTDB and Firestore, which meant the recipient's browser held
  // write access to the employee table.
  const handleAcknowledge = async () => {
    if (!signature || !agreed) return;
    await respond('acknowledge', {
      signature,
      signature_method: signatureMethod,
      name: candidateName || docData.issued_to,
    }, 'acknowledged');
  };

  // ── Render ──
  return (
    <div className="rp-page">
      {/* A rejected response has to be visible: the recipient has no other
          way to learn that their acceptance was not recorded. */}
      {actionError && (
        <div className="rp-action-error" role="alert" style={{
          position: 'sticky', top: 0, zIndex: 60,
          display: 'flex', alignItems: 'center', gap: '0.5rem',
          padding: '0.75rem 1rem', background: 'rgba(239,68,68,0.12)',
          borderBottom: '1px solid rgba(239,68,68,0.35)', color: '#fca5a5',
          fontSize: '0.8125rem', fontWeight: 500,
        }}>
          <AlertCircle size={15} />
          <span>{actionError}</span>
        </div>
      )}

      {/* ── Top Navigation ── */}
      <header className="rp-header">
        <div className="rp-header-inner">
          <div className="rp-header-left">
            {company.logo_url ? (
              <img src={company.logo_url} alt="" className="rp-header-logo" />
            ) : (
              <div className="rp-header-logo-placeholder">
                <Building2 size={18} />
              </div>
            )}
            <div className="rp-header-brand">
              <h1>{company.company_name || docData.issued_by || 'Company'}</h1>
              <span>Secure Document Portal</span>
            </div>
          </div>
          <div className="rp-header-right">
            <div className="rp-header-doctype">{formatDocType(docData.type)}</div>
            <DocumentStatusBadge status={status} />
          </div>
        </div>
      </header>

      {/* ── Security Bar ── */}
      <div className="rp-security-bar">
        <div className="rp-security-inner">
          <Lock size={11} />
          <span>End-to-end encrypted</span>
          <span className="rp-security-sep">|</span>
          <span>Document ID: {docData.id}</span>
          <span className="rp-security-sep">|</span>
          <span>Powered by StartupBuddy</span>
        </div>
      </div>

      {/* ── Main Content ── */}
      <div className="rp-main">
        <motion.div className="rp-layout" initial="initial" animate="animate" variants={stagger}>

          {/* Left: Document Viewer */}
          <motion.div className="rp-viewer" variants={fadeUp}>
            {/* Document Info Card */}
            <div className="rp-doc-info-card">
              <div className="rp-doc-info-grid">
                <div className="rp-doc-info-item">
                  <FileText size={14} />
                  <div>
                    <span className="rp-doc-info-label">Document</span>
                    <span className="rp-doc-info-value">{docData.title || formatDocType(docData.type)}</span>
                  </div>
                </div>
                <div className="rp-doc-info-item">
                  <User size={14} />
                  <div>
                    <span className="rp-doc-info-label">Recipient</span>
                    <span className="rp-doc-info-value">{docData.issued_to || docData.party_b?.company || 'Recipient'}</span>
                  </div>
                </div>
                <div className="rp-doc-info-item">
                  <Calendar size={14} />
                  <div>
                    <span className="rp-doc-info-label">Issued</span>
                    <span className="rp-doc-info-value">{docData.issue_date || '-'}</span>
                  </div>
                </div>
                <div className="rp-doc-info-item">
                  <Clock size={14} />
                  <div>
                    <span className="rp-doc-info-label">
                      {docData.type === 'quotation' ? 'Valid Until' : docData.type === 'offer_letter' ? 'Respond By' : docData.type === 'role_change' ? 'Effective Date' : docData.type === 'termination' ? 'Last Working Day' : 'Due Date'}
                    </span>
                    <span className="rp-doc-info-value">{docData.valid_until || docData.due_date || docData.effective_date || docData.last_day || '-'}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Zoom Controls */}
            <div className="rp-zoom-bar">
              <button onClick={() => setZoom(Math.max(50, zoom - 10))}><ZoomOut size={14} /></button>
              <span>{zoom}%</span>
              <button onClick={() => setZoom(Math.min(150, zoom + 10))}><ZoomIn size={14} /></button>
              <button onClick={() => setZoom(100)} className="rp-zoom-reset">Reset</button>
              {['quotation', 'proforma', 'invoice', 'offer_letter', 'role_change', 'termination'].includes(docData.type) && (
                <button className="rp-download-pdf-btn" onClick={handleDownloadPDF} disabled={downloading}>
                  <Download size={13} /> {downloading ? 'Generating...' : 'Download PDF'}
                </button>
              )}
            </div>

            {/* A4 Document Preview */}
            <div className="rp-a4-wrapper">
              <div ref={a4Ref} className="rp-a4" style={{ transform: `scale(${zoom / 100})`, transformOrigin: 'top center' }}>
                {isCancelled
                  ? <div className="rp-watermark" style={{ color: 'rgba(239,68,68,0.16)' }}>CANCELLED</div>
                  : !isActionTaken && <div className="rp-watermark">PREVIEW</div>}

                <div className="rp-doc-content">
                  {/* Letterhead */}
                  <div className="rp-letterhead">
                    {company.logo_url && <img src={company.logo_url} alt="" className="rp-letterhead-logo" crossOrigin="anonymous" />}
                    <div className="rp-letterhead-text">
                      <h2>{company.company_name || docData.issued_by}</h2>
                      {(company.company_address || company.address) && <p>{company.company_address || company.address}</p>}
                      <p>
                        {[company.company_email || company.email, company.company_phone || company.phone].filter(Boolean).join(' | ')}
                      </p>
                      {company.gstin && <p className="rp-letterhead-gstin">GSTIN: {company.gstin}</p>}
                    </div>
                  </div>

                  <div className="rp-doc-rule" />

                  {/* ── Offer Letter ── */}
                  {docData.type === 'offer_letter' && (() => {
                    const isFT = docData.offer_type === 'fulltime';
                    const isCollab = docData.offer_type === 'collaboration';
                    const currSym = { INR: '₹', USD: '$', EUR: '€', GBP: '£' }[docData.currency] || (docData.currency || '₹');
                    const detailRows = [
                      ['Position', docData.role],
                      ['Type', isFT ? 'Full-Time Employment' : isCollab ? 'Collaboration Agreement' : 'Internship'],
                      docData.department && ['Department', docData.department],
                      docData.supervisor && ['Reporting To', docData.supervisor],
                      docData.start_date && ['Start Date', fmtOfferDate(docData.start_date)],
                      (!isFT || isCollab) && docData.end_date && ['End Date', fmtOfferDate(docData.end_date)],
                      docData.is_paid && docData.salary && ['Compensation', `${currSym} ${Number(docData.salary).toLocaleString('en-IN')} / ${(docData.payment_frequency || 'Monthly').toLowerCase()}`],
                      docData.valid_until && ['Respond By', fmtOfferDate(docData.valid_until)],
                    ].filter(Boolean);

                    return (
                      <div className="rp-doc-body">
                        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '0.75em', gap: '0.5em' }}>
                          <h3 className="rp-doc-title" style={{ margin: 0 }}>{isCollab ? 'COLLABORATION AGREEMENT' : isFT ? 'OFFER OF EMPLOYMENT' : 'INTERNSHIP OFFER LETTER'}</h3>
                          <span style={{ flexShrink: 0, display: 'inline-block', background: isCollab ? '#0d9488' : isFT ? '#059669' : '#2563eb', color: '#fff', fontSize: '8pt', fontWeight: 700, padding: '3px 12px', borderRadius: '20px', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                            {isCollab ? 'Collaboration' : isFT ? 'Full-Time' : 'Internship'}
                          </span>
                        </div>
                        <p style={{ fontSize: '9pt', color: '#6b7280', margin: '0 0 0.5em' }}>Date: {fmtOfferDate(docData.issue_date)}</p>
                        <p style={{ margin: '0 0 0.1em', fontSize: '10pt' }}><strong>To, {docData.issued_to}</strong></p>
                        <p style={{ fontSize: '10pt', lineHeight: 1.6, color: '#374151', margin: '0.6em 0 0.5em' }}>
                          Dear <strong>{docData.issued_to}</strong>,{' '}
                          {isCollab
                            ? <>We are pleased to invite you as a Collaborator for the role of <strong>{docData.role}</strong> at <strong>{company.company_name || docData.issued_by}</strong>. This collaboration does not constitute an employer-employee relationship.</>
                            : <>We are delighted to extend this {isFT ? 'offer of full-time employment' : 'internship offer'} for the role of <strong>{docData.role}</strong> at <strong>{company.company_name || docData.issued_by}</strong>.</>
                          }
                        </p>

                        <table className="rp-doc-table" style={{ marginBottom: '0.75em' }}>
                          <thead>
                            <tr><th colSpan={2} style={{ textAlign: 'left', padding: '0.4em 0.75em' }}>Offer Details</th></tr>
                          </thead>
                          <tbody>
                            {detailRows.map(([label, value]) => (
                              <tr key={label}>
                                <td style={{ width: '38%', color: '#6b7280', fontWeight: 500, padding: '0.3em 0.75em' }}>{label}</td>
                                <td style={{ fontWeight: 600, padding: '0.3em 0.75em' }}>{value}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>

                        {docData.responsibilities && (
                          <div style={{ marginBottom: '0.5em' }}>
                            <p style={{ fontWeight: 700, textTransform: 'uppercase', fontSize: '7.5pt', letterSpacing: '0.06em', color: '#374151', marginBottom: '0.25em' }}>Key Responsibilities</p>
                            <p style={{ fontSize: '9pt', lineHeight: 1.5, whiteSpace: 'pre-line', color: '#374151', margin: 0 }}>{docData.responsibilities}</p>
                          </div>
                        )}

                        {docData.valid_until && (
                          <p style={{ fontSize: '9pt', lineHeight: 1.5, color: '#374151', margin: '0.5em 0' }}>
                            Please confirm your acceptance by <strong>{fmtOfferDate(docData.valid_until)}</strong>.
                          </p>
                        )}

                        {/* Compact sign-off with inline signature grid */}
                        <div style={{ borderTop: '1px solid #e4e4e7', marginTop: '1em', paddingTop: '0.75em' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1.5em' }}>
                            {/* Authorized signatory */}
                            <div style={{ flex: 1 }}>
                              <p style={{ fontSize: '9pt', color: '#374151', margin: '0 0 0.15em' }}>Sincerely,</p>
                              {company.signature_url && <img src={company.signature_url} alt="Signature" className="rp-doc-sig-img" style={{ maxHeight: '36px', margin: '0.25em 0' }} />}
                              <p style={{ fontSize: '9pt', fontWeight: 700, color: '#1a1a2e', margin: '0.15em 0 0' }}>{company.authorized_person || company.company_name || docData.issued_by}</p>
                              {company.authorized_designation && <p style={{ fontSize: '8pt', color: '#6b7280', margin: 0 }}>{company.authorized_designation}</p>}
                              <p style={{ fontSize: '8pt', color: '#6b7280', margin: 0 }}>{company.company_name || docData.issued_by}</p>
                            </div>
                            {/* Candidate acceptance */}
                            <div style={{ flex: 1, borderLeft: '1px solid #e4e4e7', paddingLeft: '1.5em' }}>
                              <p style={{ fontSize: '8pt', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#374151', margin: '0 0 0.3em' }}>Acceptance</p>
                              {status === 'signed' && signature ? (
                                <>
                                  <img src={signature} alt="Candidate Signature" className="rp-doc-sig-img" style={{ maxHeight: '36px', margin: '0.25em 0' }} />
                                  <p style={{ fontSize: '8pt', color: '#374151', margin: '0.1em 0' }}>{candidateName || docData.issued_to}</p>
                                  <p style={{ fontSize: '8pt', color: '#6b7280', margin: 0 }}>{new Date().toLocaleDateString()}</p>
                                </>
                              ) : (
                                <>
                                  <p style={{ fontSize: '8pt', color: '#6b7280', margin: '0.2em 0' }}>Name: ____________________</p>
                                  <p style={{ fontSize: '8pt', color: '#6b7280', margin: '0.2em 0' }}>Date: ____________________</p>
                                  <div style={{ borderBottom: '1px solid #d1d5db', width: '140px', marginTop: '0.75em', paddingTop: '1em' }} />
                                  <p style={{ fontSize: '7pt', color: '#9ca3af', margin: '0.15em 0 0' }}>Signature</p>
                                </>
                              )}
                            </div>
                          </div>
                        </div>

                        <p style={{ textAlign: 'center', color: '#9ca3af', fontSize: '6.5pt', marginTop: '0.75em', marginBottom: 0 }}>
                          I, {docData.issued_to}, hereby accept the terms and conditions of this {isCollab ? 'collaboration agreement' : isFT ? 'offer of employment' : 'internship offer'}.
                        </p>
                      </div>
                    );
                  })()}

                  {/* ── Role Change Notice ── */}
                  {docData.type === 'role_change' && (
                    <div className="rp-doc-body">
                      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '1em', gap: '0.5em' }}>
                        <h3 className="rp-doc-title" style={{ margin: 0 }}>ROLE CHANGE NOTICE</h3>
                        <span style={{ flexShrink: 0, display: 'inline-block', background: '#4f46e5', color: '#fff', fontSize: '8pt', fontWeight: 700, padding: '3px 12px', borderRadius: '20px', letterSpacing: '0.04em', textTransform: 'uppercase' }}>Internal</span>
                      </div>
                      <p className="rp-doc-date">Date: {fmtOfferDate(docData.issue_date)}</p>
                      <p><strong>To,</strong></p>
                      <p><strong>{docData.issued_to}</strong></p>
                      {(docData.current_role || docData.current_department) && (
                        <p style={{ fontSize: '10pt', color: '#6b7280', marginTop: '-0.5em' }}>{[docData.current_role, docData.current_department].filter(Boolean).join(', ')}</p>
                      )}
                      <p className="rp-doc-para">Dear <strong>{docData.issued_to}</strong>,</p>
                      <p className="rp-doc-para">
                        We are pleased to inform you that, effective <strong>{fmtOfferDate(docData.effective_date)}</strong>, your role at <strong>{company.company_name || 'the company'}</strong> will be updated as detailed below.
                      </p>
                      <table className="rp-doc-table" style={{ marginBottom: '1.5em' }}>
                        <thead><tr><th colSpan={2} style={{ textAlign: 'left' }}>Role Change Details</th></tr></thead>
                        <tbody>
                          <tr><td style={{ width: '38%', color: '#6b7280', fontWeight: 500 }}>Current Role</td><td style={{ fontWeight: 600 }}>{docData.current_role || '—'}</td></tr>
                          <tr><td style={{ color: '#6b7280', fontWeight: 500 }}>New Role</td><td style={{ fontWeight: 700 }}>{docData.new_role || '—'}</td></tr>
                          {docData.current_department && <tr><td style={{ color: '#6b7280', fontWeight: 500 }}>Current Dept.</td><td style={{ fontWeight: 600 }}>{docData.current_department}</td></tr>}
                          {docData.new_department && <tr><td style={{ color: '#6b7280', fontWeight: 500 }}>New Dept.</td><td style={{ fontWeight: 700 }}>{docData.new_department}</td></tr>}
                          {docData.new_salary && <tr><td style={{ color: '#6b7280', fontWeight: 500 }}>New Compensation</td><td style={{ fontWeight: 700 }}>₹ {Number(docData.new_salary).toLocaleString('en-IN')} / {docData.salary_frequency || 'month'}</td></tr>}
                          <tr><td style={{ color: '#6b7280', fontWeight: 500 }}>Effective Date</td><td style={{ fontWeight: 700 }}>{fmtOfferDate(docData.effective_date)}</td></tr>
                        </tbody>
                      </table>
                      {docData.message && (
                        <div style={{ marginBottom: '1.5em' }}>
                          <p style={{ fontWeight: 700, textTransform: 'uppercase', fontSize: '8pt', letterSpacing: '0.06em', color: '#374151', marginBottom: '0.5em' }}>Additional Information</p>
                          <p style={{ fontSize: '10pt', lineHeight: 1.7, whiteSpace: 'pre-line', color: '#374151' }}>{docData.message}</p>
                        </div>
                      )}
                      <p className="rp-doc-para">We look forward to your continued contributions in this new capacity. Should you have any questions, please reach out to the HR department.</p>
                      <div className="rp-doc-signoff-block">
                        <p className="rp-doc-sign-line">Sincerely,</p>
                        <p><strong>{company.authorized_person || company.company_name || 'HR Department'}</strong></p>
                        {company.authorized_designation && <p style={{ fontSize: '9pt', color: '#6b7280' }}>{company.authorized_designation}</p>}
                        {company.signature_url && <img src={company.signature_url} alt="Authorized Signature" className="rp-doc-sig-img" />}
                        <div className="rp-doc-sig-section">
                          <h4>ACKNOWLEDGEMENT</h4>
                          <div className="rp-doc-sig-rule" />
                          <p>I, <strong>{docData.issued_to}</strong>, hereby acknowledge receipt and understanding of this role change notice.</p>
                          <div className="rp-doc-sig-grid">
                            <div className="rp-doc-sig-col">
                              <p className="rp-doc-sig-heading">Authorized Signatory</p>
                              <p>{company.company_name || 'HR Department'}</p>
                              <p>Date: {fmtOfferDate(docData.issue_date)}</p>
                              {company.signature_url && <img src={company.signature_url} alt="Signature" className="rp-doc-sig-img" style={{ opacity: 0.6 }} />}
                              <div className="rp-doc-sig-line" /><p className="rp-doc-sig-caption">Signature</p>
                            </div>
                            <div className="rp-doc-sig-col">
                              <p className="rp-doc-sig-heading">Employee Acknowledgement</p>
                              {status === 'acknowledged' && signature ? (
                                <><img src={signature} alt="Employee Signature" className="rp-doc-sig-img" /><p>Name: {candidateName || docData.issued_to}</p><p>Date: {new Date().toLocaleDateString()}</p></>
                              ) : (
                                <><p>Name: _______________________</p><p>Date: _______________________</p><div className="rp-doc-sig-line" /><p className="rp-doc-sig-caption">Signature</p></>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* ── Termination Notice ── */}
                  {docData.type === 'termination' && (
                    <div className="rp-doc-body">
                      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '1em', gap: '0.5em' }}>
                        <h3 className="rp-doc-title" style={{ margin: 0 }}>EMPLOYMENT TERMINATION NOTICE</h3>
                        <span style={{ flexShrink: 0, display: 'inline-block', background: '#dc2626', color: '#fff', fontSize: '8pt', fontWeight: 700, padding: '3px 12px', borderRadius: '20px', letterSpacing: '0.04em', textTransform: 'uppercase' }}>Confidential</span>
                      </div>
                      <p className="rp-doc-date">Date: {fmtOfferDate(docData.issue_date)}</p>
                      <p><strong>To,</strong></p>
                      <p><strong>{docData.issued_to}</strong></p>
                      {(docData.current_role || docData.current_department) && (
                        <p style={{ fontSize: '10pt', color: '#6b7280', marginTop: '-0.5em' }}>{[docData.current_role, docData.current_department].filter(Boolean).join(', ')}</p>
                      )}
                      <p className="rp-doc-para">Dear <strong>{docData.issued_to}</strong>,</p>
                      <p className="rp-doc-para">
                        We regret to inform you that your employment with <strong>{company.company_name || 'the company'}</strong> will be concluded effective <strong>{fmtOfferDate(docData.last_day)}</strong>, which shall be your last working day.
                      </p>
                      <table className="rp-doc-table" style={{ marginBottom: '1.5em' }}>
                        <thead><tr><th colSpan={2} style={{ textAlign: 'left' }}>Termination Details</th></tr></thead>
                        <tbody>
                          <tr><td style={{ width: '38%', color: '#6b7280', fontWeight: 500 }}>Employee</td><td style={{ fontWeight: 600 }}>{docData.issued_to}</td></tr>
                          {docData.current_role && <tr><td style={{ color: '#6b7280', fontWeight: 500 }}>Role</td><td style={{ fontWeight: 600 }}>{docData.current_role}</td></tr>}
                          {docData.current_department && <tr><td style={{ color: '#6b7280', fontWeight: 500 }}>Department</td><td style={{ fontWeight: 600 }}>{docData.current_department}</td></tr>}
                          <tr><td style={{ color: '#6b7280', fontWeight: 500 }}>Last Working Day</td><td style={{ fontWeight: 700, color: '#dc2626' }}>{fmtOfferDate(docData.last_day)}</td></tr>
                        </tbody>
                      </table>
                      {docData.message && (
                        <div style={{ marginBottom: '1.5em' }}>
                          <p style={{ fontWeight: 700, textTransform: 'uppercase', fontSize: '8pt', letterSpacing: '0.06em', color: '#374151', marginBottom: '0.5em' }}>Additional Details</p>
                          <p style={{ fontSize: '10pt', lineHeight: 1.7, whiteSpace: 'pre-line', color: '#374151' }}>{docData.message}</p>
                        </div>
                      )}
                      <p className="rp-doc-para">
                        Please ensure all company property and documents are returned and knowledge transfer is completed by your last working day. Your final settlement will be processed in accordance with company policy.
                      </p>
                      <div className="rp-doc-signoff-block">
                        <p className="rp-doc-sign-line">Sincerely,</p>
                        <p><strong>{company.authorized_person || company.company_name || 'HR Department'}</strong></p>
                        {company.authorized_designation && <p style={{ fontSize: '9pt', color: '#6b7280' }}>{company.authorized_designation}</p>}
                        {company.signature_url && <img src={company.signature_url} alt="Authorized Signature" className="rp-doc-sig-img" />}
                        <div className="rp-doc-sig-section">
                          <h4>ACKNOWLEDGEMENT</h4>
                          <div className="rp-doc-sig-rule" />
                          <p>I, <strong>{docData.issued_to}</strong>, hereby acknowledge receipt of this termination notice.</p>
                          <div className="rp-doc-sig-grid">
                            <div className="rp-doc-sig-col">
                              <p className="rp-doc-sig-heading">Authorized Signatory</p>
                              <p>{company.company_name || 'HR Department'}</p>
                              <p>Date: {fmtOfferDate(docData.issue_date)}</p>
                              {company.signature_url && <img src={company.signature_url} alt="Signature" className="rp-doc-sig-img" style={{ opacity: 0.6 }} />}
                              <div className="rp-doc-sig-line" /><p className="rp-doc-sig-caption">Signature</p>
                            </div>
                            <div className="rp-doc-sig-col">
                              <p className="rp-doc-sig-heading">Employee Acknowledgement</p>
                              {status === 'acknowledged' && signature ? (
                                <><img src={signature} alt="Employee Signature" className="rp-doc-sig-img" /><p>Name: {candidateName || docData.issued_to}</p><p>Date: {new Date().toLocaleDateString()}</p></>
                              ) : (
                                <><p>Name: _______________________</p><p>Date: _______________________</p><div className="rp-doc-sig-line" /><p className="rp-doc-sig-caption">Signature</p></>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* ── MoU ── */}
                  {docData.type === 'mou' && (
                    <div className="rp-doc-body">
                      <h3 className="rp-doc-title">MEMORANDUM OF UNDERSTANDING</h3>
                      <p className="rp-doc-para">
                        This MoU is entered into between <strong>{docData.party_a?.company}</strong> (First Party)
                        and <strong>{docData.party_b?.company}</strong> (Second Party).
                      </p>
                      <p className="rp-doc-date">Date: {docData.issue_date}</p>
                      <p className="rp-doc-para">The parties agree to collaborate in good faith under the terms outlined in this agreement.</p>
                      <div className="rp-doc-sig-grid" style={{ marginTop: '2.5em' }}>
                        <div className="rp-doc-sig-col">
                          <p className="rp-doc-sig-heading">{docData.party_a?.company}</p>
                          <p>{docData.party_a?.representative} — {docData.party_a?.designation}</p>
                          {docData.party_a?.signed_at && <p className="rp-doc-signed-badge">Signed: {docData.party_a.signed_at}</p>}
                          {docData.party_a?.signature ? (
                            <img src={docData.party_a.signature} alt="" className="rp-doc-sig-img" style={{ opacity: 0.6 }} />
                          ) : (
                            <div className="rp-doc-sig-line" />
                          )}
                        </div>
                        <div className="rp-doc-sig-col">
                          <p className="rp-doc-sig-heading">{docData.party_b?.company}</p>
                          <p>{docData.party_b?.representative} — {docData.party_b?.designation}</p>
                          {status === 'fully_signed' && partyBSignature ? (
                            <>
                              <p className="rp-doc-signed-badge">Signed: {new Date().toLocaleString()}</p>
                              <img src={partyBSignature} alt="" className="rp-doc-sig-img" />
                            </>
                          ) : (
                            <div className="rp-doc-sig-line" />
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* ── Invoice / Proforma ── */}
                  {docData.type === 'proforma' && <ProformaDocument doc={docData} company={company} />}

                  {docData.type === 'invoice' && (
                    <div className="rp-doc-body">
                      <h3 className="rp-doc-title">TAX INVOICE</h3>
                      <div className="rp-doc-invoice-meta">
                        <div>
                          <p className="rp-doc-meta-label">Bill To</p>
                          <p className="rp-doc-meta-value">{docData.issued_to || docData.client?.name}</p>
                          {docData.client?.address && <p>{docData.client.address}</p>}
                          {docData.client?.gstin && <p className="rp-letterhead-gstin">GSTIN: {docData.client.gstin}</p>}
                        </div>
                        <div className="rp-doc-invoice-ids">
                          <p><strong>{docData.doc_number || docData.id}</strong></p>
                          <p>Date: {docData.issue_date}</p>
                          {docData.due_date && <p>Due: {docData.due_date}</p>}
                        </div>
                      </div>
                      <table className="rp-doc-table">
                        <thead>
                          <tr>
                            <th>Description</th>
                            <th>Qty</th>
                            <th>Rate</th>
                            <th>Amount</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(docData.items || []).map((item, i) => (
                            <tr key={i}>
                              <td>{item.description}</td>
                              <td className="rp-doc-table-center">{item.quantity} {item.unit || ''}</td>
                              <td className="rp-doc-table-right">₹{item.rate?.toLocaleString('en-IN')}</td>
                              <td className="rp-doc-table-right">₹{((item.quantity || 0) * (item.rate || 0)).toLocaleString('en-IN')}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <DocTotals doc={docData} totalLabel="Total Due" splitGst />
                      {docData.accepted_signature && (
                        <div className="rp-doc-sig-section">
                          <h4>SIGNATURES</h4>
                          <div className="rp-doc-sig-rule" />
                          <div className="rp-doc-sig-grid">
                            <div className="rp-doc-sig-col">
                              <p className="rp-doc-sig-heading">Authorized Signatory</p>
                              <p>{company.company_name || docData.issued_by}</p>
                              <p>Date: {docData.issue_date}</p>
                              {company.signature_url && <img src={company.signature_url} alt="Company Signature" className="rp-doc-sig-img" />}
                              <div className="rp-doc-sig-line" />
                            </div>
                            <div className="rp-doc-sig-col">
                              <p className="rp-doc-sig-heading">Accepted By</p>
                              <img src={docData.accepted_signature} alt="Accepted Signature" className="rp-doc-sig-img" />
                              <p>{docData.accepted_by || docData.issued_to}</p>
                              <p>Date: {docData.accepted_at ? new Date(docData.accepted_at).toLocaleDateString() : ''}</p>
                              {docData.converted_from && <p style={{ fontSize: '7pt', color: '#999', marginTop: '0.5em' }}>Ref: {docData.converted_from_number || docData.converted_from}</p>}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* ── Quotation ── */}
                  {docData.type === 'quotation' && (
                    <div className="rp-doc-body">
                      <h3 className="rp-doc-title">QUOTATION</h3>
                      <div className="rp-doc-invoice-meta">
                        <div>
                          <p className="rp-doc-meta-label">Prepared For</p>
                          <p className="rp-doc-meta-value">{docData.issued_to || docData.client?.name}</p>
                        </div>
                        <div className="rp-doc-invoice-ids">
                          <p><strong>{docData.doc_number || docData.id}</strong></p>
                          <p>Date: {docData.issue_date}</p>
                          <p>Valid Until: {docData.valid_until}</p>
                        </div>
                      </div>
                      <table className="rp-doc-table">
                        <thead>
                          <tr>
                            <th>Description</th>
                            <th>Qty</th>
                            <th>Rate</th>
                            <th>Amount</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(docData.items || []).map((item, i) => (
                            <tr key={i}>
                              <td>{item.description}</td>
                              <td className="rp-doc-table-center">{item.quantity}</td>
                              <td className="rp-doc-table-right">₹{item.rate?.toLocaleString('en-IN')}</td>
                              <td className="rp-doc-table-right">₹{((item.quantity || 0) * (item.rate || 0)).toLocaleString('en-IN')}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <DocTotals doc={docData} totalLabel="Total" />
                      {(docData.accepted_signature || (status === 'accepted' && signature)) && (
                        <div className="rp-doc-sig-section">
                          <h4>SIGNATURES</h4>
                          <div className="rp-doc-sig-rule" />
                          <div className="rp-doc-sig-grid">
                            <div className="rp-doc-sig-col">
                              <p className="rp-doc-sig-heading">Authorized Signatory</p>
                              <p>{company.company_name || docData.issued_by}</p>
                              <p>Date: {docData.issue_date}</p>
                              {company.signature_url && <img src={company.signature_url} alt="Company Signature" className="rp-doc-sig-img" />}
                              <div className="rp-doc-sig-line" />
                            </div>
                            <div className="rp-doc-sig-col">
                              <p className="rp-doc-sig-heading">Accepted By</p>
                              <img src={docData.accepted_signature || signature} alt="Accepted Signature" className="rp-doc-sig-img" />
                              <p>{docData.accepted_by || candidateName || docData.issued_to}</p>
                              <p>Date: {docData.accepted_at ? new Date(docData.accepted_at).toLocaleDateString() : new Date().toLocaleDateString()}</p>
                            </div>
                          </div>
                        </div>
                      )}
                      <p className="rp-doc-disclaimer">This is not a tax invoice.</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </motion.div>

          {/* Right: Action Panel */}
          <motion.div className="rp-actions" variants={fadeUp}>

            {/* ════════ OFFER LETTER ════════ */}
            {/* Opening the link flips 'pending' to 'viewed', and a letter saved
                from the documents page starts as 'draft' — gate on whether a
                response has been recorded, not on one particular status, or
                the accept panel vanishes on the candidate's second visit. */}
            {docData.type === 'offer_letter' && !isActionTaken && (
              <div className="rp-card">
                <div className="rp-card-header">
                  <Sparkles size={18} />
                  <h3>Your Response</h3>
                </div>
                <p className="rp-card-desc">Review the offer letter on the left, then provide your signature below to accept.</p>

                <SignatureCapture onSignatureChange={(sig, method) => { setSignature(sig); setSignatureMethod(method); }} />

                <label className="rp-agree">
                  <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
                  <span>I, <strong>{candidateName || docData.issued_to}</strong>, confirm I have read and accept all terms of this offer letter.</span>
                </label>

                <div className="rp-card-actions">
                  <button className="rp-btn rp-btn-primary" disabled={!signature || !agreed || readOnly || !!submitting} onClick={handleAcceptOffer}>
                    <Check size={16} /> Accept & Sign
                  </button>
                  <button className="rp-btn rp-btn-danger-outline" disabled={readOnly || !!submitting} onClick={() => setShowDeclineModal(true)}>
                    <X size={16} /> Decline
                  </button>
                </div>
              </div>
            )}

            {docData.type === 'offer_letter' && status === 'signed' && (
              <SuccessCard
                title="Offer Accepted"
                subtitle={`Thank you, ${candidateName || docData.issued_to}`}
                details={[
                  // The signing time is on the document. Rendering `new Date()`
                  // told anyone revisiting the link that they had signed it
                  // just now.
                  { label: 'Signed on', value: fmtSignedAt(docData.signed_at) },
                  { label: 'Method', value: signatureMethod === 'draw' ? 'Drawn' : signatureMethod === 'upload' ? 'Uploaded' : 'Typed' },
                  { label: 'Document', value: docData.doc_number || docData.id },
                ]}
              />
            )}

            {/* Issued straight from the Employees page: the person is already
                on the registry, so the letter is a record, not a request. */}
            {docData.type === 'offer_letter' && status === 'accepted' && (
              <SuccessCard
                title="Offer Already Accepted"
                subtitle={`This letter is on record for ${docData.issued_to || 'you'}. Nothing further is needed.`}
                details={[
                  { label: 'Status', value: 'Accepted' },
                  { label: 'Issued on', value: docData.issue_date || '—' },
                  { label: 'Document', value: docData.doc_number || docData.id },
                ]}
              />
            )}

            {/* ════════ MoU / NDA ════════ */}
            {docData.type === 'mou' && status === 'party_a_signed' && (
              <div className="rp-card">
                <div className="rp-card-header">
                  <ShieldCheck size={18} />
                  <h3>Counter-Sign Agreement</h3>
                </div>

                <div className="rp-party-status">
                  <div className="rp-party-row rp-party-done">
                    <Check size={14} />
                    <div>
                      <strong>{docData.party_a?.company}</strong>
                      <span>Signed by {docData.party_a?.representative} — {docData.party_a?.signed_at}</span>
                    </div>
                  </div>
                  <div className="rp-party-row rp-party-pending">
                    <Clock size={14} />
                    <div>
                      <strong>{docData.party_b?.company}</strong>
                      <span>Awaiting your signature</span>
                    </div>
                  </div>
                </div>

                <div className="rp-field-group">
                  <label className="rp-label">Your Signature</label>
                  <SignatureCapture onSignatureChange={(sig) => setPartyBSignature(sig)} />
                </div>

                <div className="rp-fields-row">
                  <div className="rp-field">
                    <label>Full Name</label>
                    <input type="text" value={candidateName} onChange={(e) => setCandidateName(e.target.value)} placeholder="Enter your name" />
                  </div>
                  <div className="rp-field">
                    <label>Designation</label>
                    <input type="text" value={candidateDesignation} onChange={(e) => setCandidateDesignation(e.target.value)} placeholder="e.g. CEO" />
                  </div>
                  <div className="rp-field">
                    <label>Date</label>
                    <input type="date" value={candidateDate} onChange={(e) => setCandidateDate(e.target.value)} />
                  </div>
                </div>

                <label className="rp-agree">
                  <input type="checkbox" checked={partyBAgreed} onChange={(e) => setPartyBAgreed(e.target.checked)} />
                  <span>I am authorized to sign on behalf of <strong>{docData.party_b?.company}</strong>.</span>
                </label>

                <button className="rp-btn rp-btn-primary" disabled={!partyBSignature || !partyBAgreed || readOnly || !!submitting} onClick={handleMoUSign}>
                  <Check size={16} /> Sign Agreement
                </button>
              </div>
            )}

            {docData.type === 'mou' && status === 'fully_signed' && (
              <SuccessCard title="Agreement Fully Signed" subtitle="Both parties have signed the document." />
            )}

            {isCancelled && (
              <StatusCard icon={<AlertCircle size={28} />} color="#ef4444"
                title={`${docData.type === 'invoice' ? 'Invoice' : docData.type === 'proforma' ? 'Proforma invoice' : 'Quotation'} cancelled`}
                subtitle={`${company?.company_name || 'The issuer'} has cancelled this document. No action or payment is needed — contact them if you have questions.`} />
            )}

            {/* ════════ INVOICE ════════ */}
            {docData.type === 'invoice' && !isCancelled && !paymentSubmitted && status !== 'paid' && status !== 'payment_submitted' && (
              <div className="rp-card">
                <div className="rp-card-header">
                  <CreditCard size={18} />
                  <h3>Pay Invoice</h3>
                </div>

                <div className="rp-amount-hero">
                  <span className="rp-amount-label">Amount Due</span>
                  <span className="rp-amount-value">{inr(grandTotalOf(docData))}</span>
                  <div className="rp-amount-meta-row">
                    <span><Calendar size={12} /> Due: {docData.due_date}</span>
                    <span><Hash size={12} /> {docData.doc_number || docData.id}</span>
                  </div>
                </div>

                <div className="rp-payment-method">
                  <h4>UPI Payment</h4>
                  <UPIQRGenerator
                    upiId={docData.upi_id || company.upi_id}
                    payeeName={company.company_name || docData.issued_by}
                    amount={docData.grand_total || docData.amount}
                    transactionNote={docData.id}
                  />
                </div>

                <div className="rp-payment-method">
                  <button className="rp-bank-toggle" onClick={() => setShowBankDetails(!showBankDetails)}>
                    <Banknote size={15} />
                    <span>Bank Transfer Details</span>
                    <span className="rp-bank-arrow">{showBankDetails ? '−' : '+'}</span>
                  </button>
                  <AnimatePresence>
                    {showBankDetails && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="rp-bank-details"
                      >
                        <BankRow label="Bank Name" value={docData.bank?.name || company.bank_name} />
                        <BankRow label="Account No." value={docData.bank?.account || company.bank_account_number} copyable onCopy={(v) => handleCopy(v, 'account')} copied={copied === 'account'} />
                        <BankRow label="IFSC Code" value={docData.bank?.ifsc || company.bank_ifsc} copyable onCopy={(v) => handleCopy(v, 'ifsc')} copied={copied === 'ifsc'} />
                        <BankRow label="Account Type" value={docData.bank?.type || company.bank_account_type} />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                {!showPaymentForm ? (
                  <button className="rp-btn rp-btn-primary" onClick={() => setShowPaymentForm(true)}>
                    <Check size={16} /> I Have Made the Payment
                  </button>
                ) : (
                  <PaymentConfirmationForm
                    amount={docData.grand_total || docData.amount}
                    invoiceId={docData.id}
                    onSubmit={handlePaymentConfirmation}
                  />
                )}
              </div>
            )}

            {docData.type === 'invoice' && (paymentSubmitted || status === 'payment_submitted') && (
              <SuccessCard title="Payment Submitted" subtitle="Your payment confirmation is under review. You'll receive a receipt once verified." />
            )}

            {docData.type === 'invoice' && status === 'paid' && (
              <SuccessCard title="Invoice Paid" subtitle="Payment verified successfully. Thank you!" />
            )}

            {/* ════════ QUOTATION ════════ */}
            {docData.type === 'quotation' && !isCancelled && status !== 'accepted' && status !== 'declined' && status !== 'revision_requested' && status !== 'converted' && (
              <div className="rp-card">
                <div className="rp-card-header">
                  <FileText size={18} />
                  <h3>Review Quotation</h3>
                </div>

                <div className="rp-amount-hero">
                  <span className="rp-amount-label">Quoted Amount</span>
                  <span className="rp-amount-value">{inr(grandTotalOf(docData))}</span>
                  <div className="rp-amount-meta-row">
                    <span><Calendar size={12} /> Valid until: {docData.valid_until}</span>
                    <span><Hash size={12} /> {docData.doc_number || docData.id}</span>
                  </div>
                </div>

                <div className="rp-field-group">
                  <label className="rp-label">Your Signature</label>
                  <SignatureCapture onSignatureChange={(sig, method) => { setSignature(sig); setSignatureMethod(method); }} />
                </div>

                <div className="rp-fields-row">
                  <div className="rp-field">
                    <label>Full Name</label>
                    <input type="text" value={candidateName} onChange={(e) => setCandidateName(e.target.value)} placeholder="Enter your name" />
                  </div>
                  <div className="rp-field">
                    <label>Designation</label>
                    <input type="text" value={candidateDesignation} onChange={(e) => setCandidateDesignation(e.target.value)} placeholder="e.g. Procurement Head" />
                  </div>
                  <div className="rp-field">
                    <label>Date</label>
                    <input type="date" value={candidateDate} onChange={(e) => setCandidateDate(e.target.value)} />
                  </div>
                </div>

                <label className="rp-agree">
                  <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
                  <span>I accept this quotation and authorize <strong>{company.company_name || docData.issued_by}</strong> to proceed.</span>
                </label>

                <div className="rp-card-actions">
                  <button className="rp-btn rp-btn-primary" disabled={!signature || !agreed || readOnly || !!submitting} onClick={handleAcceptQuotation}>
                    <Check size={16} /> Accept Quotation
                  </button>
                  <button className="rp-btn rp-btn-outline" onClick={() => setShowRevisionModal(true)}>
                    <MessageSquare size={14} /> Request Revision
                  </button>
                  <button className="rp-btn rp-btn-danger-outline" disabled={readOnly || !!submitting} onClick={() => setShowDeclineModal(true)}>
                    <X size={14} /> Decline
                  </button>
                </div>
              </div>
            )}

            {docData.type === 'quotation' && status === 'accepted' && (
              <SuccessCard title="Quotation Accepted" subtitle={`Thank you, ${candidateName}`} />
            )}

            {docData.type === 'quotation' && status === 'revision_requested' && (
              <StatusCard icon={<MessageSquare size={28} />} color="#6366f1" title="Revision Requested" subtitle="The issuer has been notified. You'll receive an updated quotation." />
            )}

            {docData.type === 'quotation' && status === 'converted' && (
              <SuccessCard title="Quotation Converted" subtitle="This quotation has moved to billing. You will receive the invoice separately — no further action is needed here." />
            )}

            {/* ════════ PROFORMA ════════ */}
            {docData.type === 'proforma' && !isCancelled && (
              <ProformaActions
                doc={docData}
                company={company}
                status={paymentSubmitted ? 'payment_submitted' : status}
                orderConfirmed={orderConfirmed}
                agreed={agreed}
                setAgreed={setAgreed}
                readOnly={readOnly}
                submitting={submitting}
                onConfirm={handleConfirmOrder}
                onPay={handleProformaPayment}
                showPaymentForm={showPaymentForm}
                setShowPaymentForm={setShowPaymentForm}
                showBankDetails={showBankDetails}
                setShowBankDetails={setShowBankDetails}
              />
            )}

            {/* ════════ ROLE CHANGE ════════ */}
            {docData.type === 'role_change' && !isActionTaken && (
              <div className="rp-card">
                <div className="rp-card-header">
                  <Sparkles size={18} />
                  <h3>Acknowledge Role Change</h3>
                </div>
                <p className="rp-card-desc">Review the notice on the left, then sign below to acknowledge your updated role.</p>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem', marginBottom: '1rem', padding: '0.75rem', background: 'rgba(99,102,241,0.06)', borderRadius: '10px', border: '1px solid rgba(99,102,241,0.18)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem' }}>
                    <span style={{ color: 'var(--rp-text-muted)' }}>New Role</span>
                    <strong>{docData.new_role}</strong>
                  </div>
                  {docData.new_department && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem' }}>
                      <span style={{ color: 'var(--rp-text-muted)' }}>Department</span>
                      <strong>{docData.new_department}</strong>
                    </div>
                  )}
                  {docData.new_salary && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem' }}>
                      <span style={{ color: 'var(--rp-text-muted)' }}>New Compensation</span>
                      <strong>₹{Number(docData.new_salary).toLocaleString('en-IN')} / {docData.salary_frequency || 'month'}</strong>
                    </div>
                  )}
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem' }}>
                    <span style={{ color: 'var(--rp-text-muted)' }}>Effective</span>
                    <strong>{fmtOfferDate(docData.effective_date)}</strong>
                  </div>
                </div>

                <div className="rp-field-group">
                  <label className="rp-label">Your Signature</label>
                  <SignatureCapture onSignatureChange={(sig, method) => { setSignature(sig); setSignatureMethod(method); }} />
                </div>

                <label className="rp-agree">
                  <input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} />
                  <span>I, <strong>{candidateName || docData.issued_to}</strong>, acknowledge this role change effective <strong>{fmtOfferDate(docData.effective_date)}</strong>.</span>
                </label>

                <div className="rp-card-actions">
                  <button className="rp-btn rp-btn-primary" disabled={!signature || !agreed || readOnly || !!submitting} onClick={handleAcknowledge}>
                    <Check size={16} /> Acknowledge & Sign
                  </button>
                </div>
              </div>
            )}

            {docData.type === 'role_change' && status === 'acknowledged' && (
              <SuccessCard
                title="Role Change Acknowledged"
                subtitle={`Thank you, ${candidateName || docData.issued_to}`}
                details={[
                  { label: 'New Role', value: docData.new_role },
                  { label: 'Effective', value: fmtOfferDate(docData.effective_date) },
                  { label: 'Document', value: docData.id },
                ]}
              />
            )}

            {/* ════════ TERMINATION ════════ */}
            {docData.type === 'termination' && !isActionTaken && (
              <div className="rp-card">
                <div className="rp-card-header" style={{ color: '#ef4444' }}>
                  <AlertCircle size={18} />
                  <h3>Acknowledgement Required</h3>
                </div>
                <p className="rp-card-desc">Please review the termination notice on the left and provide your signature below.</p>

                <div style={{ padding: '0.6rem 0.875rem', background: 'rgba(239,68,68,0.07)', borderRadius: '8px', border: '1px solid rgba(239,68,68,0.2)', marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem' }}>
                  <span style={{ color: '#f87171' }}>Last Working Day</span>
                  <strong style={{ color: '#f87171' }}>{fmtOfferDate(docData.last_day)}</strong>
                </div>

                <div style={{ fontSize: '0.72rem', color: 'var(--rp-text-muted)', padding: '0.5rem 0.75rem', background: 'rgba(239,68,68,0.04)', borderRadius: '6px', border: '1px solid rgba(239,68,68,0.12)', marginBottom: '1rem' }}>
                  This acknowledgement is mandatory and cannot be declined.
                </div>

                <div className="rp-field-group">
                  <label className="rp-label">Your Signature</label>
                  <SignatureCapture onSignatureChange={(sig, method) => { setSignature(sig); setSignatureMethod(method); }} />
                </div>

                <label className="rp-agree">
                  <input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} />
                  <span>I, <strong>{candidateName || docData.issued_to}</strong>, acknowledge this termination notice. My last working day is <strong>{fmtOfferDate(docData.last_day)}</strong>.</span>
                </label>

                <div className="rp-card-actions">
                  <button className="rp-btn rp-btn-danger" disabled={!signature || !agreed || readOnly || !!submitting} onClick={handleAcknowledge}>
                    <Check size={16} /> Acknowledge & Sign
                  </button>
                </div>
              </div>
            )}

            {docData.type === 'termination' && status === 'acknowledged' && (
              <SuccessCard
                title="Notice Acknowledged"
                subtitle={`Recorded for ${candidateName || docData.issued_to}`}
                details={[
                  { label: 'Last Working Day', value: fmtOfferDate(docData.last_day) },
                  { label: 'Acknowledged on', value: new Date().toLocaleDateString() },
                  { label: 'Document', value: docData.id },
                ]}
              />
            )}

            {/* ════════ DECLINED (shared) ════════ */}
            {status === 'declined' && (
              <StatusCard icon={<AlertCircle size={28} />} color="#ef4444" title="Document Declined" subtitle="The issuer has been notified of your decision." />
            )}
          </motion.div>
        </motion.div>
      </div>

      {/* ── Decline Modal ── */}
      <AnimatePresence>
        {showDeclineModal && (
          <ModalOverlay onClose={() => setShowDeclineModal(false)}>
            <div className="rp-modal-icon rp-modal-icon-danger"><AlertCircle size={22} /></div>
            <h3>Decline this document?</h3>
            <p>This action cannot be undone. The issuer will be notified.</p>
            <textarea
              className="rp-modal-textarea"
              placeholder="Reason for declining (optional)..."
              value={declineReason}
              onChange={(e) => setDeclineReason(e.target.value)}
            />
            <div className="rp-modal-actions">
              <button className="rp-btn rp-btn-ghost" onClick={() => setShowDeclineModal(false)}>Cancel</button>
              <button className="rp-btn rp-btn-danger" onClick={handleDecline} disabled={!!submitting}>Confirm Decline</button>
            </div>
          </ModalOverlay>
        )}
      </AnimatePresence>

      {/* ── Revision Modal ── */}
      <AnimatePresence>
        {showRevisionModal && (
          <ModalOverlay onClose={() => setShowRevisionModal(false)}>
            <h3>Request Revision</h3>
            <p>Describe the changes you'd like made to this quotation.</p>
            <textarea
              className="rp-modal-textarea"
              placeholder="Describe the changes needed..."
              value={revisionText}
              onChange={(e) => setRevisionText(e.target.value)}
            />
            <div className="rp-modal-actions">
              <button className="rp-btn rp-btn-ghost" onClick={() => setShowRevisionModal(false)}>Cancel</button>
              <button className="rp-btn rp-btn-primary" onClick={handleRevisionRequest} disabled={!revisionText.trim() || !!submitting}>
                Submit Request
              </button>
            </div>
          </ModalOverlay>
        )}
      </AnimatePresence>

      {/* ── Footer — always visible ── */}
      <footer className="rp-footer">
        <div className="rp-footer-inner">
          <div className="rp-footer-brand">
            <Shield size={13} />
            <span>Powered by <strong>StartupBuddy</strong></span>
          </div>
          <p className="rp-footer-tagline">Secure document management for businesses</p>
        </div>
      </footer>
    </div>
  );
}

// ── Sub-components ──

function ModalOverlay({ children, onClose }) {
  return (
    <div className="rp-overlay" onClick={onClose}>
      <motion.div
        className="rp-modal"
        initial={{ scale: 0.95, opacity: 0, y: 10 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.95, opacity: 0, y: 10 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </motion.div>
    </div>
  );
}

function SuccessCard({ title, subtitle, details }) {
  return (
    <motion.div
      className="rp-success"
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ type: 'spring', duration: 0.6 }}
    >
      <motion.div
        className="rp-success-icon"
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        transition={{ delay: 0.15, type: 'spring', stiffness: 200 }}
      >
        <CheckCircle2 size={36} />
      </motion.div>
      <h3>{title}</h3>
      {subtitle && <p>{subtitle}</p>}
      {details && (
        <div className="rp-success-details">
          {details.map((d, i) => (
            <div key={i}><span>{d.label}</span><strong>{d.value}</strong></div>
          ))}
        </div>
      )}
    </motion.div>
  );
}

function StatusCard({ icon, color, title, subtitle }) {
  return (
    <motion.div
      className="rp-status-card"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      style={{ '--status-color': color }}
    >
      <div className="rp-status-card-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{subtitle}</p>
    </motion.div>
  );
}

function BankRow({ label, value, copyable, onCopy, copied }) {
  return (
    <div className="rp-bank-row">
      <span>{label}</span>
      <div className="rp-bank-val">
        <strong>{value || '—'}</strong>
        {copyable && value && (
          <button onClick={() => onCopy(value)} className="rp-copy-btn" title="Copy">
            {copied ? <Check size={11} /> : <Copy size={11} />}
          </button>
        )}
      </div>
    </div>
  );
}

const inr = (n) => '₹' + (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

/** grand_total is written by the totals trigger and already includes GST. */
function grandTotalOf(doc) {
  return Number(doc.grand_total ?? doc.total ?? doc.amount) || 0;
}

/* Subtotal → discount → GST → total, from the trigger-computed columns. The
   quotation used to print `subtotal` as its total, so every quotation with GST
   showed the client the pre-tax figure. A quotation shows one GST line, as
   its editor does; an invoice splits it the way the tax invoice must. */
function DocTotals({ doc, totalLabel, splitGst }) {
  const subtotal = Number(doc.subtotal) || 0;
  const discount = Number(doc.discount_amount) || 0;
  const gst = doc.gst_enabled === false ? 0 : Number(doc.gst_amount ?? doc.gst) || 0;
  const rate = Number(doc.gst_rate) || 0;
  const interState = !!doc.is_inter_state;
  return (
    <div className="rp-doc-totals">
      {(discount > 0 || gst > 0) && (
        <div className="rp-doc-total-row"><span>Subtotal</span><span>{inr(subtotal)}</span></div>
      )}
      {discount > 0 && (
        <div className="rp-doc-total-row"><span>Discount</span><span>−{inr(discount)}</span></div>
      )}
      {gst > 0 && !splitGst && (
        <div className="rp-doc-total-row"><span>GST @ {rate}%</span><span>{inr(gst)}</span></div>
      )}
      {gst > 0 && splitGst && (interState ? (
        <div className="rp-doc-total-row"><span>IGST @ {rate}%</span><span>{inr(gst)}</span></div>
      ) : (
        <>
          <div className="rp-doc-total-row"><span>CGST @ {rate / 2}%</span><span>{inr(gst / 2)}</span></div>
          <div className="rp-doc-total-row"><span>SGST @ {rate / 2}%</span><span>{inr(gst / 2)}</span></div>
        </>
      ))}
      <div className="rp-doc-total-row rp-doc-grand-total">
        <span>{totalLabel}</span>
        <span>{inr(grandTotalOf(doc))}</span>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   Proforma — its own document and its own flow, not an invoice's.

   A proforma is an offer to supply at a price, sent so the client can commit:
   confirm the order, then pay the advance it asks for. It is not a demand for
   the full amount and not a tax document. The balance is billed on the tax
   invoice at delivery, and that invoice is what the client pays in full.
   ══════════════════════════════════════════════════════════════════════════ */

function ProformaDocument({ doc }) {
  const a = advanceOf(doc);
  const subtotal = Number(doc.subtotal) || 0;
  const discount = Number(doc.discount_amount) || 0;
  const gst = doc.gst_enabled === false ? 0 : Number(doc.gst_amount ?? doc.gst) || 0;
  const rate = Number(doc.gst_rate) || 0;
  const validUntil = doc.valid_until || doc.due_date;
  return (
    <div className="rp-doc-body">
      <h3 className="rp-doc-title">PROFORMA INVOICE</h3>
      <div className="rp-doc-invoice-meta">
        <div>
          <p className="rp-doc-meta-label">Proforma for</p>
          <p className="rp-doc-meta-value">{doc.issued_to || doc.client?.name}</p>
          {doc.client?.address && <p>{doc.client.address}</p>}
          {doc.client?.gstin && <p className="rp-letterhead-gstin">GSTIN: {doc.client.gstin}</p>}
        </div>
        <div className="rp-doc-invoice-ids">
          <p><strong>{doc.doc_number || doc.id}</strong></p>
          <p>Date: {doc.issue_date}</p>
          {validUntil && <p>Valid until: {validUntil}</p>}
        </div>
      </div>
      <table className="rp-doc-table">
        <thead>
          <tr><th>Description</th><th>Qty</th><th>Rate</th><th>Amount</th></tr>
        </thead>
        <tbody>
          {(doc.items || []).map((item, i) => (
            <tr key={i}>
              <td>{item.description}</td>
              <td className="rp-doc-table-center">{item.quantity} {item.unit || ''}</td>
              <td className="rp-doc-table-right">{inr(item.rate)}</td>
              <td className="rp-doc-table-right">{inr((item.quantity || 0) * (item.rate || 0))}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="rp-doc-totals">
        {(discount > 0 || gst > 0) && (
          <div className="rp-doc-total-row"><span>Subtotal</span><span>{inr(subtotal)}</span></div>
        )}
        {discount > 0 && <div className="rp-doc-total-row"><span>Discount</span><span>−{inr(discount)}</span></div>}
        {gst > 0 && <div className="rp-doc-total-row"><span>GST @ {rate}%</span><span>{inr(gst)}</span></div>}
        <div className="rp-doc-total-row rp-doc-grand-total">
          <span>Order value</span>
          <span>{inr(a.total)}</span>
        </div>
        {a.percent > 0 && (
          <>
            <div className="rp-doc-total-row"><span>Advance payable now ({a.percent}%)</span><span>{inr(a.advance)}</span></div>
            {a.balance > 0 && (
              <div className="rp-doc-total-row"><span>Balance on delivery</span><span>{inr(a.balance)}</span></div>
            )}
          </>
        )}
      </div>
      <p className="rp-doc-disclaimer">
        This is a proforma invoice issued to confirm the order. It is not a tax invoice and
        cannot be used to claim input tax credit; the tax invoice is issued on delivery.
      </p>
    </div>
  );
}

function ProformaActions({
  doc, company, status, orderConfirmed, agreed, setAgreed, readOnly, submitting,
  onConfirm, onPay, showPaymentForm, setShowPaymentForm, showBankDetails, setShowBankDetails,
}) {
  const a = advanceOf(doc);
  const number = doc.doc_number || doc.id;

  if (status === 'converted') {
    return <SuccessCard title="Tax invoice issued" subtitle="This order has moved to its tax invoice. Nothing more is needed here." />;
  }
  if (['advance_paid', 'partially_paid', 'paid'].includes(status)) {
    return (
      <SuccessCard
        title="Advance received"
        subtitle={`Your order is confirmed and ${inr(a.paid || a.advance)} has been received. The tax invoice for the balance follows on delivery.`}
      />
    );
  }
  if (status === 'payment_submitted') {
    return (
      <StatusCard
        icon={<Clock size={28} />}
        color="#b45309"
        title="Advance submitted — being verified"
        subtitle={`${company.company_name || 'The issuer'} is checking your payment against ${number}. You'll hear from them once it's confirmed.`}
      />
    );
  }
  if (['declined', 'cancelled', 'expired'].includes(status)) return null;

  const confirmed = orderConfirmed || status === 'order_confirmed';
  const needsAdvance = a.advanceDue > 0;

  return (
    <div className="rp-card">
      <div className="rp-card-header">
        <CreditCard size={18} />
        <h3>{needsAdvance ? 'Confirm order & pay advance' : 'Confirm order'}</h3>
      </div>

      <div className="rp-amount-breakdown">
        <div className="rp-amount-break-row">
          <span>Order value</span>
          <strong>{inr(a.total)}</strong>
        </div>
        {a.percent > 0 && (
          <div className="rp-amount-break-row rp-amount-highlight">
            <span>Advance ({a.percent}%)</span>
            <strong>{inr(a.advance)}</strong>
            <span className="rp-amount-badge">Now</span>
          </div>
        )}
        {a.balance > 0 && (
          <div className="rp-amount-break-row">
            <span>Balance</span>
            <strong>{inr(a.balance)}</strong>
            <span className="rp-amount-badge rp-amount-badge-muted">On delivery</span>
          </div>
        )}
      </div>

      {doc.payment_rejected && confirmed && (
        <p role="alert" style={{
          margin: '0 0 1rem', padding: '0.625rem 0.75rem', borderRadius: 8,
          background: '#fef2f2', color: '#b91c1c', fontSize: '0.8125rem', lineHeight: 1.5,
        }}>
          Your last payment could not be verified{doc.rejection_reason ? `: ${doc.rejection_reason}` : '.'} Please check the details and submit it again.
        </p>
      )}

      {/* Step 1 — commit to the order. */}
      {!confirmed ? (
        <div className="rp-step">
          <div className="rp-step-num">1</div>
          <div className="rp-step-body">
            <h4 className="rp-step-title">Confirm the order</h4>
            <label className="rp-agree">
              <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
              <span>I confirm the items, quantities and prices in this proforma invoice.</span>
            </label>
            <button className="rp-btn rp-btn-primary" disabled={!agreed || readOnly || !!submitting} onClick={onConfirm}>
              {submitting === 'confirm_order' ? 'Confirming…' : 'Confirm order'}
            </button>
          </div>
        </div>
      ) : (
        <div className="rp-step rp-step-done">
          <div className="rp-step-num rp-step-check"><Check size={12} /></div>
          <span>Order confirmed</span>
        </div>
      )}

      {/* Step 2 — the advance, only once the order stands. */}
      {needsAdvance && (
        <div className="rp-step" style={confirmed ? undefined : { opacity: 0.5 }}>
          <div className="rp-step-num">2</div>
          <div className="rp-step-body">
            <h4 className="rp-step-title">Pay the advance — {inr(a.advanceDue)}</h4>
            {!confirmed ? (
              <p style={{ margin: 0, fontSize: '0.8125rem', color: '#71717a' }}>Payment details appear once the order is confirmed.</p>
            ) : (
              <>
                <UPIQRGenerator
                  upiId={doc.upi_id || company.upi_id}
                  payeeName={company.company_name || doc.issued_by}
                  amount={a.advanceDue}
                  transactionNote={`${number} advance`}
                />
                <button className="rp-bank-toggle" onClick={() => setShowBankDetails(!showBankDetails)}>
                  <Banknote size={15} />
                  <span>Bank transfer</span>
                  <span className="rp-bank-arrow">{showBankDetails ? '−' : '+'}</span>
                </button>
                {showBankDetails && (
                  <div className="rp-bank-details" style={{ marginTop: '0.5rem' }}>
                    <BankRow label="Bank" value={company.bank_name} />
                    <BankRow label="A/C" value={company.bank_account_number} />
                    <BankRow label="IFSC" value={company.bank_ifsc} />
                  </div>
                )}
                {!showPaymentForm ? (
                  <button className="rp-btn rp-btn-primary" disabled={readOnly} onClick={() => setShowPaymentForm(true)}>
                    <Check size={16} /> I have paid the advance
                  </button>
                ) : (
                  <PaymentConfirmationForm amount={a.advanceDue} invoiceId={number} onSubmit={onPay} />
                )}
              </>
            )}
          </div>
        </div>
      )}

      {confirmed && !needsAdvance && (
        <p style={{ margin: 0, fontSize: '0.8125rem', color: '#52525b', lineHeight: 1.55 }}>
          No advance is needed. The tax invoice will be issued on delivery.
        </p>
      )}
    </div>
  );
}
