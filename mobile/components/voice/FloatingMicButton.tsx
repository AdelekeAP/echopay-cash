// FloatingMicButton — typed, strict-TS, Echopay-accent rebuild of the
// legacy components/FloatingMicButton.tsx (which is @ts-nocheck'd and
// gated by CLAUDE.md against modification).
//
// Functional parity with the legacy: 60px circular FAB positioned above
// the tab bar, draggable with edge-snapping, pulses when idle, glows
// when listening, rotates when processing, haptics on press.
//
// Visual: replaces the legacy red/green gradients with the Echopay
// accent orange. Soft accent ring instead of a green drop shadow.

import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useRef } from 'react';
import {
  Animated,
  Dimensions,
  PanResponder,
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';

import { Echopay } from '../../constants/theme';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const BUTTON_SIZE = 60;
const MARGIN = 20;
const INITIAL_X = SCREEN_WIDTH - BUTTON_SIZE - MARGIN;
const INITIAL_Y = SCREEN_HEIGHT - BUTTON_SIZE - 180;

export interface FloatingMicButtonProps {
  onPress: () => void;
  isListening?: boolean;
  isProcessing?: boolean;
  disabled?: boolean;
}

export default function FloatingMicButton({
  onPress,
  isListening = false,
  isProcessing = false,
  disabled = false,
}: FloatingMicButtonProps) {
  const pan = useRef(new Animated.ValueXY({ x: INITIAL_X, y: INITIAL_Y })).current;
  // Track the current pan offset in a plain ref so we don't reach into
  // Animated.Value internals (which strict TS rejects).
  const panPos = useRef({ x: INITIAL_X, y: INITIAL_Y });

  const pulseAnim = useRef(new Animated.Value(1)).current;
  const glowAnim = useRef(new Animated.Value(0)).current;
  const rotateAnim = useRef(new Animated.Value(0)).current;

  // Pulse loop when idle (not listening, not processing).
  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.08, duration: 1500, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 1500, useNativeDriver: true }),
      ]),
    );
    if (!isListening && !isProcessing) {
      pulse.start();
    } else {
      pulse.stop();
      pulseAnim.setValue(1);
    }
    return () => pulse.stop();
  }, [isListening, isProcessing, pulseAnim]);

  // Glow loop when listening.
  useEffect(() => {
    if (isListening) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(glowAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
          Animated.timing(glowAnim, { toValue: 0.3, duration: 600, useNativeDriver: true }),
        ]),
      ).start();
    } else {
      glowAnim.setValue(0);
    }
  }, [isListening, glowAnim]);

  // Rotate when processing.
  useEffect(() => {
    if (isProcessing) {
      Animated.loop(
        Animated.timing(rotateAnim, { toValue: 1, duration: 1000, useNativeDriver: true }),
      ).start();
    } else {
      rotateAnim.setValue(0);
    }
  }, [isProcessing, rotateAnim]);

  // Drag with edge snap + Y clamp.
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 5 || Math.abs(g.dy) > 5,
      onPanResponderGrant: () => {
        pan.setOffset({ x: panPos.current.x, y: panPos.current.y });
        pan.setValue({ x: 0, y: 0 });
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      },
      onPanResponderMove: Animated.event(
        [null, { dx: pan.x, dy: pan.y }],
        { useNativeDriver: false },
      ),
      onPanResponderRelease: (_, g) => {
        pan.flattenOffset();
        const currentX = panPos.current.x + g.dx;
        const currentY = panPos.current.y + g.dy;
        const snapToRight = currentX > SCREEN_WIDTH / 2;
        const targetX = snapToRight ? SCREEN_WIDTH - BUTTON_SIZE - MARGIN : MARGIN;
        const minY = 100;
        const maxY = SCREEN_HEIGHT - BUTTON_SIZE - 180;
        const targetY = Math.max(minY, Math.min(maxY, currentY));

        panPos.current = { x: targetX, y: targetY };
        Animated.spring(pan, {
          toValue: { x: targetX, y: targetY },
          friction: 7,
          tension: 40,
          useNativeDriver: false,
        }).start();
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      },
    }),
  ).current;

  const handlePress = async () => {
    if (disabled) return;
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onPress();
  };

  const glowOpacity = glowAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 0.6],
  });
  const rotation = rotateAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  // PRD_LEKE §5.3 accent polish: orange gradient always, with the
  // listening/processing differentiation in the icon and glow.
  const gradient: readonly [string, string] = isProcessing
    ? [Echopay.accentMuted, Echopay.accentSoft]
    : [Echopay.accent, Echopay.accentPressed];

  return (
    <Animated.View
      style={[
        styles.container,
        {
          transform: [
            { translateX: pan.x },
            { translateY: pan.y },
            { scale: pulseAnim },
          ],
        },
      ]}
      {...panResponder.panHandlers}
    >
      {isListening && (
        <>
          <Animated.View style={[styles.glowRing, styles.glowRing1, { opacity: glowOpacity }]} />
          <Animated.View
            style={[
              styles.glowRing,
              styles.glowRing2,
              { opacity: Animated.multiply(glowOpacity, 0.5) },
            ]}
          />
        </>
      )}

      <TouchableOpacity
        onPress={handlePress}
        disabled={disabled}
        activeOpacity={0.85}
        style={styles.buttonWrapper}
      >
        <LinearGradient
          colors={gradient}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.button}
        >
          {isProcessing ? (
            <Animated.View style={{ transform: [{ rotate: rotation }] }}>
              <Ionicons name="sync" size={28} color={Echopay.pageBg} />
            </Animated.View>
          ) : (
            <Ionicons
              name={isListening ? 'mic' : 'mic-outline'}
              size={28}
              color={Echopay.pageBg}
            />
          )}
        </LinearGradient>
      </TouchableOpacity>

      <View style={styles.shadow} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    zIndex: 1000,
  },
  buttonWrapper: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: BUTTON_SIZE / 2,
    overflow: 'hidden',
  },
  button: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: BUTTON_SIZE / 2,
  },
  shadow: {
    position: 'absolute',
    top: 4,
    left: 4,
    right: 4,
    bottom: -4,
    borderRadius: BUTTON_SIZE / 2,
    backgroundColor: Echopay.accentSoft,
    zIndex: -1,
  },
  glowRing: {
    position: 'absolute',
    borderRadius: 100,
    backgroundColor: Echopay.accent,
  },
  glowRing1: { top: -10, left: -10, right: -10, bottom: -10 },
  glowRing2: { top: -20, left: -20, right: -20, bottom: -20 },
});
