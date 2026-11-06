import { initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth } from "firebase/auth";
import { connectFirestoreEmulator, initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from "firebase/firestore";
import { firebaseConfig } from "./firebase-config.ts";
import { usesEmulators } from "./origin.ts";

// Origin-driven configuration (rule and cases in origin.ts).
//
// This replaces the guard that used to throw on a non-local origin. That guard
// was right while the app was local-only; now the non-local origin is the
// production case, so the throw is removed deliberately rather than silently.
const isLocal = usesEmulators(window.location);

const app = initializeApp(
  isLocal ? { projectId: "demo-calendar-app", apiKey: "local-only" } : firebaseConfig,
);
export const auth = getAuth(app);
export const db = initializeFirestore(app, {
  // The persistent local cache and multi-tab manager are kept on both paths:
  // offline is a core product promise, not a development convenience.
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

if (isLocal) {
  connectAuthEmulator(auth, "http://127.0.0.1:9199", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8187);
}
