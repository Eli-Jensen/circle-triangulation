/**
 * GeoTools Authentication
 * Firebase Auth with Google sign-in + email whitelist.
 */
(function () {
  'use strict';

  const config = window.APP_CONFIG;
  if (!config?.firebase?.apiKey) {
    console.warn('No Firebase config found — auth disabled');
    document.getElementById('login-overlay')?.remove();
    return;
  }

  // Initialize Firebase
  firebase.initializeApp(config.firebase);
  const auth = firebase.auth();
  const provider = new firebase.auth.GoogleAuthProvider();

  // DOM elements
  const overlay = document.getElementById('login-overlay');
  const signInBtn = document.getElementById('sign-in-btn');
  const signOutBtn = document.getElementById('sign-out-btn');
  const loginError = document.getElementById('login-error');
  const userDisplay = document.getElementById('user-display');
  const userAvatar = document.getElementById('user-avatar');
  const userName = document.getElementById('user-name');

  // Current user token (refreshed automatically)
  let currentToken = null;

  /**
   * Check if an email is in the whitelist.
   */
  function isWhitelisted(email) {
    if (!config.whitelist || config.whitelist.length === 0) return true;
    return config.whitelist.includes(email.toLowerCase());
  }

  /**
   * Show the app (hide login overlay).
   */
  function showApp(user) {
    if (overlay) overlay.classList.add('hidden');

    // Show user info + sign out button
    if (userDisplay) userDisplay.style.display = 'flex';
    if (userAvatar && user.photoURL) {
      userAvatar.src = user.photoURL;
      userAvatar.style.display = 'block';
    }
    if (userName) userName.textContent = user.displayName || user.email;
    if (signOutBtn) signOutBtn.style.display = 'inline-block';

    // Hide dev tools in production
    if (config.devTools === false) {
      const devSection = document.querySelector('.dev-tools');
      if (devSection) devSection.style.display = 'none';
    }
  }

  /**
   * Show the login overlay.
   */
  function showLogin(errorMsg) {
    if (overlay) overlay.classList.remove('hidden');
    if (loginError) {
      loginError.textContent = errorMsg || '';
      loginError.style.display = errorMsg ? 'block' : 'none';
    }
    if (userDisplay) userDisplay.style.display = 'none';
    if (signOutBtn) signOutBtn.style.display = 'none';
    currentToken = null;
  }

  /**
   * Handle sign-in button click.
   */
  async function handleSignIn() {
    if (loginError) loginError.style.display = 'none';
    signInBtn.disabled = true;
    signInBtn.textContent = 'Signing in...';

    try {
      await auth.signInWithPopup(provider);
      // onAuthStateChanged will handle the rest
    } catch (err) {
      console.error('Sign-in error:', err);
      if (err.code === 'auth/popup-closed-by-user') {
        // User closed popup — not an error
      } else if (err.code === 'auth/popup-blocked') {
        showLogin('Pop-up blocked. Please allow pop-ups for this site.');
      } else {
        showLogin('Sign-in failed. Please try again.');
      }
    } finally {
      signInBtn.disabled = false;
      signInBtn.textContent = 'Sign in with Google';
    }
  }

  /**
   * Handle sign-out.
   */
  async function handleSignOut() {
    await auth.signOut();
    showLogin();
  }

  /**
   * Auth state listener — fires on login, logout, and page refresh.
   */
  auth.onAuthStateChanged(async (user) => {
    if (user) {
      if (!isWhitelisted(user.email)) {
        showLogin('Access denied. Your account is not authorized to use this app.');
        await auth.signOut();
        return;
      }

      // Get ID token for backend requests
      try {
        currentToken = await user.getIdToken();
        showApp(user);
      } catch (err) {
        console.error('Token error:', err);
        showLogin('Authentication error. Please try again.');
      }
    } else {
      showLogin();
    }
  });

  // Wire up buttons
  if (signInBtn) signInBtn.addEventListener('click', handleSignIn);
  if (signOutBtn) signOutBtn.addEventListener('click', handleSignOut);

  // Export for use by app.js
  window.GeoAuth = {
    /**
     * Get the current Firebase ID token. Refreshes if expired.
     * Returns null if not signed in.
     */
    async getToken() {
      const user = auth.currentUser;
      if (!user) return null;
      try {
        currentToken = await user.getIdToken();
        return currentToken;
      } catch {
        return null;
      }
    },

    /**
     * Get current user email.
     */
    getEmail() {
      return auth.currentUser?.email || null;
    },

    /**
     * Check if user is signed in and whitelisted.
     */
    isAuthenticated() {
      const user = auth.currentUser;
      return user && isWhitelisted(user.email);
    },
  };
})();
