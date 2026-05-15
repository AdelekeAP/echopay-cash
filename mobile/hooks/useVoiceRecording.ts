// @ts-nocheck — legacy file inherited from EchoPay v1; pre-strict TS. Do not modify (see CLAUDE.md).
import { useState, useRef, useCallback, useEffect } from 'react';
import { Audio } from 'expo-av';
import * as Haptics from 'expo-haptics';

export interface RecordingState {
  isRecording: boolean;
  isPaused: boolean;
  duration: number;
  uri: string | null;
  error: string | null;
  metering: number; // Audio level for waveform visualization
}

export interface UseVoiceRecordingReturn {
  recordingState: RecordingState;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<string | null>;
  cancelRecording: () => Promise<void>;
  resetRecording: () => void;
}

export function useVoiceRecording(): UseVoiceRecordingReturn {
  const [recordingState, setRecordingState] = useState<RecordingState>({
    isRecording: false,
    isPaused: false,
    duration: 0,
    uri: null,
    error: null,
    metering: -160, // Silent
  });

  const recordingRef = useRef<Audio.Recording | null>(null);
  const durationIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const meteringIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Request permissions on mount
  useEffect(() => {
    (async () => {
      try {
        const { status } = await Audio.requestPermissionsAsync();
        if (status !== 'granted') {
          setRecordingState(prev => ({
            ...prev,
            error: 'Microphone permission is required for voice banking',
          }));
        }
      } catch (error) {
        console.error('Permission request error:', error);
      }
    })();

    // Cleanup on unmount
    return () => {
      if (durationIntervalRef.current) clearInterval(durationIntervalRef.current);
      if (meteringIntervalRef.current) clearInterval(meteringIntervalRef.current);
      if (recordingRef.current) {
        recordingRef.current.stopAndUnloadAsync().catch(() => {});
      }
    };
  }, []);

  // Start recording
  const startRecording = useCallback(async () => {
    try {
      // Configure audio mode for recording
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });

      // Create recording with high quality settings
      const { recording } = await Audio.Recording.createAsync(
        {
          android: {
            extension: '.m4a',
            outputFormat: Audio.AndroidOutputFormat.MPEG_4,
            audioEncoder: Audio.AndroidAudioEncoder.AAC,
            sampleRate: 16000,
            numberOfChannels: 1,
            bitRate: 128000,
          },
          ios: {
            extension: '.m4a',
            audioQuality: Audio.IOSAudioQuality.HIGH,
            sampleRate: 16000,
            numberOfChannels: 1,
            bitRate: 128000,
            linearPCMBitDepth: 16,
            linearPCMIsBigEndian: false,
            linearPCMIsFloat: false,
          },
          web: {
            mimeType: 'audio/webm',
            bitsPerSecond: 128000,
          },
        },
        (status) => {
          // Update metering for waveform visualization
          if (status.isRecording && status.metering !== undefined) {
            setRecordingState(prev => ({
              ...prev,
              metering: status.metering!,
            }));
          }
        },
        100 // Metering update interval in ms
      );

      recordingRef.current = recording;

      // Haptic feedback
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      // Start duration timer
      const startTime = Date.now();
      durationIntervalRef.current = setInterval(() => {
        setRecordingState(prev => ({
          ...prev,
          duration: Math.floor((Date.now() - startTime) / 1000),
        }));
      }, 1000);

      setRecordingState(prev => ({
        ...prev,
        isRecording: true,
        isPaused: false,
        duration: 0,
        uri: null,
        error: null,
      }));

    } catch (error: any) {
      console.error('Start recording error:', error);
      setRecordingState(prev => ({
        ...prev,
        error: 'Failed to start recording. Please check microphone access.',
      }));
    }
  }, []);

  // Stop recording and return URI
  const stopRecording = useCallback(async (): Promise<string | null> => {
    if (!recordingRef.current) return null;

    try {
      // Stop timers
      if (durationIntervalRef.current) {
        clearInterval(durationIntervalRef.current);
        durationIntervalRef.current = null;
      }
      if (meteringIntervalRef.current) {
        clearInterval(meteringIntervalRef.current);
        meteringIntervalRef.current = null;
      }

      // Stop recording
      await recordingRef.current.stopAndUnloadAsync();
      const uri = recordingRef.current.getURI();

      // Haptic feedback
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      // Reset audio mode
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
      });

      setRecordingState(prev => ({
        ...prev,
        isRecording: false,
        isPaused: false,
        uri,
        metering: -160,
      }));

      recordingRef.current = null;
      return uri;

    } catch (error: any) {
      console.error('Stop recording error:', error);
      setRecordingState(prev => ({
        ...prev,
        isRecording: false,
        error: 'Failed to stop recording.',
      }));
      return null;
    }
  }, []);

  // Cancel recording without saving
  const cancelRecording = useCallback(async () => {
    if (!recordingRef.current) return;

    try {
      // Stop timers
      if (durationIntervalRef.current) {
        clearInterval(durationIntervalRef.current);
        durationIntervalRef.current = null;
      }
      if (meteringIntervalRef.current) {
        clearInterval(meteringIntervalRef.current);
        meteringIntervalRef.current = null;
      }

      await recordingRef.current.stopAndUnloadAsync();

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
      });

      setRecordingState({
        isRecording: false,
        isPaused: false,
        duration: 0,
        uri: null,
        error: null,
        metering: -160,
      });

      recordingRef.current = null;

    } catch (error) {
      console.error('Cancel recording error:', error);
    }
  }, []);

  // Reset recording state
  const resetRecording = useCallback(() => {
    setRecordingState({
      isRecording: false,
      isPaused: false,
      duration: 0,
      uri: null,
      error: null,
      metering: -160,
    });
  }, []);

  return {
    recordingState,
    startRecording,
    stopRecording,
    cancelRecording,
    resetRecording,
  };
}

export default useVoiceRecording;