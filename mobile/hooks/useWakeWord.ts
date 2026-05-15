// @ts-nocheck — legacy file inherited from EchoPay v1; pre-strict TS. Do not modify (see CLAUDE.md).
import { useState, useEffect, useRef, useCallback } from 'react';
import { AppState, AppStateStatus, Platform, NativeEventEmitter, NativeModules } from 'react-native';
import * as Haptics from 'expo-haptics';

// Wake word configuration
const WAKE_WORDS = [
  'hello echo',
  'hey echo',
  'hi echo',
  'hello eco',
  'hey eco',
  'helloecho',
  'eco',
  'echo',
];

export interface UseWakeWordProps {
  onWakeWordDetected: () => void;
  enabled?: boolean;
}

export interface UseWakeWordReturn {
  isListening: boolean;
  isSupported: boolean;
  error: string | null;
  lastHeard: string | null;
  startListening: () => Promise<void>;
  stopListening: () => void;
}

// Try to import Voice module
let Voice: any = null;
try {
  Voice = require('@react-native-voice/voice').default;
} catch (e) {
  console.log('[WakeWord] react-native-voice not available, using fallback');
}

/**
 * Wake word detection hook using react-native-voice
 *
 * Listens continuously for "Hello Echo" and triggers callback when detected
 */
export function useWakeWord({
  onWakeWordDetected,
  enabled = true,
}: UseWakeWordProps): UseWakeWordReturn {
  const [isListening, setIsListening] = useState(false);
  const [isSupported, setIsSupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastHeard, setLastHeard] = useState<string | null>(null);

  const appState = useRef(AppState.currentState);
  const isProcessingWakeWord = useRef(false);
  const restartTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Check if Voice is available
  useEffect(() => {
    if (Voice) {
      setIsSupported(true);
    } else {
      setIsSupported(false);
      setError('Voice recognition not available on this device');
    }
  }, []);

  // Check if text contains wake word
  const containsWakeWord = useCallback((text: string): boolean => {
    const normalizedText = text.toLowerCase().trim();
    return WAKE_WORDS.some(word => normalizedText.includes(word));
  }, []);

  // Handle speech results
  const onSpeechResults = useCallback((event: any) => {
    if (!event.value || event.value.length === 0) return;

    const results = event.value as string[];
    const heard = results[0]?.toLowerCase() || '';
    setLastHeard(heard);

    console.log('[WakeWord] Heard:', heard);

    // Check for wake word
    if (containsWakeWord(heard) && !isProcessingWakeWord.current) {
      isProcessingWakeWord.current = true;
      console.log('[WakeWord] Wake word detected!');

      // Stop listening temporarily
      stopListening();

      // Trigger haptic feedback and callback
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onWakeWordDetected();

      // Reset processing flag after delay
      setTimeout(() => {
        isProcessingWakeWord.current = false;
      }, 2000);
    }
  }, [containsWakeWord, onWakeWordDetected]);

  // Handle speech end - restart listening
  const onSpeechEnd = useCallback(() => {
    if (enabled && !isProcessingWakeWord.current) {
      // Restart listening after a short delay
      restartTimeoutRef.current = setTimeout(() => {
        if (enabled && !isProcessingWakeWord.current) {
          startListeningInternal();
        }
      }, 500);
    }
  }, [enabled]);

  // Handle speech error
  const onSpeechError = useCallback((event: any) => {
    console.log('[WakeWord] Speech error:', event.error);

    // Don't set error for common non-fatal errors
    if (event.error?.code !== '7' && event.error?.code !== '5') {
      // Restart listening on recoverable errors
      if (enabled && !isProcessingWakeWord.current) {
        restartTimeoutRef.current = setTimeout(() => {
          startListeningInternal();
        }, 1000);
      }
    }
  }, [enabled]);

  // Internal start listening function
  const startListeningInternal = useCallback(async () => {
    if (!Voice || !enabled) return;

    try {
      await Voice.start('en-US');
      setIsListening(true);
      setError(null);
    } catch (err: any) {
      console.error('[WakeWord] Start error:', err);
      // Retry after delay
      restartTimeoutRef.current = setTimeout(() => {
        startListeningInternal();
      }, 2000);
    }
  }, [enabled]);

  // Setup Voice event listeners
  useEffect(() => {
    if (!Voice || !enabled) return;

    Voice.onSpeechResults = onSpeechResults;
    Voice.onSpeechEnd = onSpeechEnd;
    Voice.onSpeechError = onSpeechError;

    // Start listening
    startListeningInternal();

    return () => {
      if (restartTimeoutRef.current) {
        clearTimeout(restartTimeoutRef.current);
      }
      Voice.destroy().then(Voice.removeAllListeners).catch(() => {});
    };
  }, [enabled, onSpeechResults, onSpeechEnd, onSpeechError, startListeningInternal]);

  // Handle app state changes
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState: AppStateStatus) => {
      if (appState.current === 'active' && nextAppState.match(/inactive|background/)) {
        stopListening();
      } else if (appState.current.match(/inactive|background/) && nextAppState === 'active') {
        if (enabled) {
          startListeningInternal();
        }
      }
      appState.current = nextAppState;
    });

    return () => {
      subscription.remove();
    };
  }, [enabled, startListeningInternal]);

  // Public start listening function
  const startListening = useCallback(async () => {
    if (!isSupported || !enabled) {
      setError('Wake word detection not available');
      return;
    }
    await startListeningInternal();
  }, [isSupported, enabled, startListeningInternal]);

  // Stop listening function
  const stopListening = useCallback(() => {
    if (restartTimeoutRef.current) {
      clearTimeout(restartTimeoutRef.current);
      restartTimeoutRef.current = null;
    }

    if (Voice) {
      Voice.stop().catch(() => {});
      Voice.cancel().catch(() => {});
    }

    setIsListening(false);
  }, []);

  return {
    isListening,
    isSupported,
    error,
    lastHeard,
    startListening,
    stopListening,
  };
}

export default useWakeWord;