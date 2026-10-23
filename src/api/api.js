import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || '/api';

const api = axios.create({
  baseURL: API_URL,
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
    'X-Tagstash-Client': 'web',
  },
});

// Auth API
export const authAPI = {
  upgradeSession: (token) =>
    api.post('/auth/session', null, { headers: { Authorization: `Bearer ${token}` } }),

  logout: () => api.post('/auth/logout'),
  register: (username, email, password) =>
    api.post('/auth/register', { username, email, password }),
  
  login: (email, password) =>
    api.post('/auth/login', { email, password }),
  
  getCurrentUser: () =>
    api.get('/auth/me'),

  verifyEmail: (token) =>
    api.get(`/auth/verify-email?token=${encodeURIComponent(token)}`),

  resendVerification: (email) =>
    api.post('/auth/resend-verification', { email }),

  forgotPassword: (email) =>
    api.post('/auth/forgot-password', { email }),

  resetPassword: (token, password) =>
    api.post('/auth/reset-password', { token, password }),

  getApiKeys: () =>
    api.get('/auth/api-keys'),

  createApiKey: (name) =>
    api.post('/auth/api-keys', { name }),

  revokeApiKey: (id) =>
    api.delete(`/auth/api-keys/${id}`),

  deleteApiKey: (id) =>
    api.delete(`/auth/api-keys/${id}/permanent`),

  updateUsername: (newUsername, password) =>
    api.put('/auth/username', { newUsername, password }),

  updateEmail: (newEmail, password) =>
    api.put('/auth/email', { newEmail, password }),

  updatePassword: (currentPassword, newPassword, confirmPassword) =>
    api.put('/auth/password', { currentPassword, newPassword, confirmPassword }),

  // Permanently deletes the signed-in account. The server re-checks the password and the typed
  // confirmation. resumeDeletion finishes a deletion that was interrupted, from the login screen.
  deleteAccount: (password, confirmation) =>
    api.post('/auth/delete-account', { password, confirmation }),

  resumeDeletion: (email, password) =>
    api.post('/auth/resume-deletion', { email, password }),

  updateProfilePublic: (profilePublic) =>
    api.put('/auth/profile-public', { profilePublic }),

  updateTheme: (theme) =>
    api.put('/auth/theme', { theme }),

  updateLinkTarget: (linkTarget) =>
    api.put('/auth/link-target', { linkTarget }),

  adminListUsers: () =>
    api.get('/auth/admin/users'),

  adminUpdateUser: (id, updates) =>
    api.patch(`/auth/admin/users/${id}`, updates),

  adminDeleteUser: (id) =>
    api.delete(`/auth/admin/users/${id}`),

  // action: 'suspend' | 'unsuspend' | 'make-private'
  adminModerateUser: (id, action) =>
    api.post(`/auth/admin/users/${id}/${action}`),

  adminListAuthEvents: () =>
    api.get('/auth/admin/auth-events'),
};

// Bookmarks API
export const bookmarksAPI = {
  getAll: () =>
    api.get('/bookmarks'),
  
  getOne: (id) =>
    api.get(`/bookmarks/${id}`),
  
  create: (bookmarkData) =>
    api.post('/bookmarks', bookmarkData),
  
  update: (id, bookmarkData) =>
    api.put(`/bookmarks/${id}`, bookmarkData),
  
  delete: (id) =>
    api.delete(`/bookmarks/${id}`),

  toggleFavorite: (id) =>
    api.post(`/bookmarks/${id}/favorite`),

  togglePrivate: (id) =>
    api.post(`/bookmarks/${id}/private`),

  fetchMetadata: (url) =>
    api.post('/bookmarks/meta', { url }),

  fetchDescription: (url) =>
    api.post('/bookmarks/meta-description', { url }),
  
  getAllTags: () =>
    api.get('/bookmarks/tags/all'),

  toggleTagFavorite: (id) =>
    api.post(`/bookmarks/tags/${id}/favorite`),

  mergeTags: (sourceTagId, targetTagId) =>
    api.post('/bookmarks/tags/merge', { sourceTagId, targetTagId }),

  renameTag: (id, name) =>
    api.put(`/bookmarks/tags/${id}`, { name }),

  deleteTag: (id) =>
    api.delete(`/bookmarks/tags/${id}`),

  importBookmarks: (bookmarks) =>
    api.post('/bookmarks/import', { bookmarks }),
};

export const billingAPI = {
  getPlans: () =>
    api.get('/billing/plans'),

  getStatus: () =>
    api.get('/billing/status'),

  createCheckoutSession: (plan) =>
    api.post('/billing/checkout-session', { plan }),

  createPortalSession: () =>
    api.post('/billing/portal-session'),
};

export const supportAPI = {
  submit: ({ email, message, captchaToken }) =>
    api.post('/support', { email, message, captchaToken }),
};

export const profileAPI = {
  getPublicProfile: (username) =>
    api.get(`/profiles/${encodeURIComponent(username)}`, {
      // The public API uses wildcard CORS, which cannot be combined with credentials.
      withCredentials: false,
      headers: { 'X-Tagstash-Client': undefined },
    }),
};

export default api;
