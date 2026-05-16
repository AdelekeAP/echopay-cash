# Q&A Prep Card — EchoPay Cash

Single-page reference for Kosi + team during judge Q&A.
Eleven prepared answers, ranked by likelihood. Memorize the
**Answer** line; the **If probed** line is the depth move when
a judge presses.

---

### Q-1: "Show me a real Squad webhook arriving in your system"

**Likely framing:** "Can you actually demonstrate the live Squad integration end-to-end, or is this all synthetic?"

**Answer:** "Yes — the backend's `/webhooks/squad` endpoint is exposed via Cloudflared tunnel restricted to that path only. If we trigger a real DVA payment in the Squad sandbox dashboard right now, you'll see the webhook arrive in our admin dashboard within seconds, with HMAC-SHA512 V2 signature validation visible."

**If probed:** *"What's the canonical HMAC field order?"* → *"`transaction_reference | virtual_account_number | currency | principal_amount | settled_amount | customer_identifier`. We accept V2 canonical with V1 raw-body fallback for sandbox variance. Field name `currency` not `transaction_currency` — Squad's docs had this wrong in early versions; we defensively accept both."*

---

### Q-2: "What stops a malicious user from sending fake webhooks?"

**Likely framing:** "Your webhook is public — how do you trust the payload?"

**Answer:** "Three layers. First, HMAC-SHA512 V2 with constant-time compare — we verify the signature over the raw request bytes before any DB write, no exceptions. Second, idempotency: `WebhookEvent.transaction_ref` is the primary key, so a replay attack just collides on insert and returns 200 with no state change. Third, amount mismatch handling: if the paid amount doesn't match the expected DVA amount, we mark the transaction `reversed` and don't credit the wallet."

**If probed:** *"What if Squad rotates their secret?"* → *"`SQUAD_SECRET_KEY` is env-driven; rotation is a single `.env` update + restart. The verify function accepts V1 raw-body hash as a fallback for sandbox variance during the rotation window."*

---

### Q-3: "What happens if Whisper API is down on stage?"

**Likely framing:** "Your demo depends on OpenAI being up. What's the fallback?"

**Answer:** "Two layers. The `VOICE_DEMO_MODE=true` env flag bypasses Whisper entirely and returns a hardcoded transcript — the demo flow continues identically because intent parsing happens after transcription. The flag is defaulted true for stage stability. If we hit a transcription error in production (Whisper unreachable, audio corruption), the endpoint returns 503 and the mobile shows a clean retry state with an IntentPicker fallback offering the same three demo intents as buttons."

**If probed:** *"What's the IntentPicker fallback?"* → *"A 3-button dropdown — Send ₦5K to Iya, Send ₦200 to Kosi, Check my balance — that bypasses voice entirely and routes via the same dispatcher used by the voice intent endpoint. Same code path, manual trigger."*

---

### Q-4: "Why z-score over machine learning for anomaly detection?"

**Likely framing:** "ML fraud models are state-of-the-art. Why are you using a 1950s statistics method?"

**Answer:** "Three reasons. First, explainability — when we flag Mama's ₦450K transaction, the reason string includes the math: 'mean ₦45,415, stdev ₦134,997, z=3.0σ above her typical pattern.' Operators can read that and decide. Black-box ML can't. Second, no training data needed — z-score works from a user's first 5 transactions. Third, per-persona baselines avoid population-level bias: a trader with consistently large transactions has a higher baseline, so large amounts aren't reflexively flagged. ML is on the production roadmap — z-score is the MVP that proves the data path."

**If probed:** *"What's the cold-start risk?"* → *"Users with fewer than 5 outbound transactions return an `insufficient_history` marker, not a flag. We surface the uncertainty rather than guess. Production layer adds a similarity-based bootstrap from peer-group baselines for new users."*

---

### Q-5: "How does the credit score evolve over time?"

**Likely framing:** "Is your credit score a static number or does it actually update?"

**Answer:** "Recomputed on every loan request from live transaction history — deterministic formula, no caching. Five signals: account age (×2 capped at 100), inbound transaction count (×15 capped 120), transfer activity (×8 capped 80), balance threshold bonus (flat 50 if >₦10K), failed transaction penalty (×25 capped 100). Clamped to FICO range [300, 850]. As a user transacts, their score rises naturally. Musa for example — twelve gig payments over thirty days plus a ₦26K balance — computes to 730, auto-approve band."

**If probed:** *"What's the auto-approve threshold?"* → *"700 auto-disburses, 500-699 manual review, below 500 declined. Tunable per-cohort in production. Conservative defaults for demo because the loan disburses instantly without human review."*

---

### Q-6: "What if the `:8000` voice biometric service is down?"

**Likely framing:** "Your architecture depends on a separate service for biometrics. What's the contingency?"

**Answer:** "Documented at PRD §11.5 — `VOICE_BIOMETRIC_DEMO_MODE=true` env flag puts the proxy on Path C, which returns synthetic-pass responses without calling `:8000`. We default to Path C for stage; flip to Path A only after dress-rehearsal confirms reachability. The synthetic responses match the legacy `:8000` shape verbatim so the mobile parser doesn't notice a difference. The decision separates two failure domains: algorithm credibility lives on `:8000`, network reachability lives in our deployment ops."

**If probed:** *"So your live demo is fake biometric?"* → *"The voice intent path is real Whisper transcription. The biometric verify is Path C synthetic for stage reliability — but the same backend endpoint, same request/response shape, same idempotency keys. Flipping the env flag to Path A makes the exact same code call the real ECAPA model. We're choosing stage reliability over algorithm credibility in a 5-minute window where we can't recover from infra blips."*

---

### Q-7: "Show me your reconciliation number matching Squad's sandbox dashboard"

**Likely framing:** "Your admin dashboard shows a master VA balance. Can you prove it matches what Squad shows?"

**Answer:** "M1 reconciliation is synthesized from transaction history plus a seeded baseline — explicitly documented as a gap-filler in `admin.py:_master_va_balance_kobo`. Live Squad `/account/balance` query lands in M2. The invariant we DO prove is internal: `SUM(wallets.balance + locked) == seed_baseline + inbound_types_sum - outbound_types_sum`. Drift = 0 across the full loan lifecycle, including mid-loan — we have an explicit test for that. The mismatch with Squad's actual pool balance is honest scope discipline, not a bug."

**If probed:** *"Why didn't you just call Squad's balance endpoint?"* → *"Squad's `/account/balance` for the merchant master VA isn't exposed in sandbox — the sandbox docs explicitly note it's production-only. We'd need live production access to demonstrate the round-trip, which the hackathon scope doesn't include. The synthesized formula is the right tradeoff for M1."*

---

### Q-8: "Where does the loan money come from?"

**Likely framing:** "When you disburse ₦20,000 to Musa, where does that money physically come from?"

**Answer:** "Conceptually, the EchoPay master VA pool — and we model it correctly. Loans are credit-creation events in the formula: `loan_disbursement` is treated as INBOUND to master VA, not outbound. Banks create money when they lend; we mirror that semantic. The result: `sum(wallets) == master_va` stays balanced before, during, and after the loan lifecycle. The disbursement code path is one atomic `with db.begin():` — wallet credit, Transaction insert, loan status update, all-or-nothing."

**If probed:** *"Isn't that just a number going up in your database?"* → *"In the M1 demo, yes — same as any digital bank's overdraft. The capital model for Phase 2 is partner-lender funding via a discrete tranche; the disbursement endpoint becomes a thin wrapper around an external lender API. The interface stays identical because the production substitution is internal-only."*

---

### Q-9: "Is your admin dashboard authenticated? What stops me from accessing it?"

**Likely framing:** "I just saw the admin URL on your screen. Can I open it on my phone right now?"

**Answer:** "The admin dashboard is served localhost-only — `python -m http.server 5173 --bind 127.0.0.1`. It's running on the laptop you're looking at; there's no way for an external client to reach it. The backend API endpoints it polls are bound to `0.0.0.0:8100` for mobile LAN access, but our Cloudflared tunnel scope explicitly restricts the public surface to `/webhooks/squad/.*` only. `/admin/*` returns 404 over the tunnel. Production hardening — X-Admin-Key dependency — is in the post-demo backlog and is straightforward."

**If probed:** *"Show me the tunnel config."* → Open the runbook on the laptop, show the `ingress:` block with `/webhooks/squad/.*` path filter and `http_status:404` catch-all. Then `curl https://<tunnel>/admin/state` from your terminal — returns 404 live.

---

### Q-10: "Can a regular user with your mobile app access admin endpoints?"

**Likely framing:** "If I install your mobile APK and obtain the backend URL, what stops me from hitting `/admin/state` and seeing all balances?"

**Answer:** "Two protections. First, the mobile app doesn't include the admin endpoint paths in any service file — the `services/squad-api.ts` stub for `getAdminState` throws 'not implemented yet'. Even if the user reverse-engineered the backend URL, the admin paths aren't discoverable from the bundle. Second, the backend is bound to `0.0.0.0:8100` for LAN access, but the public Cloudflared tunnel is scoped to `/webhooks/squad/.*` — admin endpoints are NOT publicly reachable. A user on the same WiFi could in theory hit `/admin/state` directly; we treat 'same physical network as backend' as the trust boundary for the M1 demo. Production adds X-Admin-Key auth."

**If probed:** *"What about a malicious user on the demo venue's WiFi?"* → *"Valid risk. Mitigated for stage by ensuring the laptop is on the speaker's hotspot, not venue WiFi. Post-demo: X-Admin-Key dependency on the FastAPI router. Five-line change; in the backlog."*

---

### Q-11: "How do you prevent biometric enrollment hijacking?"

**Likely framing:** "If biometric enrolls on first transfer, what stops someone with the unlocked phone from enrolling their voice?"

**Answer:** "Industry-standard pattern — Apple Pay and Cash App enroll on first use, not signup. The security boundary that matters more is device-level: fingerprint unlock + PIN backup. Both are in our M2 roadmap. Today's submission focuses on voice-first onboarding for the financially excluded; the full multi-factor stack is a Phase 2 deliverable."

**If probed:** *"What's the actual EER of your ECAPA model?"* → *"≤6% EER, disaggregated by gender and age, on the SpeechBrain VoxCeleb baseline. Our anti-replay layer requires sample diversity — three distinct utterances at enrollment — which raises attack difficulty significantly beyond raw EER."*
