// Mono NIN lookup wrapper.
//
// The real Mono NIN endpoint requires a server-side secret key
// (`mono-sec-key: test_sk_...`) and is NOT CORS-open to browsers. In the
// production shape, the mobile app POSTs to our own backend on :8100
// (`POST /kyc/nin-lookup { nin }`), and the backend proxies to:
//
//   POST https://api.mono.co/v2/lookup/nin
//   Headers: mono-sec-key: $MONO_SECRET_KEY, Content-Type: application/json
//   Body:    { "nin": "12345678901" }
//   Docs:    https://docs.mono.co/docs/lookup/nin-lookup
//
// Until the echopay-cash backend ships, this file returns mock data that
// matches the real Mono response shape. To swap to real: change the body of
// verifyNin() to a fetch against EXPO_PUBLIC_API_BASE_URL + '/kyc/nin-lookup'.

export interface MonoNinData {
  nin: string;
  first_name: string;
  middle_name: string | null;
  last_name: string;
  date_of_birth: string;       // ISO date YYYY-MM-DD
  gender: 'Male' | 'Female';
  phone_number: string;
  photo: string | null;        // base64 PNG, omitted in mock
}

export interface MonoNinResponse {
  status: 'successful' | 'failed';
  message: string;
  data: MonoNinData | null;
}

// Demo NINs that return known results. Use these on stage for predictable
// outcomes. Anything else returns a generated plausible record.
const DEMO_FIXTURES: Record<string, MonoNinData> = {
  '12345678901': {
    nin: '12345678901',
    first_name: 'Adunni',
    middle_name: 'Folake',
    last_name: 'Bello',
    date_of_birth: '1985-03-14',
    gender: 'Female',
    phone_number: '+2348099887766',
    photo: null,
  },
  '22334455667': {
    nin: '22334455667',
    first_name: 'Tunde',
    middle_name: null,
    last_name: 'Adeyemi',
    date_of_birth: '1990-11-22',
    gender: 'Male',
    phone_number: '+2348011223344',
    photo: null,
  },
  '98765432101': {
    nin: '98765432101',
    first_name: 'Chioma',
    middle_name: 'Ngozi',
    last_name: 'Okafor',
    date_of_birth: '1992-07-08',
    gender: 'Female',
    phone_number: '+2348055667788',
    photo: null,
  },
};

const VALID_NIN = /^\d{11}$/;

export async function verifyNin(nin: string): Promise<MonoNinResponse> {
  const clean = nin.replace(/\D/g, '');

  // Simulate network latency so the loading state is visible during the
  // demo. Mono's real sandbox is ~600–1200ms in practice.
  await new Promise((r) => setTimeout(r, 900 + Math.random() * 500));

  if (!VALID_NIN.test(clean)) {
    return {
      status: 'failed',
      message: 'NIN must be exactly 11 digits.',
      data: null,
    };
  }

  if (clean in DEMO_FIXTURES) {
    return {
      status: 'successful',
      message: 'NIN details fetched successfully',
      data: DEMO_FIXTURES[clean],
    };
  }

  // Generated fallback — deterministic-ish from the NIN so testers see
  // consistent results for the same input within a session.
  const seed = parseInt(clean.slice(0, 4), 10);
  const FIRST = ['Aisha', 'Ngozi', 'Funke', 'Bukola', 'Chiamaka', 'Yetunde'];
  const LAST = ['Adesanya', 'Eze', 'Okoro', 'Bello', 'Sanusi', 'Adeyemo'];
  return {
    status: 'successful',
    message: 'NIN details fetched successfully',
    data: {
      nin: clean,
      first_name: FIRST[seed % FIRST.length],
      middle_name: null,
      last_name: LAST[seed % LAST.length],
      date_of_birth: `19${70 + (seed % 30)}-0${(seed % 9) + 1}-${10 + (seed % 18)}`,
      gender: seed % 2 === 0 ? 'Female' : 'Male',
      phone_number: `+234801${clean.slice(0, 7)}`,
      photo: null,
    },
  };
}

// Human-friendly DOB formatter: "Mar 14, 1985"
export function formatDob(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// --------------------------------------------------------------------- BVN
//
// Real Mono BVN flow (https://docs.mono.co/docs/lookup/bvn-initiate) is
// three calls: initiate → method (sms/email OTP) → details with the OTP.
// For the hackathon demo we collapse it to a single mocked verify that
// returns the merged identity payload. The backend (when it lands) will
// implement the full OTP flow against:
//
//   POST https://api.mono.co/v2/lookup/bvn/initiate
//   POST https://api.mono.co/v2/lookup/bvn/verify
//   POST https://api.mono.co/v2/lookup/bvn/details
//
// All gated behind `mono-sec-key`.

export interface MonoBvnData {
  bvn: string;
  first_name: string;
  middle_name: string | null;
  last_name: string;
  date_of_birth: string;
  gender: 'Male' | 'Female';
  phone_number1: string;
  phone_number2: string | null;
  registration_date: string;
  enrollment_bank: string;
  enrollment_branch: string;
}

export interface MonoBvnResponse {
  status: 'successful' | 'failed' | 'mismatch';
  message: string;
  data: MonoBvnData | null;
}

// BVN fixtures keyed to a matching NIN. The demo personas thread through:
// enter NIN 12345678901 → verify → enter BVN 22288899900 (same person).
const BVN_FIXTURES: Record<string, { bvn: string; data: MonoBvnData }> = {
  '12345678901': {
    bvn: '22288899900',
    data: {
      bvn: '22288899900',
      first_name: 'Adunni',
      middle_name: 'Folake',
      last_name: 'Bello',
      date_of_birth: '1985-03-14',
      gender: 'Female',
      phone_number1: '+2348099887766',
      phone_number2: null,
      registration_date: '2014-06-22',
      enrollment_bank: 'GTBank',
      enrollment_branch: 'Lekki Phase 1',
    },
  },
  '22334455667': {
    bvn: '11122233344',
    data: {
      bvn: '11122233344',
      first_name: 'Tunde',
      middle_name: null,
      last_name: 'Adeyemi',
      date_of_birth: '1990-11-22',
      gender: 'Male',
      phone_number1: '+2348011223344',
      phone_number2: null,
      registration_date: '2016-02-10',
      enrollment_bank: 'GTBank',
      enrollment_branch: 'Ikeja',
    },
  },
  '98765432101': {
    bvn: '55566677788',
    data: {
      bvn: '55566677788',
      first_name: 'Chioma',
      middle_name: 'Ngozi',
      last_name: 'Okafor',
      date_of_birth: '1992-07-08',
      gender: 'Female',
      phone_number1: '+2348055667788',
      phone_number2: null,
      registration_date: '2015-11-04',
      enrollment_bank: 'GTBank',
      enrollment_branch: 'Yaba',
    },
  },
};

// Verifies a BVN against a previously NIN-verified identity. In the mock,
// any BVN works against any NIN, but if you pass the canonical pair from
// BVN_FIXTURES the returned data matches the NIN holder exactly — useful
// for stage demos where judges may check.
export async function verifyBvn(
  bvn: string,
  ninContext?: string,
): Promise<MonoBvnResponse> {
  const clean = bvn.replace(/\D/g, '');
  await new Promise((r) => setTimeout(r, 900 + Math.random() * 500));

  if (!/^\d{11}$/.test(clean)) {
    return { status: 'failed', message: 'BVN must be exactly 11 digits.', data: null };
  }

  // If the caller passed the NIN we verified earlier, check the canonical
  // BVN. Wrong BVN for the right NIN → mismatch (good story for judges).
  if (ninContext && ninContext in BVN_FIXTURES) {
    const fix = BVN_FIXTURES[ninContext];
    if (clean !== fix.bvn) {
      return {
        status: 'mismatch',
        message: `That BVN does not match the NIN holder. Expected ${fix.data.first_name} ${fix.data.last_name}.`,
        data: null,
      };
    }
    return {
      status: 'successful',
      message: 'BVN verified',
      data: fix.data,
    };
  }

  // Free-form fallback so any 11-digit BVN succeeds in demo mode.
  const seed = parseInt(clean.slice(0, 4), 10);
  const FIRST = ['Aisha', 'Ngozi', 'Funke', 'Bukola', 'Chiamaka', 'Yetunde'];
  const LAST = ['Adesanya', 'Eze', 'Okoro', 'Bello', 'Sanusi', 'Adeyemo'];
  return {
    status: 'successful',
    message: 'BVN verified',
    data: {
      bvn: clean,
      first_name: FIRST[seed % FIRST.length],
      middle_name: null,
      last_name: LAST[seed % LAST.length],
      date_of_birth: `19${70 + (seed % 30)}-0${(seed % 9) + 1}-${10 + (seed % 18)}`,
      gender: seed % 2 === 0 ? 'Female' : 'Male',
      phone_number1: `+234801${clean.slice(0, 7)}`,
      phone_number2: null,
      registration_date: '2017-01-15',
      enrollment_bank: 'GTBank',
      enrollment_branch: 'Lagos',
    },
  };
}
