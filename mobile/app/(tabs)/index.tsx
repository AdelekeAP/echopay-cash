import { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  RefreshControl,
  Dimensions,
  Image,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../../context/AuthContext';
import { transactionAPI } from '../../services/api';
import { Transaction } from '../../types';

const { width } = Dimensions.get('window');

export default function HomeScreen() {
  const { user, account, refreshAccount } = useAuth();
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);
  const [showBalance, setShowBalance] = useState(true);
  const [transactions, setTransactions] = useState<Transaction[]>([]);

  // Refresh data when screen comes into focus (e.g., after voice transfer)
  useFocusEffect(
    useCallback(() => {
      loadTransactions();
      refreshAccount();
    }, [])
  );

  const loadTransactions = async () => {
    try {
      const data = await transactionAPI.getTransactions();
      setTransactions(data.slice(0, 5)); // Get last 5
    } catch (error) {
      console.error('Error loading transactions:', error);
    }
  };

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([refreshAccount(), loadTransactions()]);
    setRefreshing(false);
  }, []);

  const formatCurrency = (amount: string) => {
    const num = parseFloat(amount);
    return new Intl.NumberFormat('en-NG', {
      style: 'currency',
      currency: 'NGN',
      minimumFractionDigits: 0,
    }).format(num);
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return `${days} days ago`;
    return date.toLocaleDateString('en-NG', { day: 'numeric', month: 'short' });
  };

  const getTransactionIcon = (type: string) => {
    switch (type) {
      case 'transfer_out':
        return { name: 'arrow-up', color: '#E31937', bg: '#FFE5E8' };
      case 'transfer_in':
        return { name: 'arrow-down', color: '#00C853', bg: '#E8F5E9' };
      case 'deposit':
        return { name: 'add', color: '#00C853', bg: '#E8F5E9' };
      default:
        return { name: 'swap-horizontal', color: '#666', bg: '#f0f0f0' };
    }
  };

  const quickActions = [
    { icon: 'paper-plane', label: 'Send', color: '#E31937', bg: '#FFE5E8', route: '/transfer' },
    { icon: 'download', label: 'Request', color: '#7C4DFF', bg: '#EDE7F6', route: null },
    { icon: 'flash', label: 'Airtime', color: '#FF9800', bg: '#FFF3E0', route: null },
    { icon: 'receipt', label: 'Bills', color: '#00BCD4', bg: '#E0F7FA', route: null },
  ];

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#E31937" />
        }
      >
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>
                {user?.first_name?.[0]}{user?.last_name?.[0]}
              </Text>
            </View>
            <View style={styles.headerTextContainer}>
              <Text style={styles.greeting}>Good {getGreeting()},</Text>
              <Text style={styles.userName}>{user?.first_name || 'User'}</Text>
            </View>
          </View>
          <View style={styles.headerRight}>
            <TouchableOpacity style={styles.iconButton}>
              <Ionicons name="search-outline" size={22} color="#333" />
            </TouchableOpacity>
            <TouchableOpacity style={styles.iconButton}>
              <Ionicons name="notifications-outline" size={22} color="#333" />
              <View style={styles.notificationBadge} />
            </TouchableOpacity>
          </View>
        </View>

        {/* Premium Balance Card */}
        <View style={styles.cardContainer}>
          <LinearGradient
            colors={['#E31937', '#B71C1C']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.balanceCard}
          >
            <View style={styles.cardPattern}>
              <View style={styles.circle1} />
              <View style={styles.circle2} />
            </View>

            <View style={styles.cardHeader}>
              <View style={styles.bankBadge}>
                <Ionicons name="business" size={14} color="#fff" />
                <Text style={styles.bankBadgeText}>{account?.bank?.name || 'Bank'}</Text>
              </View>
              <TouchableOpacity onPress={() => setShowBalance(!showBalance)}>
                <Ionicons
                  name={showBalance ? 'eye-outline' : 'eye-off-outline'}
                  size={22}
                  color="rgba(255,255,255,0.8)"
                />
              </TouchableOpacity>
            </View>

            <View style={styles.balanceSection}>
              <Text style={styles.balanceLabel}>Total Balance</Text>
              <Text style={styles.balanceAmount}>
                {showBalance ? formatCurrency(account?.balance || '0') : '••••••'}
              </Text>
            </View>

            <View style={styles.cardFooter}>
              <View>
                <Text style={styles.accountLabel}>Account Number</Text>
                <Text style={styles.accountNumber}>{account?.account_number}</Text>
              </View>
              <View style={styles.cardChip}>
                <Ionicons name="wifi" size={20} color="rgba(255,255,255,0.6)" style={{ transform: [{ rotate: '90deg' }] }} />
              </View>
            </View>
          </LinearGradient>
        </View>

        {/* Quick Actions */}
        <View style={styles.quickActionsContainer}>
          {quickActions.map((action, index) => (
            <TouchableOpacity
              key={index}
              style={styles.quickActionItem}
              onPress={() => action.route && router.push(action.route as any)}
            >
              <View style={[styles.quickActionIcon, { backgroundColor: action.bg }]}>
                <Ionicons name={action.icon as any} size={22} color={action.color} />
              </View>
              <Text style={styles.quickActionLabel}>{action.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Promo Card */}
        <TouchableOpacity style={styles.promoCard}>
          <LinearGradient
            colors={['#1a1a1a', '#333']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.promoGradient}
          >
            <View style={styles.promoLeft}>
              <View style={styles.promoIconContainer}>
                <Ionicons name="mic" size={24} color="#E31937" />
              </View>
              <View style={styles.promoTextContainer}>
                <Text style={styles.promoTitle}>Voice Banking</Text>
                <Text style={styles.promoSubtitle}>Try "Send 5000 to Ade"</Text>
              </View>
            </View>
            <View style={styles.promoArrow}>
              <Ionicons name="arrow-forward" size={20} color="#fff" />
            </View>
          </LinearGradient>
        </TouchableOpacity>

        {/* Recent Transactions */}
        <View style={styles.transactionsSection}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Recent Transactions</Text>
            <TouchableOpacity onPress={() => router.push('/(tabs)/transactions')}>
              <Text style={styles.seeAllText}>See All</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.transactionsList}>
            {transactions.length === 0 ? (
              <View style={styles.emptyState}>
                <View style={styles.emptyIconContainer}>
                  <Ionicons name="receipt-outline" size={32} color="#ccc" />
                </View>
                <Text style={styles.emptyTitle}>No transactions yet</Text>
                <Text style={styles.emptySubtitle}>Your activity will appear here</Text>
              </View>
            ) : (
              transactions.map((txn, index) => {
                const icon = getTransactionIcon(txn.transaction_type);
                const isDebit = txn.transaction_type === 'transfer_out';
                return (
                  <TouchableOpacity key={txn.id} style={styles.transactionItem}>
                    <View style={[styles.txnIconContainer, { backgroundColor: icon.bg }]}>
                      <Ionicons name={icon.name as any} size={18} color={icon.color} />
                    </View>
                    <View style={styles.txnDetails}>
                      <Text style={styles.txnTitle} numberOfLines={1}>
                        {txn.recipient_name || (isDebit ? 'Transfer Out' : 'Transfer In')}
                      </Text>
                      <Text style={styles.txnSubtitle}>
                        {txn.recipient_bank || txn.description} • {formatDate(txn.timestamp)}
                      </Text>
                    </View>
                    <Text style={[styles.txnAmount, isDebit && styles.txnAmountDebit]}>
                      {isDebit ? '-' : '+'}{formatCurrency(txn.amount)}
                    </Text>
                  </TouchableOpacity>
                );
              })
            )}
          </View>
        </View>

        {/* Bottom Spacer for floating tab bar */}
        <View style={{ height: 100 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8f9fa',
  },
  scrollContent: {
    paddingHorizontal: 20,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 16,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#E31937',
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  headerTextContainer: {
    marginLeft: 12,
  },
  greeting: {
    fontSize: 13,
    color: '#666',
  },
  userName: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1a1a1a',
  },
  headerRight: {
    flexDirection: 'row',
    gap: 8,
  },
  iconButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#fff',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  notificationBadge: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#E31937',
  },
  cardContainer: {
    marginTop: 8,
  },
  balanceCard: {
    borderRadius: 24,
    padding: 24,
    overflow: 'hidden',
    minHeight: 200,
  },
  cardPattern: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  circle1: {
    position: 'absolute',
    top: -60,
    right: -60,
    width: 200,
    height: 200,
    borderRadius: 100,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  circle2: {
    position: 'absolute',
    bottom: -80,
    left: -40,
    width: 180,
    height: 180,
    borderRadius: 90,
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  bankBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.2)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    gap: 6,
  },
  bankBadgeText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  balanceSection: {
    marginTop: 24,
  },
  balanceLabel: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.7)',
    marginBottom: 8,
  },
  balanceAmount: {
    fontSize: 36,
    fontWeight: '700',
    color: '#fff',
    letterSpacing: -1,
  },
  cardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    marginTop: 24,
  },
  accountLabel: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.6)',
    marginBottom: 4,
  },
  accountNumber: {
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
    letterSpacing: 2,
  },
  cardChip: {
    width: 40,
    height: 30,
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: 6,
    justifyContent: 'center',
    alignItems: 'center',
  },
  quickActionsContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 24,
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 12,
    elevation: 3,
  },
  quickActionItem: {
    alignItems: 'center',
    flex: 1,
  },
  quickActionIcon: {
    width: 52,
    height: 52,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8,
  },
  quickActionLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#333',
  },
  promoCard: {
    marginTop: 20,
    borderRadius: 16,
    overflow: 'hidden',
  },
  promoGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
  },
  promoLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  promoIconContainer: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: 'rgba(227,25,55,0.15)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  promoTextContainer: {
    marginLeft: 14,
  },
  promoTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#fff',
  },
  promoSubtitle: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.6)',
    marginTop: 2,
  },
  promoArrow: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.1)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  transactionsSection: {
    marginTop: 24,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1a1a1a',
  },
  seeAllText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#E31937',
  },
  transactionsList: {
    backgroundColor: '#fff',
    borderRadius: 20,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 12,
    elevation: 3,
  },
  transactionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#f5f5f5',
  },
  txnIconContainer: {
    width: 44,
    height: 44,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  txnDetails: {
    flex: 1,
    marginLeft: 14,
  },
  txnTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1a1a1a',
  },
  txnSubtitle: {
    fontSize: 12,
    color: '#999',
    marginTop: 3,
  },
  txnAmount: {
    fontSize: 15,
    fontWeight: '700',
    color: '#00C853',
  },
  txnAmountDebit: {
    color: '#E31937',
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 40,
  },
  emptyIconContainer: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#f5f5f5',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#666',
  },
  emptySubtitle: {
    fontSize: 13,
    color: '#999',
    marginTop: 4,
  },
});
