// Local transaction cache.
//
// For the hackathon scope we use AsyncStorage across both platforms — one
// JSON blob per user. The PRD §15.7 calls for SQLite + WAL on phone for the
// outbox; that's an M2 deliverable when the offline-permit work lands.
// Until then, AsyncStorage is good enough for the demo and avoids platform
// branching that would slow us down.
//
// Storage shape:
//   key: `echopay:tx:<user_id>`
//   value: JSON array of TransactionRow, newest first, capped at MAX_ROWS.
//
// idempotency_key is the dedupe column. writeTransaction() ignores rows
// with a key that already exists — same semantics as a SQLite
// `INSERT OR IGNORE`.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { TransactionRow, OutboxRow, OutboxStatus } from '../types/transaction';

const KEY_PREFIX = 'echopay:tx:';
const OUTBOX_KEY_PREFIX = 'echopay:outbox:';
const MAX_ROWS = 200;
const MAX_OUTBOX_ROWS = 100;

function keyFor(userId: number): string {
  return `${KEY_PREFIX}${userId}`;
}

async function readAll(userId: number): Promise<TransactionRow[]> {
  try {
    const raw = await AsyncStorage.getItem(keyFor(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn('[cache] readAll failed:', e);
    return [];
  }
}

async function writeAll(userId: number, rows: TransactionRow[]): Promise<void> {
  await AsyncStorage.setItem(keyFor(userId), JSON.stringify(rows));
}

export async function writeTransaction(tx: TransactionRow): Promise<void> {
  const rows = await readAll(tx.user_id);
  if (rows.some((r) => r.idempotency_key === tx.idempotency_key)) {
    // Duplicate write — INSERT OR IGNORE semantics.
    return;
  }
  rows.unshift(tx);
  if (rows.length > MAX_ROWS) rows.length = MAX_ROWS;
  await writeAll(tx.user_id, rows);
}

export async function getRecentTx(userId: number, limit = 20): Promise<TransactionRow[]> {
  const rows = await readAll(userId);
  return rows.slice(0, Math.max(0, limit));
}

export async function getTransactionByIdempotencyKey(
  userId: number,
  idempotencyKey: string,
): Promise<TransactionRow | null> {
  const rows = await readAll(userId);
  return rows.find((r) => r.idempotency_key === idempotencyKey) ?? null;
}

export async function clearCache(userId: number): Promise<void> {
  await AsyncStorage.removeItem(keyFor(userId));
  await AsyncStorage.removeItem(outboxKeyFor(userId));
}

// --------------------------------------------------------------- outbox
//
// PRD_FUNBI §11 / EchoPay_Cash_PRD §15.7. Persists offline-queued ops
// so they replay to the backend when the device reconnects. Same
// AsyncStorage-blob-per-user pattern as the tx history; one row per
// pending op. Dedupe column is `idempotency_key` — the backend uses the
// same key on transactions.UNIQUE, so any replay is safe.

function outboxKeyFor(userId: number): string {
  return `${OUTBOX_KEY_PREFIX}${userId}`;
}

async function readAllOutbox(userId: number): Promise<OutboxRow[]> {
  try {
    const raw = await AsyncStorage.getItem(outboxKeyFor(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn('[cache] readAllOutbox failed:', e);
    return [];
  }
}

async function writeAllOutbox(userId: number, rows: OutboxRow[]): Promise<void> {
  await AsyncStorage.setItem(outboxKeyFor(userId), JSON.stringify(rows));
}

export async function writeOutbox(row: OutboxRow): Promise<void> {
  const rows = await readAllOutbox(row.user_id);
  if (rows.some((r) => r.idempotency_key === row.idempotency_key)) {
    // Duplicate enqueue — drop silently. The first enqueue wins.
    return;
  }
  rows.push(row);
  if (rows.length > MAX_OUTBOX_ROWS) rows.shift();
  await writeAllOutbox(row.user_id, rows);
}

export async function readOutboxQueued(
  userId: number,
  limit = 20,
): Promise<OutboxRow[]> {
  const rows = await readAllOutbox(userId);
  const nowIso = new Date().toISOString();
  return rows
    .filter((r) => r.status === 'queued' && r.next_retry_at <= nowIso)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .slice(0, Math.max(0, limit));
}

export async function markOutbox(
  userId: number,
  id: string,
  patch: Partial<Pick<OutboxRow, 'status' | 'attempts' | 'last_error' | 'next_retry_at'>>,
): Promise<void> {
  const rows = await readAllOutbox(userId);
  const i = rows.findIndex((r) => r.id === id);
  if (i === -1) return;
  rows[i] = { ...rows[i], ...patch };
  await writeAllOutbox(userId, rows);
}

export async function getOutboxPendingCount(userId: number): Promise<number> {
  const rows = await readAllOutbox(userId);
  return rows.filter((r) => r.status === 'queued' || r.status === 'sent').length;
}

export async function getOutboxByIdempotencyKey(
  userId: number,
  idempotencyKey: string,
): Promise<OutboxRow | null> {
  const rows = await readAllOutbox(userId);
  return rows.find((r) => r.idempotency_key === idempotencyKey) ?? null;
}

export function buildOutboxRow(input: {
  userId: number;
  fromUserId: number;
  toUserId: number;
  amountKobo: number;
  idempotencyKey: string;
}): OutboxRow {
  const now = new Date().toISOString();
  return {
    id: outboxIdSafe(),
    user_id: input.userId,
    op_type: 'in_network',
    payload: {
      from_user_id: input.fromUserId,
      to_user_id: input.toUserId,
      amount_kobo: input.amountKobo,
    },
    idempotency_key: input.idempotencyKey,
    attempts: 0,
    created_at: now,
    next_retry_at: now,
    status: 'queued',
  };
}

function outboxIdSafe(): string {
  const g = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (g?.randomUUID) return `ob_${g.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  return `ob_${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`;
}

// Computes the next retry timestamp with exponential backoff, capped.
// attempts=0 → +0ms (drain immediately)
// attempts=1 → +2s
// attempts=2 → +4s
// ...attempts=5 → +32s
// Capped at 60s so the drain loop always tries again within a minute.
export function backoffNextRetryAt(attempts: number): string {
  const ms = Math.min(60_000, Math.pow(2, Math.max(0, attempts)) * 1_000);
  return new Date(Date.now() + ms).toISOString();
}

export type { OutboxStatus };
