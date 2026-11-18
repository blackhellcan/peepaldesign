#!/usr/bin/env bash
# Publish the Peepal Design site to here.now.
#
# Ships every root-level .html plus assets/. PRODUCT.md, DESIGN.md, .gitignore,
# .claude/ and .herenow/ are never staged, so none of them reach the public URL.
#
# Stages a clean copy first: publish.sh uploads every file it is given except
# .DS_Store, so pointing it at the repo root would serve PRODUCT.md, DESIGN.md,
# .gitignore and .claude/ from the public URL.
#
#   ./deploy.sh              # update the existing site
#   ./deploy.sh --new        # publish to a fresh slug instead
#   ./deploy.sh --dry-run    # show what would be uploaded, publish nothing
#
# Extra flags are passed through to publish.sh, e.g:
#   ./deploy.sh --ttl 604800

set -euo pipefail

SLUG="${HERENOW_SLUG:-wistful-quasar-q38v}"
PUBLISH="$HOME/.agents/skills/here-now/scripts/publish.sh"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Everything the site needs. Anything not listed here never reaches the web.
# Globbed rather than listed: the site went from one page to eleven and a
# hand-kept list silently fell behind, so every root-level .html ships.
# Documentation and config stay out because they are not .html at the root.
INCLUDE=(assets info)   # info/ holds the one-pager, served at /info/
while IFS= read -r page; do INCLUDE+=("$page"); done < <(cd "$(dirname "${BASH_SOURCE[0]}")" && ls -1 *.html)

# Dropped from the staged copy even though they live under an included path.
PRUNE=(
  assets/img/work/_source
  assets/img/services/_source
  assets/img/work/bg.png     # 9.7MB, unreferenced — delete this line if you wire it up
  assets/img/voices          # the six testimonial portraits, unreferenced since the
                             # photographs came out of that section on 2026-08-12
)
# Internal notes, dropped wholesale. These READMEs carry candid provenance —
# which images are stock, what must be replaced before launch, which files are
# still missing — and every one of them was being served from the public URL.
PRUNE_GLOB=('*/README.md')

[[ -x "$PUBLISH" ]] || { echo "error: publish.sh not found at $PUBLISH" >&2; exit 1; }

NEW=0
DRY=0
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --new) NEW=1 ;;
    --dry-run) DRY=1 ;;
    *) ARGS+=("$arg") ;;
  esac
done

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

for item in "${INCLUDE[@]}"; do
  [[ -e "$ROOT/$item" ]] || { echo "error: missing $item" >&2; exit 1; }
  cp -R "$ROOT/$item" "$STAGE/"
done

for p in "${PRUNE[@]}"; do
  rm -rf "${STAGE:?}/$p"
done
for g in "${PRUNE_GLOB[@]}"; do
  find "${STAGE:?}" -path "$g" -delete
done
find "$STAGE" -name '.DS_Store' -delete

# Fail loudly rather than shipping a page with dead references. Checks every
# staged page, not just index.html — and strips the #fragment as well as the
# ?query, which it did not before: "index.html#contact" was being looked up as a
# filename, so a correct link was reported as a missing file on every run.
missing=0
warned=0
for page in "$STAGE"/*.html; do
  # Sources on a tag that also carries onerror= are deliberate: the image swaps
  # itself out when the file is absent, which is how the unshot case studies and
  # the logomark degrade. Those are reported but do not block a publish.
  # || true is load-bearing: the script runs under `set -e`, and grep exits 1 on
  # a page with no onerror at all, which killed the whole publish silently.
  # Newlines are folded first: these <img> tags wrap over three lines, so a
  # line-based grep never sees src= and onerror= together and every guarded
  # reference came back looking unguarded.
  # || true is load-bearing too — grep exits 1 on a page with no onerror at all,
  # and under `set -e` that killed the whole publish silently.
  guarded="$(tr '\n' ' ' < "$page" | grep -oE '<[^>]*onerror=[^>]*>' \
               | grep -oE 'src="[^"]*"' | sed 's/src="//;s/"//;s/?.*//' | sort -u || true)"
  while read -r ref; do
    [[ -n "$ref" ]] || continue
    [[ -f "$STAGE/$ref" ]] && continue
    if grep -qxF "$ref" <<<"$guarded"; then
      echo "note:  $(basename "$page") -> $ref absent, falls back via onerror"
      warned=$((warned + 1))
    else
      echo "error: $(basename "$page") references missing $ref" >&2
      missing=1
    fi
  done < <(grep -oE '(src|href)="[^"]*"' "$page" \
             | sed 's/.*="//;s/"//;s/?.*//;s/#.*//' \
             | grep -vE '^(https?:|//|mailto:|tel:|data:)' \
             | grep -v '^$' \
             | sort -u)
done
[[ "$warned" -eq 0 ]] || echo "$warned reference(s) rely on an onerror fallback"
[[ "$missing" -eq 0 ]] || exit 1

echo "staged $(find "$STAGE" -type f | wc -l | tr -d ' ') files ($(du -sh "$STAGE" | cut -f1))"

if [[ "$DRY" -eq 1 ]]; then
  (cd "$STAGE" && find . -type f | sed 's|^\./||' | sort)
  echo "(dry run - nothing published)"
  exit 0
fi

# publish.sh resolves the anonymous claim token from ./.herenow/state.json,
# so run from the repo root no matter where this was invoked.
cd "$ROOT"

if [[ "$NEW" -eq 1 ]]; then
  "$PUBLISH" "$STAGE" --client claude-code "${ARGS[@]+"${ARGS[@]}"}"
  exit
fi

# A successful update rewrites .herenow/state.json WITHOUT the claimToken the
# create step stored, so the next anonymous update would 401. Keep our own copy
# and pass it explicitly. Not needed once the site is claimed to an account.
TOKEN_ARGS=()
if [[ -s "$ROOT/.herenow/claim-token" ]]; then
  TOKEN_ARGS=(--claim-token "$(tr -d '[:space:]' < "$ROOT/.herenow/claim-token")")
fi

"$PUBLISH" "$STAGE" --slug "$SLUG" --client claude-code \
  "${TOKEN_ARGS[@]+"${TOKEN_ARGS[@]}"}" "${ARGS[@]+"${ARGS[@]}"}"
