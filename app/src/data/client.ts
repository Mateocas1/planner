import { initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth } from "firebase/auth";
import { connectFirestoreEmulator, initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from "firebase/firestore";

const projectId = "demo-calendar-app";
const allowedOrigins = new Set(["localhost", "127.0.0.1"]);

if (!allowedOrigins.has(window.location.hostname)) {
  throw new Error("Personal planner only runs from localhost or 127.0.0.1");
}

const app = initializeApp({ projectId, apiKey: "local-only" });
export const auth = getAuth(app);
connectAuthEmulator(auth, "http://127.0.0.1:9199", { disableWarnings: true });
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});
connectFirestoreEmulator(db, "127.0.0.1", 8187);
