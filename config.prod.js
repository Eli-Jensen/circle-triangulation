/**
 * GeoTools production configuration.
 * Deployed to Firebase Hosting via CI.
 */
window.APP_CONFIG = {
  // Backend API URL (Cloud Run — will be updated in Phase 3)
  apiBase: '',

  // Firebase configuration
  firebase: {
    apiKey: 'AIzaSyBErhVy-06YoozfyAd7_704wdcTrfmj6Bk',
    authDomain: 'geotools-ej.firebaseapp.com',
    projectId: 'geotools-ej',
    storageBucket: 'geotools-ej.firebasestorage.app',
    messagingSenderId: '1040408463154',
    appId: '1:1040408463154:web:f905a92555e8da22d3792b',
  },

  // Whitelisted Google accounts (client-side check for UX; server enforces too)
  whitelist: [
    'eli.mit.jensen@gmail.com',
    'twotoedsleuth@gmail.com',
    'halospartan34@gmail.com',
  ],

  // Hide dev tools in production
  devTools: false,
};
