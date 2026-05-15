import { useState, useEffect } from 'react';
import { View, Text, StyleSheet, Pressable, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useAuth } from '../../context/AuthContext';
import VoiceEnrollment from '../../components/VoiceEnrollment';
import { voiceBiometricsService, VoiceProfileResponse } from '../../services/voiceService';
import { Echopay } from '../../constants/theme';

export default function ProfileScreen() {
  const { user, account, logout } = useAuth();
  const router = useRouter();

  // Voice enrollment state
  const [showVoiceEnrollment, setShowVoiceEnrollment] = useState(false);
  const [voiceProfile, setVoiceProfile] = useState<VoiceProfileResponse['data'] | null>(null);
  const [loadingVoiceProfile, setLoadingVoiceProfile] = useState(true);

  // Load voice profile status
  useEffect(() => {
    loadVoiceProfile();
  }, [account?.account_number]);

  const loadVoiceProfile = async () => {
    if (!account?.account_number) {
      setLoadingVoiceProfile(false);
      return;
    }

    try {
      const profile = await voiceBiometricsService.getVoiceProfile(account.account_number);
      if (profile.success && profile.data) {
        setVoiceProfile(profile.data);
      } else {
        setVoiceProfile(null);
      }
    } catch (error) {
      console.log('Error loading voice profile:', error);
      setVoiceProfile(null);
    } finally {
      setLoadingVoiceProfile(false);
    }
  };

  const handleVoiceSettings = () => {
    if (voiceProfile) {
      Alert.alert(
        'Voice ID Settings',
        `Voice ID is enrolled.\n\nQuality: ${Math.round((voiceProfile.quality_score || 0) * 100)}%\nVerifications: ${voiceProfile.verification_count}`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Re-enroll',
            onPress: () => handleReenroll(),
          },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => handleDeleteVoiceProfile(),
          },
        ]
      );
    } else {
      setShowVoiceEnrollment(true);
    }
  };

  const handleReenroll = async () => {
    if (!account?.account_number) return;

    try {
      await voiceBiometricsService.deleteVoiceProfile(account.account_number);
      setVoiceProfile(null);
      setShowVoiceEnrollment(true);
    } catch (error) {
      Alert.alert('Error', 'Failed to reset voice profile. Please try again.');
    }
  };

  const handleDeleteVoiceProfile = async () => {
    if (!account?.account_number) return;

    Alert.alert(
      'Delete Voice ID',
      'Are you sure? You will need to re-enroll to use voice verification for transactions.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              const result = await voiceBiometricsService.deleteVoiceProfile(account.account_number);
              if (result.success) {
                setVoiceProfile(null);
                Alert.alert('Success', 'Voice ID has been deleted.');
              } else {
                Alert.alert('Error', result.message);
              }
            } catch (error) {
              Alert.alert('Error', 'Failed to delete voice profile.');
            }
          },
        },
      ]
    );
  };

  const handleVoiceEnrollmentSuccess = (enrollmentId: string) => {
    console.log('Voice enrolled:', enrollmentId);
    loadVoiceProfile();
    Alert.alert('Success', 'Voice ID has been set up successfully!');
  };

  const handleLogout = () => {
    Alert.alert(
      'Logout',
      'Are you sure you want to logout?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Logout',
          style: 'destructive',
          onPress: async () => {
            await logout();
            router.replace('/login');
          },
        },
      ]
    );
  };

  const menuItems: Array<{
    icon: string;
    label: string;
    onPress: () => void;
    badge?: string;
    badgeKind?: 'success' | 'muted';
  }> = [
    { icon: 'person-outline', label: 'Personal information', onPress: () => {} },
    { icon: 'card-outline', label: 'Card management', onPress: () => {} },
    {
      icon: 'mic-outline',
      label: 'Voice ID',
      onPress: handleVoiceSettings,
      badge: voiceProfile ? 'Active' : 'Not set',
      badgeKind: voiceProfile ? 'success' : 'muted',
    },
    { icon: 'lock-closed-outline', label: 'Security settings', onPress: () => {} },
    { icon: 'notifications-outline', label: 'Notifications', onPress: () => {} },
    { icon: 'help-circle-outline', label: 'Help & support', onPress: () => {} },
    { icon: 'information-circle-outline', label: 'About', onPress: () => {} },
  ];

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Profile</Text>
      </View>

      {/* User Info Card */}
      <View style={styles.userCard}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>
            {user?.first_name?.[0]}{user?.last_name?.[0]}
          </Text>
        </View>
        <View style={styles.userInfo}>
          <Text style={styles.userName}>
            {user?.first_name} {user?.last_name}
          </Text>
          <Text style={styles.userEmail}>{user?.email}</Text>
          <Text style={styles.userPhone}>{user?.phone_number}</Text>
        </View>
      </View>

      {/* Account Info */}
      <View style={styles.accountCard}>
        <View style={styles.accountRow}>
          <Text style={styles.accountLabel}>Account number</Text>
          <Text style={styles.accountValue}>{account?.account_number}</Text>
        </View>
        <View style={styles.divider} />
        <View style={styles.accountRow}>
          <Text style={styles.accountLabel}>Bank</Text>
          <Text style={styles.accountValue}>{account?.bank?.name}</Text>
        </View>
      </View>

      {/* Menu Items */}
      <View style={styles.menuContainer}>
        {menuItems.map((item, index) => (
          <Pressable
            key={index}
            style={({ pressed }) => [styles.menuItem, pressed && styles.menuItemPressed]}
            onPress={item.onPress}
          >
            <Ionicons name={item.icon as any} size={22} color={Echopay.textMuted} />
            <Text style={styles.menuLabel}>{item.label}</Text>
            {item.badge && (
              <View
                style={[
                  styles.badge,
                  item.badgeKind === 'success' ? styles.badgeSuccess : styles.badgeMuted,
                ]}
              >
                <Text
                  style={[
                    styles.badgeText,
                    item.badgeKind === 'success' ? styles.badgeTextSuccess : styles.badgeTextMuted,
                  ]}
                >
                  {item.badge}
                </Text>
              </View>
            )}
            <Ionicons name="chevron-forward" size={20} color={Echopay.textSubtle} />
          </Pressable>
        ))}
      </View>

      {/* Logout Button — secondary outline */}
      <Pressable
        style={({ pressed }) => [styles.logoutButton, pressed && styles.logoutButtonPressed]}
        onPress={handleLogout}
      >
        <Ionicons name="log-out-outline" size={22} color={Echopay.accent} />
        <Text style={styles.logoutText}>Logout</Text>
      </Pressable>

      <Text style={styles.version}>Version 1.0.0</Text>

      {/* Voice Enrollment Modal */}
      <VoiceEnrollment
        visible={showVoiceEnrollment}
        onClose={() => setShowVoiceEnrollment(false)}
        onSuccess={handleVoiceEnrollmentSuccess}
        accountNumber={account?.account_number || ''}
        companyId="1"
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Echopay.pageBg,
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
  userCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Echopay.cardBg,
    borderWidth: 1,
    borderColor: Echopay.border,
    padding: 18,
    margin: 16,
    borderRadius: 16,
  },
  avatar: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: Echopay.cardSoft,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: {
    fontSize: 22,
    fontWeight: '700',
    color: Echopay.text,
  },
  userInfo: {
    marginLeft: 16,
    flex: 1,
  },
  userName: {
    fontSize: 17,
    fontWeight: '700',
    color: Echopay.text,
  },
  userEmail: {
    fontSize: 13,
    color: Echopay.textMuted,
    marginTop: 3,
  },
  userPhone: {
    fontSize: 13,
    color: Echopay.textMuted,
    marginTop: 2,
  },
  accountCard: {
    backgroundColor: Echopay.cardBg,
    borderWidth: 1,
    borderColor: Echopay.border,
    marginHorizontal: 16,
    borderRadius: 16,
    padding: 14,
    marginBottom: 16,
  },
  accountRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
  },
  accountLabel: {
    fontSize: 13,
    color: Echopay.textMuted,
  },
  accountValue: {
    fontSize: 13,
    fontWeight: '600',
    color: Echopay.text,
  },
  divider: {
    height: 1,
    backgroundColor: Echopay.border,
    marginVertical: 6,
  },
  menuContainer: {
    backgroundColor: Echopay.cardBg,
    borderWidth: 1,
    borderColor: Echopay.border,
    marginHorizontal: 16,
    borderRadius: 16,
    overflow: 'hidden',
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: Echopay.border,
  },
  menuItemPressed: {
    backgroundColor: Echopay.cardSoft,
  },
  menuLabel: {
    flex: 1,
    fontSize: 15,
    color: Echopay.text,
    marginLeft: 12,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    marginRight: 8,
  },
  badgeSuccess: {
    backgroundColor: Echopay.successSoft,
  },
  badgeMuted: {
    backgroundColor: Echopay.cardSoft,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  badgeTextSuccess: {
    color: Echopay.success,
  },
  badgeTextMuted: {
    color: Echopay.textMuted,
  },
  logoutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
    margin: 16,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Echopay.accent,
    gap: 8,
  },
  logoutButtonPressed: {
    backgroundColor: Echopay.accentSoft,
  },
  logoutText: {
    fontSize: 15,
    fontWeight: '600',
    color: Echopay.accent,
  },
  version: {
    textAlign: 'center',
    fontSize: 12,
    color: Echopay.textSubtle,
    marginBottom: 24,
  },
});
