// VoiceIntentModal — real voice-to-intent flow for PRD §3.14.
//
// Records audio via useVoiceRecording, posts to POST /voice/intent,
// and calls onIntent() with the typed result. On intent failure (network
// error or action='unknown'), surfaces an error state that falls back to
// the IntentPicker mock-dropdown.
//
// VOICE_DEMO_MODE=true on the backend means audio doesn't need to be
// intelligible — backend returns a hardcoded transfer intent regardless.
// That's the demo-day insurance path for the 1:15 Script A beat.
//
// Imports EchoOrb and useVoiceRecording from the legacy voice stack.
// Those files are @ts-nocheck'd per CLAUDE.md; importing them here is
// runtime-safe. Calls go through their exported API, not internals.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const EchoOrb = require('../EchoOrb').default;
import { useVoiceRecording } from '../../hooks/useVoiceRecording';
import { parseIntent } from '../../services/squad-api';
import { Echopay } from '../../constants/theme';
import IntentPicker, { Intent } from './IntentPicker';

type Stage = 'idle' | 'recording' | 'processing' | 'error';

export interface VoiceIntentModalProps {
  visible: boolean;
  onClose: () => void;
  /** Fired once intent is resolved. Caller handles routing / alerts. */
  onIntent: (
    action: string,
    entities: { recipientId?: string; amountKobo?: number; balance_kobo?: number },
  ) => void;
}

const AUTO_STOP_MS = 5_000;

const _FALLBACK_INTENTS: Intent[] = [
  {
    id: 'send_iya',
    label: 'Send ₦5,000 to Iya Tope',
    icon: 'paper-plane-outline',
    action: 'transfer_local',
    recipientId: 'iya_tope',
    amountKobo: 500_000,
  },
  {
    id: 'send_kosi',
    label: 'Send ₦200 to Kosi',
    icon: 'paper-plane-outline',
    action: 'transfer_local',
    recipientId: 'kosi',
    amountKobo: 20_000,
  },
  {
    id: 'balance',
    label: "What's my balance?",
    icon: 'wallet-outline',
    action: 'balance',
  },
];

export default function VoiceIntentModal({
  visible,
  onClose,
  onIntent,
}: VoiceIntentModalProps) {
  const [stage, setStage] = useState<Stage>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [pickerVisible, setPickerVisible] = useState(false);
  const autoStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { startRecording, stopRecording } = useVoiceRecording();

  // Reset to idle whenever the modal opens.
  useEffect(() => {
    if (visible) {
      setStage('idle');
      setErrorMsg('');
      setPickerVisible(false);
    }
    if (!visible && autoStopRef.current) {
      clearTimeout(autoStopRef.current);
      autoStopRef.current = null;
    }
  }, [visible]);

  const handleStop = useCallback(async () => {
    if (autoStopRef.current) {
      clearTimeout(autoStopRef.current);
      autoStopRef.current = null;
    }
    setStage('processing');
    try {
      const uri = await stopRecording();
      if (!uri) throw new Error('no uri');
      const token = await AsyncStorage.getItem('token');
      const result = await parseIntent(uri, token);
      if (result.action === 'unknown') {
        setErrorMsg("Didn't catch that. Try again or tap below.");
        setStage('error');
        return;
      }
      onIntent(result.action, result.entities);
    } catch {
      setErrorMsg('Something went wrong. Try again or tap below.');
      setStage('error');
    }
  }, [onIntent, stopRecording]);

  const handleRecord = useCallback(async () => {
    try {
      await startRecording();
      setStage('recording');
      autoStopRef.current = setTimeout(() => {
        handleStop();
      }, AUTO_STOP_MS);
    } catch {
      setErrorMsg('Microphone unavailable. Please check permissions.');
      setStage('error');
    }
  }, [startRecording, handleStop]);

  const handleFallbackSelect = useCallback(
    (intent: Intent) => {
      setPickerVisible(false);
      onIntent(intent.action, {
        recipientId: intent.recipientId,
        amountKobo: intent.amountKobo,
      });
    },
    [onIntent],
  );

  const orbStatus =
    stage === 'recording'
      ? 'listening'
      : stage === 'processing'
        ? 'processing'
        : stage === 'error'
          ? 'error'
          : 'idle';

  const actionLabel =
    stage === 'idle'
      ? 'Voice command'
      : stage === 'recording'
        ? 'Listening…'
        : stage === 'processing'
          ? 'Processing…'
          : 'Try again';

  return (
    <>
      <Modal
        visible={visible && !pickerVisible}
        animationType="slide"
        transparent={false}
        onRequestClose={onClose}
        statusBarTranslucent
      >
        <View style={styles.container}>
          {/* top bar */}
          <View style={styles.topBar}>
            <Pressable onPress={onClose} hitSlop={12} style={styles.closeBtn}>
              <Ionicons name="close" size={26} color={Echopay.text} />
            </Pressable>
          </View>

          {/* orb + label */}
          <View style={styles.hero}>
            <View style={styles.orbWrap}>
              <EchoOrb status={orbStatus} size={180} />
            </View>
            <Text style={styles.heroTitle}>{actionLabel}</Text>
            {stage === 'error' && (
              <Text style={styles.errorText}>{errorMsg}</Text>
            )}
          </View>

          {/* action area */}
          <View style={styles.actions}>
            {stage === 'idle' && (
              <Pressable
                style={({ pressed }) => [styles.micBtn, pressed && styles.micBtnPressed]}
                onPress={handleRecord}
              >
                <Ionicons name="mic" size={32} color={Echopay.pageBg} />
                <Text style={styles.micLabel}>Tap to speak</Text>
              </Pressable>
            )}

            {stage === 'recording' && (
              <Pressable
                style={({ pressed }) => [
                  styles.micBtn,
                  styles.micBtnRecording,
                  pressed && styles.micBtnPressed,
                ]}
                onPress={handleStop}
              >
                <Ionicons name="stop" size={32} color={Echopay.pageBg} />
                <Text style={styles.micLabel}>Tap to stop</Text>
              </Pressable>
            )}

            {stage === 'processing' && (
              <View style={styles.processingRow}>
                <Text style={styles.processingText}>One moment…</Text>
              </View>
            )}

            {stage === 'error' && (
              <View style={styles.errorBtns}>
                <Pressable
                  style={({ pressed }) => [
                    styles.retryBtn,
                    pressed && styles.retryBtnPressed,
                  ]}
                  onPress={() => {
                    setStage('idle');
                    setErrorMsg('');
                  }}
                >
                  <Text style={styles.retryLabel}>Try again</Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [
                    styles.pickerBtn,
                    pressed && styles.pickerBtnPressed,
                  ]}
                  onPress={() => setPickerVisible(true)}
                >
                  <Text style={styles.pickerLabel}>Use example phrases</Text>
                </Pressable>
              </View>
            )}
          </View>

          <Text style={styles.footnote}>
            {stage === 'recording'
              ? `Auto-stops in ${AUTO_STOP_MS / 1000}s`
              : 'Say "Send ₦5,000 to Iya Tope" or "Check my balance"'}
          </Text>
        </View>
      </Modal>

      {/* Fallback mock picker in case voice can't be understood */}
      <IntentPicker
        visible={pickerVisible}
        intents={_FALLBACK_INTENTS}
        onClose={() => setPickerVisible(false)}
        onSelect={handleFallbackSelect}
      />
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Echopay.pageBg,
    paddingHorizontal: 24,
    paddingTop: 50,
  },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  closeBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Echopay.cardBg,
    borderWidth: 1,
    borderColor: Echopay.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hero: {
    alignItems: 'center',
    marginTop: 18,
    marginBottom: 28,
  },
  orbWrap: {
    width: 200,
    height: 200,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: Echopay.text,
    marginTop: 8,
  },
  errorText: {
    fontSize: 13,
    color: Echopay.danger,
    marginTop: 6,
    textAlign: 'center',
    paddingHorizontal: 16,
  },
  actions: {
    alignItems: 'center',
    gap: 12,
  },
  micBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: Echopay.accent,
    paddingVertical: 16,
    paddingHorizontal: 32,
    borderRadius: 50,
  },
  micBtnRecording: {
    backgroundColor: Echopay.danger,
  },
  micBtnPressed: {
    opacity: 0.85,
  },
  micLabel: {
    fontSize: 16,
    fontWeight: '700',
    color: Echopay.pageBg,
  },
  processingRow: {
    paddingVertical: 16,
  },
  processingText: {
    fontSize: 15,
    color: Echopay.textMuted,
  },
  errorBtns: {
    width: '100%',
    gap: 10,
  },
  retryBtn: {
    backgroundColor: Echopay.accent,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  retryBtnPressed: {
    opacity: 0.85,
  },
  retryLabel: {
    fontSize: 15,
    fontWeight: '700',
    color: Echopay.pageBg,
  },
  pickerBtn: {
    backgroundColor: Echopay.cardBg,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Echopay.border,
  },
  pickerBtnPressed: {
    backgroundColor: Echopay.cardSoft,
  },
  pickerLabel: {
    fontSize: 15,
    fontWeight: '600',
    color: Echopay.accent,
  },
  footnote: {
    fontSize: 12,
    color: Echopay.textSubtle,
    textAlign: 'center',
    marginTop: 24,
    fontStyle: 'italic',
  },
});
