// Unit tests for services/transfer.ts — verifies the online/offline
// branch logic, dual-balance gating, and outbox enqueue on fallback.
// PRD_FUNBI §14 mobile-side coverage.

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
  localTransfer,
  buildIdempotencyKey,
  suggestedRecipients,
  LocalTransferError,
} from '../transfer';
import { readOutboxQueued, getRecentTx } from '../cache';
import { User, Account } from '../../types';
import { PERSONAS } from '../../constants/personas';

const fetchMock = jest.fn();
beforeAll(() => {
  (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
});
beforeEach(() => {
  (AsyncStorage as unknown as { __reset: () => void }).__reset();
  fetchMock.mockReset();
});

const mama = PERSONAS[0];
const iyaTope = PERSONAS[1];
const me: User = mama.user;
const myAccount: Account = mama.account;

function req(overrides: Partial<Parameters<typeof localTransfer>[0]> = {}) {
  return {
    fromUser: me,
    fromAccount: myAccount,
    toPersonaId: iyaTope.id,
    amountKobo: 500_00,
    pin: '1234',
    idempotencyKey: buildIdempotencyKey(me.id, iyaTope.id, 500_00) + '_t' + Date.now(),
    balanceKobo: 400_000_00,
    lockedBalanceKobo: 50_000_00,
    ...overrides,
  };
}

// -------------------------------------------- online: backend acks

test('online path: backend success debits balance, no outbox row', async () => {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      data: { tx_id: 'lt_srv_1', status: 'completed', settled_at: 1, balance_after_kobo: 399_500_00, debited_from: 'balance' },
    }),
  });
  const res = await localTransfer(req());
  expect(res.debitedFrom).toBe('balance');
  expect(res.txId).toBe('lt_srv_1');
  expect(await readOutboxQueued(me.id)).toHaveLength(0);
  // Tx history populated
  const history = await getRecentTx(me.id);
  expect(history).toHaveLength(1);
});

// -------------------------------------------- online: insufficient balance (local gate)

test('online: insufficient balance → throws insufficient_balance before network', async () => {
  await expect(
    localTransfer(req({ amountKobo: 999_000_00, balanceKobo: 100_00 })),
  ).rejects.toMatchObject({
    name: 'LocalTransferError',
    code: 'insufficient_balance',
  });
  expect(fetchMock).not.toHaveBeenCalled();
});

// -------------------------------------------- online: backend returns structured business error

test('backend 4xx → throws LocalTransferError surfacing server code', async () => {
  fetchMock.mockResolvedValueOnce({
    ok: false,
    status: 400,
    json: async () => ({
      detail: { code: 'insufficient_balance', message: 'too poor' },
    }),
  });
  await expect(localTransfer(req())).rejects.toMatchObject({
    name: 'LocalTransferError',
    code: 'insufficient_balance',
    message: 'too poor',
  });
  expect(await readOutboxQueued(me.id)).toHaveLength(0);
});

// -------------------------------------------- offline: network error → fall to mock + outbox

test('offline (network error): falls to mock, enqueues outbox with from_locked-bound payload', async () => {
  fetchMock.mockRejectedValueOnce(new Error('Network request failed'));
  const r = req({ amountKobo: 200_00 });
  const res = await localTransfer(r);
  expect(res.debitedFrom).toBe('locked');
  expect(res.txId).toMatch(/^lt_/);
  const queue = await readOutboxQueued(me.id);
  expect(queue).toHaveLength(1);
  expect(queue[0].payload).toEqual({
    from_user_id: me.id,
    to_user_id: iyaTope.user.id,
    amount_kobo: 200_00,
  });
  expect(queue[0].idempotency_key).toBe(r.idempotencyKey);
});

// -------------------------------------------- offline: insufficient locked → no mock, no outbox

test('offline + insufficient locked budget → rejects, no outbox row', async () => {
  fetchMock.mockRejectedValueOnce(new Error('Network down'));
  await expect(
    localTransfer(req({ amountKobo: 60_000_00, lockedBalanceKobo: 1_000_00 })),
  ).rejects.toMatchObject({
    name: 'LocalTransferError',
    code: 'insufficient_offline_budget',
  });
  expect(await readOutboxQueued(me.id)).toHaveLength(0);
});

// -------------------------------------------- idempotent re-issue returns existing row

test('re-issuing same idempotency_key returns the cached row, no fetch', async () => {
  // First call: online success, writes tx row.
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      data: { tx_id: 'lt_one', status: 'completed', settled_at: 1, balance_after_kobo: 0, debited_from: 'balance' },
    }),
  });
  const r1 = req();
  await localTransfer(r1);
  fetchMock.mockReset();

  // Second call: same idempotency key.
  const res = await localTransfer(r1);
  expect(res.txId).toBe('lt_one');
  expect(fetchMock).not.toHaveBeenCalled();
});

// -------------------------------------------- validation: self-transfer rejected

test('self-transfer rejected before any I/O', async () => {
  await expect(
    localTransfer(req({ toPersonaId: mama.id })),
  ).rejects.toMatchObject({ code: 'self_transfer' });
  expect(fetchMock).not.toHaveBeenCalled();
});

// -------------------------------------------- validation: invalid amount rejected

test('non-positive amount rejected', async () => {
  await expect(localTransfer(req({ amountKobo: 0 }))).rejects.toMatchObject({
    code: 'invalid_amount',
  });
  await expect(localTransfer(req({ amountKobo: -100 }))).rejects.toMatchObject({
    code: 'invalid_amount',
  });
});

// -------------------------------------------- validation: unknown recipient

test('unknown recipient persona id rejected', async () => {
  await expect(
    localTransfer(req({ toPersonaId: 'no_such_persona' })),
  ).rejects.toMatchObject({ code: 'recipient_not_found' });
});

// -------------------------------------------- suggestedRecipients excludes self

test('suggestedRecipients excludes the sender', () => {
  const out = suggestedRecipients(me.id);
  expect(out.find((p) => p.user.id === me.id)).toBeUndefined();
  expect(out.find((p) => p.user.id === iyaTope.user.id)).toBeDefined();
});

// -------------------------------------------- idempotency key minute-bucketing

test('buildIdempotencyKey produces same key for identical inputs within a minute', () => {
  const a = buildIdempotencyKey(1, 'iya_tope', 500_00);
  const b = buildIdempotencyKey(1, 'iya_tope', 500_00);
  expect(a).toBe(b);
});

test('buildIdempotencyKey is sender/recipient/amount-scoped', () => {
  const a = buildIdempotencyKey(1, 'iya_tope', 500_00);
  const b = buildIdempotencyKey(1, 'iya_tope', 600_00);
  const c = buildIdempotencyKey(2, 'iya_tope', 500_00);
  expect(a).not.toBe(b);
  expect(a).not.toBe(c);
});
