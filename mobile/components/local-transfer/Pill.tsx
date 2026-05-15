// LocalTransferPill — the home-tab quick-action that opens the local
// transfer flow. Visually parallels Leke's Send and Receive pills in
// app/(tabs)/index.tsx; uses a cash icon to read as "money transfer."

import { Pressable, Text, View, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Echopay } from '../../constants/theme';

export function LocalTransferPill({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.pill, pressed && styles.pillPressed]}
    >
      <View style={styles.iconCircle}>
        <Ionicons name="cash-outline" size={22} color={Echopay.accent} />
      </View>
      <Text style={styles.label}>Local</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 8,
    borderRadius: 16,
    backgroundColor: Echopay.cardBg,
    borderWidth: 1,
    borderColor: Echopay.border,
    gap: 8,
  },
  pillPressed: {
    backgroundColor: Echopay.cardSoft,
    transform: [{ scale: 0.98 }],
  },
  iconCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Echopay.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: Echopay.text,
  },
});
