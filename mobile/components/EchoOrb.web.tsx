// EchoOrb — web shim.
//
// The native EchoOrb (EchoOrb.tsx) uses @shopify/react-native-skia for
// the animated voice-recording orb. Skia on web requires the CanvasKit
// WASM module, which we don't ship in the Vercel build. Without it,
// Skia constructors throw "Cannot read properties of undefined
// (reading 'PictureRecorder')" on every animation frame — the JS
// thread fills the console with the same error thousands of times.
//
// Metro picks platform-specific extensions automatically: this file
// wins on web, the native EchoOrb.tsx wins on iOS/Android. Voice
// signup is already hard-blocked on web via Platform.OS check, so
// this component is never actually rendered — we just need to make
// sure the *import* doesn't pull Skia into the web bundle.

import { View, StyleSheet } from 'react-native';

interface EchoOrbProps {
  status?: 'listening' | 'idle';
  size?: number;
}

export default function EchoOrb({ size = 220 }: EchoOrbProps) {
  // Render a simple flat circle in case any code path on web ever hits
  // this component. The voice-signup screen short-circuits to a web
  // fallback before reaching the recording stage, so this never runs.
  return (
    <View
      style={[
        styles.orb,
        { width: size, height: size, borderRadius: size / 2 },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  orb: {
    backgroundColor: '#FFEDD5',
    borderWidth: 2,
    borderColor: '#F97316',
  },
});
