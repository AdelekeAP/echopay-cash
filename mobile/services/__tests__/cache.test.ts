// Unit tests for services/cache.ts — tx history + outbox helpers.
// PRD_FUNBI §14 mobile-side test coverage.

// Mock AsyncStorage with an in-memory implementation so each test gets
// a clean store. We import this mock first, then the module under test.
jest.mock('@react-native-async-storage/async-storage', () => {
  const store: Record<string, string> = {};
  return {
    getItem: jest.fn(async (key: string) => store[key] ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: jest.fn(async (key: string) => {
      delete store[key];
    }),
    __reset: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
  };
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  writeTransaction,
  getRecentTx,
  getTransactionByIdempotencyKey,
  clearCache,
  writeOutbox,
  readOutboxQueued,
  markOutbox,
  getOutboxPendingCount,
  getOutboxByIdempotencyKey,
  buildOutboxRow,
  backoffNextRetryAt,
} from '../cache';
import { TransactionRow, OutboxRow } from '../../types/transaction';

beforeEach(() => {
  (AsyncStorage as unknown as { __reset: () => void }).__reset();
});

// ----------------------------------------------------- transactions

function makeTx(overrides: Partial<TransactionRow> = {}): TransactionRow {
  return {
    id: 'lt_default',
    user_id: 1,
    type: 'in_network',
    direction: 'out',
    amount_kobo: 1000,
    counterparty: 'Iya Tope',
    status: 'completed',
    idempotency_key: 'k1',
    created_at: '2026-05-15T12:00:00Z',
    settled_at: '2026-05-15T12:00:00Z',
    ...overrides,
  };
}

test('writeTransaction stores and getRecentTx returns it', async () => {
  await writeTransaction(makeTx());
  const rows = await getRecentTx(1);
  expect(rows).toHaveLength(1);
  expect(rows[0].id).toBe('lt_default');
});

test('writeTransaction is INSERT OR IGNORE on idempotency_key', async () => {
  await writeTransaction(makeTx({ id: 'first', idempotency_key: 'same' }));
  await writeTransaction(makeTx({ id: 'second', idempotency_key: 'same' }));
  const rows = await getRecentTx(1);
  expect(rows).toHaveLength(1);
  expect(rows[0].id).toBe('first');
});

test('getRecentTx returns newest first', async () => {
  await writeTransaction(makeTx({ id: 'a', idempotency_key: 'a', created_at: '2026-05-15T11:00:00Z' }));
  await writeTransaction(makeTx({ id: 'b', idempotency_key: 'b', created_at: '2026-05-15T12:00:00Z' }));
  const rows = await getRecentTx(1);
  expect(rows.map((r) => r.id)).toEqual(['b', 'a']);
});

test('getRecentTx respects limit', async () => {
  for (let i = 0; i < 5; i++) {
    await writeTransaction(makeTx({ id: `tx_${i}`, idempotency_key: `k${i}` }));
  }
  const rows = await getRecentTx(1, 2);
  expect(rows).toHaveLength(2);
});

test('getRecentTx is per-user-isolated', async () => {
  await writeTransaction(makeTx({ user_id: 1, idempotency_key: 'a' }));
  await writeTransaction(makeTx({ user_id: 2, idempotency_key: 'b' }));
  expect(await getRecentTx(1)).toHaveLength(1);
  expect(await getRecentTx(2)).toHaveLength(1);
});

test('getTransactionByIdempotencyKey returns the row or null', async () => {
  await writeTransaction(makeTx({ idempotency_key: 'find-me' }));
  expect((await getTransactionByIdempotencyKey(1, 'find-me'))?.id).toBe('lt_default');
  expect(await getTransactionByIdempotencyKey(1, 'no-such-key')).toBeNull();
});

test('clearCache wipes both tx history and outbox', async () => {
  await writeTransaction(makeTx());
  await writeOutbox(
    buildOutboxRow({
      userId: 1,
      fromUserId: 1,
      toUserId: 2,
      amountKobo: 500,
      idempotencyKey: 'ob-1',
    }),
  );
  await clearCache(1);
  expect(await getRecentTx(1)).toHaveLength(0);
  expect(await getOutboxPendingCount(1)).toBe(0);
});

// ----------------------------------------------------- outbox

test('writeOutbox stores a row and readOutboxQueued returns it', async () => {
  const row = buildOutboxRow({
    userId: 1,
    fromUserId: 1,
    toUserId: 2,
    amountKobo: 500,
    idempotencyKey: 'ob-1',
  });
  await writeOutbox(row);
  const rows = await readOutboxQueued(1);
  expect(rows).toHaveLength(1);
  expect(rows[0].idempotency_key).toBe('ob-1');
});

test('writeOutbox is INSERT OR IGNORE on idempotency_key', async () => {
  const row1 = buildOutboxRow({
    userId: 1, fromUserId: 1, toUserId: 2, amountKobo: 100, idempotencyKey: 'dup',
  });
  const row2 = buildOutboxRow({
    userId: 1, fromUserId: 1, toUserId: 3, amountKobo: 999, idempotencyKey: 'dup',
  });
  await writeOutbox(row1);
  await writeOutbox(row2);
  const rows = await readOutboxQueued(1);
  expect(rows).toHaveLength(1);
  expect(rows[0].payload.amount_kobo).toBe(100);
});

test('readOutboxQueued filters by status', async () => {
  await writeOutbox(buildOutboxRow({ userId: 1, fromUserId: 1, toUserId: 2, amountKobo: 100, idempotencyKey: 'a' }));
  await writeOutbox(buildOutboxRow({ userId: 1, fromUserId: 1, toUserId: 2, amountKobo: 200, idempotencyKey: 'b' }));
  // mark one as acked
  const all = await readOutboxQueued(1, 10);
  await markOutbox(1, all[0].id, { status: 'acked' });

  const queued = await readOutboxQueued(1);
  expect(queued).toHaveLength(1);
  expect(queued[0].status).toBe('queued');
});

test('readOutboxQueued respects next_retry_at — future rows are skipped', async () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const row = buildOutboxRow({ userId: 1, fromUserId: 1, toUserId: 2, amountKobo: 100, idempotencyKey: 'k' });
  await writeOutbox(row);
  await markOutbox(1, row.id, { next_retry_at: future });
  const queued = await readOutboxQueued(1);
  expect(queued).toHaveLength(0);
});

test('readOutboxQueued returns oldest first', async () => {
  // buildOutboxRow uses Date.now() for created_at; insert with a slight gap.
  const r1 = buildOutboxRow({ userId: 1, fromUserId: 1, toUserId: 2, amountKobo: 100, idempotencyKey: 'k1' });
  await writeOutbox(r1);
  // Force r2's created_at to be strictly later than r1.
  const r2 = {
    ...buildOutboxRow({ userId: 1, fromUserId: 1, toUserId: 2, amountKobo: 200, idempotencyKey: 'k2' }),
    created_at: new Date(Date.now() + 1000).toISOString(),
  };
  await writeOutbox(r2);
  const queued = await readOutboxQueued(1);
  expect(queued.map((r) => r.idempotency_key)).toEqual(['k1', 'k2']);
});

test('markOutbox patches fields without touching others', async () => {
  const r = buildOutboxRow({ userId: 1, fromUserId: 1, toUserId: 2, amountKobo: 100, idempotencyKey: 'k' });
  await writeOutbox(r);
  await markOutbox(1, r.id, { status: 'sent', attempts: 3, last_error: 'boom' });
  const all = await readOutboxQueued(1, 10);
  // status='sent' → filtered out of queued
  expect(all).toHaveLength(0);
  const fromIdem = await getOutboxByIdempotencyKey(1, 'k');
  expect(fromIdem?.attempts).toBe(3);
  expect(fromIdem?.last_error).toBe('boom');
  expect(fromIdem?.idempotency_key).toBe('k');
});

test('getOutboxPendingCount counts queued + sent only', async () => {
  const r1 = buildOutboxRow({ userId: 1, fromUserId: 1, toUserId: 2, amountKobo: 100, idempotencyKey: 'q' });
  const r2 = buildOutboxRow({ userId: 1, fromUserId: 1, toUserId: 2, amountKobo: 200, idempotencyKey: 'a' });
  const r3 = buildOutboxRow({ userId: 1, fromUserId: 1, toUserId: 2, amountKobo: 300, idempotencyKey: 'r' });
  await writeOutbox(r1);
  await writeOutbox(r2);
  await writeOutbox(r3);
  await markOutbox(1, r2.id, { status: 'acked' });
  await markOutbox(1, r3.id, { status: 'rejected' });

  // r1 is queued → counted
  expect(await getOutboxPendingCount(1)).toBe(1);
});

test('backoffNextRetryAt scales exponentially but caps at 60s', () => {
  const at = (attempts: number) => new Date(backoffNextRetryAt(attempts)).getTime() - Date.now();
  expect(at(0)).toBeGreaterThanOrEqual(800);
  expect(at(0)).toBeLessThanOrEqual(1200);
  expect(at(1)).toBeGreaterThanOrEqual(1800);
  expect(at(1)).toBeLessThanOrEqual(2200);
  expect(at(5)).toBeGreaterThanOrEqual(31_500);
  expect(at(5)).toBeLessThanOrEqual(32_500);
  // attempt 10 → capped at 60s
  expect(at(10)).toBeLessThanOrEqual(60_500);
  expect(at(10)).toBeGreaterThanOrEqual(59_500);
});
