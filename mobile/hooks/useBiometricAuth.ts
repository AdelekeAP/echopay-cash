import { useState, useCallback, useEffect } from 'react';
import * as LocalAuthentication from 'expo-local-authentication';
import * as Haptics from 'expo-haptics';

export interface BiometricAuthState {
  isAvailable: boolean;
  biometricType: 'fingerprint' | 'facial' | 'iris' | 'none';
  isEnrolled: boolean;
  isAuthenticated: boolean;
  error: string | null;
}

export interface UseBiometricAuthReturn {
  state: BiometricAuthState;
  authenticate: (reason?: string) => Promise<boolean>;
  checkAvailability: () => Promise<void>;
}

export function useBiometricAuth(): UseBiometricAuthReturn {
  const [state, setState] = useState<BiometricAuthState>({
    isAvailable: false,
    biometricType: 'none',
    isEnrolled: false,
    isAuthenticated: false,
    error: null,
  });

  // Check biometric availability on mount
  const checkAvailability = useCallback(async () => {
    try {
      // Check if hardware supports biometrics
      const hasHardware = await LocalAuthentication.hasHardwareAsync();

      if (!hasHardware) {
        setState(prev => ({
          ...prev,
          isAvailable: false,
          biometricType: 'none',
          error: 'Biometric hardware not available',
        }));
        return;
      }

      // Check if biometrics are enrolled
      const isEnrolled = await LocalAuthentication.isEnrolledAsync();

      // Get supported biometric types
      const supportedTypes = await LocalAuthentication.supportedAuthenticationTypesAsync();

      let biometricType: BiometricAuthState['biometricType'] = 'none';
      if (supportedTypes.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) {
        biometricType = 'facial';
      } else if (supportedTypes.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) {
        biometricType = 'fingerprint';
      } else if (supportedTypes.includes(LocalAuthentication.AuthenticationType.IRIS)) {
        biometricType = 'iris';
      }

      setState(prev => ({
        ...prev,
        isAvailable: hasHardware && isEnrolled,
        biometricType,
        isEnrolled,
        error: null,
      }));
    } catch (error: any) {
      setState(prev => ({
        ...prev,
        isAvailable: false,
        error: error.message || 'Failed to check biometric availability',
      }));
    }
  }, []);

  // Authenticate using biometrics
  const authenticate = useCallback(async (reason?: string): Promise<boolean> => {
    try {
      setState(prev => ({ ...prev, error: null }));

      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: reason || 'Authenticate to continue',
        fallbackLabel: 'Use PIN instead',
        cancelLabel: 'Cancel',
        disableDeviceFallback: false,
      });

      if (result.success) {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setState(prev => ({
          ...prev,
          isAuthenticated: true,
          error: null,
        }));
        return true;
      } else {
        const errorMessage = result.error === 'user_cancel'
          ? 'Authentication cancelled'
          : result.error === 'user_fallback'
          ? 'User chose fallback'
          : result.error === 'system_cancel'
          ? 'Authentication cancelled by system'
          : result.error === 'lockout'
          ? 'Too many failed attempts. Please try again later.'
          : 'Authentication failed';

        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setState(prev => ({
          ...prev,
          isAuthenticated: false,
          error: errorMessage,
        }));
        return false;
      }
    } catch (error: any) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setState(prev => ({
        ...prev,
        isAuthenticated: false,
        error: error.message || 'Authentication failed',
      }));
      return false;
    }
  }, []);

  // Check availability on mount
  useEffect(() => {
    checkAvailability();
  }, [checkAvailability]);

  return {
    state,
    authenticate,
    checkAvailability,
  };
}

export default useBiometricAuth;
