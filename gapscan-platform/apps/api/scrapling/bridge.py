"""GapScan's bridge to Scrapling (https://github.com/D4Vinci/Scrapling, BSD-3-Clause).

Reads one JSON request per line on stdin: {"id": ..., "url": ...} or {"check": true}.
Writes one JSON answer per line on stdout: {"id", "status", "url", "contentType", "body" (base64)}
or {"id", "error"}. It only fetches the URLs GapScan sends, always through GapScan's egress
proxy (argv[1]), which connects only to vetted public addresses on port 443. It never follows
anything a page asks for and never runs page scripts: this is Scrapling's HTTP fetcher.
"""
import base64
import json
import sys

PROXY = sys.argv[1] if len(sys.argv) > 1 else None
TIMEOUT = int(sys.argv[2]) if len(sys.argv) > 2 else 30
MAX_BYTES = int(sys.argv[3]) if len(sys.argv) > 3 else 4_000_000


def answer(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


try:
    from scrapling.fetchers import Fetcher
except Exception as error:  # Scrapling or its fetcher extras are not installed
    for line in sys.stdin:
        answer({"id": json.loads(line).get("id"), "error": f"Scrapling is not available: {error}"})
    sys.exit(0)

for line in sys.stdin:
    request = json.loads(line)
    if request.get("check"):
        answer({"id": request.get("id"), "ok": True})
        continue
    try:
        page = Fetcher.get(request["url"], proxy=PROXY, timeout=TIMEOUT, retries=2, follow_redirects="safe", stealthy_headers=True)
        body = bytes(page.body or b"")[:MAX_BYTES]
        headers = getattr(page, "headers", None) or {}
        content_type = next((v for k, v in dict(headers).items() if str(k).lower() == "content-type"), "")
        answer({"id": request.get("id"), "status": page.status, "url": str(getattr(page, "url", None) or request["url"]),
                "contentType": str(content_type), "body": base64.b64encode(body).decode("ascii")})
    except Exception as error:
        answer({"id": request.get("id"), "error": str(error)[:300]})
