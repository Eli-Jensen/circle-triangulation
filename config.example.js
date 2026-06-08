/**
 * GeoTools configuration template.
 * Copy to config.js and fill in your Firebase values.
 *
 *   cp config.example.js config.js
 */
window.APP_CONFIG = {
  // Backend API URL (local dev default)
  apiBase: 'http://localhost:8081',

  // Firebase configuration — get from Firebase Console → Project Settings
  firebase: {
    apiKey: '',
    authDomain: '',
    projectId: '',
    storageBucket: '',
    messagingSenderId: '',
    appId: '',
  },

  // Whitelisted Google accounts
  whitelist: [],

  // Show dev tools section
  devTools: true,
};
