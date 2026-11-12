#!/usr/bin/env bash
set -euo pipefail
# Fill the submission artifacts after deploy + video.
# Usage:
#   ./scripts/finalize-submission.sh https://you-bit-settled.hf.space https://youtu.be/xxxx
URL="${1:?first argument: hosted demo URL}"
VIDEO="${2:?second argument: YouTube URL}"
cd "$(dirname "$0")/.."
python3 - "$URL" "$VIDEO" <<'PY'
import sys
url, video = sys.argv[1], sys.argv[2]
for p in ['DEVPOST.md']:
    s=open(p,encoding='utf-8').read()
    s=s.replace('HOSTED_DEMO_URL', url).replace('VIDEO_URL_HERE', video).replace('VIDEO_URL', video)
    open(p,'w',encoding='utf-8').write(s)
print('filled', url, video)
PY
