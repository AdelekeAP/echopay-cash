# Squad spike

Friday 18:00 gate. Throwaway after green.

```bash
cd echopay-cash/spike
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill SQUAD_SECRET_KEY from Squad sandbox dashboard

# Terminal 1: webhook listener
python squad_roundtrip.py listen

# Terminal 2: cloudflared tunnel
cloudflared tunnel --url http://localhost:9000
# Paste the public https://*.trycloudflare.com URL into Squad sandbox webhook config + /webhook suffix

# Terminal 3: drive it
python squad_roundtrip.py create-va --persona mama_risikat
# Note the va_number from output
python squad_roundtrip.py simulate --va <va_number> --amount-kobo 50000
# Watch Terminal 1 — should print "signature_valid: true"
python squad_roundtrip.py transfer --to 0123456789 --bank-code 058 --amount-kobo 10000
# On 424 the script auto-polls /payout/requery
```

**Green:** signature valid on at least one webhook, transfer reaches a terminal state.

**Save screenshots to `proof/`** before deleting this directory.
