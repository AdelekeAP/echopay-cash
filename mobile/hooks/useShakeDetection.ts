import { useEffect, useRef, useCallback } from 'react';
import { Accelerometer, AccelerometerMeasurement } from 'expo-sensors';
import * as Haptics from 'expo-haptics';

const SHAKE_THRESHOLD = 1.5; // Acceleration threshold to detect shake
const SHAKE_TIMEOUT = 500; // Minimum time between shake detections (ms)

interface UseShakeDetectionProps {
  onShake: () => void;
  enabled?: boolean;
  sensitivity?: 'low' | 'medium' | 'high';
}

export function useShakeDetection({
  onShake,
  enabled = true,
  sensitivity = 'medium',
}: UseShakeDetectionProps) {
  const lastShakeTime = useRef(0);
  const lastAcceleration = useRef({ x: 0, y: 0, z: 0 });

  // Adjust threshold based on sensitivity
  const getThreshold = useCallback(() => {
    switch (sensitivity) {
      case 'low':
        return 2.0;
      case 'high':
        return 1.2;
      case 'medium':
      default:
        return 1.5;
    }
  }, [sensitivity]);

  useEffect(() => {
    if (!enabled) return;

    let subscription: { remove: () => void } | null = null;

    const setupAccelerometer = async () => {
      const isAvailable = await Accelerometer.isAvailableAsync();
      if (!isAvailable) {
        console.log('Accelerometer not available on this device');
        return;
      }

      // Set update interval (100ms = 10 updates per second)
      Accelerometer.setUpdateInterval(100);

      subscription = Accelerometer.addListener((data: AccelerometerMeasurement) => {
        const { x, y, z } = data;
        const threshold = getThreshold();

        // Calculate the change in acceleration
        const deltaX = Math.abs(x - lastAcceleration.current.x);
        const deltaY = Math.abs(y - lastAcceleration.current.y);
        const deltaZ = Math.abs(z - lastAcceleration.current.z);

        // Update last acceleration
        lastAcceleration.current = { x, y, z };

        // Calculate total acceleration change
        const acceleration = Math.sqrt(deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ);

        // Check if shake detected
        if (acceleration > threshold) {
          const now = Date.now();
          if (now - lastShakeTime.current > SHAKE_TIMEOUT) {
            lastShakeTime.current = now;

            // Trigger haptic feedback
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);

            // Call the shake handler
            onShake();
          }
        }
      });
    };

    setupAccelerometer();

    return () => {
      if (subscription) {
        subscription.remove();
      }
    };
  }, [enabled, onShake, getThreshold]);
}

export default useShakeDetection;
