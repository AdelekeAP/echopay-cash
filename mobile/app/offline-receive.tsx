// Offline receive — shows the current user's receive QR so a sender
// (whose phone may also be offline) can build a signed payment to them.
//
// The QR carries {user_id, display_name, pubkey}. Sender's phone uses
// it to fill in `to_user` on the tx envelope and to later verify our
// counter-signature locally.

import { useMemo, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Platform,
  ScrollView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import QRCode from 'react-native-qrcode-svg';

import { useAuth } from '../context/AuthContext';
import { Echopay } from '../constants/theme';
import { getPersonaById } from '../constants/personas';
import { encodeReceive, ReceiveBundle } from '../services/crypto';

export default function OfflineReceiveScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const [copied, setCopied] = useState(false);

  const me = useMemo(
    () => (user ? getPersonaById(user.username ?? '') : undefined),
    [user],
  );

  if (!user || !me) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Sign in first</Text>
      </View>
    );
  }

  const bundle: ReceiveBundle = {
    u: user.id,
    n: me.display_name,
    k: me.ed25519PubKeyB64,
  };
  const payload = encodeReceive(bundle);

  const onCopy = async () => {
    try {
      if (Platform.OS === 'web') {
        const nav = (
          globalThis as {
            navigator?: { clipboard?: { writeText: (s: string) => Promise<void> } };
          }
        ).navigator;
        await nav?.clipboard?.writeText(payload);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
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

        <Text style={styles.title}>Receive offline</Text>
        <Text style={styles.subtitle}>
          Show this QR to anyone paying you offline. It carries your name,
          ID, and public key — enough for their phone to build a signed
          payment to you.
        </Text>

        <View style={styles.qrBlock}>
          <View style={styles.qrInner}>
            <QRCode
              value={payload}
              size={240}
              color={Echopay.text}
              backgroundColor={Echopay.cardBg}
            />
          </View>
          <Text style={styles.qrName}>{me.display_name}</Text>
          <Text style={styles.qrMeta}>{me.role}</Text>
        </View>

        <Pressable
          onPress={onCopy}
          style={({ pressed }) => [
            styles.copy,
            pressed && styles.copyPressed,
          ]}
        >
          <Ionicons
            name={copied ? 'checkmark' : 'copy-outline'}
            size={16}
            color={Echopay.accent}
          />
          <Text style={styles.copyText}>
            {copied ? 'Copied to clipboard' : 'Copy bundle (for web demo)'}
          </Text>
        </Pressable>

        <Text style={styles.bundleLabel}>What's in the QR</Text>
        <TextInput
          style={styles.bundleText}
          value={payload}
          editable={false}
          multiline
          nativeID="receive-bundle"
        />


        <Text style={styles.note}>
          Your private key never leaves this phone. The sender's tx is only
          valid up to the cap on their server-signed permit.
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Echopay.pageBg },
  scroll: { padding: 24, paddingTop: 16, paddingBottom: 60 },

  back: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: -10,
    marginBottom: 24,
  },
  backPressed: {
    backgroundColor: Echopay.cardSoft,
  },

  title: {
    fontSize: 30,
    fontWeight: '700',
    color: Echopay.text,
    letterSpacing: -0.6,
  },
  subtitle: {
    fontSize: 14,
    color: Echopay.textMuted,
    lineHeight: 20,
    marginTop: 8,
    marginBottom: 32,
  },

  qrBlock: {
    alignItems: 'center',
    paddingVertical: 8,
  },
  qrInner: {
    padding: 18,
    backgroundColor: Echopay.cardBg,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Echopay.border,
  },
  qrName: {
    marginTop: 22,
    fontSize: 20,
    fontWeight: '700',
    color: Echopay.text,
    letterSpacing: -0.3,
  },
  qrMeta: {
    fontSize: 13,
    color: Echopay.textMuted,
    marginTop: 4,
  },

  copy: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    marginTop: 24,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Echopay.border,
    backgroundColor: Echopay.cardBg,
  },
  copyPressed: { backgroundColor: Echopay.cardSoft },
  copyText: { color: Echopay.accent, fontSize: 14, fontWeight: '600' },

  bundleLabel: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1.2,
    color: Echopay.textSubtle,
    marginTop: 24,
    marginBottom: 6,
  },
  bundleText: {
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    color: Echopay.text,
    backgroundColor: Echopay.cardSoft,
    borderRadius: 10,
    padding: 10,
    minHeight: 60,
    textAlignVertical: 'top',
  },

  note: {
    fontSize: 12,
    color: Echopay.textMuted,
    textAlign: 'center',
    marginTop: 24,
    lineHeight: 18,
  },
});
