// @ts-nocheck — legacy file inherited from EchoPay v1; pre-strict TS. Do not modify (see CLAUDE.md).
import React, { useEffect, useRef } from 'react';
import { View, StyleSheet, Animated } from 'react-native';

interface WaveformProps {
  isActive: boolean;
  metering: number; // Audio level from -160 to 0
  color?: string;
  barCount?: number;
}

export default function Waveform({
  isActive,
  metering,
  color = '#E31937',
  barCount = 5,
}: WaveformProps) {
  // Create animated values for each bar
  const barAnimations = useRef(
    Array.from({ length: barCount }, () => new Animated.Value(0.3))
  ).current;

  // Animate bars based on metering level
  useEffect(() => {
    if (isActive) {
      // Normalize metering from -160..0 to 0..1
      const normalizedLevel = Math.max(0, Math.min(1, (metering + 60) / 60));

      // Animate each bar with slight variation
      barAnimations.forEach((anim, index) => {
        // Stop any running animation before starting new one
        anim.stopAnimation();

        // Create variation based on bar position
        const variation = Math.sin(Date.now() / 200 + index) * 0.2;
        const targetHeight = Math.max(0.2, Math.min(1, normalizedLevel + variation));

        Animated.spring(anim, {
          toValue: targetHeight,
          friction: 3,
          tension: 40,
          useNativeDriver: true,
        }).start();
      });
    } else {
      // Reset all bars to minimum
      barAnimations.forEach((anim) => {
        anim.stopAnimation();
        Animated.timing(anim, {
          toValue: 0.3,
          duration: 300,
          useNativeDriver: true,
        }).start();
      });
    }
  }, [isActive, metering]);

  // Idle animation when not active
  useEffect(() => {
    if (!isActive) {
      const interval = setInterval(() => {
        barAnimations.forEach((anim, index) => {
          const randomHeight = 0.2 + Math.random() * 0.15;
          Animated.timing(anim, {
            toValue: randomHeight,
            duration: 500,
            useNativeDriver: true,
          }).start();
        });
      }, 600);

      return () => clearInterval(interval);
    }
  }, [isActive]);

  return (
    <View style={styles.container}>
      {barAnimations.map((anim, index) => (
        <Animated.View
          key={index}
          style={[
            styles.bar,
            {
              backgroundColor: color,
              transform: [
                {
                  scaleY: anim,
                },
              ],
            },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 40,
    gap: 4,
  },
  bar: {
    width: 6,
    height: 40,
    borderRadius: 3,
  },
});