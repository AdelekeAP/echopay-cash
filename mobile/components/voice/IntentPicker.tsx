// IntentPicker — mock-dropdown voice flow for PRD §1 Script A 1:15 demo
// beat. Used by the home tab's voice hint card while the real
// /voice/intent backend is being built.
//
// The legacy VoiceModal in components/VoiceModal.tsx does real audio
// recording + posts to the broken :8000 voice service, AND its
// onTransferRequested contract hands back {recipient_name: string},
// not Funbi's §12 deeplink contract ({recipientId: 'iya_tope', ...}).
// So this is a clean-room small modal that gives the same visual cue
// (EchoOrb pulsing in 'listening' state) without any audio or network.
//
// Caller supplies an Intent[] and an onSelect callback. The modal stays
// purely presentational — no business logic, no router push, no
// state-aware routing. Demo intents are hardcoded in the caller.

import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import EchoOrb from '../EchoOrb';
import { Echopay } from '../../constants/theme';

export interface Intent {
  id: string;
  label: string;
  icon: string; // Ionicons name
  action: 'transfer_local' | 'balance';
  recipientId?: string;
  amountKobo?: number;
}

interface IntentPickerProps {
  visible: boolean;
  intents: Intent[];
  onClose: () => void;
  onSelect: (intent: Intent) => void;
}

export default function IntentPicker({
  visible,
  intents,
  onClose,
  onSelect,
}: IntentPickerProps) {
  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={false}
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.container}>
        <View style={styles.topBar}>
          <Pressable onPress={onClose} hitSlop={12} style={styles.closeButton}>
            <Ionicons name="close" size={26} color={Echopay.text} />
          </Pressable>
        </View>

        <View style={styles.heroBlock}>
          <View style={styles.orbWrap}>
            <EchoOrb status="listening" size={180} />
          </View>
          <Text style={styles.heroTitle}>Listening…</Text>
          <Text style={styles.heroSubtitle}>Try one of these:</Text>
        </View>

        <View style={styles.intentsBlock}>
          {intents.map((intent) => (
            <Pressable
              key={intent.id}
              onPress={() => onSelect(intent)}
              style={({ pressed }) => [
                styles.intentRow,
                pressed && styles.intentRowPressed,
              ]}
              hitSlop={6}
            >
              <View style={styles.intentIconCircle}>
                <Ionicons
                  name={intent.icon as any}
                  size={20}
                  color={Echopay.accent}
                />
              </View>
              <Text style={styles.intentLabel}>{intent.label}</Text>
              <Ionicons
                name="chevron-forward"
                size={18}
                color={Echopay.textSubtle}
              />
            </Pressable>
          ))}
        </View>

        <Text style={styles.footnote}>
          Demo intents — real voice recognition ships next sprint.
        </Text>
      </View>
    </Modal>
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
  closeButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Echopay.cardBg,
    borderWidth: 1,
    borderColor: Echopay.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroBlock: {
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
  heroSubtitle: {
    fontSize: 14,
    color: Echopay.textMuted,
    marginTop: 4,
  },
  intentsBlock: {
    backgroundColor: Echopay.cardBg,
    borderWidth: 1,
    borderColor: Echopay.border,
    borderRadius: 16,
    overflow: 'hidden',
  },
  intentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
    borderBottomColor: Echopay.border,
    gap: 14,
  },
  intentRowPressed: {
    backgroundColor: Echopay.cardSoft,
  },
  intentIconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Echopay.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  intentLabel: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
    color: Echopay.text,
  },
  footnote: {
    fontSize: 12,
    color: Echopay.textSubtle,
    textAlign: 'center',
    marginTop: 18,
    fontStyle: 'italic',
  },
});
