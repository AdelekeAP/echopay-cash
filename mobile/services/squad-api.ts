// Typed wrappers around the echopay-cash backend (:8100) endpoints that
// proxy Squad. The backend orchestrates Squad sandbox + Whisper (voice
// signup) + atomic DB writes; the mobile client just calls these typed
// surfaces and handles the resulting envelope shape.
//
// Response envelope from the backend (PRD §6 / matches Funbi's
// /transfer/in-network):
//   success: { success: true, data: { ... } }
//   error:   { detail: { code: string, message: string, ... } }
//
// This file is the SINGLE entry point for Squad-proxy endpoints on the
// mobile side. Direct axios/fetch calls to the backend's Squad routes
// from anywhere else in the app are a code-review red flag.

import axios, { AxiosError } from 'axios';

import { API_BASE_URL } from '../constants/config';
import { Account, User } from '../types';

// ----------------------------------------------------------------- response shapes

export interface VoiceSignupResponse {
  user: User;
  account: Account;

  // DEMO TOKEN FORMAT — placeholder until §3.12 auth-gate PR adds real JWT.
  // Mobile AuthContext treats this as opaque; any non-empty string is accepted.
  // Format: demo_token_<user_id>_<unix_timestamp>
  // DO NOT use this as a real auth token for any sensitive endpoint.
  token: string;

  matched_persona_id: string; // 'mama_risikat' | 'iya_tope' | 'kosi'
  transcript: string;
  demo_mode: boolean;
}

// Backend error envelope (FastAPI HTTPException(detail={code, message, ...})).
export interface BackendErrorDetail {
  code: string;
  message: string;
  // Endpoint-specific extras (e.g. `transcript` on persona_unmatched,
  // `cause` on voice_unavailable / squad_failed).
  [extra: string]: unknown;
}

export class BackendError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly detail: BackendErrorDetail | null,
  ) {
    super(message);
    this.name = 'BackendError';
  }
}

// ----------------------------------------------------------------- voice signup

export async function signupWithVoice(
  audioUri: string,
  phone?: string,
): Promise<VoiceSignupResponse> {
  // expo-av writes the recording to a file:// URI on iOS/Android. We
  // wrap it in FormData; axios/RN converts the URI reference into the
  // multipart frame on the network side.
  const form = new FormData();
  form.append('audio', {
    uri: audioUri,
    name: 'recording.m4a',
    type: 'audio/m4a',
    // The `as any` is unavoidable — React Native's FormData accepts a
    // {uri, name, type} blob shape that DOM FormData typings don't.
  } as any);
  if (phone) {
    form.append('phone', phone);
  }

  try {
    const res = await axios.post<{ success: true; data: VoiceSignupResponse }>(
      `${API_BASE_URL}/auth/voice-signup`,
      form,
      {
        headers: { 'Content-Type': 'multipart/form-data' },
        // Whisper round-trip can take 3-6s on a busy day; allow generous
        // upper bound. Mobile UI shows a spinner during this window.
        timeout: 20_000,
      },
    );
    return res.data.data;
  } catch (err) {
    throw _toBackendError(err);
  }
}

// ----------------------------------------------------------------- stubs (future PRs)

/**
 * External transfer via Squad's payout API. POST /transfer/voice-initiate.
 * Wires up in a later PR — Squad client + voice intent extraction land
 * together for the §3.6 transfer-external work.
 */
export async function transferExternal(_params: {
  from_user_id: number;
  bank_code: string;
  account_number: string;
  amount_kobo: number;
  remark: string;
  idempotency_key: string;
}): Promise<never> {
  throw new Error('transferExternal: not implemented yet (PRD §3.6 follow-up PR)');
}

// ----------------------------------------------------------------- DVA

export interface CreateDynamicVaResponse {
  tx_id: string;
  dva_number: string;
  qr_payload: string;
  amount_kobo: number;
  reference: string;
  expires_at: number;
  merchant_business_name: string;
  demo_mode: boolean;
}

/**
 * Create a per-QR Squad Dynamic VA. POST /dynamic-va/create.
 *
 * Auth: token from AuthContext (minted by /auth/voice-signup) goes in
 * the Authorization header. The backend parses user_id out of the
 * token; mobile treats the token as opaque.
 *
 * Idempotent: same `amountKobo` within a 5-minute bucket returns the
 * same DVA. Different amount → fresh DVA.
 */
export async function createDynamicVa(
  amountKobo: number,
  ttlSeconds: number = 300,
  token: string | null,
): Promise<CreateDynamicVaResponse> {
  // DEMO TOKEN FORMAT — placeholder until §3.12 auth-gate PR adds real JWT.
  // Mobile AuthContext treats this as opaque; any non-empty string is accepted.
  // Format: demo_token_<user_id>_<unix_timestamp>
  // DO NOT use this as a real auth token for any sensitive endpoint.
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await axios.post<{ success: true; data: CreateDynamicVaResponse }>(
      `${API_BASE_URL}/dynamic-va/create`,
      { amount_kobo: amountKobo, ttl_seconds: ttlSeconds },
      { headers, timeout: 12_000 },
    );
    return res.data.data;
  } catch (err) {
    throw _toBackendError(err);
  }
}

/**
 * Admin reconciliation snapshot. GET /admin/state.
 * Ships with the admin-dashboard PR.
 */
export async function getAdminState(): Promise<never> {
  throw new Error('getAdminState: not implemented yet (admin dashboard PR)');
}

// ----------------------------------------------------------------- voice intent

export interface ParseIntentResult {
  intent: string;
  transcript: string;
  action: 'transfer_local' | 'balance' | 'cancel' | 'unknown';
  entities: {
    recipientId?: string;
    amountKobo?: number;
    balance_kobo?: number;
  };
}

/**
 * POST /voice/intent — send recorded audio, get back a typed intent.
 *
 * Backend runs Whisper (or demo bypass) then fast-path regex + optional
 * GPT-4o-mini. Always returns HTTP 200; action='unknown' means the
 * backend couldn't classify. Caller should surface a "try again" path.
 *
 * Auth: same demo Bearer token as createDynamicVa. Backend uses it to
 * attach live balance_kobo for balance-check responses.
 */
export async function parseIntent(
  audioUri: string,
  token: string | null,
): Promise<ParseIntentResult> {
  const form = new FormData();
  // React Native FormData accepts {uri, name, type} as a file blob.
  form.append('audio', { uri: audioUri, name: 'recording.m4a', type: 'audio/m4a' } as any);

  const headers: Record<string, string> = {
    'Content-Type': 'multipart/form-data',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await axios.post<{ success: true; data: ParseIntentResult }>(
      `${API_BASE_URL}/voice/intent`,
      form,
      {
        headers,
        // Whisper + intent round-trip; allow generous upper bound.
        timeout: 15_000,
      },
    );
    return res.data.data;
  } catch (err) {
    throw _toBackendError(err);
  }
}

// ----------------------------------------------------------------- helpers

function _toBackendError(err: unknown): Error {
  if (axios.isAxiosError(err)) {
    const ax = err as AxiosError<{ detail?: BackendErrorDetail }>;
    const status = ax.response?.status ?? 0;
    const detail = ax.response?.data?.detail ?? null;
    if (detail && typeof detail === 'object' && 'code' in detail) {
      return new BackendError(detail.code, detail.message ?? ax.message, status, detail);
    }
    if (ax.code === 'ECONNABORTED' || ax.code === 'ERR_NETWORK') {
      return new BackendError('network', 'Connection problem. Try again.', 0, null);
    }
    return new BackendError('unknown', ax.message || 'Request failed', status, null);
  }
  if (err instanceof Error) return err;
  return new Error('Unknown error');
}
