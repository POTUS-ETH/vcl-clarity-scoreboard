#!/bin/sh
# The scoreboards are one codebase. The fib-era pair (v4 futures, v5 crypto) share the
# marioR scorer byte-for-byte; all three boards, V6 included, share the ranking and the
# stats helpers. Only TICK and MA_REQUIRED may differ on the fib-era pair, both single
# named constants. V6 has its own scorer (computeR — a typed structure stop, not a fib
# solve) which is pinned by verify/v6score.test.js instead.
#
# This exists because shared code silently diverged twice in one session: once when `RV`
# was left reading a flat row on crypto while futures nested under `t.r`, and once when an
# over-greedy regex deleted nine functions from one board and not the other. Neither was
# visible from the endpoints — only from rendering the board.
set -e
cd "$(dirname "$0")/.."
fail=0
check() {   # check <label> <python-regex capturing the block> <file> [file...]
  lab="$1"; pat="$2"; shift 2
  python3 - "$lab" "$pat" "$@" <<'PY' || fail=1
import re,sys
lab,pat,files=sys.argv[1],sys.argv[2],sys.argv[3:]
got={}
for f in files:
    m=re.search(pat,open(f).read(),re.S|re.M)
    if not m: print(f"MISSING {lab} in {f}"); raise SystemExit(1)
    got[f]=m.group(0)
ref=files[0]; bad=[f for f in files[1:] if got[f]!=got[ref]]
if not bad: print(f"ok    {lab}  ({got[ref].count(chr(10))+1} lines, identical across {len(files)} boards)"); raise SystemExit(0)
import difflib
for f in bad:
    print(f"DRIFT {lab}: {f} vs {ref}")
    for l in list(difflib.unified_diff(got[ref].splitlines(),got[f].splitlines(),ref,f,lineterm=''))[:16]: print("  "+l)
raise SystemExit(1)
PY
}
FIB="v4-futures.html v3-grant.html"
ALL="v4-futures.html v3-grant.html v6-obvs.html"
check "marioR scorer"  '^function marioR\(row\)\{.*?\n\}'                $FIB
check "rankKey"        '^const rankKey = .*?;$'                            $ALL
check "rankRows"       '^function rankRows\(rows, pool\)\{.*?\n\}'       $ALL
check "stats helpers"  '^function seriesFor.*?\n^function paired.*?\n\}'  $ALL
# fib-era pair: method keys/labels must agree, and METHOD_INFO must cover every method
python3 - <<'PY' || fail=1
import re
d=lambda x: re.sub(r'\\u([0-9a-fA-F]{4})', lambda m: chr(int(m.group(1),16)), x)
F,C,V=[open(f).read() for f in ('v4-futures.html','v3-grant.html','v6-obvs.html')]
f={k:d(v) for k,v in re.findall(r"\{k:'(m_[a-z0-9]+)',label:'([^']+)'",F)}
c={k:d(v) for k,v in re.findall(r"\{key:'(m_[a-z0-9]+)',[^}]*?name:'([^']+)'",C,re.S)}
bad=[k for k in set(f)|set(c) if f.get(k)!=c.get(k)]
print(f"ok    fib-era method table ({len(f)} methods, labels match)" if not bad
      else "DRIFT fib-era method table: "+", ".join(f"{k}: {f.get(k)!r} vs {c.get(k)!r}" for k in bad))
gap=0
for name,src,pat in (('futures',F,r"\{k:'(m_[a-z0-9]+)'"),('crypto',C,r"\{key:'(m_[a-z0-9]+)'"),('v6',V,r"\{k:'([a-z][0-9])',label")):
    info=set(re.findall(r'^  ([a-z_0-9]+):', re.search(r'^const METHOD_INFO=\{.*?\n\};',src,re.S|re.M).group(0), re.M))
    meth=set(re.findall(pat,src))
    if meth-info: print(f"GAP   {name} METHOD_INFO has no copy for: {sorted(meth-info)}"); gap=1
if not gap: print("ok    METHOD_INFO covers every method on all three boards")
raise SystemExit(1 if (bad or gap) else 0)
PY
# V6 scorer is pinned by its vectors, not by identity with another board
node verify/v6score.test.js >/dev/null 2>&1 && echo "ok    v6 scorer vectors" || { echo "FAIL  v6 scorer vectors (run: node verify/v6score.test.js)"; fail=1; }
[ "$fail" = 0 ] && echo "boards are one codebase" || { echo "BOARDS HAVE DRIFTED"; exit 1; }
