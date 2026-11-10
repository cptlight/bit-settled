# Configure r/bit_settled safely

You created the community; this pack configures it without sharing your password.

## 1. Do not paste credentials in chat

Create a Reddit **script app** at https://www.reddit.com/prefs/apps and a token with only the scopes needed:

- `read`
- `submit`
- `modconfig`
- `wikiedit`

Do **not** share your Reddit password, client secret, or refresh token in the conversation. Put them in a local `.env` file or shell environment, run the script locally, then delete the token file.

## 1b. App creation fields

When Reddit asks for the app details, use:

| Field | Value |
|---|---|
| **Name** | `bit-settled setup` |
| **Type** | **script** |
| **About URL** | `https://github.com/cptlight/bit-settled` (or `https://cptlight-bit-settled.hf.space/board.html`) |
| **Redirect URI** | `http://localhost:8080/reddit-callback` |

The redirect URI must be **exactly** what you later put in the OAuth authorization request. Nothing needs to be listening on that port: after Reddit redirects, the browser will show a connection error but the address bar contains the `code` parameter you need.

Do not use a public production URL as the redirect URI unless you actually implement that callback.

## 2. Create a refresh token

Use a local OAuth helper or the Reddit OAuth flow to obtain a **refresh token** for your own account. Store it only in an environment variable:

```bash
export REDDIT_CLIENT_ID=...
export REDDIT_CLIENT_SECRET=...
export REDDIT_REFRESH_TOKEN=...
export REDDIT_USER_AGENT="bit-settled-setup/1.0 by u/<your-username>"
export REDDIT_SUBREDDIT=bit_settled
```

## 3. Dry run

```bash
REDDIT_DRY_RUN=1 node scripts/setup-reddit-community.js
```

This prints every API call it would make; it does not change Reddit.

## 4. Apply

```bash
REDDIT_APPLY=1 node scripts/setup-reddit-community.js
```

The script:

- updates the community title, public description and sidebar description
- creates/updates the wiki pages `start`, `agents`, `rules`
- publishes the seed posts from `reddit/r_bit_settled/seed-posts.md` (only if `REDDIT_SEED=1`)

It does **not** automate votes, DMs, moderation actions, or user activity.

## 5. Manual steps after the script

Reddit’s API for rules and flairs changes more often; set these in Mod Tools:

- Rules: paste `reddit/r_bit_settled/rules.txt`
- Flairs: paste `reddit/r_bit_settled/flairs.txt`
- AutoModerator: paste `reddit/r_bit_settled/automoderator.yml` into `/wiki/config/automoderator`
- Add a second human moderator
- Set icon/banner and “Topics”
- Pin the `wiki/start` post

## 6. What I can do for you

If you put the **refresh token in your local environment**, I can:
- run the dry run,
- inspect failures,
- tailor the content pack and bot payload.

I will not ask you to paste the secret into chat, and I will not create a new Reddit account or bypass Reddit moderation.
