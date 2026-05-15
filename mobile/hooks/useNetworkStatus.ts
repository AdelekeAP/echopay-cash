import { useNetInfo } from '@react-native-community/netinfo';

/**
 * Reactive network status. Wraps `@react-native-community/netinfo`.
 *
 * Returns:
 *   - `isOnline`        — `true` when the device reports a connected interface.
 *                         Initialises to `true` to avoid flashing an "offline"
 *                         badge during the first render before NetInfo resolves.
 *   - `isInternetReachable` — `true` / `false` once the underlying reachability
 *                         probe completes. `null` while pending, AND on web —
 *                         NetInfo's web shim does not implement reachability,
 *                         it only exposes `navigator.onLine`-style connection
 *                         state. Callers must handle the `null` case.
 *
 * Drives the OfflineBadge on home and the outbox-drain trigger per
 * EchoPay_Cash_PRD.md §15.4.
 */
export function useNetworkStatus(): {
  isOnline: boolean;
  isInternetReachable: boolean | null;
} {
  const net = useNetInfo();
  return {
    isOnline: net.isConnected !== false,
    isInternetReachable:
      net.isInternetReachable === undefined ? null : net.isInternetReachable,
  };
}
