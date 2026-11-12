/**
 * Firebase — progetto tag-impianto
 * Finché restano placeholder YOUR_* l’app lavora solo in locale (IndexedDB).
 */
export const firebaseConfig = {
  apiKey: "AIzaSyBwJpwQwbB-DMttlSOpj857dkGTk3cSWyg",
  authDomain: "tag-impianto.firebaseapp.com",
  projectId: "tag-impianto",
  storageBucket: "tag-impianto.firebasestorage.app",
  messagingSenderId: "644994436298",
  appId: "1:644994436298:web:083df769fb5d6d92027833",
};

export function isFirebaseConfigured() {
  return (
    !!firebaseConfig.apiKey &&
    firebaseConfig.apiKey !== "YOUR_API_KEY" &&
    !!firebaseConfig.projectId &&
    firebaseConfig.projectId !== "YOUR_PROJECT_ID"
  );
}
