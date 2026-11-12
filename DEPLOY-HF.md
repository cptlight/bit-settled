# Persistent free demo on Hugging Face Spaces

The Space runs a **live PayPal sandbox + live AI** demo. Keys are Space secrets; PayPal is sandbox only; no real money moves. It stays within HF's free CPU tier (2 vCPU / 16 GB) and can be kept warm for judging.

## One-time setup

1. Create a **write** token: https://huggingface.co/settings/tokens
2. In GitHub → **Settings → Secrets and variables → Actions**:
   - Secret **`HF_TOKEN`** = the token
   - Variable **`HF_USER`** = your Hugging Face username (default fallback: `cptlight`)
3. Run **Actions → Deploy Hugging Face Space → Run workflow**.
4. Copy the Space URL:
   - Page: `https://huggingface.co/spaces/<user>/bit-settled`
   - Direct: `https://<user>-bit-settled.hf.space`
5. Add repository variable **`HF_SPACE_URL`** = the direct URL. The keepalive workflow pings `/api/health` every 6 hours.

Or run locally:

```bash
HF_TOKEN=hf_xxx HF_USER=<your-hf-user> ./deploy/huggingface/deploy.sh
```

## Space secrets (live mode)

Set these in **Space → Settings → Variables and secrets** (or via the HF API):

| Secret | Value |
|---|---|
| `PAYPAL_LIVE` | `1` |
| `PAYPAL_CLIENT_ID` | PayPal sandbox client ID |
| `PAYPAL_CLIENT_SECRET` | PayPal sandbox secret |
| `PAYPAL_ENV` | `sandbox` |
| `AI_PROVIDER` | `openai` |
| `AI_API_KEY` | model API key |
| `AI_MODEL` | `gpt-oss:20b` |
| `AI_BASE_URL` | `https://ollama.com/v1` |
| `AI_TIMEOUT_MS` | `30000` |
| `PUBLIC_BASE_URL` | `https://<user>-bit-settled.hf.space` |

Never put these in the Dockerfile or repo. The Space is public and sandbox-only; rotate keys after judging.

## Keeping it live for judging

- HF **free CPU-basic** sleeps after **48 hours of inactivity**. A judge opening the URL wakes it; this is fine for a link, but not “always warm”.
- The included keepalive workflow pings every 6 hours (GitHub cron can be delayed, but far below 48 h).
- If your **HF Pro** plan includes upgraded Space hardware, set sleep time to `-1` (never sleep) in Space settings, or call:
  `POST https://huggingface.co/api/spaces/<user>/bit-settled/sleeptime` with `{"seconds": -1}`.
  CPU-basic does not allow a custom sleep time.
- The Space is public and runs in **PayPal sandbox**; keys are Space secrets and never reach the frontend. Do not use production credentials.

## What gets deployed

- `deploy/huggingface/Dockerfile` clones the public GitHub repo at build time.
- `deploy/huggingface/README.md` is the Space card.
- `deploy/huggingface/deploy.sh` creates/updates the Space through the HF API and pushes the two files.
- The app listens on `PORT=7860` and `HOST=0.0.0.0`.

## After deploy

- Test `/start.html`, `/demo.html`, `/api/health`, `/api/config` (must say `mode:"sim"`).
- Put the direct URL in the private submission package.
- If the Space build fails, open the Space **Logs** tab; the Dockerfile needs outbound GitHub access during build.
