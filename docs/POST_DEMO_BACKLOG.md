# Post-Demo Backlog

Items intentionally deferred from the M1 hackathon scope to ship a focused 5-minute demo. **None of these affect the 5-minute stage flow.** All surfaced in the pre-demo audit; tracked here so they don't get lost after submission.

---

## Security hardening

- **Real admin auth** — `X-Admin-Key` HTTP header + FastAPI dependency on `/admin/*` routes. Currently mitigated by Cloudflared tunnel scope (admin not publicly reachable) + localhost-only dashboard static server. ~5-line change in a single PR.
- **Token format hardening** — `demo_token_<uid>_<unix>` is opaque placeholder. Production needs real JWT with signing key + expiry + refresh. Affects every Bearer-token consumer.
- **Per-persona biometric enrollment trigger** — currently no flow calls `/api/v1/voice/biometrics/enroll` after signup; relies on Path C demo mode for stage. Production needs an enrollment beat in the signup screen OR opt-in flow.
- **Rate limiting** — no global request rate limits. Easy WIN with `slowapi` or Cloudflare-side rules.

## Test coverage

- **Mobile Jest tests for screens** — currently service-layer only (`cache.test.ts`, `transfer.test.ts`, 27 tests total). Loans, scan, transfer, receive, voice-signup screens are smoke-tested manually, not Jest-tested.
- **Path A integration test for voice biometric proxy** — only Path C synthetic path is unit-tested. Real `:8000` forwarding tested by smoke only.
- **End-to-end demo flow integration test** — no test exists that exercises the full Script A across multiple endpoints (signup → transfer → QR → scan → loan → reconcile). Demo-day smoke is the closest substitute.

## Architecture & infra

- **Real Squad `/account/balance` reconciliation** — `master_va` is synthesized from transaction history + seeded baseline. M1 gap-filler explicitly documented. Production should query Squad's actual master VA balance and compare against our computed total for the invariant.
- **SQLite → Postgres migration** — current SQLite WAL mode is fine for hackathon scope (single-writer, atomic `BEGIN IMMEDIATE`). Production needs Postgres for concurrent writers + better observability + connection pooling. Models are dialect-agnostic; switch is mostly a `DATABASE_URL` change + Alembic migrations.
- **Real-time observability + metrics dashboard** — currently structured logs only. Production needs Prometheus metrics endpoint + dashboard for: webhook latency, transcribe latency, loan disbursement rate, anomaly flag rate, reconciliation drift events.
- **Load testing** — no benchmarks of concurrent transfer throughput, webhook ingest under burst, or anomaly recomputation under N personas. The atomic `with db.begin():` pattern is correct but untested under load.

## Voice + AI

- **Pidgin Whisper fine-tune** — using off-the-shelf Whisper for the demo. PRD §10 notes a Pidgin fine-tune is in-progress; production should swap in the fine-tuned model for better Pidgin transcription accuracy.
- **Voice biometric anti-replay hardening** — current `:8000` service requires sample diversity at enrollment (3 distinct utterances). Production adds liveness detection (random-prompt challenge response) and timestamp-bound voice signatures.
- **Multi-language intent parser** — current regex + LLM prompt covers English + Nigerian Pidgin. Roadmap: Yoruba, Igbo, Hausa. Same architecture, different prompts + regex sets.

## Demo narrative gaps

- **Signup → biometric enrollment bridge** — addressed in "Security hardening" above; flagged separately because it directly affects the 1:15 demo beat's narrative integrity (synthetic biometric pass works on stage but is rhetorically weaker than real enrollment).
- **Anomaly review action** — current admin dashboard surfaces alerts as read-only. Production needs operator actions: dismiss, escalate, suspend wallet, push notification to user. ~50-line addition.

---

## Triage rules

When picking up an item from this backlog:

1. **Security hardening items go first.** Admin auth + JWT migration are the only items with real demo-day risk if exploited; they were mitigated operationally for the hackathon, not designed away.
2. **Test coverage second.** The mobile Jest gap is the biggest unknown — most likely place for a regression bug to ship to users.
3. **Architecture/infra third.** Squad balance reconciliation is the most rhetorically powerful add (closes the Q-7 weakness from the prep card).
4. **Voice + AI last.** These are quality wins, not correctness fixes. Roadmap, not backlog.

---

*Item count: 17. Estimated total engineering effort: ~3-4 weeks for one engineer working full-time, or 6-8 weeks for a part-time 2-person team.*
