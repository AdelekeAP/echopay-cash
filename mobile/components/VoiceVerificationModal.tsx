// @ts-nocheck — legacy file inherited from EchoPay v1; pre-strict TS. Do not modify (see CLAUDE.md).
import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  Animated,
  Dimensions,
  ActivityIndicator,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';

import Waveform from './Waveform';
import { useVoiceRecording } from '../hooks/useVoiceRecording';
import { voiceBiometricsService, VerificationResponse } from '../services/voiceService';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');

type VerificationStep = 'ready' | 'recording' | 'verifying' | 'success' | 'failed';

interface VoiceVerificationModalProps {
  visible: boolean;
  onClose: () => void;
  onVerified: () => void;
  onFailed?: (attempts: number) => void;
  accountNumber: string;
  companyId?: string;
  maxAttempts?: number;
  transferAmount?: number;
}

export default function VoiceVerificationModal({
  visible,
  onClose,
  onVerified,
  onFailed,
  accountNumber,
  companyId = '1',
  maxAttempts = 3,
  transferAmount,
}: VoiceVerificationModalProps) {
  const [step, setStep] = useState<VerificationStep>('ready');
  const [attempts, setAttempts] = useState(0);
  const [isRecording, setIsRecording] = useState(false);
  const [verificationResult, setVerificationResult] = useState<VerificationResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState('');

  const { recordingState, startRecording, stopRecording, cancelRecording, resetRecording } =
    useVoiceRecording();

  const slideAnim = useRef(new Animated.Value(SCREEN_HEIGHT)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;

  // Pulse animation for recording
  useEffect(() => {
    let animation: Animated.CompositeAnimation | null = null;

    if (isRecording) {
      animation = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.1,
            duration: 500,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 500,
            useNativeDriver: true,
          }),
        ])
      );
      animation.start();
    } else {
      pulseAnim.setValue(1);
    }

    // Cleanup: stop animation when recording stops or component unmounts
    return () => {
      if (animation) {
        animation.stop();
      }
      pulseAnim.setValue(1);
    };
  }, [isRecording]);

  // Animate modal in/out
  useEffect(() => {
    if (visible) {
      resetState();
      Animated.parallel([
        Animated.spring(slideAnim, {
          toValue: 0,
          friction: 8,
          tension: 40,
          useNativeDriver: true,
        }),
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideAnim, {
          toValue: SCREEN_HEIGHT,
          duration: 250,
          useNativeDriver: true,
        }),
        Animated.timing(fadeAnim, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible]);

  const resetState = () => {
    setStep('ready');
    setAttempts(0);
    setIsRecording(false);
    setVerificationResult(null);
    setErrorMessage('');
    resetRecording();
  };

  const handleClose = async () => {
    await cancelRecording();
    resetRecording();
    onClose();
  };

  const handleStartRecording = async () => {
    setStep('recording');
    setIsRecording(true);
    await startRecording();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  };

  const handleStopRecording = async () => {
    setIsRecording(false);
    setStep('verifying');
    const uri = await stopRecording();

    if (uri) {
      await verifyVoice(uri);
    } else {
      setErrorMessage('Recording failed. Please try again.');
      setStep('failed');
    }
  };

  const verifyVoice = async (audioUri: string) => {
    try {
      const result = await voiceBiometricsService.verifyVoice(
        audioUri,
        accountNumber,
        companyId
      );

      setVerificationResult(result);

      if (result.verified) {
        setStep('success');
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        // Short delay before calling onVerified
        setTimeout(() => {
          onVerified();
        }, 1500);
      } else {
        const newAttempts = attempts + 1;
        setAttempts(newAttempts);
        setErrorMessage(result.message || 'Voice not recognized. Please try again.');
        setStep('failed');
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);

        if (newAttempts >= maxAttempts && onFailed) {
          onFailed(newAttempts);
        }
      }
    } catch (error: any) {
      setErrorMessage(error.message || 'Verification failed. Please try again.');
      setStep('failed');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  const handleRetry = () => {
    if (attempts < maxAttempts) {
      setStep('ready');
      setVerificationResult(null);
      setErrorMessage('');
      resetRecording();
    }
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-NG', {
      style: 'currency',
      currency: 'NGN',
      minimumFractionDigits: 0,
    }).format(amount);
  };

  const getSecurityLevelColor = (level: string | undefined) => {
    switch (level) {
      case 'high':
        return '#00B050';
      case 'medium':
        return '#FFA500';
      default:
        return '#666';
    }
  };

  const renderReady = () => (
    <View style={styles.content}>
      <View style={styles.iconContainer}>
        <LinearGradient
          colors={['#00B050', '#008040']}
          style={styles.iconGradient}
        >
          <Ionicons name="shield-checkmark" size={40} color="#fff" />
        </LinearGradient>
      </View>

      <Text style={styles.title}>Voice Verification</Text>
      <Text style={styles.subtitle}>
        Verify your identity with your voice to authorize this transaction
      </Text>

      {transferAmount && (
        <View style={styles.amountCard}>
          <Text style={styles.amountLabel}>Transaction Amount</Text>
          <Text style={styles.amountValue}>{formatCurrency(transferAmount)}</Text>
        </View>
      )}

      <TouchableOpacity
        style={styles.startButton}
        onPress={handleStartRecording}
      >
        <LinearGradient
          colors={['#00B050', '#008040']}
          style={styles.buttonGradient}
        >
          <Ionicons name="mic" size={24} color="#fff" />
          <Text style={styles.buttonText}>Start Speaking</Text>
        </LinearGradient>
      </TouchableOpacity>

      <Text style={styles.hint}>Say anything for 2-3 seconds</Text>
    </View>
  );

  const renderRecording = () => (
    <View style={styles.content}>
      <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
        <TouchableOpacity onPress={handleStopRecording} style={styles.micButton}>
          <LinearGradient
            colors={['#E31937', '#FF4D4D']}
            style={styles.micButtonGradient}
          >
            <Waveform
              isActive={recordingState.isRecording}
              metering={recordingState.metering}
              color="#fff"
            />
          </LinearGradient>
        </TouchableOpacity>
      </Animated.View>

      <Text style={styles.recordingText}>Listening...</Text>
      <Text style={styles.duration}>{recordingState.duration}s</Text>
      <Text style={styles.hint}>Tap to stop when done</Text>
    </View>
  );

  const renderVerifying = () => (
    <View style={styles.content}>
      <ActivityIndicator size="large" color="#00B050" />
      <Text style={styles.verifyingText}>Verifying your voice...</Text>
      <Text style={styles.hint}>This takes just a moment</Text>
    </View>
  );

  const renderSuccess = () => (
    <View style={styles.content}>
      <View style={styles.successIcon}>
        <Ionicons name="checkmark-circle" size={80} color="#00B050" />
      </View>
      <Text style={styles.successTitle}>Verified!</Text>

      {verificationResult && (
        <View style={styles.resultCard}>
          <View style={styles.resultRow}>
            <Text style={styles.resultLabel}>Confidence</Text>
            <Text style={styles.resultValue}>
              {Math.round(verificationResult.confidence * 100)}%
            </Text>
          </View>
          {verificationResult.security_level && (
            <View style={styles.resultRow}>
              <Text style={styles.resultLabel}>Security Level</Text>
              <Text
                style={[
                  styles.resultValue,
                  { color: getSecurityLevelColor(verificationResult.security_level) },
                ]}
              >
                {verificationResult.security_level.toUpperCase()}
              </Text>
            </View>
          )}
        </View>
      )}
    </View>
  );

  const renderFailed = () => (
    <View style={styles.content}>
      <View style={styles.errorIcon}>
        <Ionicons name="close-circle" size={80} color="#E31937" />
      </View>
      <Text style={styles.errorTitle}>Verification Failed</Text>
      <Text style={styles.errorMessage}>{errorMessage}</Text>

      <Text style={styles.attemptsText}>
        Attempts: {attempts} / {maxAttempts}
      </Text>

      {attempts < maxAttempts ? (
        <TouchableOpacity style={styles.retryButton} onPress={handleRetry}>
          <Ionicons name="refresh" size={20} color="#fff" />
          <Text style={styles.retryButtonText}>Try Again</Text>
        </TouchableOpacity>
      ) : (
        <View style={styles.lockedContainer}>
          <Ionicons name="lock-closed" size={24} color="#E31937" />
          <Text style={styles.lockedText}>
            Too many failed attempts. Please use PIN instead.
          </Text>
        </View>
      )}

      <TouchableOpacity style={styles.cancelLink} onPress={handleClose}>
        <Text style={styles.cancelLinkText}>Use PIN Instead</Text>
      </TouchableOpacity>
    </View>
  );

  const renderStep = () => {
    switch (step) {
      case 'ready':
        return renderReady();
      case 'recording':
        return renderRecording();
      case 'verifying':
        return renderVerifying();
      case 'success':
        return renderSuccess();
      case 'failed':
        return renderFailed();
      default:
        return renderReady();
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="none"
      transparent
      statusBarTranslucent
      onRequestClose={handleClose}
    >
      <Animated.View style={[styles.backdrop, { opacity: fadeAnim }]}>
        <BlurView intensity={30} style={StyleSheet.absoluteFill} />
        <TouchableOpacity
          style={StyleSheet.absoluteFill}
          onPress={step === 'verifying' || step === 'success' ? undefined : handleClose}
        />
      </Animated.View>

      <Animated.View
        style={[
          styles.modalContainer,
          { transform: [{ translateY: slideAnim }] },
        ]}
      >
        <View style={styles.modalContent}>
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <LinearGradient
                colors={['#00B050', '#008040']}
                style={styles.logoContainer}
              >
                <Ionicons name="shield-checkmark" size={20} color="#fff" />
              </LinearGradient>
              <Text style={styles.headerTitle}>Voice Auth</Text>
            </View>
            {step !== 'verifying' && step !== 'success' && (
              <TouchableOpacity onPress={handleClose} style={styles.closeButton}>
                <Ionicons name="close" size={24} color="#666" />
              </TouchableOpacity>
            )}
          </View>

          {renderStep()}
        </View>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
  },
  modalContainer: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 24,
    paddingTop: 20,
    paddingBottom: 40,
    minHeight: SCREEN_HEIGHT * 0.5,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  logoContainer: {
    width: 36,
    height: 36,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1a1a1a',
    marginLeft: 10,
  },
  closeButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#f5f5f5',
    justifyContent: 'center',
    alignItems: 'center',
  },
  content: {
    alignItems: 'center',
    paddingVertical: 20,
  },
  iconContainer: {
    marginBottom: 24,
  },
  iconGradient: {
    width: 80,
    height: 80,
    borderRadius: 40,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#00B050',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#1a1a1a',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 15,
    color: '#666',
    textAlign: 'center',
    marginBottom: 20,
    paddingHorizontal: 16,
  },
  amountCard: {
    backgroundColor: '#f8f9fa',
    borderRadius: 12,
    padding: 16,
    width: '100%',
    marginBottom: 24,
    alignItems: 'center',
  },
  amountLabel: {
    fontSize: 14,
    color: '#666',
    marginBottom: 4,
  },
  amountValue: {
    fontSize: 24,
    fontWeight: '700',
    color: '#1a1a1a',
  },
  startButton: {
    width: '100%',
    borderRadius: 16,
    overflow: 'hidden',
    marginBottom: 16,
  },
  buttonGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    gap: 8,
  },
  buttonText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#fff',
  },
  hint: {
    fontSize: 14,
    color: '#999',
  },
  micButton: {
    alignItems: 'center',
  },
  micButtonGradient: {
    width: 120,
    height: 120,
    borderRadius: 60,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#E31937',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.3,
    shadowRadius: 16,
    elevation: 8,
  },
  recordingText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#E31937',
    marginTop: 20,
    marginBottom: 8,
  },
  duration: {
    fontSize: 32,
    fontWeight: '700',
    color: '#1a1a1a',
    marginBottom: 8,
  },
  verifyingText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1a1a1a',
    marginTop: 24,
    marginBottom: 8,
  },
  successIcon: {
    marginBottom: 16,
  },
  successTitle: {
    fontSize: 28,
    fontWeight: '700',
    color: '#00B050',
    marginBottom: 16,
  },
  resultCard: {
    backgroundColor: '#f8f9fa',
    borderRadius: 12,
    padding: 16,
    width: '100%',
  },
  resultRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  resultLabel: {
    fontSize: 15,
    color: '#666',
  },
  resultValue: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1a1a1a',
  },
  errorIcon: {
    marginBottom: 16,
  },
  errorTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: '#E31937',
    marginBottom: 8,
  },
  errorMessage: {
    fontSize: 15,
    color: '#666',
    textAlign: 'center',
    marginBottom: 16,
    paddingHorizontal: 16,
  },
  attemptsText: {
    fontSize: 14,
    color: '#999',
    marginBottom: 20,
  },
  retryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#E31937',
    paddingVertical: 14,
    paddingHorizontal: 32,
    borderRadius: 12,
    gap: 8,
    marginBottom: 16,
  },
  retryButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
  },
  lockedContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff5f5',
    padding: 16,
    borderRadius: 12,
    gap: 12,
    marginBottom: 16,
  },
  lockedText: {
    flex: 1,
    fontSize: 14,
    color: '#E31937',
  },
  cancelLink: {
    paddingVertical: 8,
  },
  cancelLinkText: {
    fontSize: 16,
    color: '#0066FF',
    fontWeight: '600',
  },
});