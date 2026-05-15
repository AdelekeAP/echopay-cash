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
  ScrollView,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { Audio } from 'expo-av';

import Waveform from './Waveform';
import { useVoiceRecording } from '../hooks/useVoiceRecording';
import { voiceBiometricsService, EnrollmentResponse } from '../services/voiceService';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');

type EnrollmentStep = 'intro' | 'recording' | 'processing' | 'success' | 'error';

interface VoiceEnrollmentProps {
  visible: boolean;
  onClose: () => void;
  onSuccess: (enrollmentId: string) => void;
  accountNumber: string;
  companyId?: string;
}

// Phrases user should say for each sample
const ENROLLMENT_PHRASES = [
  "My voice is my password",
  "EchoPay makes banking easy",
  "Secure my account with voice",
];

export default function VoiceEnrollment({
  visible,
  onClose,
  onSuccess,
  accountNumber,
  companyId = '1',
}: VoiceEnrollmentProps) {
  const [step, setStep] = useState<EnrollmentStep>('intro');
  const [currentSample, setCurrentSample] = useState(0);
  const [samples, setSamples] = useState<string[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [enrollmentResult, setEnrollmentResult] = useState<EnrollmentResponse | null>(null);

  const { recordingState, startRecording, stopRecording, cancelRecording, resetRecording } =
    useVoiceRecording();

  const slideAnim = useRef(new Animated.Value(SCREEN_HEIGHT)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const progressAnim = useRef(new Animated.Value(0)).current;

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

  // Animate progress bar
  useEffect(() => {
    Animated.timing(progressAnim, {
      toValue: currentSample / 3,
      duration: 300,
      useNativeDriver: false,
    }).start();
  }, [currentSample]);

  const resetState = () => {
    setStep('intro');
    setCurrentSample(0);
    setSamples([]);
    setIsRecording(false);
    setErrorMessage('');
    setEnrollmentResult(null);
    resetRecording();
  };

  const handleClose = async () => {
    await cancelRecording();
    resetRecording();
    onClose();
  };

  const handleStartEnrollment = () => {
    setStep('recording');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  };

  const handleStartRecording = async () => {
    setIsRecording(true);
    await startRecording();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  };

  const handleStopRecording = async () => {
    setIsRecording(false);
    const uri = await stopRecording();

    if (uri) {
      const newSamples = [...samples, uri];
      setSamples(newSamples);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      if (newSamples.length >= 3) {
        // All samples collected, start enrollment
        await processEnrollment(newSamples);
      } else {
        // Move to next sample
        setCurrentSample(newSamples.length);
        resetRecording();
      }
    } else {
      setErrorMessage('Recording failed. Please try again.');
      setStep('error');
    }
  };

  const processEnrollment = async (audioSamples: string[]) => {
    setStep('processing');

    try {
      const result = await voiceBiometricsService.enrollVoice(
        audioSamples,
        accountNumber,
        companyId
      );

      if (result.success) {
        setEnrollmentResult(result);
        setStep('success');
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } else {
        setErrorMessage(result.message || 'Enrollment failed. Please try again.');
        setStep('error');
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
    } catch (error: any) {
      setErrorMessage(error.message || 'Something went wrong. Please try again.');
      setStep('error');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  const handleRetry = () => {
    resetState();
    setStep('recording');
  };

  const handleDone = () => {
    if (enrollmentResult?.enrollment_id) {
      onSuccess(enrollmentResult.enrollment_id);
    }
    onClose();
  };

  const renderIntro = () => (
    <View style={styles.stepContent}>
      <View style={styles.iconContainer}>
        <LinearGradient
          colors={['#00B050', '#008040']}
          style={styles.iconGradient}
        >
          <Ionicons name="finger-print" size={48} color="#fff" />
        </LinearGradient>
      </View>

      <Text style={styles.title}>Set Up Voice ID</Text>
      <Text style={styles.subtitle}>
        Your voice is unique. We'll use it to add an extra layer of security
        to your transactions.
      </Text>

      <View style={styles.infoCard}>
        <View style={styles.infoRow}>
          <Ionicons name="mic-outline" size={20} color="#00B050" />
          <Text style={styles.infoText}>Record 3 short voice samples</Text>
        </View>
        <View style={styles.infoRow}>
          <Ionicons name="shield-checkmark-outline" size={20} color="#00B050" />
          <Text style={styles.infoText}>Voice data is encrypted & secure</Text>
        </View>
        <View style={styles.infoRow}>
          <Ionicons name="time-outline" size={20} color="#00B050" />
          <Text style={styles.infoText}>Takes less than 2 minutes</Text>
        </View>
      </View>

      <TouchableOpacity
        style={styles.primaryButton}
        onPress={handleStartEnrollment}
      >
        <LinearGradient
          colors={['#00B050', '#008040']}
          style={styles.buttonGradient}
        >
          <Text style={styles.buttonText}>Get Started</Text>
          <Ionicons name="arrow-forward" size={20} color="#fff" />
        </LinearGradient>
      </TouchableOpacity>
    </View>
  );

  const renderRecording = () => (
    <View style={styles.stepContent}>
      {/* Progress indicator */}
      <View style={styles.progressContainer}>
        <View style={styles.progressBar}>
          <Animated.View
            style={[
              styles.progressFill,
              {
                width: progressAnim.interpolate({
                  inputRange: [0, 1],
                  outputRange: ['0%', '100%'],
                }),
              },
            ]}
          />
        </View>
        <Text style={styles.progressText}>
          Sample {currentSample + 1} of 3
        </Text>
      </View>

      {/* Sample dots */}
      <View style={styles.dotsContainer}>
        {[0, 1, 2].map((index) => (
          <View
            key={index}
            style={[
              styles.dot,
              index < currentSample && styles.dotCompleted,
              index === currentSample && styles.dotActive,
            ]}
          >
            {index < currentSample && (
              <Ionicons name="checkmark" size={16} color="#fff" />
            )}
          </View>
        ))}
      </View>

      {/* Phrase to say */}
      <View style={styles.phraseCard}>
        <Text style={styles.phraseLabel}>Say this phrase clearly:</Text>
        <Text style={styles.phraseText}>
          "{ENROLLMENT_PHRASES[currentSample]}"
        </Text>
      </View>

      {/* Recording button */}
      <View style={styles.recordingContainer}>
        {isRecording ? (
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
            <Text style={styles.micHint}>Tap to stop</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity onPress={handleStartRecording} style={styles.micButton}>
            <LinearGradient
              colors={['#00B050', '#008040']}
              style={styles.micButtonGradient}
            >
              <Ionicons name="mic" size={48} color="#fff" />
            </LinearGradient>
            <Text style={styles.micHint}>Tap to record</Text>
          </TouchableOpacity>
        )}

        {/* Duration */}
        {isRecording && (
          <Text style={styles.duration}>{recordingState.duration}s</Text>
        )}
      </View>

      <Text style={styles.tipText}>
        Speak naturally in a quiet environment
      </Text>
    </View>
  );

  const renderProcessing = () => (
    <View style={styles.stepContent}>
      <ActivityIndicator size="large" color="#00B050" />
      <Text style={styles.processingTitle}>Creating Your Voice ID</Text>
      <Text style={styles.processingSubtitle}>
        Analyzing voice patterns and creating secure voiceprint...
      </Text>
      <View style={styles.securityNote}>
        <Ionicons name="lock-closed" size={16} color="#666" />
        <Text style={styles.securityText}>
          Your voice data is encrypted with AES-256
        </Text>
      </View>
    </View>
  );

  const renderSuccess = () => (
    <View style={styles.stepContent}>
      <View style={styles.successIcon}>
        <Ionicons name="checkmark-circle" size={80} color="#00B050" />
      </View>
      <Text style={styles.successTitle}>Voice ID Created!</Text>
      <Text style={styles.successSubtitle}>
        Your voice is now enrolled for secure authentication
      </Text>

      {enrollmentResult && (
        <View style={styles.resultCard}>
          <View style={styles.resultRow}>
            <Text style={styles.resultLabel}>Quality Score</Text>
            <Text style={styles.resultValue}>
              {Math.round((enrollmentResult.quality_score || 0) * 100)}%
            </Text>
          </View>
          <View style={styles.resultRow}>
            <Text style={styles.resultLabel}>Samples Used</Text>
            <Text style={styles.resultValue}>
              {enrollmentResult.samples_used || 3}
            </Text>
          </View>
        </View>
      )}

      <TouchableOpacity style={styles.primaryButton} onPress={handleDone}>
        <LinearGradient
          colors={['#00B050', '#008040']}
          style={styles.buttonGradient}
        >
          <Text style={styles.buttonText}>Done</Text>
          <Ionicons name="checkmark" size={20} color="#fff" />
        </LinearGradient>
      </TouchableOpacity>
    </View>
  );

  const renderError = () => (
    <View style={styles.stepContent}>
      <View style={styles.errorIcon}>
        <Ionicons name="alert-circle" size={80} color="#E31937" />
      </View>
      <Text style={styles.errorTitle}>Enrollment Failed</Text>
      <Text style={styles.errorMessage}>{errorMessage}</Text>

      <TouchableOpacity style={styles.retryButton} onPress={handleRetry}>
        <Ionicons name="refresh" size={20} color="#fff" />
        <Text style={styles.retryButtonText}>Try Again</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.cancelLink} onPress={handleClose}>
        <Text style={styles.cancelLinkText}>Cancel</Text>
      </TouchableOpacity>
    </View>
  );

  const renderStep = () => {
    switch (step) {
      case 'intro':
        return renderIntro();
      case 'recording':
        return renderRecording();
      case 'processing':
        return renderProcessing();
      case 'success':
        return renderSuccess();
      case 'error':
        return renderError();
      default:
        return renderIntro();
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
          onPress={step === 'processing' ? undefined : handleClose}
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
                <Ionicons name="finger-print" size={20} color="#fff" />
              </LinearGradient>
              <Text style={styles.headerTitle}>Voice ID Setup</Text>
            </View>
            {step !== 'processing' && (
              <TouchableOpacity onPress={handleClose} style={styles.closeButton}>
                <Ionicons name="close" size={24} color="#666" />
              </TouchableOpacity>
            )}
          </View>

          <ScrollView
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            {renderStep()}
          </ScrollView>
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
    maxHeight: SCREEN_HEIGHT * 0.85,
  },
  scrollContent: {
    flexGrow: 1,
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
  stepContent: {
    alignItems: 'center',
    paddingVertical: 20,
  },
  iconContainer: {
    marginBottom: 24,
  },
  iconGradient: {
    width: 100,
    height: 100,
    borderRadius: 50,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#00B050',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.3,
    shadowRadius: 16,
    elevation: 8,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#1a1a1a',
    marginBottom: 12,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 16,
    color: '#666',
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: 24,
    paddingHorizontal: 16,
  },
  infoCard: {
    backgroundColor: '#f8f9fa',
    borderRadius: 16,
    padding: 20,
    width: '100%',
    marginBottom: 24,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  infoText: {
    fontSize: 15,
    color: '#1a1a1a',
    marginLeft: 12,
  },
  primaryButton: {
    width: '100%',
    borderRadius: 16,
    overflow: 'hidden',
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
  progressContainer: {
    width: '100%',
    marginBottom: 24,
  },
  progressBar: {
    height: 6,
    backgroundColor: '#e0e0e0',
    borderRadius: 3,
    overflow: 'hidden',
    marginBottom: 8,
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#00B050',
    borderRadius: 3,
  },
  progressText: {
    fontSize: 14,
    color: '#666',
    textAlign: 'center',
  },
  dotsContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 16,
    marginBottom: 32,
  },
  dot: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#e0e0e0',
    justifyContent: 'center',
    alignItems: 'center',
  },
  dotCompleted: {
    backgroundColor: '#00B050',
  },
  dotActive: {
    borderWidth: 3,
    borderColor: '#00B050',
    backgroundColor: '#fff',
  },
  phraseCard: {
    backgroundColor: '#f0f8f4',
    borderRadius: 16,
    padding: 20,
    width: '100%',
    marginBottom: 32,
    borderWidth: 1,
    borderColor: '#00B050',
  },
  phraseLabel: {
    fontSize: 14,
    color: '#666',
    marginBottom: 8,
  },
  phraseText: {
    fontSize: 20,
    fontWeight: '600',
    color: '#1a1a1a',
    textAlign: 'center',
  },
  recordingContainer: {
    alignItems: 'center',
    marginBottom: 24,
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
    shadowColor: '#00B050',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.3,
    shadowRadius: 16,
    elevation: 8,
  },
  micHint: {
    fontSize: 14,
    color: '#999',
    marginTop: 16,
  },
  duration: {
    fontSize: 24,
    fontWeight: '700',
    color: '#E31937',
    marginTop: 16,
  },
  tipText: {
    fontSize: 14,
    color: '#999',
    textAlign: 'center',
  },
  processingTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: '#1a1a1a',
    marginTop: 24,
    marginBottom: 12,
  },
  processingSubtitle: {
    fontSize: 16,
    color: '#666',
    textAlign: 'center',
    marginBottom: 24,
  },
  securityNote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  securityText: {
    fontSize: 14,
    color: '#666',
  },
  successIcon: {
    marginBottom: 24,
  },
  successTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: '#00B050',
    marginBottom: 12,
  },
  successSubtitle: {
    fontSize: 16,
    color: '#666',
    textAlign: 'center',
    marginBottom: 24,
  },
  resultCard: {
    backgroundColor: '#f8f9fa',
    borderRadius: 16,
    padding: 20,
    width: '100%',
    marginBottom: 24,
  },
  resultRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  resultLabel: {
    fontSize: 15,
    color: '#666',
  },
  resultValue: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1a1a1a',
  },
  errorIcon: {
    marginBottom: 24,
  },
  errorTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: '#E31937',
    marginBottom: 12,
  },
  errorMessage: {
    fontSize: 16,
    color: '#666',
    textAlign: 'center',
    marginBottom: 24,
    paddingHorizontal: 16,
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
  cancelLink: {
    paddingVertical: 8,
  },
  cancelLinkText: {
    fontSize: 16,
    color: '#666',
  },
});