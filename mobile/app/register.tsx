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
import { useAuth } from '../context/AuthContext';
import { Echopay } from '../constants/theme';
import { User, Account } from '../types';
import {
  verifyNin,
  verifyBvn,
  formatDob,
  MonoNinData,
  MonoBvnData,
} from '../services/mono';

type Stage =
  | 'enter-nin'
  | 'verifying-nin'
  | 'enter-bvn'
  | 'verifying-bvn'
  | 'pin'
  | 'creating'
  | 'done';

export default function RegisterScreen() {
  const router = useRouter();
  const { setSession } = useAuth();

  const [stage, setStage] = useState<Stage>('enter-nin');
  const [nin, setNin] = useState('');
  const [bvn, setBvn] = useState('');
  const [verified, setVerified] = useState<MonoNinData | null>(null);
  const [bvnVerified, setBvnVerified] = useState<MonoBvnData | null>(null);
  const [pin, setPin] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [vaNumber, setVaNumber] = useState('');

  // -------------------------------------------------------- helpers

  const formattedNin = nin.replace(/\D/g, '').slice(0, 11)
    .replace(/^(\d{4})(\d{4})(\d{0,3})$/, '$1 $2 $3').trim();

  const formattedBvn = bvn.replace(/\D/g, '').slice(0, 11)
    .replace(/^(\d{4})(\d{4})(\d{0,3})$/, '$1 $2 $3').trim();

  const handleLookup = async () => {
    setError(null);
    setStage('verifying-nin');
    const res = await verifyNin(nin);
    if (res.status === 'successful' && res.data) {
      setVerified(res.data);
      setStage('enter-bvn');
    } else {
      setError(res.message || 'Could not verify NIN. Try again.');
      setStage('enter-nin');
    }
  };

  const handleBvnVerify = async () => {
    setError(null);
    setStage('verifying-bvn');
    const res = await verifyBvn(bvn, verified?.nin);
    if (res.status === 'successful' && res.data) {
      setBvnVerified(res.data);
      setStage('pin');
    } else {
      setError(res.message || 'Could not verify BVN. Try again.');
      setStage('enter-bvn');
    }
  };

  const handleCreate = async () => {
    if (pin.length !== 4) {
      setError('PIN must be exactly 4 digits.');
      return;
    }
    if (pin !== pinConfirm) {
      setError('PINs do not match.');
      return;
    }
    if (!verified) return;
    setError(null);
    setStage('creating');

    // Mock Squad B2C Static VA. Real call: backend POST /auth/voice-signup
    // → Squad /virtual-account using `verified` as the KYC payload.
    await new Promise((r) => setTimeout(r, 1300));
    const fakeVa = `0${Math.floor(100000000 + Math.random() * 899999999)}`;
    setVaNumber(fakeVa);

    const user: User = {
      id: Date.now(),
      username: `${verified.first_name.toLowerCase()}_${verified.last_name.toLowerCase()}`,
      email: `${verified.first_name.toLowerCase()}@echopay.test`,
      first_name: verified.first_name,
      last_name: verified.last_name,
      phone_number: verified.phone_number,
    };

    const account: Account = {
      id: user.id,
      account_number: fakeVa,
      balance: '0.00',
      is_active: true,
      created_at: new Date().toISOString(),
      user,
      bank: { id: 1, name: 'GTBank', code: '058', logo_url: null },
    };

    await setSession(user, account, `demo_token_signup_${user.id}`);
    setStage('done');
    setTimeout(() => router.replace('/(tabs)'), 1300);
  };

  // -------------------------------------------------------- screens

  if (stage === 'verifying-nin') {
    return (
      <FullScreenMessage
        spinner
        title="Verifying with NIMC…"
        subtitle="Pulling your details from the National Identity Database."
      />
    );
  }

  if (stage === 'verifying-bvn') {
    return (
      <FullScreenMessage
        spinner
        title="Verifying with your bank…"
        subtitle="Cross-checking your BVN against NIBSS."
      />
    );
  }

  if (stage === 'creating') {
    return (
      <FullScreenMessage
        spinner
        title={`One moment, ${verified?.first_name ?? ''}…`}
        subtitle="Opening your GTBank account via Squad."
      />
    );
  }

  if (stage === 'done') {
    return (
      <View style={styles.successScreen}>
        <View style={styles.successCheck}>
          <Text style={styles.successCheckMark}>✓</Text>
        </View>
        <Text style={styles.successTitle}>Welcome, {verified?.first_name}.</Text>
        <Text style={styles.successSubtitle}>Your GTBank account is ready.</Text>
        <Text style={styles.vaNumber}>{vaNumber}</Text>
        <Text style={styles.vaCaption}>Anyone can send you money here.</Text>
      </View>
    );
  }

  // -------- enter-nin or pin stage share the page shell

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.container}
    >
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <Pressable onPress={() => router.back()} style={styles.backRow} hitSlop={12}>
          <Text style={styles.backText}>← Back</Text>
        </Pressable>

        {stage === 'enter-nin' && (
          <>
            <View style={styles.heroBlock}>
              <Text style={styles.heroEyebrow}>STEP 1 · IDENTITY</Text>
              <Text style={styles.heroTitle}>Verify with your NIN</Text>
              <Text style={styles.heroSubtitle}>
                We pull your verified name and date of birth from NIMC. No
                paperwork. No long forms.
              </Text>
            </View>

            <View style={styles.field}>
              <Text style={styles.fieldLabel}>National Identification Number</Text>
              <TextInput
                style={styles.ninInput}
                value={formattedNin}
                onChangeText={(t) => setNin(t.replace(/\D/g, '').slice(0, 11))}
                keyboardType="number-pad"
                maxLength={13}
                placeholder="0000 0000 000"
                placeholderTextColor={Echopay.textSubtle}
                autoFocus
              />
              <Text style={styles.fieldHint}>
                11 digits. Find it on the back of your NIN slip.
              </Text>
            </View>

            {error && <Text style={styles.errorText}>{error}</Text>}

            <Pressable
              onPress={handleLookup}
              disabled={nin.replace(/\D/g, '').length !== 11}
              style={({ pressed }) => [
                styles.primaryButton,
                nin.replace(/\D/g, '').length !== 11 && styles.primaryButtonDisabled,
                pressed && styles.primaryButtonPressed,
              ]}
            >
              <Text style={styles.primaryButtonText}>Look up my details</Text>
            </Pressable>

            <View style={styles.providerBadge}>
              <View style={styles.providerDot} />
              <Text style={styles.providerText}>
                Powered by <Text style={styles.providerBold}>Mono</Text> ·
                NIN lookup via NIMC
              </Text>
            </View>

            <View style={styles.demoNins}>
              <Text style={styles.demoTitle}>Try these test NINs</Text>
              {[
                { nin: '12345678901', who: 'Adunni Bello' },
                { nin: '22334455667', who: 'Tunde Adeyemi' },
                { nin: '98765432101', who: 'Chioma Okafor' },
              ].map((d) => (
                <Pressable
                  key={d.nin}
                  onPress={() => setNin(d.nin)}
                  style={styles.demoRow}
                >
                  <Text style={styles.demoNin}>{d.nin}</Text>
                  <Text style={styles.demoName}>{d.who}</Text>
                </Pressable>
              ))}
            </View>
          </>
        )}

        {stage === 'pin' && verified && (
          <>
            <View style={styles.heroBlock}>
              <Text style={styles.heroEyebrow}>STEP 2 · SECURITY</Text>
              <Text style={styles.heroTitle}>Set your PIN</Text>
              <Text style={styles.heroSubtitle}>
                4 digits. You'll use this to confirm payments.
              </Text>
            </View>

            <View style={styles.verifiedCard}>
              <View style={styles.verifiedBadge}>
                <Text style={styles.verifiedBadgeText}>✓ VERIFIED</Text>
              </View>
              <Text style={styles.verifiedName}>
                {verified.first_name}{' '}
                {verified.middle_name ? `${verified.middle_name} ` : ''}
                {verified.last_name}
              </Text>
              <View style={styles.verifiedRow}>
                <Text style={styles.verifiedLabel}>Date of birth</Text>
                <Text style={styles.verifiedValue}>
                  {formatDob(verified.date_of_birth)}
                </Text>
              </View>
              <View style={styles.verifiedRow}>
                <Text style={styles.verifiedLabel}>Phone</Text>
                <Text style={styles.verifiedValue}>{verified.phone_number}</Text>
              </View>
              <View style={styles.verifiedRow}>
                <Text style={styles.verifiedLabel}>NIN</Text>
                <Text style={styles.verifiedValue}>
                  {verified.nin.replace(/(\d{4})(\d{4})(\d{3})/, '$1 $2 $3')}
                </Text>
              </View>
            </View>

            <View style={styles.pinRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.fieldLabel}>4-digit PIN</Text>
                <TextInput
                  style={styles.pinInput}
                  value={pin}
                  onChangeText={(t) =>
                    setPin(t.replace(/\D/g, '').slice(0, 4))
                  }
                  keyboardType="number-pad"
                  secureTextEntry
                  maxLength={4}
                  placeholder="••••"
                  placeholderTextColor={Echopay.textSubtle}
                  autoFocus
                />
              </View>
              <View style={{ width: 12 }} />
              <View style={{ flex: 1 }}>
                <Text style={styles.fieldLabel}>Confirm</Text>
                <TextInput
                  style={styles.pinInput}
                  value={pinConfirm}
                  onChangeText={(t) =>
                    setPinConfirm(t.replace(/\D/g, '').slice(0, 4))
                  }
                  keyboardType="number-pad"
                  secureTextEntry
                  maxLength={4}
                  placeholder="••••"
                  placeholderTextColor={Echopay.textSubtle}
                />
              </View>
            </View>

            {error && <Text style={styles.errorText}>{error}</Text>}

            <Pressable
              onPress={handleCreate}
              style={({ pressed }) => [
                styles.primaryButton,
                pressed && styles.primaryButtonPressed,
              ]}
            >
              <Text style={styles.primaryButtonText}>
                Create my GTBank account
              </Text>
            </Pressable>

            <View style={styles.providerBadge}>
              <View style={styles.providerDot} />
              <Text style={styles.providerText}>
                Squad opens a real B2C Static VA in your name.
              </Text>
            </View>
          </>
        )}

        <Pressable
          onPress={() => router.replace('/login')}
          style={styles.bottomLink}
          hitSlop={12}
        >
          <Text style={styles.bottomLinkText}>
            Already have an account?{' '}
            <Text style={styles.bottomLinkBold}>Sign in</Text>
          </Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ---------------------------------------------------- full-screen messaging

function FullScreenMessage({
  spinner,
  title,
  subtitle,
}: {
  spinner?: boolean;
  title: string;
  subtitle?: string;
}) {
  return (
    <View style={styles.fullScreen}>
      {spinner && <ActivityIndicator size="large" color={Echopay.accent} />}
      <Text style={styles.fullScreenTitle}>{title}</Text>
      {subtitle && <Text style={styles.fullScreenSubtitle}>{subtitle}</Text>}
    </View>
  );
}

// ---------------------------------------------------- styles

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Echopay.pageBg },
  scrollContent: { flexGrow: 1, padding: 24, paddingBottom: 60 },

  backRow: { marginTop: 8, marginBottom: 14 },
  backText: { fontSize: 15, color: Echopay.accent, fontWeight: '500' },

  heroBlock: { marginBottom: 26 },
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
  },
  ninInput: {
    borderWidth: 1,
    borderColor: Echopay.border,
    borderRadius: 14,
    paddingVertical: 18,
    paddingHorizontal: 18,
    fontSize: 22,
    letterSpacing: 4,
    backgroundColor: Echopay.cardBg,
    color: Echopay.text,
    fontWeight: '500',
  },
  pinRow: { flexDirection: 'row', marginBottom: 8 },
  pinInput: {
    borderWidth: 1,
    borderColor: Echopay.border,
    borderRadius: 14,
    paddingVertical: 18,
    paddingHorizontal: 16,
    fontSize: 24,
    letterSpacing: 10,
    textAlign: 'center',
    backgroundColor: Echopay.cardBg,
    color: Echopay.text,
  },

  errorText: {
    color: Echopay.danger,
    fontSize: 13,
    marginTop: 4,
    marginBottom: 10,
    fontWeight: '500',
  },

  primaryButton: {
    backgroundColor: Echopay.accent,
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
    marginTop: 18,
  },
  primaryButtonDisabled: { backgroundColor: Echopay.accentMuted },
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

  // Verified-NIN card (PIN stage)
  verifiedCard: {
    backgroundColor: Echopay.cardBg,
    borderWidth: 1,
    borderColor: Echopay.border,
    borderRadius: 18,
    padding: 18,
    marginBottom: 22,
  },
  verifiedBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: Echopay.successSoft,
    marginBottom: 12,
  },
  verifiedBadgeText: {
    color: Echopay.success,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
  verifiedName: {
    fontSize: 20,
    fontWeight: '700',
    color: Echopay.text,
    marginBottom: 14,
  },
  verifiedRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  verifiedLabel: { fontSize: 13, color: Echopay.textMuted },
  verifiedValue: { fontSize: 13, color: Echopay.text, fontWeight: '500' },

  // Demo NINs panel
  demoNins: {
    marginTop: 28,
    padding: 16,
    backgroundColor: Echopay.cardSoft,
    borderRadius: 14,
  },
  demoTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: Echopay.textMuted,
    letterSpacing: 1.2,
    marginBottom: 12,
  },
  demoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  demoNin: { fontSize: 13, color: Echopay.text, fontWeight: '600' },
  demoName: { fontSize: 13, color: Echopay.textMuted },

  bottomLink: { alignItems: 'center', marginTop: 28 },
  bottomLinkText: { fontSize: 14, color: Echopay.textMuted },
  bottomLinkBold: { color: Echopay.accent, fontWeight: '600' },

  // full-screen states
  fullScreen: {
    flex: 1,
    backgroundColor: Echopay.pageBg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 16,
  },
  fullScreenTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: Echopay.text,
    marginTop: 12,
    textAlign: 'center',
  },
  fullScreenSubtitle: {
    fontSize: 14,
    color: Echopay.textMuted,
    textAlign: 'center',
    maxWidth: 280,
  },

  // success
  successScreen: {
    flex: 1,
    backgroundColor: Echopay.pageBg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  successCheck: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: Echopay.success,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 22,
  },
  successCheckMark: { fontSize: 44, color: '#fff', fontWeight: '700' },
  successTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: Echopay.text,
    marginTop: 8,
    textAlign: 'center',
  },
  successSubtitle: {
    fontSize: 15,
    color: Echopay.textMuted,
    marginTop: 6,
    textAlign: 'center',
  },
  vaNumber: {
    fontSize: 30,
    fontWeight: '800',
    letterSpacing: 2,
    color: Echopay.text,
    marginTop: 22,
  },
  vaCaption: { fontSize: 13, color: Echopay.textSubtle, marginTop: 6 },
});
