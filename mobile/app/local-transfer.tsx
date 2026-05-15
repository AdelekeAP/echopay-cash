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

  // -------------------------------------------------- success

  if (lt.stage === 'success' && lt.result) {
    return (
      <View style={styles.container}>
        <ScrollView contentContainerStyle={styles.successContent}>
          <View style={styles.tick}>
            <Ionicons name="checkmark" size={28} color={Echopay.accent} />
          </View>

          <Text style={styles.successAmount}>
            Sent {formatKoboToNaira(lt.amountKobo)}
          </Text>
          <Text style={styles.successTo}>to {lt.result.recipientName}</Text>

          <View style={styles.detailList}>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Settled in</Text>
              <Text style={styles.detailValue}>{lt.result.durationMs} ms</Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Reference</Text>
              <Text style={styles.detailMono}>{lt.result.txId}</Text>
            </View>
            <View style={[styles.detailRow, styles.detailRowLast]}>
              <Text style={styles.detailLabel}>
                {lt.result.debitedFrom === 'locked'
                  ? 'Offline budget left'
                  : 'New balance'}
              </Text>
              <Text style={styles.detailValue}>
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

          <Pressable onPress={lt.reset} style={styles.linkButton} hitSlop={8}>
            <Text style={styles.linkText}>Send another</Text>
          </Pressable>
        </ScrollView>
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
        <Pressable
          onPress={() =>
            lt.stage === 'pick-recipient' ? router.back() : lt.back()
          }
          hitSlop={12}
          style={styles.back}
        >
          <Ionicons name="chevron-back" size={22} color={Echopay.text} />
        </Pressable>

        <Text style={styles.title}>
          {lt.stage === 'pick-recipient' && 'Send'}
          {lt.stage === 'enter-amount' && 'How much?'}
          {lt.stage === 'confirm-pin' && 'Confirm'}
        </Text>

        {lt.stage === 'pick-recipient' && (
          <Text style={styles.subtitle}>
            Instant. No fees. Between EchoPay Cash users.
          </Text>
        )}

        {/* Stage: pick-recipient */}
        {lt.stage === 'pick-recipient' && (
          <>
            <View style={styles.searchRow}>
              <Ionicons
                name="search"
                size={18}
                color={Echopay.textSubtle}
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

            <View>
              {lt.recipients.length === 0 ? (
                <View style={styles.empty}>
                  <Text style={styles.emptyTitle}>No matches</Text>
                  <Text style={styles.emptySub}>
                    Try a different name or username.
                  </Text>
                </View>
              ) : (
                lt.recipients.map((p, i) => (
                  <Pressable
                    key={p.id}
                    onPress={() => lt.selectRecipient(p)}
                    style={({ pressed }) => [
                      styles.row,
                      i !== lt.recipients.length - 1 && styles.rowDivider,
                      pressed && styles.rowPressed,
                    ]}
                  >
                    <View style={styles.avatar}>
                      <Text style={styles.avatarText}>{p.initials}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowName}>{p.display_name}</Text>
                      <Text style={styles.rowMeta}>{p.role}</Text>
                    </View>
                  </Pressable>
                ))
              )}
            </View>
          </>
        )}

        {/* Stage: enter-amount */}
        {lt.stage === 'enter-amount' && lt.recipient && (
          <>
            <View style={styles.toLine}>
              <View style={styles.avatarSmall}>
                <Text style={styles.avatarTextSmall}>
                  {lt.recipient.initials}
                </Text>
              </View>
              <Text style={styles.toText}>
                To{' '}
                <Text style={styles.toName}>
                  {lt.recipient.display_name}
                </Text>
              </Text>
            </View>

            <View style={styles.amountRow}>
              <Text style={styles.naira}>₦</Text>
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
              <Text style={styles.balanceHintBold}>
                {lt.activeBalanceNaira}
              </Text>
            </Text>

            <View style={styles.instant}>
              <Ionicons name="flash" size={13} color={Echopay.accent} />
              <Text style={styles.instantText}>
                {lt.isOnline
                  ? 'Instant · No fees'
                  : 'Offline · Will sync when connected'}
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
              <Text style={styles.readbackTo}>
                to {lt.recipient.display_name}
              </Text>
            </View>

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
                pressed &&
                  !lt.loading &&
                  lt.pin.length === 4 &&
                  styles.primaryButtonPressed,
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
              Demo PIN <Text style={styles.hintBold}>1234</Text>
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
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingTop: 16,
    paddingBottom: 60,
  },

  // header
  back: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: -10,
    marginBottom: 28,
  },
  title: {
    fontSize: 32,
    fontWeight: '700',
    color: Echopay.text,
    letterSpacing: -0.8,
  },
  subtitle: {
    fontSize: 14,
    color: Echopay.textMuted,
    marginTop: 8,
    lineHeight: 20,
  },

  // search
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: Echopay.border,
    marginTop: 32,
    marginBottom: 24,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: Echopay.text,
    padding: 0,
  },

  sectionLabel: {
    fontSize: 12,
    color: Echopay.textSubtle,
    fontWeight: '500',
    marginBottom: 4,
  },

  // recipient list — flat rows w/ hairline dividers
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 16,
  },
  rowDivider: {
    borderBottomWidth: 1,
    borderBottomColor: Echopay.border,
  },
  rowPressed: { opacity: 0.55 },
  rowName: {
    fontSize: 16,
    color: Echopay.text,
    fontWeight: '500',
  },
  rowMeta: {
    fontSize: 13,
    color: Echopay.textMuted,
    marginTop: 2,
  },

  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Echopay.cardSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: Echopay.text,
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  avatarSmall: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: Echopay.cardSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarTextSmall: {
    color: Echopay.text,
    fontSize: 11,
    fontWeight: '600',
  },

  empty: { paddingVertical: 32, alignItems: 'center' },
  emptyTitle: { fontSize: 14, fontWeight: '500', color: Echopay.text },
  emptySub: { fontSize: 13, color: Echopay.textMuted, marginTop: 4 },

  // enter amount
  toLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 32,
    marginBottom: 40,
    alignSelf: 'flex-start',
  },
  toText: { fontSize: 15, color: Echopay.textMuted },
  toName: { color: Echopay.text, fontWeight: '600' },

  amountRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'center',
    marginBottom: 18,
  },
  naira: {
    fontSize: 30,
    color: Echopay.textMuted,
    fontWeight: '300',
    marginRight: 4,
  },
  amountInput: {
    fontSize: 56,
    color: Echopay.text,
    fontWeight: '300',
    letterSpacing: -1.5,
    padding: 0,
    minWidth: 80,
  },

  balanceHint: {
    fontSize: 13,
    color: Echopay.textMuted,
    textAlign: 'center',
    marginBottom: 14,
  },
  balanceHintBold: { color: Echopay.text, fontWeight: '600' },

  instant: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    gap: 5,
    marginBottom: 36,
  },
  instantText: {
    fontSize: 12,
    color: Echopay.textMuted,
    fontWeight: '500',
  },

  // confirm pin
  readback: {
    alignItems: 'center',
    marginTop: 36,
    marginBottom: 44,
  },
  readbackAmount: {
    fontSize: 44,
    fontWeight: '300',
    color: Echopay.text,
    letterSpacing: -1.2,
  },
  readbackTo: {
    fontSize: 14,
    color: Echopay.textMuted,
    marginTop: 10,
  },

  pinInput: {
    fontSize: 28,
    letterSpacing: 18,
    textAlign: 'center',
    color: Echopay.text,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: Echopay.border,
  },

  errorText: {
    color: Echopay.danger,
    fontSize: 13,
    marginTop: 12,
    textAlign: 'center',
    fontWeight: '500',
  },

  // primary button
  primaryButton: {
    backgroundColor: Echopay.accent,
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
    marginTop: 28,
  },
  primaryButtonDisabled: { backgroundColor: Echopay.accentMuted },
  primaryButtonPressed: { backgroundColor: Echopay.accentPressed },
  primaryButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },

  hintText: {
    fontSize: 12,
    color: Echopay.textSubtle,
    marginTop: 16,
    textAlign: 'center',
  },
  hintBold: { color: Echopay.textMuted, fontWeight: '600' },

  // success
  successContent: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingTop: 80,
    paddingBottom: 60,
    alignItems: 'center',
  },
  tick: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: Echopay.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 28,
  },
  successAmount: {
    fontSize: 28,
    fontWeight: '700',
    color: Echopay.text,
    letterSpacing: -0.6,
  },
  successTo: {
    fontSize: 15,
    color: Echopay.textMuted,
    marginTop: 6,
  },
  detailList: {
    width: '100%',
    marginTop: 32,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: Echopay.border,
  },
  detailRowLast: { borderBottomWidth: 0 },
  detailLabel: { fontSize: 14, color: Echopay.textMuted },
  detailValue: { fontSize: 14, color: Echopay.text, fontWeight: '500' },
  detailMono: {
    fontSize: 12,
    color: Echopay.text,
    fontWeight: '500',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },

  linkButton: { marginTop: 16, paddingVertical: 8 },
  linkText: { color: Echopay.accent, fontSize: 14, fontWeight: '600' },
});
