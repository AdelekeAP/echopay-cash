import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  LoginResponse,
  Account,
  Bank,
  Transaction,
  RecipientInfo,
  TransferResponse,
} from '../types';
import { API_BASE_URL } from '../constants/config';

// TODO(phase-1): the echopay-cash backend lives at :8100 (no /api suffix).
// Every wrapper below was inherited from the source fork and points at the
// legacy demo-bank shape on :8001/api. Until each call site is migrated to
// services/squad-api.ts, expect 404s — the new backend is not live yet.

console.log('[echopay-cash API] base URL:', API_BASE_URL);

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Add token to requests
api.interceptors.request.use(async (config) => {
  const token = await AsyncStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Token ${token}`;
  }
  return config;
});

// TODO(phase-1): rewire to echopay-cash backend on :8100 (not live yet — expect 404).
export const authAPI = {
  login: async (username: string, password: string): Promise<LoginResponse> => {
    const response = await api.post('/auth/login/', { username, password });
    return response.data;
  },

  register: async (data: {
    username: string;
    email: string;
    password: string;
    first_name: string;
    last_name: string;
    phone_number: string;
    pin: string;
    bank_code: string;
  }): Promise<LoginResponse> => {
    const response = await api.post('/auth/register/', data);
    return response.data;
  },

  logout: async (): Promise<void> => {
    await api.post('/auth/logout/');
  },
};

export const bankAPI = {
  getBanks: async (): Promise<Bank[]> => {
    const response = await api.get('/banks');
    return response.data;
  },
};

export const accountAPI = {
  getAccount: async (): Promise<Account> => {
    const response = await api.get('/account/');
    return response.data;
  },

  lookupAccount: async (accountNumber: string, bankCode: string): Promise<{ found: boolean; recipient: RecipientInfo }> => {
    const response = await api.post('/account/lookup', {
      account_number: accountNumber,
      bank_code: bankCode,
    });
    return response.data;
  },
};

export const transactionAPI = {
  getTransactions: async (): Promise<Transaction[]> => {
    const response = await api.get('/transactions/');
    return response.data;
  },

  transfer: async (data: {
    recipient_account_number: string;
    recipient_bank_code: string;
    amount: number;
    pin: string;
    description?: string;
  }): Promise<TransferResponse> => {
    const response = await api.post('/transactions/transfer/', data);
    return response.data;
  },
};

export default api;
