// Permit cache + issuance. Master doc §4.2 / PRD §4.
//
// Flow:
//   While online: POST /permits/issue → server returns {permit + sig}.
//   Phone caches it under echopay:permits:<user_id>.
//   Offline: pick a fresh outstanding permit, use it to sign txs.
//   On reconnect: outbox replays the signed bundles to /sync/submit.
//
// Cache shape mirrors the server's Permit row. We track local state
// (`local_status`) separately from the server-side `status`:
//   - 'fresh'        → outstanding, unused
//   - 'partially_used' → at least one tx signed against it
//     (kept for audit; we don't enforce caps here, server does)
//   - 'spent'        → server-acked at least one redemption
//   - 'expired'      → expired_at passed

import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE_URL } from '../constants/config';
import type { PermitBundle } from './crypto';

const KEY_PREFIX = 'echopay:permits:';
const MAX_PERMITS = 50;

export type LocalPermitStatus = 'fresh' | 'partially_used' | 'spent' | 'expired';

export interface LocalPermit extends PermitBundle {
  local_status: LocalPermitStatus;
  cached_at: string;
}

function keyFor(userId: number): string {
  return `${KEY_PREFIX}${userId}`;
}

async function readAll(userId: number): Promise<LocalPermit[]> {
  try {
    const raw = await AsyncStorage.getItem(keyFor(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeAll(userId: number, rows: LocalPermit[]): Promise<void> {
  await AsyncStorage.setItem(keyFor(userId), JSON.stringify(rows));
}

export async function issuePermit(opts: {
  userId: number;
  maxAmountKobo: number;
  ttlSeconds?: number;
  deviceFingerprint?: string;
  token?: string | null;
}): Promise<LocalPermit> {
  const body = {
    user_id: opts.userId,
    max_amount_kobo: opts.maxAmountKobo,
    ...(opts.ttlSeconds ? { ttl_seconds: opts.ttlSeconds } : {}),
    ...(opts.deviceFingerprint
      ? { device_fingerprint: opts.deviceFingerprint }
      : {}),
  };
  const res = await fetch(`${API_BASE_URL}/permits/issue`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail: unknown = null;
    try {
      detail = (await res.json()).detail;
    } catch {
      /* ignore */
    }
    throw new PermitError(
      (detail as { code?: string })?.code ?? 'permit_issue_failed',
      (detail as { message?: string })?.message ?? `HTTP ${res.status}`,
    );
  }
  const json = await res.json();
  const data = json.data as PermitBundle;
  const permit: LocalPermit = {
    ...data,
    local_status: 'fresh',
    cached_at: new Date().toISOString(),
  };
  await cachePermit(opts.userId, permit);
  return permit;
}

export async function cachePermit(
  userId: number,
  permit: LocalPermit,
): Promise<void> {
  const rows = await readAll(userId);
  if (rows.some((r) => r.permit_id === permit.permit_id)) return;
  rows.unshift(permit);
  if (rows.length > MAX_PERMITS) rows.length = MAX_PERMITS;
  await writeAll(userId, rows);
}

export async function getActivePermits(userId: number): Promise<LocalPermit[]> {
  const rows = await readAll(userId);
  const now = Math.floor(Date.now() / 1000);
  const updated = rows.map((p) => {
    if (p.local_status === 'fresh' && p.expires_at <= now) {
      return { ...p, local_status: 'expired' as const };
    }
    return p;
  });
  // Persist any expiry transitions back.
  if (updated.some((p, i) => p.local_status !== rows[i].local_status)) {
    await writeAll(userId, updated);
  }
  return updated.filter((p) => p.local_status === 'fresh' || p.local_status === 'partially_used');
}

export async function markPermitUsed(
  userId: number,
  permitId: string,
  next: LocalPermitStatus,
): Promise<void> {
  const rows = await readAll(userId);
  const i = rows.findIndex((r) => r.permit_id === permitId);
  if (i === -1) return;
  rows[i] = { ...rows[i], local_status: next };
  await writeAll(userId, rows);
}

export class PermitError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'PermitError';
  }
}
