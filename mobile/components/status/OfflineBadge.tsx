// OfflineBadge — home-screen offline-budget card.
//
// Acts as the visual offline-state indicator: when isOnline=false, the
// card promotes to visual primary (accent hairline + heavier value
// weight) per PRD_LEKE §3.15. Renders the offline-spendable balance and
// taps through to /offline-wallet.
//
// Extracted from app/(tabs)/index.tsx so the home file stops sprawling
// (PRD_LEKE §5.1 polish item).

import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Echopay } from '../../constants/theme';

export interface OfflineBadgeProps {
  /** Decimal naira string from account.locked_balance (e.g. "50000.00"). */
  lockedBalance: string;
  /** Drives the accent-primary styling when false. */
  isOnline: boolean;
  onPress: () => void;
}

export default function OfflineBadge({
  lockedBalance,
  isOnline,
  onPress,
}: OfflineBadgeProps) {
  const hasFunds = lockedBalance !== '0.00';
  return (
    <Pressable
      style={[styles.card, !isOnline && styles.cardActive]}
      onPress={onPress}
    >
      <View style={styles.iconCircle}>
        <Ionicons name="lock-closed-outline" size={18} color={Echopay.accent} />
      </View>
      <View style={styles.body}>
        <Text style={[styles.label, !isOnline && styles.labelActive]}>
          Offline budget
        </Text>
        <Text style={styles.hint}>
          {hasFunds
            ? 'Manage your offline-spendable funds →'
            : 'Set aside funds for offline use →'}
        </Text>
      </View>
      <Text style={[styles.value, !isOnline && styles.valueActive]}>
        ₦
        {Number(lockedBalance).toLocaleString('en-NG', {
          minimumFractionDigits: 0,
        })}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Echopay.cardBg,
    borderWidth: 1,
    borderColor: Echopay.border,
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 14,
    gap: 14,
    marginBottom: 22,
  },
  iconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Echopay.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: { flex: 1 },
  label: { fontSize: 13, color: Echopay.textMuted, fontWeight: '600' },
  hint: { fontSize: 12, color: Echopay.textSubtle, marginTop: 2 },
  value: { fontSize: 17, fontWeight: '700', color: Echopay.text },
  // PRD_LEKE §3.15 — offline state promotes this card to visual primary.
  cardActive: { borderColor: Echopay.accent },
  labelActive: { color: Echopay.text },
  valueActive: { fontWeight: '800' },
});
