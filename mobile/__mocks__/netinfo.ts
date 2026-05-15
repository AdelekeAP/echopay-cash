// NetInfo stub for unit tests. Real network detection is integration-
// tested via the offline mock fallback in transfer.test.ts.

let online = true;

export function setMockNetInfo(isOnline: boolean): void {
  online = isOnline;
}

export function useNetInfo() {
  return {
    isConnected: online,
    isInternetReachable: online,
    type: 'wifi',
  };
}

export default {
  fetch: async () => ({ isConnected: online, isInternetReachable: online, type: 'wifi' }),
  addEventListener: () => () => {},
};
