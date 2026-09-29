import React, { useState, useRef, useEffect } from 'react';
import {
  ArrowRight, Zap, Shield, Clock, Star, Check, Mail,
  FileText, Receipt, Scale, Award, Briefcase, BarChart3,
  ChevronRight, ChevronDown, Users, FileCheck, TrendingUp, Globe,
  Lock, CreditCard, Send, Layers, ArrowUpRight, Activity,
  Menu, X, Sparkles, Brain, MessageSquare, Crown
} from 'lucide-react';
import './LandingPage.css';
import { useScrollParallax } from '../hooks/useScrollParallax';
import { useCardGlow } from '../hooks/useCardGlow';

const FEATURE_ITEMS = [
  { href: '/ai-cofounder', icon: Sparkles, label: 'AI Co-founder', desc: 'Decisions, follow-ups & live business intelligence' },
  { href: '/invoicing', icon: Receipt, label: 'Invoicing', desc: 'GST-compliant tax invoices & billing' },
  { href: '/quotations', icon: FileText, label: 'Quotations', desc: 'Dynamic quotes with revision tracking' },
  { href: '/offer-letters', icon: Briefcase, label: 'Offer Letters', desc: 'Professional employment offers' },
  { href: '/legal-documents', icon: Scale, label: 'Legal Documents', desc: 'MoUs, NDAs & agreements' },
  { href: '/certificates', icon: Award, label: 'Certificates', desc: 'Branded certificates with QR codes' },
];

const LandingPage = ({ onEnter }) => {
  const landingRef = useRef(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [mobileFeaturesOpen, setMobileFeaturesOpen] = useState(false);
  useCardGlow(landingRef);
  useScrollParallax();

  // Force light theme
  useEffect(() => {
    const prev = document.documentElement.getAttribute('data-theme');
    document.documentElement.setAttribute('data-theme', 'light');
    return () => document.documentElement.setAttribute('data-theme', prev || 'light');
  }, []);

  // Navbar scroll effect
  useEffect(() => {
    const nav = document.querySelector('.eos-nav');
    if (!nav) return;
    const handler = () => {
      nav.classList.toggle('eos-nav-scrolled', window.scrollY > 40);
    };
    window.addEventListener('scroll', handler, { passive: true });
    return () => window.removeEventListener('scroll', handler);
  }, []);


  const chartBars = [35, 55, 42, 68, 52, 78, 45, 60, 80, 65, 90, 72, 85, 58, 95, 70, 88, 62, 75, 92];

  return (
    <div className="eos-landing" ref={landingRef}>
      {/* ════════════════ NAVIGATION ════════════════ */}
      <nav className="eos-nav">
        <div className="eos-nav-inner">
          <div className="eos-nav-logo">
            <img src="/startupbuddy-wordmark.png" alt="StartupBuddy" className="eos-logo-img" />
          </div>

          <div className="eos-nav-links">
            <div className="eos-nav-dropdown">
              <a href="#features" className="eos-nav-link eos-nav-link-features">
                Features <ChevronDown size={14} className="eos-chevron-icon" />
              </a>
              <div className="eos-features-dropdown">
                <div className="eos-features-dropdown-inner">
                  {FEATURE_ITEMS.map((item) => {
                    const Icon = item.icon;
                    return (
                      <a key={item.href} href={item.href} className="eos-dropdown-item">
                        <div className="eos-dropdown-item-icon">
                          <Icon size={18} />
                        </div>
                        <div className="eos-dropdown-item-text">
                          <span className="eos-dropdown-item-label">{item.label}</span>
                          <span className="eos-dropdown-item-desc">{item.desc}</span>
                        </div>
                      </a>
                    );
                  })}
                </div>
              </div>
            </div>
            <a href="/ai-cofounder" className="eos-nav-link eos-nav-link-cofounder">
              <Sparkles size={13} /> AI Co-founder
            </a>
            <a href="#how-it-works" className="eos-nav-link">How It Works</a>
            <a href="/pricing" className="eos-nav-link">Pricing</a>
            <a href="#testimonials" className="eos-nav-link">Testimonials</a>
          </div>

          <div className="eos-nav-actions">
            <button onClick={onEnter} className="eos-btn eos-btn-ghost">Sign In</button>
            <button onClick={onEnter} className="eos-btn eos-btn-primary" style={{ padding: '0.5rem 1.25rem' }}>
              Get Started
            </button>
            <button
              className="eos-mobile-menu-btn"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open menu"
            >
              <Menu size={22} />
            </button>
          </div>
        </div>
      </nav>

      {/* ════════════════ MOBILE MENU ════════════════ */}
      {mobileMenuOpen && (
        <div className="eos-mobile-overlay" onClick={() => setMobileMenuOpen(false)}>
          <div className="eos-mobile-menu" onClick={(e) => e.stopPropagation()}>
            <div className="eos-mobile-menu-header">
              <img src="/startupbuddy-wordmark.png" alt="StartupBuddy" className="eos-logo-img" style={{ height: 40 }} />
              <button
                className="eos-mobile-close-btn"
                onClick={() => setMobileMenuOpen(false)}
                aria-label="Close menu"
              >
                <X size={20} />
              </button>
            </div>

            <div className="eos-mobile-menu-body">
              {/* Features Accordion */}
              <button
                className={`eos-mobile-nav-link eos-mobile-features-trigger ${mobileFeaturesOpen ? 'open' : ''}`}
                onClick={() => setMobileFeaturesOpen(!mobileFeaturesOpen)}
              >
                Features
                <ChevronDown size={16} className={`eos-mobile-chevron ${mobileFeaturesOpen ? 'rotated' : ''}`} />
              </button>
              <div className={`eos-mobile-features-list ${mobileFeaturesOpen ? 'open' : ''}`}>
                {FEATURE_ITEMS.map((item) => {
                  const Icon = item.icon;
                  return (
                    <a key={item.href} href={item.href} className="eos-mobile-feature-item" onClick={() => setMobileMenuOpen(false)}>
                      <Icon size={16} />
                      <span>{item.label}</span>
                    </a>
                  );
                })}
              </div>

              <a href="/ai-cofounder" className="eos-mobile-nav-link eos-mobile-cofounder" onClick={() => setMobileMenuOpen(false)}>
                <Sparkles size={15} /> AI Co-founder
              </a>
              <a href="#how-it-works" className="eos-mobile-nav-link" onClick={() => setMobileMenuOpen(false)}>How It Works</a>
              <a href="/pricing" className="eos-mobile-nav-link" onClick={() => setMobileMenuOpen(false)}>Pricing</a>
              <a href="#testimonials" className="eos-mobile-nav-link" onClick={() => setMobileMenuOpen(false)}>Testimonials</a>
            </div>

            <div className="eos-mobile-menu-footer">
              <button onClick={() => { setMobileMenuOpen(false); onEnter(); }} className="eos-btn eos-btn-primary" style={{ width: '100%', justifyContent: 'center' }}>
                Get Started <ArrowRight size={16} />
              </button>
              <button onClick={() => { setMobileMenuOpen(false); onEnter(); }} className="eos-btn eos-btn-ghost" style={{ width: '100%', justifyContent: 'center' }}>
                Sign In
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ════════════════ HERO ════════════════ */}
      <section className="eos-hero">
        <div className="eos-hero-glow" />
        <div className="eos-hero-grid-bg" />

        {/* Floating labels */}
        <div className="eos-float-labels">
          <div className="eos-float-label eos-fl-1">
            <div className="eos-float-dot" />
            Invoicing
          </div>
          <div className="eos-float-label eos-fl-2">
            <Receipt size={12} />
            Proforma
          </div>
          <div className="eos-float-label eos-fl-3">
            <Scale size={12} />
            MoU & NDA
          </div>
          <div className="eos-float-label eos-fl-4">
            <FileText size={12} />
            Offer Letters
          </div>
          <div className="eos-float-label eos-fl-5">
            <BarChart3 size={12} />
            Analytics
          </div>
          <div className="eos-float-label eos-fl-6">
            <Award size={12} />
            Certificates
          </div>
        </div>

        <div className="eos-container">
          <div className="eos-hero-content">
            <span className="eos-hero-eyebrow">EdgeOS · The Royal Business OS</span>

            <h1 className="eos-hero-title">
              The Business OS,<br />
              <em>reimagined</em> for the<br />
              AI <span className="eos-hero-title-amp">&amp;</span> founder era.
            </h1>

            <p className="eos-hero-subtitle">
              Documents, finances, hiring, decisions — every operation distilled into one calm workspace, with an AI Co-founder that reads your live data and runs alongside you.
            </p>

            <div className="eos-hero-actions">
              <button onClick={onEnter} className="eos-btn eos-btn-primary">
                Get Started Free <ArrowRight size={16} />
              </button>
              <a href="/ai-cofounder" className="eos-btn eos-btn-secondary">
                Meet the AI Co-founder
              </a>
            </div>

            <div className="eos-hero-meta">
              <span className="eos-hero-meta-item"><Check size={14} /> No credit card</span>
              <span className="eos-hero-meta-item"><Sparkles size={14} /> AI-native by default</span>
              <span className="eos-hero-meta-item"><Lock size={14} /> Your data, never trained on</span>
            </div>
          </div>
        </div>
      </section>

      {/* ════════════════ TRUST / LOGOS ════════════════ */}
      {/* TODO: Revive once we have real customer logos / data
      <section className="eos-trust">
        <div className="eos-container">
          <p className="eos-trust-label eos-parallax">Trusted by forward-thinking teams</p>
          <div className="eos-logo-slider">
            <div className="eos-logo-track">
              {[...logoItems, ...logoItems].map((name, i) => (
                <div key={i} className="eos-logo-item">
                  <Activity size={16} />
                  {name}
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
      */}

      {/* ════════════════ DASHBOARD PREVIEW ════════════════ */}
      <section className="eos-dashboard-section">
        <div className="eos-container">
          <div className="eos-section-header eos-parallax">
            <div className="eos-section-badge"><Layers size={12} /> Live Preview</div>
            <h2 className="eos-section-title">Your <em>command</em> center.</h2>
            <p className="eos-section-subtitle">
              Track every document, payment, and client interaction from a single, intuitive dashboard.
            </p>
          </div>

          <div className="eos-dashboard-frame eos-parallax">
            <div className="eos-dashboard-topbar">
              <div className="eos-dashboard-dot" />
              <div className="eos-dashboard-dot" />
              <div className="eos-dashboard-dot" />
              <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: 'var(--eos-text-muted)' }}>
                dashboard.edgeos.app
              </span>
            </div>
            <div className="eos-dashboard-body">
              <div className="eos-dashboard-sidebar">
                <div className="eos-dash-menu-item active"><BarChart3 size={15} /> Dashboard</div>
                <div className="eos-dash-menu-item"><FileText size={15} /> Quotations</div>
                <div className="eos-dash-menu-item"><Receipt size={15} /> Invoices</div>
                <div className="eos-dash-menu-item"><CreditCard size={15} /> Proformas</div>
                <div className="eos-dash-menu-item"><Briefcase size={15} /> Offer Letters</div>
                <div className="eos-dash-menu-item"><Scale size={15} /> MoU / NDA</div>
                <div className="eos-dash-menu-item"><Award size={15} /> Certificates</div>
                <div className="eos-dash-menu-item"><Users size={15} /> Clients</div>
              </div>
              <div className="eos-dashboard-main">
                <div className="eos-dash-stats-row">
                  <div className="eos-dash-stat-card">
                    <div className="eos-dash-stat-label">Revenue</div>
                    <div className="eos-dash-stat-value">$24.8K</div>
                    <div className="eos-dash-stat-change">+18.2% this month</div>
                  </div>
                  <div className="eos-dash-stat-card">
                    <div className="eos-dash-stat-label">Documents</div>
                    <div className="eos-dash-stat-value">1,247</div>
                    <div className="eos-dash-stat-change">+34 today</div>
                  </div>
                  <div className="eos-dash-stat-card">
                    <div className="eos-dash-stat-label">Clients</div>
                    <div className="eos-dash-stat-value">89</div>
                    <div className="eos-dash-stat-change">+7 this week</div>
                  </div>
                </div>
                <div className="eos-dash-chart">
                  {chartBars.map((h, i) => (
                    <div key={i} className="eos-chart-bar" style={{ height: `${h}%` }} />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ════════════════ FEATURES BENTO ════════════════ */}
      <section id="features" className="eos-section">
        <div className="eos-container">
          <div className="eos-section-header eos-parallax">
            <div className="eos-section-badge"><Zap size={12} /> The Complete Suite</div>
            <h2 className="eos-section-title">Everything you need.<br /><em>Nothing</em> you don't.</h2>
            <p className="eos-section-subtitle">
              From quotations to certificates — manage your entire business document pipeline in one calm, opinionated workspace.
            </p>
          </div>

          <div className="eos-features-grid">
            {/* AI CO-FOUNDER — full width hero card */}
            <a href="/ai-cofounder" className="eos-feature-card eos-fc-cofounder eos-fc-span-12 eos-parallax" style={{ textDecoration: 'none', color: 'inherit', cursor: 'pointer' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '2rem', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 280 }}>
                  <div className="eos-fc-badge eos-fc-badge-glow">
                    <Sparkles size={11} /> Flagship Capability
                  </div>
                  <h3 className="eos-fc-title" style={{ marginTop: '1rem', fontSize: 'clamp(1.5rem, 3vw, 2.25rem)' }}>
                    AI Co-founder
                  </h3>
                  <p className="eos-fc-desc" style={{ maxWidth: 720 }}>
                    A real co-founder built into EdgeOS — not a chatbot. It reads your live business data, makes structured decisions, drafts polite-firm-urgent follow-ups to clients and team, runs guided onboarding, remembers your facts, opportunities & risks, and answers any question about your company in seconds. Always context-aware. Never invents data.
                  </p>
                  <div className="eos-cf-skills">
                    <div className="eos-cf-skill"><Brain size={14} /> Decision Mode</div>
                    <div className="eos-cf-skill"><MessageSquare size={14} /> Follow-up Drafts</div>
                    <div className="eos-cf-skill"><Activity size={14} /> Live Business Data</div>
                    <div className="eos-cf-skill"><Layers size={14} /> Memory & Insights</div>
                    <div className="eos-cf-skill"><Send size={14} /> Email & WhatsApp</div>
                  </div>
                  <div style={{ marginTop: '1.5rem', display: 'inline-flex', alignItems: 'center', gap: '0.4rem', color: 'var(--eos-text)', fontWeight: 600, fontSize: '0.875rem' }}>
                    Explore the AI Co-founder <ArrowUpRight size={16} />
                  </div>
                </div>
                <div className="eos-cf-preview" aria-hidden>
                  <div className="eos-cf-bubble eos-cf-bubble-user">
                    Should I hire another designer this quarter?
                  </div>
                  <div className="eos-cf-bubble eos-cf-bubble-ai">
                    <span className="eos-cf-bubble-tag">DECISION</span>
                    Hold off until Q3. Pending revenue (₹4.2L) covers 1.5 months of runway, and your last 3 invoices closed faster — pipeline {'>'} capacity right now.
                  </div>
                  <div className="eos-cf-bubble eos-cf-bubble-user">
                    Draft a polite follow-up for the Acme invoice
                  </div>
                  <div className="eos-cf-bubble eos-cf-bubble-ai eos-cf-bubble-typing">
                    <span className="eos-cf-typing-dot" />
                    <span className="eos-cf-typing-dot" />
                    <span className="eos-cf-typing-dot" />
                  </div>
                </div>
              </div>
            </a>

            {/* Row 1 */}
            <div className="eos-feature-card eos-fc-span-7 eos-parallax">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div className="eos-fc-badge">Financial Suite</div>
                <TrendingUp size={20} style={{ color: 'var(--eos-accent)' }} />
              </div>
              <h3 className="eos-fc-title" style={{ marginTop: '1rem' }}>Smart Invoicing & Quotations</h3>
              <p className="eos-fc-desc">
                Create GST-compliant tax invoices with auto-calculated CGST, SGST, and IGST. Build dynamic quotations with full revision tracking — clients can accept, request changes, or reject directly from a branded portal. Generate proforma invoices with advance payment splits and convert them into final tax invoices in one click. Track making costs per line item to see real profit margins (hidden from clients). Export polished PDFs and share instantly via WhatsApp or email.
              </p>
              <div className="eos-fc-image">
                <svg viewBox="0 0 480 210" fill="none" xmlns="http://www.w3.org/2000/svg" className="eos-fc-svg">
                  <defs>
                    <filter id="g1" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="5" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
                    <filter id="g1s" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="8" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
                    <radialGradient id="ig" cx="70%" cy="90%" r="55%"><stop offset="0" stopColor="rgba(255,255,255,0.15)" /><stop offset="1" stopColor="transparent" /></radialGradient>
                  </defs>
                  <rect x="8" y="5" width="464" height="200" rx="12" fill="#0a0a0a" stroke="rgba(255,255,255,0.15)" strokeWidth="1" />
                  <rect x="8" y="5" width="464" height="200" rx="12" fill="url(#ig)" />
                  {/* Header */}
                  <rect x="28" y="22" width="70" height="10" rx="5" fill="rgba(255,255,255,0.7)" />
                  <rect x="28" y="36" width="100" height="5" rx="2.5" fill="rgba(255,255,255,0.3)" />
                  <rect x="370" y="20" width="80" height="18" rx="9" fill="rgba(255,255,255,0.12)" stroke="rgba(255,255,255,0.4)" strokeWidth="0.7" />
                  <text x="410" y="32" textAnchor="middle" fill="rgba(255,255,255,0.9)" fontSize="7" fontWeight="600" fontFamily="Inter,sans-serif">INVOICE</text>
                  <line x1="28" y1="52" x2="452" y2="52" stroke="rgba(255,255,255,0.15)" strokeWidth="0.5" />
                  {/* Table headers */}
                  {[['28', '60'], ['200', '35'], ['290', '35'], ['380', '50']].map(([x, w], i) => (
                    <rect key={i} x={x} y="60" width={w} height="5" rx="2.5" fill="rgba(255,255,255,0.5)" />
                  ))}
                  {/* Data rows */}
                  {[78, 96, 114].map((y, i) => (
                    <g key={i}>
                      {i % 2 === 0 && <rect x="20" y={y - 4} width="440" height="16" rx="4" fill="rgba(255,255,255,0.04)" />}
                      <rect x="28" y={y} width={120 - i * 15} height="4" rx="2" fill="rgba(255,255,255,0.35)" />
                      <rect x="200" y={y} width="22" height="4" rx="2" fill="rgba(255,255,255,0.25)" />
                      <rect x="290" y={y} width="35" height="4" rx="2" fill="rgba(255,255,255,0.25)" />
                      <rect x="380" y={y} width="48" height="4" rx="2" fill="rgba(255,255,255,0.4)" />
                    </g>
                  ))}
                  {/* Totals */}
                  <line x1="280" y1="138" x2="452" y2="138" stroke="rgba(255,255,255,0.2)" strokeWidth="0.5" />
                  <rect x="290" y="146" width="50" height="5" rx="2.5" fill="rgba(255,255,255,0.4)" />
                  <rect x="395" y="144" width="55" height="9" rx="4.5" fill="rgba(255,255,255,0.55)" filter="url(#g1)" />
                  <rect x="290" y="162" width="35" height="4" rx="2" fill="rgba(255,255,255,0.3)" />
                  <rect x="400" y="162" width="48" height="4" rx="2" fill="rgba(255,255,255,0.25)" />
                  {/* Grand total — bright glow */}
                  <line x1="280" y1="176" x2="452" y2="176" stroke="rgba(255,255,255,0.25)" strokeWidth="0.7" />
                  <rect x="290" y="183" width="60" height="7" rx="3.5" fill="rgba(255,255,255,0.6)" filter="url(#g1)" />
                  <rect x="388" y="182" width="64" height="10" rx="5" fill="#fff" opacity="0.75" filter="url(#g1s)" />
                </svg>
              </div>
              <div className="eos-fc-metrics">
                <div className="eos-fc-metric">
                  <div className="eos-fc-metric-value">12.5K</div>
                  <div className="eos-fc-metric-label">Invoices</div>
                </div>
                <div className="eos-fc-metric">
                  <div className="eos-fc-metric-value">$2.4M</div>
                  <div className="eos-fc-metric-label">Processed</div>
                </div>
                <div className="eos-fc-metric">
                  <div className="eos-fc-metric-value">+18%</div>
                  <div className="eos-fc-metric-label">Growth</div>
                </div>
              </div>
            </div>

            <div className="eos-feature-card eos-fc-span-5 eos-parallax">
              <div className="eos-fc-icon"><Scale size={22} /></div>
              <h3 className="eos-fc-title">Legal MoUs & NDAs</h3>
              <p className="eos-fc-desc">
                Draft comprehensive Memorandums of Understanding and Non-Disclosure Agreements from professional templates. Define disclosing and receiving parties, set obligation periods, specify non-solicitation terms, and include custom purpose clauses. Both parties sign with separate signature blocks that include name, designation, and date. Every document is stored with a unique ID, timestamp, and version history for full compliance and audit readiness.
              </p>
              <div className="eos-fc-image">
                <svg viewBox="0 0 320 210" fill="none" xmlns="http://www.w3.org/2000/svg" className="eos-fc-svg">
                  <defs>
                    <filter id="g2" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="5" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
                    <filter id="g2b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="8" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
                    <radialGradient id="mg" cx="50%" cy="80%" r="45%"><stop offset="0" stopColor="rgba(255,255,255,0.12)" /><stop offset="1" stopColor="transparent" /></radialGradient>
                  </defs>
                  <rect x="10" y="5" width="300" height="200" rx="12" fill="#0a0a0a" stroke="rgba(255,255,255,0.15)" strokeWidth="1" />
                  <rect x="10" y="5" width="300" height="200" rx="12" fill="url(#mg)" />
                  {/* Title */}
                  <rect x="85" y="20" width="150" height="10" rx="5" fill="rgba(255,255,255,0.7)" />
                  <rect x="70" y="36" width="180" height="5" rx="2.5" fill="rgba(255,255,255,0.3)" />
                  <line x1="50" y1="50" x2="270" y2="50" stroke="rgba(255,255,255,0.15)" strokeWidth="0.5" />
                  {/* Text lines */}
                  {[60, 68, 76, 84].map((y, i) => (
                    <rect key={i} x="32" y={y} width={260 - (i === 3 ? 80 : i === 1 ? 20 : 0)} height="3.5" rx="1.75" fill={`rgba(255,255,255,${0.2 + i * 0.03})`} />
                  ))}
                  {[98, 106, 114, 122].map((y, i) => (
                    <rect key={`b${i}`} x="32" y={y} width={260 - (i === 3 ? 100 : i === 1 ? 30 : 0)} height="3.5" rx="1.75" fill={`rgba(255,255,255,${0.18 + i * 0.03})`} />
                  ))}
                  {/* Signatures — bright white glow */}
                  <line x1="32" y1="150" x2="140" y2="150" stroke="rgba(255,255,255,0.3)" strokeWidth="0.7" strokeDasharray="3 2" />
                  <line x1="180" y1="150" x2="288" y2="150" stroke="rgba(255,255,255,0.3)" strokeWidth="0.7" strokeDasharray="3 2" />
                  <path d="M45 142 Q58 128 70 138 Q80 148 92 134 Q100 126 112 136" stroke="#fff" strokeWidth="1.5" fill="none" strokeLinecap="round" filter="url(#g2)" />
                  <path d="M195 142 Q208 126 218 137 Q226 148 238 132 Q246 124 258 135" stroke="#fff" strokeWidth="1.5" fill="none" strokeLinecap="round" filter="url(#g2)" />
                  <rect x="48" y="156" width="65" height="4" rx="2" fill="rgba(255,255,255,0.4)" />
                  <rect x="198" y="156" width="65" height="4" rx="2" fill="rgba(255,255,255,0.4)" />
                  {/* Seal — glowing white */}
                  <circle cx="160" cy="182" r="16" stroke="#fff" strokeWidth="1.5" fill="rgba(255,255,255,0.08)" filter="url(#g2b)" />
                  <circle cx="160" cy="182" r="11" stroke="rgba(255,255,255,0.5)" strokeWidth="0.7" fill="none" />
                  <text x="160" y="185" textAnchor="middle" fill="rgba(255,255,255,0.85)" fontSize="5.5" fontWeight="700" fontFamily="Inter,sans-serif">SEAL</text>
                </svg>
              </div>
            </div>

            {/* Row 2 */}
            <div className="eos-feature-card eos-fc-span-5 eos-parallax">
              <div className="eos-fc-icon"><Award size={22} /></div>
              <h3 className="eos-fc-title">Certificates</h3>
              <p className="eos-fc-desc">
                Issue beautifully designed landscape certificates with gold accents, calligraphic fonts, and your organization's branding. Perfect for training programs, internship completions, and employee recognition. Each certificate includes a unique verification ID and QR code so third parties can verify authenticity instantly. Generate certificates one at a time or in bulk by uploading a CSV of recipients. Distribute via email or WhatsApp with high-quality PDF downloads.
              </p>
              <div className="eos-fc-image">
                <svg viewBox="0 0 320 210" fill="none" xmlns="http://www.w3.org/2000/svg" className="eos-fc-svg">
                  <defs>
                    <filter id="g3" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
                    <filter id="g3b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="10" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
                    <linearGradient id="cb" x1="0" y1="0" x2="320" y2="210" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="rgba(255,255,255,0.5)" /><stop offset="0.5" stopColor="rgba(255,255,255,0.12)" /><stop offset="1" stopColor="rgba(255,255,255,0.5)" /></linearGradient>
                    <radialGradient id="cg" cx="50%" cy="25%" r="50%"><stop offset="0" stopColor="rgba(255,255,255,0.15)" /><stop offset="1" stopColor="transparent" /></radialGradient>
                  </defs>
                  <rect x="10" y="5" width="300" height="200" rx="6" fill="#0a0a0a" stroke="url(#cb)" strokeWidth="1.5" />
                  <rect x="10" y="5" width="300" height="200" rx="6" fill="url(#cg)" />
                  <rect x="20" y="15" width="280" height="180" rx="4" stroke="rgba(255,255,255,0.15)" strokeWidth="0.5" fill="none" strokeDasharray="6 3" />
                  {/* Star — bright white glow */}
                  <polygon points="160,28 165,43 180,43 168,52 172,67 160,58 148,67 152,52 140,43 155,43" fill="#fff" opacity="0.7" filter="url(#g3b)" />
                  {/* Title */}
                  <rect x="90" y="78" width="140" height="9" rx="4.5" fill="rgba(255,255,255,0.7)" />
                  <rect x="75" y="94" width="170" height="5" rx="2.5" fill="rgba(255,255,255,0.35)" />
                  {/* Name — glowing white */}
                  <rect x="85" y="112" width="150" height="8" rx="4" fill="#fff" opacity="0.6" filter="url(#g3)" />
                  <line x1="70" y1="126" x2="250" y2="126" stroke="rgba(255,255,255,0.25)" strokeWidth="0.5" />
                  {/* Description */}
                  <rect x="55" y="136" width="210" height="3.5" rx="1.75" fill="rgba(255,255,255,0.2)" />
                  <rect x="70" y="144" width="180" height="3.5" rx="1.75" fill="rgba(255,255,255,0.2)" />
                  {/* Bottom */}
                  <line x1="35" y1="160" x2="95" y2="160" stroke="rgba(255,255,255,0.25)" strokeWidth="0.5" strokeDasharray="2 1.5" />
                  <rect x="40" y="164" width="50" height="3.5" rx="1.75" fill="rgba(255,255,255,0.3)" />
                  <line x1="225" y1="160" x2="285" y2="160" stroke="rgba(255,255,255,0.25)" strokeWidth="0.5" strokeDasharray="2 1.5" />
                  <path d="M235 154 Q245 142 255 152 Q262 160 272 148" stroke="#fff" strokeWidth="1.2" fill="none" strokeLinecap="round" filter="url(#g3)" />
                  <rect x="230" y="164" width="50" height="3.5" rx="1.75" fill="rgba(255,255,255,0.3)" />
                  {/* QR */}
                  <rect x="138" y="160" width="24" height="24" rx="3" fill="rgba(255,255,255,0.1)" stroke="rgba(255,255,255,0.4)" strokeWidth="0.7" />
                  <g opacity="0.7">
                    <rect x="142" y="164" width="5" height="5" rx="1" fill="#fff" /><rect x="149" y="164" width="5" height="5" rx="1" fill="#fff" />
                    <rect x="142" y="171" width="3" height="5" rx="0.5" fill="#fff" /><rect x="147" y="171" width="5" height="3" rx="0.5" fill="#fff" />
                    <rect x="154" y="171" width="5" height="5" rx="1" fill="#fff" /><rect x="155" y="164" width="3" height="3" rx="0.5" fill="#fff" />
                    <rect x="142" y="178" width="5" height="3" rx="0.5" fill="#fff" /><rect x="149" y="178" width="3" height="3" rx="0.5" fill="#fff" />
                    <rect x="154" y="178" width="5" height="3" rx="0.5" fill="#fff" />
                  </g>
                </svg>
              </div>
            </div>

            <div className="eos-feature-card eos-fc-span-7 eos-parallax">
              <div style={{ display: 'flex', gap: '2rem', alignItems: 'center' }}>
                <div style={{ flex: 1 }}>
                  <div className="eos-fc-badge">HR Suite</div>
                  <h3 className="eos-fc-title" style={{ marginTop: '0.75rem' }}>Offer Letters</h3>
                  <p className="eos-fc-desc">
                    Generate professional offer letters for full-time employees and interns. Customize with your company logo, digital signature, job title, department, compensation details, start date, and reporting manager. Recipients receive the offer through a branded portal where they can review all terms, digitally sign, and confirm acceptance — no account required. Track acceptance status in real time. Upload a CSV to generate hundreds of personalized offers in one batch.
                  </p>
                </div>
              </div>
              <div className="eos-fc-image">
                <svg viewBox="0 0 480 210" fill="none" xmlns="http://www.w3.org/2000/svg" className="eos-fc-svg">
                  <defs>
                    <filter id="g4" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="5" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
                    <filter id="g4b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="8" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
                    <radialGradient id="og" cx="15%" cy="15%" r="55%"><stop offset="0" stopColor="rgba(255,255,255,0.12)" /><stop offset="1" stopColor="transparent" /></radialGradient>
                  </defs>
                  <rect x="8" y="5" width="464" height="200" rx="12" fill="#0a0a0a" stroke="rgba(255,255,255,0.15)" strokeWidth="1" />
                  <rect x="8" y="5" width="464" height="200" rx="12" fill="url(#og)" />
                  {/* Logo */}
                  <rect x="28" y="18" width="32" height="32" rx="8" fill="rgba(255,255,255,0.12)" stroke="rgba(255,255,255,0.35)" strokeWidth="0.7" />
                  <rect x="35" y="28" width="18" height="4" rx="2" fill="rgba(255,255,255,0.6)" />
                  <rect x="37" y="36" width="12" height="2.5" rx="1.25" fill="rgba(255,255,255,0.3)" />
                  <rect x="68" y="22" width="90" height="8" rx="4" fill="rgba(255,255,255,0.65)" />
                  <rect x="68" y="36" width="130" height="4" rx="2" fill="rgba(255,255,255,0.25)" />
                  <rect x="380" y="24" width="70" height="5" rx="2.5" fill="rgba(255,255,255,0.3)" />
                  <line x1="28" y1="58" x2="452" y2="58" stroke="rgba(255,255,255,0.15)" strokeWidth="0.5" />
                  {/* Subject */}
                  <rect x="28" y="68" width="180" height="7" rx="3.5" fill="rgba(255,255,255,0.6)" />
                  <rect x="28" y="84" width="110" height="5" rx="2.5" fill="rgba(255,255,255,0.35)" />
                  {/* Body */}
                  {[98, 108, 118, 128].map((y, i) => (
                    <rect key={i} x="28" y={y} width={420 - (i === 3 ? 130 : 0)} height="3.5" rx="1.75" fill={`rgba(255,255,255,${0.15 + i * 0.02})`} />
                  ))}
                  {/* CTC boxes — glowing */}
                  <rect x="28" y="144" width="195" height="24" rx="6" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.25)" strokeWidth="0.7" />
                  <rect x="38" y="150" width="35" height="3.5" rx="1.75" fill="rgba(255,255,255,0.4)" />
                  <rect x="38" y="158" width="60" height="6" rx="3" fill="#fff" opacity="0.6" filter="url(#g4)" />
                  <rect x="240" y="144" width="195" height="24" rx="6" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.25)" strokeWidth="0.7" />
                  <rect x="250" y="150" width="45" height="3.5" rx="1.75" fill="rgba(255,255,255,0.4)" />
                  <rect x="250" y="158" width="70" height="6" rx="3" fill="#fff" opacity="0.6" filter="url(#g4)" />
                  {/* Accept — bright white glow */}
                  <rect x="28" y="180" width="90" height="22" rx="11" fill="#fff" opacity="0.5" filter="url(#g4b)" />
                  <text x="73" y="194" textAnchor="middle" fill="#fff" fontSize="7.5" fontWeight="600" fontFamily="Inter,sans-serif">Accept</text>
                  <rect x="128" y="180" width="90" height="22" rx="11" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="0.7" />
                  <text x="173" y="194" textAnchor="middle" fill="rgba(255,255,255,0.6)" fontSize="7.5" fontFamily="Inter,sans-serif">Decline</text>
                </svg>
              </div>
            </div>

            {/* Row 3 */}
            <div className="eos-feature-card eos-fc-span-4 eos-parallax">
              <div className="eos-fc-icon"><Globe size={22} /></div>
              <h3 className="eos-fc-title">Recipient Portal</h3>
              <p className="eos-fc-desc">
                Every document you send opens in a secure, branded portal customized with your company identity. Recipients can view the full document, download a high-quality PDF, pay advance amounts via UPI QR or bank transfer, and digitally sign — all without creating an account. The portal tracks every interaction including views, downloads, and payments, giving you complete visibility into document status.
              </p>
              <div className="eos-fc-image">
                <svg viewBox="0 0 260 180" fill="none" xmlns="http://www.w3.org/2000/svg" className="eos-fc-svg">
                  <defs>
                    <filter id="g5" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="5" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
                    <filter id="g5b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="8" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
                    <radialGradient id="pg" cx="50%" cy="55%" r="50%"><stop offset="0" stopColor="rgba(255,255,255,0.12)" /><stop offset="1" stopColor="transparent" /></radialGradient>
                  </defs>
                  <rect x="6" y="4" width="248" height="172" rx="10" fill="#0a0a0a" stroke="rgba(255,255,255,0.15)" strokeWidth="1" />
                  <rect x="6" y="4" width="248" height="172" rx="10" fill="url(#pg)" />
                  {/* Title bar */}
                  <rect x="6" y="4" width="248" height="26" rx="10" fill="rgba(255,255,255,0.06)" />
                  <rect x="6" y="22" width="248" height="8" fill="rgba(255,255,255,0.06)" />
                  {/* Traffic dots */}
                  <circle cx="20" cy="17" r="3.5" fill="rgba(255,255,255,0.3)" />
                  <circle cx="31" cy="17" r="3.5" fill="rgba(255,255,255,0.25)" />
                  <circle cx="42" cy="17" r="3.5" fill="rgba(255,255,255,0.2)" />
                  {/* URL bar */}
                  <rect x="56" y="10" width="150" height="14" rx="7" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.2)" strokeWidth="0.5" />
                  <rect x="66" y="15" width="70" height="3.5" rx="1.75" fill="rgba(255,255,255,0.4)" />
                  {/* Lock glow */}
                  <circle cx="140" cy="17" r="4" fill="#fff" opacity="0.4" filter="url(#g5)" />
                  {/* Content */}
                  <rect x="20" y="42" width="90" height="7" rx="3.5" fill="rgba(255,255,255,0.6)" />
                  <rect x="20" y="54" width="55" height="4" rx="2" fill="rgba(255,255,255,0.25)" />
                  {/* Status pill */}
                  <rect x="170" y="42" width="65" height="16" rx="8" fill="rgba(255,255,255,0.1)" stroke="rgba(255,255,255,0.3)" strokeWidth="0.5" />
                  <circle cx="182" cy="50" r="3" fill="#fff" opacity="0.7" filter="url(#g5)" />
                  <rect x="190" y="48" width="32" height="3.5" rx="1.75" fill="rgba(255,255,255,0.4)" />
                  {/* Document card */}
                  <rect x="20" y="68" width="220" height="65" rx="6" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.15)" strokeWidth="0.7" />
                  <rect x="32" y="78" width="90" height="5" rx="2.5" fill="rgba(255,255,255,0.4)" />
                  <rect x="32" y="88" width="150" height="3.5" rx="1.75" fill="rgba(255,255,255,0.2)" />
                  <rect x="32" y="96" width="130" height="3.5" rx="1.75" fill="rgba(255,255,255,0.2)" />
                  <rect x="32" y="104" width="100" height="3.5" rx="1.75" fill="rgba(255,255,255,0.2)" />
                  {/* Amount — bright glow */}
                  <rect x="155" y="115" width="75" height="8" rx="4" fill="#fff" opacity="0.5" filter="url(#g5b)" />
                  {/* Buttons */}
                  <rect x="20" y="146" width="75" height="20" rx="10" fill="#fff" opacity="0.35" filter="url(#g5b)" />
                  <text x="57" y="159" textAnchor="middle" fill="#fff" fontSize="6.5" fontWeight="600" fontFamily="Inter,sans-serif">Download</text>
                  <rect x="103" y="146" width="60" height="20" rx="10" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.3)" strokeWidth="0.5" />
                  <text x="133" y="159" textAnchor="middle" fill="rgba(255,255,255,0.7)" fontSize="6.5" fontFamily="Inter,sans-serif">Pay</text>
                </svg>
              </div>
            </div>

            <div className="eos-feature-card eos-fc-span-4 eos-parallax">
              <div className="eos-fc-icon"><BarChart3 size={22} /></div>
              <h3 className="eos-fc-title">Sales Analytics</h3>
              <p className="eos-fc-desc">
                Monitor your business performance with real-time dashboards. Track total revenue, outstanding payments, and collection rates at a glance. Analyze quotation-to-invoice conversion rates to understand your sales pipeline. View document activity feeds showing recently created, sent, and accepted items. Filter by date range, client, or document type. Use data-driven insights to identify top clients, seasonal trends, and growth opportunities.
              </p>
              <div className="eos-fc-image">
                <svg viewBox="0 0 260 180" fill="none" xmlns="http://www.w3.org/2000/svg" className="eos-fc-svg">
                  <defs>
                    <filter id="g6" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="5" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
                    <filter id="g6b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="8" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
                    <linearGradient id="cg6" x1="0" y1="55" x2="0" y2="148" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="rgba(255,255,255,0.3)" /><stop offset="1" stopColor="rgba(255,255,255,0)" /></linearGradient>
                    <radialGradient id="ag" cx="40%" cy="70%" r="50%"><stop offset="0" stopColor="rgba(255,255,255,0.12)" /><stop offset="1" stopColor="transparent" /></radialGradient>
                    <linearGradient id="lg6" x1="42" y1="0" x2="155" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="rgba(255,255,255,0.4)" /><stop offset="1" stopColor="#fff" /></linearGradient>
                  </defs>
                  <rect x="6" y="4" width="248" height="172" rx="10" fill="#0a0a0a" stroke="rgba(255,255,255,0.15)" strokeWidth="1" />
                  <rect x="6" y="4" width="248" height="172" rx="10" fill="url(#ag)" />
                  {/* Stat cards */}
                  {[{ x: 18, w: 68 }, { x: 94, w: 68 }, { x: 170, w: 68 }].map((c, i) => (
                    <g key={i}>
                      <rect x={c.x} y="16" width={c.w} height="34" rx="6" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.15)" strokeWidth="0.5" />
                      <rect x={c.x + 10} y="24" width="32" height="3.5" rx="1.75" fill="rgba(255,255,255,0.3)" />
                      <rect x={c.x + 10} y="32" width="42" height="7" rx="3.5" fill="rgba(255,255,255,0.6)" />
                      <rect x={c.x + 10} y="43" width="22" height="3" rx="1.5" fill="rgba(255,255,255,0.35)" />
                    </g>
                  ))}
                  {/* Chart area */}
                  <rect x="18" y="58" width="148" height="105" rx="6" fill="rgba(255,255,255,0.03)" stroke="rgba(255,255,255,0.12)" strokeWidth="0.5" />
                  {/* Grid */}
                  {[70, 88, 106, 124].map((y, i) => (
                    <g key={i}>
                      <rect x="22" y={y} width="14" height="2" rx="1" fill="rgba(255,255,255,0.15)" />
                      <line x1="40" y1={y + 1} x2="160" y2={y + 1} stroke="rgba(255,255,255,0.06)" strokeWidth="0.5" />
                    </g>
                  ))}
                  {/* Chart line — bright white glow */}
                  <path d="M42 125 L58 108 L74 115 L90 88 L106 94 L122 74 L138 66 L155 58" stroke="url(#lg6)" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" filter="url(#g6)" />
                  <path d="M42 125 L58 108 L74 115 L90 88 L106 94 L122 74 L138 66 L155 58 L155 148 L42 148 Z" fill="url(#cg6)" />
                  {/* Glowing data points */}
                  {[[90, 88], [122, 74], [155, 58]].map(([cx, cy], i) => (
                    <g key={i}>
                      <circle cx={cx} cy={cy} r="6" fill="#fff" opacity="0.15" filter="url(#g6b)" />
                      <circle cx={cx} cy={cy} r="3" fill="#0a0a0a" stroke="#fff" strokeWidth="1.5" />
                    </g>
                  ))}
                  {/* Tooltip */}
                  <rect x="132" y="40" width="44" height="16" rx="4" fill="rgba(255,255,255,0.15)" stroke="rgba(255,255,255,0.35)" strokeWidth="0.5" />
                  <rect x="138" y="45" width="32" height="5" rx="2.5" fill="rgba(255,255,255,0.65)" />
                  {/* Donut */}
                  <rect x="174" y="58" width="72" height="105" rx="6" fill="rgba(255,255,255,0.03)" stroke="rgba(255,255,255,0.12)" strokeWidth="0.5" />
                  <circle cx="210" cy="88" r="20" stroke="rgba(255,255,255,0.15)" strokeWidth="5" fill="none" />
                  <path d="M210 68 A20 20 0 0 1 230 88" stroke="#fff" strokeWidth="5" fill="none" strokeLinecap="round" filter="url(#g6)" />
                  <path d="M230 88 A20 20 0 0 1 220 106" stroke="rgba(255,255,255,0.5)" strokeWidth="5" fill="none" strokeLinecap="round" />
                  <text x="210" y="91" textAnchor="middle" fill="rgba(255,255,255,0.85)" fontSize="8" fontWeight="700" fontFamily="Inter,sans-serif">68%</text>
                  {/* Legend */}
                  {[{ y: 122, w: 0.8, lw: 32 }, { y: 134, w: 0.5, lw: 28 }, { y: 146, w: 0.25, lw: 36 }].map((l, i) => (
                    <g key={i}>
                      <circle cx="184" cy={l.y} r="2.5" fill={`rgba(255,255,255,${l.w})`} />
                      <rect x="192" y={l.y - 1.5} width={l.lw} height="3" rx="1.5" fill="rgba(255,255,255,0.25)" />
                    </g>
                  ))}
                </svg>
              </div>
            </div>

            <div className="eos-feature-card eos-fc-span-4 eos-parallax">
              <div className="eos-fc-icon"><Lock size={22} /></div>
              <h3 className="eos-fc-title">Enterprise Security</h3>
              <p className="eos-fc-desc">
                Your data is protected with industry-standard security measures. All documents are synced to Firebase cloud with encrypted storage and real-time backup across devices. Access controls ensure only authorized team members can view or edit sensitive documents. Every action — creation, edit, download, and signature — is logged in a complete audit trail. Your company data, banking details, and client information are never shared or exposed.
              </p>
              <div className="eos-fc-image">
                <svg viewBox="0 0 260 180" fill="none" xmlns="http://www.w3.org/2000/svg" className="eos-fc-svg">
                  <defs>
                    <filter id="g7" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
                    <filter id="g7b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="10" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
                    <filter id="g7s" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
                    <radialGradient id="sg" cx="50%" cy="40%" r="40%"><stop offset="0" stopColor="rgba(255,255,255,0.2)" /><stop offset="1" stopColor="transparent" /></radialGradient>
                    <linearGradient id="sf" x1="130" y1="24" x2="130" y2="120" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="rgba(255,255,255,0.15)" /><stop offset="1" stopColor="rgba(255,255,255,0.03)" /></linearGradient>
                  </defs>
                  <rect x="6" y="4" width="248" height="172" rx="10" fill="#0a0a0a" stroke="rgba(255,255,255,0.15)" strokeWidth="1" />
                  <rect x="6" y="4" width="248" height="172" rx="10" fill="url(#sg)" />
                  {/* Orbit rings */}
                  <ellipse cx="130" cy="76" rx="100" ry="35" stroke="rgba(255,255,255,0.08)" strokeWidth="0.5" fill="none" />
                  <ellipse cx="130" cy="76" rx="75" ry="25" stroke="rgba(255,255,255,0.12)" strokeWidth="0.5" fill="none" />
                  {/* Shield — bright white glow */}
                  <path d="M130 24 L165 38 L165 76 C165 100 150 116 130 124 C110 116 95 100 95 76 L95 38 Z" fill="url(#sf)" stroke="#fff" strokeWidth="1.5" opacity="0.6" filter="url(#g7b)" />
                  <path d="M130 36 L157 47 L157 76 C157 94 146 107 130 114 C114 107 103 94 103 76 L103 47 Z" fill="rgba(255,255,255,0.05)" stroke="rgba(255,255,255,0.3)" strokeWidth="0.7" />
                  {/* Checkmark — pure white glow */}
                  <path d="M117 74 L126 84 L145 60" stroke="#fff" strokeWidth="3.5" fill="none" strokeLinecap="round" strokeLinejoin="round" filter="url(#g7b)" />
                  {/* Nodes — left */}
                  {[{ x: 22, y: 36 }, { x: 18, y: 68 }, { x: 22, y: 100 }].map((n, i) => (
                    <g key={i}>
                      <rect x={n.x} y={n.y} width="62" height="24" rx="6" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.2)" strokeWidth="0.5" />
                      <circle cx={n.x + 12} cy={n.y + 12} r="4" fill="#fff" opacity="0.4" filter="url(#g7s)" />
                      <rect x={n.x + 20} y={n.y + 8} width="34" height="3.5" rx="1.75" fill="rgba(255,255,255,0.35)" />
                      <rect x={n.x + 20} y={n.y + 14} width="22" height="2.5" rx="1.25" fill="rgba(255,255,255,0.15)" />
                      <line x1={n.x + 62} y1={n.y + 12} x2="95" y2={i === 0 ? 50 : i === 1 ? 76 : 100} stroke="rgba(255,255,255,0.15)" strokeWidth="0.7" strokeDasharray="3 2" />
                    </g>
                  ))}
                  {/* Nodes — right */}
                  {[{ x: 176, y: 36 }, { x: 180, y: 68 }, { x: 176, y: 100 }].map((n, i) => (
                    <g key={i}>
                      <rect x={n.x} y={n.y} width="62" height="24" rx="6" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.2)" strokeWidth="0.5" />
                      <circle cx={n.x + 50} cy={n.y + 12} r="4" fill="#fff" opacity="0.4" filter="url(#g7s)" />
                      <rect x={n.x + 8} y={n.y + 8} width="34" height="3.5" rx="1.75" fill="rgba(255,255,255,0.35)" />
                      <rect x={n.x + 8} y={n.y + 14} width="22" height="2.5" rx="1.25" fill="rgba(255,255,255,0.15)" />
                      <line x1={n.x} y1={n.y + 12} x2="165" y2={i === 0 ? 50 : i === 1 ? 76 : 100} stroke="rgba(255,255,255,0.15)" strokeWidth="0.7" strokeDasharray="3 2" />
                    </g>
                  ))}
                  {/* Status bar — glowing */}
                  <rect x="50" y="138" width="160" height="8" rx="4" fill="rgba(255,255,255,0.06)" />
                  <rect x="50" y="138" width="128" height="8" rx="4" fill="#fff" opacity="0.25" filter="url(#g7s)" />
                  <text x="130" y="158" textAnchor="middle" fill="rgba(255,255,255,0.6)" fontSize="5.5" fontWeight="500" fontFamily="Inter,sans-serif" letterSpacing="0.5">ALL SYSTEMS PROTECTED</text>
                </svg>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ════════════════ TIMELINE — PARALLAX SCROLL ════════════════ */}
      <section id="how-it-works" className="eos-tl-section">
        <div className="eos-container">
          <div className="eos-section-header eos-parallax" style={{ marginBottom: '6rem' }}>
            <div className="eos-section-badge"><Activity size={12} /> The Process</div>
            <h2 className="eos-section-title">From first invoice to <em>scale</em>.</h2>
            <p className="eos-section-subtitle">
              A step-by-step journey from setup to scaling — making every operation effortless and profitable.
            </p>
          </div>

          <div className="eos-tl-wrapper">
            {/* Progress track */}
            <div className="eos-tl-track">
              <div className="eos-tl-progress-fill" />
            </div>

            {[
              {
                number: '01',
                badge: 'Define',
                title: 'Setup Your Business Identity',
                desc: 'Sign up in under 2 minutes. Add your company logo, address, GSTIN, bank details, and digital signature — your entire business identity, ready to deploy across every document you create.',
                cta: true,
              },
              {
                number: '02',
                badge: 'Create',
                title: 'Generate Any Document Instantly',
                desc: 'Build GST-compliant invoices, dynamic quotations with revision tracking, proforma invoices with advance payment splits, professional offer letters, MoUs, NDAs, and certificates — all from polished templates.',
              },
              {
                number: '03',
                badge: 'Deliver',
                title: 'Share via Branded Portal',
                desc: 'Send documents instantly via WhatsApp or email. Your recipients open a secure, branded portal to view, digitally sign, and pay advances — no login required. Every interaction is tracked live.',
              },
              {
                number: '04',
                badge: 'Automate',
                title: 'Seamless Payment & Conversion',
                desc: 'Convert accepted quotations into proformas, then into tax invoices — one click at each stage. Collect advances via UPI QR or bank transfer. Manage recurring invoices on autopilot.',
              },
              {
                number: '05',
                badge: 'Scale',
                title: 'Analyze, Optimize & Grow',
                desc: 'Real-time revenue dashboards, document conversion rates, outstanding payment tracking, and client activity feeds. Make data-driven decisions and scale your business with absolute confidence.',
              },
            ].map((step, i) => (
              <div key={i} className="eos-tl-step eos-parallax">
                {/* Dot on the line */}
                <div className="eos-tl-dot-wrap">
                  <div className="eos-tl-dot" />
                </div>

                {/* Content */}
                <div className="eos-tl-content">
                  <div className="eos-tl-number">{step.number}</div>
                  <div className="eos-tl-body">
                    <span className="eos-tl-badge">{step.badge}</span>
                    <h3 className="eos-tl-title">{step.title}</h3>
                    <p className="eos-tl-desc">{step.desc}</p>
                    {step.cta && (
                      <button onClick={onEnter} className="eos-btn eos-btn-primary" style={{ marginTop: '1.75rem' }}>
                        Get Started <ArrowUpRight size={16} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ════════════════ TESTIMONIALS ════════════════ */}
      <section id="testimonials" className="eos-section">
        <div className="eos-container">
          <div className="eos-section-header eos-parallax">
            <div className="eos-section-badge"><Star size={12} /> Testimonials</div>
            <h2 className="eos-section-title">Trusted by teams who<br /><em>ship</em> with intent.</h2>
            <p className="eos-section-subtitle">
              Join thousands of businesses that streamlined their operations with EdgeOS.
            </p>
          </div>

          <div className="eos-testimonials-grid">
            {[
              {
                name: 'Sarah Chen',
                role: 'CTO, NovaScale',
                avatar: 'https://images.unsplash.com/photo-1487412720507-e7ab37603c6f?q=80&w=200&h=200&auto=format&fit=crop',
                quote: 'EdgeOS has completely transformed how we handle our corporate document pipelines. What used to take days now takes minutes.',
              },
              {
                name: 'Marcus Thorne',
                role: 'Operations Director, SwiftLegal',
                avatar: 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?q=80&w=200&h=200&auto=format&fit=crop',
                quote: 'The invoicing and payment tracking is unmatched. Our team\'s productivity spiked by 40% in the first month.',
              },
              {
                name: 'Elena Rodriguez',
                role: 'Founder, Vertex AI',
                avatar: 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?q=80&w=200&h=200&auto=format&fit=crop',
                quote: 'Finally a suite that handles MoUs, invoicing, and offer letters with the same level of polish. Indispensable.',
              },
            ].map((t, i) => (
              <div key={i} className="eos-testimonial-card eos-parallax">
                <div className="eos-testimonial-stars">
                  {[...Array(5)].map((_, j) => <Star key={j} size={14} fill="currentColor" />)}
                </div>
                <p className="eos-testimonial-quote">"{t.quote}"</p>
                <div className="eos-testimonial-author">
                  <img src={t.avatar} alt={t.name} className="eos-testimonial-avatar" />
                  <div className="eos-testimonial-info">
                    <h4>{t.name}</h4>
                    <p>{t.role}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ════════════════ PRICING TEASER ════════════════ */}
      <section id="pricing" className="eos-section">
        <div className="eos-container">
          <div className="eos-section-header eos-parallax">
            <div className="eos-section-badge"><CreditCard size={12} /> Pricing</div>
            <h2 className="eos-section-title">Pricing built for <em>every</em><br />stage of your journey.</h2>
            <p className="eos-section-subtitle">
              Free to start. Pro at $12/mo. Max at $54/mo. Enterprise on request. Pick a plan and we'll set up a 15-minute onboarding call.
            </p>
            <div style={{ marginTop: '2rem' }}>
              <a href="/pricing" className="eos-btn eos-btn-primary">
                See All Plans <ArrowRight size={16} />
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ════════════════ CTA ════════════════ */}
      <section className="eos-cta">
        <div className="eos-container">
          <div className="eos-cta-box eos-parallax">
            <h2 className="eos-cta-title">Run a sharper business.<br />Starting today.</h2>
            <p className="eos-cta-subtitle">
              Free to begin. No credit card. Bring your AI Co-founder along — and never stare at a blank invoice again.
            </p>
            <div className="eos-cta-actions">
              <button onClick={onEnter} className="eos-btn eos-btn-primary">
                Get Started Free <ArrowRight size={16} />
              </button>
              <a href="mailto:edgeossuite@gmail.com" className="eos-btn eos-btn-secondary" style={{ textDecoration: 'none' }}>
                Talk to Sales
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ════════════════ FOOTER ════════════════ */}
      <footer className="eos-footer">
        <div className="eos-container">
          <div className="eos-footer-grid">
            <div className="eos-footer-brand">
              <div className="eos-nav-logo" style={{ marginBottom: '0.5rem' }}>
                <img src="/startupbuddy-wordmark.png" alt="StartupBuddy" className="eos-logo-img" />
              </div>
              <p>
                The all-in-one operating system for business documents, financial operations, and team management.
              </p>
            </div>

            <div>
              <div className="eos-footer-col-title">Platform</div>
              <div className="eos-footer-links">
                <a className="eos-footer-link" href="/ai-cofounder">AI Co-founder</a>
                <a className="eos-footer-link" href="/pricing">Pricing</a>
                <a className="eos-footer-link" href="/invoicing">Invoicing</a>
                <a className="eos-footer-link" href="/quotations">Quotations</a>
                <a className="eos-footer-link" href="/offer-letters">Offer Letters</a>
                <a className="eos-footer-link" href="/legal-documents">Legal Documents</a>
                <a className="eos-footer-link" href="/certificates">Certificates</a>
              </div>
            </div>

            <div>
              <div className="eos-footer-col-title">Resources</div>
              <div className="eos-footer-links">
                <a className="eos-footer-link" href="/documentation">Documentation</a>
                <a className="eos-footer-link" href="/support">Support</a>
                <a className="eos-footer-link" href="/changelog">Changelog</a>
              </div>
            </div>

            <div>
              <div className="eos-footer-col-title">Legal</div>
              <div className="eos-footer-links">
                <a className="eos-footer-link" href="/privacy">Privacy Policy</a>
                <a className="eos-footer-link" href="/terms">Terms of Service</a>
                <a className="eos-footer-link" href="/security">Security</a>
              </div>
            </div>
          </div>

          <div className="eos-footer-bottom">
            <div>&copy; 2026 EdgeOS. All rights reserved.</div>
            <div className="eos-footer-socials">
              <a href="#"><Globe size={16} /></a>
              <a href="#">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                </svg>
              </a>
              <a href="#">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14m-.5 15.5v-5.3a3.26 3.26 0 0 0-3.26-3.26c-.85 0-1.84.52-2.32 1.3v-1.11h-2.79v8.37h2.79v-4.93c0-.77.62-1.4 1.39-1.4a1.4 1.4 0 0 1 1.4 1.4v4.93h2.79M6.88 8.56a1.68 1.68 0 0 0 1.68-1.68c0-.93-.75-1.69-1.68-1.69a1.69 1.69 0 0 0-1.69 1.69c0 .93.76 1.68 1.69 1.68m1.39 9.94v-8.37H5.5v8.37h2.77z" />
                </svg>
              </a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default LandingPage;
