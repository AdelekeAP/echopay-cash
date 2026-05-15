// TransactionRow — renders a single row in the home tab's recent
// transactions list.
//
// Reads the modern TransactionRow shape from services/cache.ts via
// types/transaction.ts (PRD_LEKE §3.13). Helpers (icon, label, relative
// date) live next to the renderer so the home file stops sprawling.
//
// Scope note: (tabs)/transactions.tsx still uses the divergent
// Transaction type from the dead api.ts path, so it does NOT consume
// this component yet. Migration is gated on a backend list-history
// endpoint that doesn't exist.

import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Echopay } from '../../constants/theme';
import {
  TransactionDirection,
  TransactionRow as TransactionRowData,
  TransactionType,
} from '../../types/transaction';
import { formatKoboToNaira } from '../../utils/format';

export interface TransactionRowProps {
  transaction: TransactionRowData;
  onPress?: (txn: TransactionRowData) => void;
}

// PRD_LEKE §3.13 — TransactionRow uses (type, direction) instead of the
// legacy `transaction_type` string.
function getIcon(type: TransactionType, direction: TransactionDirection) {
  if (direction === 'in') {
    if (type === 'qr_receive') {
      return { name: 'qr-code', color: Echopay.success, bg: Echopay.successSoft };
    }
    if (type === 'topup') {
      return { name: 'add-circle', color: Echopay.success, bg: Echopay.successSoft };
    }
    return { name: 'arrow-down', color: Echopay.success, bg: Echopay.successSoft };
  }
  // direction === 'out'
  return { name: 'arrow-up', color: Echopay.danger, bg: Echopay.dangerSoft };
}

function getLabel(type: TransactionType): string {
  switch (type) {
    case 'in_network':
      return 'EchoPay transfer';
    case 'external_out':
      return 'Bank transfer';
    case 'qr_receive':
      return 'QR receive';
    case 'topup':
      return 'Top-up';
    default:
      return type;
  }
}

// Relative time for ISO-8601 strings from TransactionRow.created_at.
function formatRelativeDate(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return date.toLocaleDateString('en-NG', { day: 'numeric', month: 'short' });
}

export default function TransactionRow({ transaction, onPress }: TransactionRowProps) {
  const isDebit = transaction.direction === 'out';
  const icon = getIcon(transaction.type, transaction.direction);
  const label = getLabel(transaction.type);
  const counterparty = transaction.counterparty || (isDebit ? 'Sent' : 'Received');

  return (
    <Pressable
      style={styles.row}
      onPress={onPress ? () => onPress(transaction) : undefined}
    >
      <View style={[styles.iconContainer, { backgroundColor: icon.bg }]}>
        <Ionicons name={icon.name as any} size={18} color={icon.color} />
      </View>
      <View style={styles.details}>
        <Text style={styles.title} numberOfLines={1}>
          {counterparty}
        </Text>
        <Text style={styles.subtitle}>
          {label} • {formatRelativeDate(transaction.created_at)}
        </Text>
      </View>
      <Text style={[styles.amount, isDebit && styles.amountDebit]}>
        {isDebit ? '-' : '+'}
        {formatKoboToNaira(transaction.amount_kobo)}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: Echopay.border,
  },
  iconContainer: {
    width: 44,
    height: 44,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  details: {
    flex: 1,
    marginLeft: 14,
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
    color: Echopay.text,
  },
  subtitle: {
    fontSize: 12,
    color: Echopay.textSubtle,
    marginTop: 3,
  },
  amount: {
    fontSize: 15,
    fontWeight: '700',
    color: Echopay.success,
  },
  amountDebit: {
    color: Echopay.danger,
  },
});
