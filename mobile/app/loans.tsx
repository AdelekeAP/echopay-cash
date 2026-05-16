// Loans — request + view + repay.
//
// PRD §1 demo beat 3:45: Musa (the gig-worker persona seeded with
// 12 inbound payments from Mama/Iya Tope) requests a ₦20K
// working-capital loan, gets auto-approved + auto-disbursed instantly
// because his credit score is in the ≥700 band.
//
// Three states the screen handles:
//   idle        — form to request a loan
//   submitting  — request in flight
//   result      — show approved / manual_review / declined card
//
// Active loans section sits below the request form, showing
// outstanding loans with a Repay button per loan. Repayment opens an
// inline amount input (no modal — keeps the screen single-glance).
//
// Auth: every API call passes the Bearer token from AuthContext.
// 401 responses redirect to /voice-signup since the token is the
// only thing that ties the loan to a borrower.

import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Echopay } from '../constants/theme';
import { useAuth } from '../context/AuthContext';
import {
  BackendError,
  LoanRow,
  RequestLoanResponse,
  getMyLoans,
  repayLoan,
  requestLoan,
} from '../services/squad-api';
import { formatKoboToNaira, parseNairaToKobo } from '../utils/format';

type Stage = 'idle' | 'submitting' | 'result';

export default function LoansScreen() {
  const router = useRouter();
  const { token } = useAuth();

  const [stage, setStage] = useState<Stage>('idle');
  const [amountInput, setAmountInput] = useState('');
  const [result, setResult] = useState<RequestLoanResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loans, setLoans] = useState<LoanRow[]>([]);
  const [repayingId, setRepayingId] = useState<string | null>(null);
  const [repayAmountInput, setRepayAmountInput] = useState('');
  const [repaySubmitting, setRepaySubmitting] = useState(false);

  // Refresh loans on screen focus.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        try {
          const data = await getMyLoans(token);
          if (!cancelled) setLoans(data);
        } catch (e) {
          if (e instanceof BackendError && e.status === 401) {
            router.replace('/voice-signup?reason=session_expired');
            return;
          }
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [token, router]),
  );

  const handleSubmit = useCallback(async () => {
    setErrorMessage(null);
    let amountKobo: number;
    try {
      amountKobo = parseNairaToKobo(amountInput);
    } catch {
      setErrorMessage('Enter a valid amount.');
      return;
    }
    if (amountKobo < 1000) {
      setErrorMessage('Minimum loan amount is ₦10.');
      return;
    }
    if (amountKobo > 50_000_000) {
      setErrorMessage('Maximum loan amount is ₦500,000.');
      return;
    }
    setStage('submitting');
    try {
      const data = await requestLoan(amountKobo, token);
      setResult(data);
      setStage('result');
      // Refresh the active loans list — the new loan should appear.
      try {
        const updated = await getMyLoans(token);
        setLoans(updated);
      } catch {
        // Non-fatal — result card is already showing.
      }
    } catch (e) {
      if (e instanceof BackendError && e.status === 401) {
        router.replace('/voice-signup?reason=session_expired');
        return;
      }
      if (e instanceof BackendError && e.code === 'active_loan_exists') {
        setErrorMessage("You already have an active loan. Repay it before requesting another.");
      } else if (e instanceof BackendError) {
        setErrorMessage(e.message);
      } else {
        setErrorMessage('Something went wrong. Try again.');
      }
      setStage('idle');
    }
  }, [amountInput, token, router]);

  const handleRepay = useCallback(
    async (loanId: string) => {
      setErrorMessage(null);
      let amountKobo: number;
      try {
        amountKobo = parseNairaToKobo(repayAmountInput);
      } catch {
        setErrorMessage('Enter a valid amount.');
        return;
      }
      setRepaySubmitting(true);
      try {
        await repayLoan(loanId, amountKobo, token);
        setRepayingId(null);
        setRepayAmountInput('');
        const updated = await getMyLoans(token);
        setLoans(updated);
      } catch (e) {
        if (e instanceof BackendError && e.status === 401) {
          router.replace('/voice-signup?reason=session_expired');
          return;
        }
        if (e instanceof BackendError) {
          setErrorMessage(e.message);
        } else {
          setErrorMessage('Repayment failed. Try again.');
        }
      } finally {
        setRepaySubmitting(false);
      }
    },
    [repayAmountInput, token, router],
  );

  const handleReset = useCallback(() => {
    setStage('idle');
    setResult(null);
    setAmountInput('');
    setErrorMessage(null);
  }, []);

  const activeLoans = loans.filter(
    (l) => l.status === 'disbursed' || l.status === 'approved',
  );
  const otherLoans = loans.filter(
    (l) => l.status !== 'disbursed' && l.status !== 'approved',
  );
  const hasActive = activeLoans.length > 0;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.scroll}>
        <Pressable
          onPress={() => router.back()}
          style={styles.backRow}
          hitSlop={12}
        >
          <Text style={styles.backText}>← Back</Text>
        </Pressable>

        <Text style={styles.heading}>Working capital</Text>
        <Text style={styles.subheading}>
          Instant credit against your transaction history.
        </Text>

        {/* Request form (hidden when there's an active loan) */}
        {!hasActive && stage !== 'result' && (
          <View style={styles.card}>
            <Text style={styles.label}>Amount</Text>
            <View style={styles.amountRow}>
              <Text style={styles.naira}>₦</Text>
              <TextInput
                value={amountInput}
                onChangeText={setAmountInput}
                placeholder="20,000"
                placeholderTextColor={Echopay.textSubtle}
                keyboardType="number-pad"
                style={styles.amountInput}
              />
            </View>
            <Text style={styles.hint}>Between ₦10 and ₦500,000</Text>
            {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}
            <Pressable
              onPress={handleSubmit}
              disabled={stage === 'submitting' || !amountInput.trim()}
              style={({ pressed }) => [
                styles.primaryBtn,
                (stage === 'submitting' || !amountInput.trim()) && styles.btnDisabled,
                pressed && styles.btnPressed,
              ]}
            >
              {stage === 'submitting' ? (
                <ActivityIndicator color={Echopay.pageBg} />
              ) : (
                <Text style={styles.primaryBtnText}>Request loan</Text>
              )}
            </Pressable>
          </View>
        )}

        {/* Result card (post-submit) */}
        {stage === 'result' && result && (
          <ResultCard result={result} onDismiss={handleReset} />
        )}

        {/* Active loans */}
        {activeLoans.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Active loans</Text>
            {activeLoans.map((loan) => (
              <LoanCard
                key={loan.loan_id}
                loan={loan}
                isRepaying={repayingId === loan.loan_id}
                repayAmountInput={repayAmountInput}
                onRepayPress={() => {
                  setRepayingId(loan.loan_id);
                  setRepayAmountInput(
                    (loan.outstanding_kobo / 100).toString(),
                  );
                }}
                onRepayAmountChange={setRepayAmountInput}
                onRepaySubmit={() => handleRepay(loan.loan_id)}
                onRepayCancel={() => {
                  setRepayingId(null);
                  setRepayAmountInput('');
                }}
                submitting={repaySubmitting}
                errorMessage={
                  repayingId === loan.loan_id ? errorMessage : null
                }
              />
            ))}
          </View>
        )}

        {/* History */}
        {otherLoans.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>History</Text>
            {otherLoans.map((loan) => (
              <HistoryRow key={loan.loan_id} loan={loan} />
            ))}
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ----------------------------------------------------------------- subcomponents

function ResultCard({
  result,
  onDismiss,
}: {
  result: RequestLoanResponse;
  onDismiss: () => void;
}) {
  const isApproved = result.status === 'disbursed';
  const isReview = result.status === 'manual_review';
  return (
    <View
      style={[
        styles.card,
        isApproved && styles.cardSuccess,
        isReview && styles.cardReview,
        !isApproved && !isReview && styles.cardDanger,
      ]}
    >
      <View style={styles.resultHeader}>
        <Ionicons
          name={
            isApproved
              ? 'checkmark-circle'
              : isReview
                ? 'time-outline'
                : 'close-circle'
          }
          size={32}
          color={
            isApproved
              ? Echopay.success
              : isReview
                ? Echopay.accent
                : Echopay.danger
          }
        />
        <Text style={styles.resultTitle}>
          {isApproved
            ? `Approved — ${formatKoboToNaira(result.amount_kobo)} disbursed`
            : isReview
              ? 'Under review'
              : 'Declined'}
        </Text>
      </View>
      <View style={styles.scoreRow}>
        <Text style={styles.scoreLabel}>Credit score</Text>
        <Text style={styles.scoreValue}>{result.credit_score}</Text>
      </View>
      {result.decision_reason && (
        <Text style={styles.reason}>{_reasonLabel(result.decision_reason)}</Text>
      )}
      <Pressable
        onPress={onDismiss}
        style={({ pressed }) => [styles.secondaryBtn, pressed && styles.btnPressed]}
      >
        <Text style={styles.secondaryBtnText}>Done</Text>
      </Pressable>
    </View>
  );
}

function LoanCard({
  loan,
  isRepaying,
  repayAmountInput,
  onRepayPress,
  onRepayAmountChange,
  onRepaySubmit,
  onRepayCancel,
  submitting,
  errorMessage,
}: {
  loan: LoanRow;
  isRepaying: boolean;
  repayAmountInput: string;
  onRepayPress: () => void;
  onRepayAmountChange: (s: string) => void;
  onRepaySubmit: () => void;
  onRepayCancel: () => void;
  submitting: boolean;
  errorMessage: string | null;
}) {
  return (
    <View style={styles.loanCard}>
      <View style={styles.loanRow}>
        <Text style={styles.loanAmount}>
          {formatKoboToNaira(loan.outstanding_kobo)}
        </Text>
        <Text style={styles.loanLabel}>outstanding</Text>
      </View>
      <Text style={styles.loanMeta}>
        Originally {formatKoboToNaira(loan.amount_kobo)} • repaid{' '}
        {formatKoboToNaira(loan.repaid_kobo)}
      </Text>
      {!isRepaying ? (
        <Pressable
          onPress={onRepayPress}
          style={({ pressed }) => [styles.primaryBtn, pressed && styles.btnPressed]}
        >
          <Text style={styles.primaryBtnText}>Repay</Text>
        </Pressable>
      ) : (
        <View style={styles.repayBlock}>
          <View style={styles.amountRow}>
            <Text style={styles.naira}>₦</Text>
            <TextInput
              value={repayAmountInput}
              onChangeText={onRepayAmountChange}
              keyboardType="number-pad"
              style={styles.amountInput}
              placeholder="0"
              placeholderTextColor={Echopay.textSubtle}
            />
          </View>
          {errorMessage && <Text style={styles.error}>{errorMessage}</Text>}
          <View style={styles.repayBtnRow}>
            <Pressable
              onPress={onRepayCancel}
              style={styles.tertiaryBtn}
              disabled={submitting}
            >
              <Text style={styles.tertiaryBtnText}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={onRepaySubmit}
              disabled={submitting || !repayAmountInput.trim()}
              style={({ pressed }) => [
                styles.primaryBtn,
                styles.repaySubmitBtn,
                (submitting || !repayAmountInput.trim()) && styles.btnDisabled,
                pressed && styles.btnPressed,
              ]}
            >
              {submitting ? (
                <ActivityIndicator color={Echopay.pageBg} />
              ) : (
                <Text style={styles.primaryBtnText}>Confirm</Text>
              )}
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

function HistoryRow({ loan }: { loan: LoanRow }) {
  return (
    <View style={styles.historyRow}>
      <Text style={styles.historyAmount}>{formatKoboToNaira(loan.amount_kobo)}</Text>
      <Text style={styles.historyStatus}>{_statusLabel(loan.status)}</Text>
    </View>
  );
}

function _reasonLabel(reason: string): string {
  switch (reason) {
    case 'manual_review_required':
      return 'A team member will review and contact you shortly.';
    case 'credit_score_below_threshold':
      return 'Build more transaction history to qualify.';
    default:
      return reason;
  }
}

function _statusLabel(status: LoanRow['status']): string {
  switch (status) {
    case 'repaid':
      return 'Repaid';
    case 'declined':
      return 'Declined';
    case 'manual_review':
      return 'Under review';
    default:
      return status;
  }
}

// ----------------------------------------------------------------- styles

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Echopay.pageBg,
  },
  scroll: {
    padding: 24,
    paddingBottom: 60,
  },
  backRow: { marginTop: 8, marginBottom: 14 },
  backText: { fontSize: 15, color: Echopay.accent, fontWeight: '500' },

  heading: {
    fontSize: 26,
    fontWeight: '700',
    color: Echopay.text,
  },
  subheading: {
    fontSize: 14,
    color: Echopay.textMuted,
    marginTop: 4,
    marginBottom: 20,
  },

  card: {
    backgroundColor: Echopay.cardBg,
    borderWidth: 1,
    borderColor: Echopay.border,
    borderRadius: 16,
    padding: 18,
    marginBottom: 18,
  },
  cardSuccess: { borderColor: Echopay.success },
  cardReview: { borderColor: Echopay.accent },
  cardDanger: { borderColor: Echopay.danger },

  label: {
    fontSize: 13,
    color: Echopay.textMuted,
    fontWeight: '600',
    marginBottom: 6,
  },
  amountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Echopay.cardSoft,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 8,
  },
  naira: {
    fontSize: 20,
    color: Echopay.textMuted,
    fontWeight: '600',
  },
  amountInput: {
    flex: 1,
    fontSize: 22,
    fontWeight: '700',
    color: Echopay.text,
  },
  hint: {
    fontSize: 12,
    color: Echopay.textSubtle,
    marginTop: 8,
  },
  error: {
    fontSize: 13,
    color: Echopay.danger,
    marginTop: 8,
  },

  primaryBtn: {
    marginTop: 14,
    backgroundColor: Echopay.accent,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  primaryBtnText: {
    color: Echopay.pageBg,
    fontWeight: '700',
    fontSize: 16,
  },
  secondaryBtn: {
    marginTop: 12,
    backgroundColor: Echopay.cardBg,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Echopay.border,
  },
  secondaryBtnText: { color: Echopay.accent, fontWeight: '600' },
  tertiaryBtn: { paddingVertical: 8, paddingHorizontal: 16 },
  tertiaryBtnText: { color: Echopay.textMuted, fontSize: 14 },
  btnDisabled: { opacity: 0.4 },
  btnPressed: { opacity: 0.85 },

  resultHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 14,
  },
  resultTitle: {
    flex: 1,
    fontSize: 16,
    fontWeight: '700',
    color: Echopay.text,
  },
  scoreRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: Echopay.border,
  },
  scoreLabel: { fontSize: 13, color: Echopay.textMuted },
  scoreValue: { fontSize: 18, fontWeight: '700', color: Echopay.text },
  reason: {
    fontSize: 13,
    color: Echopay.textMuted,
    marginTop: 8,
  },

  section: { marginTop: 12 },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: Echopay.textMuted,
    marginBottom: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },

  loanCard: {
    backgroundColor: Echopay.cardBg,
    borderWidth: 1,
    borderColor: Echopay.border,
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
  },
  loanRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
  },
  loanAmount: {
    fontSize: 24,
    fontWeight: '800',
    color: Echopay.text,
  },
  loanLabel: {
    fontSize: 13,
    color: Echopay.textMuted,
  },
  loanMeta: {
    fontSize: 12,
    color: Echopay.textSubtle,
    marginTop: 4,
  },
  repayBlock: { marginTop: 12 },
  repayBtnRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 8,
    marginTop: 10,
  },
  repaySubmitBtn: { marginTop: 0, paddingHorizontal: 24 },

  historyRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: Echopay.border,
  },
  historyAmount: { fontSize: 14, color: Echopay.text, fontWeight: '600' },
  historyStatus: { fontSize: 13, color: Echopay.textMuted },
});
