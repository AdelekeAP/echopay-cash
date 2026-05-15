// Voice signup screen — PRD §1 Script A 0:30 demo opener.
//
// Mama taps the mic, speaks her name, and lands on a success card
// showing her real GTBank account number. The screen is a four-state
// machine (idle → recording → processing → success/error) wired to the
// /auth/voice-signup endpoint from PR #11.
//
// Constraints honoured here (per the Wave-3 approval message):
//  - Web hard-blocks: Platform.OS === 'web' short-circuits the mic UI
//    and offers the persona-picker fallback at /login. No
//    useVoiceRecording call on web, no getUserMedia attempt.
//  - Recording auto-stops at 10s but the primary stop is tap-to-stop on
//    the orb. Countdown ticker shows once we cross the 5s mark.
//  - Legacy useVoiceRecording + EchoOrb are consumed directly. They're
//    @ts-nocheck'd at the file level but runtime-safe on phone.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { Echopay } from '../constants/theme';
import { useAuth } from '../context/AuthContext';
import { useVoiceRecording } from '../hooks/useVoiceRecording';
import EchoOrb from '../components/EchoOrb';
import {
  BackendError,
  VoiceSignupResponse,
  signupWithVoice,
} from '../services/squad-api';

type Stage = 'idle' | 'recording' | 'processing' | 'success' | 'error';

type ErrorKind =
  | 'mic_denied'
  | 'empty_transcript'
  | 'persona_unmatched'
  | 'voice_unavailable'
  | 'squad_failed'
  | 'network'
  | 'unknown';

const MAX_RECORDING_SECONDS = 10;
const COUNTDOWN_AFTER_SECONDS = 5;

export default function VoiceSignup() {
  const router = useRouter();
  const { setSession } = useAuth();

  // Hard-block web — useVoiceRecording wraps expo-av which has no
  // useful web shim for our flow. Demo runs on Expo Go on a phone.
  if (Platform.OS === 'web') {
    return <WebFallbackScreen onUsePicker={() => router.replace('/login')} />;
  }

  return <PhoneVoiceSignup onAuthed={setSession} onGoLogin={() => router.replace('/login')}
    onGoHome={() => router.replace('/(tabs)')} />;
}

// --------------------------------------------------------------- phone implementation

function PhoneVoiceSignup({
  onAuthed,
  onGoLogin,
  onGoHome,
}: {
  onAuthed: (
    user: VoiceSignupResponse['user'],
    account: VoiceSignupResponse['account'],
    token: string,
  ) => Promise<void>;
  onGoLogin: () => void;
  onGoHome: () => void;
}) {
  const [stage, setStage] = useState<Stage>('idle');
  const [errorKind, setErrorKind] = useState<ErrorKind | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [response, setResponse] = useState<VoiceSignupResponse | null>(null);
  const [secondsElapsed, setSecondsElapsed] = useState(0);

  const { recordingState, startRecording, stopRecording } = useVoiceRecording();

  // Tick a 1Hz timer during 'recording' for the countdown display.
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (tickRef.current) clearInterval(tickRef.current);
    if (autoStopRef.current) clearTimeout(autoStopRef.current);
  }, []);

  const handleSubmitAudio = useCallback(
    async (uri: string) => {
      setStage('processing');
      try {
        const data = await signupWithVoice(uri);
        setResponse(data);
        setStage('success');
      } catch (e) {
        const kind = mapErrorToKind(e);
        const msg = e instanceof Error ? e.message : 'Something went wrong.';
        setErrorKind(kind);
        setErrorMessage(msg);
        setStage('error');
      }
    },
    [],
  );

  const handleStop = useCallback(async () => {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    if (autoStopRef.current) {
      clearTimeout(autoStopRef.current);
      autoStopRef.current = null;
    }
    const uri = await stopRecording();
    if (!uri) {
      setErrorKind('mic_denied');
      setErrorMessage(
        recordingState.error || 'Microphone unavailable. Allow microphone access to continue.',
      );
      setStage('error');
      return;
    }
    await handleSubmitAudio(uri);
  }, [stopRecording, recordingState.error, handleSubmitAudio]);

  const handleStart = useCallback(async () => {
    setErrorKind(null);
    setErrorMessage(null);
    setResponse(null);
    setSecondsElapsed(0);
    setStage('recording');

    try {
      await startRecording();
    } catch (e) {
      setErrorKind('mic_denied');
      setErrorMessage(
        e instanceof Error ? e.message : 'Microphone unavailable.',
      );
      setStage('error');
      return;
    }

    // 1Hz tick for the countdown.
    tickRef.current = setInterval(() => {
      setSecondsElapsed((s) => s + 1);
    }, 1000);

    // Auto-stop at MAX_RECORDING_SECONDS.
    autoStopRef.current = setTimeout(() => {
      void handleStop();
    }, MAX_RECORDING_SECONDS * 1000);
  }, [startRecording, handleStop]);

  const handleContinue = useCallback(async () => {
    if (!response) return;
    await onAuthed(response.user, response.account, response.token);
    onGoHome();
  }, [response, onAuthed, onGoHome]);

  const handleReset = useCallback(() => {
    setStage('idle');
    setErrorKind(null);
    setErrorMessage(null);
    setResponse(null);
    setSecondsElapsed(0);
  }, []);

  // ----- render -----

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.scrollContent}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.brandRow}>
        <Text style={styles.brand}>EchoPay</Text>
      </View>

      {stage === 'idle' && (
        <IdleView onStart={handleStart} onUsePicker={onGoLogin} />
      )}

      {stage === 'recording' && (
        <RecordingView
          secondsElapsed={secondsElapsed}
          onStop={handleStop}
        />
      )}

      {stage === 'processing' && <ProcessingView />}

      {stage === 'success' && response && (
        <SuccessView response={response} onContinue={handleContinue} />
      )}

      {stage === 'error' && (
        <ErrorView
          kind={errorKind}
          message={errorMessage}
          onRetry={handleReset}
          onUsePicker={onGoLogin}
        />
      )}
    </ScrollView>
  );
}

// --------------------------------------------------------------- subviews

function IdleView({
  onStart,
  onUsePicker,
}: {
  onStart: () => void;
  onUsePicker: () => void;
}) {
  return (
    <View style={styles.idleBlock}>
      <View style={styles.headerBlock}>
        <Text style={styles.heroTitle}>Welcome to EchoPay</Text>
        <Text style={styles.heroBody}>Speak your full name to open your wallet.</Text>
        <Text style={styles.heroSubtitle}>Sọ orukọ rẹ</Text>
      </View>

      <Pressable
        onPress={onStart}
        style={({ pressed }) => [styles.micButton, pressed && styles.micButtonPressed]}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel="Start recording your name"
      >
        <Ionicons name="mic" size={42} color={Echopay.cardBg} />
      </Pressable>
      <Text style={styles.micHint}>Tap to start</Text>

      <Pressable onPress={onUsePicker} style={styles.pickerLink} hitSlop={10}>
        <Text style={styles.pickerLinkText}>Use a demo persona instead →</Text>
      </Pressable>
    </View>
  );
}

function RecordingView({
  secondsElapsed,
  onStop,
}: {
  secondsElapsed: number;
  onStop: () => void;
}) {
  const remaining = Math.max(0, MAX_RECORDING_SECONDS - secondsElapsed);
  const showCountdown = secondsElapsed >= COUNTDOWN_AFTER_SECONDS;

  return (
    <View style={styles.recordingBlock}>
      <Text style={styles.recordingTitle}>Listening…</Text>
      <Text style={styles.recordingBody}>Say your full name out loud.</Text>

      <Pressable
        onPress={onStop}
        style={styles.orbWrapper}
        hitSlop={20}
        accessibilityRole="button"
        accessibilityLabel="Stop recording"
      >
        <EchoOrb status="listening" size={220} />
      </Pressable>

      <Text style={styles.tapToStop}>Tap to stop</Text>
      {showCountdown && (
        <Text style={styles.countdown}>{remaining}s</Text>
      )}
    </View>
  );
}

function ProcessingView() {
  return (
    <View style={styles.processingBlock}>
      <ActivityIndicator size="large" color={Echopay.accent} />
      <Text style={styles.processingTitle}>Looking up your account…</Text>
      <Text style={styles.processingBody}>
        Talking to Squad to open your GTBank account.
      </Text>
    </View>
  );
}

function SuccessView({
  response,
  onContinue,
}: {
  response: VoiceSignupResponse;
  onContinue: () => void;
}) {
  const va = response.account.account_number;
  const formattedVa =
    va.length === 10
      ? `${va.slice(0, 4)} ${va.slice(4, 7)} ${va.slice(7)}`
      : va;
  const firstName = response.user.first_name;

  return (
    <View style={styles.successBlock}>
      <View style={styles.checkCircle}>
        <Text style={styles.checkMark}>✓</Text>
      </View>
      <Text style={styles.successTitle}>Welcome, {firstName}.</Text>
      <Text style={styles.successBody}>Your GTBank account is ready.</Text>

      <View style={styles.vaCard}>
        <Text style={styles.vaLabel}>YOUR ACCOUNT</Text>
        <Text style={styles.vaNumber}>{formattedVa}</Text>
        <Text style={styles.vaCaption}>Anyone can send you money here.</Text>
      </View>

      <Pressable
        onPress={onContinue}
        style={({ pressed }) => [styles.primaryButton, pressed && styles.primaryButtonPressed]}
      >
        <Text style={styles.primaryButtonText}>Continue</Text>
      </Pressable>
    </View>
  );
}

function ErrorView({
  kind,
  message,
  onRetry,
  onUsePicker,
}: {
  kind: ErrorKind | null;
  message: string | null;
  onRetry: () => void;
  onUsePicker: () => void;
}) {
  const copy = errorCopy(kind, message);
  return (
    <View style={styles.errorBlock}>
      <View style={styles.errorIcon}>
        <Ionicons name="alert-circle-outline" size={36} color={Echopay.danger} />
      </View>
      <Text style={styles.errorTitle}>{copy.title}</Text>
      <Text style={styles.errorBody}>{copy.body}</Text>

      <Pressable
        onPress={onRetry}
        style={({ pressed }) => [styles.primaryButton, pressed && styles.primaryButtonPressed]}
      >
        <Text style={styles.primaryButtonText}>Try again</Text>
      </Pressable>

      <Pressable onPress={onUsePicker} style={styles.secondaryLink} hitSlop={10}>
        <Text style={styles.secondaryLinkText}>Use a demo persona instead →</Text>
      </Pressable>
    </View>
  );
}

function WebFallbackScreen({ onUsePicker }: { onUsePicker: () => void }) {
  return (
    <View style={styles.webBlock}>
      <Text style={styles.brand}>EchoPay</Text>
      <View style={styles.webIcon}>
        <Ionicons name="phone-portrait-outline" size={44} color={Echopay.textMuted} />
      </View>
      <Text style={styles.heroTitle}>Voice signup is mobile-only</Text>
      <Text style={styles.heroBody}>
        Open EchoPay on a phone via Expo Go to sign up with your voice.
        On the web preview, use a demo persona to continue.
      </Text>
      <Pressable
        onPress={onUsePicker}
        style={({ pressed }) => [styles.primaryButton, pressed && styles.primaryButtonPressed]}
      >
        <Text style={styles.primaryButtonText}>Use a demo persona</Text>
      </Pressable>
    </View>
  );
}

// --------------------------------------------------------------- helpers

function mapErrorToKind(e: unknown): ErrorKind {
  if (e instanceof BackendError) {
    switch (e.code) {
      case 'transcription_empty':
        return 'empty_transcript';
      case 'persona_unmatched':
        return 'persona_unmatched';
      case 'voice_unavailable':
        return 'voice_unavailable';
      case 'squad_failed':
        return 'squad_failed';
      case 'network':
        return 'network';
      default:
        return 'unknown';
    }
  }
  return 'unknown';
}

function errorCopy(kind: ErrorKind | null, fallback: string | null): { title: string; body: string } {
  switch (kind) {
    case 'mic_denied':
      return {
        title: 'Microphone needed',
        body: 'Allow microphone access to continue.',
      };
    case 'empty_transcript':
      return {
        title: 'I didn’t catch that',
        body: 'Try again, a bit closer to the mic.',
      };
    case 'persona_unmatched':
      return {
        title: 'Name not recognised',
        body: 'We couldn’t match that to a demo persona. Use the picker instead.',
      };
    case 'voice_unavailable':
    case 'squad_failed':
      return {
        title: 'Service is busy',
        body: 'Couldn’t open your account. Try again, or use a demo persona.',
      };
    case 'network':
      return {
        title: 'Connection problem',
        body: 'Check your network and try again.',
      };
    default:
      return {
        title: 'Something went wrong',
        body: fallback ?? 'Try again, or use a demo persona.',
      };
  }
}

// --------------------------------------------------------------- styles

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Echopay.pageBg,
  },
  scrollContent: {
    flexGrow: 1,
    padding: 24,
    paddingBottom: 60,
  },

  brandRow: {
    alignItems: 'center',
    marginTop: 12,
    marginBottom: 20,
  },
  brand: {
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: -0.4,
    color: Echopay.text,
  },

  headerBlock: {
    alignItems: 'center',
    marginBottom: 24,
    paddingHorizontal: 8,
  },
  heroTitle: {
    fontSize: 26,
    fontWeight: '700',
    color: Echopay.text,
    textAlign: 'center',
    letterSpacing: -0.5,
    marginBottom: 10,
  },
  heroBody: {
    fontSize: 15,
    color: Echopay.textMuted,
    textAlign: 'center',
    lineHeight: 22,
  },
  heroSubtitle: {
    fontSize: 13,
    color: Echopay.textSubtle,
    textAlign: 'center',
    marginTop: 6,
    fontStyle: 'italic',
  },

  // ----- idle stage -----

  idleBlock: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
  },
  micButton: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: Echopay.accent,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
  },
  micButtonPressed: {
    backgroundColor: Echopay.accentPressed,
  },
  micHint: {
    fontSize: 13,
    color: Echopay.textMuted,
    marginTop: 16,
    fontWeight: '600',
    letterSpacing: 0.4,
  },
  pickerLink: {
    marginTop: 32,
    paddingVertical: 6,
  },
  pickerLinkText: {
    fontSize: 14,
    color: Echopay.accent,
    fontWeight: '600',
  },

  // ----- recording stage -----

  recordingBlock: {
    alignItems: 'center',
    paddingVertical: 8,
  },
  recordingTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: Echopay.text,
    marginBottom: 6,
  },
  recordingBody: {
    fontSize: 14,
    color: Echopay.textMuted,
    marginBottom: 14,
  },
  orbWrapper: {
    width: 240,
    height: 240,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tapToStop: {
    fontSize: 14,
    color: Echopay.textMuted,
    marginTop: 4,
    fontWeight: '600',
  },
  countdown: {
    fontSize: 36,
    fontWeight: '800',
    color: Echopay.accent,
    marginTop: 14,
    fontVariant: ['tabular-nums'],
  },

  // ----- processing stage -----

  processingBlock: {
    alignItems: 'center',
    paddingVertical: 60,
    gap: 18,
  },
  processingTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: Echopay.text,
    marginTop: 12,
  },
  processingBody: {
    fontSize: 14,
    color: Echopay.textMuted,
    textAlign: 'center',
    maxWidth: 280,
  },

  // ----- success stage -----

  successBlock: {
    alignItems: 'center',
    paddingVertical: 16,
  },
  checkCircle: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: Echopay.success,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 22,
  },
  checkMark: {
    color: Echopay.cardBg,
    fontSize: 44,
    fontWeight: '700',
  },
  successTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: Echopay.text,
    textAlign: 'center',
  },
  successBody: {
    fontSize: 15,
    color: Echopay.textMuted,
    marginTop: 6,
    textAlign: 'center',
  },
  vaCard: {
    backgroundColor: Echopay.cardBg,
    borderWidth: 1,
    borderColor: Echopay.border,
    borderRadius: 18,
    paddingVertical: 22,
    paddingHorizontal: 28,
    marginTop: 28,
    width: '100%',
    alignItems: 'center',
  },
  vaLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: Echopay.textMuted,
    letterSpacing: 1.4,
    marginBottom: 8,
  },
  vaNumber: {
    fontSize: 30,
    fontWeight: '800',
    color: Echopay.text,
    letterSpacing: 4,
    fontVariant: ['tabular-nums'],
  },
  vaCaption: {
    fontSize: 13,
    color: Echopay.textSubtle,
    marginTop: 8,
    textAlign: 'center',
  },

  primaryButton: {
    backgroundColor: Echopay.accent,
    paddingVertical: 16,
    paddingHorizontal: 32,
    borderRadius: 14,
    alignItems: 'center',
    marginTop: 28,
    minWidth: 220,
  },
  primaryButtonPressed: {
    backgroundColor: Echopay.accentPressed,
  },
  primaryButtonText: {
    color: Echopay.cardBg,
    fontSize: 16,
    fontWeight: '600',
  },

  // ----- error stage -----

  errorBlock: {
    alignItems: 'center',
    paddingVertical: 24,
  },
  errorIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: Echopay.dangerSoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18,
  },
  errorTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: Echopay.text,
    textAlign: 'center',
  },
  errorBody: {
    fontSize: 14,
    color: Echopay.textMuted,
    marginTop: 8,
    textAlign: 'center',
    maxWidth: 300,
    lineHeight: 21,
  },
  secondaryLink: {
    marginTop: 14,
    paddingVertical: 6,
  },
  secondaryLinkText: {
    fontSize: 14,
    color: Echopay.accent,
    fontWeight: '600',
  },

  // ----- web fallback -----

  webBlock: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
    backgroundColor: Echopay.pageBg,
    gap: 12,
  },
  webIcon: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: Echopay.cardSoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 12,
  },
});
