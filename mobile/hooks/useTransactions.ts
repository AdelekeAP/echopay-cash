// useTransactions — surfaces the cached tx history for the current user.
// Refreshable by callers (e.g. after a successful local transfer) so the
// home tab + transactions tab don't have to re-query the cache themselves.

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { getRecentTx } from '../services/cache';
import { TransactionRow } from '../types/transaction';

interface UseTransactionsReturn {
  transactions: TransactionRow[];
  isLoading: boolean;
  refresh: () => Promise<void>;
}

export function useTransactions(limit = 20): UseTransactionsReturn {
  const { user } = useAuth();
  const [transactions, setTransactions] = useState<TransactionRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!user) {
      setTransactions([]);
      return;
    }
    setIsLoading(true);
    try {
      const rows = await getRecentTx(user.id, limit);
      setTransactions(rows);
    } finally {
      setIsLoading(false);
    }
  }, [user, limit]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { transactions, isLoading, refresh };
}
