// useLocalTransfer — state machine + handlers for the four-stage local
// transfer flow. PRD_FUNBI §13 (refactor) + §12 (route-param prefill).
//
// Pulls everything non-presentational out of app/local-transfer.tsx so:
//   1. The screen file is presentation-only per mobile/docs/ARCHITECTURE.md
//   2. The state machine is unit-testable (jest, post-PRD §14)
//   3. Route-param prefill (recipientId, amountKobo) becomes a hook
//      concern, not a screen concern — the screen just calls
//      useLocalTransfer({ prefilledRecipientId, prefilledAmountKobo })
//      and consumes the returned state.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useWallet } from './useWallet';
import { useNetworkStatus } from './useNetworkStatus';
import { Persona, getPersonaById } from '../constants/personas';
import {
  localTransfer,
  buildIdempotencyKey,
  suggestedRecipients,
  LocalTransferError,
  LocalTransferResult,
} from '../services/transfer';
import { parseNairaToKobo } from '../utils/format';

export type Stage =
  | 'pick-recipient'
  | 'enter-amount'
  | 'confirm-pin'
  | 'success';

export interface UseLocalTransferOpts {
  prefilledRecipientId?: string;
  prefilledAmountKobo?: number;
}

export interface UseLocalTransferReturn {
  // state
  stage: Stage;
  query: string;
  recipient: Persona | null;
  amountStr: string;
  amountKobo: number;
  pin: string;
  error: string | null;
  loading: boolean;
  result: LocalTransferResult | null;
  recipients: Persona[];

  // pot context (drives UI copy + the active gate)
  isOnline: boolean;
  activeBalanceKobo: number;
  activeBalanceNaira: string;
  activeBalanceLabel: 'balance' | 'offline budget';
  amountValid: boolean;

  // handlers
  setQuery: (q: string) => void;
  selectRecipient: (p: Persona) => void;
  setAmount: (s: string) => void;
  setPin: (p: string) => void;
  back: () => void;
  continueFromAmount: () => void;
  confirmAndSend: () => Promise<void>;
  reset: () => void;
}

export function useLocalTransfer(
  opts: UseLocalTransferOpts = {},
): UseLocalTransferReturn {
  const { user, account } = useAuth();
  const {
    balanceKobo,
    balanceNaira,
    lockedBalanceKobo,
    lockedBalanceNaira,
    applyDebit,
    applyLockedDebit,
  } = useWallet();
  const { isOnline } = useNetworkStatus();

  // -------- state -------------------------------------------------------

  const [stage, setStage] = useState<Stage>('pick-recipient');
  const [query, setQuery] = useState('');
  const [recipient, setRecipient] = useState<Persona | null>(null);
  const [amountStr, setAmountStr] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<LocalTransferResult | null>(null);

  // PRD_FUNBI §12 prefill — fire once on mount if route params are
  // present and resolve cleanly. recipientId resolves to a Persona;
  // amountKobo is parsed as a positive integer ≤ active pot.
  const prefilledRef = useRef(false);
  useEffect(() => {
    if (prefilledRef.current) return;
    prefilledRef.current = true;
    if (!user) return;

    const prefilledRecipient = opts.prefilledRecipientId
      ? getPersonaById(opts.prefilledRecipientId)
      : undefined;
    const prefilledAmount =
      opts.prefilledAmountKobo &&
      Number.isInteger(opts.prefilledAmountKobo) &&
      opts.prefilledAmountKobo > 0
        ? opts.prefilledAmountKobo
        : undefined;

    if (prefilledRecipient && prefilledRecipient.user.id !== user.id) {
      setRecipient(prefilledRecipient);

      if (prefilledAmount !== undefined) {
        // Skip both pick + amount stages straight to confirm.
        // Naira string so the screen's existing input displays it.
        setAmountStr((prefilledAmount / 100).toString());
        setStage('confirm-pin');
      } else {
        setStage('enter-amount');
      }
    } else if (opts.prefilledRecipientId) {
      // recipientId provided but unknown — leave the user on the picker
      // with their query pre-filled so they understand what failed.
      setQuery(opts.prefilledRecipientId);
    }
  }, [opts.prefilledRecipientId, opts.prefilledAmountKobo, user]);

  // -------- derived -----------------------------------------------------

  const activeBalanceKobo = isOnline ? balanceKobo : lockedBalanceKobo;
  const activeBalanceNaira = isOnline ? balanceNaira : lockedBalanceNaira;
  const activeBalanceLabel: 'balance' | 'offline budget' = isOnline
    ? 'balance'
    : 'offline budget';

  const amountKobo = useMemo(() => {
    try {
      const k = parseNairaToKobo(amountStr || '0');
      return k > 0 ? k : 0;
    } catch {
      return 0;
    }
  }, [amountStr]);

  const amountValid = amountKobo > 0 && amountKobo <= activeBalanceKobo;

  const recipients = useMemo(() => {
    if (!user) return [];
    const all = suggestedRecipients(user.id);
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (p) =>
        p.display_name.toLowerCase().includes(q) ||
        p.user.phone_number.replace(/\s/g, '').includes(q.replace(/\s/g, '')) ||
        p.user.username.toLowerCase().includes(q),
    );
  }, [query, user]);

  // -------- handlers ----------------------------------------------------

  const reset = useCallback(() => {
    setStage('pick-recipient');
    setRecipient(null);
    setAmountStr('');
    setPin('');
    setError(null);
    setResult(null);
  }, []);

  const selectRecipient = useCallback((p: Persona) => {
    setRecipient(p);
    setStage('enter-amount');
  }, []);

  const setAmount = useCallback((s: string) => {
    setAmountStr(s.replace(/[^0-9.]/g, ''));
  }, []);

  const continueFromAmount = useCallback(() => {
    if (amountValid) setStage('confirm-pin');
  }, [amountValid]);

  const back = useCallback(() => {
    if (stage === 'enter-amount') {
      setStage('pick-recipient');
    } else if (stage === 'confirm-pin') {
      setStage('enter-amount');
      setPin('');
      setError(null);
    }
  }, [stage]);

  const me: Persona | undefined = useMemo(
    () => (user ? getPersonaById(user.username ?? '') : undefined),
    [user],
  );

  const confirmAndSend = useCallback(async () => {
    if (!user || !account || !recipient) return;
    setError(null);

    if (pin.length < 4) {
      setError('Enter 4 digits.');
      return;
    }
    if (me && pin !== me.pin) {
      setError('Wrong PIN. Try again.');
      setPin('');
      return;
    }

    setLoading(true);
    try {
      const idempotencyKey = buildIdempotencyKey(
        user.id,
        recipient.id,
        amountKobo,
      );
      const res = await localTransfer({
        fromUser: user,
        fromAccount: account,
        toPersonaId: recipient.id,
        amountKobo,
        pin,
        idempotencyKey,
        balanceKobo,
        lockedBalanceKobo,
      });
      if (res.debitedFrom === 'locked') {
        await applyLockedDebit(amountKobo);
      } else {
        await applyDebit(amountKobo);
      }
      setResult(res);
      setStage('success');
    } catch (e) {
      if (e instanceof LocalTransferError) {
        setError(e.message);
      } else {
        setError('Transfer failed. Try again.');
      }
    } finally {
      setLoading(false);
    }
  }, [
    user,
    account,
    recipient,
    pin,
    me,
    amountKobo,
    balanceKobo,
    lockedBalanceKobo,
    applyDebit,
    applyLockedDebit,
  ]);

  return {
    stage,
    query,
    recipient,
    amountStr,
    amountKobo,
    pin,
    error,
    loading,
    result,
    recipients,

    isOnline,
    activeBalanceKobo,
    activeBalanceNaira,
    activeBalanceLabel,
    amountValid,

    setQuery,
    selectRecipient,
    setAmount,
    setPin,
    back,
    continueFromAmount,
    confirmAndSend,
    reset,
  };
}
