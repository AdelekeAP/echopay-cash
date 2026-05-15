export interface User {
  id: number;
  username: string;
  email: string;
  first_name: string;
  last_name: string;
  phone_number: string;
}

export interface Bank {
  id: number;
  name: string;
  code: string;
  logo_url: string | null;
}

export interface Account {
  id: number;
  user: User;
  bank: Bank;
  account_number: string;
  balance: string;
  // PRD_FUNBI §11 — pre-allocated offline-spending budget. Optional for
  // back-compat with code that doesn't yet read this field; defaults to
  // "0.00" when missing.
  locked_balance?: string;
  is_active: boolean;
  created_at: string;
}

export interface Transaction {
  id: number;
  amount: string;
  transaction_type: 'deposit' | 'withdrawal' | 'transfer_in' | 'transfer_out';
  status: 'pending' | 'completed' | 'failed';
  reference: string;
  description: string;
  recipient_name: string;
  recipient_bank: string;
  timestamp: string;
}

export interface RecipientInfo {
  account_number: string;
  account_name: string;
  bank_name: string;
}

export interface SavedRecipient {
  id: number;
  nickname: string;
  recipient_details: RecipientInfo;
  created_at: string;
}

export interface LoginResponse {
  token: string;
  user: User;
  account: Account;
}

export interface TransferResponse {
  message: string;
  transaction: Transaction;
  new_balance: string;
}
