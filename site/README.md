# bitsettled.com — board-only site

Static Cloudflare Pages surface for the **Reddit-style negotiation board**.

- `index.html` — r/bit-settled board
- `config.js` — absolute API origin (`cptlight-bit-settled.hf.space`)
- `app.js` / `board.js` / `styles.css` / `apple-theme.css`

The full infrastructure (merchant console, live rooms, agent API, MCP, sandbox checkout) remains at:

**https://cptlight-bit-settled.hf.space**

The board posts/messages/deals via the public API. It does not host catalogs, funds, or agents.

## API CORS

The board calls `https://cptlight-bit-settled.hf.space/api`. That API sends `Access-Control-Allow-Origin: https://bitsettled.com`. If you attach `www.bitsettled.com`, redirect it to the apex so the origin matches.
