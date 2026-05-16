// Offline wallet top-up screen — PRD_FUNBI §11.4.
//
// Users explicitly move funds from their online balance into a
// server-tracked offline budget. The locked amount is what they can
// spend when the network is down. Money never leaves the wallet — the
// move is a column-to-column transfer on the server (balance_kobo ↔
// locked_kobo).
//
// Visual hierarchy: lock icon hero → active-pot huge number with
// "of total" context → horizontal progress bar (orange = locked) →
// mode pill → amount input with quick-pick chips → primary CTA.
// Strict Echopay palette: no gradients, no shadows, one accent.

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

  const amountKobo = useMemo(() => {
    try {
      const k = parseNairaToKobo(amountStr || '0');
      return k > 0 ? k : 0;
    } catch {
      return 0;
    }
  }, [amountStr]);

  // The two pots. "Source" is what we're drawing from in the current
  // mode, "target" is what we're adding to.
  const source = mode === 'lock'
    ? { label: 'Main balance', kobo: balanceKobo, naira: balanceNaira }
    : { label: 'Offline budget', kobo: lockedBalanceKobo, naira: lockedBalanceNaira };
  const target = mode === 'lock'
    ? { label: 'Offline budget', kobo: lockedBalanceKobo, naira: lockedBalanceNaira }
    : { label: 'Main balance', kobo: balanceKobo, naira: balanceNaira };

  const totalKobo = balanceKobo + lockedBalanceKobo;
  const lockedPct = totalKobo > 0 ? lockedBalanceKobo / totalKobo : 0;

  const valid = amountKobo > 0 && amountKobo <= source.kobo && isOnline;

  const onSwitchMode = (next: Mode) => {
    setMode(next);
    setAmountStr('');
    setError(null);
    setSuccess(null);
  };

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
          ? `${formatKoboToNaira(res.movedKobo)} moved to your offline budget.`
          : `${formatKoboToNaira(res.movedKobo)} returned to your main wallet.`,
      );
      setAmountStr('');
    } catch (e) {
      if (e instanceof WalletMoveError) setError(e.message);
      else setError('Something went wrong. Try again.');
    } finally {
      setLoading(false);
    }
  };

  const quickAmounts = useMemo(() => {
    const cap = source.kobo;
    return [5_000_00, 10_000_00, 20_000_00, 50_000_00]
      .filter((k) => k <= cap)
      .slice(0, 3)
      .concat(cap > 0 ? [cap] : []);
  }, [source.kobo]);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.container}
    >
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.backButton}>
          <Ionicons name="chevron-back" size={22} color={Echopay.text} />
        </Pressable>

        {/* Hero icon — single flat container, hairline border, no rings */}
        <View style={styles.heroIconWrap}>
          <View style={styles.heroIcon}>
            <Ionicons
              name={mode === 'lock' ? 'lock-closed' : 'lock-open'}
              size={26}
              color={Echopay.accent}
            />
          </View>
          <Text style={styles.eyebrow}>OFFLINE WALLET</Text>
        </View>

        {/* Big active-pot number with total context */}
        <View style={styles.activeBlock}>
          <Text style={styles.activeLabel}>{target.label}</Text>
          <Text style={styles.activeAmount}>{target.naira}</Text>
          <Text style={styles.totalHint}>
            of <Text style={styles.totalHintBold}>{formatKoboToNaira(totalKobo)}</Text> total in your wallet
          </Text>
        </View>

        {/* Progress bar — orange = locked share */}
        <View style={styles.progressTrack}>
          <View
            style={[
              styles.progressFill,
              { width: `${Math.max(2, lockedPct * 100)}%` },
            ]}
          />
        </View>
        <View style={styles.progressLegend}>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: Echopay.accent }]} />
            <Text style={styles.legendText}>
              Offline {formatKoboToNaira(lockedBalanceKobo)}
            </Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: Echopay.border }]} />
            <Text style={styles.legendText}>
              Main {formatKoboToNaira(balanceKobo)}
            </Text>
          </View>
        </View>

        {/* Mode pill — animated-feeling sliding selector */}
        <View style={styles.modePill}>
          <View
            style={[
              styles.modeIndicator,
              mode === 'unlock' && styles.modeIndicatorRight,
            ]}
          />
          <Pressable
            onPress={() => onSwitchMode('lock')}
            style={styles.modePillHalf}
          >
            <Text
              style={[styles.modeText, mode === 'lock' && styles.modeTextActive]}
            >
              Move to offline
            </Text>
          </Pressable>
          <Pressable
            onPress={() => onSwitchMode('unlock')}
            style={styles.modePillHalf}
          >
            <Text
              style={[styles.modeText, mode === 'unlock' && styles.modeTextActive]}
            >
              Return to main
            </Text>
          </Pressable>
        </View>

        {/* Amount input */}
        <View style={styles.amountCard}>
          <Text style={styles.amountFieldLabel}>
            How much from{' '}
            <Text style={styles.amountFieldLabelBold}>{source.label}</Text>?
          </Text>
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
            Up to{' '}
            <Text style={styles.capHintBold}>{source.naira}</Text> available
          </Text>

          {/* Quick-pick chips */}
          {quickAmounts.length > 0 && (
            <View style={styles.chipsRow}>
              {quickAmounts.map((kobo, i) => {
                const isMax = kobo === source.kobo && i === quickAmounts.length - 1;
                return (
                  <Pressable
                    key={`${kobo}-${i}`}
                    onPress={() => setAmountStr((kobo / 100).toString())}
                    style={({ pressed }) => [
                      styles.chip,
                      pressed && styles.chipPressed,
                    ]}
                  >
                    <Text style={styles.chipText}>
                      {isMax ? 'Max' : formatKoboToNaira(kobo)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          )}
        </View>

        {/* Status banners */}
        {!isOnline && (
          <View style={styles.banner}>
            <Ionicons name="cloud-offline-outline" size={16} color={Echopay.danger} />
            <Text style={styles.bannerDanger}>
              You're offline. Connect to move funds between wallets.
            </Text>
          </View>
        )}
        {error && (
          <View style={styles.banner}>
            <Ionicons name="alert-circle-outline" size={16} color={Echopay.danger} />
            <Text style={styles.bannerDanger}>{error}</Text>
          </View>
        )}
        {success && (
          <View style={styles.bannerSuccess}>
            <Ionicons name="checkmark-circle" size={18} color={Echopay.success} />
            <Text style={styles.bannerSuccessText}>{success}</Text>
          </View>
        )}

        {/* Primary CTA */}
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
            <ActivityIndicator color={Echopay.cardBg} />
          ) : (
            <View style={styles.primaryButtonInner}>
              <Text style={styles.primaryButtonText}>
                {amountKobo > 0
                  ? mode === 'lock'
                    ? `Move ${formatKoboToNaira(amountKobo)} offline`
                    : `Return ${formatKoboToNaira(amountKobo)} to main`
                  : mode === 'lock'
                  ? 'Move to offline'
                  : 'Return to main'}
              </Text>
              <Ionicons
                name={mode === 'lock' ? 'arrow-down' : 'arrow-up'}
                size={18}
                color={Echopay.cardBg}
                style={{ marginLeft: 8 }}
              />
            </View>
          )}
        </Pressable>

        {/* Note */}
        <View style={styles.note}>
          <Ionicons name="shield-checkmark-outline" size={16} color={Echopay.textMuted} />
          <Text style={styles.noteText}>
            Your money never leaves your wallet. Locked funds sit in a
            server-tracked offline budget — spendable from your phone
            only, capped at what you've allocated.
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ----------------------------------------------------------------- styles

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Echopay.pageBg },
  scrollContent: { flexGrow: 1, paddingHorizontal: 22, paddingTop: 12, paddingBottom: 50 },

  // back — icon-only, no label
  backButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
    marginLeft: -8,
  },

  // hero — single flat surface, hairline border, no rings
  heroIconWrap: { alignItems: 'center', marginBottom: 28 },
  heroIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: Echopay.cardBg,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Echopay.border,
  },
  eyebrow: {
    marginTop: 14,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1.8,
    color: Echopay.textSubtle,
  },

  // active pot — tracking-tight, light weight
  activeBlock: { alignItems: 'center', marginBottom: 24 },
  activeLabel: {
    fontSize: 13,
    color: Echopay.textMuted,
    fontWeight: '500',
    marginBottom: 8,
  },
  activeAmount: {
    fontSize: 48,
    fontWeight: '300',
    color: Echopay.text,
    letterSpacing: -1.2,
  },
  totalHint: {
    fontSize: 13,
    color: Echopay.textMuted,
    marginTop: 8,
  },
  totalHintBold: { color: Echopay.text, fontWeight: '500' },

  // progress — thinner refined track
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: Echopay.border,
    overflow: 'hidden',
    marginBottom: 12,
  },
  progressFill: {
    height: '100%',
    backgroundColor: Echopay.accent,
    borderRadius: 3,
  },
  progressLegend: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 28,
  },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendDot: { width: 6, height: 6, borderRadius: 3 },
  legendText: { fontSize: 12, color: Echopay.textMuted, fontWeight: '500' },

  // mode pill — single hairline border on card surface
  modePill: {
    flexDirection: 'row',
    backgroundColor: Echopay.cardBg,
    borderWidth: 1,
    borderColor: Echopay.border,
    borderRadius: 12,
    padding: 4,
    marginBottom: 24,
    position: 'relative',
    height: 44,
  },
  modeIndicator: {
    position: 'absolute',
    top: 4,
    left: 4,
    width: '50%',
    height: 34,
    backgroundColor: Echopay.cardSoft,
    borderRadius: 8,
  },
  modeIndicatorRight: {
    left: '50%',
    marginLeft: -2,
  },
  modePillHalf: {
    flex: 1,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },
  modeText: { fontSize: 13, fontWeight: '500', color: Echopay.textMuted },
  modeTextActive: { color: Echopay.text, fontWeight: '600' },

  // amount card — hairline border, consistent radius
  amountCard: {
    backgroundColor: Echopay.cardBg,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Echopay.border,
    padding: 20,
    marginBottom: 16,
  },
  amountFieldLabel: {
    fontSize: 13,
    color: Echopay.textMuted,
    marginBottom: 14,
  },
  amountFieldLabelBold: { color: Echopay.text, fontWeight: '600' },
  amountWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: Echopay.border,
    paddingBottom: 4,
  },
  nairaSymbol: {
    fontSize: 36,
    color: Echopay.textSubtle,
    fontWeight: '300',
    marginRight: 6,
  },
  amountInput: {
    flex: 1,
    fontSize: 40,
    paddingVertical: 8,
    color: Echopay.text,
    fontWeight: '300',
    letterSpacing: -1.0,
  },
  capHint: {
    fontSize: 12,
    color: Echopay.textMuted,
    marginTop: 12,
  },
  capHintBold: { color: Echopay.text, fontWeight: '600' },
  chipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 16,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: Echopay.cardBg,
    borderWidth: 1,
    borderColor: Echopay.border,
  },
  chipPressed: {
    backgroundColor: Echopay.cardSoft,
    borderColor: Echopay.borderStrong,
  },
  chipText: { fontSize: 13, fontWeight: '500', color: Echopay.text },

  // banners — hairline border in semantic tone
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Echopay.dangerSoft,
    borderWidth: 1,
    borderColor: Echopay.dangerSoft,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 10,
  },
  bannerDanger: {
    flex: 1,
    fontSize: 13,
    color: Echopay.danger,
    fontWeight: '500',
  },
  bannerSuccess: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Echopay.successSoft,
    borderWidth: 1,
    borderColor: Echopay.successSoft,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 10,
  },
  bannerSuccessText: {
    flex: 1,
    fontSize: 13,
    color: Echopay.success,
    fontWeight: '500',
  },

  // primary CTA — consistent 12 radius
  primaryButton: {
    backgroundColor: Echopay.accent,
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 8,
  },
  primaryButtonInner: { flexDirection: 'row', alignItems: 'center' },
  primaryButtonDisabled: { backgroundColor: Echopay.accentMuted },
  primaryButtonPressed: { backgroundColor: Echopay.accentPressed },
  primaryButtonText: { color: Echopay.cardBg, fontSize: 15, fontWeight: '600' },

  // note — hairline border to match design language
  note: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginTop: 24,
    padding: 14,
    borderRadius: 12,
    backgroundColor: Echopay.cardSoft,
    borderWidth: 1,
    borderColor: Echopay.border,
  },
  noteText: {
    flex: 1,
    fontSize: 12,
    color: Echopay.textMuted,
    lineHeight: 18,
  },
});
