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
} from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '../context/AuthContext';
import { PERSONAS, Persona } from '../constants/personas';
import { Echopay } from '../constants/theme';

export default function LoginScreen() {
  const [picked, setPicked] = useState<Persona | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { setSession } = useAuth();
  const router = useRouter();

  const handlePersonaTap = (persona: Persona) => {
    setPicked(persona);
    setPin('');
    setError(null);
  };

  const handlePinSubmit = async () => {
    if (!picked) return;
    if (pin.length < 4) {
      setError('Enter 4 digits.');
      return;
    }
    if (pin !== picked.pin) {
      setError('Wrong PIN. Try again.');
      setPin('');
      return;
    }
    setLoading(true);
    try {
      await setSession(
        picked.user,
        picked.account,
        `demo_token_${picked.id}_${Date.now()}`,
      );
      router.replace('/(tabs)');
    } finally {
      setLoading(false);
    }
  };

  // ----------------------------------------------- PIN sheet (step 2)

  if (picked) {
    return (
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.container}
      >
        <ScrollView contentContainerStyle={styles.scrollContent}>
          <Wordmark small />

          <Pressable
            onPress={() => {
              setPicked(null);
              setPin('');
              setError(null);
            }}
            style={styles.backRow}
            hitSlop={12}
          >
            <Text style={styles.backText}>← Choose another account</Text>
          </Pressable>

          <View style={styles.personaCardActive}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{picked.initials}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.personaName}>{picked.display_name}</Text>
              <Text style={styles.personaRole}>{picked.role}</Text>
            </View>
          </View>

          <Text style={styles.pinTitle}>Enter your PIN</Text>
          <Text style={styles.pinSubtitle}>4 digits</Text>

          <TextInput
            style={styles.pinInput}
            value={pin}
            onChangeText={(t) => {
              setPin(t.replace(/\D/g, '').slice(0, 4));
              if (error) setError(null);
            }}
            keyboardType="number-pad"
            secureTextEntry
            autoFocus
            maxLength={4}
            placeholder="••••"
            placeholderTextColor={Echopay.textSubtle}
          />

          {error ? <Text style={styles.errorText}>{error}</Text> : null}

          <Pressable
            onPress={handlePinSubmit}
            disabled={loading || pin.length < 4}
            style={({ pressed }) => [
              styles.primaryButton,
              (loading || pin.length < 4) && styles.primaryButtonDisabled,
              pressed && styles.primaryButtonPressed,
            ]}
          >
            <Text style={styles.primaryButtonText}>
              {loading ? 'Signing in…' : 'Sign in'}
            </Text>
          </Pressable>

          <Text style={styles.hintText}>
            Demo PIN for all personas:{' '}
            <Text style={styles.hintBold}>1234</Text>
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  // ------------------------------------------- Persona picker (step 1)

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.container}
    >
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <Wordmark />

        <Text style={styles.welcomeTitle}>Welcome back</Text>
        <Text style={styles.welcomeSubtitle}>Choose your account to sign in.</Text>

        <View style={styles.personaList}>
          {PERSONAS.map((p) => (
            <Pressable
              key={p.id}
              onPress={() => handlePersonaTap(p)}
              style={({ pressed }) => [
                styles.personaCard,
                pressed && styles.personaCardPressed,
              ]}
            >
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{p.initials}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.personaName}>{p.display_name}</Text>
                <Text style={styles.personaRole}>{p.role}</Text>
              </View>
              <Text style={styles.chevron}>›</Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.divider} />

        <View style={styles.signupBlock}>
          <Text style={styles.signupQuestion}>New to EchoPay Cash?</Text>
          <Pressable
            onPress={() => router.push('/voice-signup')}
            style={({ pressed }) => [
              styles.secondaryButton,
              pressed && styles.secondaryButtonPressed,
            ]}
          >
            <Text style={styles.secondaryButtonText}>
              Sign up with your voice →
            </Text>
          </Pressable>
          <Pressable
            onPress={() => router.push('/register')}
            style={styles.tertiaryLink}
            hitSlop={10}
          >
            <Text style={styles.tertiaryLinkText}>Or sign up with your NIN →</Text>
          </Pressable>
          <Text style={styles.signupFootnote}>
            Verified through NIMC. GTBank account in 30 seconds.
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// -------------------------------------------------- shared wordmark

function Wordmark({ small }: { small?: boolean }) {
  return (
    <View
      style={[
        styles.brandHeader,
        small && { marginTop: 24, marginBottom: 16 },
      ]}
    >
      <Text style={[styles.brandWordmark, small && { fontSize: 22 }]}>
        echopay<Text style={styles.brandWordmarkAccent}>.</Text>
        <Text style={styles.brandWordmarkLight}>cash</Text>
      </Text>
      {!small && (
        <Text style={styles.brandTagline}>
          Voice-first wallet for Nigeria's cash economy
        </Text>
      )}
    </View>
  );
}

// ------------------------------------------------------------- styles

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Echopay.pageBg },
  scrollContent: { flexGrow: 1, padding: 24, paddingBottom: 40 },

  brandHeader: { alignItems: 'center', marginTop: 48, marginBottom: 36 },
  brandWordmark: {
    fontSize: 30,
    fontWeight: '800',
    color: Echopay.text,
    letterSpacing: -0.6,
  },
  brandWordmarkAccent: { color: Echopay.accent },
  brandWordmarkLight: { color: Echopay.textMuted, fontWeight: '500' },
  brandTagline: {
    fontSize: 13,
    color: Echopay.textMuted,
    marginTop: 8,
    textAlign: 'center',
    maxWidth: 280,
  },

  welcomeTitle: {
    fontSize: 26,
    fontWeight: '700',
    color: Echopay.text,
    marginBottom: 4,
    letterSpacing: -0.4,
  },
  welcomeSubtitle: {
    fontSize: 15,
    color: Echopay.textMuted,
    marginBottom: 22,
  },

  personaList: { gap: 10 },
  personaCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 16,
    backgroundColor: Echopay.cardBg,
    borderWidth: 1,
    borderColor: Echopay.border,
    gap: 14,
  },
  personaCardPressed: {
    backgroundColor: Echopay.cardSoft,
    transform: [{ scale: 0.99 }],
  },
  personaCardActive: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 18,
    borderRadius: 18,
    backgroundColor: Echopay.cardBg,
    borderWidth: 1.5,
    borderColor: Echopay.accent,
    gap: 14,
    marginBottom: 26,
  },

  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: Echopay.cardSoft,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Echopay.border,
  },
  avatarText: {
    color: Echopay.text,
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 0.4,
  },

  personaName: { fontSize: 16, fontWeight: '600', color: Echopay.text },
  personaRole: { fontSize: 13, color: Echopay.textMuted, marginTop: 2 },
  chevron: { fontSize: 28, color: Echopay.textSubtle, marginLeft: 4 },

  divider: { height: 1, backgroundColor: Echopay.border, marginVertical: 28 },

  signupBlock: { alignItems: 'center' },
  signupQuestion: {
    fontSize: 14,
    color: Echopay.textMuted,
    marginBottom: 12,
  },
  secondaryButton: {
    paddingVertical: 13,
    paddingHorizontal: 26,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: Echopay.accent,
    backgroundColor: 'transparent',
  },
  secondaryButtonPressed: { backgroundColor: Echopay.accentSoft },
  secondaryButtonText: {
    color: Echopay.accent,
    fontSize: 15,
    fontWeight: '600',
  },
  tertiaryLink: {
    marginTop: 10,
    paddingVertical: 4,
  },
  tertiaryLinkText: {
    fontSize: 13,
    color: Echopay.textMuted,
    fontWeight: '500',
  },
  signupFootnote: {
    fontSize: 12,
    color: Echopay.textSubtle,
    marginTop: 14,
    textAlign: 'center',
    maxWidth: 280,
  },

  backRow: { marginBottom: 14 },
  backText: { fontSize: 14, color: Echopay.accent, fontWeight: '500' },

  pinTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: Echopay.text,
    marginBottom: 4,
  },
  pinSubtitle: {
    fontSize: 14,
    color: Echopay.textMuted,
    marginBottom: 18,
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
  hintText: {
    fontSize: 12,
    color: Echopay.textSubtle,
    marginTop: 16,
    textAlign: 'center',
  },
  hintBold: { color: Echopay.textMuted, fontWeight: '600' },
});
