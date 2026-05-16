// Offline payment — RECEIVER flow. Master doc §4.2.
//
// 1. Receiver scans (phone) or pastes (web) the sender's QR bundle.
// 2. Phone verifies all three signature properties locally:
//      - server signed the permit
//      - sender signed the tx with their published pubkey
//      - permit hasn't expired and amount ≤ cap
// 3. Receiver counter-signs { tx, sender_sig } with their key.
// 4. Phone POSTs the complete bundle to /sync/submit when next online.
//    Server verifies all three sigs again + atomic permit redemption.
//
// For web, "scan" is a paste textarea. For phone, expo-camera scan
// would feed the same bundle decoder.

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
import { CameraView, useCameraPermissions } from 'expo-camera';

import { useAuth } from '../context/AuthContext';
import { useWallet } from '../hooks/useWallet';
import { Echopay } from '../constants/theme';
import { PERSONAS, getPersonaById } from '../constants/personas';
import {
  decodeBundle,
  signCanonicalB64,
  verifyCanonicalB64,
  permitCanonical,
  receiptCanonical,
  encodeBundle,
  secretKeyBytes,
  pubKeyBytes,
  OfflineBundle,
} from '../services/crypto';
import { formatKoboToNaira } from '../utils/format';
import { API_BASE_URL } from '../constants/config';

// Pinned at boot via EXPO_PUBLIC_SERVER_ED25519_PUB. Phone verifies
// permits with this offline. If unset, we fetch it from /crypto/server-pubkey
// on first use and cache it via module-scope.
let _serverPubB64: string | undefined =
  process.env.EXPO_PUBLIC_SERVER_ED25519_PUB;

async function getServerPub(): Promise<string> {
  if (_serverPubB64) return _serverPubB64;
  const res = await fetch(`${API_BASE_URL}/crypto/server-pubkey`);
  if (!res.ok) throw new Error('server_pubkey_fetch_failed');
  const json = await res.json();
  _serverPubB64 = json.data.ed25519_pub_b64;
  return _serverPubB64!;
}

type Stage = 'scan' | 'verifying' | 'review' | 'settling' | 'done' | 'failed';

export default function OfflineScanScreen() {
  const router = useRouter();
  const { user, token } = useAuth();
  const { applyCredit } = useWallet();

  const [stage, setStage] = useState<Stage>('scan');
  const [paste, setPaste] = useState('');
  const [bundle, setBundle] = useState<OfflineBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settled, setSettled] = useState<{
    tx_id: string;
    settled_at: number;
  } | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();

  const me = useMemo(
    () => (user ? getPersonaById(user.username ?? '') : undefined),
    [user],
  );

  // -------------------- handlers

  const onVerify = async () => {
    setError(null);
    setStage('verifying');
    const b = decodeBundle(paste.trim());
    if (!b) {
      setError('Could not read the QR / pasted bundle.');
      setStage('scan');
      return;
    }
    try {
      // 1. Receiver must be the intended recipient.
      if (!user || b.tx.to_user !== user.id) {
        throw new Error('This payment is for a different account.');
      }

      // 2. Permit not expired.
      const now = Math.floor(Date.now() / 1000);
      if (b.permit.expires_at <= now) {
        throw new Error('Permit expired. Sender needs a fresh one.');
      }

      // 3. Amount within permit cap.
      if (b.tx.amount_kobo > b.permit.max_amount_kobo) {
        throw new Error('Amount exceeds the permit cap.');
      }

      // 4. Server signature on the permit.
      const serverPub = await getServerPub();
      if (
        !verifyCanonicalB64(
          permitCanonical(b.permit),
          b.permit.server_sig_b64,
          pubKeyBytes(serverPub),
        )
      ) {
        throw new Error('Permit not signed by the EchoPay server.');
      }

      // 5. Sender's signature on the tx.
      const senderPersona = PERSONAS.find((p) => p.user.id === b.tx.from_user);
      if (!senderPersona) {
        throw new Error('Unknown sender.');
      }
      if (
        !verifyCanonicalB64(
          b.tx,
          b.sender_sig_b64,
          pubKeyBytes(senderPersona.ed25519PubKeyB64),
        )
      ) {
        throw new Error('Sender signature invalid.');
      }

      setBundle(b);
      setStage('review');
    } catch (e) {
      setError((e as Error).message ?? 'Verification failed.');
      setStage('failed');
    }
  };

  const onAccept = async () => {
    if (!bundle || !me) return;
    setError(null);
    setStage('settling');

    try {
      const receiverSig = signCanonicalB64(
        receiptCanonical(bundle.tx, bundle.sender_sig_b64),
        secretKeyBytes(me.ed25519PrivKeyB64),
      );

      const complete: OfflineBundle = { ...bundle, receiver_sig_b64: receiverSig };

      // Try settling immediately. In a real two-phones-offline demo,
      // the receiver would write to outbox and settle on reconnect.
      const res = await fetch(`${API_BASE_URL}/sync/submit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          permit: complete.permit,
          tx: complete.tx,
          sender_sig_b64: complete.sender_sig_b64,
          receiver_sig_b64: receiverSig,
        }),
      });
      if (!res.ok) {
        let detail: { code?: string; message?: string } = {};
        try {
          detail = (await res.json()).detail;
        } catch {
          /* ignore */
        }
        throw new Error(
          detail?.message ?? detail?.code ?? `Settlement failed (${res.status}).`,
        );
      }
      const json = await res.json();
      const data = json.data as { tx_id: string; settled_at: number };
      setSettled(data);

      // Receiver credits their own balance optimistically. (Server
      // already moved it; this just refreshes our local mirror.)
      await applyCredit(bundle.tx.amount_kobo);
      setStage('done');
    } catch (e) {
      setError((e as Error).message);
      setStage('failed');
    }
  };

  // -------------------- screens

  if (stage === 'verifying' || stage === 'settling') {
    return (
      <View style={styles.fullScreen}>
        <ActivityIndicator size="large" color={Echopay.accent} />
        <Text style={styles.fullTitle}>
          {stage === 'verifying' ? 'Verifying signatures…' : 'Settling on server…'}
        </Text>
        <Text style={styles.fullSub}>
          {stage === 'verifying'
            ? 'Checking the server permit + sender signature locally.'
            : 'Atomically redeeming the permit and crediting your balance.'}
        </Text>
      </View>
    );
  }

  if (stage === 'done' && settled && bundle) {
    return (
      <View style={styles.successScreen}>
        <View style={styles.successCheck}>
          <Ionicons name="checkmark" size={42} color="#fff" />
        </View>
        <Text style={styles.successHeadline}>
          Received {formatKoboToNaira(bundle.tx.amount_kobo)}
        </Text>
        <Text style={styles.successSub}>
          from{' '}
          {PERSONAS.find((p) => p.user.id === bundle.tx.from_user)?.display_name}
        </Text>

        <View style={styles.successCard}>
          <View style={styles.successRow}>
            <Text style={styles.successLabel}>Permit redeemed</Text>
            <Text style={styles.successValueMono}>
              {bundle.permit.permit_id.slice(0, 12)}…
            </Text>
          </View>
          <View style={styles.successRow}>
            <Text style={styles.successLabel}>Reference</Text>
            <Text style={styles.successValueMono}>{settled.tx_id}</Text>
          </View>
          <View style={styles.successRow}>
            <Text style={styles.successLabel}>Signatures verified</Text>
            <Text style={[styles.successValue, { color: Echopay.success }]}>
              server · sender · me
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
      </View>
    );
  }

  // Camera overlay — full-screen QR scanner.
  if (cameraOpen) {
    return (
      <View style={styles.cameraWrap}>
        <CameraView
          style={StyleSheet.absoluteFillObject}
          facing="back"
          onBarcodeScanned={(result) => {
            if (!result?.data) return;
            setCameraOpen(false);
            setPaste(result.data);
            setTimeout(() => onVerify(), 0);
          }}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        />
        <View style={styles.cameraOverlay} pointerEvents="none">
          <View style={styles.cameraFrame} />
          <Text style={styles.cameraHint}>
            Align the sender's QR inside the frame
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

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.container}
    >
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <Pressable
          onPress={() => {
            if (router.canGoBack()) router.back();
            else router.replace('/(tabs)');
          }}
          style={({ pressed }) => [styles.back, pressed && styles.backPressed]}
          hitSlop={12}
        >
          <Ionicons name="chevron-back" size={22} color={Echopay.text} />
        </Pressable>

        <Text style={styles.eyebrow}>OFFLINE RECEIVE</Text>
        <Text style={styles.title}>
          {stage === 'review' ? 'Confirm this payment' : 'Scan the sender'}
        </Text>

        {(stage === 'scan' || stage === 'failed') && (
          <>
            <Text style={styles.subtitle}>
              Point your camera at the sender's QR — or paste the bundle
              text below for the web demo.
            </Text>

            {Platform.OS !== 'web' && (
              <Pressable
                onPress={async () => {
                  if (!permission?.granted) {
                    const r = await requestPermission();
                    if (!r.granted) return;
                  }
                  setCameraOpen(true);
                  setError(null);
                }}
                style={({ pressed }) => [
                  styles.scanButton,
                  pressed && styles.scanButtonPressed,
                ]}
              >
                <Ionicons name="qr-code-outline" size={18} color="#fff" />
                <Text style={styles.scanButtonText}>Scan QR</Text>
              </Pressable>
            )}

            <View style={styles.pasteCard}>
              <Text style={styles.pasteLabel}>
                Paste bundle{' '}
                <Text style={styles.pasteLabelMuted}>(fallback)</Text>
              </Text>
              <TextInput
                style={styles.pasteInput}
                value={paste}
                onChangeText={setPaste}
                multiline
                placeholder='{"permit":{...},"tx":{...},"sender_sig_b64":"..."}'
                placeholderTextColor={Echopay.textSubtle}
              />
            </View>

            {error && (
              <View style={styles.banner}>
                <Ionicons
                  name="alert-circle-outline"
                  size={16}
                  color={Echopay.danger}
                />
                <Text style={styles.bannerDanger}>{error}</Text>
              </View>
            )}

            <Pressable
              onPress={onVerify}
              disabled={!paste.trim()}
              style={({ pressed }) => [
                styles.primaryButton,
                !paste.trim() && styles.primaryButtonDisabled,
                pressed && paste.trim() && styles.primaryButtonPressed,
              ]}
            >
              <Text style={styles.primaryButtonText}>Verify signatures</Text>
            </Pressable>
          </>
        )}

        {stage === 'review' && bundle && (
          <>
            <View style={styles.reviewCard}>
              <Text style={styles.reviewLabel}>YOU'LL RECEIVE</Text>
              <Text style={styles.reviewAmount}>
                {formatKoboToNaira(bundle.tx.amount_kobo)}
              </Text>
              <Text style={styles.reviewFrom}>
                from{' '}
                {
                  PERSONAS.find((p) => p.user.id === bundle.tx.from_user)
                    ?.display_name
                }
              </Text>

              <View style={styles.divider} />

              <View style={styles.verifyRow}>
                <Ionicons name="checkmark" size={16} color={Echopay.success} />
                <Text style={styles.verifyRowText}>Permit signed by EchoPay server</Text>
              </View>
              <View style={styles.verifyRow}>
                <Ionicons name="checkmark" size={16} color={Echopay.success} />
                <Text style={styles.verifyRowText}>
                  Sender ed25519 signature valid
                </Text>
              </View>
              <View style={styles.verifyRow}>
                <Ionicons name="checkmark" size={16} color={Echopay.success} />
                <Text style={styles.verifyRowText}>
                  Permit not expired, amount within cap
                </Text>
              </View>
            </View>

            <View style={styles.note}>
              <Ionicons
                name="information-circle-outline"
                size={16}
                color={Echopay.textMuted}
              />
              <Text style={styles.noteText}>
                When you accept, your phone counter-signs and sends the
                complete bundle to the server. The server atomically
                redeems the permit — if the sender tried to spend this
                permit elsewhere, only one of the redemptions succeeds.
              </Text>
            </View>

            <Pressable
              onPress={onAccept}
              style={({ pressed }) => [
                styles.primaryButton,
                pressed && styles.primaryButtonPressed,
              ]}
            >
              <View style={styles.primaryButtonInner}>
                <Ionicons name="checkmark" size={18} color="#fff" />
                <Text style={styles.primaryButtonText}>
                  Accept {formatKoboToNaira(bundle.tx.amount_kobo)}
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

  pasteCard: {
    backgroundColor: Echopay.cardBg,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Echopay.border,
    padding: 16,
    marginBottom: 12,
  },
  pasteLabel: { fontSize: 13, color: Echopay.text, fontWeight: '600' },
  pasteLabelMuted: { color: Echopay.textMuted, fontWeight: '400' },
  pasteInput: {
    marginTop: 10,
    minHeight: 120,
    padding: 12,
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    color: Echopay.text,
    backgroundColor: Echopay.cardSoft,
    borderRadius: 10,
    textAlignVertical: 'top',
  },

  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 10,
    borderRadius: 12,
    backgroundColor: Echopay.dangerSoft,
    borderWidth: 1,
    borderColor: '#FBD5D5',
    marginBottom: 12,
  },
  bannerDanger: { flex: 1, fontSize: 13, color: Echopay.danger, fontWeight: '500' },

  // review
  reviewCard: {
    padding: 18,
    borderRadius: 16,
    backgroundColor: Echopay.cardBg,
    borderWidth: 1,
    borderColor: Echopay.border,
    marginBottom: 14,
  },
  reviewLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.4,
    color: Echopay.textSubtle,
    marginBottom: 6,
  },
  reviewAmount: {
    fontSize: 36,
    fontWeight: '800',
    color: Echopay.text,
    letterSpacing: -0.6,
  },
  reviewFrom: { fontSize: 14, color: Echopay.textMuted, marginTop: 2 },

  divider: { height: 1, backgroundColor: Echopay.border, marginVertical: 14 },

  verifyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 4,
  },
  verifyRowText: { fontSize: 13, color: Echopay.text },

  note: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    padding: 14,
    borderRadius: 12,
    backgroundColor: Echopay.cardSoft,
    marginBottom: 14,
  },
  noteText: {
    flex: 1,
    fontSize: 12,
    color: Echopay.textMuted,
    lineHeight: 18,
  },

  scanButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Echopay.accent,
    paddingVertical: 16,
    borderRadius: 14,
    marginBottom: 16,
  },
  scanButtonPressed: { backgroundColor: Echopay.accentPressed },
  scanButtonText: { color: '#fff', fontSize: 15, fontWeight: '600' },

  // camera overlay
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

  fullScreen: {
    flex: 1,
    backgroundColor: Echopay.pageBg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 12,
  },
  fullTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: Echopay.text,
    marginTop: 6,
  },
  fullSub: {
    fontSize: 13,
    color: Echopay.textMuted,
    textAlign: 'center',
    maxWidth: 280,
  },

  // success
  successScreen: {
    flex: 1,
    backgroundColor: Echopay.pageBg,
    padding: 24,
    paddingTop: 80,
    alignItems: 'center',
  },
  successCheck: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: Echopay.success,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 22,
  },
  successHeadline: {
    fontSize: 26,
    fontWeight: '800',
    color: Echopay.text,
    letterSpacing: -0.4,
  },
  successSub: { fontSize: 15, color: Echopay.textMuted, marginTop: 4 },
  successCard: {
    width: '100%',
    marginTop: 28,
    padding: 18,
    borderRadius: 16,
    backgroundColor: Echopay.cardBg,
    borderWidth: 1,
    borderColor: Echopay.border,
    marginBottom: 18,
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
});
