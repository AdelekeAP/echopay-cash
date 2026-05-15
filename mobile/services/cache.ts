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
import { TransactionRow } from '../types/transaction';

const KEY_PREFIX = 'echopay:tx:';
const MAX_ROWS = 200;

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
}
