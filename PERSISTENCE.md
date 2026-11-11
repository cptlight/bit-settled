# Persistence with the least database possible

## Currently configured

- Private bucket: `cptlight/bit-settled-state`
- Mounted into the Space at `/data` (read-write)
- Secret: `STATE_PATH=/data/settled-state.json`
- Snapshot file: `/data/settled-state.json`
- Verified across a full Space restart: a test offer survived, then was archived and removed from the active board.

## Recommendation

For the current bitsettled board: **no database — a private Hugging Face Storage Bucket with a debounced JSON snapshot.**

It gives durable board state, accounts, bids, deals, stale timestamps and archive flags without running a database.

## Why HF Storage Buckets

Hugging Face Spaces local disk is **ephemeral** — it is lost when the Space restarts or is rebuilt. HF Storage Buckets can be attached to a Space as a read-write volume at a path like `/data`; the bucket survives restarts.

- [Spaces storage](https://huggingface.co/docs/hub/spaces-storage)
- [Storage Buckets](https://huggingface.co/docs/hub/storage-buckets)

Storage Buckets are object/file storage, **not a relational database**. There is no managed SQL database for Spaces. Do not use a Dataset repo as a hot database; it is Git/LFS-backed and slow for frequent writes.

## Setup

1. Create a **private** bucket:
   ```text
   cptlight/bit-settled-state
   ```
2. Open the Space settings for `cptlight/bit-settled`.
3. Attach the bucket as a volume:
   - mount path: `/data`
   - mode: read-write
4. Add a Space secret:
   ```text
   STATE_PATH=/data/settled-state.json
   ```
5. Restart the Space.

No other environment variable is required.

## How the code works

- On boot, `lib/persist.js` reads `STATE_PATH` if it exists.
- After successful API mutations, the server schedules a debounced snapshot.
- Snapshot writes are atomic: write `.tmp`, then rename.
- Seed data is only created if the state is empty.
- The JSON contains accounts, offers/wants, messages, votes, deals, escrow states, archive/stale timestamps and fee request tokens.

This is a **single-replica, last-write-wins snapshot**. It is appropriate for a demo/early board.

## When to add a database

Use SQLite or a hosted SQL database when you need:

- multiple Space replicas / concurrent writers
- transactions and row-level updates
- search/query performance at scale
- audit history beyond one snapshot
- safer per-record writes without rewriting the whole state

Options, least to most operationally heavy:

1. **SQLite file on the mounted volume** — one replica only. Node 22 has `node:sqlite` (experimental); or use `better-sqlite3`. Verify the mounted filesystem supports SQLite locking.
2. **Turso / libSQL** — hosted SQLite over HTTP; fits the current Node app.
3. **Cloudflare D1** — strong fit since bitsettled.com already uses Cloudflare; requires a small Worker API layer.
4. **Neon/Supabase Postgres** — for multi-tenant production.

## Tradeoffs

| Approach | DB needed | Multi-replica | Writes | Effort |
|---|---|---|---|---|
| HF bucket + JSON snapshot | No | No | debounced whole-state | Very low |
| SQLite on volume | Yes, one file | No | transactional | Low |
| Turso/libSQL | Hosted | Yes | SQL | Medium |
| Cloudflare D1 | Hosted | Yes | SQL | Medium |
| Postgres | Hosted | Yes | SQL | Medium–high |

## What I need to enable the bucket path

- Create the private bucket and attach it to the Space at `/data`.
- Tell me the bucket name and confirm the mount.
- Then set `STATE_PATH=/data/settled-state.json`.

The code is already in `lib/persist.js`; without `STATE_PATH` it is a no-op, so tests and local runs remain unchanged.
