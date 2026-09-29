import React, { useEffect } from 'react';
import { ArrowRight } from 'lucide-react';

const SubPageNav = () => {
  useEffect(() => {
    const nav = document.querySelector('.eos-nav');
    if (!nav) return;
    const handler = () => {
      nav.classList.toggle('eos-nav-scrolled', window.scrollY > 40);
    };
    window.addEventListener('scroll', handler, { passive: true });
    handler();
    return () => window.removeEventListener('scroll', handler);
  }, []);

  return (
    <nav className="eos-nav">
      <div className="eos-nav-inner">
        <a href="/" className="eos-nav-logo" style={{ textDecoration: 'none' }}>
          <img src="/startupbuddy-wordmark.png" alt="StartupBuddy" className="eos-logo-img" />
        </a>
        <div className="eos-nav-actions">
          <a href="/" className="eos-btn eos-btn-ghost eos-nav-link">Home</a>
          <a href="/" className="eos-btn eos-btn-primary eos-btn-sm">
            Get Started <ArrowRight size={14} />
          </a>
        </div>
      </div>
    </nav>
  );
};

export default SubPageNav;
