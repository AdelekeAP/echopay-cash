# Demo Day Runbook — EchoPay Cash

GTCO Squad Hackathon 3.0 · Saturday May 16, 2026

This is the operational playbook. Follow top-to-bottom. Every checkbox
matters; the failure modes are documented at the bottom.

---

## Pre-stage checklist (T-30 min)

- [ ] **Backend running** on `:8100` (bound to 0.0.0.0 so phones can reach it):
  ```bash
  cd backend
  source .venv/bin/activate
  uvicorn app.main:app --host 0.0.0.0 --port 8100
  ```
- [ ] **Admin dashboard server** on `:5173`, bound to localhost ONLY (never `0.0.0.0`):
  ```bash
  cd admin
  python -m http.server 5173 --bind 127.0.0.1
  ```
  Then open `http://127.0.0.1:5173/index.html?api=http://localhost:8100` in your laptop browser. The `?api=` query param tells the dashboard where to find the backend.
- [ ] **DB freshly seeded:**
  ```bash
  cd backend
  rm -f echopay.db echopay.db-shm echopay.db-wal
  python -m seed
  ```
  Expected output: `seeded mama_risikat_001`, `seeded iya_tope_002`, `seeded kosi_003`, `seeded musa_offloader_001`, `seeded 12 gig transactions for Musa`, `seeded 18 demo transactions for Mama (anomaly panel)`.
- [ ] **Verify drift = 0:**
  ```bash
  curl -s -X POST http://localhost:8100/admin/reconcile | python3 -m json.tool | grep -E "drift_kobo|invariant_holds"
  ```
  Expected: `"drift_kobo": 0` and `"invariant_holds": true`.
- [ ] **Verify anomaly panel populates:**
  ```bash
  curl -s http://localhost:8100/admin/anomalies | python3 -c "import sys,json; d=json.load(sys.stdin); print('high:', d['alerts_by_severity']['high'])"
  ```
  Expected: `high: 1` (Mama's seeded ₦450K anomaly).
- [ ] **Mobile `EXPO_PUBLIC_API_BASE_URL`** set to laptop LAN IP (not `localhost`). Find it with `ifconfig | grep "inet "` on the laptop — pick the WiFi adapter's `192.168.x.x` or `10.x.x.x` address.
- [ ] **Both phones on same WiFi as backend.** Test connectivity: open `http://<laptop-LAN-IP>:8100/health` in the phone's browser — should return `{"success":true,"data":{"status":"ok"}}`.
- [ ] **Cloudflared tunnel started with SCOPED config** (see next section — DO NOT skip this).
- [ ] **Squad sandbox dashboard** open in a browser tab on the laptop for the "show me the matching balance" Q&A moment.
- [ ] **Recording backup** of full demo run ready as fallback. If live demo fails catastrophically, switch to recording without acknowledging the failure.

---

## Cloudflared tunnel scope (CRITICAL)

The backend exposes both `/webhooks/squad` (Squad sandbox needs to reach us) AND `/admin/*` (sensitive — balances, credit scores, anomaly alerts, all unauthenticated). **A wide-open tunnel exposes the admin endpoints to anyone with the URL.** Restrict to webhook path only.

### Example `~/.cloudflared/config.yml`:

```yaml
tunnel: <your-tunnel-id>
credentials-file: /Users/<you>/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: <your-tunnel-hostname>.trycloudflare.com
    path: /webhooks/squad/.*
    service: http://localhost:8100
  # Catch-all returns 404 — admin endpoints are NOT reachable via tunnel.
  - service: http_status:404
```

Start the tunnel:
```bash
cloudflared tunnel --config ~/.cloudflared/config.yml run
```

### Verify scope BEFORE demo:

```bash
# Should reach backend (200 or 405 — webhook endpoint exists, GET not allowed is fine)
curl -i https://<your-tunnel>.trycloudflare.com/webhooks/squad

# Should return 404 — admin endpoints NOT exposed
curl -i https://<your-tunnel>.trycloudflare.com/admin/state
curl -i https://<your-tunnel>.trycloudflare.com/admin/anomalies
curl -i https://<your-tunnel>.trycloudflare.com/admin/reconcile
```

If `/admin/state` returns 200 with persona data, your tunnel is WIDE OPEN. **Kill the tunnel immediately, fix the config, restart, re-verify.**

If your existing tunnel was provisioned with `cloudflared tunnel --url http://localhost:8100` (one-shot, no config file), it's wide-open by default. Stop it (Ctrl+C) and restart with the scoped config above.

---

## Demo `.env` values (backend/.env)

```bash
# Voice intent — Whisper bypass for stage stability
VOICE_DEMO_MODE=true

# Voice biometric — synthetic Path C pass (no :8000 dependency)
VOICE_BIOMETRIC_DEMO_MODE=true

# Squad — sandbox key required for live VA creation
SQUAD_BASE_URL=https://sandbox-api-d.squadco.com
SQUAD_SECRET_KEY=<sandbox-key>
SQUAD_MERCHANT_ID=SBUTRLU8CS

# OpenAI Whisper — only needed if VOICE_DEMO_MODE=false (don't flip on stage)
OPENAI_API_KEY=

# Database
DATABASE_URL=sqlite:///./echopay.db
```

**Both demo-mode flags default `true` for safety.** Only flip them after a green dress-rehearsal on the actual stage hardware. The audit's recommendation: leave them on for the demo — Path A real-mode is for a controlled environment, not a 5-minute live stage with limited recovery time.

---

## Mid-demo fallback table

If something fails on stage, do these silently without acknowledging the failure narratively:

| Failure | Action | Recovery time |
|---|---|---|
| Voice transcription fails (Whisper down) | `export VOICE_DEMO_MODE=true && restart backend` — uvicorn hot-reloads in <2s | <10s |
| Biometric step-up fails (`:8000` down) | Already on Path C demo mode — say "real ECAPA running on team infra, demo mode active for stage reliability" | 0s (preventive) |
| Squad webhook delayed | Show admin reconcile manually with the curl on stage laptop; it'll show pending. Move on to next beat. | <15s |
| QR scan fails (camera permission) | Switch to manual paste of the 10-digit DVA number on the scan screen — paste textarea fallback is built-in. Re-attempt camera after. | <20s |
| Backend crashes | Restart with same uvicorn command; SQLite WAL persists. No data loss. | <5s |
| Admin dashboard blank | Reload the browser tab. Confirm `?api=http://localhost:8100` query param present. | <5s |
| Mobile app freezes | Force-close, reopen. AsyncStorage retains the session token. | <10s |
| Both phones unreachable via LAN | Check WiFi network. Worst case: switch to recording backup. | <30s |

---

## Post-demo (T+0)

- [ ] **Stop Cloudflared tunnel immediately** — Ctrl+C in the tunnel terminal. The tunnel URL becomes unreachable.
- [ ] **Stop backend** — Ctrl+C in the uvicorn terminal.
- [ ] **Stop admin static server** — Ctrl+C in the `python -m http.server` terminal.
- [ ] **Do NOT share the tunnel URL** with anyone outside the team after demo. Even though it's stopped, log scrubbers may have captured it.
- [ ] **Take screenshots** of the admin dashboard final state for the post-demo deck.
- [ ] **Save the recording** if used — useful for the post-demo Q&A session.

---

## What's running on the laptop during demo

Three terminal windows minimum:

1. **Backend** — `uvicorn app.main:app --host 0.0.0.0 --port 8100`
2. **Admin static server** — `python -m http.server 5173 --bind 127.0.0.1`
3. **Cloudflared tunnel** — `cloudflared tunnel --config ~/.cloudflared/config.yml run`

Plus one browser window with the admin dashboard, one with the Squad sandbox.

If the laptop screen is being mirrored to the demo display, hide the terminal windows behind the browser. Judges should see the dashboard + mobile-mirror, not the engineering plumbing.
