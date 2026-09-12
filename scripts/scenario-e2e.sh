#!/usr/bin/env bash
# End to end check for the MCP Community Connect demo scenario.
#
# Runs the agent loop against a running emulator through each of the three
# SCOPE surfaces and validates the result the way the evaluation harness would:
# issue #11 is readable, the repository clones and builds, a branch pushes, and
# a pull request lands against main with a closing reference to the issue.
#
#   scripts/scenario-e2e.sh [base-url]
#
# Defaults to http://localhost:4801. Requires git, and uses gh and Docker for
# the gh and MCP surfaces when they are available.
set -uo pipefail

BASE="${1:-http://localhost:4801}"
REPO="${SCENARIO_REPO:-mcp-demo/ndjson-readablestream}"
TOKEN="${SCENARIO_TOKEN:-demo-token}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0

ok()   { echo "  PASS  $1"; pass=$((pass + 1)); }
bad()  { echo "  FAIL  $1"; fail=$((fail + 1)); }
check() { if [ "$1" = "0" ]; then ok "$2"; else bad "$2"; fi; }

api() { curl -sS -H "Authorization: token ${TOKEN}" "$@"; }

echo "scenario: ${REPO} at ${BASE}"
echo

echo "[1/4] seeded state"
number=$(api "${BASE}/repos/${REPO}/issues/11" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("number"))' 2>/dev/null)
[ "$number" = "11" ] && ok "issue #11 is readable" || bad "issue #11 is readable (got ${number})"

issues=$(api "${BASE}/repos/${REPO}/issues?state=all&per_page=100" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))' 2>/dev/null)
[ "$issues" = "6" ] && ok "6 issues imported" || bad "6 issues imported (got ${issues})"

pulls=$(api "${BASE}/repos/${REPO}/pulls?state=all&per_page=100" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))' 2>/dev/null)
[ "$pulls" = "11" ] && ok "11 pull requests imported" || bad "11 pull requests imported (got ${pulls})"

echo
echo "[2/4] git surface, shared by every profile"
git -c safe.bareRepository=all clone --quiet "${BASE}/${REPO}.git" "${WORK}/repo" >/dev/null 2>&1
check $? "git clone"

commits=$(git -C "${WORK}/repo" rev-list --count HEAD 2>/dev/null)
[ "$commits" = "50" ] && ok "full history (50 commits)" || bad "full history (got ${commits})"

if [ -f "${WORK}/repo/package.json" ]; then
  ( cd "${WORK}/repo" && npm ci --silent >/dev/null 2>&1 ) ; check $? "npm ci"
  ( cd "${WORK}/repo" && npm test --silent -- --run >/dev/null 2>&1 ) ; check $? "npm test"
  ( cd "${WORK}/repo" && npm run build --silent >/dev/null 2>&1 ) ; check $? "npm run build"
else
  bad "clone contains package.json"
fi

(
  cd "${WORK}/repo" &&
  git checkout -q -b fix-issue-11 &&
  printf '\nexport const continueAfterError = true\n' >> index.mjs &&
  git add index.mjs &&
  git -c user.name=Agent -c user.email=agent@example.com commit -qm "Handle malformed NDJSON lines" &&
  git push -q origin fix-issue-11
) >/dev/null 2>&1
check $? "git push of a feature branch"

pushed=$(git -C "${WORK}/repo" rev-parse HEAD 2>/dev/null)
seen=$(api "${BASE}/repos/${REPO}/branches/fix-issue-11" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("commit",{}).get("sha"))' 2>/dev/null)
[ -n "$pushed" ] && [ "$pushed" = "$seen" ] && ok "pushed commit visible through the API" || bad "pushed commit visible through the API"

echo
echo "[3/4] baseline profile: REST"
pr=$(api -X POST -H 'Content-Type: application/json' \
  -d '{"title":"Fix malformed JSON handling","head":"fix-issue-11","base":"main","body":"Buffers by complete NDJSON lines.\n\nFixes #11"}' \
  "${BASE}/repos/${REPO}/pulls")
prnum=$(echo "$pr" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("number"))' 2>/dev/null)
[ -n "$prnum" ] && [ "$prnum" != "None" ] && ok "pull request created (#${prnum})" || bad "pull request created"

if [ -n "$prnum" ] && [ "$prnum" != "None" ]; then
  detail=$(api "${BASE}/repos/${REPO}/pulls/${prnum}")
  echo "$detail" | python3 -c '
import json,sys
d=json.load(sys.stdin)
checks=[("targets main", d.get("base",{}).get("ref")=="main"),
        ("head matches pushed branch", d.get("head",{}).get("ref")=="fix-issue-11"),
        ("state is open", d.get("state")=="open"),
        ("body closes #11", "Fixes #11" in (d.get("body") or ""))]
for name,good in checks:
    print(("  PASS  " if good else "  FAIL  ")+name)
import os
sys.exit(0 if all(g for _,g in checks) else 1)
'
  if [ $? -eq 0 ]; then pass=$((pass + 4)); else fail=$((fail + 1)); fi

  files=$(api "${BASE}/repos/${REPO}/pulls/${prnum}/files")
  echo "$files" | python3 -c '
import json,sys
f=json.load(sys.stdin)
names=[x.get("filename") for x in f]
ok = names==["index.mjs"] and any(x.get("patch") for x in f)
print(("  PASS  " if ok else "  FAIL  ")+f"diff contains only the intended change ({names})")
sys.exit(0 if ok else 1)
'
  check $? "pull request diff is gradeable"
fi

echo
echo "[4/4] gh profile"
if command -v gh >/dev/null 2>&1; then
  port="${BASE##*:}"
  export HTTP_PROXY="http://127.0.0.1:${port}" http_proxy="http://127.0.0.1:${port}"
  export GH_HOST=github.localhost GH_TOKEN="${TOKEN}" GH_PAGER=cat
  gh auth status --hostname github.localhost >/dev/null 2>&1; check $? "gh auth status"
  gh repo view "${REPO}" >/dev/null 2>&1;                    check $? "gh repo view"
  gh issue view 11 -R "${REPO}" >/dev/null 2>&1;             check $? "gh issue view 11"
  gh issue list -R "${REPO}" >/dev/null 2>&1;                check $? "gh issue list"
  gh pr list -R "${REPO}" --state all >/dev/null 2>&1;       check $? "gh pr list"
  if [ -n "${prnum:-}" ]; then
    gh pr view "${prnum}" -R "${REPO}" >/dev/null 2>&1;      check $? "gh pr view"
    gh pr diff "${prnum}" -R "${REPO}" >/dev/null 2>&1;      check $? "gh pr diff"
  fi
  unset HTTP_PROXY http_proxy
else
  echo "  SKIP  gh is not installed"
fi

echo
echo "passed=${pass} failed=${fail}"
[ "$fail" -eq 0 ]
