// TODO: tests pending Jest setup. Inline assertions live in dev only — see
// the assertion block at the bottom of this file (stripped by Metro in prod).

/**
 * All monetary amounts are stored as integers in kobo (1 naira = 100 kobo).
 * Display formatting converts kobo → human-readable naira.
 *
 *   formatKoboToNaira(500000)  → "₦5,000"
 *   formatKoboToNaira(20050)   → "₦200.50"
 *   parseNairaToKobo("₦5,000") → 500000
 *   parseNairaToKobo("200.50") → 20050
 *
 * Round-trip rule: parseNairaToKobo(formatKoboToNaira(k)) === k for any
 * non-negative integer k. parseNairaToKobo rounds to the nearest kobo on
 * inputs with sub-kobo precision (e.g. "0.005" → 1).
 */

export function formatKoboToNaira(kobo: number): string {
  if (!Number.isFinite(kobo)) {
    throw new TypeError(`formatKoboToNaira expected finite number, got ${kobo}`);
  }
  const negative = kobo < 0;
  const abs = Math.abs(Math.trunc(kobo));
  const nairaWhole = Math.floor(abs / 100);
  const koboPart = abs % 100;
  const wholeStr = nairaWhole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = koboPart === 0
    ? wholeStr
    : `${wholeStr}.${koboPart.toString().padStart(2, '0')}`;
  return `${negative ? '-' : ''}₦${body}`;
}

export function parseNairaToKobo(input: string): number {
  if (typeof input !== 'string') {
    throw new TypeError(`parseNairaToKobo expected string, got ${typeof input}`);
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) return 0;
  const negative = trimmed.startsWith('-');
  const cleaned = trimmed.replace(/[₦,\s]/g, '').replace(/^-/, '');
  if (cleaned.length === 0 || !/^\d*(\.\d*)?$/.test(cleaned)) {
    throw new RangeError(`parseNairaToKobo could not parse: ${JSON.stringify(input)}`);
  }
  const naira = Number(cleaned);
  if (!Number.isFinite(naira)) {
    throw new RangeError(`parseNairaToKobo non-finite result for: ${JSON.stringify(input)}`);
  }
  const kobo = Math.round(naira * 100);
  return negative ? -kobo : kobo;
}

// Inline dev-only assertions — run once on import in __DEV__ builds.
// Replace with proper Jest tests once a test framework lands.
if (typeof __DEV__ !== 'undefined' && __DEV__) {
  const assertEq = <T>(actual: T, expected: T, label: string) => {
    if (actual !== expected) {
      console.warn(`[format.ts] assertion failed (${label}): expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };
  assertEq(formatKoboToNaira(500000), '₦5,000', 'format whole naira with comma');
  assertEq(formatKoboToNaira(20050), '₦200.50', 'format naira with kobo');
  assertEq(formatKoboToNaira(0), '₦0', 'format zero');
  assertEq(parseNairaToKobo('₦5,000'), 500000, 'parse formatted with symbol + comma');
  assertEq(parseNairaToKobo('200.50'), 20050, 'parse decimal without symbol');
}
