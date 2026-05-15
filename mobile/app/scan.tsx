import {
  View,
  Text,
  Pressable,
  StyleSheet,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { Echopay } from '../constants/theme';

export default function ScanScreen() {
  const router = useRouter();

  return (
    <View style={styles.container}>
      <Pressable
        onPress={() => router.back()}
        style={styles.backRow}
        hitSlop={12}
      >
        <Text style={styles.backText}>← Back</Text>
      </Pressable>

      <View style={styles.body}>
        <View style={styles.iconCard}>
          <Ionicons name="camera-outline" size={44} color={Echopay.textMuted} />
        </View>
        <Text style={styles.title}>Scan QR</Text>
        <Text style={styles.subtitle}>
          The QR scanner is available in Expo Go on a phone. The web preview
          shows this notice instead.
        </Text>
      </View>
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
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: Echopay.text,
  },
  subtitle: {
    fontSize: 14,
    color: Echopay.textMuted,
    textAlign: 'center',
    maxWidth: 300,
    lineHeight: 21,
  },
});
