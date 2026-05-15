// Demo personas — Mile 12 Market story from the EchoPay Cash master doc.
// Used by login (persona picker) and register (creates a fourth user that
// inherits the shape). PIN is uniform 1234 for stage demo control.
//
// These mock the user + Squad Static VA pairs the backend would create.
// When the real backend lands (echopay-cash backend on :8100), this file
// becomes a fallback for offline-first cold start before the first sync.

import { User, Account } from '../types';

export interface Persona {
  id: string;            // slug used in URLs and analytics
  display_name: string;  // shown in the header: "Good morning, Mama Risikat"
  role: string;          // subtitle on the picker tile
  initials: string;      // for the avatar circle
  pin: string;           // demo only — real flow stores Argon2id hash in secure-store
  user: User;
  account: Account;
}

export const PERSONAS: Persona[] = [
  {
    id: 'mama_risikat',
    display_name: 'Mama Risikat',
    role: 'Fish seller · Mile 12 Market',
    initials: 'MR',
    pin: '1234',
    user: {
      id: 1,
      username: 'mama_risikat',
      email: 'mama.risikat@echopay.test',
      first_name: 'Mama Risikat',
      last_name: 'Oluwole',
      phone_number: '+234 801 234 5001',
    },
    account: {
      id: 1,
      account_number: '0123456789',
      balance: '450000.00',
      is_active: true,
      created_at: '2026-05-10T08:00:00Z',
      user: {
        id: 1,
        username: 'mama_risikat',
        email: 'mama.risikat@echopay.test',
        first_name: 'Mama Risikat',
        last_name: 'Oluwole',
        phone_number: '+234 801 234 5001',
      },
      bank: { id: 1, name: 'GTBank', code: '058', logo_url: null },
    },
  },
  {
    id: 'iya_tope',
    display_name: 'Iya Tope',
    role: 'Okra trader · Mile 12 Market',
    initials: 'IT',
    pin: '1234',
    user: {
      id: 2,
      username: 'iya_tope',
      email: 'iya.tope@echopay.test',
      first_name: 'Iya Tope',
      last_name: 'Adeyemi',
      phone_number: '+234 801 234 5002',
    },
    account: {
      id: 2,
      account_number: '0234567890',
      balance: '125000.00',
      is_active: true,
      created_at: '2026-05-10T08:00:00Z',
      user: {
        id: 2,
        username: 'iya_tope',
        email: 'iya.tope@echopay.test',
        first_name: 'Iya Tope',
        last_name: 'Adeyemi',
        phone_number: '+234 801 234 5002',
      },
      bank: { id: 1, name: 'GTBank', code: '058', logo_url: null },
    },
  },
  {
    id: 'kosi',
    display_name: 'Kosi',
    role: 'Customer · Lagos',
    initials: 'K',
    pin: '1234',
    user: {
      id: 3,
      username: 'kosi',
      email: 'kosi@echopay.test',
      first_name: 'Kosi',
      last_name: 'Eze',
      phone_number: '+234 801 234 5003',
    },
    account: {
      id: 3,
      account_number: '0345678901',
      balance: '80000.00',
      is_active: true,
      created_at: '2026-05-10T08:00:00Z',
      user: {
        id: 3,
        username: 'kosi',
        email: 'kosi@echopay.test',
        first_name: 'Kosi',
        last_name: 'Eze',
        phone_number: '+234 801 234 5003',
      },
      bank: { id: 1, name: 'GTBank', code: '058', logo_url: null },
    },
  },
];

export function getPersonaById(id: string): Persona | undefined {
  return PERSONAS.find((p) => p.id === id);
}
