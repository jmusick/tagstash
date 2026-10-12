import { HOME_FAQS as faqs, HOME_FEATURES as features } from '../content/homeMarketing'
import { getHomeStructuredData } from '../content/marketingSchema'
import { usePageStructuredData } from '../utils/usePageStructuredData'
import Logo from './Logo'
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { authAPI } from '../api/api';
import ThemeSelector from './ThemeSelector';
import HomeTagDemo from './HomeTagDemo';
import { version } from '../../package.json';
import { useDocumentMeta } from '../utils/useDocumentMeta';
import './Home.css';

function Home({ logoSrc, theme, onSelectTheme }) {
  usePageStructuredData(getHomeStructuredData);
  useDocumentMeta({
    title: 'Tagstash - Tag-Based Bookmark Manager',
    description: 'A tag-based bookmark manager for saving links, organizing bookmarks, and sharing a public profile. Free for your first 50 bookmarks.',
    path: '/',
  });

  const [searchParams] = useSearchParams();
  const [isLogin, setIsLogin] = useState(() => searchParams.get('signup') !== '1');
  const [formData, setFormData] = useState({
    username: '',
    email: '',
    password: '',
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [pendingEmail, setPendingEmail] = useState('');
  const [resendStatus, setResendStatus] = useState('');
  const [forgotMode, setForgotMode] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotStatus, setForgotStatus] = useState('idle'); // idle | loading | sent | error
  const [forgotError, setForgotError] = useState('');

  const { login, register } = useAuth();

  const handleChange = (e) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value,
    });
    setError('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    let result;
    if (isLogin) {
      result = await login(formData.email, formData.password);
    } else {
      if (/\s/.test(formData.username.trim())) {
        setError('Username cannot contain spaces');
        setLoading(false);
        return;
      }

      if (formData.password.length < 6) {
        setError('Password must be at least 6 characters');
        setLoading(false);
        return;
      }
      result = await register(formData.username, formData.email, formData.password);
    }

    setLoading(false);

    if (!result.success) {
      setError(result.error);
    } else if (result.pendingVerification) {
      setPendingEmail(formData.email);
    }
  };

  const toggleMode = () => {
    setIsLogin(!isLogin);
    setError('');
    setFormData({ username: '', email: '', password: '' });
  };

  const handleForgotPassword = async (e) => {
    e.preventDefault();
    setForgotStatus('loading');
    setForgotError('');
    try {
      await authAPI.forgotPassword(forgotEmail);
      setForgotStatus('sent');
    } catch (err) {
      if (err.response?.status === 429) {
        setForgotError(err.response?.data?.error || 'Please wait before requesting another reset link.');
        setForgotStatus('error');
      } else {
        // For security, don't reveal if email wasn't found
        setForgotStatus('sent');
      }
    }
  };

  const handleResend = async () => {
    setResendStatus('');
    try {
      await authAPI.resendVerification(pendingEmail);
      setResendStatus('A new verification link has been sent.');
    } catch (err) {
      setResendStatus(err.response?.data?.error || 'Could not resend. Please try again.');
    }
  };

  if (forgotMode) {
    return (
      <div className="home-container home-container--centered">
        <div className="home-topbar">
          <Logo src={logoSrc} className="home-logo" />
          <ThemeSelector theme={theme} onSelectTheme={onSelectTheme} className="home-theme-toggle" size={18} />
        </div>
        <main id="main" tabIndex={-1} className="home-centered-content">
          <div className="auth-card">
            {forgotStatus === 'sent' ? (
              <>
                <h2 className="auth-card-title">Check your email</h2>
                <p className="auth-description">
                  If <strong>{forgotEmail}</strong> is registered, a password reset link has been sent.
                </p>
                <button
                  className="auth-button auth-button--secondary"
                  onClick={() => { setForgotMode(false); setForgotStatus('idle'); setForgotError(''); }}
                >
                  Back to sign in
                </button>
              </>
            ) : (
              <>
                <h2 className="auth-card-title">Reset your password</h2>
                <p className="auth-description">
                  Enter your email address and we&rsquo;ll send you a link to choose a new password.
                </p>
                <form onSubmit={handleForgotPassword} className="auth-form">
                  <div className="form-field">
                    <label htmlFor="forgot-email">Email</label>
                    <input
                      id="forgot-email"
                      type="email"
                      value={forgotEmail}
                      onChange={(e) => { setForgotEmail(e.target.value); setForgotError(''); }}
                      required
                      placeholder="Enter your email"
                      autoFocus
                      aria-invalid={forgotError ? 'true' : undefined}
                      aria-describedby={forgotError ? 'forgot-error' : undefined}
                    />
                  </div>
                  <div role="alert" className="live-region">
                    {forgotError && <div id="forgot-error" className="auth-error">{forgotError}</div>}
                  </div>
                  <button type="submit" className="auth-button" disabled={forgotStatus === 'loading'}>
                    {forgotStatus === 'loading' ? 'Sending…' : 'Send reset link'}
                  </button>
                </form>
                <div className="auth-toggle">
                  Remember your password?{' '}
                  <button
                    onClick={() => { setForgotMode(false); setForgotStatus('idle'); setForgotError(''); }}
                    className="auth-toggle-button"
                  >
                    Back to sign in
                  </button>
                </div>
              </>
            )}
          </div>
        </main>
      </div>
    );
  }

  if (pendingEmail) {
    return (
      <div className="home-container home-container--centered">
        <div className="home-topbar">
          <Logo src={logoSrc} className="home-logo" />
          <ThemeSelector theme={theme} onSelectTheme={onSelectTheme} className="home-theme-toggle" size={18} />
        </div>
        <main id="main" tabIndex={-1} className="home-centered-content">
          <div className="auth-card">
            <h2 className="auth-card-title">Check your email</h2>
            <p className="auth-description">
              We sent a verification link to <strong>{pendingEmail}</strong>. Click the link to activate
              your account.
            </p>
            <div role="status" className="live-region">
              {resendStatus && <p className="auth-description">{resendStatus}</p>}
            </div>
            <button className="auth-button auth-button--secondary" onClick={handleResend}>
              Resend verification email
            </button>
            <div className="auth-toggle">
              Wrong email?{' '}
              <button onClick={() => { setPendingEmail(''); setIsLogin(false); }} className="auth-toggle-button">
                Go back
              </button>
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="home-container">
      <div className="home-topbar">
        <Logo src={logoSrc} className="home-logo" />
        <Link className="home-features-link" to="/features">Features</Link>
        <ThemeSelector theme={theme} onSelectTheme={onSelectTheme} className="home-theme-toggle" size={18} />
      </div>

      <main id="main" tabIndex={-1}>
      <section className="hero-section">
        <div className="hero-content">
          <h1 className="sr-only">Tagstash - Tag-Based Bookmark Manager</h1>
          <p className="hero-headline">Tag-first bookmarking for people who outgrow folders fast.</p>
          <p className="hero-lede">
            Save links in a bookmark manager built around tags. Give each link every tag that fits, and find it again from any of them.
            Free for your first 50 bookmarks.
          </p>
        </div>

        <div className="auth-card" id="account">
          <h2 className="auth-card-title">
            {isLogin ? 'Log in' : 'Create your account'}
          </h2>
          <p className="auth-card-intro">
            {isLogin
              ? 'Welcome back. Your bookmarks are where you left them.'
              : 'Start on the free plan. Upgrade any time if you need more than 50 bookmarks.'}
          </p>

          <form onSubmit={handleSubmit} className="auth-form">
            {!isLogin && (
              <div className="form-field">
                <label htmlFor="username">Username</label>
                <input
                  type="text"
                  id="username"
                  name="username"
                  value={formData.username}
                  onChange={handleChange}
                  required
                  aria-describedby="username-hint"
                  autoComplete="username"
                  pattern="\S+"
                  title="Username cannot contain spaces"
                />
                <small id="username-hint" className="form-hint">No spaces</small>
              </div>
            )}

            <div className="form-field">
              <label htmlFor="email">Email</label>
              <input
                type="email"
                id="email"
                name="email"
                value={formData.email}
                onChange={handleChange}
                required
                autoComplete="email"
                placeholder="you@example.com"
              />
            </div>

            <div className="form-field">
              <div className="form-field-head">
                <label htmlFor="password">Password</label>
                {isLogin && (
                  <button
                    type="button"
                    className="auth-toggle-button"
                    onClick={() => { setForgotEmail(formData.email); setForgotMode(true); setForgotStatus('idle'); setForgotError(''); }}
                  >
                    Forgot password?
                  </button>
                )}
              </div>
              <input
                type="password"
                id="password"
                name="password"
                value={formData.password}
                onChange={handleChange}
                required
                autoComplete={isLogin ? 'current-password' : 'new-password'}
                aria-describedby={isLogin ? undefined : 'password-hint'}
                minLength={6}
              />
              {!isLogin && <small id="password-hint" className="form-hint">At least 6 characters</small>}
            </div>

            <div role="alert" className="live-region">
              {error && <div className="auth-error">{error}</div>}
            </div>

            <button type="submit" className="auth-button" disabled={loading}>
              {loading ? 'Please wait…' : isLogin ? 'Log in' : 'Create account'}
            </button>
          </form>

          <div className="auth-toggle">
            {isLogin ? 'New to Tagstash? ' : 'Already have an account? '}
            <button onClick={toggleMode} className="auth-toggle-button">
              {isLogin ? 'Create an account' : 'Log in'}
            </button>
          </div>

          <div className="extension-links">
            <p className="extension-links-label">Save tabs straight from your browser</p>
            <div className="extension-links-row">
              <a
                href="https://addons.mozilla.org/en-US/firefox/addon/tagstash/"
                target="_blank"
                rel="noreferrer"
                className="extension-link-card"
              >
                <img src="/firefox.svg" alt="" className="extension-link-browser-icon" />
                <span>Add to Firefox</span>
              </a>
              <a
                href="https://chromewebstore.google.com/detail/tagstash/ijoaejbpaibpodnohjmlbeanfhjdgoab"
                target="_blank"
                rel="noreferrer"
                className="extension-link-card"
              >
                <img src="/chrome.svg" alt="" className="extension-link-browser-icon" />
                <span>Add to Chrome</span>
              </a>
            </div>
          </div>
        </div>

        <div className="hero-demo">
          <HomeTagDemo />
        </div>
      </section>

      <section className="features-section">
        <h2 className="home-section-title">What you get</h2>
        <dl className="features-list">
          {features.map((feature) => (
            <div key={feature.title} className="feature-item">
              <dt>{feature.title}</dt>
              <dd>{feature.description}</dd>
            </div>
          ))}
        </dl>
        <Link className="home-features-detail-link" to="/features">Explore all features</Link>
      </section>

      <section className="pricing-section">
        <h2 className="home-section-title">Pricing</h2>
        <div className="pricing-grid">
          <div className="pricing-plan">
            <h3 className="pricing-plan-name">Free</h3>
            <p className="pricing-amount">$0</p>
            <p className="pricing-description">Up to 50 bookmarks, with no time limit.</p>
          </div>
          <div className="pricing-plan pricing-plan--pro">
            <h3 className="pricing-plan-name">Pro</h3>
            <p className="pricing-amount">$3<span className="pricing-period">/month</span></p>
            <p className="pricing-description">
              Unlimited bookmarks. Pay monthly and cancel any time, or pay $36 once a year. Same rate either way.
            </p>
          </div>
        </div>
        <p className="pricing-note">Upgrade from Settings whenever you need more room.</p>
      </section>

      <section className="faq-section">
        <h2 className="home-section-title">Questions</h2>
        <dl className="faq-list">
          {faqs.map((faq) => (
            <div key={faq.question} className="faq-item">
              <dt>{faq.question}</dt>
              <dd>{faq.answer}</dd>
            </div>
          ))}
        </dl>
      </section>

      </main>
      <footer className="home-footer">
        <span className="home-footer-copyright">
          &copy; {new Date().getFullYear()}{' '}
          <a href="https://stonedragonmedia.com/" target="_blank" rel="noopener noreferrer">
            Stone Dragon Media LLC
          </a>
        </span>
        <Link className="home-footer-privacy-link" to="/privacy">Privacy Policy</Link>
        <Link className="home-footer-privacy-link" to="/support">Support</Link>
        <button className="home-footer-privacy-link" data-cookie-preferences>Cookie Choices</button>
        <span className="version">v{version}</span>
      </footer>
    </div>
  );
}

export default Home;
