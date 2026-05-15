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
} from 'react-native';
import { useRouter } from 'expo-router';
import QRCode from 'react-native-qrcode-svg';

import { Echopay } from '../constants/theme';
import { useAuth } from '../context/AuthContext';
import { formatKoboToNaira, parseNairaToKobo } from '../utils/format';

// Static demo VA — replaced by /dynamic-va/create response once backend lands.
const DEMO_VA = '0123456789';

export default function ReceiveScreen() {
  const router = useRouter();
  const { user, account } = useAuth();
  const [amountInput, setAmountInput] = useState('');

  const amountKobo = useMemo(() => {
    if (!amountInput.trim()) return 0;
    try {
      return parseNairaToKobo(amountInput);
    } catch {
      return 0;
    }
  }, [amountInput]);

  const vaNumber = account?.account_number ?? DEMO_VA;
  const recipientName =
    user?.first_name && user?.last_name
      ? `${user.first_name} ${user.last_name}`
      : user?.first_name ?? 'EchoPay user';
  const bankName = account?.bank?.name ?? 'GTBank';

  const qrPayload = `echopay:demo:${vaNumber}:${amountKobo}`;
  const amountDisplay = amountKobo > 0 ? formatKoboToNaira(amountKobo) : null;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.container}
    >
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <Pressable
          onPress={() => router.back()}
          style={styles.backRow}
          hitSlop={12}
        >
          <Text style={styles.backText}>← Back</Text>
        </Pressable>

        <View style={styles.heroBlock}>
          <Text style={styles.heroEyebrow}>RECEIVE</Text>
          <Text style={styles.heroTitle}>Receive money</Text>
          <Text style={styles.heroSubtitle}>
            Anyone can scan this QR to send to your wallet.
          </Text>
        </View>

        <View style={styles.qrCard}>
          <View style={styles.qrFrame}>
            <QRCode
              value={qrPayload}
              size={200}
              color={Echopay.text}
              backgroundColor={Echopay.cardBg}
              ecl="Q"
            />
          </View>
          <Text style={styles.recipientName}>{recipientName}</Text>
          <Text style={styles.recipientMeta}>
            {bankName} · {vaNumber.replace(/(\d{4})(\d{3})(\d{3})/, '$1 $2 $3')}
          </Text>
          {amountDisplay && (
            <View style={styles.amountChip}>
              <Text style={styles.amountChipText}>{amountDisplay}</Text>
            </View>
          )}
        </View>

        <View style={styles.field}>
          <Text style={styles.fieldLabel}>How much?</Text>
          <View style={styles.amountInputWrap}>
            <Text style={styles.amountPrefix}>₦</Text>
            <TextInput
              style={styles.amountInput}
              value={amountInput}
              onChangeText={(t) => setAmountInput(t.replace(/[^0-9.,]/g, ''))}
              keyboardType="decimal-pad"
              placeholder="0"
              placeholderTextColor={Echopay.textSubtle}
            />
          </View>
          <Text style={styles.fieldHint}>
            Type an amount to lock the QR to that figure. Leave blank to let
            the payer choose.
          </Text>
        </View>

        <Pressable
          style={({ pressed }) => [
            styles.primaryButton,
            pressed && styles.primaryButtonPressed,
          ]}
        >
          <Text style={styles.primaryButtonText}>Generate QR</Text>
        </Pressable>

        <View style={styles.providerBadge}>
          <View style={styles.providerDot} />
          <Text style={styles.providerText}>
            Powered by <Text style={styles.providerBold}>Squad</Text> Dynamic
            VA · 5-minute expiry
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Echopay.pageBg },
  scrollContent: { flexGrow: 1, padding: 24, paddingBottom: 60 },

  backRow: { marginTop: 8, marginBottom: 14 },
  backText: { fontSize: 15, color: Echopay.accent, fontWeight: '500' },

  heroBlock: { marginBottom: 22 },
  heroEyebrow: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.4,
    color: Echopay.accent,
    marginBottom: 10,
  },
  heroTitle: {
    fontSize: 30,
    fontWeight: '700',
    color: Echopay.text,
    letterSpacing: -0.6,
    lineHeight: 36,
  },
  heroSubtitle: {
    fontSize: 15,
    color: Echopay.textMuted,
    marginTop: 8,
    lineHeight: 22,
  },

  qrCard: {
    backgroundColor: Echopay.cardBg,
    borderWidth: 1,
    borderColor: Echopay.border,
    borderRadius: 18,
    padding: 24,
    alignItems: 'center',
    marginBottom: 22,
  },
  qrFrame: {
    padding: 14,
    backgroundColor: Echopay.cardBg,
    borderRadius: 14,
    marginBottom: 18,
  },
  recipientName: {
    fontSize: 18,
    fontWeight: '700',
    color: Echopay.text,
    marginTop: 4,
  },
  recipientMeta: {
    fontSize: 13,
    color: Echopay.textMuted,
    marginTop: 4,
    letterSpacing: 0.6,
  },
  amountChip: {
    marginTop: 14,
    backgroundColor: Echopay.accentSoft,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 999,
  },
  amountChipText: {
    color: Echopay.accentPressed,
    fontSize: 14,
    fontWeight: '700',
  },

  field: { marginBottom: 14 },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: Echopay.text,
    marginBottom: 8,
    letterSpacing: 0.2,
  },
  fieldHint: {
    fontSize: 12,
    color: Echopay.textSubtle,
    marginTop: 8,
    lineHeight: 17,
  },
  amountInputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Echopay.border,
    borderRadius: 14,
    backgroundColor: Echopay.cardBg,
    paddingHorizontal: 18,
  },
  amountPrefix: {
    fontSize: 22,
    color: Echopay.textMuted,
    marginRight: 8,
    fontWeight: '500',
  },
  amountInput: {
    flex: 1,
    paddingVertical: 18,
    fontSize: 22,
    color: Echopay.text,
    fontWeight: '500',
  },

  primaryButton: {
    backgroundColor: Echopay.accent,
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
    marginTop: 18,
  },
  primaryButtonPressed: { backgroundColor: Echopay.accentPressed },
  primaryButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },

  providerBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 14,
    paddingHorizontal: 4,
  },
  providerDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Echopay.success,
    marginRight: 8,
  },
  providerText: {
    flex: 1,
    fontSize: 12,
    color: Echopay.textMuted,
    lineHeight: 17,
  },
  providerBold: { color: Echopay.text, fontWeight: '700' },
});
