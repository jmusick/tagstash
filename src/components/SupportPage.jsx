import Logo from './Logo'
import { useEffect, useRef, useState } from 'react';
import { supportAPI } from '../api/api';
import { useDocumentMeta } from '../utils/useDocumentMeta';
import { SUPPORT_META } from '../utils/pageMeta';
import './SupportPage.css';

const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY || '';

function SupportPage({ logoSrc, onBack, prefillEmail = '' }) {
  useDocumentMeta(SUPPORT_META);

  const [email, setEmail] = useState(prefillEmail);
  const [message, setMessage] = useState('');
  const [captchaToken, setCaptchaToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const widgetContainerRef = useRef(null);
  const widgetIdRef = useRef(null);

  useEffect(() => {
    setEmail(prefillEmail || '');
  }, [prefillEmail]);

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY || !widgetContainerRef.current) return;

    const ensureWidget = () => {
      if (!window.turnstile || widgetIdRef.current !== null || !widgetContainerRef.current) return;

      widgetIdRef.current = window.turnstile.render(widgetContainerRef.current, {
        sitekey: TURNSTILE_SITE_KEY,
        // Must match TURNSTILE_SUPPORT_ACTION in functions/api/[[path]].js.
        action: 'support',
        theme: 'auto',
        callback: (token) => setCaptchaToken(token),
        'expired-callback': () => setCaptchaToken(''),
        'error-callback': () => setCaptchaToken(''),
      });
    };

    if (window.turnstile) {
      ensureWidget();
      return;
    }

    const existingScript = document.querySelector('script[data-turnstile-script="true"]');
    if (!existingScript) {
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.defer = true;
      script.dataset.turnstileScript = 'true';
      script.onload = ensureWidget;
      document.head.appendChild(script);
    } else {
      existingScript.addEventListener('load', ensureWidget, { once: true });
      ensureWidget();
    }
  }, []);

  const resetCaptcha = () => {
    if (window.turnstile && widgetIdRef.current !== null) {
      window.turnstile.reset(widgetIdRef.current);
    }
    setCaptchaToken('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    const trimmedEmail = email.trim();
    const trimmedMessage = message.trim();

    if (!trimmedEmail) {
      setError('Email is required.');
      return;
    }

    if (!trimmedMessage) {
      setError('Message is required.');
      return;
    }

    if (!TURNSTILE_SITE_KEY) {
      setError('Support form is not configured yet. Please try again later.');
      return;
    }

    if (!captchaToken) {
      setError('Please complete the CAPTCHA.');
      return;
    }

    try {
      setLoading(true);
      await supportAPI.submit({
        email: trimmedEmail,
        message: trimmedMessage,
        captchaToken,
      });
      setSuccess('Support request sent. We will get back to you soon.');
      setMessage('');
      resetCaptcha();
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not send support request. Please try again.');
      resetCaptcha();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="support-page">
      <header className="support-header">
        {logoSrc && <Logo src={logoSrc} className="support-logo" />}
        <h1>Contact Support</h1>
      </header>

      <main id="main" tabIndex={-1} className="support-content">
        <p className="support-intro">
          Use this form to reach the Tagstash support team.
        </p>

        <form className="support-form" onSubmit={handleSubmit}>
          <div className="support-field">
            <label htmlFor="support-email">Account Email</label>
            <input
              id="support-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="you@example.com"
            />
          </div>

          <div className="support-field">
            <label htmlFor="support-message">Message</label>
            <textarea
              id="support-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              required
              minLength={10}
              maxLength={4000}
              rows={8}
              placeholder="How can we help?"
            />
          </div>

          <div className="support-turnstile" ref={widgetContainerRef} role="group" aria-label="CAPTCHA verification" />

          {!TURNSTILE_SITE_KEY && (
            <p className="support-warning">CAPTCHA site key is not configured.</p>
          )}

          <div role="alert" className="live-region">
            {error && <div className="support-error">{error}</div>}
          </div>
          <div role="status" className="live-region">
            {success && <div className="support-success">{success}</div>}
          </div>

          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? 'Sending...' : 'Send Support Request'}
          </button>
        </form>
      </main>

      <footer className="support-footer">
        <button className="btn-secondary" onClick={onBack}>
          &larr; Back
        </button>
        <span className="support-copyright">
          &copy; {new Date().getFullYear()}{' '}
          <a href="https://stonedragonmedia.com/" target="_blank" rel="noopener noreferrer">
            Stone Dragon Media LLC
          </a>
        </span>
      </footer>
    </div>
  );
}

export default SupportPage;
