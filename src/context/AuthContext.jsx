import { createContext, useState, useContext, useEffect, useCallback } from 'react';
import { authAPI } from '../api/api';

const AuthContext = createContext(null);

// eslint-disable-next-line react-refresh/only-export-components
export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refreshCurrentUser = useCallback(async () => {
    const response = await authAPI.getCurrentUser();
    localStorage.removeItem('token');
    setUser(response.data.user);
    return response.data.user;
  }, []);

  useEffect(() => {
    const restoreSession = async () => {
      const legacyToken = localStorage.getItem('token');
      if (legacyToken) {
        try {
          await authAPI.upgradeSession(legacyToken);
        } catch (err) {
          // Keep it for a later upgrade if the server is temporarily unreachable.
          if (![401, 403].includes(err.response?.status)) throw err;
        }
        localStorage.removeItem('token');
      }
      await refreshCurrentUser();
    };
    restoreSession().catch(() => {}).finally(() => setLoading(false));
  }, [refreshCurrentUser]);

  const describeAuthError = (err, fallback) => {
    if (err.response?.data?.error) return err.response.data.error;
    // A Cloudflare rate-limiting block answers 429 with an HTML page, not our JSON error.
    if (err.response?.status === 429) return 'Too many attempts. Please wait a moment and try again.';
    if (err.request) return 'Unable to reach the server. Please check your connection and try again.';
    return fallback;
  };

  const register = async (username, email, password) => {
    try {
      setError(null);
      const response = await authAPI.register(username, email, password);
      if (response.data.pendingVerification) {
        return { success: true, pendingVerification: true };
      }
      localStorage.removeItem('token');
      setUser(response.data.user);
      return { success: true };
    } catch (err) {
      const errorMessage = describeAuthError(err, 'Registration failed');
      setError(errorMessage);
      return { success: false, error: errorMessage };
    }
  };

  const login = async (email, password) => {
    try {
      setError(null);
      const response = await authAPI.login(email, password);
      localStorage.removeItem('token');
      setUser(response.data.user);
      return { success: true };
    } catch (err) {
      const errorMessage = describeAuthError(err, 'Login failed');
      setError(errorMessage);
      // The password was right, but a deletion of this account was started and never finished.
      return { success: false, error: errorMessage, deletionPending: err.response?.data?.deletionPending === true };
    }
  };

  const logout = async () => {
    // Only clear UI state once the server has removed the HttpOnly cookie.
    try {
      await authAPI.logout();
    } catch (err) {
      setError(describeAuthError(err, 'Sign out failed. Please try again.'));
      return;
    }
    localStorage.removeItem('token');
    setUser(null);
  };

  const updateUser = (nextUser) => {
    setUser(nextUser);
  };

  const value = {
    user,
    loading,
    error,
    register,
    login,
    logout,
    refreshCurrentUser,
    updateUser,
    isAuthenticated: !!user,
  };

  return (
    <AuthContext.Provider value={value}>
      {user && error && <div className="error-message" role="alert">{error}</div>}
      {children}
    </AuthContext.Provider>
  );
};
