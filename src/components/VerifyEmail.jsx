import Logo from './Logo'
import { useState, useEffect } from 'react';
import { authAPI } from '../api/api';
import { useAuth } from '../context/AuthContext';
import { useDocumentMeta } from '../utils/useDocumentMeta';
import './Auth.css';

function VerifyEmail({ logoSrc }) {
  useDocumentMeta({ title: 'Verify Email - Tagstash', path: '/verify-email', noindex: true });

  const [status, setStatus] = useState('verifying'); // verifying | success | error
  const [message, setMessage] = useState('');
  const { refreshCurrentUser } = useAuth();

  useEffect(() => {
    let redirectTimer;
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
        // An email-change link proves inbox access only: no session, the user signs in again.
        if (response?.data?.emailChanged) {
          setStatus('changed');
          return null;
        }
        return refreshCurrentUser().then(() => {
          setStatus('success');
          // Switch out of verify mode after auth state is ready.
          redirectTimer = window.setTimeout(() => {
            window.location.assign('/');
          }, 800);
        });
      })
      .catch((err) => {
        setStatus('error');
        setMessage(err.response?.data?.error || 'Verification failed. The link may be invalid or expired.');
      });

    return () => {
      if (redirectTimer) {
        window.clearTimeout(redirectTimer);
      }
    };
  }, [refreshCurrentUser]);

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
            <p className="auth-description">Your account is active. You are now signed in.</p>
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
