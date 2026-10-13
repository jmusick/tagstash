import Logo from './Logo'
import { useState } from 'react';
import { authAPI } from '../api/api';
import { useAuth } from '../context/AuthContext';
import { useDocumentMeta } from '../utils/useDocumentMeta';
import { INPUT_LIMITS } from '../utils/inputLimits';
import { NEW_PASSWORD_HINT, newPasswordError } from '../utils/passwordPolicy';
import './Auth.css';

function ResetPassword({ logoSrc }) {
  useDocumentMeta({ title: 'Reset Password - Tagstash', path: '/reset-password', noindex: true });

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [status, setStatus] = useState('form'); // form | loading | success | error
  const [message, setMessage] = useState('');
  const { refreshCurrentUser } = useAuth();

  const token = new URLSearchParams(window.location.search).get('token');

  const handleSubmit = async (e) => {
    e.preventDefault();
    const passwordError = newPasswordError(password);
    if (passwordError) {
      setMessage(`${passwordError}.`);
      setStatus('error');
      return;
    }
    if (password !== confirm) {
      setMessage('Passwords do not match.');
      setStatus('error');
      return;
    }

    setStatus('loading');
    setMessage('');

    try {
      await authAPI.resetPassword(token, password);
      await refreshCurrentUser();
      setStatus('success');
      setTimeout(() => window.location.assign('/'), 800);
    } catch (err) {
      setStatus('error');
      setMessage(err.response?.data?.error || 'Password reset failed. The link may be invalid or expired.');
    }
  };

  return (
    <main id="main" tabIndex={-1} className="auth-container">
      <div className="auth-card">
        <h1 className="auth-title">
          <Logo src={logoSrc} className="auth-title-logo" />
        </h1>

        <div role="status" className="live-region">
          {token && status === 'success' && (
            <>
              <p className="auth-subtitle">Password updated!</p>
              <p className="auth-description">You are now signed in. Redirecting…</p>
            </>
          )}
        </div>

        {!token ? (
          <>
            <p className="auth-subtitle">Invalid link</p>
            <p className="auth-description">No reset token was found in the link.</p>
            <a href="/" className="auth-button" style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }}>
              Back to sign in
            </a>
          </>
        ) : status === 'success' ? null : (
          <>
            <p className="auth-subtitle">Choose a new password</p>

            <form onSubmit={handleSubmit} className="auth-form">
              <div className="form-field">
                <label htmlFor="rp-password">New password</label>
                <input
                  id="rp-password"
                  type="password"
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); setStatus('form'); }}
                  required
                  minLength={INPUT_LIMITS.passwordMinChars}
                  aria-describedby="rp-password-hint"
                  autoFocus
                />
                <small id="rp-password-hint" className="form-hint">{NEW_PASSWORD_HINT}</small>
              </div>
              <div className="form-field">
                <label htmlFor="rp-confirm">Confirm new password</label>
                <input
                  id="rp-confirm"
                  type="password"
                  value={confirm}
                  onChange={(e) => { setConfirm(e.target.value); setStatus('form'); }}
                  required
                  minLength={INPUT_LIMITS.passwordMinChars}
                  placeholder="Repeat your password"
                  aria-invalid={status === 'error' ? 'true' : undefined}
                  aria-describedby={status === 'error' ? 'rp-error' : undefined}
                />
              </div>

              <div role="alert" className="live-region">
                {status === 'error' && <div id="rp-error" className="auth-error">{message}</div>}
              </div>

              <button type="submit" className="auth-button" disabled={status === 'loading'}>
                {status === 'loading' ? 'Resetting…' : 'Reset password'}
              </button>
            </form>
          </>
        )}
      </div>
    </main>
  );
}

export default ResetPassword;
