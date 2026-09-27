/**
 * Firebase web configuration for the production project.
 *
 * A Firebase web config is public by design: it ships to every browser that
 * loads the app, and the API key is an identifier, not a secret. Access is
 * enforced by the Firestore security rules, so committing this file is
 * correct rather than a mistake.
 */
export const firebaseConfig = {
  projectId: "cumbia-4ca6e",
  appId: "1:698694280142:web:b6aa6e59212c19a6fc019f",
  apiKey: "AIzaSyBy9acbQZO2cihWaQ-mOiEQMeYVTybcnyo",
  authDomain: "cumbia-4ca6e.firebaseapp.com",
  storageBucket: "cumbia-4ca6e.firebasestorage.app",
  messagingSenderId: "698694280142",
};
