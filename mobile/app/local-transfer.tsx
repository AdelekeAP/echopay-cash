// Local Transfer screen — four-stage in-network payment flow.
//
// Presentation-only per mobile/docs/ARCHITECTURE.md (PRD_FUNBI §13).
// All state machine + handlers + prefill logic live in
// hooks/useLocalTransfer. This file is JSX + styles only.
//
// Accepts optional URL params (PRD_FUNBI §12):
//   /local-transfer?recipientId=iya_tope&amountKobo=500000
// When both are present and resolve, the hook skips straight to PIN.

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
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Echopay } from '../constants/theme';
import { useLocalTransfer } from '../hooks/useLocalTransfer';
import { formatKoboToNaira } from '../utils/format';

export default function LocalTransferScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    recipientId?: string;
    amountKobo?: string;
  }>();

  const parsedAmount = params.amountKobo
    ? Number.parseInt(params.amountKobo, 10)
    : undefined;

  const lt = useLocalTransfer({
    prefilledRecipientId: params.recipientId,
    prefilledAmountKobo: Number.isFinite(parsedAmount) ? parsedAmount : undefined,
  });

  // -------------------------------------------------- success screen

  if (lt.stage === 'success' && lt.result) {
    return (
      <View style={styles.successScreen}>
        <View style={styles.successInner}>
          <View style={styles.successCheck}>
            <Text style={styles.successCheckMark}>✓</Text>
          </View>
          <Text style={styles.successHeadline}>
            Sent {formatKoboToNaira(lt.amountKobo)}
          </Text>
          <Text style={styles.successSub}>to {lt.result.recipientName}</Text>

          <View style={styles.successCard}>
            <View style={styles.successRow}>
              <Text style={styles.successLabel}>Settled in</Text>
              <Text style={styles.successValue}>{lt.result.durationMs} ms</Text>
            </View>
            <View style={styles.successRow}>
              <Text style={styles.successLabel}>Reference</Text>
              <Text style={styles.successValueMono}>{lt.result.txId}</Text>
            </View>
            <View style={styles.successRow}>
              <Text style={styles.successLabel}>
                {lt.result.debitedFrom === 'locked' ? 'Offline budget left' : 'New balance'}
              </Text>
              <Text style={styles.successValue}>
                {formatKoboToNaira(lt.result.balanceAfterKobo)}
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

          <Pressable onPress={lt.reset} style={styles.linkRow} hitSlop={8}>
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
        <View style={styles.header}>
          <Pressable
            onPress={() => (lt.stage === 'pick-recipient' ? router.back() : lt.back())}
            hitSlop={12}
            style={styles.backRow}
          >
            <Text style={styles.backText}>← Back</Text>
          </Pressable>
          <Text style={styles.eyebrow}>LOCAL TRANSFER</Text>
          <Text style={styles.title}>
            {lt.stage === 'pick-recipient' && 'Who are you paying?'}
            {lt.stage === 'enter-amount' && 'How much?'}
            {lt.stage === 'confirm-pin' && 'Confirm with your PIN'}
          </Text>
          {lt.stage === 'pick-recipient' && (
            <Text style={styles.subtitle}>
              Send instantly to another EchoPay Cash user. No fees.
            </Text>
          )}
        </View>

        {/* Stage: pick-recipient */}
        {lt.stage === 'pick-recipient' && (
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
                value={lt.query}
                onChangeText={lt.setQuery}
                placeholder="Phone or username"
                placeholderTextColor={Echopay.textSubtle}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>

            <Text style={styles.sectionLabel}>Suggested</Text>

            <View style={styles.recipientList}>
              {lt.recipients.length === 0 ? (
                <View style={styles.emptyState}>
                  <Text style={styles.emptyTitle}>No matches</Text>
                  <Text style={styles.emptySub}>
                    Try a different name or username.
                  </Text>
                </View>
              ) : (
                lt.recipients.map((p) => (
                  <Pressable
                    key={p.id}
                    onPress={() => lt.selectRecipient(p)}
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
        {lt.stage === 'enter-amount' && lt.recipient && (
          <>
            <View style={styles.toCard}>
              <View style={styles.avatarSmall}>
                <Text style={styles.avatarText}>{lt.recipient.initials}</Text>
              </View>
              <View>
                <Text style={styles.toLabel}>To</Text>
                <Text style={styles.toName}>{lt.recipient.display_name}</Text>
                <Text style={styles.toMeta}>{lt.recipient.role}</Text>
              </View>
            </View>

            <View style={styles.amountWrap}>
              <Text style={styles.nairaSymbol}>₦</Text>
              <TextInput
                style={styles.amountInput}
                value={lt.amountStr}
                onChangeText={lt.setAmount}
                placeholder="0"
                placeholderTextColor={Echopay.textSubtle}
                keyboardType="decimal-pad"
                autoFocus
              />
            </View>

            <Text style={styles.balanceHint}>
              From your {lt.activeBalanceLabel}{' '}
              <Text style={styles.balanceHintBold}>{lt.activeBalanceNaira}</Text>
            </Text>

            <View style={styles.instantBadge}>
              <Ionicons name="flash" size={14} color={Echopay.accent} />
              <Text style={styles.instantBadgeText}>
                {lt.isOnline ? 'Instant · No fees' : 'Offline · Will sync when connected'}
              </Text>
            </View>

            {lt.amountKobo > lt.activeBalanceKobo && (
              <Text style={styles.errorText}>
                {lt.isOnline
                  ? "That's more than your balance."
                  : "That's more than your offline budget. Connect to add more."}
              </Text>
            )}

            <Pressable
              onPress={lt.continueFromAmount}
              disabled={!lt.amountValid}
              style={({ pressed }) => [
                styles.primaryButton,
                !lt.amountValid && styles.primaryButtonDisabled,
                pressed && lt.amountValid && styles.primaryButtonPressed,
              ]}
            >
              <Text style={styles.primaryButtonText}>Continue</Text>
            </Pressable>
          </>
        )}

        {/* Stage: confirm-pin */}
        {lt.stage === 'confirm-pin' && lt.recipient && (
          <>
            <View style={styles.readback}>
              <Text style={styles.readbackAmount}>
                {formatKoboToNaira(lt.amountKobo)}
              </Text>
              <Text style={styles.readbackTo}>to {lt.recipient.display_name}</Text>
              <Text style={styles.readbackMeta}>
                EchoPay Cash · Instant · No fees
              </Text>
            </View>

            <Text style={styles.fieldLabel}>Your PIN</Text>
            <TextInput
              style={styles.pinInput}
              value={lt.pin}
              onChangeText={(t) => lt.setPin(t.replace(/\D/g, '').slice(0, 4))}
              keyboardType="number-pad"
              secureTextEntry
              maxLength={4}
              placeholder="••••"
              placeholderTextColor={Echopay.textSubtle}
              autoFocus
            />

            {lt.error && <Text style={styles.errorText}>{lt.error}</Text>}

            <Pressable
              onPress={lt.confirmAndSend}
              disabled={lt.loading || lt.pin.length < 4}
              style={({ pressed }) => [
                styles.primaryButton,
                (lt.loading || lt.pin.length < 4) && styles.primaryButtonDisabled,
                pressed && !lt.loading && lt.pin.length === 4 && styles.primaryButtonPressed,
              ]}
            >
              {lt.loading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.primaryButtonText}>
                  Send {formatKoboToNaira(lt.amountKobo)}
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
