# EchoPay Cash backend — FastAPI on :8100.
#
# Single-stage, slim, non-root. Pure-Python deps so no compiler toolchain
# is needed in the final image. SQLite + ed25519 server key persist via
# a /data volume mount (see docker-compose.yml).

FROM python:3.11-slim AS base

# Faster builds + smaller image + reproducible installs.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# curl is for the HEALTHCHECK below.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

# Run as an unprivileged user — defence-in-depth against container
# escapes. UID 10001 picked outside the host's default range.
RUN groupadd --system --gid 10001 echopay \
    && useradd --system --uid 10001 --gid 10001 --create-home echopay

WORKDIR /app

# Copy requirements first so layer cache survives source edits.
COPY --chown=echopay:echopay requirements.txt /app/requirements.txt
RUN pip install -r /app/requirements.txt

# Now the source. seed.py, alembic.ini etc. all needed at runtime.
COPY --chown=echopay:echopay . /app

# /data is the persistent volume:
#   /data/echopay.db                 — SQLite ledger
#   /data/server_ed25519.key         — server signing key (auto-generated
#                                      on first boot; never rotate without
#                                      re-pinning the mobile app pubkey)
RUN mkdir -p /data && chown echopay:echopay /data
VOLUME ["/data"]

ENV DATABASE_URL="sqlite:////data/echopay.db" \
    ECHOPAY_SERVER_KEY_PATH="/data/server_ed25519.key"

USER echopay

EXPOSE 8100

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8100/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8100"]
