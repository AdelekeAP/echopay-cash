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

// --------------------------------------------------------------- outbox
// Persisted in services/cache.ts (`echopay:outbox:<user_id>`). One row
// per offline-queued op. Status transitions monotonically:
//   queued → sent → (acked | rejected)
// Rejected rows never retry. idempotency_key matches transactions.UNIQUE
// on the server so replay is safe.

export type OutboxStatus = 'queued' | 'sent' | 'acked' | 'rejected';

export interface OutboxRow {
  id: string;
  user_id: number;
  op_type: 'in_network';            // ready for future op types (M2 permits)
  payload: {
    from_user_id: number;
    to_user_id: number;
    amount_kobo: number;
  };
  idempotency_key: string;
  attempts: number;
  last_error?: string;
  created_at: string;
  next_retry_at: string;
  status: OutboxStatus;
}
