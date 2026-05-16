import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { User, Account } from '../types';
import { authAPI, accountAPI } from '../services/api';
import { useOutboxDrain } from '../hooks/useOutbox';

interface AuthContextType {
  user: User | null;
  account: Account | null;
  token: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (data: {
    username: string;
    email: string;
    password: string;
    first_name: string;
    last_name: string;
    phone_number: string;
    pin: string;
    bank_code: string;
  }) => Promise<void>;
  logout: () => Promise<void>;
  refreshAccount: () => Promise<void>;
  // Mints a session without calling the API. Used by the demo persona picker
  // and as the offline-first fallback when the backend is unreachable on cold
  // start. Persists to AsyncStorage so the next boot picks it up.
  setSession: (user: User, account: Account, token: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadStoredAuth();
  }, []);

  const loadStoredAuth = async () => {
    try {
      const storedToken = await AsyncStorage.getItem('token');
      const storedUser = await AsyncStorage.getItem('user');
      const storedAccount = await AsyncStorage.getItem('account');

      if (storedToken && storedUser && storedAccount) {
        setToken(storedToken);
        setUser(JSON.parse(storedUser));
        setAccount(JSON.parse(storedAccount));
      }
    } catch (error) {
      console.error('Error loading auth:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const login = async (username: string, password: string) => {
    const response = await authAPI.login(username, password);

    await AsyncStorage.setItem('token', response.token);
    await AsyncStorage.setItem('user', JSON.stringify(response.user));
    await AsyncStorage.setItem('account', JSON.stringify(response.account));

    setToken(response.token);
    setUser(response.user);
    setAccount(response.account);
  };

  const register = async (data: {
    username: string;
    email: string;
    password: string;
    first_name: string;
    last_name: string;
    phone_number: string;
    pin: string;
    bank_code: string;
  }) => {
    const response = await authAPI.register(data);

    await AsyncStorage.setItem('token', response.token);
    await AsyncStorage.setItem('user', JSON.stringify(response.user));
    await AsyncStorage.setItem('account', JSON.stringify(response.account));

    setToken(response.token);
    setUser(response.user);
    setAccount(response.account);
  };

  const logout = async () => {
    try {
      await authAPI.logout();
    } catch (error) {
      // Ignore logout errors
    }

    await AsyncStorage.removeItem('token');
    await AsyncStorage.removeItem('user');
    await AsyncStorage.removeItem('account');

    setToken(null);
    setUser(null);
    setAccount(null);
  };

  const setSession = async (newUser: User, newAccount: Account, newToken: string) => {
    await AsyncStorage.setItem('token', newToken);
    await AsyncStorage.setItem('user', JSON.stringify(newUser));
    await AsyncStorage.setItem('account', JSON.stringify(newAccount));
    setToken(newToken);
    setUser(newUser);
    setAccount(newAccount);
  };

  const refreshAccount = async () => {
    try {
      const updatedAccount = await accountAPI.getAccount();
      setAccount(updatedAccount);
      await AsyncStorage.setItem('account', JSON.stringify(updatedAccount));
    } catch {
      // accountAPI.getAccount hits GET /account/ — a legacy demo-bank
      // endpoint that doesn't exist on the echopay-cash backend (returns
      // 404). Wallet state is kept current via useWallet's optimistic
      // applyDebit/applyCredit instead. Silenced to keep LogBox clean
      // during demo; TODO(phase-1) is to remove accountAPI calls
      // entirely once all sites are migrated to squad-api.
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        account,
        token,
        isLoading,
        isAuthenticated: !!token,
        login,
        register,
        logout,
        refreshAccount,
        setSession,
      }}
    >
      <OutboxDrainer />
      {children}
    </AuthContext.Provider>
  );
}

// Mounted once inside the provider so it lives one level above the
// router and never re-mounts on screen changes. Consumes useAuth() via
// useOutboxDrain to get the current user + token; returns null.
function OutboxDrainer(): null {
  useOutboxDrain();
  return null;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
