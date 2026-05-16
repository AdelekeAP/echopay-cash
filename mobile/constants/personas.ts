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
  // ed25519 keypair for offline-payment signing (master doc §4.2).
  // Demo-only: in production these would be generated on the device
  // at signup and never written to a JS bundle. The deterministic
  // seed (sha256("echopay-demo:<customer_identifier>")) matches the
  // pubkeys seeded in backend/seed.py.
  ed25519PrivKeyB64: string;
  ed25519PubKeyB64: string;
}

export const PERSONAS: Persona[] = [
  {
    // ed25519 seed (32 bytes b64) and pubkey (32 bytes b64) — matches
    // backend/seed.py "mama_risikat_001".
    ed25519PrivKeyB64: 'fBVAVFqgRrvrKi7157yvWm7YFqIOrAT4xEVBRRtc6/o=',
    ed25519PubKeyB64:  '999uiLtwK4u4k3NhG5SB6xzPTs9uB6MkDsPH9Z5t8yw=',
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
      account_number: '3647487179',
      balance: '400000.00',
      locked_balance: '50000.00',
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
    ed25519PrivKeyB64: 'EHbzjmSPqhvBsvGYWBHBX+ilYqSoSkytbBVdWk1BKos=',
    ed25519PubKeyB64:  'o5hjpq2lYZfj4Z/XC6X2es7G2Syn+1cbtXtovEihU1o=',
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
      account_number: '5539926298',
      balance: '110000.00',
      locked_balance: '15000.00',
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
    ed25519PrivKeyB64: 'zfEk1Btao3Hjf5+8iZDyjCuX/m5mq3BHbK1tEPPYgfk=',
    ed25519PubKeyB64:  'E2tSlHCYKv56LLXSlmXbrmBK5vyXRHZKCrvGExDxG/g=',
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
      account_number: '1686232573',
      balance: '75000.00',
      locked_balance: '5000.00',
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
