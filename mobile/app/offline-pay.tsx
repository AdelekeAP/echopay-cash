// Offline payment — SENDER flow. Master doc §4.2.
//
// 1. Sender picks a recipient + amount.
// 2. Phone requests a permit from the server (while online).
//    Server signs the permit; phone caches it.
// 3. Sender builds a tx and signs it with their ed25519 private key.
// 4. Phone shows {permit, tx, sender_sig} as a QR for the receiver
//    to scan. Sender can also Copy-bundle in dev.
// 5. After the receiver counter-signs and the bundle is complete,
//    either phone POSTs /sync/submit when next online.
//
// For the web demo, the QR can also be exported as text the receiver
// pastes into the offline-scan screen.

import { useEffect, useMemo, useState } from 'react';
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
import QRCode from 'react-native-qrcode-svg';
import { CameraView, useCameraPermissions } from 'expo-camera';

import { useAuth } from '../context/AuthContext';
import { useWallet } from '../hooks/useWallet';
import { Echopay } from '../constants/theme';
import { PERSONAS, Persona, getPersonaById } from '../constants/personas';
import {
  buildTx,
  decodeReceive,
  encodeBundle,
  permitCanonical,
  signCanonicalB64,
  secretKeyBytes,
  OfflineBundle,
} from '../services/crypto';
import {
  getActivePermits,
  issuePermit,
  markPermitUsed,
  PermitError,
  LocalPermit,
} from '../services/permits';
import { formatKoboToNaira, parseNairaToKobo } from '../utils/format';

type Stage = 'scan-receiver' | 'enter-amount' | 'building' | 'show-qr';

export default function OfflinePayScreen() {
  const router = useRouter();
  const { user, token } = useAuth();
  const { lockedBalanceKobo, lockedBalanceNaira, applyLockedDebit } = useWallet();

  const [stage, setStage] = useState<Stage>('scan-receiver');
  const [recipient, setRecipient] = useState<Persona | null>(null);
  const [pastedReceive, setPastedReceive] = useState('');
  const [scanError, setScanError] = useState<string | null>(null);
  const [amountStr, setAmountStr] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [bundle, setBundle] = useState<OfflineBundle | null>(null);
  const [copied, setCopied] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();

  const amountKobo = useMemo(() => {
    try {
      const k = parseNairaToKobo(amountStr || '0');
      return k > 0 ? k : 0;
    } catch {
      return 0;
    }
  }, [amountStr]);

  const me: Persona | undefined = useMemo(
    () => (user ? getPersonaById(user.username ?? '') : undefined),
    [user],
  );

  // Recipients = the other 2 personas
  const candidates = useMemo(
    () => (user ? PERSONAS.filter((p) => p.user.id !== user.id) : []),
    [user],
  );

  const amountValid = amountKobo > 0 && amountKobo <= lockedBalanceKobo;

  // -------------------- handlers

  const acceptReceiver = (r: Persona) => {
    setRecipient(r);
    setScanError(null);
    setPastedReceive('');
    setStage('enter-amount');
  };

  const tryResolveReceive = (raw: string) => {
    setScanError(null);
    const rb = decodeReceive(raw.trim());
    if (!rb) {
      setScanError('Could not read that receive bundle.');
      return;
    }
    if (user && rb.u === user.id) {
      setScanError("That's your own QR — scan the other person's.");
      return;
    }
    // For the demo, recipients must resolve to a known persona on the
    // server. (In production we'd allow any user_id and key on the QR.)
    const p = PERSONAS.find(
      (cand) => cand.user.id === rb.u && cand.ed25519PubKeyB64 === rb.k,
    );
    if (!p) {
      setScanError('Recipient not recognised on this device.');
      return;
    }
    acceptReceiver(p);
  };

  const onScanReceiver = () => tryResolveReceive(pastedReceive);

  const onBuildBundle = async () => {
    if (!user || !me || !recipient) return;
    setError(null);
    setStage('building');
    try {
      // Find a fresh permit big enough, or issue one.
      let permit: LocalPermit | undefined;
      const active = await getActivePermits(user.id);
      permit = active.find((p) => p.max_amount_kobo >= amountKobo);
      if (!permit) {
        permit = await issuePermit({
          userId: user.id,
          maxAmountKobo: amountKobo,
          ttlSeconds: 3600,
          token,
        });
      }

      // Build the tx and sign it with the sender's private key.
      const tx = buildTx({
        permitId: permit.permit_id,
        fromUser: user.id,
        toUser: recipient.user.id,
        amountKobo,
      });
      const senderSig = signCanonicalB64(tx, secretKeyBytes(me.ed25519PrivKeyB64));

      const b: OfflineBundle = {
        permit: {
          permit_id: permit.permit_id,
          user_id: permit.user_id,
          device_fingerprint: permit.device_fingerprint,
          max_amount_kobo: permit.max_amount_kobo,
          issued_at: permit.issued_at,
          expires_at: permit.expires_at,
          server_sig_b64: permit.server_sig_b64,
        },
        tx,
        sender_sig_b64: senderSig,
      };
      setBundle(b);
      await markPermitUsed(user.id, permit.permit_id, 'partially_used');
      // Optimistically debit the offline budget on the sender side. If
      // the receiver never countersigns / never settles, the server's
      // locked_kobo doesn't drop and the permit eventually expires —
      // funds return to the user's locked pot automatically.
      await applyLockedDebit(amountKobo);
      setStage('show-qr');
    } catch (e) {
      if (e instanceof PermitError) setError(e.message);
      else setError('Could not prepare offline payment.');
      setStage('enter-amount');
    }
  };

  const onCopy = async () => {
    if (!bundle) return;
    try {
      const payload = encodeBundle(bundle);
      if (Platform.OS === 'web') {
        const nav = (globalThis as { navigator?: { clipboard?: { writeText: (s: string) => Promise<void> } } }).navigator;
        await nav?.clipboard?.writeText(payload);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  // -------------------- success/QR screen

  if (stage === 'show-qr' && bundle) {
    return (
      <View style={styles.container}>
        <ScrollView contentContainerStyle={styles.scrollContent}>
          <Pressable
            onPress={() => router.replace('/(tabs)')}
            style={({ pressed }) => [styles.back, pressed && styles.backPressed]}
            hitSlop={12}
          >
            <Ionicons name="chevron-back" size={22} color={Echopay.text} />
          </Pressable>

          <Text style={styles.eyebrow}>SHOW THIS QR</Text>
          <Text style={styles.title}>
            {recipient?.display_name} scans this to receive
          </Text>
          <Text style={styles.subtitle}>
            Both phones can be offline. The bundle carries the server's
            permit + your signature; their phone verifies it locally.
          </Text>

          <View style={styles.qrCard}>
            <View style={styles.qrInner}>
              <QRCode
                value={encodeBundle(bundle)}
                size={240}
                color={Echopay.text}
                backgroundColor={Echopay.cardBg}
              />
            </View>
            <Text style={styles.qrAmount}>{formatKoboToNaira(amountKobo)}</Text>
            <Text style={styles.qrCaption}>to {recipient?.display_name}</Text>
          </View>

          <Pressable
            onPress={onCopy}
            style={({ pressed }) => [
              styles.copyButton,
              pressed && styles.copyButtonPressed,
            ]}
          >
            <Ionicons
              name={copied ? 'checkmark' : 'copy-outline'}
              size={16}
              color={Echopay.accent}
            />
            <Text style={styles.copyButtonText}>
              {copied ? 'Copied to clipboard' : 'Copy bundle (for web demo)'}
            </Text>
          </Pressable>

          <Text style={styles.bundleLabel}>Signed payment bundle</Text>
          <TextInput
            style={styles.bundleText}
            value={encodeBundle(bundle)}
            editable={false}
            multiline
            nativeID="payment-bundle"
          />


          <View style={styles.note}>
            <Ionicons
              name="shield-checkmark-outline"
              size={16}
              color={Echopay.textMuted}
            />
            <Text style={styles.noteText}>
              Funds move on the server only after {recipient?.display_name}{' '}
              counter-signs and either phone reconnects. Replay = rejected
              (nonce uniqueness); double-spend = rejected (atomic permit
              redemption).
            </Text>
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
        </ScrollView>
      </View>
    );
  }

  if (stage === 'building') {
    return (
      <View style={styles.fullScreen}>
        <ActivityIndicator size="large" color={Echopay.accent} />
        <Text style={styles.fullScreenTitle}>Preparing offline payment…</Text>
        <Text style={styles.fullScreenSub}>
          Requesting a signed permit · signing the tx with your key
        </Text>
      </View>
    );
  }

  // -------------------- camera overlay

  if (cameraOpen) {
    return (
      <View style={styles.cameraWrap}>
        <CameraView
          style={StyleSheet.absoluteFillObject}
          facing="back"
          onBarcodeScanned={(result) => {
            if (!result?.data) return;
            setCameraOpen(false);
            setPastedReceive(result.data);
            tryResolveReceive(result.data);
          }}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        />
        <View style={styles.cameraOverlay} pointerEvents="none">
          <View style={styles.cameraFrame} />
          <Text style={styles.cameraHint}>
            Align the receiver's QR inside the frame
          </Text>
        </View>
        <Pressable
          onPress={() => setCameraOpen(false)}
          style={styles.cameraCancel}
          hitSlop={12}
        >
          <Text style={styles.cameraCancelText}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  // -------------------- main shell

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.container}
    >
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <Pressable
          onPress={() => {
            if (stage !== 'scan-receiver') {
              setStage('scan-receiver');
              return;
            }
            if (router.canGoBack()) router.back();
            else router.replace('/(tabs)');
          }}
          style={({ pressed }) => [styles.back, pressed && styles.backPressed]}
          hitSlop={12}
        >
          <Ionicons name="chevron-back" size={22} color={Echopay.text} />
        </Pressable>

        <Text style={styles.eyebrow}>OFFLINE PAY</Text>
        <Text style={styles.title}>
          {stage === 'scan-receiver' ? 'Who are you paying?' : 'How much?'}
        </Text>
        {stage === 'scan-receiver' && (
          <Text style={styles.subtitle}>
            Ask the person you're paying to show their receive QR. Scan it
            (or paste the bundle for the web demo). Both phones can stay
            offline — funds settle when either reconnects.
          </Text>
        )}

        {stage === 'scan-receiver' && (
          <>
            {Platform.OS !== 'web' && (
              <Pressable
                onPress={async () => {
                  if (!permission?.granted) {
                    const r = await requestPermission();
                    if (!r.granted) return;
                  }
                  setCameraOpen(true);
                  setScanError(null);
                }}
                style={({ pressed }) => [
                  styles.cameraOpenButton,
                  pressed && styles.cameraOpenButtonPressed,
                ]}
              >
                <Ionicons name="qr-code-outline" size={18} color="#fff" />
                <Text style={styles.cameraOpenButtonText}>
                  Scan their QR
                </Text>
              </Pressable>
            )}

            <View style={styles.scanCard}>
              <Text style={styles.scanLabel}>
                Paste receive bundle{' '}
                <Text style={styles.scanLabelMuted}>(fallback)</Text>
              </Text>
              <TextInput
                style={styles.scanInput}
                value={pastedReceive}
                onChangeText={setPastedReceive}
                multiline
                placeholder='{"u":2,"n":"Iya Tope","k":"…"}'
                placeholderTextColor={Echopay.textSubtle}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>

            {scanError && (
              <Text style={styles.errorText}>{scanError}</Text>
            )}

            <Pressable
              onPress={onScanReceiver}
              disabled={!pastedReceive.trim()}
              style={({ pressed }) => [
                styles.primaryButton,
                !pastedReceive.trim() && styles.primaryButtonDisabled,
                pressed &&
                  pastedReceive.trim() &&
                  styles.primaryButtonPressed,
              ]}
            >
              <Text style={styles.primaryButtonText}>Use this recipient</Text>
            </Pressable>

            <Pressable
              onPress={() => router.push('/offline-receive')}
              style={({ pressed }) => [
                styles.linkRow,
                pressed && { opacity: 0.6 },
              ]}
              hitSlop={8}
            >
              <Ionicons
                name="qr-code-outline"
                size={16}
                color={Echopay.accent}
              />
              <Text style={styles.linkRowText}>
                Show my own receive QR instead
              </Text>
            </Pressable>

            <Text style={styles.divider}>Or quick-pick a demo contact</Text>

            <View style={styles.contactList}>
              {candidates.map((p, i) => (
                <Pressable
                  key={p.id}
                  onPress={() => acceptReceiver(p)}
                  style={({ pressed }) => [
                    styles.contactRow,
                    i !== candidates.length - 1 && styles.contactDivider,
                    pressed && { opacity: 0.55 },
                  ]}
                >
                  <View style={styles.avatar}>
                    <Text style={styles.avatarText}>{p.initials}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.contactName}>{p.display_name}</Text>
                    <Text style={styles.contactMeta}>{p.role}</Text>
                  </View>
                </Pressable>
              ))}
            </View>
          </>
        )}

        {stage === 'enter-amount' && recipient && (
          <>
            <View style={styles.toCard}>
              <View style={styles.avatarSmall}>
                <Text style={styles.avatarText}>{recipient.initials}</Text>
              </View>
              <View>
                <Text style={styles.toLabel}>TO</Text>
                <Text style={styles.toName}>{recipient.display_name}</Text>
              </View>
            </View>

            <View style={styles.amountCard}>
              <Text style={styles.amountFieldLabel}>
                Amount from your{' '}
                <Text style={styles.amountFieldLabelBold}>offline budget</Text>
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
                <Text style={styles.capHintBold}>{lockedBalanceNaira}</Text>{' '}
                available
              </Text>
            </View>

            {amountKobo > lockedBalanceKobo && (
              <Text style={styles.errorText}>
                That's more than your offline budget. Lock more funds first.
              </Text>
            )}
            {error && <Text style={styles.errorText}>{error}</Text>}

            <Pressable
              onPress={onBuildBundle}
              disabled={!amountValid}
              style={({ pressed }) => [
                styles.primaryButton,
                !amountValid && styles.primaryButtonDisabled,
                pressed && amountValid && styles.primaryButtonPressed,
              ]}
            >
              <View style={styles.primaryButtonInner}>
                <Ionicons name="qr-code-outline" size={18} color="#fff" />
                <Text style={styles.primaryButtonText}>
                  Generate signed QR
                </Text>
              </View>
            </Pressable>
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// -------------------- styles

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Echopay.pageBg },
  scrollContent: { padding: 22, paddingTop: 14, paddingBottom: 50 },

  back: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: -10,
    marginBottom: 14,
  },
  backPressed: {
    backgroundColor: Echopay.cardSoft,
  },

  eyebrow: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.6,
    color: Echopay.textSubtle,
    marginBottom: 8,
  },
  title: {
    fontSize: 26,
    fontWeight: '700',
    color: Echopay.text,
    letterSpacing: -0.4,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: Echopay.textMuted,
    lineHeight: 20,
    marginBottom: 22,
  },

  // scan-receiver stage
  scanCard: {
    backgroundColor: Echopay.cardBg,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Echopay.border,
    padding: 14,
    marginBottom: 12,
  },
  scanLabel: { fontSize: 13, color: Echopay.text, fontWeight: '600' },
  scanLabelMuted: { color: Echopay.textMuted, fontWeight: '400' },
  scanInput: {
    marginTop: 10,
    minHeight: 80,
    padding: 12,
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    color: Echopay.text,
    backgroundColor: Echopay.cardSoft,
    borderRadius: 10,
    textAlignVertical: 'top',
  },

  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 14,
    marginTop: 6,
  },
  linkRowText: {
    color: Echopay.accent,
    fontSize: 14,
    fontWeight: '600',
  },

  divider: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1.2,
    color: Echopay.textSubtle,
    textAlign: 'center',
    marginTop: 18,
    marginBottom: 6,
  },

  contactList: { marginTop: 4 },
  contactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 14,
  },
  contactDivider: {
    borderBottomWidth: 1,
    borderBottomColor: Echopay.border,
  },
  contactName: {
    fontSize: 15,
    color: Echopay.text,
    fontWeight: '500',
  },
  contactMeta: {
    fontSize: 12,
    color: Echopay.textMuted,
    marginTop: 2,
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

  // to-card on amount stage
  toCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderRadius: 14,
    backgroundColor: Echopay.cardBg,
    borderWidth: 1,
    borderColor: Echopay.border,
    gap: 12,
    marginBottom: 18,
  },
  toLabel: {
    fontSize: 11,
    color: Echopay.textSubtle,
    fontWeight: '600',
    letterSpacing: 0.6,
  },
  toName: { fontSize: 16, color: Echopay.text, fontWeight: '700' },

  // amount card
  amountCard: {
    backgroundColor: Echopay.cardBg,
    borderWidth: 1,
    borderColor: Echopay.border,
    borderRadius: 16,
    padding: 18,
    marginBottom: 14,
  },
  amountFieldLabel: {
    fontSize: 13,
    color: Echopay.textMuted,
    marginBottom: 12,
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
    fontSize: 38,
    color: Echopay.textMuted,
    fontWeight: '300',
    marginRight: 6,
  },
  amountInput: {
    flex: 1,
    fontSize: 42,
    paddingVertical: 8,
    color: Echopay.text,
    fontWeight: '300',
    letterSpacing: -1,
  },
  capHint: {
    fontSize: 12,
    color: Echopay.textMuted,
    marginTop: 10,
  },
  capHintBold: { color: Echopay.text, fontWeight: '600' },

  errorText: {
    color: Echopay.danger,
    fontSize: 13,
    marginBottom: 10,
    fontWeight: '500',
  },

  // QR result screen
  qrCard: {
    alignItems: 'center',
    paddingVertical: 24,
    paddingHorizontal: 18,
    borderRadius: 18,
    backgroundColor: Echopay.cardBg,
    borderWidth: 1,
    borderColor: Echopay.border,
    marginBottom: 16,
  },
  qrInner: {
    padding: 14,
    borderRadius: 12,
    backgroundColor: Echopay.cardBg,
    borderWidth: 1,
    borderColor: Echopay.border,
  },
  qrAmount: {
    marginTop: 16,
    fontSize: 30,
    fontWeight: '800',
    color: Echopay.text,
    letterSpacing: -0.6,
  },
  qrCaption: { fontSize: 14, color: Echopay.textMuted, marginTop: 4 },

  // copy button
  copyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Echopay.border,
    backgroundColor: Echopay.cardBg,
    marginBottom: 16,
  },
  copyButtonPressed: { backgroundColor: Echopay.cardSoft },
  copyButtonText: {
    color: Echopay.accent,
    fontSize: 13,
    fontWeight: '600',
  },

  bundleLabel: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1.2,
    color: Echopay.textSubtle,
    marginBottom: 6,
    marginTop: 6,
  },
  bundleText: {
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    color: Echopay.text,
    backgroundColor: Echopay.cardSoft,
    borderRadius: 10,
    padding: 10,
    minHeight: 70,
    textAlignVertical: 'top',
    marginBottom: 14,
  },

  // note
  note: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    padding: 14,
    borderRadius: 12,
    backgroundColor: Echopay.cardSoft,
    marginBottom: 18,
  },
  noteText: {
    flex: 1,
    fontSize: 12,
    color: Echopay.textMuted,
    lineHeight: 18,
  },

  // primary CTA
  // camera flow
  cameraOpenButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Echopay.accent,
    paddingVertical: 16,
    borderRadius: 14,
    marginBottom: 12,
  },
  cameraOpenButtonPressed: { backgroundColor: Echopay.accentPressed },
  cameraOpenButtonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  cameraWrap: { flex: 1, backgroundColor: '#000' },
  cameraOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cameraFrame: {
    width: 260,
    height: 260,
    borderRadius: 18,
    borderWidth: 3,
    borderColor: Echopay.accent,
  },
  cameraHint: {
    marginTop: 16,
    color: '#fff',
    fontSize: 14,
    fontWeight: '500',
    textShadowColor: '#000',
    textShadowRadius: 4,
  },
  cameraCancel: {
    position: 'absolute',
    top: 60,
    left: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  cameraCancelText: { color: '#fff', fontSize: 14, fontWeight: '600' },

  primaryButton: {
    backgroundColor: Echopay.accent,
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  primaryButtonInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  primaryButtonDisabled: { backgroundColor: Echopay.accentMuted },
  primaryButtonPressed: { backgroundColor: Echopay.accentPressed },
  primaryButtonText: { color: '#fff', fontSize: 15, fontWeight: '600' },

  // building state
  fullScreen: {
    flex: 1,
    backgroundColor: Echopay.pageBg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 14,
  },
  fullScreenTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: Echopay.text,
    marginTop: 8,
  },
  fullScreenSub: {
    fontSize: 13,
    color: Echopay.textMuted,
    textAlign: 'center',
    maxWidth: 280,
  },
});
