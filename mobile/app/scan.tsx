// Scan-to-pay — PRD §1 Script A 2:00 demo beat.
//
// Phone B opens this screen, points camera at Phone A's QR (a bare
// 10-digit Squad DVA number rendered by receive.tsx), confirms the
// recipient + amount, and fires POST /transfer/in-network.
//
// State machine:
//   idle → scanning → resolving → confirm → paying → success
//                                      ↘ error (with retry + paste fallback)
//
// Web fallback: expo-camera doesn't work in Expo Go web preview, so the
// idle stage short-circuits to a paste-textarea flow. Same downstream
// states after resolve. Preserves desktop-demo capability.
//
// Permission denied: defensive UX — no infinite re-prompt loop. Static
// "Open Settings" guidance + paste fallback box.
//
// Idempotency: idempotency_key is generated once when entering the
// confirm stage via useMemo([vaNumber, amountKobo]). Re-tapping Pay
// during a slow network won't double-charge.

import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Echopay } from '../constants/theme';
import { useAuth } from '../context/AuthContext';
import {
  BackendError,
  ResolveDvaResponse,
  payByDVA,
  resolveDVA,
} from '../services/squad-api';
import { formatKoboToNaira, parseNairaToKobo } from '../utils/format';

type Stage =
  | 'idle'
  | 'scanning'
  | 'resolving'
  | 'confirm'
  | 'paying'
  | 'success'
  | 'error';

// echopay:dva:<10-digit-va>:<amount-kobo>:<tx-id>  (reserved structured form)
const ECHOPAY_QR_RE = /^echopay:dva:(\d{10}):(\d+):/;

function parseQR(raw: string): { vaNumber: string; amountKobo?: number } | null {
  const trimmed = raw.trim();
  // Form 1: structured echopay payload (future-compat)
  const m = ECHOPAY_QR_RE.exec(trimmed);
  if (m) {
    return { vaNumber: m[1], amountKobo: parseInt(m[2], 10) };
  }
  // Form 2: bare 10-digit DVA number (current receive.tsx output)
  if (/^\d{10}$/.test(trimmed)) {
    return { vaNumber: trimmed };
  }
  return null;
}

export default function ScanScreen() {
  const router = useRouter();
  const { user, token } = useAuth();
  const params = useLocalSearchParams<{ va_number?: string }>();
  const [permission, requestPermission] = useCameraPermissions();

  const [stage, setStage] = useState<Stage>('idle');
  const [vaNumber, setVaNumber] = useState<string>(params.va_number ?? '');
  const [pasteInput, setPasteInput] = useState('');
  const [recipient, setRecipient] = useState<ResolveDvaResponse | null>(null);
  const [amountInput, setAmountInput] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  const amountKobo = useMemo(() => {
    if (!amountInput.trim()) return 0;
    try {
      return parseNairaToKobo(amountInput);
    } catch {
      return 0;
    }
  }, [amountInput]);

  // Generate idempotency key once per (vaNumber, amountKobo) pair so
  // re-tapping Pay returns the original tx instead of creating a new one.
  const idempotencyKey = useMemo(() => {
    if (!vaNumber) return '';
    return `scan_${vaNumber}_${amountKobo}_${Date.now()}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaNumber, amountKobo]);

  const handleResolve = useCallback(
    async (va: string, presetAmountKobo?: number) => {
      setStage('resolving');
      setVaNumber(va);
      try {
        const data = await resolveDVA(va, token);
        setRecipient(data);
        if (presetAmountKobo) {
          setAmountInput((presetAmountKobo / 100).toString());
        }
        setStage('confirm');
      } catch (e) {
        const msg =
          e instanceof BackendError && e.code === 'VA_NOT_FOUND'
            ? "QR not recognized — that's not an EchoPay account."
            : e instanceof BackendError
              ? e.message
              : 'Network error. Try again.';
        setErrorMessage(msg);
        setStage('error');
      }
    },
    [token],
  );

  const handleBarcodeScanned = useCallback(
    (result: { data: string }) => {
      if (stage !== 'scanning') return; // suppress duplicate scans
      const parsed = parseQR(result.data);
      if (!parsed) {
        setErrorMessage('QR not recognized. Point at an EchoPay payment QR.');
        setStage('error');
        return;
      }
      handleResolve(parsed.vaNumber, parsed.amountKobo);
    },
    [stage, handleResolve],
  );

  const handlePastePay = useCallback(() => {
    const parsed = parseQR(pasteInput);
    if (!parsed) {
      setErrorMessage('Paste a 10-digit account number or echopay: payload.');
      setStage('error');
      return;
    }
    handleResolve(parsed.vaNumber, parsed.amountKobo);
  }, [pasteInput, handleResolve]);

  const handlePay = useCallback(async () => {
    if (!user?.id || !recipient || !vaNumber || amountKobo <= 0) return;
    setStage('paying');
    try {
      await payByDVA(vaNumber, amountKobo, user.id, token, idempotencyKey);
      setStage('success');
    } catch (e) {
      const msg =
        e instanceof BackendError
          ? e.message
          : 'Transfer failed. Try again.';
      setErrorMessage(msg);
      setStage('error');
    }
  }, [user?.id, recipient, vaNumber, amountKobo, token, idempotencyKey]);

  const handleReset = useCallback(() => {
    setStage('idle');
    setVaNumber('');
    setPasteInput('');
    setRecipient(null);
    setAmountInput('');
    setErrorMessage('');
  }, []);

  // expo-camera not available in Expo Go web; offer paste path.
  const isWeb = Platform.OS === 'web';

  return (
    <View style={styles.container}>
      <Pressable
        onPress={() => router.back()}
        style={styles.backRow}
        hitSlop={12}
      >
        <Text style={styles.backText}>← Back</Text>
      </Pressable>

      {stage === 'idle' && (
        <View style={styles.body}>
          <View style={styles.iconCard}>
            <Ionicons name="qr-code-outline" size={44} color={Echopay.accent} />
          </View>
          <Text style={styles.title}>Scan QR to pay</Text>
          <Text style={styles.subtitle}>
            {isWeb
              ? "Camera isn't available in web preview. Paste a 10-digit account number below."
              : 'Point at any EchoPay payment QR.'}
          </Text>

          {!isWeb && (
            <Pressable
              onPress={async () => {
                if (!permission?.granted) {
                  const r = await requestPermission();
                  if (!r.granted) {
                    setErrorMessage(
                      'Camera permission denied. Enable it in Settings to scan QR codes.',
                    );
                    setStage('error');
                    return;
                  }
                }
                setStage('scanning');
              }}
              style={styles.primaryBtn}
            >
              <Text style={styles.primaryBtnText}>Open camera</Text>
            </Pressable>
          )}

          <View style={styles.pasteWrap}>
            <Text style={styles.pasteLabel}>Or paste account number</Text>
            <TextInput
              value={pasteInput}
              onChangeText={setPasteInput}
              placeholder="0123456789"
              placeholderTextColor={Echopay.textSubtle}
              keyboardType="number-pad"
              style={styles.pasteInput}
              maxLength={64}
            />
            <Pressable
              onPress={handlePastePay}
              disabled={pasteInput.length < 10}
              style={[
                styles.secondaryBtn,
                pasteInput.length < 10 && styles.btnDisabled,
              ]}
            >
              <Text style={styles.secondaryBtnText}>Continue</Text>
            </Pressable>
          </View>
        </View>
      )}

      {stage === 'scanning' && !isWeb && (
        <View style={styles.cameraWrap}>
          <CameraView
            style={StyleSheet.absoluteFillObject}
            facing="back"
            onBarcodeScanned={handleBarcodeScanned}
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          />
          <View style={styles.cameraOverlay} pointerEvents="none">
            <View style={styles.cameraFrame} />
            <Text style={styles.cameraHint}>Align the QR within the frame</Text>
          </View>
          <Pressable
            onPress={handleReset}
            style={styles.cameraCancel}
            hitSlop={12}
          >
            <Text style={styles.cameraCancelText}>Cancel</Text>
          </Pressable>
        </View>
      )}

      {stage === 'resolving' && (
        <View style={styles.body}>
          <ActivityIndicator size="large" color={Echopay.accent} />
          <Text style={styles.title}>Looking up recipient…</Text>
        </View>
      )}

      {stage === 'confirm' && recipient && (
        <View style={styles.body}>
          <View style={styles.iconCard}>
            <Ionicons
              name="person-circle-outline"
              size={44}
              color={Echopay.accent}
            />
          </View>
          <Text style={styles.title}>{recipient.recipient_display_name}</Text>
          <Text style={styles.subtitle}>EchoPay account {vaNumber}</Text>

          <View style={styles.amountRow}>
            <Text style={styles.amountLabel}>Amount</Text>
            <TextInput
              value={amountInput}
              onChangeText={setAmountInput}
              placeholder="0"
              placeholderTextColor={Echopay.textSubtle}
              keyboardType="number-pad"
              style={styles.amountInput}
            />
            <Text style={styles.amountSuffix}>NGN</Text>
          </View>

          <Pressable
            onPress={handlePay}
            disabled={amountKobo <= 0}
            style={[styles.primaryBtn, amountKobo <= 0 && styles.btnDisabled]}
          >
            <Text style={styles.primaryBtnText}>
              Pay {amountKobo > 0 ? formatKoboToNaira(amountKobo) : ''}
            </Text>
          </Pressable>
          <Pressable onPress={handleReset} style={styles.tertiaryBtn}>
            <Text style={styles.tertiaryBtnText}>Cancel</Text>
          </Pressable>
        </View>
      )}

      {stage === 'paying' && (
        <View style={styles.body}>
          <ActivityIndicator size="large" color={Echopay.accent} />
          <Text style={styles.title}>Sending…</Text>
        </View>
      )}

      {stage === 'success' && recipient && (
        <View style={styles.body}>
          <View style={[styles.iconCard, styles.iconCardSuccess]}>
            <Ionicons name="checkmark-circle" size={56} color={Echopay.success} />
          </View>
          <Text style={styles.title}>
            Paid {formatKoboToNaira(amountKobo)}
          </Text>
          <Text style={styles.subtitle}>
            to {recipient.recipient_display_name}
          </Text>
          <Pressable
            onPress={() => router.replace('/')}
            style={styles.primaryBtn}
          >
            <Text style={styles.primaryBtnText}>Done</Text>
          </Pressable>
        </View>
      )}

      {stage === 'error' && (
        <View style={styles.body}>
          <View style={[styles.iconCard, styles.iconCardError]}>
            <Ionicons name="alert-circle" size={44} color={Echopay.danger} />
          </View>
          <Text style={styles.title}>Couldn&apos;t complete that</Text>
          <Text style={styles.subtitle}>{errorMessage}</Text>
          <Pressable onPress={handleReset} style={styles.primaryBtn}>
            <Text style={styles.primaryBtnText}>Try again</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Echopay.pageBg,
    padding: 24,
  },
  backRow: { marginTop: 8, marginBottom: 14 },
  backText: { fontSize: 15, color: Echopay.accent, fontWeight: '500' },

  body: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
  },
  iconCard: {
    width: 120,
    height: 120,
    borderRadius: 24,
    backgroundColor: Echopay.cardBg,
    borderWidth: 1,
    borderColor: Echopay.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  iconCardSuccess: { borderColor: Echopay.success },
  iconCardError: { borderColor: Echopay.danger },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: Echopay.text,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 14,
    color: Echopay.textMuted,
    textAlign: 'center',
    maxWidth: 320,
    lineHeight: 21,
  },

  primaryBtn: {
    marginTop: 12,
    backgroundColor: Echopay.accent,
    paddingVertical: 14,
    paddingHorizontal: 32,
    borderRadius: 12,
    minWidth: 200,
    alignItems: 'center',
  },
  primaryBtnText: {
    color: Echopay.pageBg,
    fontWeight: '700',
    fontSize: 16,
  },
  secondaryBtn: {
    marginTop: 8,
    backgroundColor: Echopay.cardBg,
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Echopay.border,
    alignItems: 'center',
  },
  secondaryBtnText: { color: Echopay.accent, fontWeight: '600' },
  tertiaryBtn: { paddingVertical: 8 },
  tertiaryBtnText: { color: Echopay.textMuted, fontSize: 14 },
  btnDisabled: { opacity: 0.4 },

  pasteWrap: {
    marginTop: 28,
    width: '100%',
    alignItems: 'center',
    gap: 8,
  },
  pasteLabel: {
    fontSize: 13,
    color: Echopay.textMuted,
  },
  pasteInput: {
    width: '100%',
    maxWidth: 320,
    backgroundColor: Echopay.cardBg,
    borderWidth: 1,
    borderColor: Echopay.border,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 18,
    color: Echopay.text,
    textAlign: 'center',
  },

  amountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    width: '100%',
    maxWidth: 320,
    backgroundColor: Echopay.cardBg,
    borderWidth: 1,
    borderColor: Echopay.border,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginTop: 16,
  },
  amountLabel: {
    fontSize: 14,
    color: Echopay.textMuted,
    fontWeight: '600',
  },
  amountInput: {
    flex: 1,
    fontSize: 22,
    fontWeight: '700',
    color: Echopay.text,
    textAlign: 'right',
  },
  amountSuffix: {
    fontSize: 13,
    color: Echopay.textSubtle,
  },

  cameraWrap: {
    flex: 1,
    backgroundColor: '#000',
    borderRadius: 16,
    overflow: 'hidden',
    marginTop: -8,
  },
  cameraOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cameraFrame: {
    width: 240,
    height: 240,
    borderWidth: 3,
    borderColor: Echopay.accent,
    borderRadius: 16,
  },
  cameraHint: {
    marginTop: 18,
    color: '#FFFFFF',
    fontSize: 14,
  },
  cameraCancel: {
    position: 'absolute',
    bottom: 24,
    alignSelf: 'center',
    backgroundColor: Echopay.cardBg,
    paddingVertical: 10,
    paddingHorizontal: 24,
    borderRadius: 999,
  },
  cameraCancelText: { color: Echopay.text, fontWeight: '600' },
});
