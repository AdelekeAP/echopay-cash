// Local (in-network) transfer service. PRD §4 calls this an
// "In-network transfer (both users online, no Squad call)" — atomic ledger
// move between two EchoPay-Cash wallets. No Squad API hit; the Master VA
// at Squad doesn't move because the money was already pooled there.
//
// localTransfer() tries the real backend at $EXPO_PUBLIC_API_BASE_URL
// first. If the call times out, the network is unreachable, or the
// service is down, we fall back to the in-process mock and still write
// the tx to the local AsyncStorage cache so the UX never breaks during
// the demo. This mirrors the offline-first contract from PRD §15.

import { Account, User } from '../types';
import { TransactionRow } from '../types/transaction';
import { PERSONAS, getPersonaById } from '../constants/personas';
import {
  writeTransaction,
  getTransactionByIdempotencyKey,
  writeOutbox,
  buildOutboxRow,
} from './cache';
import { API_BASE_URL } from '../constants/config';

export interface LocalTransferRequest {
  fromUser: User;
  fromAccount: Account;
  toPersonaId: string;         // matches Persona.id from constants/personas.ts
  amountKobo: number;          // PRD §5 — always integer kobo
  pin: string;                 // verified locally against the picked persona's PIN
  idempotencyKey: string;      // sha256(fromUserId + toPersonaId + amountKobo + minute-bucket)
  // PRD_FUNBI §11 — the two pots the caller is offering. Online path
  // gates against balanceKobo, offline fallback gates against
  // lockedBalanceKobo. Caller passes both so the service can pick the
  // right pot based on connectivity without an extra round-trip.
  balanceKobo: number;
  lockedBalanceKobo: number;
}

export type DebitedFrom = 'balance' | 'locked';

export interface LocalTransferResult {
  txId: string;
  status: 'completed';
  settledAt: string;           // ISO 8601
  durationMs: number;
  balanceAfterKobo: number;
  recipientName: string;
  // Which pot the caller should optimistically debit on the UI side.
  // 'balance' for online success (server already debited balance_kobo).
  // 'locked' for offline mock fallback (outbox will replay with
  // from_locked=true so the server eventually debits locked_kobo).
  debitedFrom: DebitedFrom;
}

export class LocalTransferError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'LocalTransferError';
  }
}

// Mint a stable idempotency key for a (sender, recipient, amount) within a
// one-minute window. Duplicates within the window collapse to one row —
// same semantics the backend will enforce via UNIQUE on transactions.
export function buildIdempotencyKey(
  fromUserId: number,
  toPersonaId: string,
  amountKobo: number,
): string {
  const minute = Math.floor(Date.now() / 60_000);
  return `local:${fromUserId}:${toPersonaId}:${amountKobo}:${minute}`;
}

export async function localTransfer(req: LocalTransferRequest): Promise<LocalTransferResult> {
  const started = Date.now();

  // -------------------- 1. Validate input

  if (req.amountKobo <= 0 || !Number.isInteger(req.amountKobo)) {
    throw new LocalTransferError('invalid_amount', 'Amount must be a positive integer (in kobo).');
  }
  const toPersona = getPersonaById(req.toPersonaId);
  if (!toPersona) {
    throw new LocalTransferError('recipient_not_found', 'Recipient not found.');
  }
  if (toPersona.user.id === req.fromUser.id) {
    throw new LocalTransferError('self_transfer', 'You cannot send to yourself.');
  }

  // -------------------- 2. Idempotency — re-issuing the same request
  //                                       returns the existing row.

  const existing = await getTransactionByIdempotencyKey(req.fromUser.id, req.idempotencyKey);
  if (existing && existing.status === 'completed') {
    return {
      txId: existing.id,
      status: 'completed',
      settledAt: existing.settled_at ?? existing.created_at,
      durationMs: Date.now() - started,
      balanceAfterKobo: Math.max(0, req.balanceKobo - req.amountKobo),
      recipientName: existing.counterparty,
      debitedFrom: 'balance',
    };
  }

  // -------------------- 3. Try the real backend; fall back to mock + offline pot
  //
  // Online path: backend debits sender.balance_kobo. Gate against
  // req.balanceKobo locally for the snappy "insufficient balance" UX,
  // but the authoritative check is server-side.
  //
  // Offline fallback: outbox replay will debit sender.locked_kobo with
  // from_locked=true. Gate against req.lockedBalanceKobo locally — the
  // mock has no server to fall back to for this check.

  let txId: string;
  let debitedFrom: DebitedFrom = 'balance';
  let backendBalanceKobo: number | null = null;

  try {
    if (req.balanceKobo < req.amountKobo) {
      // Skip the network call when we know it'll be rejected.
      throw new LocalTransferError(
        'insufficient_balance',
        'Insufficient online balance.',
      );
    }
    const serverResult = await postInNetwork({
      from_user_id: req.fromUser.id,
      to_user_id: toPersona.user.id,
      amount_kobo: req.amountKobo,
      idempotency_key: req.idempotencyKey,
    });
    txId = serverResult.tx_id;
    backendBalanceKobo = serverResult.balance_after_kobo;
    debitedFrom = 'balance';
  } catch (e) {
    if (e instanceof LocalTransferError) {
      throw e;
    }
    if (e instanceof BackendBusinessError) {
      // Backend returned a structured 4xx — surface it to the user.
      throw new LocalTransferError(e.code, e.message);
    }
    // Network down / backend not running → switch to the offline pot.
    if (req.lockedBalanceKobo < req.amountKobo) {
      throw new LocalTransferError(
        'insufficient_offline_budget',
        "That's more than your offline budget. Connect to add more.",
      );
    }
    await new Promise((r) => setTimeout(r, 350 + Math.random() * 200));
    txId = `lt_${cryptoIdSafe()}`;
    debitedFrom = 'locked';
    try {
      await writeOutbox(
        buildOutboxRow({
          userId: req.fromUser.id,
          fromUserId: req.fromUser.id,
          toUserId: toPersona.user.id,
          amountKobo: req.amountKobo,
          idempotencyKey: req.idempotencyKey,
        }),
      );
    } catch (outboxErr) {
      console.warn('[transfer] outbox enqueue failed:', outboxErr);
    }
  }

  const now = new Date().toISOString();
  const balanceAfterKobo =
    backendBalanceKobo ??
    (debitedFrom === 'balance'
      ? req.balanceKobo - req.amountKobo
      : req.balanceKobo);

  // -------------------- 5. Persist sender's debit row to the cache.
  // (The receiver's credit row is the backend's responsibility once real;
  // for the demo on one device we only track the sender's history.)

  const row: TransactionRow = {
    id: txId,
    user_id: req.fromUser.id,
    type: 'in_network',
    direction: 'out',
    amount_kobo: req.amountKobo,
    counterparty: toPersona.display_name,
    counterparty_user_id: toPersona.user.id,
    status: 'completed',
    idempotency_key: req.idempotencyKey,
    created_at: now,
    settled_at: now,
  };
  await writeTransaction(row);

  return {
    txId,
    status: 'completed',
    settledAt: now,
    durationMs: Date.now() - started,
    balanceAfterKobo,
    recipientName: toPersona.display_name,
    debitedFrom,
  };
}

// Returns the subset of personas eligible to receive money from this user.
// Excludes the sender themself. Future: rank by recent counterparties.
export function suggestedRecipients(fromUserId: number) {
  return PERSONAS.filter((p) => p.user.id !== fromUserId);
}

// --------------------------------------------------------------- backend wire

class BackendBusinessError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'BackendBusinessError';
  }
}

interface InNetworkServerRequest {
  from_user_id: number;
  to_user_id: number;
  amount_kobo: number;
  idempotency_key: string;
}

interface InNetworkServerResponse {
  tx_id: string;
  status: string;
  settled_at: number;
  balance_after_kobo: number;
}

async function postInNetwork(body: InNetworkServerRequest): Promise<InNetworkServerResponse> {
  // Short timeout — if the backend isn't reachable on the demo Wi-Fi we
  // fall back to the local mock instead of stalling the UI.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch(`${API_BASE_URL}/transfer/in-network`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (res.status >= 200 && res.status < 300) {
      const json = await res.json();
      return json?.data ?? json;
    }

    // Structured business error from the backend
    if (res.status >= 400 && res.status < 500) {
      let code = 'backend_error';
      let message = `Transfer rejected (${res.status}).`;
      try {
        const json = await res.json();
        const detail = json?.detail;
        if (detail && typeof detail === 'object') {
          code = detail.code ?? code;
          message = detail.message ?? message;
        }
      } catch {
        /* swallow */
      }
      throw new BackendBusinessError(code, message);
    }

    // 5xx — let the caller fall through to mock
    throw new Error(`Backend ${res.status}`);
  } finally {
    clearTimeout(timeout);
  }
}

// Pull a short uuid-ish string without depending on crypto.randomUUID()
// being present in every JS runtime (web worker, hermes, etc.).
function cryptoIdSafe(): string {
  const g = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (g?.randomUUID) return g.randomUUID().replace(/-/g, '').slice(0, 16);
  return (
    Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10)
  );
}
