// Test-only env. constants/config.ts throws if EXPO_PUBLIC_API_BASE_URL
// is missing — set a placeholder so the module loads without screaming.
process.env.EXPO_PUBLIC_API_BASE_URL = 'http://localhost:8100';
