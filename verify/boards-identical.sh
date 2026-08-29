#!/bin/sh
# The two scoreboards are one codebase. Their scorer, ranking and stats helpers must be
# byte-identical; only the tick grid (TICK) and the Max Adverse evidence policy
# (MA_REQUIRED) may differ, and both are single named constants.
#
# This exists because the shared code silently diverged twice in one session: once when
# `RV` was left reading a flat row on crypto while futures nested under `t.r`, and once
# when an over-greedy regex deleted nine functions from one board and not the other.
# Neither was visible from the endpoints — only from rendering the board.
set -e
cd "$(dirname "$0")/.."
fail=0
check() {   # check <label> <python-regex capturing the block>
  python3 - "$1" "$2" <<'PY' || fail=1
import re,sys
lab,pat=sys.argv[1],sys.argv[2]
b={f:(re.search(pat,open(f).read(),re.S|re.M) or [None]) for f in ('v4-futures.html','v3-grant.html')}
if any(m is None or m[0] is None for m in b.values()):
    print(f"MISSING {lab}"); raise SystemExit(1)
a,c=[b[f].group(0) for f in ('v4-futures.html','v3-grant.html')]
if a==c: print(f"ok    {lab}  ({a.count(chr(10))+1} lines, identical)"); raise SystemExit(0)
print(f"DRIFT {lab}")
import difflib
for l in list(difflib.unified_diff(a.splitlines(),c.splitlines(),'futures','crypto',lineterm=''))[:20]: print("  "+l)
raise SystemExit(1)
PY
}
check "marioR scorer"  '^function marioR\(row\)\{.*?\n\}'
check "rankKey"        '^const rankKey = .*?;$'
check "rankRows"       '^function rankRows\(rows, pool\)\{.*?\n\}'
check "stats helpers"  '^function seriesFor.*?\n^function paired.*?\n\}'
python3 - <<'PY' || fail=1
import re
d=lambda x: re.sub(r'\\u([0-9a-fA-F]{4})', lambda m: chr(int(m.group(1),16)), x)
F,C=open('v4-futures.html').read(),open('v3-grant.html').read()
f={k:d(v) for k,v in re.findall(r"\{k:'(m_[a-z0-9]+)',label:'([^']+)'",F)}
c={k:d(v) for k,v in re.findall(r"\{key:'(m_[a-z0-9]+)',[^}]*?name:'([^']+)'",C,re.S)}
bad=[k for k in set(f)|set(c) if f.get(k)!=c.get(k)]
print(f"ok    method table ({len(f)} methods, labels match)" if not bad
      else "DRIFT method table: "+", ".join(f"{k}: {f.get(k)!r} vs {c.get(k)!r}" for k in bad))
gap=0
for name,src in (('futures',F),('crypto',C)):
    info=set(re.findall(r'^  (m_[a-z0-9]+):', re.search(r'^const METHOD_INFO=\{.*?\n\};',src,re.S|re.M).group(0), re.M))
    meth=set(re.findall(r"\{k(?:ey)?:'(m_[a-z0-9]+)'",src))
    if meth-info: print(f"GAP   {name} METHOD_INFO has no copy for: {sorted(meth-info)}"); gap=1
if not gap: print("ok    METHOD_INFO covers every method on both boards")
raise SystemExit(1 if (bad or gap) else 0)
PY
[ "$fail" = 0 ] && echo "boards are one codebase" || { echo "BOARDS HAVE DRIFTED"; exit 1; }
