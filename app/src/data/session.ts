import { useEffect, useState } from "react";
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from "firebase/auth";
import { auth } from "./client.ts";

export type Session = { loading: boolean; user: User | null };

export function useSession(): Session {
  const [session, setSession] = useState<Session>({ loading: true, user: null });
  useEffect(
    () => onAuthStateChanged(auth, user => setSession({ loading: false, user })),
    [],
  );
  return session;
}

export function createAccount(email: string, password: string) {
  return createUserWithEmailAndPassword(auth, email, password);
}

export function signIn(email: string, password: string) {
  return signInWithEmailAndPassword(auth, email, password);
}

export function signOutUser() {
  return signOut(auth);
}
