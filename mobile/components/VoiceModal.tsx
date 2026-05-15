// @ts-nocheck — legacy file inherited from EchoPay v1; pre-strict TS. Do not modify (see CLAUDE.md).
import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  Animated,
  Dimensions,
  ActivityIndicator,
  Platform,
  ScrollView,
  TextInput,
  KeyboardAvoidingView,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';

import EchoOrb from './EchoOrb';
import Waveform from './Waveform';
import voiceService, { VoiceResponse } from '../services/voiceService';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');

// Modal status types for voice interaction states
type ModalStatus = 'idle' | 'listening' | 'processing' | 'responding' | 'success' | 'error';

interface VoiceModalProps {
  visible: boolean;
  onClose: () => void;
  accountNumber?: string;
  onTransferRequested?: (data: VoiceResponse['data']) => void;
  onTransferComplete?: () => void; // Called to refresh account after transfer
}

export default function VoiceModal({
  visible,
  onClose,
  accountNumber,
  onTransferRequested,
  onTransferComplete,
}: VoiceModalProps) {
  const [status, setStatus] = useState<ModalStatus>('idle');
  const [transcript, setTranscript] = useState('');
  const [response, setResponse] = useState('');
  const [responseAudio, setResponseAudio] = useState<string | null>(null);
  const [lastIntent, setLastIntent] = useState('');
  const [lastAction, setLastAction] = useState(''); // Track action for PIN flow
  const [actionData, setActionData] = useState<VoiceResponse['data'] | null>(null);
  const [metering, setMetering] = useState(-160);
  const [recordingDuration, setRecordingDuration] = useState(0);

  // Edit escape hatch state
  const [showEditOverlay, setShowEditOverlay] = useState(false);
  const [editField, setEditField] = useState<'amount' | 'recipient' | null>(null);
  const [editValue, setEditValue] = useState('');

  const slideAnim = useRef(new Animated.Value(SCREEN_HEIGHT)).current;
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const soundRef = useRef<Audio.Sound | null>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const meteringIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const durationIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Set user context when modal opens
  useEffect(() => {
    if (visible && accountNumber) {
      voiceService.setUserContext(accountNumber);
    }
  }, [visible, accountNumber]);

  // Animate modal in/out
  useEffect(() => {
    if (visible) {
      setStatus('idle');
      setTranscript('');
      setResponse('');
      setLastAction(''); // Reset action state for fresh conversation
      setRecordingDuration(0);
      setShowEditOverlay(false); // Reset edit overlay state
      setEditField(null);
      setEditValue('');
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

      // Cleanup on close
      stopRecording(false);
    }
  }, [visible]);

  // Auto-start recording when modal opens
  useEffect(() => {
    if (visible && status === 'idle') {
      const timer = setTimeout(() => {
        startRecording();
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [visible]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (recordingRef.current) {
        // Use .catch() to handle promise rejection from async unload
        recordingRef.current.stopAndUnloadAsync().catch(() => {
          // Recording may already be unloaded, ignore
        });
        recordingRef.current = null;
      }
      if (soundRef.current) {
        soundRef.current.unloadAsync().catch(() => {
          // Sound may already be unloaded, ignore
        });
        soundRef.current = null;
      }
      if (meteringIntervalRef.current) {
        clearInterval(meteringIntervalRef.current);
        meteringIntervalRef.current = null;
      }
      if (durationIntervalRef.current) {
        clearInterval(durationIntervalRef.current);
        durationIntervalRef.current = null;
      }
    };
  }, []);

  // Start audio recording
  const startRecording = async () => {
    try {
      // Prevent double recording
      if (recordingRef.current) {
        console.log('[Voice] Already recording, skipping...');
        return;
      }

      console.log('[Voice] Requesting permissions...');
      const { granted } = await Audio.requestPermissionsAsync();

      if (!granted) {
        setStatus('error');
        setResponse('Microphone permission is required for voice commands.');
        return;
      }

      // Configure audio mode for recording
      // Use interruptionMode to prevent volume fluctuations on iOS
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        interruptionModeIOS: 1, // INTERRUPTION_MODE_IOS_DO_NOT_MIX
        interruptionModeAndroid: 1, // INTERRUPTION_MODE_ANDROID_DO_NOT_MIX
        shouldDuckAndroid: false,
      });

      console.log('[Voice] Starting recording...');

      // Use the simpler recording preset for better compatibility
      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );

      recordingRef.current = recording;

      setStatus('listening');
      setTranscript('');
      setResponse('');
      setRecordingDuration(0);
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      // Start metering updates
      meteringIntervalRef.current = setInterval(async () => {
        if (recordingRef.current) {
          try {
            const status = await recordingRef.current.getStatusAsync();
            if (status.isRecording && status.metering !== undefined) {
              setMetering(status.metering);
            }
          } catch (e) {
            // Ignore metering errors
          }
        }
      }, 100);

      // Start duration counter
      durationIntervalRef.current = setInterval(() => {
        setRecordingDuration(prev => prev + 1);
      }, 1000);

      console.log('[Voice] Recording started');
      return; // Success - early return

    } catch (error) {
      console.error('[Voice] Recording error:', error);
      setStatus('error');
      setResponse('Could not start recording. Please try again.');
    }
  };

  // Stop recording and process audio
  const stopRecording = async (shouldProcess: boolean = true) => {
    console.log('[Voice] stopRecording called, shouldProcess:', shouldProcess, 'hasRecording:', !!recordingRef.current);

    try {
      // Clear intervals
      if (meteringIntervalRef.current) {
        clearInterval(meteringIntervalRef.current);
        meteringIntervalRef.current = null;
      }
      if (durationIntervalRef.current) {
        clearInterval(durationIntervalRef.current);
        durationIntervalRef.current = null;
      }

      if (!recordingRef.current) {
        console.log('[Voice] No recording to stop, returning early');
        return;
      }

      console.log('[Voice] Stopping recording...');

      const recording = recordingRef.current;
      recordingRef.current = null;

      // Capture duration BEFORE stopping (state may be stale after async calls)
      const capturedDuration = recordingDuration;
      console.log('[Voice] Captured duration before stop:', capturedDuration);

      try {
        console.log('[Voice] Calling stopAndUnloadAsync...');
        await recording.stopAndUnloadAsync();
        console.log('[Voice] stopAndUnloadAsync completed');
      } catch (stopError) {
        console.error('[Voice] Error stopping recording:', stopError);
        // Continue anyway to try to get the URI
      }

      // Reset audio mode for playback (critical for iOS!)
      // Add a small delay to let iOS properly switch audio sessions
      try {
        console.log('[Voice] Resetting audio mode...');
        await new Promise(resolve => setTimeout(resolve, 150));
        // Use playback mode settings - this avoids the 'defaultToSpeaker' error
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: false,
          playsInSilentModeIOS: true,
          staysActiveInBackground: false,
        });
        console.log('[Voice] Audio mode reset completed');
      } catch (modeError) {
        console.error('[Voice] Error resetting audio mode:', modeError);
        // Continue processing even if audio mode reset fails
      }

      if (!shouldProcess) {
        console.log('[Voice] shouldProcess is false, returning');
        return;
      }

      console.log('[Voice] Getting recording URI...');
      const uri = recording.getURI();
      console.log('[Voice] Recording URI:', uri);

      if (!uri) {
        setStatus('error');
        setResponse('Recording failed. Please try again.');
        return;
      }

      // Check minimum recording duration (at least 0.5 seconds)
      // Use capturedDuration instead of state which may be stale
      console.log('[Voice] Recording duration:', capturedDuration, 'seconds');
      if (capturedDuration < 1) {
        console.log('[Voice] Recording too short, showing error');
        setStatus('error');
        setResponse("I didn't hear anything. Please hold the button and speak.");
        return;
      }

      setStatus('processing');
      setTranscript('Processing your voice...');

      // Send audio to backend for processing
      // Backend will use Google Speech (Nigerian English) → Whisper fallback
      console.log('[Voice] Sending audio to backend...');
      const result = await voiceService.processAudio(uri);

      console.log('[Voice] Backend response:', result);

      if (result.success) {
        // Show what the user said (transcript from speech recognition)
        setTranscript(result.transcript || '');
        setResponse(result.response_text);
        setLastIntent(result.intent);
        setLastAction(result.action); // Track action for PIN flow hints
        setActionData(result.data || null);
        setResponseAudio(result.response_audio || null);
        setStatus('success');

        // Play response audio if available
        if (result.response_audio) {
          console.log('[Voice] response_audio received, type:', typeof result.response_audio);
          await playResponseAudio(result.response_audio);
        } else {
          console.log('[Voice] No response_audio in result');
        }

        // Handle transfer intent - only redirect when transfer is FULLY COMPLETE
        // Don't redirect when:
        // - awaiting PIN - user needs to say PIN
        // - offer_save_beneficiary - user needs to answer yes/no to save
        if (result.intent === 'transfer_complete' && result.data) {
          // Transfer completed successfully via voice - refresh account balance
          if (onTransferComplete) {
            onTransferComplete();
          }

          // Only close modal if there's no follow-up question
          // When action is 'offer_save_beneficiary', user needs to respond yes/no
          const hasFollowUpQuestion = result.action === 'offer_save_beneficiary';
          if (onTransferRequested && !hasFollowUpQuestion) {
            onTransferRequested(result.data);
          }
        }
        // Note: When action === 'awaiting_pin' or 'offer_save_beneficiary', user stays in voice modal

        // Handle close_modal action - user said goodbye
        if (result.action === 'close_modal') {
          // Play the goodbye audio first, then close after a delay
          if (result.response_audio) {
            await playResponseAudio(result.response_audio);
            // Wait for audio to finish (approx 2-3 seconds), then close
            setTimeout(() => {
              handleClose();
            }, 2500);
          } else {
            // No audio, close after showing the message briefly
            setTimeout(() => {
              handleClose();
            }, 1500);
          }
          return; // Skip the haptic feedback below since we're closing
        }

        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } else {
        setResponse(result.response_text || 'Sorry, I could not understand that.');
        setLastAction(result.action || ''); // Track action even for errors (e.g., retry_pin)
        setResponseAudio(result.response_audio || null);
        setStatus('error');

        // IMPORTANT: Play TTS audio even for error responses (e.g., Invalid PIN)
        // Backend sends TTS for error messages like "Invalid PIN. You have X attempts remaining"
        if (result.response_audio) {
          console.log('[Voice] Error response has TTS audio, playing...');
          await playResponseAudio(result.response_audio);
        }

        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
    } catch (error) {
      console.error('[Voice] Processing error:', error);
      setResponse('Something went wrong. Please try again.');
      setStatus('error');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  // Play response audio
  const playResponseAudio = async (base64Audio: string) => {
    try {
      // Defensive check - ensure we have a valid base64 string
      if (!base64Audio || typeof base64Audio !== 'string') {
        console.error('[Voice] Invalid audio data:', typeof base64Audio);
        return;
      }

      console.log('[Voice] Playing TTS audio, type:', typeof base64Audio, 'length:', base64Audio.length);

      // Clean up previous sound
      if (soundRef.current) {
        await soundRef.current.unloadAsync();
        soundRef.current = null;
      }

      // Set audio mode for playback (important for iOS!)
      // Use minimal settings to avoid iOS audio session conflicts
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
      });

      // Write base64 to temp file (more reliable than data URI on iOS)
      const cacheDir = FileSystem.cacheDirectory || FileSystem.documentDirectory || '';
      const tempFile = `${cacheDir}tts_response_${Date.now()}.mp3`;
      console.log('[Voice] Writing to temp file:', tempFile);
      await FileSystem.writeAsStringAsync(tempFile, base64Audio, {
        encoding: FileSystem.EncodingType.Base64,
      });
      console.log('[Voice] TTS audio saved successfully');

      const { sound } = await Audio.Sound.createAsync(
        { uri: tempFile },
        { shouldPlay: true, volume: 1.0 }
      );

      soundRef.current = sound;
      setStatus('responding');
      console.log('[Voice] Audio playback started');

      // Wait for playback to complete with full error handling
      sound.setOnPlaybackStatusUpdate(async (status) => {
        if (!status.isLoaded) {
          // Handle unloaded/error state
          if ('error' in status && status.error) {
            console.error('[Voice] Audio playback error:', status.error);
            setStatus('success'); // Still show success for the response
          }
          return;
        }

        if (status.didJustFinish) {
          console.log('[Voice] Audio playback finished');
          setStatus('success');
          // Clean up temp file
          try {
            await FileSystem.deleteAsync(tempFile, { idempotent: true });
          } catch (e) {
            // Ignore cleanup errors
          }
        }

        // Handle interruptions (e.g., phone call, other audio)
        if (status.isLoaded && !status.isPlaying && !status.didJustFinish && status.positionMillis > 0) {
          console.log('[Voice] Audio playback interrupted');
          setStatus('success');
        }
      });
    } catch (error) {
      console.error('[Voice] Audio playback error:', error);
      // Don't fail silently - still show success status
      setStatus('success');
    }
  };

  // Handle close with cleanup
  const handleClose = async () => {
    await stopRecording(false);
    if (soundRef.current) {
      await soundRef.current.unloadAsync();
      soundRef.current = null;
    }
    onClose();
  };

  // Handle tap to stop recording
  // Use ref-based check for recording state since React state can be stale
  const handleMicPress = async () => {
    const isRecording = !!recordingRef.current;
    console.log('[Voice] handleMicPress, status:', status, 'isRecording:', isRecording);

    if (isRecording) {
      // Recording is active - stop and process it
      console.log('[Voice] Recording active, calling stopRecording(true)');
      await stopRecording(true);
    } else if (status === 'idle' || status === 'success' || status === 'error') {
      // Not recording - start new recording
      console.log('[Voice] Not recording, calling startRecording');
      await startRecording();
    } else {
      console.log('[Voice] Status', status, 'does not allow action');
    }
  };

  // Edit escape hatch handlers
  const handleEditAmount = () => {
    const currentAmount = actionData?.amount || '';
    setEditField('amount');
    setEditValue(currentAmount.toString());
    setShowEditOverlay(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handleEditRecipient = () => {
    const currentRecipient = actionData?.recipient_name || actionData?.recipient || '';
    setEditField('recipient');
    setEditValue(currentRecipient);
    setShowEditOverlay(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handleEditSubmit = async () => {
    if (!editValue.trim()) {
      setShowEditOverlay(false);
      setEditField(null);
      return;
    }

    setShowEditOverlay(false);
    setStatus('processing');

    try {
      // Step 1: First trigger correction mode with "edit"
      await voiceService.processText('edit');

      // Small delay to ensure backend processes the state change
      await new Promise(resolve => setTimeout(resolve, 200));

      // Step 2: Now send the actual correction
      let textCommand = '';
      if (editField === 'amount') {
        textCommand = `the correct amount is ${editValue}`;
      } else if (editField === 'recipient') {
        textCommand = `send to ${editValue}`;
      }

      const result = await voiceService.processText(textCommand);

      if (result.success) {
        setTranscript(`Edited: ${editValue}`);
        setResponse(result.response_text);
        setLastIntent(result.intent);
        setLastAction(result.action);
        setActionData(result.data || null);
        setResponseAudio(result.response_audio || null);
        setStatus('success');

        if (result.response_audio) {
          await playResponseAudio(result.response_audio);
        }

        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } else {
        setResponse(result.response_text || 'Could not process edit.');
        setResponseAudio(result.response_audio || null);
        setStatus('error');

        // Play TTS for error responses
        if (result.response_audio) {
          await playResponseAudio(result.response_audio);
        }

        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
    } catch (error) {
      console.error('[Voice] Edit processing error:', error);
      setResponse('Could not process edit. Please try again.');
      setStatus('error');
    }

    setEditField(null);
    setEditValue('');
  };

  const handleEditCancel = () => {
    setShowEditOverlay(false);
    setEditField(null);
    setEditValue('');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  // Check if we should show edit buttons (only during confirmation states)
  const showEditButtons = lastAction === 'awaiting_pin' || lastAction === 'retry_pin';

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={handleClose}
    >
      <Animated.View style={[styles.overlay, { opacity: fadeAnim }]} pointerEvents="box-none">
        <BlurView intensity={20} style={StyleSheet.absoluteFill} pointerEvents="none" />
        {/* Backdrop - only covers area above modal */}
        <TouchableOpacity
          style={styles.backdrop}
          activeOpacity={1}
          onPress={handleClose}
        />

        <Animated.View
          style={[
            styles.modalContainer,
            { transform: [{ translateY: slideAnim }] },
          ]}
          pointerEvents="box-none"
        >
          <LinearGradient
            colors={['#0a0a1a', '#1a1a2e', '#0f0f20']}
            style={styles.modalContent}
            pointerEvents="box-none"
          >
            {/* Close button */}
            <TouchableOpacity style={styles.closeButton} onPress={handleClose}>
              <Ionicons name="close" size={28} color="rgba(255,255,255,0.7)" />
            </TouchableOpacity>

            {/* Title */}
            <Text style={styles.title}>Echo</Text>
            <Text style={styles.subtitle}>
              {status === 'listening'
                ? 'Listening...'
                : status === 'processing'
                ? 'Processing...'
                : status === 'responding'
                ? 'Speaking...'
                : 'Tap orb to speak'}
            </Text>

            {/* Living Orb - Main visual element */}
            <TouchableOpacity
              style={styles.orbContainer}
              onPress={handleMicPress}
              onPressIn={() => {
                // Immediate feedback on touch
                console.log('[Voice] Orb onPressIn triggered');
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              }}
              disabled={status === 'processing' || status === 'responding'}
              activeOpacity={0.7}
            >
              <View style={styles.orbTouchArea} pointerEvents="none">
                <EchoOrb status={status} size={260} />
              </View>
            </TouchableOpacity>

            {/* Small waveform for audio feedback when listening */}
            {status === 'listening' && (
              <View style={styles.miniWaveform}>
                <Waveform metering={metering} isActive={true} />
              </View>
            )}

            {/* Conversation area - scrollable */}
            <ScrollView
              style={styles.conversationArea}
              contentContainerStyle={styles.conversationContent}
              showsVerticalScrollIndicator={false}
            >
              {/* Transcript */}
              {transcript ? (
                <View style={styles.transcriptContainer}>
                  <View style={styles.messageBubble}>
                    <Text style={styles.messageLabel}>You</Text>
                    <Text style={styles.transcript}>{transcript}</Text>
                  </View>
                </View>
              ) : null}

              {/* Response */}
              {response ? (
                <View style={styles.responseContainer}>
                  <View style={[styles.messageBubble, styles.responseBubble]}>
                    <Text style={styles.messageLabel}>Echo</Text>
                    <Text style={[
                      styles.response,
                      status === 'error' && styles.errorText
                    ]}>
                      {response}
                    </Text>
                  </View>
                </View>
              ) : null}
            </ScrollView>

            {/* Edit Escape Hatch Buttons - Only show during confirmation */}
            {showEditButtons && !showEditOverlay && (
              <View style={styles.editButtonsContainer}>
                <TouchableOpacity
                  style={styles.editButton}
                  onPress={handleEditAmount}
                  accessibilityLabel="Edit amount"
                  accessibilityHint="Tap to change the transfer amount using keyboard"
                >
                  <Ionicons name="pencil-outline" size={14} color="rgba(255,255,255,0.5)" />
                  <Text style={styles.editButtonText}>Edit Amount</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.editButton}
                  onPress={handleEditRecipient}
                  accessibilityLabel="Edit recipient"
                  accessibilityHint="Tap to change the recipient using keyboard"
                >
                  <Ionicons name="person-outline" size={14} color="rgba(255,255,255,0.5)" />
                  <Text style={styles.editButtonText}>Edit Recipient</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* Edit Overlay - Keyboard input for sighted users */}
            {showEditOverlay && (
              <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                style={styles.editOverlay}
              >
                <View style={styles.editCard}>
                  <Text style={styles.editTitle}>
                    {editField === 'amount' ? 'Edit Amount' : 'Edit Recipient'}
                  </Text>
                  <Text style={styles.editSubtitle}>
                    {editField === 'amount'
                      ? 'Enter the correct amount in Naira'
                      : 'Enter the recipient name'}
                  </Text>

                  <TextInput
                    style={styles.editInput}
                    value={editValue}
                    onChangeText={setEditValue}
                    placeholder={editField === 'amount' ? '5000' : 'Recipient name'}
                    placeholderTextColor="rgba(255,255,255,0.3)"
                    keyboardType={editField === 'amount' ? 'numeric' : 'default'}
                    autoFocus
                    autoCapitalize={editField === 'amount' ? 'none' : 'words'}
                    returnKeyType="done"
                    onSubmitEditing={handleEditSubmit}
                  />

                  <View style={styles.editActions}>
                    <TouchableOpacity
                      style={styles.editCancelButton}
                      onPress={handleEditCancel}
                    >
                      <Text style={styles.editCancelText}>Cancel</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={styles.editSubmitButton}
                      onPress={handleEditSubmit}
                    >
                      <Text style={styles.editSubmitText}>Update</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </KeyboardAvoidingView>
            )}

            {/* Hint text */}
            <View style={styles.hintContainer}>
              <Text style={styles.hintText}>
                {status === 'listening'
                  ? 'Tap orb when done speaking'
                  : lastAction === 'awaiting_pin' || lastAction === 'retry_pin'
                  ? 'Say your PIN to confirm, or tap edit below'
                  : lastAction === 'awaiting_numbered_selection'
                  ? 'Say a number to select, or "more" for more options'
                  : lastAction === 'awaiting_spelling'
                  ? 'Spell letter by letter, like A-D-E'
                  : lastAction === 'awaiting_spelling_confirmation'
                  ? 'Say "yes" to confirm or "no" to try again'
                  : lastAction === 'awaiting_account_number'
                  ? 'Say the 10-digit account number'
                  : lastAction === 'awaiting_bank_name'
                  ? 'Say the bank name'
                  : lastAction === 'clarify_recipient'
                  ? 'Say name again, "spell it", or "my contacts"'
                  : lastAction === 'awaiting_correction'
                  ? 'Say the correct amount or name'
                  : lastAction === 'offer_save_beneficiary'
                  ? 'Say "yes" to save, or "no" to skip'
                  : lastAction === 'complete'
                  ? 'Done! Tap to speak again'
                  : 'Try: "Check my balance"'}
              </Text>
            </View>
          </LinearGradient>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    justifyContent: 'flex-end',
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: SCREEN_HEIGHT * 0.15, // Only covers area above modal
  },
  modalContainer: {
    height: SCREEN_HEIGHT * 0.85,
    borderTopLeftRadius: 40,
    borderTopRightRadius: 40,
    overflow: 'hidden',
  },
  modalContent: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: Platform.OS === 'ios' ? 40 : 20,
    alignItems: 'center',
  },
  closeButton: {
    position: 'absolute',
    top: 16,
    right: 16,
    padding: 12,
    zIndex: 10,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 20,
  },
  title: {
    fontSize: 32,
    fontWeight: '700',
    color: '#fff',
    marginTop: 10,
    letterSpacing: 2,
  },
  subtitle: {
    fontSize: 15,
    color: 'rgba(255,255,255,0.5)',
    marginTop: 4,
    letterSpacing: 0.5,
  },
  orbContainer: {
    marginTop: 10,
    marginBottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    // Explicit touch area for reliable tap detection
    width: 280,
    height: 280,
  },
  orbTouchArea: {
    width: 260,
    height: 260,
    justifyContent: 'center',
    alignItems: 'center',
  },
  miniWaveform: {
    height: 40,
    width: '80%',
    marginTop: -10,
    opacity: 0.6,
  },
  conversationArea: {
    flex: 1,
    width: '100%',
    marginTop: 10,
  },
  conversationContent: {
    paddingVertical: 10,
  },
  transcriptContainer: {
    width: '100%',
    marginBottom: 12,
    alignItems: 'flex-end',
  },
  responseContainer: {
    width: '100%',
    marginBottom: 12,
    alignItems: 'flex-start',
  },
  messageBubble: {
    maxWidth: '85%',
    padding: 14,
    backgroundColor: 'rgba(227, 25, 55, 0.15)',
    borderRadius: 18,
    borderTopRightRadius: 4,
  },
  responseBubble: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderTopRightRadius: 18,
    borderTopLeftRadius: 4,
  },
  messageLabel: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.4)',
    marginBottom: 4,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  transcript: {
    fontSize: 16,
    color: '#fff',
    lineHeight: 22,
  },
  response: {
    fontSize: 16,
    color: '#fff',
    lineHeight: 22,
  },
  errorText: {
    color: '#FF6B6B',
  },
  hintContainer: {
    paddingVertical: 16,
    paddingHorizontal: 20,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 20,
    marginTop: 10,
  },
  hintText: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.5)',
    textAlign: 'center',
    letterSpacing: 0.3,
  },
  // Edit escape hatch styles - subtle, non-intrusive
  editButtonsContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 20,
    marginTop: 8,
    marginBottom: 4,
  },
  editButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 14,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  editButtonText: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.5)',
    fontWeight: '500',
  },
  // Edit overlay styles
  editOverlay: {
    position: 'absolute',
    bottom: 100,
    left: 20,
    right: 20,
    zIndex: 100,
  },
  editCard: {
    backgroundColor: 'rgba(30, 30, 50, 0.98)',
    borderRadius: 20,
    padding: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 16,
    elevation: 10,
  },
  editTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#fff',
    textAlign: 'center',
    marginBottom: 4,
  },
  editSubtitle: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.5)',
    textAlign: 'center',
    marginBottom: 16,
  },
  editInput: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    fontSize: 18,
    color: '#fff',
    textAlign: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    marginBottom: 16,
  },
  editActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  editCancelButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
  },
  editCancelText: {
    fontSize: 15,
    color: 'rgba(255,255,255,0.6)',
    fontWeight: '600',
  },
  editSubmitButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: '#C9A962',
    alignItems: 'center',
  },
  editSubmitText: {
    fontSize: 15,
    color: '#000',
    fontWeight: '700',
  },
});