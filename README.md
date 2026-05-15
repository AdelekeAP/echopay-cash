# EchoPay Cash

Voice-first Squad-powered payment wallet for Nigeria's cash economy.
Built for GTCO Squad Hackathon 3.0, May 15–16 2026.

## Team

Adeleke Oluwasanmi (Leke), Funbi Onaeko, Kosi — Team Echo.

Our team has shipped voice AI infrastructure before with EchoPay v1 (voice banking)
and EchoMind (voice healthcare assistant). This repo contains the new product we built
for the GTCO Squad Hackathon 3.0: a Squad-powered wallet with voice signup, QR-based
inbound payments via Squad Dynamic Virtual Accounts, and a closed-loop ledger
architecture for offline-resilient payments between EchoPay users.

The voice stack (Whisper, intent extraction, ECAPA-TDNN biometric) is reused as an
HTTP dependency from our existing infrastructure. All Squad integration, the
permit-based offline ledger, the wallet, the QR mechanic, and the admin
reconciliation dashboard were built specifically for this hackathon.

## Run

_[Detailed clone-to-demo instructions will be added as the build progresses.]_

## License

MIT
