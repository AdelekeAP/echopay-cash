import { Tabs, useRouter } from 'expo-router';
import React, { useState, useCallback } from 'react';
import { Alert, Platform, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import FloatingMicButton from '../../components/voice/FloatingMicButton';
import VoiceIntentModal from '../../components/voice/VoiceIntentModal';
import { useAuth } from '../../context/AuthContext';
import { useWakeWord } from '../../hooks/useWakeWord';
import { useShakeDetection } from '../../hooks/useShakeDetection';
import { Echopay } from '../../constants/theme';
import { formatKoboToNaira } from '../../utils/format';

export default function TabLayout() {
  const [voiceModalVisible, setVoiceModalVisible] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [wakeWordEnabled, setWakeWordEnabled] = useState(true);
  const { account } = useAuth();
  const router = useRouter();

  // Open voice modal
  const handleMicPress = useCallback(() => {
    setVoiceModalVisible(true);
  }, []);

  // Wake word detection - "Hello Echo"
  // Disabled on web: @react-native-voice/voice has no web shim and the
  // legacy hook's retry-on-error loop spams startSpeech crashes forever.
  const { isListening: isWakeWordListening, isSupported: wakeWordSupported } = useWakeWord({
    onWakeWordDetected: handleMicPress,
    enabled: Platform.OS !== 'web' && wakeWordEnabled && !voiceModalVisible,
  });

  // Shake detection as fallback when wake word isn't supported (Expo Go)
  // Shake the phone to activate voice assistant
  useShakeDetection({
    onShake: handleMicPress,
    enabled: !wakeWordSupported && !voiceModalVisible, // Only enable if wake word not available
    sensitivity: 'medium',
  });

  const handleVoiceModalClose = () => {
    setVoiceModalVisible(false);
    setIsListening(false);
    setIsProcessing(false);
  };

  // Mirrors home screen's handleVoiceIntent (PRD_LEKE §3.14). Receives the
  // parsed action + entities from POST /voice/intent and routes accordingly.
  const handleVoiceIntent = useCallback(
    (
      action: string,
      entities: { recipientId?: string; amountKobo?: number; balance_kobo?: number },
    ) => {
      setVoiceModalVisible(false);
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
      if (action === 'qr_generate') {
        router.push({
          pathname: '/receive',
          params: { amount_kobo: String(entities.amountKobo ?? '') },
        });
        return;
      }
      if (action === 'balance') {
        const kobo =
          entities.balance_kobo ??
          Math.round(parseFloat(account?.balance ?? '0') * 100);
        Alert.alert('Available balance', formatKoboToNaira(kobo), [{ text: 'OK' }]);
      }
    },
    [router, account?.balance],
  );

  return (
    <View style={{ flex: 1 }}>
      <Tabs
        screenOptions={{
          tabBarActiveTintColor: Echopay.accent,
          tabBarInactiveTintColor: Echopay.textSubtle,
          headerShown: false,
          tabBarStyle: {
            position: 'absolute',
            bottom: 18,
            left: 24,
            right: 24,
            backgroundColor: Echopay.cardBg,
            borderRadius: 22,
            height: 56,
            paddingTop: 6,
            paddingBottom: Platform.OS === 'ios' ? 6 : 6,
            borderTopWidth: 1,
            borderColor: Echopay.border,
          },
          tabBarLabelStyle: {
            fontSize: 10,
            fontWeight: '600',
            marginTop: 2,
          },
          tabBarItemStyle: {
            paddingVertical: 2,
          },
        }}>
        <Tabs.Screen
          name="index"
          options={{
            title: 'Home',
            tabBarIcon: ({ color, size }) => <Ionicons name="home" size={20} color={color} />,
          }}
        />
        <Tabs.Screen
          name="transactions"
          options={{
            title: 'History',
            tabBarIcon: ({ color, size }) => <Ionicons name="receipt" size={20} color={color} />,
          }}
        />
        <Tabs.Screen
          name="profile"
          options={{
            title: 'Profile',
            tabBarIcon: ({ color, size }) => <Ionicons name="person" size={20} color={color} />,
          }}
        />
      </Tabs>

      {/* Floating Mic Button - EchoPay Voice Assistant */}
      <FloatingMicButton
        onPress={handleMicPress}
        isListening={isListening}
        isProcessing={isProcessing}
      />

      {/* Voice Modal — real /voice/intent flow (PRD_LEKE §3.14) */}
      <VoiceIntentModal
        visible={voiceModalVisible}
        onClose={handleVoiceModalClose}
        onIntent={handleVoiceIntent}
      />
    </View>
  );
}
