import React from 'react';
import { Globe } from 'lucide-react';

const SubPageFooter = () => (
  <footer className="eos-footer">
    <div className="eos-container">
      <div className="eos-footer-grid">
        <div className="eos-footer-brand">
          <a href="/" className="eos-nav-logo" style={{ marginBottom: '0.5rem', textDecoration: 'none' }}>
            <img src="/startupbuddy-wordmark.png" alt="StartupBuddy" className="eos-logo-img" />
          </a>
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
);

export default SubPageFooter;
