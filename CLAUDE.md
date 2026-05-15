# EchoPay Cash — Engineering Rules

This file is read by Claude Code sessions working in this repo. Both team members (Leke and Funbi) run CC against echopay-cash/ in parallel.

## Repo scope
- Working directory: echopay-cash/ (this folder)
- This is a public GitHub repo: github.com/AdelekeAP/echopay-cash
- Do NOT modify anything outside echopay-cash/
- The outer echo-pay repo, demo-bank/, backend/, .claude/ are READ-ONLY

## Coordination
- Two engineers work in parallel. Both full-stack capable.
- Mobile work: echopay-cash/mobile/**
- Backend work: echopay-cash/backend/**
- Admin dashboard: echopay-cash/admin/**
- Spike code: echopay-cash/spike/** (deleted post-demo)
- Before editing a file, pull origin main. Commit often, push to feature branches.
- API contract source of truth: EchoPay_Cash_PRD.md §6
- DB schema source of truth: EchoPay_Cash_PRD.md §5

## Branching and PRs

Direct pushes to main are NOT allowed after Phase 0. Every feature, fix, or scoped change goes through:

1. Create a feature branch from main:
   git checkout main && git pull origin main
   git checkout -b feat/<scope>-<thing>

   Naming convention:
   - feat/mobile-voice-signup, feat/mobile-receive-qr, feat/mobile-scan
   - feat/backend-squad-client, feat/backend-permits, feat/backend-webhooks
   - feat/admin-dashboard
   - fix/<bug-summary>

2. Commit frequently with descriptive messages. Each commit message describes WHAT changed, not who/what wrote it. No Co-Authored-By trailers. No "Generated with Claude Code" footers.

3. Push the branch:
   git push -u origin feat/<scope>-<thing>

4. Open a PR to main on GitHub with:
   - A 2-3 sentence description of what the branch does
   - A "Test plan" section with 1-3 manual steps to verify (e.g. "1. Open Receive screen 2. Say 'generate ₦200 QR' 3. QR renders with correct payload")
   - Link to the PRD section if relevant

5. Self-merge after a 30-second visual self-review. The other team member is welcome to glance but review is NOT required (28-hour sprint, friction > value).

6. Delete the branch after merge.

7. Push back to feature-branch discipline: NEVER push directly to main again after Phase 0.

## CI workflow

A GitHub Actions workflow runs on every push to main and on every PR. Defined at .github/workflows/check.yml. It runs:

- mobile-typecheck: cd mobile && npm ci && npm run typecheck
- backend-syntax: cd backend && pip install -r requirements.txt && python -m py_compile $(find app -name "*.py")

If either job fails, the PR shows a red ❌. Do NOT merge a PR with a red CI status without explaining in the PR description why it's acceptable (rare cases: CI infrastructure issue, etc.).

Backend job only runs when echopay-cash/backend/ exists with a requirements.txt. Until then, the backend job will skip via path filtering.

## Architecture invariants (the law)
- All monetary amounts stored as integers in kobo (₦1 = 100 kobo)
- transactions.idempotency_key is UNIQUE — every write enforces this
- Permits transition outstanding → (redeemed | expired) monotonically
- (sender_user_id, nonce) is UNIQUE forever — replay protection
- All Squad webhooks return HTTP 200 even on signature failure (log + alert internally)
- HMAC computed over raw request bytes, never over re-parsed JSON
- All Squad calls go through ONE client (services/squad/client.py on backend)
- Account Lookup precedes every Transfer
- 424 on Transfer = poll /payout/requery, never retry the Transfer with same ref

## Squad config
- Base URL: https://sandbox-api-d.squadco.com (sandbox only — production URL never appears in this repo)
- All amounts in API calls: kobo as integers

## Honesty rules for Q&A defense
- We do NOT claim cross-bank-offline (NIBSS interbank is synchronous)
- We disclose voice infrastructure as team capability (EchoPay v1, EchoMind) — see README
- All Squad integration, the closed-loop ledger, the permit-based offline mechanic, the QR flow, and the admin dashboard were built specifically for this hackathon

## Mobile architecture (echopay-cash/mobile/)
- 5-layer separation: app/ (screens) → hooks/ (logic) → services/ (I/O) → types/ → utils/
- Screens never call services directly — they use hooks
- Hooks never render UI
- Services never know about React
- See docs/ARCHITECTURE.md

## Backend architecture (echopay-cash/backend/)
- FastAPI + SQLAlchemy + SQLite on :8100
- 4-layer: api/ (routes) → services/ (business logic) → models/ (SQLAlchemy) + schemas/ (Pydantic)
- See backend/README.md when scaffolded

## Voice services
- The voice stack (Whisper, intent extraction, ECAPA-TDNN biometric) is reused as an HTTP dependency from our team's existing infrastructure on :8000
- NOT committed to this repo
- Backend calls voice services via httpx — never as file imports
- This separation is documented in docs/ARCHITECTURE.md so judges understand the boundary

## Commit attribution rules
- Do NOT add "Co-Authored-By: Claude" trailers to commits
- Do NOT add "🤖 Generated with Claude Code" or similar to commit messages
- Do NOT add Claude as a collaborator on any commit
- Commits are authored by the human running the CC session (Leke or Funbi)
- Commit messages describe what changed, not who/what generated the change

## Things NOT to do
- Do not install M2 deps (tweetnacl, etc.) unless explicitly told
- Do not add ESLint, Prettier, Husky, or other tooling layers
- Do not use --legacy-peer-deps or --force on npm install
- Do not modify the existing voice components at components/ root (legacy, untouched)
- Do not call production Squad endpoints anywhere in this repo

## Legacy voice files (pre-existing, untouched)
The following files are excluded from `tsc --noEmit` because they predate strict-mode TypeScript and were written for an older Skia API and pre-Node-Timeout-types React Native typings. They function correctly at runtime.

- components/EchoOrb.tsx
- components/VoiceModal.tsx
- components/VoiceVerificationModal.tsx
- components/Waveform.tsx
- components/FloatingMicButton.tsx
- hooks/useVoiceRecording.ts
- hooks/useWakeWord.ts

Do NOT modify these. Phase 1+ work that needs to call into them should wrap them in new typed components under components/voice/ rather than refactoring the originals. Migration to strict TS is post-hackathon work.
