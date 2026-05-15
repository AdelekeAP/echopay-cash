// useWallet — exposes both the online balance (balance_kobo) and the
// offline-spendable allocation (locked_kobo) from PRD_FUNBI §11. Wraps
// AuthContext.account.balance + account.locked_balance and persists
// via setSession so AsyncStorage stays in sync.
//
// applyDebit / applyCredit operate on the online pot. applyLockedDebit
// operates on the offline pot — used by services/transfer when the
// offline mock-fallback runs. lockForOffline / unlockFromOffline call
// the backend wallet endpoints and update both pots atomically.

import { useCallback, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { formatKoboToNaira } from '../utils/format';
import { API_BASE_URL } from '../constants/config';

interface UseWalletReturn {
  balanceKobo: number;
  balanceNaira: string;
  lockedBalanceKobo: number;
  lockedBalanceNaira: string;
  vaNumber: string | null;

  // Online pot mutations
  applyDebit: (kobo: number) => Promise<void>;
  applyCredit: (kobo: number) => Promise<void>;

  // Offline pot mutation (used by the offline mock-fallback path)
  applyLockedDebit: (kobo: number) => Promise<void>;

  // Server-backed lock / unlock (atomic move between the two pots)
  lockForOffline: (kobo: number) => Promise<WalletMoveResult>;
  unlockFromOffline: (kobo: number) => Promise<WalletMoveResult>;
}

export interface WalletMoveResult {
  balanceKobo: number;
  lockedKobo: number;
  movedKobo: number;
  movementTxId: string;
}

export function useWallet(): UseWalletReturn {
  const { user, account, token, setSession } = useAuth();

  const balanceKobo = useMemo(
    () => parseStringKobo(account?.balance),
    [account?.balance],
  );

  const lockedBalanceKobo = useMemo(
    () => parseStringKobo(account?.locked_balance),
    [account?.locked_balance],
  );

  const balanceNaira = useMemo(() => formatKoboToNaira(balanceKobo), [balanceKobo]);
  const lockedBalanceNaira = useMemo(
    () => formatKoboToNaira(lockedBalanceKobo),
    [lockedBalanceKobo],
  );

  // Atomic-ish persistence helper: writes both balances at once so a
  // partial update during a server round-trip can't leave the two pots
  // out of sync in AsyncStorage.
  const persistBoth = useCallback(
    async (nextBalanceKobo: number, nextLockedKobo: number) => {
      if (!user || !account || !token) return;
      const balance = (Math.max(0, nextBalanceKobo) / 100).toFixed(2);
      const locked = (Math.max(0, nextLockedKobo) / 100).toFixed(2);
      await setSession(
        user,
        { ...account, balance, locked_balance: locked },
        token,
      );
    },
    [user, account, token, setSession],
  );

  // ---------- online pot --------------------------------------------------

  const applyDebit = useCallback(
    async (kobo: number) => {
      if (kobo <= 0) return;
      await persistBoth(balanceKobo - kobo, lockedBalanceKobo);
    },
    [balanceKobo, lockedBalanceKobo, persistBoth],
  );

  const applyCredit = useCallback(
    async (kobo: number) => {
      if (kobo <= 0) return;
      await persistBoth(balanceKobo + kobo, lockedBalanceKobo);
    },
    [balanceKobo, lockedBalanceKobo, persistBoth],
  );

  // ---------- offline pot -------------------------------------------------

  const applyLockedDebit = useCallback(
    async (kobo: number) => {
      if (kobo <= 0) return;
      await persistBoth(balanceKobo, lockedBalanceKobo - kobo);
    },
    [balanceKobo, lockedBalanceKobo, persistBoth],
  );

  // ---------- server-backed move between pots -----------------------------

  const lockForOffline = useCallback(
    async (kobo: number): Promise<WalletMoveResult> => {
      if (!user) throw new Error('not_signed_in');
      const res = await postWalletMove('lock-for-offline', user.id, kobo, token);
      await persistBoth(res.balanceKobo, res.lockedKobo);
      return res;
    },
    [user, token, persistBoth],
  );

  const unlockFromOffline = useCallback(
    async (kobo: number): Promise<WalletMoveResult> => {
      if (!user) throw new Error('not_signed_in');
      const res = await postWalletMove('unlock-from-offline', user.id, kobo, token);
      await persistBoth(res.balanceKobo, res.lockedKobo);
      return res;
    },
    [user, token, persistBoth],
  );

  return {
    balanceKobo,
    balanceNaira,
    lockedBalanceKobo,
    lockedBalanceNaira,
    vaNumber: account?.account_number ?? null,
    applyDebit,
    applyCredit,
    applyLockedDebit,
    lockForOffline,
    unlockFromOffline,
  };
}

// ----------------------------------------------------------------- helpers

function parseStringKobo(input?: string | null): number {
  if (!input) return 0;
  const n = parseFloat(input);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

async function postWalletMove(
  path: 'lock-for-offline' | 'unlock-from-offline',
  userId: number,
  amountKobo: number,
  token: string | null,
): Promise<WalletMoveResult> {
  if (!Number.isInteger(amountKobo) || amountKobo <= 0) {
    throw new WalletMoveError('invalid_amount', 'Amount must be a positive integer in kobo.');
  }
  const idempotencyKey = `${path}:${userId}:${amountKobo}:${Math.floor(Date.now() / 60_000)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(`${API_BASE_URL}/wallet/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        user_id: userId,
        amount_kobo: amountKobo,
        idempotency_key: idempotencyKey,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      let code = 'backend_error';
      let message = `Request failed (${res.status}).`;
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
      throw new WalletMoveError(code, message);
    }
    const json = await res.json();
    const data = json?.data ?? json;
    return {
      balanceKobo: data.balance_kobo,
      lockedKobo: data.locked_kobo,
      movedKobo: data.moved_kobo,
      movementTxId: data.movement_tx_id,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export class WalletMoveError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'WalletMoveError';
  }
}
