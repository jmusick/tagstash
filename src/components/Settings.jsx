import { useEffect, useState, useCallback, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { authAPI, billingAPI } from '../api/api';
import { X, KeyRound, Copy, Ban, EyeOff, Trash2, CreditCard, Zap, CheckCircle } from 'lucide-react';
import Import from './Import';
import Export from './Export';
import { DEFAULT_LINK_TARGET, LINK_TARGET_ORDER, LINK_TARGET_LABELS } from '../utils/linkTarget';
import { useDocumentMeta } from '../utils/useDocumentMeta';
import { INPUT_LIMITS } from '../utils/inputLimits';
import './Settings.css';

function Settings({
  onClose,
  pageMode = false,
  onImportComplete,
  linkTarget = DEFAULT_LINK_TARGET,
  onSelectLinkTarget,
}) {
  useDocumentMeta({ title: 'Settings - Tagstash', path: '/settings', noindex: true, enabled: pageMode });

  const { user, updateUser, refreshCurrentUser } = useAuth();
  const isSuperAdmin = user?.role === 'super_admin';
  const currentMembershipTier = user?.membership_tier || user?.membershipTier || 'free';
  const [activeTab, setActiveTab] = useState('username');
  const [loading, setLoading] = useState(false);
  const [loadingKeys, setLoadingKeys] = useState(false);
  const [loadingAdminUsers, setLoadingAdminUsers] = useState(false);
  const [adminUserQuery, setAdminUserQuery] = useState('');
  const [savingAdminUserId, setSavingAdminUserId] = useState(null);
  const [deletingAdminUserId, setDeletingAdminUserId] = useState(null);
  const [moderatingAdminUserId, setModeratingAdminUserId] = useState(null);
  const [moderationAvailable, setModerationAvailable] = useState(true);
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');
  const [apiKeys, setApiKeys] = useState([]);
  const [adminUsers, setAdminUsers] = useState([]);
  const [authEvents, setAuthEvents] = useState([]);
  const [loadingAuthEvents, setLoadingAuthEvents] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [generatedApiKey, setGeneratedApiKey] = useState('');
  const [showRevokedKeys, setShowRevokedKeys] = useState(false);
  const [publicApiTagInput, setPublicApiTagInput] = useState('');

  // Billing state
  const [plans, setPlans] = useState([]);
  const [billingLoading, setBillingLoading] = useState(false);
  const [subscriptionStatus, setSubscriptionStatus] = useState(null);

  const fetchPlans = useCallback(async () => {
    try {
      const res = await billingAPI.getPlans();
      setPlans(res.data.plans);
    } catch {
      // Stripe not configured — leave plans empty
    }
  }, []);

  const syncBillingStatus = useCallback(async () => {
    try {
      const res = await billingAPI.getStatus();
      setSubscriptionStatus(res?.data?.subscription || null);
      if (res?.data?.user) {
        updateUser({ ...user, ...res.data.user });
      }
    } catch {
      // If status sync fails, keep current UI state and let normal billing actions continue.
    }
  }, [updateUser, user]);

  const cancellationTs = subscriptionStatus?.cancel_at || subscriptionStatus?.current_period_end || null;
  const cancellationDateLabel = cancellationTs
    ? new Date(cancellationTs * 1000).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : '';

  const handleUpgrade = async (plan) => {
    try {
      setBillingLoading(true);
      const res = await billingAPI.createCheckoutSession(plan);
      window.location.href = res.data.url;
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to start checkout');
    } finally {
      setBillingLoading(false);
    }
  };

  const handleManageSubscription = async () => {
    try {
      setBillingLoading(true);
      const res = await billingAPI.createPortalSession();
      window.location.href = res.data.url;
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to open billing portal');
    } finally {
      setBillingLoading(false);
    }
  };

  // Username form state
  const [usernameForm, setUsernameForm] = useState({
    newUsername: user?.username || '',
    password: '',
  });

  // Email form state
  const [emailForm, setEmailForm] = useState({
    newEmail: user?.email || '',
    password: '',
  });

  useEffect(() => {
    setUsernameForm((prev) => ({
      ...prev,
      newUsername: user?.username || '',
    }));

    setEmailForm((prev) => ({
      ...prev,
      newEmail: user?.email || '',
    }));
  }, [user]);

  const handleUsernameChange = (e) => {
    setUsernameForm({
      ...usernameForm,
      [e.target.name]: e.target.value,
    });
    setError('');
  };

  // Password form state
  const [passwordForm, setPasswordForm] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });

  const handleEmailChange = (e) => {
    setEmailForm({
      ...emailForm,
      [e.target.name]: e.target.value,
    });
    setError('');
  };

  const handlePasswordChange = (e) => {
    setPasswordForm({
      ...passwordForm,
      [e.target.name]: e.target.value,
    });
    setError('');
  };

  const fetchApiKeys = async () => {
    try {
      setLoadingKeys(true);
      const response = await authAPI.getApiKeys();
      setApiKeys(response.data.apiKeys || []);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to fetch API keys');
    } finally {
      setLoadingKeys(false);
    }
  };

  const fetchAdminUsers = async () => {
    if (!isSuperAdmin) {
      return;
    }

    try {
      setLoadingAdminUsers(true);
      const response = await authAPI.adminListUsers();
      setAdminUsers(response.data.users || []);
      setModerationAvailable(response.data.moderationAvailable !== false);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to fetch users');
    } finally {
      setLoadingAdminUsers(false);
    }
  };

  const fetchAuthEvents = async () => {
    if (!isSuperAdmin) {
      return;
    }

    try {
      setLoadingAuthEvents(true);
      const response = await authAPI.adminListAuthEvents();
      setAuthEvents(response.data.events || []);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to fetch security events');
    } finally {
      setLoadingAuthEvents(false);
    }
  };

  const handleAdminFieldChange = (id, field, value) => {
    setAdminUsers((prev) =>
      prev.map((member) =>
        member.id === id
          ? { ...member, [field]: value }
          : member
      )
    );
  };

  const handleSaveAdminUser = async (member) => {
    try {
      setSavingAdminUserId(member.id);
      setError('');
      setSuccess('');
      await authAPI.adminUpdateUser(member.id, {
        membershipTier: member.membership_tier,
        role: member.role,
      });
      setSuccess(`Updated ${member.email}`);
      await fetchAdminUsers();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to update user access');
    } finally {
      setSavingAdminUserId(null);
    }
  };

  const handleDeleteAdminUser = async (member) => {
    const confirmed = window.confirm(
      `Delete ${member.email}? This will permanently remove the account and all of their bookmarks.`
    );

    if (!confirmed) {
      return;
    }

    try {
      setDeletingAdminUserId(member.id);
      setError('');
      setSuccess('');
      await authAPI.adminDeleteUser(member.id);
      setSuccess(`Deleted ${member.email} and removed their bookmarks`);
      await fetchAdminUsers();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete user');
    } finally {
      setDeletingAdminUserId(null);
    }
  };

  const MODERATION_CONFIRMATIONS = {
    suspend: (member) =>
      `Suspend ${member.email}? Their public profile will be hidden everywhere and they won't be able to make it public again until unsuspended. They can still sign in and use their bookmarks.`,
    'make-private': (member) =>
      `Make ${member.email}'s profile private? They can turn it back on unless their account is suspended.`,
  };

  const handleModerateAdminUser = async (member, action) => {
    const confirmMessage = MODERATION_CONFIRMATIONS[action];
    if (confirmMessage && !window.confirm(confirmMessage(member))) {
      return;
    }

    try {
      setModeratingAdminUserId(member.id);
      setError('');
      setSuccess('');
      const response = await authAPI.adminModerateUser(member.id, action);
      setSuccess(response.data.message);
      await Promise.all([fetchAdminUsers(), fetchAuthEvents()]);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to update account');
    } finally {
      setModeratingAdminUserId(null);
    }
  };

  const filteredAdminUsers = useMemo(() => {
    const query = adminUserQuery.trim().toLowerCase();
    if (!query) return adminUsers;

    return adminUsers.filter((member) => {
      const searchable = [
        member.id,
        member.username,
        member.email,
        member.membership_tier,
        member.role,
        member.bookmark_count,
        member.suspended_at ? 'suspended' : '',
        member.profile_public ? 'public' : '',
      ]
        .map((value) => String(value ?? '').toLowerCase())
        .join(' ');

      return searchable.includes(query);
    });
  }, [adminUsers, adminUserQuery]);

  const handleCreateApiKey = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setGeneratedApiKey('');

    try {
      setLoading(true);
      const response = await authAPI.createApiKey(newKeyName);
      setGeneratedApiKey(response.data.apiKey);
      setSuccess('API key created. Copy it now - it will only be shown once.');
      setNewKeyName('');
      await fetchApiKeys();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create API key');
    } finally {
      setLoading(false);
    }
  };

  const handleRevokeApiKey = async (id) => {
    try {
      setError('');
      setSuccess('');
      await authAPI.revokeApiKey(id);
      setSuccess('API key revoked');
      await fetchApiKeys();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to revoke API key');
    }
  };

  const handleDeleteApiKey = async (id) => {
    const confirmed = window.confirm('Delete this API key permanently? This cannot be undone.');
    if (!confirmed) return;

    try {
      setError('');
      setSuccess('');
      await authAPI.deleteApiKey(id);
      setSuccess('API key deleted permanently');
      await fetchApiKeys();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete API key');
    }
  };

  const handleCopyApiKey = async () => {
    if (!generatedApiKey) return;

    try {
      await navigator.clipboard.writeText(generatedApiKey);
      setSuccess('API key copied to clipboard');
    } catch {
      setError('Unable to copy API key');
    }
  };

  const visibleApiKeys = showRevokedKeys
    ? apiKeys
    : apiKeys.filter((key) => !key.revoked_at);

  const handleUsernameSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setSuccess('');

    try {
      const trimmedUsername = usernameForm.newUsername.trim();

      if (!trimmedUsername || !usernameForm.password) {
        setError('Both fields are required');
        setLoading(false);
        return;
      }

      if (/\s/.test(trimmedUsername)) {
        setError('Username cannot contain spaces');
        setLoading(false);
        return;
      }

      if (trimmedUsername === user?.username) {
        setError('New username must be different from current username');
        setLoading(false);
        return;
      }

      const response = await authAPI.updateUsername(trimmedUsername, usernameForm.password);
      updateUser(response.data.user);
      setSuccess('Username updated successfully!');
      setUsernameForm({
        newUsername: response.data.user.username,
        password: '',
      });
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to update username');
    } finally {
      setLoading(false);
    }
  };

  const handleEmailSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setSuccess('');

    try {
      if (!emailForm.newEmail || !emailForm.password) {
        setError('Both fields are required');
        setLoading(false);
        return;
      }

      if (emailForm.newEmail === user?.email) {
        setError('New email must be different from current email');
        setLoading(false);
        return;
      }

      const response = await authAPI.updateEmail(emailForm.newEmail, emailForm.password);
      setSuccess(response.data.message || 'Check your new inbox to confirm the change.');
      setEmailForm({
        newEmail: '',
        password: '',
      });
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to update email');
    } finally {
      setLoading(false);
    }
  };

  const handlePasswordSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setSuccess('');

    try {
      if (!passwordForm.currentPassword || !passwordForm.newPassword || !passwordForm.confirmPassword) {
        setError('All fields are required');
        setLoading(false);
        return;
      }

      if (passwordForm.newPassword !== passwordForm.confirmPassword) {
        setError('New passwords do not match');
        setLoading(false);
        return;
      }

      if (passwordForm.newPassword.length < 6) {
        setError('New password must be at least 6 characters');
        setLoading(false);
        return;
      }

      await authAPI.updatePassword(
        passwordForm.currentPassword,
        passwordForm.newPassword,
        passwordForm.confirmPassword
      );
      setSuccess('Password updated successfully!');
      setPasswordForm({
        currentPassword: '',
        newPassword: '',
        confirmPassword: '',
      });
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to update password');
    } finally {
      setLoading(false);
    }
  };

  const handleTogglePublicProfile = async (e) => {
    const nextValue = e.target.checked;
    setError('');
    setSuccess('');
    setLoading(true);

    try {
      await authAPI.updateProfilePublic(nextValue);
      updateUser({ ...user, profile_public: nextValue ? 1 : 0 });
      setSuccess(nextValue ? 'Public profile enabled' : 'Public profile disabled');
    } catch (err) {
      if (err.response?.data?.suspended) {
        updateUser({ ...user, suspended: true });
      }
      setError(err.response?.data?.error || 'Failed to update public profile setting');
    } finally {
      setLoading(false);
    }
  };

  // The login response doesn't carry the moderation state, so re-read /auth/me when the
  // Public Profile tab opens; a suspension then shows its notice without a reload.
  const isPublicProfileTab = activeTab === 'publicProfile';
  useEffect(() => {
    if (!isPublicProfileTab) return;
    refreshCurrentUser?.().catch(() => {});
  }, [isPublicProfileTab, refreshCurrentUser]);

  const isSuspended = Boolean(user?.suspended);

  const publicProfileUrl = `${window.location.origin}/u/${user?.username || ''}`;
  const publicApiUrl = (() => {
    const base = `${window.location.origin}/api/profiles/${user?.username || ''}`;
    const tag = publicApiTagInput.trim().toLowerCase();
    return tag ? `${base}?tag=${encodeURIComponent(tag)}` : base;
  })();

  const handleCopyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      setSuccess('Link copied to clipboard');
    } catch {
      setError('Failed to copy link');
    }
  };

  const settingsTabs = [
    { id: 'username', label: 'Username', onSelect: () => setGeneratedApiKey('') },
    { id: 'email', label: 'Email', onSelect: () => setGeneratedApiKey('') },
    { id: 'password', label: 'Password', onSelect: () => setGeneratedApiKey('') },
    { id: 'publicProfile', label: 'Public Profile' },
    { id: 'preferences', label: 'Preferences' },
    // The API Keys tab is hidden for now (its panel below is kept):
    // { id: 'apiKeys', label: 'API Keys', onSelect: fetchApiKeys },
    {
      id: 'billing',
      label: 'Billing',
      onSelect: () => {
        fetchPlans();
        syncBillingStatus();
      },
    },
    { id: 'extensions', label: 'Extensions' },
    { id: 'import', label: 'Import / Export' },
    ...(isSuperAdmin
      ? [{
          id: 'admin',
          label: 'Admin',
          onSelect: () => {
            fetchAdminUsers();
            fetchAuthEvents();
          },
        }]
      : []),
  ];
  const activeTabLabel = settingsTabs.find((tab) => tab.id === activeTab)?.label;

  const selectTab = (tab) => {
    setActiveTab(tab.id);
    setError('');
    setSuccess('');
    tab.onSelect?.();
  };

  // WAI-ARIA tabs pattern: arrow keys / Home / End move between tabs (automatic
  // activation, so the panel always matches the focused tab). Only the selected
  // tab is in the Tab order (roving tabindex), so Tab moves on into the panel.
  const handleTabKeyDown = (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const tabEls = Array.from(e.currentTarget.querySelectorAll('[role="tab"]'));
    const current = tabEls.indexOf(document.activeElement);
    if (current === -1) return;

    e.preventDefault();
    let next = current;
    if (e.key === 'ArrowRight') next = (current + 1) % tabEls.length;
    else if (e.key === 'ArrowLeft') next = (current - 1 + tabEls.length) % tabEls.length;
    else if (e.key === 'Home') next = 0;
    else next = tabEls.length - 1;
    tabEls[next].focus();
    tabEls[next].click();
  };

  return (
    <div className={pageMode ? 'settings-page' : 'settings-container'}>
      <div className={`settings-panel${pageMode ? ' settings-panel-page' : ''}`}>
        <div className="settings-header">
          <h1>Account Settings</h1>
          {!pageMode && (
            <button onClick={onClose} className="close-btn" title="Close settings">
              <X size={18} />
            </button>
          )}
        </div>

        <div
          className="settings-tabs"
          role="tablist"
          aria-label="Settings sections"
          onKeyDown={handleTabKeyDown}
        >
          {settingsTabs.map((tab) => {
            const selected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`settings-tab-${tab.id}`}
                aria-selected={selected}
                aria-controls="settings-tabpanel"
                tabIndex={selected ? 0 : -1}
                className={`tab-btn ${selected ? 'active' : ''}`}
                onClick={() => selectTab(tab)}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        <div role="alert" className="live-region">
          {error && <div className="settings-error">{error}</div>}
        </div>
        <div role="status" className="live-region">
          {success && <div className="settings-success">{success}</div>}
        </div>

        <div role="tabpanel" id="settings-tabpanel" aria-labelledby={`settings-tab-${activeTab}`}>
        <h2 className="sr-only">{activeTabLabel}</h2>
        {activeTab === 'username' && (
          <form onSubmit={handleUsernameSubmit} className="settings-form">
            <div className="form-field">
              <label htmlFor="current-username">Current Username</label>
              <input
                type="text"
                id="current-username"
                value={user?.username || ''}
                disabled
                className="input-disabled"
              />
            </div>

            <div className="form-field">
              <label htmlFor="new-username">New Username</label>
              <input
                type="text"
                id="new-username"
                name="newUsername"
                value={usernameForm.newUsername}
                onChange={handleUsernameChange}
                required
                minLength={2}
                maxLength={INPUT_LIMITS.username}
                placeholder="Enter your new username"
                pattern="\S+"
                title="Username cannot contain spaces"
              />
            </div>

            <div className="form-field">
              <label htmlFor="username-password">Password (for verification)</label>
              <input
                type="password"
                id="username-password"
                name="password"
                value={usernameForm.password}
                onChange={handleUsernameChange}
                required
                placeholder="Enter your password"
              />
            </div>

            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? 'Updating...' : 'Update Username'}
            </button>
          </form>
        )}

        {activeTab === 'email' && (
          <form onSubmit={handleEmailSubmit} className="settings-form">
            <div className="form-field">
              <label htmlFor="current-email">Current Email</label>
              <input
                type="email"
                id="current-email"
                value={user?.email || ''}
                disabled
                className="input-disabled"
              />
            </div>

            <div className="form-field">
              <label htmlFor="new-email">New Email</label>
              <input
                type="email"
                id="new-email"
                name="newEmail"
                value={emailForm.newEmail}
                onChange={handleEmailChange}
                required
                maxLength={INPUT_LIMITS.email}
                placeholder="Enter your new email"
              />
            </div>

            <div className="form-field">
              <label htmlFor="email-password">Password (for verification)</label>
              <input
                type="password"
                id="email-password"
                name="password"
                value={emailForm.password}
                onChange={handleEmailChange}
                required
                placeholder="Enter your password"
              />
            </div>

            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? 'Updating...' : 'Update Email'}
            </button>
          </form>
        )}

        {activeTab === 'password' && (
          <form onSubmit={handlePasswordSubmit} className="settings-form">
            <div className="form-field">
              <label htmlFor="current-password">Current Password</label>
              <input
                type="password"
                id="current-password"
                name="currentPassword"
                value={passwordForm.currentPassword}
                onChange={handlePasswordChange}
                required
                placeholder="Enter your current password"
              />
            </div>

            <div className="form-field">
              <label htmlFor="new-password">New Password</label>
              <input
                type="password"
                id="new-password"
                name="newPassword"
                value={passwordForm.newPassword}
                onChange={handlePasswordChange}
                required
                placeholder="Enter your new password"
                aria-describedby="new-password-hint"
                minLength={6}
                maxLength={INPUT_LIMITS.password}
              />
              <small id="new-password-hint" className="form-hint">At least 6 characters</small>
            </div>

            <div className="form-field">
              <label htmlFor="confirm-password">Confirm New Password</label>
              <input
                type="password"
                id="confirm-password"
                name="confirmPassword"
                value={passwordForm.confirmPassword}
                onChange={handlePasswordChange}
                required
                placeholder="Confirm your new password"
                minLength={6}
                maxLength={INPUT_LIMITS.password}
              />
            </div>

            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? 'Updating...' : 'Update Password'}
            </button>
          </form>
        )}

        {activeTab === 'publicProfile' && (
          <div className="settings-form">
            <p>
              Turn this on to let anyone with your link view your non-private bookmarks, browsable
              by tag. All bookmarks are included by default &mdash; mark individual bookmarks
              private from your bookmark list to keep them out of your public profile.
            </p>
            {isSuspended && (
              <p className="settings-suspended-notice" role="note">
                Your account has been suspended, so your profile is hidden and can&apos;t be made
                public. Your bookmarks are unaffected. If you think this is a mistake,{' '}
                <a href="/support">contact support</a>.
              </p>
            )}
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={Boolean(user?.profile_public)}
                onChange={handleTogglePublicProfile}
                disabled={loading || (isSuspended && !user?.profile_public)}
              />
              <span>Make my profile public</span>
            </label>

            {Boolean(user?.profile_public) && !isSuspended && (
              <>
                <div className="public-profile-link">
                  <input
                    type="text"
                    readOnly
                    aria-label="Public profile URL"
                    value={publicProfileUrl}
                    onFocus={(e) => e.target.select()}
                  />
                  <button type="button" onClick={() => handleCopyText(publicProfileUrl)} className="btn-secondary">
                    <Copy size={14} /> Copy link
                  </button>
                </div>

                <div>
                  <strong>API access</strong>
                  <p>
                    The same bookmarks are also available as JSON, so you can pull them into another
                    site &mdash; cross-origin requests are already allowed. Leave the tag field blank
                    for all public bookmarks, or enter a tag to get only bookmarks with that tag.
                  </p>
                </div>

                <div className="form-field">
                  <label htmlFor="public-api-tag">Tag (optional)</label>
                  <input
                    id="public-api-tag"
                    type="text"
                    value={publicApiTagInput}
                    onChange={(e) => setPublicApiTagInput(e.target.value)}
                    placeholder="e.g. poe2"
                  />
                </div>

                <div className="public-profile-link">
                  <input
                    type="text"
                    readOnly
                    aria-label="Public API URL"
                    value={publicApiUrl}
                    onFocus={(e) => e.target.select()}
                  />
                  <button type="button" onClick={() => handleCopyText(publicApiUrl)} className="btn-secondary">
                    <Copy size={14} /> Copy API URL
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {activeTab === 'preferences' && (
          <div className="settings-form">
            <div>
              <strong>Open bookmark links in</strong>
              <p>
                Where a bookmark opens when you click its link on this site. Saved to your account,
                so it follows you to any browser you sign in from. The browser extension has its own
                separate setting for its sidebar list.
              </p>
            </div>
            <div className="preference-options" role="radiogroup" aria-label="Open bookmark links in">
              {LINK_TARGET_ORDER.map((option) => (
                <label key={option} className="toggle-row">
                  <input
                    type="radio"
                    name="link-target"
                    value={option}
                    checked={linkTarget === option}
                    onChange={() => onSelectLinkTarget?.(option)}
                  />
                  <span>{LINK_TARGET_LABELS[option]}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Unreachable while the API Keys tab button above is commented out */}
        {activeTab === 'apiKeys' && (
          <div className="api-keys-panel">
            <form onSubmit={handleCreateApiKey} className="settings-form api-key-create-form">
              <div className="form-field">
                <label htmlFor="api-key-name">Key Name (optional)</label>
                <input
                  type="text"
                  id="api-key-name"
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  maxLength={INPUT_LIMITS.apiKeyName}
                  placeholder="e.g. Chrome extension"
                />
              </div>

              <button type="submit" className="btn-primary" disabled={loading}>
                <KeyRound size={16} />
                <span>{loading ? 'Generating...' : 'Generate API Key'}</span>
              </button>
            </form>

            {generatedApiKey && (
              <div className="generated-key-box">
                <p className="generated-key-note">
                  Copy this key now. You won&apos;t see it again: only a hash is stored, so it can&apos;t be
                  shown later. If you lose it, revoke it and generate a new one.
                </p>
                <code>{generatedApiKey}</code>
                <button type="button" className="btn-secondary" onClick={handleCopyApiKey}>
                  <Copy size={16} />
                  <span>Copy Key</span>
                </button>
              </div>
            )}

            <div className="api-keys-list">
              <div className="api-keys-list-header">
                <label className="show-revoked-toggle">
                  <input
                    type="checkbox"
                    checked={showRevokedKeys}
                    onChange={(e) => setShowRevokedKeys(e.target.checked)}
                  />
                  <span>Show revoked keys</span>
                </label>
              </div>

              {loadingKeys ? (
                <p className="api-keys-empty">Loading API keys...</p>
              ) : visibleApiKeys.length === 0 ? (
                <p className="api-keys-empty">No API keys yet.</p>
              ) : (
                visibleApiKeys.map((key) => (
                  <div key={key.id} className="api-key-item">
                    <div>
                      <p className="api-key-name">{key.name}</p>
                      <p className="api-key-meta">
                        {key.key_prefix}...{key.key_last4} • Created {new Date(key.created_at).toLocaleDateString()}
                        {key.last_used_at && ` • Last used ${new Date(key.last_used_at).toLocaleDateString()}`}
                      </p>
                      {key.revoked_at && (
                        <p className="api-key-revoked">Revoked {new Date(key.revoked_at).toLocaleDateString()}</p>
                      )}
                    </div>

                    <div className="api-key-actions">
                      {!key.revoked_at && (
                        <button
                          type="button"
                          className="btn-secondary api-key-revoke-btn"
                          onClick={() => handleRevokeApiKey(key.id)}
                        >
                          <Ban size={15} />
                          <span>Revoke</span>
                        </button>
                      )}
                      {key.revoked_at && (
                        <button
                          type="button"
                          className="btn-secondary api-key-delete-btn"
                          onClick={() => handleDeleteApiKey(key.id)}
                        >
                          <Trash2 size={15} />
                          <span>Delete</span>
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {activeTab === 'billing' && (
          <div className="settings-billing-tab">
            <div className="billing-current-plan">
              <div className="billing-plan-badge">
                {currentMembershipTier === 'paid' ? (
                  <><Zap size={16} /> Pro</>
                ) : (
                  <><CreditCard size={16} /> Free</>
                )}
              </div>
              <p className="billing-plan-label">
                {currentMembershipTier === 'paid'
                  ? 'You are on the Pro plan.'
                  : `You are on the Free plan (up to 50 bookmarks).`}
              </p>
            </div>

            {currentMembershipTier === 'paid' ? (
              <div className="billing-manage">
                <p className="billing-manage-description">
                  Manage your subscription, update payment method, or cancel via the Stripe portal.
                </p>
                {cancellationDateLabel && (
                  <p className="billing-cancel-note">
                    Your Pro plan is scheduled to end on {cancellationDateLabel}. You keep Pro access until then.
                  </p>
                )}
                <button
                  type="button"
                  className="btn-primary billing-btn"
                  onClick={handleManageSubscription}
                  disabled={billingLoading}
                >
                  {billingLoading ? 'Loading...' : 'Manage Subscription'}
                </button>
              </div>
            ) : (
              <div className="billing-upgrade">
                <p className="billing-upgrade-description">
                  Upgrade to Pro for unlimited bookmarks.
                </p>
                <div className="billing-plan-options">
                  {plans.filter((p) => p.available).length === 0 ? (
                    <p className="billing-unavailable">Paid plans are not available on this instance.</p>
                  ) : (
                    plans
                      .filter((p) => p.available)
                      .map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          className="billing-plan-option"
                          onClick={() => handleUpgrade(p.id)}
                          disabled={billingLoading}
                        >
                          <CheckCircle size={16} />
                          <span>{p.id === 'monthly' ? 'Monthly' : 'Annual'}</span>
                        </button>
                      ))
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === 'extensions' && (
          <div className="settings-extensions-tab">
            <p className="settings-extensions-description">
              Install the Tagstash browser extension to save the current page directly into your account.
            </p>

            <div className="settings-extensions-grid">
              <a
                href="https://addons.mozilla.org/en-US/firefox/addon/tagstash/"
                target="_blank"
                rel="noreferrer"
                className="settings-extension-card"
              >
                <img src="/firefox.svg" alt="Firefox" className="settings-extension-icon" />
                <h3>Firefox</h3>
                <span className="settings-extension-preferred-badge">Preferred</span>
                <p>Save the current tab without leaving the page. Great for quick capture while browsing.</p>
                <p className="settings-extension-sidebar-note">Browse your full tag library and save pages from a persistent Firefox sidebar.</p>
                <span className="settings-extension-link-text">Open Add-ons listing →</span>
              </a>
              <a
                href="https://chromewebstore.google.com/detail/tagstash/ijoaejbpaibpodnohjmlbeanfhjdgoab"
                target="_blank"
                rel="noreferrer"
                className="settings-extension-card"
              >
                <img src="/chrome.svg" alt="Chrome" className="settings-extension-icon" />
                <h3>Chrome</h3>
                <p>Save the current tab without leaving the page. Great for quick capture while browsing.</p>
                <span className="settings-extension-link-text">Open Web Store listing →</span>
              </a>
            </div>
          </div>
        )}

        {activeTab === 'import' && (
          <div className="settings-import-tab">
            <p className="settings-import-description">
              Import bookmarks from other services into Tagstash.
            </p>
            <Import onImportComplete={onImportComplete} />
            <Export />
          </div>
        )}

        {activeTab === 'admin' && isSuperAdmin && (
          <div className="admin-users-panel">
            <p className="admin-users-description">
              Manage account access. Free users are limited to 50 bookmarks; paid users are unlimited.
              Public profiles below the indexing bar are served with noindex and left out of the
              sitemap. Suspending an account hides its profile; the owner can still sign in.
            </p>

            <div className="admin-users-search-wrap">
              <input
                type="text"
                aria-label="Search users"
                value={adminUserQuery}
                onChange={(e) => setAdminUserQuery(e.target.value)}
                placeholder="Search by email, username, id, role, or tier"
                className="admin-users-search"
              />
              <span className="admin-users-search-count">
                {filteredAdminUsers.length} match{filteredAdminUsers.length === 1 ? '' : 'es'}
              </span>
            </div>

            {loadingAdminUsers ? (
              <p className="admin-users-empty">Loading users...</p>
            ) : adminUsers.length === 0 ? (
              <p className="admin-users-empty">No users found.</p>
            ) : filteredAdminUsers.length === 0 ? (
              <p className="admin-users-empty">No users match that search.</p>
            ) : (
              <div className="admin-users-list">
                {filteredAdminUsers.map((member) => (
                  <div key={member.id} className="admin-user-row">
                    <div className="admin-user-meta">
                      <p className="admin-user-name">{member.username}</p>
                      <p className="admin-user-email">{member.email}</p>
                      <p className="admin-user-count">Bookmarks: {member.bookmark_count}</p>
                      <p className="admin-user-last-login">
                        Last login:{' '}
                        {member.last_login_at
                          ? new Date(member.last_login_at).toLocaleString(undefined, {
                              year: 'numeric',
                              month: 'short',
                              day: 'numeric',
                              hour: 'numeric',
                              minute: '2-digit',
                            })
                          : 'Never'}
                      </p>
                      {member.locked_until && member.locked_until > Date.now() && (
                        <p className="admin-user-locked">
                          Locked after failed logins until{' '}
                          {new Date(member.locked_until).toLocaleTimeString(undefined, {
                            hour: 'numeric',
                            minute: '2-digit',
                          })}
                        </p>
                      )}
                      {member.stripe_customer_id && (
                        <p className="admin-user-stripe-id">
                          Stripe: <code>{member.stripe_customer_id}</code>
                        </p>
                      )}
                      <p className="admin-user-profile">
                        Profile:{' '}
                        {member.suspended_at
                          ? 'hidden (suspended)'
                          : member.profile_public
                            ? (
                              <>
                                <a href={`/u/${encodeURIComponent(member.username)}`} target="_blank" rel="noopener noreferrer">
                                  public
                                </a>
                                {member.meets_indexing_bar ? ', indexed' : ', noindex (below bar)'}
                              </>
                            )
                            : 'private'}
                      </p>
                      {member.suspended_at && (
                        <p className="admin-user-suspended">Suspended {member.suspended_at} UTC</p>
                      )}
                    </div>

                    <div className="admin-user-controls">
                      <label>
                        Tier
                        <select
                          value={member.membership_tier}
                          onChange={(e) =>
                            handleAdminFieldChange(member.id, 'membership_tier', e.target.value)
                          }
                        >
                          <option value="free">free</option>
                          <option value="paid">paid</option>
                        </select>
                      </label>

                      <label>
                        Role
                        <select
                          value={member.role}
                          onChange={(e) => handleAdminFieldChange(member.id, 'role', e.target.value)}
                        >
                          <option value="user">user</option>
                          <option value="super_admin">super_admin</option>
                        </select>
                      </label>

                      <div className="admin-user-actions">
                        <button
                          type="button"
                          className="btn-primary"
                          onClick={() => handleSaveAdminUser(member)}
                          disabled={savingAdminUserId === member.id}
                        >
                          <CheckCircle size={14} className="btn-icon" />
                          {savingAdminUserId === member.id ? 'Saving...' : 'Save'}
                        </button>

                        <button
                          type="button"
                          className="btn-primary btn-danger"
                          onClick={() => handleDeleteAdminUser(member)}
                          disabled={
                            deletingAdminUserId === member.id ||
                            member.id === user?.id ||
                            member.role === 'super_admin'
                          }
                          title={
                            member.id === user?.id
                              ? 'You cannot delete your own account from this panel'
                              : member.role === 'super_admin'
                                ? 'Configured super admin account cannot be deleted'
                                : 'Delete this account and all bookmarks'
                          }
                        >
                          <Trash2 size={14} className="btn-icon" />
                          {deletingAdminUserId === member.id ? 'Deleting...' : 'Delete'}
                        </button>
                      </div>

                      <div className="admin-user-actions">
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => handleModerateAdminUser(member, 'make-private')}
                          disabled={moderatingAdminUserId === member.id || !member.profile_public}
                          title={member.profile_public ? 'Turn this profile private' : 'Profile is already private'}
                        >
                          <EyeOff size={14} className="btn-icon" />
                          Make private
                        </button>

                        {member.suspended_at ? (
                          <button
                            type="button"
                            className="btn-secondary"
                            onClick={() => handleModerateAdminUser(member, 'unsuspend')}
                            disabled={moderatingAdminUserId === member.id}
                            title="Allow this account to publish a profile again (does not re-publish it)"
                          >
                            <CheckCircle size={14} className="btn-icon" />
                            Unsuspend
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn-primary btn-danger"
                            onClick={() => handleModerateAdminUser(member, 'suspend')}
                            disabled={
                              moderatingAdminUserId === member.id ||
                              !moderationAvailable ||
                              member.id === user?.id ||
                              member.role === 'super_admin'
                            }
                            title={
                              !moderationAvailable
                                ? 'Suspension needs database migration 0016'
                                : member.id === user?.id || member.role === 'super_admin'
                                  ? 'Super admin accounts cannot be suspended'
                                  : 'Hide this account’s public profile and block re-publishing'
                            }
                          >
                            <Ban size={14} className="btn-icon" />
                            Suspend
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <h3 className="admin-events-heading">Recent security events</h3>
            <p className="admin-users-description">
              Failed logins, lockouts, rate-limited requests, password-reset requests and admin
              moderation actions from the last 30 days.
            </p>
            {loadingAuthEvents ? (
              <p className="admin-users-empty">Loading events...</p>
            ) : authEvents.length === 0 ? (
              <p className="admin-users-empty">No security events recorded.</p>
            ) : (
              <div className="admin-events-table-wrap">
                <table className="admin-events-table">
                  <thead>
                    <tr>
                      <th scope="col">When (UTC)</th>
                      <th scope="col">Event</th>
                      <th scope="col">Email</th>
                      <th scope="col">IP</th>
                      <th scope="col">By admin</th>
                    </tr>
                  </thead>
                  <tbody>
                    {authEvents.map((event) => (
                      <tr key={event.id}>
                        <td>{event.created_at}</td>
                        <td>{event.event_type.replace(/_/g, ' ')}</td>
                        <td>{event.email || '—'}</td>
                        <td>{event.ip || '—'}</td>
                        <td>{event.actor_username || (event.actor_user_id ? `#${event.actor_user_id}` : '—')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
        </div>
      </div>
    </div>
  );
}

export default Settings;
