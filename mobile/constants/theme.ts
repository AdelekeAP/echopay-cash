/**
 * Below are the colors that are used in the app. The colors are defined in the light and dark mode.
 * There are many other ways to style your app. For example, [Nativewind](https://www.nativewind.dev/), [Tamagui](https://tamagui.dev/), [unistyles](https://reactnativeunistyles.vercel.app), etc.
 */

import { Platform } from 'react-native';

// EchoPay Cash brand palette — minimalist white/orange/beige.
// One accent (orange) on warm beige paper. No gradients. No drop shadows.
export const Echopay = {
  // Surfaces
  pageBg: '#FBF7F0',        // warm beige page background
  cardBg: '#FFFFFF',         // elevated surface on the beige page
  cardSoft: '#F5EFE6',       // recessed surface (input wells, footers)

  // Brand
  accent: '#F97316',          // primary orange — CTAs, brand, focus
  accentSoft: '#FFEDD5',      // tinted background (hero, success-pending)
  accentPressed: '#C2410C',   // pressed state
  accentMuted: '#FBC192',     // disabled

  // Borders
  border: '#ECE5D7',          // 1px hairline on beige
  borderStrong: '#D9CFB8',    // for inputs in focus

  // Text
  text: '#1A1A1A',
  textMuted: '#6B6B6B',
  textSubtle: '#9A9A9A',

  // Semantic
  success: '#0E8C5A',
  successSoft: '#E2F4EC',
  danger: '#DC2626',
  dangerSoft: '#FEF2F2',
} as const;

const tintColorLight = '#0a7ea4';
const tintColorDark = '#fff';

export const Colors = {
  light: {
    text: '#11181C',
    background: '#fff',
    tint: tintColorLight,
    icon: '#687076',
    tabIconDefault: '#687076',
    tabIconSelected: tintColorLight,
  },
  dark: {
    text: '#ECEDEE',
    background: '#151718',
    tint: tintColorDark,
    icon: '#9BA1A6',
    tabIconDefault: '#9BA1A6',
    tabIconSelected: tintColorDark,
  },
};

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    serif: "Georgia, 'Times New Roman', serif",
    rounded: "'SF Pro Rounded', 'Hiragino Maru Gothic ProN', Meiryo, 'MS PGothic', sans-serif",
    mono: "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  },
});
