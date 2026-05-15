// Wallet shape. The authoritative balance lives on the backend; this is
// the local cache that powers offline-first cold start.

export interface Wallet {
  user_id: number;
  squad_va_number: string;
  balance_kobo: number;
  updated_at: string;          // ISO 8601
}
