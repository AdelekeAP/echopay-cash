import { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { transactionAPI } from '../../services/api';
import { Transaction } from '../../types';
import { Echopay } from '../../constants/theme';

export default function TransactionsScreen() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadTransactions = async () => {
    try {
      const data = await transactionAPI.getTransactions();
      setTransactions(data);
    } catch {
      // transactionAPI.getTransactions() hits GET /transactions/ — a
      // legacy demo-bank endpoint that doesn't exist on the
      // echopay-cash backend (404). The home tab's useTransactions
      // hook reads from the real backend via squad-api; this History
      // tab falls back to an empty list. TODO(phase-1): migrate this
      // screen to use the same squad-api source as the home tab.
      setTransactions([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTransactions();
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadTransactions();
    setRefreshing(false);
  }, []);

  const formatCurrency = (amount: string) => {
    const num = parseFloat(amount);
    return new Intl.NumberFormat('en-NG', {
      style: 'currency',
      currency: 'NGN',
      minimumFractionDigits: 2,
    }).format(num);
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-NG', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getTransactionIcon = (type: string) => {
    switch (type) {
      case 'transfer_out':
        return { name: 'arrow-up-circle', color: Echopay.danger, bg: Echopay.dangerSoft };
      case 'transfer_in':
        return { name: 'arrow-down-circle', color: Echopay.success, bg: Echopay.successSoft };
      case 'deposit':
        return { name: 'add-circle', color: Echopay.success, bg: Echopay.successSoft };
      case 'withdrawal':
        return { name: 'remove-circle', color: Echopay.danger, bg: Echopay.dangerSoft };
      default:
        return { name: 'swap-horizontal', color: Echopay.textMuted, bg: Echopay.cardSoft };
    }
  };

  const getTransactionLabel = (type: string) => {
    switch (type) {
      case 'transfer_out':
        return 'Transfer Out';
      case 'transfer_in':
        return 'Transfer In';
      case 'deposit':
        return 'Deposit';
      case 'withdrawal':
        return 'Withdrawal';
      default:
        return type;
    }
  };

  const renderTransaction = ({ item }: { item: Transaction }) => {
    const icon = getTransactionIcon(item.transaction_type);
    const isDebit = item.transaction_type === 'transfer_out' || item.transaction_type === 'withdrawal';

    return (
      <View style={styles.transactionItem}>
        <View style={[styles.iconContainer, { backgroundColor: icon.bg }]}>
          <Ionicons name={icon.name as any} size={24} color={icon.color} />
        </View>
        <View style={styles.transactionDetails}>
          <Text style={styles.transactionTitle}>
            {item.recipient_name || getTransactionLabel(item.transaction_type)}
          </Text>
          <Text style={styles.transactionSubtitle}>
            {item.recipient_bank || item.description}
          </Text>
          <Text style={styles.transactionDate}>{formatDate(item.timestamp)}</Text>
        </View>
        <Text style={[styles.transactionAmount, isDebit && styles.debitAmount]}>
          {isDebit ? '-' : '+'}{formatCurrency(item.amount)}
        </Text>
      </View>
    );
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={Echopay.accent} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Transaction History</Text>
      </View>

      {transactions.length === 0 ? (
        <View style={styles.emptyContainer}>
          <View style={styles.emptyIconCircle}>
            <Ionicons name="receipt-outline" size={32} color={Echopay.textSubtle} />
          </View>
          <Text style={styles.emptyTitle}>No transactions yet</Text>
          <Text style={styles.emptySubtitle}>
            Your transaction history will appear here
          </Text>
        </View>
      ) : (
        <FlatList
          data={transactions}
          renderItem={renderTransaction}
          keyExtractor={(item) => item.id.toString()}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={Echopay.accent}
            />
          }
          ItemSeparatorComponent={() => <View style={styles.separator} />}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Echopay.pageBg,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  header: {
    padding: 20,
    backgroundColor: Echopay.cardBg,
    borderBottomWidth: 1,
    borderBottomColor: Echopay.border,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: Echopay.text,
    letterSpacing: -0.4,
  },
  listContent: {
    padding: 16,
  },
  transactionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Echopay.cardBg,
    borderWidth: 1,
    borderColor: Echopay.border,
    padding: 16,
    borderRadius: 14,
  },
  iconContainer: {
    width: 44,
    height: 44,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  transactionDetails: {
    flex: 1,
    marginLeft: 12,
  },
  transactionTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: Echopay.text,
  },
  transactionSubtitle: {
    fontSize: 13,
    color: Echopay.textMuted,
    marginTop: 2,
  },
  transactionDate: {
    fontSize: 12,
    color: Echopay.textSubtle,
    marginTop: 4,
  },
  transactionAmount: {
    fontSize: 15,
    fontWeight: '700',
    color: Echopay.success,
  },
  debitAmount: {
    color: Echopay.danger,
  },
  separator: {
    height: 10,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
  },
  emptyIconCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: Echopay.cardSoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: Echopay.textMuted,
  },
  emptySubtitle: {
    fontSize: 13,
    color: Echopay.textSubtle,
    marginTop: 6,
    textAlign: 'center',
  },
});
