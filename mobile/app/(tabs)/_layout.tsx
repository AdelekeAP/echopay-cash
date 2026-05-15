import { Tabs, useRouter } from 'expo-router';
import React, { useState, useCallback } from 'react';
import { Platform, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import FloatingMicButton from '../../components/FloatingMicButton';
import VoiceModal from '../../components/VoiceModal';
import { useAuth } from '../../context/AuthContext';
import { VoiceResponse } from '../../services/voiceService';
import { useWakeWord } from '../../hooks/useWakeWord';
import { useShakeDetection } from '../../hooks/useShakeDetection';

export default function TabLayout() {
  const [voiceModalVisible, setVoiceModalVisible] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [wakeWordEnabled, setWakeWordEnabled] = useState(true);
  const { account, refreshAccount } = useAuth();
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

  const handleTransferRequested = (data: VoiceResponse['data']) => {
    // Close voice modal and navigate to transfer screen with pre-filled data
    setVoiceModalVisible(false);
    if (data?.recipient_name && data?.amount) {
      router.push({
        pathname: '/transfer',
        params: {
          recipientName: data.recipient_name,
          amount: data.amount.toString(),
        },
      });
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <Tabs
        screenOptions={{
          tabBarActiveTintColor: '#E31937',
          tabBarInactiveTintColor: '#999',
          headerShown: false,
          tabBarStyle: {
            position: 'absolute',
            bottom: 20,
            left: 20,
            right: 20,
            backgroundColor: '#fff',
            borderRadius: 25,
            height: 70,
            paddingTop: 10,
            paddingBottom: Platform.OS === 'ios' ? 10 : 10,
            borderTopWidth: 0,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 10 },
            shadowOpacity: 0.15,
            shadowRadius: 20,
            elevation: 10,
          },
          tabBarLabelStyle: {
            fontSize: 11,
            fontWeight: '600',
            marginTop: 4,
          },
          tabBarItemStyle: {
            paddingVertical: 5,
          },
        }}>
        <Tabs.Screen
          name="index"
          options={{
            title: 'Home',
            tabBarIcon: ({ color, size }) => <Ionicons name="home" size={size} color={color} />,
          }}
        />
        <Tabs.Screen
          name="transactions"
          options={{
            title: 'History',
            tabBarIcon: ({ color, size }) => <Ionicons name="receipt" size={size} color={color} />,
          }}
        />
        <Tabs.Screen
          name="profile"
          options={{
            title: 'Profile',
            tabBarIcon: ({ color, size }) => <Ionicons name="person" size={size} color={color} />,
          }}
        />
      </Tabs>

      {/* Floating Mic Button - EchoPay Voice Assistant */}
      <FloatingMicButton
        onPress={handleMicPress}
        isListening={isListening}
        isProcessing={isProcessing}
      />

      {/* Voice Modal */}
      <VoiceModal
        visible={voiceModalVisible}
        onClose={handleVoiceModalClose}
        accountNumber={account?.account_number}
        onTransferRequested={handleTransferRequested}
        onTransferComplete={refreshAccount}
      />
    </View>
  );
}
