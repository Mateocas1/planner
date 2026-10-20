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

/**
 * The OAuth web client id of the Google Calendar import (value roadmap §1).
 *
 * Like the config above it is public by design: a web client id names the
 * project in a consent prompt and is shipped to every browser, while the
 * authorization itself is enforced by the Google accounts that consent. It is
 * not a secret, so committing it is correct rather than a mistake. Only the two
 * read-only calendar scopes are requested (data/google-client.ts), and the
 * client's authorized origins are the Hosting domain and the dev server.
 *
 * `VITE_GOOGLE_CLIENT_ID` overrides it (a fork, or a second Cloud project),
 * read through `import.meta.env` -- which Node does not define, hence the
 * optional chain: the unit tests load this module outside Vite.
 */
export const googleClientId: string =
  (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.VITE_GOOGLE_CLIENT_ID
  || "698694280142-2dhb6jrkcbua54fl04vnrp1s53vlldas.apps.googleusercontent.com";
