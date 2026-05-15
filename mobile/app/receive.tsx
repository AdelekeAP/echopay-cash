// Receive screen — PRD §1 Script A 2:00 demo beat.
//
// Mama generates a ₦200 QR. Customer pays from any bank. Mama's phone
// receives. The QR encodes the bare 10-digit Squad Dynamic VA number so
// scanners across Nigerian bank apps can interpret it as a manual
// transfer destination.
//
// Backend lives at POST /dynamic-va/create (PR #15). When the SQUAD key
// is missing the backend round-robins a synthetic 9xxx number from the
// demo pool, and the screen renders that exactly the same — full demo
// path works offline-from-Squad.
//
// State machine: idle → generating → ready (or error).
// "Generate new amount" (in ready) clears the input and returns to idle
// — same-amount-within-TTL hits backend idempotency and returns the same
// DVA, which would otherwise read as "nothing happened" on tap.
// A 401 from the backend auto-redirects to /voice-signup?reason=session_expired
// — never shown as an inline error mid-demo.

import { useCallback, useMemo, useRef, useState } from 'react';
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
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import QRCode from 'react-native-qrcode-svg';

import { Echopay } from '../constants/theme';
import { useAuth } from '../context/AuthContext';
import { formatKoboToNaira, parseNairaToKobo } from '../utils/format';
import {
  BackendError,
  CreateDynamicVaResponse,
  createDynamicVa,
} from '../services/squad-api';

type Stage = 'idle' | 'generating' | 'ready' | 'error';

type ErrorKind =
  | 'invalid_amount'
  | 'squad_failed'
  | 'network'
  | 'unknown';

export default function ReceiveScreen() {
  const router = useRouter();
  const { user, account, token } = useAuth();

  const [stage, setStage] = useState<Stage>('idle');
  const [amountInput, setAmountInput] = useState('');
  const [response, setResponse] = useState<CreateDynamicVaResponse | null>(null);
  const [errorKind, setErrorKind] = useState<ErrorKind | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const amountInputRef = useRef<TextInput | null>(null);

  const amountKobo = useMemo(() => {
    if (!amountInput.trim()) return 0;
    try {
      return parseNairaToKobo(amountInput);
    } catch {
      return 0;
    }
  }, [amountInput]);

  const recipientName =
    user?.first_name && user?.last_name
      ? `${user.first_name} ${user.last_name}`
      : user?.first_name ?? 'EchoPay user';
  const bankName = account?.bank?.name ?? 'GTBank';

  const amountDisplay = amountKobo > 0 ? formatKoboToNaira(amountKobo) : null;
  const canGenerate = amountKobo > 0 && stage === 'idle';

  // --- handlers ---

  const handleGenerate = useCallback(async () => {
    if (amountKobo <= 0) return;
    setStage('generating');
    setResponse(null);
    setErrorKind(null);
    setErrorMessage(null);

    try {
      const data = await createDynamicVa(amountKobo, 300, token);
      setResponse(data);
      setStage('ready');
    } catch (e) {
      // Adjustment A2: 401 auto-redirects, not inline.
      if (e instanceof BackendError && (e.code === 'auth_required' || e.code === 'invalid_token')) {
        router.replace('/voice-signup?reason=session_expired');
        return;
      }
      setErrorKind(mapErrorToKind(e));
      setErrorMessage(e instanceof Error ? e.message : 'Something went wrong.');
      setStage('error');
    }
  }, [amountKobo, token, router]);

  // Adjustment A3: clear input + return focus on "Generate new amount"
  const handleGenerateNew = useCallback(() => {
    setAmountInput('');
    setResponse(null);
    setStage('idle');
    setErrorKind(null);
    setErrorMessage(null);
    // small delay so the input is rendered before focusing
    setTimeout(() => amountInputRef.current?.focus(), 50);
  }, []);

  const handleRetry = useCallback(() => {
    setStage('idle');
    setErrorKind(null);
    setErrorMessage(null);
  }, []);

  // --- subviews ---

  const renderQrCard = () => {
    if (stage === 'ready' && response) {
      // Render the BARE 10-digit Squad DVA number in the QR so any
      // Nigerian bank app reads it as a manual-transfer entry. The
      // structured qr_payload is reserved for EchoPay-aware scanners.
      return (
        <View style={styles.qrCard}>
          <View style={styles.qrFrame}>
            <QRCode
              value={response.dva_number}
              size={200}
              color={Echopay.text}
              backgroundColor={Echopay.cardBg}
              ecl="Q"
            />
          </View>
          <Text style={styles.recipientName}>{recipientName}</Text>
          <Text style={styles.recipientMeta}>
            {bankName} ·{' '}
            {response.dva_number.replace(/(\d{4})(\d{3})(\d{3})/, '$1 $2 $3')}
          </Text>
          <View style={styles.amountChip}>
            <Text style={styles.amountChipText}>
              {formatKoboToNaira(response.amount_kobo)}
            </Text>
          </View>
          {response.demo_mode && (
            <View style={styles.demoBadge}>
              <Text style={styles.demoBadgeText}>DEMO MODE</Text>
            </View>
          )}
        </View>
      );
    }

    if (stage === 'generating') {
      return (
        <View style={styles.qrCard}>
          <View style={[styles.qrFrame, styles.qrPlaceholder]}>
            <ActivityIndicator size="large" color={Echopay.accent} />
          </View>
          <Text style={styles.recipientName}>Talking to Squad…</Text>
          <Text style={styles.recipientMeta}>
            Generating a fresh QR for {amountDisplay ?? 'your amount'}.
          </Text>
        </View>
      );
    }

    // idle / error — render a soft placeholder so the layout doesn't jump
    return (
      <View style={styles.qrCard}>
        <View style={[styles.qrFrame, styles.qrPlaceholder]}>
          <Ionicons name="qr-code-outline" size={80} color={Echopay.textSubtle} />
        </View>
        <Text style={styles.recipientName}>{recipientName}</Text>
        <Text style={styles.recipientMeta}>
          {bankName} · type an amount, then tap Generate
        </Text>
      </View>
    );
  };

  const renderError = () => {
    if (stage !== 'error') return null;
    const copy = errorCopy(errorKind, errorMessage);
    return (
      <View style={styles.errorCard}>
        <Ionicons name="alert-circle-outline" size={20} color={Echopay.danger} />
        <View style={{ flex: 1 }}>
          <Text style={styles.errorTitle}>{copy.title}</Text>
          <Text style={styles.errorBody}>{copy.body}</Text>
        </View>
        <Pressable onPress={handleRetry} style={styles.errorRetry} hitSlop={8}>
          <Text style={styles.errorRetryText}>Retry</Text>
        </Pressable>
      </View>
    );
  };

  const renderCta = () => {
    if (stage === 'ready') {
      return (
        <Pressable
          onPress={handleGenerateNew}
          style={({ pressed }) => [
            styles.secondaryButton,
            pressed && styles.secondaryButtonPressed,
          ]}
        >
          <Text style={styles.secondaryButtonText}>Generate new amount</Text>
        </Pressable>
      );
    }
    return (
      <Pressable
        onPress={handleGenerate}
        disabled={!canGenerate}
        style={({ pressed }) => [
          styles.primaryButton,
          !canGenerate && styles.primaryButtonDisabled,
          pressed && canGenerate && styles.primaryButtonPressed,
        ]}
      >
        {stage === 'generating' ? (
          <ActivityIndicator color={Echopay.cardBg} />
        ) : (
          <Text style={styles.primaryButtonText}>Generate QR</Text>
        )}
      </Pressable>
    );
  };

  // --- render ---

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

        {renderQrCard()}

        <View style={styles.field}>
          <Text style={styles.fieldLabel}>How much?</Text>
          <View style={styles.amountInputWrap}>
            <Text style={styles.amountPrefix}>₦</Text>
            <TextInput
              ref={amountInputRef}
              style={styles.amountInput}
              value={amountInput}
              onChangeText={(t) => setAmountInput(t.replace(/[^0-9.,]/g, ''))}
              keyboardType="decimal-pad"
              placeholder="0"
              placeholderTextColor={Echopay.textSubtle}
              editable={stage === 'idle' || stage === 'error'}
            />
          </View>
          <Text style={styles.fieldHint}>
            Type an amount, tap Generate. Same amount within 5 minutes
            returns the same QR (idempotent).
          </Text>
        </View>

        {renderError()}

        {renderCta()}

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

// --------------------------------------------------------------- helpers

function mapErrorToKind(e: unknown): ErrorKind {
  if (e instanceof BackendError) {
    switch (e.code) {
      case 'invalid_amount':
        return 'invalid_amount';
      case 'squad_failed':
        return 'squad_failed';
      case 'network':
        return 'network';
      default:
        return 'unknown';
    }
  }
  return 'unknown';
}

function errorCopy(
  kind: ErrorKind | null,
  fallback: string | null,
): { title: string; body: string } {
  switch (kind) {
    case 'invalid_amount':
      return {
        title: 'Invalid amount',
        body: 'Enter an amount above ₦0.',
      };
    case 'squad_failed':
      return {
        title: 'Squad is busy',
        body: 'Couldn’t open a QR account. Try again.',
      };
    case 'network':
      return {
        title: 'Connection problem',
        body: 'Check your network and try again.',
      };
    default:
      return {
        title: 'Something went wrong',
        body: fallback ?? 'Try again, or come back later.',
      };
  }
}

// --------------------------------------------------------------- styles

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
  qrPlaceholder: {
    width: 228,
    height: 228,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Echopay.cardSoft,
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
    textAlign: 'center',
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
  demoBadge: {
    marginTop: 10,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: Echopay.cardSoft,
  },
  demoBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
    color: Echopay.textMuted,
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

  errorCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    backgroundColor: Echopay.dangerSoft,
    borderWidth: 1,
    borderColor: Echopay.danger,
    borderRadius: 12,
    padding: 12,
    marginTop: 10,
    marginBottom: 4,
  },
  errorTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: Echopay.danger,
  },
  errorBody: {
    fontSize: 12,
    color: Echopay.text,
    marginTop: 2,
    lineHeight: 17,
  },
  errorRetry: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 999,
    backgroundColor: Echopay.cardBg,
  },
  errorRetryText: {
    fontSize: 12,
    fontWeight: '700',
    color: Echopay.danger,
  },

  primaryButton: {
    backgroundColor: Echopay.accent,
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
    marginTop: 18,
  },
  primaryButtonPressed: { backgroundColor: Echopay.accentPressed },
  primaryButtonDisabled: { backgroundColor: Echopay.accentMuted },
  primaryButtonText: { color: Echopay.cardBg, fontSize: 16, fontWeight: '600' },

  secondaryButton: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: Echopay.accent,
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
    marginTop: 18,
  },
  secondaryButtonPressed: { backgroundColor: Echopay.accentSoft },
  secondaryButtonText: {
    color: Echopay.accent,
    fontSize: 15,
    fontWeight: '600',
  },

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
