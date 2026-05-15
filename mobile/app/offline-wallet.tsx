// Offline wallet top-up screen — PRD_FUNBI §11.4.
//
// Users explicitly move funds from their online balance into a
// server-tracked offline budget. The locked amount is what they can
// spend when the network is down. Money never leaves the wallet — the
// move is a column-to-column transfer on the server (balance_kobo ↔
// locked_kobo).
//
// Lock action requires network (calls /wallet/lock-for-offline). If
// offline, the user is shown a friendly message and the action is
// disabled — top-up is an explicit-online operation by design.

import { useState } from 'react';
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
import { useWallet, WalletMoveError } from '../hooks/useWallet';
import { useNetworkStatus } from '../hooks/useNetworkStatus';
import { Echopay } from '../constants/theme';
import { formatKoboToNaira, parseNairaToKobo } from '../utils/format';

type Mode = 'lock' | 'unlock';

export default function OfflineWalletScreen() {
  const router = useRouter();
  const {
    balanceKobo,
    balanceNaira,
    lockedBalanceKobo,
    lockedBalanceNaira,
    lockForOffline,
    unlockFromOffline,
  } = useWallet();
  const { isOnline } = useNetworkStatus();

  const [mode, setMode] = useState<Mode>('lock');
  const [amountStr, setAmountStr] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);

  const amountKobo = (() => {
    try {
      const k = parseNairaToKobo(amountStr || '0');
      return k > 0 ? k : 0;
    } catch {
      return 0;
    }
  })();

  const cap = mode === 'lock' ? balanceKobo : lockedBalanceKobo;
  const valid = amountKobo > 0 && amountKobo <= cap && isOnline;

  const onSubmit = async () => {
    setError(null);
    setSuccess(null);
    setLoading(true);
    try {
      const res =
        mode === 'lock'
          ? await lockForOffline(amountKobo)
          : await unlockFromOffline(amountKobo);
      setSuccess(
        mode === 'lock'
          ? `Locked ${formatKoboToNaira(res.movedKobo)} for offline use.`
          : `Returned ${formatKoboToNaira(res.movedKobo)} to your main wallet.`,
      );
      setAmountStr('');
    } catch (e) {
      if (e instanceof WalletMoveError) setError(e.message);
      else setError('Something went wrong. Try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.container}
    >
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.backRow}>
          <Text style={styles.backText}>← Back</Text>
        </Pressable>

        <Text style={styles.eyebrow}>OFFLINE BUDGET</Text>
        <Text style={styles.title}>
          {mode === 'lock' ? 'Pre-load your offline wallet' : 'Return offline funds'}
        </Text>
        <Text style={styles.subtitle}>
          {mode === 'lock'
            ? 'Funds you can spend even when your network drops. Money stays in your wallet — we just set it aside.'
            : 'Move funds back from your offline budget to your main balance.'}
        </Text>

        {/* Balance cards */}
        <View style={styles.balancesRow}>
          <View
            style={[
              styles.balanceTile,
              mode === 'lock' && styles.balanceTileActive,
            ]}
          >
            <Text style={styles.balanceLabel}>Main balance</Text>
            <Text style={styles.balanceValue}>{balanceNaira}</Text>
          </View>
          <View style={styles.arrowCol}>
            <Ionicons
              name={mode === 'lock' ? 'arrow-forward' : 'arrow-back'}
              size={20}
              color={Echopay.accent}
            />
          </View>
          <View
            style={[
              styles.balanceTile,
              mode === 'unlock' && styles.balanceTileActive,
            ]}
          >
            <Text style={styles.balanceLabel}>Offline budget</Text>
            <Text style={styles.balanceValue}>{lockedBalanceNaira}</Text>
          </View>
        </View>

        {/* Mode toggle */}
        <View style={styles.tabsRow}>
          <Pressable
            onPress={() => {
              setMode('lock');
              setAmountStr('');
              setError(null);
              setSuccess(null);
            }}
            style={[
              styles.tab,
              mode === 'lock' && styles.tabActive,
            ]}
          >
            <Text style={[styles.tabText, mode === 'lock' && styles.tabTextActive]}>
              Lock for offline
            </Text>
          </Pressable>
          <Pressable
            onPress={() => {
              setMode('unlock');
              setAmountStr('');
              setError(null);
              setSuccess(null);
            }}
            style={[
              styles.tab,
              mode === 'unlock' && styles.tabActive,
            ]}
          >
            <Text style={[styles.tabText, mode === 'unlock' && styles.tabTextActive]}>
              Return to main
            </Text>
          </Pressable>
        </View>

        {/* Amount input */}
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

        <Text style={styles.capHint}>
          {mode === 'lock'
            ? `Up to ${balanceNaira} available`
            : `Up to ${lockedBalanceNaira} can be returned`}
        </Text>

        {!isOnline && (
          <View style={styles.offlineWarning}>
            <Ionicons name="cloud-offline-outline" size={16} color={Echopay.danger} />
            <Text style={styles.offlineWarningText}>
              You're offline. Connect to top up or return your offline budget.
            </Text>
          </View>
        )}

        {error && <Text style={styles.errorText}>{error}</Text>}
        {success && (
          <View style={styles.successInline}>
            <Ionicons name="checkmark-circle" size={18} color={Echopay.success} />
            <Text style={styles.successInlineText}>{success}</Text>
          </View>
        )}

        <Pressable
          onPress={onSubmit}
          disabled={!valid || loading}
          style={({ pressed }) => [
            styles.primaryButton,
            (!valid || loading) && styles.primaryButtonDisabled,
            pressed && valid && !loading && styles.primaryButtonPressed,
          ]}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.primaryButtonText}>
              {mode === 'lock'
                ? amountKobo > 0
                  ? `Lock ${formatKoboToNaira(amountKobo)} for offline use`
                  : 'Lock for offline use'
                : amountKobo > 0
                ? `Return ${formatKoboToNaira(amountKobo)} to main wallet`
                : 'Return to main wallet'}
            </Text>
          )}
        </Pressable>

        <View style={styles.note}>
          <Ionicons
            name="information-circle-outline"
            size={16}
            color={Echopay.textMuted}
          />
          <Text style={styles.noteText}>
            Your money never leaves your wallet. Locked funds sit in a
            server-tracked offline budget — they're only spendable from
            your phone, and only up to the amount you've allocated.
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ----------------------------------------------------------------- styles

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Echopay.pageBg },
  scrollContent: { flexGrow: 1, padding: 24, paddingBottom: 60 },

  backRow: { marginTop: 8, marginBottom: 14 },
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
    marginBottom: 20,
  },

  balancesRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 8,
    marginBottom: 24,
  },
  balanceTile: {
    flex: 1,
    backgroundColor: Echopay.cardBg,
    borderWidth: 1,
    borderColor: Echopay.border,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 14,
  },
  balanceTileActive: {
    borderColor: Echopay.accent,
    backgroundColor: Echopay.accentSoft,
  },
  balanceLabel: {
    fontSize: 11,
    color: Echopay.textMuted,
    fontWeight: '600',
    letterSpacing: 0.6,
  },
  balanceValue: {
    fontSize: 19,
    fontWeight: '700',
    color: Echopay.text,
    marginTop: 6,
  },
  arrowCol: {
    width: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },

  tabsRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 22,
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Echopay.border,
    alignItems: 'center',
    backgroundColor: Echopay.cardBg,
  },
  tabActive: {
    borderColor: Echopay.accent,
    backgroundColor: Echopay.accentSoft,
  },
  tabText: { fontSize: 13, fontWeight: '600', color: Echopay.textMuted },
  tabTextActive: { color: Echopay.accent },

  amountWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Echopay.cardBg,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Echopay.border,
    paddingHorizontal: 18,
    marginBottom: 8,
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
    paddingVertical: 16,
    color: Echopay.text,
    fontWeight: '600',
  },
  capHint: {
    fontSize: 12,
    color: Echopay.textMuted,
    marginBottom: 16,
  },

  offlineWarning: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Echopay.dangerSoft,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 12,
  },
  offlineWarningText: {
    flex: 1,
    fontSize: 13,
    color: Echopay.danger,
    fontWeight: '500',
  },

  errorText: {
    color: Echopay.danger,
    fontSize: 13,
    marginBottom: 10,
    fontWeight: '500',
  },
  successInline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Echopay.successSoft,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 10,
  },
  successInlineText: {
    flex: 1,
    fontSize: 13,
    color: Echopay.success,
    fontWeight: '500',
  },

  primaryButton: {
    backgroundColor: Echopay.accent,
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
    marginTop: 12,
  },
  primaryButtonDisabled: { backgroundColor: Echopay.accentMuted },
  primaryButtonPressed: { backgroundColor: Echopay.accentPressed },
  primaryButtonText: { color: '#fff', fontSize: 15, fontWeight: '600' },

  note: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginTop: 22,
    padding: 14,
    borderRadius: 12,
    backgroundColor: Echopay.cardSoft,
  },
  noteText: {
    flex: 1,
    fontSize: 12,
    color: Echopay.textMuted,
    lineHeight: 18,
  },
});
