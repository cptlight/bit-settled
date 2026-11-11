#!/usr/bin/env bash
set -euo pipefail
# Flip a self-hosted .env from sandbox to live PayPal.
# Run only after the PayPal business app is approved and KYC is complete.

if [ ! -f .env ]; then
  echo "No .env. Copy .env.example first." >&2
  exit 1
fi
set -a
# shellcheck disable=SC1091
. ./.env
set +a

if [ -z "${PAYPAL_CLIENT_ID:-}" ] || [ -z "${PAYPAL_CLIENT_SECRET:-}" ]; then
  echo "Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env first." >&2
  exit 1
fi
if [ -z "${PUBLIC_SITE_URL:-}" ] || [ -z "${PUBLIC_BASE_URL:-}" ]; then
  echo "Set PUBLIC_SITE_URL and PUBLIC_BASE_URL to the public HTTPS URL." >&2
  exit 1
fi

cp .env ".env.sandbox.$(date +%Y%m%d%H%M%S)"
python3 - <<'PY'
from pathlib import Path
p=Path('.env'); lines=p.read_text().splitlines()
want={'PAYPAL_LIVE':'1','PAYPAL_ENV':'live'}
out=[]; seen=set()
for line in lines:
    k=line.split('=',1)[0] if '=' in line else ''
    if k in want:
        out.append(f"{k}={want[k]}"); seen.add(k)
    else:
        out.append(line)
for k,v in want.items():
    if k not in seen: out.append(f"{k}={v}")
p.write_text('\n'.join(out)+'\n')
PY
echo "Live PayPal flags written. Restarting containers…"
docker compose up -d --build
echo "Done. Verify /api/instance and /api/config before taking real payments."
