import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { authErrorMessage } from '../lib/authErrors';
import { Mail, Lock, ArrowRight, ArrowLeft } from 'lucide-react';
import Registration from './Registration';

const GoogleIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24">
    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
  </svg>
);

const FEATURES = [
  'Offer Letters & Contracts',
  'GST Invoicing',
  'AI Co-founder',
  'Legal Documents',
  'Team Management',
  'Quotations & Proformas',
];

const Auth = () => {
  const navigate = useNavigate();
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const { login, loginWithGoogle } = useAuth();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await login(email, password);
      navigate('/hub', { replace: true });
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setLoading(true);
    setError(null);
    try {
      // Redirect-based: the browser leaves this page and returns to /hub with a
      // session, where AuthContext picks it up. Nothing after this line runs on
      // the success path, so there is no navigate() here.
      await loginWithGoogle();
    } catch (err) {
      setError(authErrorMessage(err));
      setLoading(false);
    }
  };

  if (!isLogin) {
    return <Registration onBack={() => setIsLogin(true)} />;
  }

  return (
    <div className="auth-split-wrapper" data-theme="light">
      {/* Left Side: Editorial Visual */}
      <div className="auth-visual-side">
        <div className="auth-visual-noise" />

        <div className="auth-visual-top">
          <img src="/startupbuddy-wordmark.png" alt="StartupBuddy" className="auth-visual-logo" />
        </div>

        <div className="auth-visual-content">
          <div className="auth-visual-eyebrow">Business Operating System</div>
          <h1 className="auth-hero-title">
            Every document.<br />
            Every deal.<br />
            <em>One workspace.</em>
          </h1>
          <p className="auth-hero-subtitle">
            EdgeOS unifies your documents, finances, and team operations into a single intelligent platform.
          </p>

          <div className="auth-feature-pills">
            {FEATURES.map((f) => (
              <span key={f} className="auth-feature-pill">{f}</span>
            ))}
          </div>
        </div>

        <div className="auth-visual-bottom">
          <div className="auth-visual-stat">
            <span className="auth-visual-stat-num">10×</span>
            <span className="auth-visual-stat-label">faster document workflow</span>
          </div>
          <div className="auth-visual-stat-divider" />
          <div className="auth-visual-stat">
            <span className="auth-visual-stat-num">100%</span>
            <span className="auth-visual-stat-label">GST compliant invoicing</span>
          </div>
        </div>
      </div>

      {/* Right Side: Form */}
      <div className="auth-form-side">
        <div className="auth-form-container">
          <button className="auth-back-btn" onClick={() => navigate('/')}>
            <ArrowLeft size={14} /> Back to home
          </button>

          <div className="auth-form-header">
            <h2 className="auth-form-title">Welcome back</h2>
            <p className="auth-form-subtitle">Sign in to your EdgeOS workspace.</p>
          </div>

          {error && (
            <div className="auth-error-banner">{error}</div>
          )}

          <button
            type="button"
            onClick={handleGoogleSignIn}
            disabled={loading}
            className="auth-google-btn"
          >
            <GoogleIcon />
            Continue with Google
          </button>

          <div className="auth-divider">
            <div className="auth-divider-line" />
            <span className="auth-divider-text">or</span>
            <div className="auth-divider-line" />
          </div>

          <form onSubmit={handleSubmit}>
            <div className="auth-field">
              <label className="auth-label">Email</label>
              <div className="auth-input-wrapper">
                <Mail size={15} className="auth-input-icon" />
                <input
                  type="email"
                  placeholder="name@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className="auth-input"
                />
              </div>
            </div>

            <div className="auth-field-last">
              <label className="auth-label">Password</label>
              <div className="auth-input-wrapper">
                <Lock size={15} className="auth-input-icon" />
                <input
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="auth-input"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="auth-submit-btn"
            >
              {loading ? 'Signing in…' : 'Sign In'}
              {!loading && <ArrowRight size={17} />}
            </button>
          </form>

          <div className="auth-footer">
            <button
              onClick={() => setIsLogin(false)}
              className="auth-switch-btn"
            >
              Don't have an account? <span>Get started</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Auth;
