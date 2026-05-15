// Single source of truth for the echopay-cash backend base URL.
//
// EXPO_PUBLIC_* env vars are inlined at build time by Metro. The value is
// read from .env at the repo root (see .env.example).
//
// Loud failure on missing env beats silent fallback — on a physical device,
// a wrong base URL produces network-error toasts on every screen with no
// hint as to why. The throw forces the dev to fix .env before the first
// boot.

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL;
if (!API_BASE_URL) {
  throw new Error(
    'EXPO_PUBLIC_API_BASE_URL not set. Copy .env.example to .env and set ' +
      'your dev machine LAN IP. Get it with: ipconfig getifaddr en0 (macOS) ' +
      'or hostname -I (Linux).',
  );
}

export { API_BASE_URL };
