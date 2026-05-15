// @ts-nocheck — legacy file inherited from EchoPay v1; pre-strict TS. Do not modify (see CLAUDE.md).
import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  Canvas,
  Circle,
  RadialGradient,
  vec,
  BlurMask,
  Ring,
  Group,
} from '@shopify/react-native-skia';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  withSequence,
  withSpring,
  withDelay,
  Easing,
  useDerivedValue,
} from 'react-native-reanimated';

type OrbStatus = 'idle' | 'listening' | 'processing' | 'responding' | 'success' | 'error';

interface EchoOrbProps {
  status: OrbStatus;
  size?: number;
}

// Premium banking color palette - sophisticated and trustworthy
const STATUS_COLORS = {
  idle: {
    core: '#1A1A2E',
    ring: '#C9A962',
    accent: 'rgba(201, 169, 98, 0.15)',
    glow: 'rgba(201, 169, 98, 0.08)',
  },
  listening: {
    core: '#1A1A2E',
    ring: '#D4AF37',
    accent: 'rgba(212, 175, 55, 0.25)',
    glow: 'rgba(212, 175, 55, 0.12)',
  },
  processing: {
    core: '#1A1A2E',
    ring: '#C9A962',
    accent: 'rgba(201, 169, 98, 0.2)',
    glow: 'rgba(201, 169, 98, 0.1)',
  },
  responding: {
    core: '#1A1A2E',
    ring: '#4ECDC4',
    accent: 'rgba(78, 205, 196, 0.2)',
    glow: 'rgba(78, 205, 196, 0.1)',
  },
  success: {
    core: '#1A1A2E',
    ring: '#4ECDC4',
    accent: 'rgba(78, 205, 196, 0.25)',
    glow: 'rgba(78, 205, 196, 0.12)',
  },
  error: {
    core: '#1A1A2E',
    ring: '#E85A5A',
    accent: 'rgba(232, 90, 90, 0.2)',
    glow: 'rgba(232, 90, 90, 0.1)',
  },
};

export default function EchoOrb({ status, size = 240 }: EchoOrbProps) {
  const center = size / 2;
  const coreRadius = size * 0.28;
  const ringRadius = size * 0.35;

  // Animation values
  const scale = useSharedValue(1);
  const ringOpacity = useSharedValue(0.8);
  const outerRingScale = useSharedValue(1);
  const outerRingOpacity = useSharedValue(0);
  const pulseRing1 = useSharedValue(1);
  const pulseRing1Opacity = useSharedValue(0);
  const pulseRing2 = useSharedValue(1);
  const pulseRing2Opacity = useSharedValue(0);
  const innerGlow = useSharedValue(0.3);

  const colors = STATUS_COLORS[status];

  useEffect(() => {
    // Reset all values
    scale.value = 1;
    ringOpacity.value = 0.8;
    outerRingScale.value = 1;
    outerRingOpacity.value = 0;
    pulseRing1.value = 1;
    pulseRing1Opacity.value = 0;
    pulseRing2.value = 1;
    pulseRing2Opacity.value = 0;
    innerGlow.value = 0.3;

    switch (status) {
      case 'idle':
        // Very subtle breathing - professional and calm
        scale.value = withRepeat(
          withSequence(
            withTiming(1.01, { duration: 4000, easing: Easing.inOut(Easing.ease) }),
            withTiming(0.99, { duration: 4000, easing: Easing.inOut(Easing.ease) })
          ),
          -1,
          true
        );
        innerGlow.value = withRepeat(
          withSequence(
            withTiming(0.35, { duration: 4000 }),
            withTiming(0.25, { duration: 4000 })
          ),
          -1,
          true
        );
        break;

      case 'listening':
        // Elegant expanding rings - like sonar
        scale.value = withRepeat(
          withSequence(
            withTiming(1.02, { duration: 800, easing: Easing.out(Easing.ease) }),
            withTiming(0.98, { duration: 800, easing: Easing.in(Easing.ease) })
          ),
          -1,
          true
        );

        // First pulse ring
        pulseRing1Opacity.value = 0.4;
        pulseRing1.value = withRepeat(
          withSequence(
            withTiming(1, { duration: 0 }),
            withTiming(1.8, { duration: 2000, easing: Easing.out(Easing.quad) })
          ),
          -1,
          false
        );
        pulseRing1Opacity.value = withRepeat(
          withSequence(
            withTiming(0.4, { duration: 0 }),
            withTiming(0, { duration: 2000, easing: Easing.out(Easing.quad) })
          ),
          -1,
          false
        );

        // Second pulse ring (delayed)
        pulseRing2.value = withDelay(
          1000,
          withRepeat(
            withSequence(
              withTiming(1, { duration: 0 }),
              withTiming(1.8, { duration: 2000, easing: Easing.out(Easing.quad) })
            ),
            -1,
            false
          )
        );
        pulseRing2Opacity.value = withDelay(
          1000,
          withRepeat(
            withSequence(
              withTiming(0.4, { duration: 0 }),
              withTiming(0, { duration: 2000, easing: Easing.out(Easing.quad) })
            ),
            -1,
            false
          )
        );

        innerGlow.value = withRepeat(
          withSequence(
            withTiming(0.5, { duration: 600 }),
            withTiming(0.3, { duration: 600 })
          ),
          -1,
          true
        );
        break;

      case 'processing':
        // Smooth rotation feel through pulsing
        scale.value = withRepeat(
          withSequence(
            withTiming(1.015, { duration: 500 }),
            withTiming(0.985, { duration: 500 })
          ),
          -1,
          true
        );
        ringOpacity.value = withRepeat(
          withSequence(
            withTiming(1, { duration: 400 }),
            withTiming(0.6, { duration: 400 })
          ),
          -1,
          true
        );
        break;

      case 'responding':
        // Gentle rhythmic pulse - speaking
        scale.value = withRepeat(
          withSequence(
            withTiming(1.015, { duration: 700, easing: Easing.inOut(Easing.ease) }),
            withTiming(0.985, { duration: 700, easing: Easing.inOut(Easing.ease) })
          ),
          -1,
          true
        );
        innerGlow.value = withRepeat(
          withSequence(
            withTiming(0.45, { duration: 700 }),
            withTiming(0.3, { duration: 700 })
          ),
          -1,
          true
        );
        break;

      case 'success':
        // Elegant confirmation
        scale.value = withSequence(
          withSpring(1.08, { damping: 15, stiffness: 150 }),
          withTiming(1.0, { duration: 800, easing: Easing.out(Easing.ease) })
        );
        innerGlow.value = withSequence(
          withTiming(0.6, { duration: 300 }),
          withTiming(0.3, { duration: 1000 })
        );
        outerRingScale.value = withSequence(
          withTiming(1.5, { duration: 400 }),
          withTiming(1.3, { duration: 600 })
        );
        outerRingOpacity.value = withSequence(
          withTiming(0.5, { duration: 200 }),
          withTiming(0, { duration: 800 })
        );
        break;

      case 'error':
        // Subtle but clear error indication
        scale.value = withSequence(
          withTiming(0.96, { duration: 80 }),
          withTiming(1.04, { duration: 80 }),
          withTiming(0.98, { duration: 80 }),
          withTiming(1.02, { duration: 80 }),
          withTiming(1.0, { duration: 120 })
        );
        innerGlow.value = withSequence(
          withTiming(0.6, { duration: 200 }),
          withTiming(0.3, { duration: 500 })
        );
        break;
    }
  }, [status]);

  // Animated container
  const animatedContainerStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  // Derived values for Skia
  const animatedInnerGlow = useDerivedValue(() => innerGlow.value);
  const animatedRingOpacity = useDerivedValue(() => ringOpacity.value);
  const animatedPulse1Scale = useDerivedValue(() => pulseRing1.value);
  const animatedPulse1Opacity = useDerivedValue(() => pulseRing1Opacity.value);
  const animatedPulse2Scale = useDerivedValue(() => pulseRing2.value);
  const animatedPulse2Opacity = useDerivedValue(() => pulseRing2Opacity.value);
  const animatedOuterScale = useDerivedValue(() => outerRingScale.value);
  const animatedOuterOpacity = useDerivedValue(() => outerRingOpacity.value);

  const pulse1Radius = useDerivedValue(() => ringRadius * animatedPulse1Scale.value);
  const pulse2Radius = useDerivedValue(() => ringRadius * animatedPulse2Scale.value);
  const outerRadius = useDerivedValue(() => ringRadius * animatedOuterScale.value);

  return (
    <View style={[styles.container, { width: size, height: size }]} pointerEvents="none">
      <Animated.View style={[styles.canvasContainer, animatedContainerStyle]}>
        <Canvas style={{ width: size, height: size }} pointerEvents="none">
          {/* Ambient glow - very subtle */}
          <Circle cx={center} cy={center} r={ringRadius * 1.6} opacity={0.08}>
            <RadialGradient
              c={vec(center, center)}
              r={ringRadius * 1.8}
              colors={[colors.accent, 'transparent']}
            />
          </Circle>

          {/* Pulse rings (listening state) */}
          {status === 'listening' && (
            <>
              <Circle
                cx={center}
                cy={center}
                r={pulse1Radius}
                style="stroke"
                strokeWidth={1.5}
                color={colors.ring}
                opacity={animatedPulse1Opacity}
              />
              <Circle
                cx={center}
                cy={center}
                r={pulse2Radius}
                style="stroke"
                strokeWidth={1.5}
                color={colors.ring}
                opacity={animatedPulse2Opacity}
              />
            </>
          )}

          {/* Success outer ring */}
          {status === 'success' && (
            <Circle
              cx={center}
              cy={center}
              r={outerRadius}
              style="stroke"
              strokeWidth={2}
              color={colors.ring}
              opacity={animatedOuterOpacity}
            />
          )}

          {/* Main ring - thin, elegant */}
          <Circle
            cx={center}
            cy={center}
            r={ringRadius}
            style="stroke"
            strokeWidth={1.5}
            color={colors.ring}
            opacity={animatedRingOpacity}
          />

          {/* Inner ring - secondary */}
          <Circle
            cx={center}
            cy={center}
            r={ringRadius * 0.85}
            style="stroke"
            strokeWidth={0.5}
            color={colors.ring}
            opacity={0.3}
          />

          {/* Core background */}
          <Circle cx={center} cy={center} r={coreRadius}>
            <RadialGradient
              c={vec(center, center)}
              r={coreRadius}
              colors={['#252540', colors.core, '#0D0D1A']}
            />
          </Circle>

          {/* Core inner glow */}
          <Circle cx={center} cy={center} r={coreRadius * 0.85} opacity={animatedInnerGlow}>
            <RadialGradient
              c={vec(center, center)}
              r={coreRadius}
              colors={[colors.accent, 'transparent']}
            />
            <BlurMask blur={10} style="normal" />
          </Circle>

          {/* Core edge highlight */}
          <Circle
            cx={center}
            cy={center}
            r={coreRadius - 1}
            style="stroke"
            strokeWidth={1}
            opacity={0.2}
          >
            <RadialGradient
              c={vec(center - coreRadius * 0.5, center - coreRadius * 0.5)}
              r={coreRadius * 2}
              colors={['rgba(255,255,255,0.3)', 'transparent']}
            />
          </Circle>

          {/* Subtle top highlight */}
          <Circle
            cx={center - coreRadius * 0.2}
            cy={center - coreRadius * 0.25}
            r={coreRadius * 0.3}
            opacity={0.06}
          >
            <RadialGradient
              c={vec(center - coreRadius * 0.2, center - coreRadius * 0.25)}
              r={coreRadius * 0.4}
              colors={['rgba(255,255,255,0.5)', 'transparent']}
            />
          </Circle>

          {/* Center dot - like a power indicator */}
          <Circle
            cx={center}
            cy={center}
            r={3}
            color={colors.ring}
            opacity={0.8}
          >
            <BlurMask blur={2} style="solid" />
          </Circle>
        </Canvas>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  canvasContainer: {
    width: '100%',
    height: '100%',
  },
});