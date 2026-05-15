// Minimal react-native stub used by services/hooks under test.
// Any module importing from 'react-native' inside our test target gets
// this skeleton instead of the real native bridge.

export const Platform = {
  OS: 'web' as 'ios' | 'android' | 'web',
  select: <T>(specifics: { default?: T; web?: T; ios?: T; android?: T }) =>
    specifics.web ?? specifics.default,
};

export const AppState = {
  currentState: 'active',
  addEventListener: () => ({ remove: () => {} }),
};
