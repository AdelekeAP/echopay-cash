# echopay-cash mobile

React Native (Expo SDK 54, expo-router) client for the GTCO Squad Hackathon
3.0 voice + QR wallet.

## Prerequisites

- Node **20.19.4+** (RN 0.81.5 requirement — older Node will warn but mostly works)
- npm 9+
- Expo Go on your phone (iOS or Android)
- The dev machine and phone on the **same Wi-Fi network**

## Install

```bash
cd mobile
npm install
```

## Configure

The base URL of the echopay-cash backend (`:8100`) is set via an Expo
public env var. Without it, `constants/config.ts` throws on first
import — that's intentional, silent fallback would mask the error on
every screen.

```bash
cp .env.example .env
```

Then edit `.env` and set `EXPO_PUBLIC_API_BASE_URL` to your dev machine's
LAN IP:

- macOS: `ipconfig getifaddr en0`
- Linux: `hostname -I | awk '{print $1}'`
- Windows: `ipconfig` → look for "IPv4 Address"

Example:

```
EXPO_PUBLIC_API_BASE_URL=http://192.168.1.42:8100
```

> `localhost` works on the iOS simulator but **not** on a physical phone —
> Expo Go reaches your machine over Wi-Fi, not over USB.

## Run

```bash
npx expo start
```

Scan the QR code in Expo Go.

## Check

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # expo lint
```

No test framework is wired yet — `utils/format.ts` has inline `__DEV__`
assertions that fire on import. Jest setup is a Phase 1+ task.

## Architecture

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the layer split
(app → hooks → services → types/utils), the storage policy (secure-store
vs AsyncStorage vs SQLite), and the offline-tolerant boot path.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| App boots then network errors on every screen | `EXPO_PUBLIC_API_BASE_URL` wrong — your phone can't reach `192.168.x.x` because you switched Wi-Fi networks. Re-run `ipconfig getifaddr en0`, update `.env`, restart Metro. |
| Camera screen crashes / "Camera permission denied" | iOS: Settings → Expo Go → Camera = On. Android: clear app permissions and re-grant on launch. |
| Stale bundle, edits not showing up | `npx expo start -c` (clear Metro cache) and reload the app from Expo Go (shake phone → Reload). |
