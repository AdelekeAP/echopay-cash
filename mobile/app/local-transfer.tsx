// Local Transfer screen — the four-stage in-network payment flow
// described in EchoPay_Cash_PRD.md §4 and docs/PRD_FUNBI.md §4.5.
//
// pick-recipient → enter-amount → confirm-pin → success
//
// All amounts in kobo. Sender's PIN is verified locally against the
// persona's `pin` field (hackathon scope — real Argon2id check in
// expo-secure-store is post-T2). On success the screen calls
// services/transfer.localTransfer() which writes to the cache and the
// home tab balance updates via the useWallet hook.

import { useMemo, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../context/AuthContext';
import { useWallet } from '../hooks/useWallet';
import { useNetworkStatus } from '../hooks/useNetworkStatus';
import { Echopay } from '../constants/theme';
import { PERSONAS, Persona, getPersonaById } from '../constants/personas';
import {
  localTransfer,
  buildIdempotencyKey,
  suggestedRecipients,
  LocalTransferError,
  LocalTransferResult,
} from '../services/transfer';
import { formatKoboToNaira, parseNairaToKobo } from '../utils/format';

type Stage = 'pick-recipient' | 'enter-amount' | 'confirm-pin' | 'success';

export default function LocalTransferScreen() {
  const router = useRouter();
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
  // When offline, the user can only spend from their pre-allocated
  // offline budget. When online, from their main balance. The screen
  // gates against whichever pot is "active" for this connectivity state.
  const activeBalanceKobo = isOnline ? balanceKobo : lockedBalanceKobo;
  const activeBalanceLabel = isOnline ? 'balance' : 'offline budget';
  const activeBalanceNaira = isOnline ? balanceNaira : lockedBalanceNaira;

  const [stage, setStage] = useState<Stage>('pick-recipient');
  const [query, setQuery] = useState('');
  const [recipient, setRecipient] = useState<Persona | null>(null);
  const [amountStr, setAmountStr] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<LocalTransferResult | null>(null);

  // Currently-signed-in persona — used for local PIN check (hackathon).
  // Real Argon2id-in-secure-store check happens post-T2.
  const me: Persona | undefined = useMemo(
    () => (user ? getPersonaById(asPersonaId(user.username ?? '')) : undefined),
    [user],
  );

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

  const amountKobo = useMemo(() => {
    try {
      const k = parseNairaToKobo(amountStr || '0');
      return k > 0 ? k : 0;
    } catch {
      return 0;
    }
  }, [amountStr]);

  const amountValid =
    amountKobo > 0 && amountKobo <= activeBalanceKobo;

  // -------------------------------------------------- handlers

  const reset = () => {
    setStage('pick-recipient');
    setRecipient(null);
    setAmountStr('');
    setPin('');
    setError(null);
    setResult(null);
  };

  const onConfirm = async () => {
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
  };

  // -------------------------------------------------- success screen

  if (stage === 'success' && result) {
    return (
      <View style={styles.successScreen}>
        <View style={styles.successInner}>
          <View style={styles.successCheck}>
            <Text style={styles.successCheckMark}>✓</Text>
          </View>
          <Text style={styles.successHeadline}>
            Sent {formatKoboToNaira(amountKobo)}
          </Text>
          <Text style={styles.successSub}>to {result.recipientName}</Text>

          <View style={styles.successCard}>
            <View style={styles.successRow}>
              <Text style={styles.successLabel}>Settled in</Text>
              <Text style={styles.successValue}>{result.durationMs} ms</Text>
            </View>
            <View style={styles.successRow}>
              <Text style={styles.successLabel}>Reference</Text>
              <Text style={styles.successValueMono}>{result.txId}</Text>
            </View>
            <View style={styles.successRow}>
              <Text style={styles.successLabel}>New balance</Text>
              <Text style={styles.successValue}>
                {formatKoboToNaira(result.balanceAfterKobo)}
              </Text>
            </View>
          </View>

          <Pressable
            onPress={() => router.replace('/(tabs)')}
            style={({ pressed }) => [
              styles.primaryButton,
              pressed && styles.primaryButtonPressed,
            ]}
          >
            <Text style={styles.primaryButtonText}>Done</Text>
          </Pressable>

          <Pressable onPress={reset} style={styles.linkRow} hitSlop={8}>
            <Text style={styles.linkText}>Send another →</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // -------------------------------------------------- main shell

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.container}
    >
      <ScrollView contentContainerStyle={styles.scrollContent}>
        {/* Header */}
        <View style={styles.header}>
          <Pressable
            onPress={() => {
              if (stage === 'pick-recipient') {
                router.back();
              } else if (stage === 'enter-amount') {
                setStage('pick-recipient');
              } else if (stage === 'confirm-pin') {
                setStage('enter-amount');
                setPin('');
                setError(null);
              }
            }}
            hitSlop={12}
            style={styles.backRow}
          >
            <Text style={styles.backText}>← Back</Text>
          </Pressable>
          <Text style={styles.eyebrow}>LOCAL TRANSFER</Text>
          <Text style={styles.title}>
            {stage === 'pick-recipient' && 'Who are you paying?'}
            {stage === 'enter-amount' && 'How much?'}
            {stage === 'confirm-pin' && 'Confirm with your PIN'}
          </Text>
          {stage === 'pick-recipient' && (
            <Text style={styles.subtitle}>
              Send instantly to another EchoPay Cash user. No fees.
            </Text>
          )}
        </View>

        {/* Stage: pick-recipient */}
        {stage === 'pick-recipient' && (
          <>
            <View style={styles.searchWrap}>
              <Ionicons
                name="search-outline"
                size={18}
                color={Echopay.textSubtle}
                style={styles.searchIcon}
              />
              <TextInput
                style={styles.searchInput}
                value={query}
                onChangeText={setQuery}
                placeholder="Phone or username"
                placeholderTextColor={Echopay.textSubtle}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>

            <Text style={styles.sectionLabel}>Suggested</Text>

            <View style={styles.recipientList}>
              {recipients.length === 0 ? (
                <View style={styles.emptyState}>
                  <Text style={styles.emptyTitle}>No matches</Text>
                  <Text style={styles.emptySub}>
                    Try a different name or username.
                  </Text>
                </View>
              ) : (
                recipients.map((p) => (
                  <Pressable
                    key={p.id}
                    onPress={() => {
                      setRecipient(p);
                      setStage('enter-amount');
                    }}
                    style={({ pressed }) => [
                      styles.recipientCard,
                      pressed && styles.recipientCardPressed,
                    ]}
                  >
                    <View style={styles.avatar}>
                      <Text style={styles.avatarText}>{p.initials}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.recipientName}>{p.display_name}</Text>
                      <Text style={styles.recipientMeta}>{p.role}</Text>
                    </View>
                    <Ionicons
                      name="chevron-forward"
                      size={18}
                      color={Echopay.textSubtle}
                    />
                  </Pressable>
                ))
              )}
            </View>
          </>
        )}

        {/* Stage: enter-amount */}
        {stage === 'enter-amount' && recipient && (
          <>
            <View style={styles.toCard}>
              <View style={styles.avatarSmall}>
                <Text style={styles.avatarText}>{recipient.initials}</Text>
              </View>
              <View>
                <Text style={styles.toLabel}>To</Text>
                <Text style={styles.toName}>{recipient.display_name}</Text>
                <Text style={styles.toMeta}>{recipient.role}</Text>
              </View>
            </View>

            <View style={styles.amountWrap}>
              <Text style={styles.nairaSymbol}>₦</Text>
              <TextInput
                style={styles.amountInput}
                value={amountStr}
                onChangeText={(t) => setAmountStr(t.replace(/[^0-9.]/g, ''))}
                placeholder="0"
                placeholderTextColor={Echopay.textSubtle}
                keyboardType="decimal-pad"
                autoFocus
              />
            </View>

            <Text style={styles.balanceHint}>
              From your {activeBalanceLabel}{' '}
              <Text style={styles.balanceHintBold}>{activeBalanceNaira}</Text>
            </Text>

            <View style={styles.instantBadge}>
              <Ionicons name="flash" size={14} color={Echopay.accent} />
              <Text style={styles.instantBadgeText}>
                {isOnline ? 'Instant · No fees' : 'Offline · Will sync when connected'}
              </Text>
            </View>

            {amountKobo > activeBalanceKobo && (
              <Text style={styles.errorText}>
                {isOnline
                  ? "That's more than your balance."
                  : "That's more than your offline budget. Connect to add more."}
              </Text>
            )}

            <Pressable
              onPress={() => {
                if (amountValid) setStage('confirm-pin');
              }}
              disabled={!amountValid}
              style={({ pressed }) => [
                styles.primaryButton,
                !amountValid && styles.primaryButtonDisabled,
                pressed && amountValid && styles.primaryButtonPressed,
              ]}
            >
              <Text style={styles.primaryButtonText}>Continue</Text>
            </Pressable>
          </>
        )}

        {/* Stage: confirm-pin */}
        {stage === 'confirm-pin' && recipient && (
          <>
            <View style={styles.readback}>
              <Text style={styles.readbackAmount}>
                {formatKoboToNaira(amountKobo)}
              </Text>
              <Text style={styles.readbackTo}>to {recipient.display_name}</Text>
              <Text style={styles.readbackMeta}>
                EchoPay Cash · Instant · No fees
              </Text>
            </View>

            <Text style={styles.fieldLabel}>Your PIN</Text>
            <TextInput
              style={styles.pinInput}
              value={pin}
              onChangeText={(t) => {
                setPin(t.replace(/\D/g, '').slice(0, 4));
                if (error) setError(null);
              }}
              keyboardType="number-pad"
              secureTextEntry
              maxLength={4}
              placeholder="••••"
              placeholderTextColor={Echopay.textSubtle}
              autoFocus
            />

            {error && <Text style={styles.errorText}>{error}</Text>}

            <Pressable
              onPress={onConfirm}
              disabled={loading || pin.length < 4}
              style={({ pressed }) => [
                styles.primaryButton,
                (loading || pin.length < 4) && styles.primaryButtonDisabled,
                pressed && !loading && pin.length === 4 && styles.primaryButtonPressed,
              ]}
            >
              {loading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.primaryButtonText}>
                  Send {formatKoboToNaira(amountKobo)}
                </Text>
              )}
            </Pressable>

            <Text style={styles.hintText}>
              Demo PIN: <Text style={styles.hintBold}>1234</Text>
            </Text>
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// Map AuthContext.user.username back to a Persona id used in constants/personas.ts.
function asPersonaId(username: string): string {
  return username.toLowerCase();
}

// ----------------------------------------------------- styles

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Echopay.pageBg },
  scrollContent: { flexGrow: 1, padding: 24, paddingBottom: 60 },

  header: { marginBottom: 22 },
  backRow: { marginTop: 8, marginBottom: 12 },
  backText: { fontSize: 15, color: Echopay.accent, fontWeight: '500' },
  eyebrow: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.4,
    color: Echopay.accent,
    marginBottom: 8,
  },
  title: {
    fontSize: 26,
    fontWeight: '700',
    color: Echopay.text,
    letterSpacing: -0.4,
  },
  subtitle: {
    fontSize: 14,
    color: Echopay.textMuted,
    marginTop: 6,
    lineHeight: 20,
  },

  // search
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Echopay.cardBg,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Echopay.border,
    paddingHorizontal: 14,
    marginBottom: 18,
  },
  searchIcon: { marginRight: 8 },
  searchInput: {
    flex: 1,
    paddingVertical: 14,
    fontSize: 15,
    color: Echopay.text,
  },

  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
    color: Echopay.textMuted,
    marginBottom: 10,
  },

  // recipient list
  recipientList: { gap: 10 },
  recipientCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderRadius: 16,
    backgroundColor: Echopay.cardBg,
    borderWidth: 1,
    borderColor: Echopay.border,
    gap: 14,
  },
  recipientCardPressed: {
    backgroundColor: Echopay.cardSoft,
    transform: [{ scale: 0.99 }],
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Echopay.cardSoft,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Echopay.border,
  },
  avatarSmall: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Echopay.cardSoft,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Echopay.border,
  },
  avatarText: {
    color: Echopay.text,
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  recipientName: { fontSize: 15, fontWeight: '600', color: Echopay.text },
  recipientMeta: { fontSize: 12, color: Echopay.textMuted, marginTop: 2 },

  emptyState: { padding: 24, alignItems: 'center' },
  emptyTitle: { fontSize: 14, fontWeight: '600', color: Echopay.text },
  emptySub: { fontSize: 13, color: Echopay.textMuted, marginTop: 4 },

  // enter-amount
  toCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderRadius: 14,
    backgroundColor: Echopay.cardSoft,
    gap: 12,
    marginBottom: 24,
  },
  toLabel: {
    fontSize: 11,
    color: Echopay.textSubtle,
    fontWeight: '600',
    letterSpacing: 0.6,
  },
  toName: { fontSize: 16, color: Echopay.text, fontWeight: '700' },
  toMeta: { fontSize: 12, color: Echopay.textMuted, marginTop: 1 },

  amountWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Echopay.cardBg,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Echopay.border,
    paddingHorizontal: 18,
    marginBottom: 12,
  },
  nairaSymbol: {
    fontSize: 38,
    color: Echopay.textMuted,
    fontWeight: '300',
    marginRight: 6,
  },
  amountInput: {
    flex: 1,
    fontSize: 38,
    paddingVertical: 18,
    color: Echopay.text,
    fontWeight: '600',
  },
  balanceHint: {
    fontSize: 13,
    color: Echopay.textMuted,
    marginBottom: 14,
  },
  balanceHintBold: { color: Echopay.text, fontWeight: '600' },
  instantBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: Echopay.accentSoft,
    gap: 4,
    marginBottom: 24,
  },
  instantBadgeText: {
    color: Echopay.accent,
    fontSize: 12,
    fontWeight: '600',
  },

  // confirm-pin
  readback: {
    padding: 18,
    borderRadius: 18,
    backgroundColor: Echopay.cardBg,
    borderWidth: 1,
    borderColor: Echopay.border,
    marginBottom: 26,
    alignItems: 'center',
  },
  readbackAmount: {
    fontSize: 34,
    fontWeight: '800',
    color: Echopay.text,
    letterSpacing: -0.5,
  },
  readbackTo: {
    fontSize: 15,
    color: Echopay.textMuted,
    marginTop: 6,
  },
  readbackMeta: {
    fontSize: 12,
    color: Echopay.textSubtle,
    marginTop: 4,
  },

  fieldLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: Echopay.text,
    marginBottom: 8,
    letterSpacing: 0.2,
  },
  pinInput: {
    borderWidth: 1,
    borderColor: Echopay.border,
    borderRadius: 14,
    paddingVertical: 18,
    paddingHorizontal: 20,
    fontSize: 28,
    letterSpacing: 12,
    textAlign: 'center',
    backgroundColor: Echopay.cardBg,
    color: Echopay.text,
  },

  errorText: {
    color: Echopay.danger,
    fontSize: 13,
    marginTop: 10,
    fontWeight: '500',
  },

  // primary button
  primaryButton: {
    backgroundColor: Echopay.accent,
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
    marginTop: 22,
  },
  primaryButtonDisabled: { backgroundColor: Echopay.accentMuted },
  primaryButtonPressed: { backgroundColor: Echopay.accentPressed },
  primaryButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },

  hintText: {
    fontSize: 12,
    color: Echopay.textSubtle,
    marginTop: 14,
    textAlign: 'center',
  },
  hintBold: { color: Echopay.textMuted, fontWeight: '600' },

  // success
  successScreen: {
    flex: 1,
    backgroundColor: Echopay.pageBg,
    padding: 24,
    paddingTop: 90,
  },
  successInner: { alignItems: 'center', flex: 1 },
  successCheck: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: Echopay.success,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 22,
  },
  successCheckMark: { fontSize: 40, color: '#fff', fontWeight: '700' },
  successHeadline: {
    fontSize: 26,
    fontWeight: '800',
    color: Echopay.text,
    letterSpacing: -0.4,
  },
  successSub: {
    fontSize: 15,
    color: Echopay.textMuted,
    marginTop: 6,
  },
  successCard: {
    width: '100%',
    marginTop: 28,
    padding: 18,
    borderRadius: 16,
    backgroundColor: Echopay.cardBg,
    borderWidth: 1,
    borderColor: Echopay.border,
  },
  successRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  successLabel: { fontSize: 13, color: Echopay.textMuted },
  successValue: { fontSize: 13, color: Echopay.text, fontWeight: '600' },
  successValueMono: {
    fontSize: 12,
    color: Echopay.text,
    fontWeight: '600',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },

  linkRow: { marginTop: 18 },
  linkText: { color: Echopay.accent, fontSize: 14, fontWeight: '600' },
});
