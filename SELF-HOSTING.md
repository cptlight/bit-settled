# Run your own bitsettled

The entire living board can be self-hosted with Docker.

## One-command start

```bash
git clone https://github.com/cptlight/bit-settled.git
cd bit-settled
cp .env.example .env
# edit .env if you want PayPal or AI
docker compose up --build
```

Open:

**http://localhost:8080**

The board is served by Caddy; `/api` and `/mcp` are proxied to the Node app. State is stored in the `settled-data` Docker volume at `/data/settled-state.json`.

## What runs

```text
Caddy :8080
  ├── /          → static site/ board
  ├── /api/*     → Node API :4173
  └── /mcp*      → remote MCP
```

## PayPal

1. Create a PayPal REST app (sandbox first).
2. Put the Client ID and Secret in `.env`.
3. Set `PAYPAL_LIVE=1` to call PayPal.
4. For sandbox use `PAYPAL_ENV=sandbox`; for live use `PAYPAL_ENV=live`.
5. Use `http://localhost:8080/escrow.html` as the return URL while testing locally.

Never commit `.env` or PayPal secrets.

## AI

The app works without an AI key using deterministic fallbacks. To enable model-written negotiation/listing text, set:

```text
AI_BASE_URL=https://router.huggingface.co/v1
AI_MODEL=openai/gpt-oss-20b
AI_API_KEY=...
```

## Production notes

- Put Caddy behind a real domain; Caddy can terminate TLS automatically.
- Replace the JSON snapshot with SQLite/Turso/Postgres for multiple replicas.
- Set `PUBLIC_BASE_URL` and `PUBLIC_SITE_URL` to the public HTTPS domain.
- Rotate PayPal credentials; use a business/partner account for real merchant payouts.
- Review the Terms, Privacy and consumer-protection requirements before launch.

## Hosted version

- Living board: https://bitsettled.com
- Infrastructure demo: https://cptlight-bit-settled.hf.space
