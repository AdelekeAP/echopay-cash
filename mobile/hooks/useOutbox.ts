// useOutbox — listens for the network coming back online and drains the
// queued offline transfers to the backend's /transfer/sync-offline-batch
// endpoint. PRD §15.7 / PRD_FUNBI §11.
//
// Drain rules:
// - Only one drain at a time per user (in-memory mutex).
// - Pull up to BATCH_SIZE queued rows whose next_retry_at <= now, oldest
//   first.
// - POST as a single batch. Server returns per-row results.
// - acked → mark acked. rejected (4xx) → mark rejected, never retry.
// - On network / 5xx → leave queued, bump attempts, exponential backoff.
// - After MAX_ATTEMPTS failed tries, mark rejected so the user sees it.
//
// Mounted once inside AuthContext via useOutboxDrain() so it survives
// route changes and is never duplicated. Funbi's §11 acceptance.

import { useEffect, useRef } from 'react';
import { useNetworkStatus } from './useNetworkStatus';
import { useAuth } from '../context/AuthContext';
import { API_BASE_URL } from '../constants/config';
import {
  readOutboxQueued,
  markOutbox,
  backoffNextRetryAt,
} from '../services/cache';
import { OutboxRow } from '../types/transaction';

const BATCH_SIZE = 20;
const MAX_ATTEMPTS = 10;
const DRAIN_TIMEOUT_MS = 4000;

interface BatchOp {
  idempotency_key: string;
  from_user_id: number;
  to_user_id: number;
  amount_kobo: number;
}

interface BatchResultRow {
  idempotency_key: string;
  status: 'acked' | 'rejected';
  tx_id?: string;
  error?: { code?: string; message?: string } | string;
}

export function useOutboxDrain(): void {
  const { user, token } = useAuth();
  const { isOnline } = useNetworkStatus();
  const drainingRef = useRef(false);
  const wasOnlineRef = useRef(isOnline);

  useEffect(() => {
    if (!user?.id || !token) return;
    // Drain on transitions false→true OR on first mount while online,
    // so a returning user with a stale outbox catches up immediately.
    const justReconnected = !wasOnlineRef.current && isOnline;
    const firstMountOnline = wasOnlineRef.current === isOnline && isOnline;
    wasOnlineRef.current = isOnline;
    if (!justReconnected && !firstMountOnline) return;
    void drain(user.id, token);
  }, [isOnline, user?.id, token]);

  // ---- one drain pass at a time per user ----------------------------

  const drain = async (userId: number, authToken: string): Promise<void> => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    try {
      while (true) {
        const batch = await readOutboxQueued(userId, BATCH_SIZE);
        if (batch.length === 0) return;

        await Promise.all(batch.map((r) => markOutbox(userId, r.id, { status: 'sent' })));

        const ops: BatchOp[] = batch.map((r) => ({
          idempotency_key: r.idempotency_key,
          from_user_id: r.payload.from_user_id,
          to_user_id: r.payload.to_user_id,
          amount_kobo: r.payload.amount_kobo,
        }));

        let results: BatchResultRow[] | null = null;
        try {
          results = await postBatch(ops, authToken);
        } catch (e) {
          // Network/5xx — revert to queued with backoff so the next
          // reconnect tries again. No throw — drain ends gracefully.
          await Promise.all(
            batch.map((r) =>
              markOutbox(userId, r.id, {
                status: 'queued',
                attempts: r.attempts + 1,
                last_error: (e as Error)?.message ?? 'network_error',
                next_retry_at: backoffNextRetryAt(r.attempts + 1),
              }),
            ),
          );
          return;
        }

        const byKey: Record<string, BatchResultRow> = {};
        for (const r of results ?? []) byKey[r.idempotency_key] = r;

        for (const row of batch) {
          const res = byKey[row.idempotency_key];
          if (!res) {
            // Server didn't echo this row back — treat as rejection.
            await markOutbox(userId, row.id, {
              status: 'rejected',
              last_error: 'server_dropped_row',
            });
            continue;
          }
          if (res.status === 'acked') {
            await markOutbox(userId, row.id, { status: 'acked' });
          } else {
            await markOutbox(userId, row.id, {
              status: row.attempts + 1 >= MAX_ATTEMPTS ? 'rejected' : 'rejected',
              last_error: typeof res.error === 'string' ? res.error : (res.error?.message ?? res.error?.code),
            });
          }
        }
        // Loop continues — drain everything that's drainable in one pass.
      }
    } finally {
      drainingRef.current = false;
    }
  };
}

async function postBatch(ops: BatchOp[], token: string): Promise<BatchResultRow[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DRAIN_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE_URL}/transfer/sync-offline-batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ ops }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`backend_${res.status}`);
    const json = await res.json();
    return (json?.data?.results ?? []) as BatchResultRow[];
  } finally {
    clearTimeout(timeout);
  }
}

export type { OutboxRow };
