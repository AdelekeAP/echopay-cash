// ed25519 helpers for offline-payment bundles. Master doc §4.2.
//
// Sender signs the tx with their private key. Receiver signs
// { tx, sender_sig } with theirs. Server verifies all three sigs
// (server's own on the permit, plus both user sigs) at /sync/submit.
//
// Canonical JSON encoding: JSON.stringify with keys sorted, no
// whitespace. MUST match the Python `canonical_bytes` in
// backend/app/core/crypto.py.

import 'react-native-get-random-values';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';

// ----------------------------------------------------------- canonical encoding

/** Stable JSON: keys sorted at every level, no whitespace.
 *  Must produce IDENTICAL bytes to the backend's canonical_bytes(). */
export function canonical(payload: unknown): string {
  if (payload === null || typeof payload !== 'object') {
    return JSON.stringify(payload);
  }
  if (Array.isArray(payload)) {
    return '[' + payload.map(canonical).join(',') + ']';
  }
  const keys = Object.keys(payload as Record<string, unknown>).sort();
  const obj = payload as Record<string, unknown>;
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') +
    '}'
  );
}

// ----------------------------------------------------------- base64 helpers

export const b64 = {
  encode: (u8: Uint8Array): string => naclUtil.encodeBase64(u8),
  decode: (s: string): Uint8Array => naclUtil.decodeBase64(s),
};

// ----------------------------------------------------------- sign + verify

export function signCanonicalB64(payload: unknown, privKey: Uint8Array): string {
  const msg = new TextEncoder().encode(canonical(payload));
  return b64.encode(nacl.sign.detached(msg, privKey));
}

export function verifyCanonicalB64(
  payload: unknown,
  sigB64: string,
  pubKey: Uint8Array,
): boolean {
  try {
    const msg = new TextEncoder().encode(canonical(payload));
    const sig = b64.decode(sigB64);
    return nacl.sign.detached.verify(msg, sig, pubKey);
  } catch {
    return false;
  }
}

// ----------------------------------------------------------- keypair

export interface KeyPair {
  publicKeyB64: string;
  secretKeyB64: string;
}

export function generateKeypair(): KeyPair {
  const kp = nacl.sign.keyPair();
  return {
    publicKeyB64: b64.encode(kp.publicKey),
    secretKeyB64: b64.encode(kp.secretKey),
  };
}

export function keypairFromSecretB64(secretKeyB64: string): KeyPair {
  const kp = nacl.sign.keyPair.fromSecretKey(b64.decode(secretKeyB64));
  return {
    publicKeyB64: b64.encode(kp.publicKey),
    secretKeyB64,
  };
}

/** pynacl's SigningKey.encode() returns the 32-byte seed; tweetnacl
 *  needs the 64-byte secret-key form (seed || pubkey). Use this
 *  to bridge keys generated on the Python side. */
export function keypairFromSeedB64(seedB64: string): KeyPair {
  const kp = nacl.sign.keyPair.fromSeed(b64.decode(seedB64));
  return {
    publicKeyB64: b64.encode(kp.publicKey),
    secretKeyB64: b64.encode(kp.secretKey),
  };
}

/** Resolve a Persona's stored seed to the raw Uint8Array secret key
 *  tweetnacl wants. Memoized via the input string. */
const _secretKeyCache: Record<string, Uint8Array> = {};
export function secretKeyBytes(seedB64: string): Uint8Array {
  if (!_secretKeyCache[seedB64]) {
    const kp = nacl.sign.keyPair.fromSeed(b64.decode(seedB64));
    _secretKeyCache[seedB64] = kp.secretKey;
  }
  return _secretKeyCache[seedB64];
}

export function pubKeyBytes(pubB64: string): Uint8Array {
  return b64.decode(pubB64);
}

// ----------------------------------------------------------- payload builders
//
// These shape the exact dicts the backend expects. The keys MUST match
// (case + spelling) so canonical() produces the same bytes the server
// canonicalizes from its Pydantic models.

export interface TxBundle {
  amount_kobo: number;
  from_user: number;
  nonce: string;
  permit_id: string;
  to_user: number;
  ts: number;
}

export interface PermitBundle {
  device_fingerprint: string | null;
  expires_at: number;
  issued_at: number;
  max_amount_kobo: number;
  permit_id: string;
  server_sig_b64: string;        // included in the bundle for transport,
                                  // but NOT signed over — strip when
                                  // verifying the server's signature.
  user_id: number;
}

export function permitCanonical(p: PermitBundle): {
  device_fingerprint: string | null;
  expires_at: number;
  issued_at: number;
  max_amount_kobo: number;
  permit_id: string;
  user_id: number;
} {
  // The server signed over everything EXCEPT server_sig_b64.
  const { server_sig_b64: _unused, ...rest } = p;
  return rest;
}

export function buildTx(opts: {
  permitId: string;
  fromUser: number;
  toUser: number;
  amountKobo: number;
}): TxBundle {
  return {
    amount_kobo: opts.amountKobo,
    from_user: opts.fromUser,
    nonce: randomNonce(),
    permit_id: opts.permitId,
    to_user: opts.toUser,
    ts: Math.floor(Date.now() / 1000),
  };
}

export function receiptCanonical(t: TxBundle, senderSigB64: string) {
  return {
    sender_sig: senderSigB64,
    tx: t,
  };
}

// ----------------------------------------------------------- nonces

export function randomNonce(): string {
  // 12 bytes → 16 base64url chars → fits the 64-char db column easily.
  const bytes = new Uint8Array(12);
  // react-native-get-random-values polyfills crypto.getRandomValues
  // for tweetnacl; we can re-use it here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).crypto.getRandomValues(bytes);
  return b64
    .encode(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ----------------------------------------------------------- QR payload

/** Encode the full offline-payment bundle for QR transmission.
 *  Receiver scans → decodes → verifies → countersigns. */
export interface OfflineBundle {
  permit: PermitBundle;
  tx: TxBundle;
  sender_sig_b64: string;
  receiver_sig_b64?: string;     // set after countersign
}

export function encodeBundle(b: OfflineBundle): string {
  // Plain JSON. QR libraries handle the encoding/decoding of the
  // string itself; we just need a deterministic round-trip-safe form.
  return JSON.stringify(b);
}

export function decodeBundle(payload: string): OfflineBundle | null {
  try {
    const obj = JSON.parse(payload);
    if (!obj || typeof obj !== 'object') return null;
    if (!obj.permit || !obj.tx || !obj.sender_sig_b64) return null;
    return obj as OfflineBundle;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------- receive QR
//
// Before the sender can build a signed tx, they need to know the
// receiver's user_id and ed25519 pubkey. The receiver shows this
// `ReceiveBundle` as a QR; the sender scans it. Short keys keep the
// QR small and quick to scan on low-end phones.

export interface ReceiveBundle {
  u: number;   // user_id
  n: string;   // display_name
  k: string;   // ed25519 pubkey (base64)
}

export function encodeReceive(rb: ReceiveBundle): string {
  return JSON.stringify(rb);
}

export function decodeReceive(payload: string): ReceiveBundle | null {
  try {
    const obj = JSON.parse(payload);
    if (!obj || typeof obj !== 'object') return null;
    if (
      typeof obj.u !== 'number' ||
      typeof obj.n !== 'string' ||
      typeof obj.k !== 'string'
    )
      return null;
    return obj as ReceiveBundle;
  } catch {
    return null;
  }
}
