import { HOME_FAQS as faqs, HOME_FEATURES as features } from '../content/homeMarketing'
import { getHomeStructuredData } from '../content/marketingSchema'
import { usePageStructuredData } from '../utils/usePageStructuredData'
import Logo from './Logo'
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { authAPI } from '../api/api';
import ThemeSelector from './ThemeSelector';
import HomeTagDemo from './HomeTagDemo';
import { version } from '../../package.json';
import { useDocumentMeta } from '../utils/useDocumentMeta';
import { INPUT_LIMITS } from '../utils/inputLimits';
import { NEW_PASSWORD_HINT, newPasswordError } from '../utils/passwordPolicy';
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
  const [signedOutEverywhere, setSignedOutEverywhere] = useState(false);
  const signedOutNoticeRef = useRef(null);

  // After self-service account deletion (issue #153) this page is where the owner lands:
  // 'deleted' confirms it, and 'finishDeletion' lets them finish one that was interrupted (reached
  // from Settings, or from a login that answered `deletionPending`). Nothing here is set during
  // the first render, so the server-rendered markup this hydrates over still matches.
  const [view, setView] = useState('auth'); // auth | finishDeletion | deleted
  const [finishInterrupted, setFinishInterrupted] = useState(false);
  const [finishLoading, setFinishLoading] = useState(false);
  const [finishError, setFinishError] = useState('');
  const viewHeadingRef = useRef(null);
  const location = useLocation();
  const navigate = useNavigate();
  const accountNotice = location.state?.accountNotice;
  const noticeEmail = location.state?.email;

  useEffect(() => {
    if (!accountNotice) return;
    if (accountNotice === 'deleted') {
      setView('deleted');
    } else if (accountNotice === 'signedOutEverywhere') {
      setSignedOutEverywhere(true);
    } else if (accountNotice === 'pending') {
      setFinishInterrupted(true);
      setFinishError('');
      if (typeof noticeEmail === 'string') setFormData((current) => ({ ...current, email: noticeEmail }));
      setView('finishDeletion');
    }
    // The notice is one-shot: a reload must not show it again.
    navigate(location.pathname, { replace: true, state: null });
  }, [accountNotice, noticeEmail, location.pathname, navigate]);

  useEffect(() => {
    if (view !== 'auth') viewHeadingRef.current?.focus();
  }, [view]);

  useEffect(() => {
    if (signedOutEverywhere) signedOutNoticeRef.current?.focus();
  }, [signedOutEverywhere]);

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

      const passwordError = newPasswordError(formData.password);
      if (passwordError) {
        setError(passwordError);
        setLoading(false);
        return;
      }
      result = await register(formData.username, formData.email, formData.password);
    }

    setLoading(false);

    if (!result.success && result.deletionPending) {
      // Right password, but a deletion of this account never finished. Offer to finish it.
      setFinishInterrupted(false);
      setFinishError('');
      setView('finishDeletion');
    } else if (!result.success) {
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

  const handleFinishDeletion = async (e) => {
    e.preventDefault();
    setFinishLoading(true);
    setFinishError('');
    try {
      await authAPI.resumeDeletion(formData.email, formData.password);
      setFormData({ username: '', email: '', password: '' });
      setView('deleted');
    } catch (err) {
      if (err.response?.data?.deletionPending) {
        setFinishError(
          'Deletion still has not finished. Your account stays locked and nothing was restored. ' +
          'Try again in a few minutes, or contact support.'
        );
      } else if (err.response?.data?.error) {
        setFinishError(err.response.data.error);
      } else if (err.response?.status === 429) {
        setFinishError('Too many attempts. Please wait a moment and try again.');
      } else if (err.request) {
        setFinishError('Unable to reach the server. Please check your connection and try again.');
      } else {
        setFinishError('Could not finish deleting the account. Please try again.');
      }
    } finally {
      setFinishLoading(false);
    }
  };

  const handleResend = async () => {
    setResendStatus('');
    try {
      await authAPI.resendVerification(pendingEmail);
      setResendStatus('If this address is waiting for verification, a new link is on its way.');
    } catch (err) {
      setResendStatus(err.response?.data?.error || 'Could not resend. Please try again.');
    }
  };

  if (view === 'deleted') {
    return (
      <div className="home-container home-container--centered">
        <header className="home-topbar">
          <Logo src={logoSrc} className="home-logo" />
          <ThemeSelector theme={theme} onSelectTheme={onSelectTheme} className="home-theme-toggle" size={18} />
        </header>
        <main id="main" tabIndex={-1} className="home-centered-content">
          <div className="auth-card">
            <h1 className="auth-card-title" tabIndex={-1} ref={viewHeadingRef}>Your account has been deleted</h1>
            <p className="auth-description">
              Your bookmarks, tags and account data were permanently removed, any Pro subscription
              was canceled, and you are signed out. This cannot be undone.
            </p>
            <p className="auth-description">
              Thank you for trying Tagstash. You are welcome to create a new account at any time.
            </p>
            <button type="button" className="auth-button auth-button--secondary" onClick={() => setView('auth')}>
              Back to the home page
            </button>
          </div>
        </main>
      </div>
    );
  }

  if (view === 'finishDeletion') {
    return (
      <div className="home-container home-container--centered">
        <header className="home-topbar">
          <Logo src={logoSrc} className="home-logo" />
          <ThemeSelector theme={theme} onSelectTheme={onSelectTheme} className="home-theme-toggle" size={18} />
        </header>
        <main id="main" tabIndex={-1} className="home-centered-content">
          <div className="auth-card">
            <h1 className="auth-card-title" tabIndex={-1} ref={viewHeadingRef}>Finish deleting your account</h1>
            {finishInterrupted && (
              <p className="auth-description">
                We could not finish deleting your account, so your session was ended.
              </p>
            )}
            <p className="auth-description">
              Deleting this account was started but has not finished, so the account is locked until it
              does. Finishing permanently deletes your bookmarks and account data and cancels any
              Pro subscription immediately. This cannot be undone.
            </p>
            <form onSubmit={handleFinishDeletion} className="auth-form" aria-busy={finishLoading}>
              <div className="form-field">
                <label htmlFor="finish-email">Email</label>
                <input
                  type="email"
                  id="finish-email"
                  name="email"
                  value={formData.email}
                  onChange={handleChange}
                  required
                  autoComplete="email"
                  maxLength={INPUT_LIMITS.email}
                  readOnly={finishLoading}
                />
              </div>
              <div className="form-field">
                <label htmlFor="finish-password">Password</label>
                <input
                  type="password"
                  id="finish-password"
                  name="password"
                  value={formData.password}
                  onChange={handleChange}
                  required
                  autoComplete="current-password"
                  readOnly={finishLoading}
                />
              </div>
              <div role="alert" className="live-region">
                {finishError && <div className="auth-error">{finishError}</div>}
              </div>
              <div role="status" className="live-region">
                {finishLoading && (
                  <p className="auth-description">Finishing deletion. This can take a few seconds.</p>
                )}
              </div>
              <button type="submit" className="auth-button auth-button--danger" disabled={finishLoading}>
                {finishLoading ? 'Finishing deletion…' : finishError ? 'Try again' : 'Finish deleting my account'}
              </button>
            </form>
            <div className="auth-toggle">
              Not what you want? The account stays locked until deletion finishes, so{' '}
              <Link to="/support" className="auth-toggle-button">contact support</Link> to discuss it.{' '}
              <button
                type="button"
                className="auth-toggle-button"
                onClick={() => { setView('auth'); setFinishError(''); setFormData({ username: '', email: '', password: '' }); }}
                disabled={finishLoading}
              >
                Back to log in
              </button>
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (forgotMode) {
    return (
      <div className="home-container home-container--centered">
        <header className="home-topbar">
          <Logo src={logoSrc} className="home-logo" />
          <ThemeSelector theme={theme} onSelectTheme={onSelectTheme} className="home-theme-toggle" size={18} />
        </header>
        <main id="main" tabIndex={-1} className="home-centered-content">
          <div className="auth-card">
            {forgotStatus === 'sent' ? (
              <>
                <h1 className="auth-card-title">Check your email</h1>
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
                <h1 className="auth-card-title">Reset your password</h1>
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
        <header className="home-topbar">
          <Logo src={logoSrc} className="home-logo" />
          <ThemeSelector theme={theme} onSelectTheme={onSelectTheme} className="home-theme-toggle" size={18} />
        </header>
        <main id="main" tabIndex={-1} className="home-centered-content">
          <div className="auth-card">
            <h1 className="auth-card-title">Check your email</h1>
            <p className="auth-description">
              We sent an email to <strong>{pendingEmail}</strong>. Open it to finish setting up your
              account.
            </p>
            <p className="auth-description">
              Nothing after a few minutes? Check your spam folder, or request a new link below.
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
      <header className="home-topbar">
        <Logo src={logoSrc} className="home-logo" />
        <nav className="home-topnav" aria-label="Main">
          <Link className="home-features-link" to="/features">Features</Link>
        </nav>
        <ThemeSelector theme={theme} onSelectTheme={onSelectTheme} className="home-theme-toggle" size={18} />
      </header>

      <main id="main" tabIndex={-1}>
      <section className="hero-section">
        <div className="hero-content">
          <h1 className="hero-headline">Tag-first bookmarking for people who outgrow folders fast.</h1>
          <p className="hero-lede">
            Save links in a bookmark manager built around tags. Give each link every tag that fits, and find it again from any of them.
            Free for your first 50 bookmarks.
          </p>
        </div>

        <div className="auth-card" id="account">
          {signedOutEverywhere && (
            <div className="auth-success" role="status" tabIndex={-1} ref={signedOutNoticeRef}>
              You are signed out of all devices, including browser extensions. Personal API keys are still active.
            </div>
          )}
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
                  maxLength={INPUT_LIMITS.username}
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
                maxLength={INPUT_LIMITS.email}
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
                minLength={isLogin ? undefined : INPUT_LIMITS.passwordMinChars}
              />
              {!isLogin && <small id="password-hint" className="form-hint">{NEW_PASSWORD_HINT}</small>}
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
