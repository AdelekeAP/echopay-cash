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

/**
 * Create a Squad Dynamic VA for QR-receive. POST /dynamic-va/create.
 * Ships with the receive-QR backend integration PR.
 */
export async function createDynamicVa(
  _amount_kobo: number,
  _ttl_seconds: number,
): Promise<never> {
  throw new Error('createDynamicVa: not implemented yet (DVA backend PR)');
}

/**
 * Admin reconciliation snapshot. GET /admin/state.
 * Ships with the admin-dashboard PR.
 */
export async function getAdminState(): Promise<never> {
  throw new Error('getAdminState: not implemented yet (admin dashboard PR)');
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
