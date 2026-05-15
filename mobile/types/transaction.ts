// Cached transaction row — the shape stored in services/cache.ts and read
// by the home tab + transactions tab + local-transfer success screen.
// Mirrors the backend `transactions` table from EchoPay_Cash_PRD.md §5.

export type TransactionType = 'in_network' | 'external_out' | 'topup' | 'qr_receive';
export type TransactionDirection = 'in' | 'out';
export type TransactionStatus = 'completed' | 'pending' | 'failed';

export interface TransactionRow {
  id: string;
  user_id: number;
  type: TransactionType;
  direction: TransactionDirection;
  amount_kobo: number;
  counterparty: string;       // display name, never an account number
  counterparty_user_id?: number;
  status: TransactionStatus;
  squad_ref?: string;
  idempotency_key: string;
  created_at: string;          // ISO 8601
  settled_at?: string;
}
