// useWallet — exposes the current user's balance in kobo plus
// optimistic apply functions. Wraps AuthContext.account.balance (stored
// as a naira string per types/index.ts Account) and persists via
// setSession so AsyncStorage stays in sync.
//
// The backend is authoritative on settled balance; this hook is the
// optimistic UI layer that updates immediately on a local transfer.

import { useCallback, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { formatKoboToNaira } from '../utils/format';

interface UseWalletReturn {
  balanceKobo: number;
  balanceNaira: string;
  vaNumber: string | null;
  applyDebit: (kobo: number) => Promise<void>;
  applyCredit: (kobo: number) => Promise<void>;
}

export function useWallet(): UseWalletReturn {
  const { user, account, token, setSession } = useAuth();

  const balanceKobo = useMemo(() => {
    if (!account?.balance) return 0;
    const n = parseFloat(account.balance);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * 100);
  }, [account?.balance]);

  const balanceNaira = useMemo(() => formatKoboToNaira(balanceKobo), [balanceKobo]);

  const setBalanceKobo = useCallback(
    async (nextKobo: number) => {
      if (!user || !account || !token) return;
      const safe = Math.max(0, nextKobo);
      const naira = (safe / 100).toFixed(2);
      await setSession(user, { ...account, balance: naira }, token);
    },
    [user, account, token, setSession],
  );

  const applyDebit = useCallback(
    async (kobo: number) => {
      if (kobo <= 0) return;
      await setBalanceKobo(balanceKobo - kobo);
    },
    [balanceKobo, setBalanceKobo],
  );

  const applyCredit = useCallback(
    async (kobo: number) => {
      if (kobo <= 0) return;
      await setBalanceKobo(balanceKobo + kobo);
    },
    [balanceKobo, setBalanceKobo],
  );

  return {
    balanceKobo,
    balanceNaira,
    vaNumber: account?.account_number ?? null,
    applyDebit,
    applyCredit,
  };
}
