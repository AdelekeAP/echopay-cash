import { useState, useCallback } from 'react';
import {
  Alert,
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  RefreshControl,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../../context/AuthContext';
import { Echopay } from '../../constants/theme';
import { LocalTransferPill } from '../../components/local-transfer/Pill';
import OfflineBadge from '../../components/status/OfflineBadge';
import TransactionRow from '../../components/transactions/TransactionRow';
import VoiceIntentModal from '../../components/voice/VoiceIntentModal';
import { useNetworkStatus } from '../../hooks/useNetworkStatus';
import { useTransactions } from '../../hooks/useTransactions';
import { getOutboxPendingCount } from '../../services/cache';
import { formatKoboToNaira } from '../../utils/format';

export default function HomeScreen() {
  const { user, account, refreshAccount } = useAuth();
  const router = useRouter();
  const { isOnline } = useNetworkStatus();
  const [refreshing, setRefreshing] = useState(false);
  const [showBalance, setShowBalance] = useState(true);
  const [pending, setPending] = useState(0);
  const [voiceIntentVisible, setVoiceIntentVisible] = useState(false);
  const { transactions, refresh: refreshTransactions } = useTransactions(5);

  // PRD_LEKE §3.14 — real voice intent handler. VoiceIntentModal calls
  // this with the parsed action + entities from POST /voice/intent.
  // The IntentPicker fallback inside VoiceIntentModal also calls it.
  const handleVoiceIntent = useCallback(
    (
      action: string,
      entities: { recipientId?: string; amountKobo?: number; balance_kobo?: number },
    ) => {
      setVoiceIntentVisible(false);
      if (action === 'transfer_local' && entities.recipientId) {
        router.push({
          pathname: '/local-transfer',
          params: {
            recipientId: entities.recipientId,
            amountKobo: String(entities.amountKobo ?? 0),
          },
        });
        return;
      }
      if (action === 'balance') {
        const kobo =
          entities.balance_kobo ??
          Math.round(parseFloat(account?.balance ?? '0') * 100);
        Alert.alert('Available balance', formatKoboToNaira(kobo), [
          { text: 'OK' },
        ]);
      }
    },
    [router, account?.balance],
  );

  // Refresh data when screen comes into focus (e.g., after a local
  // transfer; PRD_LEKE §3.13). useTransactions already auto-loads on
  // mount; this re-runs on every focus so a fresh local transfer or
  // QR receive shows up immediately without a manual pull-to-refresh.
  useFocusEffect(
    useCallback(() => {
      refreshTransactions();
      refreshAccount();
      if (user?.id) {
        getOutboxPendingCount(user.id).then(setPending).catch(() => setPending(0));
      }
    }, [refreshTransactions, refreshAccount, user?.id])
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        refreshAccount(),
        refreshTransactions(),
        user?.id ? getOutboxPendingCount(user.id).then(setPending) : Promise.resolve(),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [refreshAccount, refreshTransactions, user?.id]);

  const formatCurrency = (amount: string) => {
    const num = parseFloat(amount);
    return new Intl.NumberFormat('en-NG', {
      style: 'currency',
      currency: 'NGN',
      minimumFractionDigits: 0,
    }).format(num);
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Echopay.accent} />
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
            <Pressable style={styles.iconButton} hitSlop={8}>
              <Ionicons name="search-outline" size={22} color={Echopay.text} />
            </Pressable>
            <Pressable style={styles.iconButton} hitSlop={8}>
              <Ionicons name="notifications-outline" size={22} color={Echopay.text} />
              <View style={styles.notificationBadge} />
            </Pressable>
          </View>
        </View>

        {/* Balance card — flat (no gradient per palette law) */}
        <View style={styles.balanceCard}>
          <View style={styles.cardHeader}>
            <View style={styles.bankBadge}>
              <Ionicons name="business-outline" size={14} color={Echopay.text} />
              <Text style={styles.bankBadgeText}>{account?.bank?.name || 'Bank'}</Text>
            </View>
            <Pressable onPress={() => setShowBalance(!showBalance)} hitSlop={10}>
              <Ionicons
                name={showBalance ? 'eye-outline' : 'eye-off-outline'}
                size={22}
                color={Echopay.textMuted}
              />
            </Pressable>
          </View>

          <View style={styles.balanceSection}>
            <Text style={[styles.balanceLabel, !isOnline && styles.balanceLabelOffline]}>
              Available balance
            </Text>
            <Text style={[styles.balanceAmount, !isOnline && styles.balanceAmountOffline]}>
              {showBalance ? formatCurrency(account?.balance || '0') : '••••••'}
            </Text>
            <Text style={[styles.balanceMeta, !isOnline && styles.balanceMetaOffline]}>
              {isOnline ? 'As of just now' : 'Offline — last known'}
            </Text>
          </View>

          <View style={styles.cardFooter}>
            <View>
              <Text style={styles.accountLabel}>Account number</Text>
              <Text style={styles.accountNumber}>{account?.account_number}</Text>
            </View>
            <Pressable style={styles.copyPill} hitSlop={6}>
              <Ionicons name="copy-outline" size={14} color={Echopay.textMuted} />
              <Text style={styles.copyPillText}>Copy</Text>
            </Pressable>
          </View>
        </View>

        {/* Offline-spendable budget — promotes to visual primary when
            isOnline=false per PRD_LEKE §3.15. */}
        <OfflineBadge
          lockedBalance={account?.locked_balance ?? '0.00'}
          isOnline={isOnline}
          onPress={() => router.push('/offline-wallet')}
        />

        {/* Quick actions — Send + SLOT (Funbi's pill) + Receive */}
        <View style={styles.quickActionsContainer}>
          <Pressable style={styles.actionPill} onPress={() => router.push('/transfer')}>
            <View style={styles.actionPillIcon}>
              <Ionicons name="paper-plane-outline" size={22} color={Echopay.accent} />
            </View>
            <Text style={styles.actionPillLabel}>Send</Text>
          </Pressable>
          <LocalTransferPill onPress={() => router.push('/local-transfer')} />

          <Pressable style={styles.actionPill} onPress={() => router.push('/receive')}>
            <View style={styles.actionPillIcon}>
              <Ionicons name="qr-code-outline" size={22} color={Echopay.accent} />
            </View>
            <Text style={styles.actionPillLabel}>Receive</Text>
          </Pressable>
        </View>

        {/* Voice-banking hint — taps open the IntentPicker (PRD_LEKE §3.14
            mock-dropdown). Real /voice/intent wiring is a follow-up PR. */}
        <Pressable
          style={({ pressed }) => [
            styles.voiceHintCard,
            pressed && styles.voiceHintCardPressed,
          ]}
          onPress={() => setVoiceIntentVisible(true)}
          hitSlop={4}
        >
          <View style={styles.voiceHintLeft}>
            <View style={styles.voiceHintIcon}>
              <Ionicons name="mic" size={22} color={Echopay.accent} />
            </View>
            <View>
              <Text style={styles.voiceHintTitle}>Voice banking</Text>
              <Text style={styles.voiceHintSubtitle}>Try &ldquo;Send ₦5,000 to Iya Tope&rdquo;</Text>
            </View>
          </View>
          <Ionicons name="arrow-forward" size={18} color={Echopay.textMuted} />
        </Pressable>

        {/* Recent Transactions — PRD_LEKE §3.13. Reads from Funbi's
            cache hook so local-transfers + QR receives + offline-mock
            entries all show up here automatically. */}
        <View style={styles.transactionsSection}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Recent transactions</Text>
            {pending > 0 && (
              <View style={styles.syncChip}>
                <Ionicons name="sync-outline" size={11} color={Echopay.accent} />
                <Text style={styles.syncChipText}>
                  {pending === 1 ? '1 waiting to sync' : `${pending} waiting to sync`}
                </Text>
              </View>
            )}
            <Pressable onPress={() => router.push('/(tabs)/transactions')} hitSlop={8}>
              <Text style={styles.seeAllText}>See all</Text>
            </Pressable>
          </View>

          <View style={styles.transactionsList}>
            {transactions.length === 0 ? (
              <View style={styles.emptyState}>
                <View style={styles.emptyIconContainer}>
                  <Ionicons name="receipt-outline" size={32} color={Echopay.textSubtle} />
                </View>
                <Text style={styles.emptyTitle}>No transactions yet</Text>
                <Text style={styles.emptySubtitle}>Your activity will appear here</Text>
              </View>
            ) : (
              transactions.map((txn) => (
                <TransactionRow key={txn.id} transaction={txn} />
              ))
            )}
          </View>
        </View>

        {/* Bottom Spacer for floating tab bar */}
        <View style={{ height: 100 }} />
      </ScrollView>

      <VoiceIntentModal
        visible={voiceIntentVisible}
        onClose={() => setVoiceIntentVisible(false)}
        onIntent={handleVoiceIntent}
      />
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
    backgroundColor: Echopay.pageBg,
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
    backgroundColor: Echopay.cardSoft,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: {
    color: Echopay.text,
    fontSize: 16,
    fontWeight: '700',
  },
  headerTextContainer: {
    marginLeft: 12,
  },
  greeting: {
    fontSize: 13,
    color: Echopay.textMuted,
  },
  userName: {
    fontSize: 18,
    fontWeight: '700',
    color: Echopay.text,
  },
  headerRight: {
    flexDirection: 'row',
    gap: 8,
  },
  iconButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: Echopay.cardBg,
    borderWidth: 1,
    borderColor: Echopay.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  notificationBadge: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Echopay.accent,
  },

  // Balance card — flat
  balanceCard: {
    marginTop: 8,
    backgroundColor: Echopay.cardBg,
    borderWidth: 1,
    borderColor: Echopay.border,
    borderRadius: 18,
    padding: 22,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  bankBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Echopay.cardSoft,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    gap: 6,
  },
  bankBadgeText: {
    color: Echopay.text,
    fontSize: 12,
    fontWeight: '600',
  },
  balanceSection: {
    marginTop: 22,
  },
  balanceLabel: {
    fontSize: 13,
    color: Echopay.textMuted,
    marginBottom: 6,
  },
  balanceAmount: {
    fontSize: 32,
    fontWeight: '800',
    color: Echopay.text,
    letterSpacing: -0.6,
  },
  balanceMeta: {
    fontSize: 12,
    color: Echopay.textSubtle,
    marginTop: 4,
  },
  // §3.15 offline-aware contrast: when !isOnline, dim the online row to
  // shift visual primacy onto the offline-budget card.
  balanceLabelOffline: { color: Echopay.textSubtle },
  balanceAmountOffline: { opacity: 0.5, fontWeight: '600' },
  balanceMetaOffline: { color: Echopay.danger },
  cardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    marginTop: 18,
  },
  accountLabel: {
    fontSize: 11,
    color: Echopay.textMuted,
    marginBottom: 4,
  },
  accountNumber: {
    fontSize: 15,
    fontWeight: '600',
    color: Echopay.text,
    letterSpacing: 1.5,
  },
  copyPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: Echopay.cardSoft,
  },
  copyPillText: {
    fontSize: 12,
    color: Echopay.textMuted,
    fontWeight: '600',
  },

  // Quick actions
  quickActionsContainer: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginTop: 20,
    backgroundColor: Echopay.cardBg,
    borderWidth: 1,
    borderColor: Echopay.border,
    borderRadius: 18,
    padding: 18,
  },
  actionPill: {
    alignItems: 'center',
    flex: 1,
  },
  actionPillIcon: {
    width: 52,
    height: 52,
    borderRadius: 16,
    backgroundColor: Echopay.accentSoft,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8,
  },
  actionPillLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: Echopay.text,
  },

  // Voice-banking hint
  voiceHintCard: {
    marginTop: 18,
    backgroundColor: Echopay.cardSoft,
    borderRadius: 14,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  voiceHintCardPressed: {
    backgroundColor: Echopay.accentSoft,
  },
  voiceHintLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  voiceHintIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: Echopay.accentSoft,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  voiceHintTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: Echopay.text,
  },
  voiceHintSubtitle: {
    fontSize: 12,
    color: Echopay.textMuted,
    marginTop: 2,
  },

  // Transactions
  transactionsSection: {
    marginTop: 22,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: Echopay.text,
  },
  seeAllText: {
    fontSize: 13,
    fontWeight: '600',
    color: Echopay.accent,
  },
  // §3.13 — pending-sync chip surfaced when Funbi's outbox has rows.
  syncChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Echopay.accentSoft,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  syncChipText: {
    fontSize: 11,
    fontWeight: '700',
    color: Echopay.accent,
    letterSpacing: 0.2,
  },
  transactionsList: {
    backgroundColor: Echopay.cardBg,
    borderWidth: 1,
    borderColor: Echopay.border,
    borderRadius: 18,
    overflow: 'hidden',
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 40,
  },
  emptyIconContainer: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: Echopay.cardSoft,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: Echopay.textMuted,
  },
  emptySubtitle: {
    fontSize: 13,
    color: Echopay.textSubtle,
    marginTop: 4,
  },
});

