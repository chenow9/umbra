#!/bin/bash
# r5: 10k TCP *steady-state* (alive through hold + final probe).
#
# Run on generator G=192.168.10.62.
# Direct: G -> 111:19224 (echo)
# Umbra:  G -> 112:18000 -> tunnel -> 111 echo
#
# Protocol: staggered RR keepalive, NOT a throughput test and NOT
# "echo as fast as RTT allows". interval=10s, skip missed ticks.
# At n=10000 this is ~1k pings/s average. Umbra IdleTimeoutSec=60,
# so keepalive must be < 60s.
#
# PASS: firstEchoOK=n AND aliveAtDeadline=n AND failedDuringHold=0
# AND finalProbeOK=n. Direct must PASS before Umbra at the same n.
set -u
ulimit -n 1048576 || true
sysctl -w net.core.somaxconn=65535 >/dev/null 2>&1 || true
sysctl -w net.ipv4.tcp_max_syn_backlog=65535 >/dev/null 2>&1 || true
B=${B:-/opt/umbra/umbra-bench}
OUT=${OUT:-/tmp/r5}
D_TCP=${D_TCP:-192.168.10.111:19224}
U_TCP=${U_TCP:-192.168.10.112:18000}
SIZE=${SIZE:-256}
INTERVAL=${INTERVAL:-10s}
HOLD=${HOLD:-60s}
TO=${TO:-8s}
PROBE=${PROBE:-8s}
PAR=${PAR:-128}
GAP=${GAP:-8}
mkdir -p "$OUT"
: > "$OUT/summary.txt"
summary() { tee -a "$OUT/summary.txt"; }

echo "r5 start $(date -u +%Y-%m-%dT%H:%M:%SZ) ulimit=$(ulimit -n) nproc=$(nproc)" | summary
echo "D_TCP=$D_TCP U_TCP=$U_TCP size=$SIZE interval=$INTERVAL hold=$HOLD timeout=$TO par=$PAR" | summary
echo "intent: 10k TCP steady-state (staggered keepalive + final probe)" | summary

rr_one() {
  local tag=$1 addr=$2 n=$3 hold=$4
  local base="$OUT/${tag}-tcp-n${n}-i${INTERVAL}-h${hold}"
  rm -f "${base}.json" "${base}.log"
  echo "===== $tag n=$n hold=$hold $(date -u +%H:%M:%SZ) =====" | summary
  $B -mode rr -addr "$addr" -n "$n" -par "$PAR" -size "$SIZE" \
    -interval "$INTERVAL" -hold "$hold" -timeout "$TO" -probe-timeout "$PROBE" \
    -json "${base}.json" > "${base}.log" 2>&1
  local rc=$?
  echo "RC=$rc $tag n=$n hold=$hold" | summary
  grep -E 'setupElapsed=|holdElapsed=|holdAttempts=|aliveAtDeadline=|firstErrs|holdErrs|totalElapsed=|stagger=' "${base}.log" | summary
  python3 - "$base.json" "$n" "$rc" <<'PY' | summary
import json,sys
path, n, rc = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
try:
    d=json.load(open(path))
except Exception as e:
    print(f"INVALID json {path}: {e}")
    sys.exit(2)
ok = d.get("FirstEchoOK")
alive = d.get("AliveAtDeadline")
fail = d.get("FailedDuringHold")
if fail is None:
    fail = 0
probe = d.get("FinalProbeOK")
print(f"JSON firstEchoOK={ok} aliveAtDeadline={alive} failedDuringHold={fail} finalProbeOK={probe} holdErrors={d.get('HoldErrors')}")
steady = (ok==n and alive==n and fail==0 and probe==n and rc==0)
print("STEADY_PASS" if steady else "STEADY_FAIL")
sys.exit(0 if steady else 1)
PY
}

echo "===== smoke Direct n=1 =====" | summary
if ! $B -mode rr -addr "$D_TCP" -n 1 -par 1 -size "$SIZE" -interval 0 -hold 0s -timeout "$TO" >/dev/null; then
  echo "ABORT: Direct n=1 smoke failed" | summary
  exit 1
fi
echo "===== smoke Umbra n=1 =====" | summary
if ! $B -mode rr -addr "$U_TCP" -n 1 -par 1 -size "$SIZE" -interval 0 -hold 0s -timeout "$TO" >/dev/null; then
  echo "ABORT: Umbra n=1 smoke failed" | summary
  exit 1
fi

failed=0
run_or_abort() {
  local tag=$1 addr=$2 n=$3 hold=$4
  if ! rr_one "$tag" "$addr" "$n" "$hold"; then
    echo "ABORT: $tag n=$n STEADY_FAIL" | summary
    if [ "$tag" = direct ]; then
      echo "Direct failed; not blaming Umbra." | summary
      failed=1
      return 1
    fi
    failed=1
    return 1
  fi
  sleep "$GAP"
  return 0
}

run_or_abort direct "$D_TCP" 1000 20s || true
if [ "$failed" -eq 0 ]; then
  run_or_abort umbra "$U_TCP" 1000 20s || true
fi
if [ "$failed" -eq 0 ]; then
  run_or_abort direct "$D_TCP" 10000 "$HOLD" || true
fi
if [ "$failed" -eq 0 ]; then
  run_or_abort umbra "$U_TCP" 10000 "$HOLD" || true
fi

echo "r5 done $(date -u +%Y-%m-%dT%H:%M:%SZ) failed=$failed" | summary
echo "artifacts $OUT" | summary
exit "$failed"
