import { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useAuth } from '../../context/AuthContext';
import VoiceEnrollment from '../../components/VoiceEnrollment';
import { voiceBiometricsService, VoiceProfileResponse } from '../../services/voiceService';

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
      // Show options for existing enrollment
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
      // Start enrollment
      setShowVoiceEnrollment(true);
    }
  };

  const handleReenroll = async () => {
    // Delete first, then enroll
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

  const menuItems = [
    { icon: 'person-outline', label: 'Personal Information', onPress: () => {} },
    { icon: 'card-outline', label: 'Card Management', onPress: () => {} },
    {
      icon: 'mic-outline',
      label: 'Voice ID',
      onPress: handleVoiceSettings,
      badge: voiceProfile ? 'Active' : 'Not Set',
      badgeColor: voiceProfile ? '#00B050' : '#666',
    },
    { icon: 'lock-closed-outline', label: 'Security Settings', onPress: () => {} },
    { icon: 'notifications-outline', label: 'Notifications', onPress: () => {} },
    { icon: 'help-circle-outline', label: 'Help & Support', onPress: () => {} },
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
          <Text style={styles.accountLabel}>Account Number</Text>
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
          <TouchableOpacity
            key={index}
            style={styles.menuItem}
            onPress={item.onPress}
          >
            <Ionicons name={item.icon as any} size={24} color="#666" />
            <Text style={styles.menuLabel}>{item.label}</Text>
            {item.badge && (
              <View style={[styles.badge, { backgroundColor: item.badgeColor + '20' }]}>
                <Text style={[styles.badgeText, { color: item.badgeColor }]}>
                  {item.badge}
                </Text>
              </View>
            )}
            <Ionicons name="chevron-forward" size={20} color="#ccc" />
          </TouchableOpacity>
        ))}
      </View>

      {/* Logout Button */}
      <TouchableOpacity style={styles.logoutButton} onPress={handleLogout}>
        <Ionicons name="log-out-outline" size={24} color="#E31937" />
        <Text style={styles.logoutText}>Logout</Text>
      </TouchableOpacity>

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
    backgroundColor: '#f5f5f5',
  },
  header: {
    padding: 20,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#1a1a1a',
  },
  userCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    padding: 20,
    margin: 16,
    borderRadius: 16,
  },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#E31937',
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#fff',
  },
  userInfo: {
    marginLeft: 16,
    flex: 1,
  },
  userName: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1a1a1a',
  },
  userEmail: {
    fontSize: 14,
    color: '#666',
    marginTop: 4,
  },
  userPhone: {
    fontSize: 14,
    color: '#666',
    marginTop: 2,
  },
  accountCard: {
    backgroundColor: '#fff',
    marginHorizontal: 16,
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
  },
  accountRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
  },
  accountLabel: {
    fontSize: 14,
    color: '#666',
  },
  accountValue: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1a1a1a',
  },
  divider: {
    height: 1,
    backgroundColor: '#eee',
    marginVertical: 8,
  },
  menuContainer: {
    backgroundColor: '#fff',
    marginHorizontal: 16,
    borderRadius: 16,
    overflow: 'hidden',
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  menuLabel: {
    flex: 1,
    fontSize: 16,
    color: '#333',
    marginLeft: 12,
  },
  logoutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
    margin: 16,
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#E31937',
  },
  logoutText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#E31937',
    marginLeft: 8,
  },
  version: {
    textAlign: 'center',
    fontSize: 12,
    color: '#999',
    marginBottom: 20,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    marginRight: 8,
  },
  badgeText: {
    fontSize: 12,
    fontWeight: '600',
  },
});
