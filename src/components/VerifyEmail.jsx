import Logo from './Logo'
import { useState, useEffect, useRef } from 'react';
import { authAPI } from '../api/api';
import { useDocumentMeta } from '../utils/useDocumentMeta';
import './Auth.css';

function VerifyEmail({ logoSrc }) {
  useDocumentMeta({ title: 'Verify Email - Tagstash', path: '/verify-email', noindex: true });

  const [status, setStatus] = useState('verifying'); // verifying | success | changed | error
  const [message, setMessage] = useState('');
  // Links are single-use, so redeem once per mount (StrictMode re-runs effects in dev, and a
  // second request would report the link as already used).
  const requested = useRef(false);

  useEffect(() => {
    if (requested.current) return;
    requested.current = true;
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');

    if (!token) {
      setStatus('error');
      setMessage('No verification token found in the link.');
      return;
    }

    authAPI
      .verifyEmail(token)
      .then((response) => {
        // Verification and email-change links prove inbox access only: neither issues a
        // session, so the user signs in with their password afterwards.
        setStatus(response?.data?.emailChanged ? 'changed' : 'success');
      })
      .catch((err) => {
        setStatus('error');
        setMessage(err.response?.data?.error || 'Verification failed. The link may be invalid or expired.');
      });
  }, []);

  return (
    <main id="main" tabIndex={-1} className="auth-container">
      <div className="auth-card">
        <h1 className="auth-title">
          <Logo src={logoSrc} className="auth-title-logo" />
        </h1>

        <div role="status" className="live-region">
        {status === 'verifying' && (
          <p className="auth-subtitle">Verifying your email address…</p>
        )}

        {status === 'success' && (
          <>
            <p className="auth-subtitle">Email verified!</p>
            <p className="auth-description">Your account is active. Sign in with your email and password to get started.</p>
            <a href="/" className="auth-button" style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }}>
              Go to sign in
            </a>
          </>
        )}

        {status === 'changed' && (
          <>
            <p className="auth-subtitle">Email address updated</p>
            <p className="auth-description">For your security you were signed out everywhere. Sign in again with your new email.</p>
            <a href="/" className="auth-button" style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }}>
              Go to sign in
            </a>
          </>
        )}
        </div>

        <div role="alert" className="live-region">
        {status === 'error' && (
          <>
            <p className="auth-subtitle">Verification failed</p>
            <p className="auth-description">{message}</p>
            <a href="/" className="auth-button" style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }}>
              Back to sign in
            </a>
          </>
        )}
        </div>
      </div>
    </main>
  );
}

export default VerifyEmail;
