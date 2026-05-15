// Secure-store + AsyncStorage helpers.
// Secrets (ed25519 private key, PIN hash, session token) go to expo-secure-store.
// Non-secrets (last balance, last VA number, cached profile) go to AsyncStorage.
// See PRD §15.3 for the full key-material matrix.
export {};
