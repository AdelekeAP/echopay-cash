// @ts-nocheck — legacy file inherited from EchoPay v1; pre-strict TS. Do not modify (see CLAUDE.md).
import React, { useRef, useEffect } from 'react';
import {
  View,
  StyleSheet,
  TouchableOpacity,
  Dimensions,
  PanResponder,
  Animated,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const BUTTON_SIZE = 60;
const MARGIN = 20;

interface FloatingMicButtonProps {
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
  // Position state
  const pan = useRef(new Animated.ValueXY({
    x: SCREEN_WIDTH - BUTTON_SIZE - MARGIN,
    y: SCREEN_HEIGHT - BUTTON_SIZE - 180, // Above tab bar
  })).current;

  // Animation values
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const glowAnim = useRef(new Animated.Value(0)).current;
  const rotateAnim = useRef(new Animated.Value(0)).current;

  // Pulse animation for idle state
  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.08,
          duration: 1500,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 1500,
          useNativeDriver: true,
        }),
      ])
    );

    if (!isListening && !isProcessing) {
      pulse.start();
    } else {
      pulse.stop();
      pulseAnim.setValue(1);
    }

    return () => pulse.stop();
  }, [isListening, isProcessing]);

  // Glow animation for listening state
  useEffect(() => {
    if (isListening) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(glowAnim, {
            toValue: 1,
            duration: 600,
            useNativeDriver: true,
          }),
          Animated.timing(glowAnim, {
            toValue: 0.3,
            duration: 600,
            useNativeDriver: true,
          }),
        ])
      ).start();
    } else {
      glowAnim.setValue(0);
    }
  }, [isListening]);

  // Rotation animation for processing state
  useEffect(() => {
    if (isProcessing) {
      Animated.loop(
        Animated.timing(rotateAnim, {
          toValue: 1,
          duration: 1000,
          useNativeDriver: true,
        })
      ).start();
    } else {
      rotateAnim.setValue(0);
    }
  }, [isProcessing]);

  // Pan responder for dragging
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gestureState) => {
        // Only become responder if dragging significantly
        return Math.abs(gestureState.dx) > 5 || Math.abs(gestureState.dy) > 5;
      },
      onPanResponderGrant: () => {
        pan.setOffset({
          x: (pan.x as any)._value,
          y: (pan.y as any)._value,
        });
        pan.setValue({ x: 0, y: 0 });
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      },
      onPanResponderMove: Animated.event(
        [null, { dx: pan.x, dy: pan.y }],
        { useNativeDriver: false }
      ),
      onPanResponderRelease: (_, gestureState) => {
        pan.flattenOffset();

        // Calculate final position with edge snapping
        const currentX = (pan.x as any)._value;
        const currentY = (pan.y as any)._value;

        // Determine which edge to snap to
        const snapToRight = currentX > SCREEN_WIDTH / 2;
        const targetX = snapToRight
          ? SCREEN_WIDTH - BUTTON_SIZE - MARGIN
          : MARGIN;

        // Clamp Y position
        const minY = 100;
        const maxY = SCREEN_HEIGHT - BUTTON_SIZE - 180;
        const targetY = Math.max(minY, Math.min(maxY, currentY));

        Animated.spring(pan, {
          toValue: { x: targetX, y: targetY },
          friction: 7,
          tension: 40,
          useNativeDriver: false,
        }).start();

        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      },
    })
  ).current;

  // Handle button press
  const handlePress = async () => {
    if (disabled) return;
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onPress();
  };

  // Interpolated values for animations
  const glowOpacity = glowAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 0.6],
  });

  const rotation = rotateAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

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
      {/* Glow effect when listening */}
      {isListening && (
        <>
          <Animated.View
            style={[
              styles.glowRing,
              styles.glowRing1,
              { opacity: glowOpacity },
            ]}
          />
          <Animated.View
            style={[
              styles.glowRing,
              styles.glowRing2,
              { opacity: Animated.multiply(glowOpacity, 0.5) },
            ]}
          />
        </>
      )}

      {/* Main button */}
      <TouchableOpacity
        onPress={handlePress}
        disabled={disabled}
        activeOpacity={0.8}
        style={styles.buttonWrapper}
      >
        <LinearGradient
          colors={
            isListening
              ? ['#E31937', '#FF4D4D']
              : isProcessing
              ? ['#666', '#999']
              : ['#00B050', '#008040']
          }
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.button}
        >
          {isProcessing ? (
            <Animated.View style={{ transform: [{ rotate: rotation }] }}>
              <Ionicons name="sync" size={28} color="#fff" />
            </Animated.View>
          ) : (
            <Ionicons
              name={isListening ? 'mic' : 'mic-outline'}
              size={28}
              color="#fff"
            />
          )}
        </LinearGradient>
      </TouchableOpacity>

      {/* Shadow */}
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
    backgroundColor: 'rgba(0, 176, 80, 0.3)',
    zIndex: -1,
  },
  glowRing: {
    position: 'absolute',
    borderRadius: 100,
    backgroundColor: '#E31937',
  },
  glowRing1: {
    top: -10,
    left: -10,
    right: -10,
    bottom: -10,
  },
  glowRing2: {
    top: -20,
    left: -20,
    right: -20,
    bottom: -20,
  },
});