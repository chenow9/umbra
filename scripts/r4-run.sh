#!/bin/bash
# r4 collector. Run on independent generator G (192.168.10.62).
# Direct: G -> 111:19224/19300
# Umbra:  G -> 112:18000/18102 -> tunnel -> 111 echo
#
# UDP sessions idle-recycle in IdleTimeoutSec (default 60s). Consecutive
# Umbra n=800 rounds MUST wait until udpActive=0 or they stack into MaxConns
# and look like uplane loss.
#
# Optional: UMBRA_HEALTH=http://127.0.0.1:18080/health when this host can
# reach the console. Else GATE_SSH=root@192.168.10.112 curls loopback health.
# If neither works, sleep UDP_IDLE_FALLBACK then recheck. Umbra UDP rounds
# abort unless udpActive is observed as 0. n=800 requires per-IP/rate/map
# limits >=800 or disabled (0).
set -u
ulimit -n 1048576 || true
B=${B:-/opt/umbra/umbra-bench}
OUT=${OUT:-/tmp/r4}
D_TCP=${D_TCP:-192.168.10.111:19224}
U_TCP=${U_TCP:-192.168.10.112:18000}
D_UDP=${D_UDP:-192.168.10.111:19300}
U_UDP=${U_UDP:-192.168.10.112:18102}
HOLD=${HOLD:-8s}
TO=${TO:-5s}
REPS=${REPS:-5}
GATE_SSH=${GATE_SSH:-root@192.168.10.112}
GATE_HEALTH=${GATE_HEALTH:-http://127.0.0.1:18080/health}
UDP_IDLE_WAIT=${UDP_IDLE_WAIT:-90}
UDP_IDLE_FALLBACK=${UDP_IDLE_FALLBACK:-62}
mkdir -p "$OUT"
summary() { tee -a "$OUT/summary.txt"; }

gate_health_json() {
  local json=""
  if [ -n "${UMBRA_HEALTH:-}" ]; then
    json=$(curl -sS --max-time 2 "$UMBRA_HEALTH" 2>/dev/null || true)
  elif [ -n "${GATE_SSH:-}" ]; then
    json=$(ssh -o BatchMode=yes -o ConnectTimeout=3 -o StrictHostKeyChecking=no \
      "$GATE_SSH" "curl -sS --max-time 2 $GATE_HEALTH" 2>/dev/null || true)
  fi
  printf '%s' "$json"
}

udp_active() {
  gate_health_json | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin)
    v=d.get("udpActive")
    if v is None:
        v=d.get("udp_active") or 0
    print(int(v))
except Exception:
    pass' 2>/dev/null
}

udp_admit_limits() {
  gate_health_json | python3 -c 'import json,sys
try:
    d=json.load(sys.stdin)
    def n(k):
        v=d.get(k)
        if v is None:
            return -1
        return int(v)
    print("%d %d %d" % (n("udpMaxFlowsPerIP"), n("udpNewFlowsPerSec"), n("udpNewFlowsPerMap")))
except Exception:
    print("-1 -1 -1")' 2>/dev/null
}

wait_udp_idle() {
  local why=${1:-round}
  local start=$SECONDS
  local misses=0
  echo "wait udp_active=0 ($why) timeout=${UDP_IDLE_WAIT}s" | summary
  while [ $((SECONDS-start)) -lt "$UDP_IDLE_WAIT" ]; do
    local n
    n=$(udp_active || true)
    if [ "$n" = "0" ]; then
      echo "udp_active=0 after $((SECONDS-start))s ($why)" | summary
      return 0
    fi
    if [ -z "$n" ]; then
      misses=$((misses + 1))
      if [ "$misses" -ge 2 ]; then
        echo "udp_active unreachable; sleeping ${UDP_IDLE_FALLBACK}s then recheck ($why)" | summary
        sleep "$UDP_IDLE_FALLBACK"
        n=$(udp_active || true)
        if [ "$n" = "0" ]; then
          echo "udp_active=0 after fallback sleep ($why)" | summary
          return 0
        fi
        echo "FAIL udp_active=${n:-unknown} after fallback; refuse to start ($why)" | summary
        return 1
      fi
    else
      echo "udp_active=$n ($why) t=$((SECONDS-start))s" | summary
    fi
    sleep 2
  done
  local n
  n=$(udp_active || true)
  echo "FAIL udp_active=${n:-unknown} still non-zero after ${UDP_IDLE_WAIT}s ($why)" | summary
  return 1
}

require_udp_idle() {
  local why=$1
  if ! wait_udp_idle "$why"; then
    echo "ABORT $why: udpActive!=0, skip remaining Umbra UDP rounds" | summary
    exit 1
  fi
  local n
  n=$(udp_active || true)
  if [ "$n" != "0" ]; then
    echo "ABORT $why: udp_active=${n:-unknown} after wait" | summary
    exit 1
  fi
}

nnint() {
  [[ "${1:-}" =~ ^[0-9]+$ ]]
}

require_udp_admit_for_n() {
  local n=$1
  local limits perip persec permap
  limits=$(udp_admit_limits || true)
  perip=$(printf '%s' "$limits" | awk '{print $1}')
  persec=$(printf '%s' "$limits" | awk '{print $2}')
  permap=$(printf '%s' "$limits" | awk '{print $3}')
  echo "gate admit perIP=$perip perSec=$persec perMap=$permap n=$n" | summary
  if ! nnint "$perip" || ! nnint "$persec" || ! nnint "$permap"; then
    echo "ABORT n=$n: admission limits missing/negative/non-numeric ($limits)" | summary
    exit 1
  fi
  if [ "$perip" -gt 0 ] && [ "$perip" -lt "$n" ]; then
    echo "ABORT n=$n: udpMaxFlowsPerIP=$perip < n (set UMBRA_UDP_MAX_FLOWS_PER_IP>=$n or 0)" | summary
    exit 1
  fi
  if [ "$persec" -gt 0 ] && [ "$persec" -lt "$n" ]; then
    echo "ABORT n=$n: udpNewFlowsPerSec=$persec < n (burst is 1s; set >=$n or 0)" | summary
    exit 1
  fi
  if [ "$permap" -gt 0 ] && [ "$permap" -lt "$n" ]; then
    echo "ABORT n=$n: udpNewFlowsPerMap=$permap < n (set UMBRA_UDP_NEW_FLOWS_PER_MAP>=$n or 0)" | summary
    exit 1
  fi
}

echo "r4 start $(date -u +%Y-%m-%dT%H:%M:%SZ) ulimit=$(ulimit -n)" | summary
echo "D_TCP=$D_TCP U_TCP=$U_TCP D_UDP=$D_UDP U_UDP=$U_UDP" | summary

stream_one() {
  local tag=$1 addr=$2 n=$3 rep=$4
  local base="$OUT/${tag}-n${n}-r${rep}"
  rm -f "${base}.json"
  $B -mode stream -addr "$addr" -n "$n" -par "$n" -size 65536 -hold "$HOLD" -timeout "$TO" \
    -json "${base}.json" > "${base}.log" 2>&1
  local rc=$?
  echo "RC=$rc $tag n=$n r=$rep" | summary
  if [ "$rc" -ne 0 ]; then
    echo "INVALID $tag n=$n r=$rep bench rc=$rc" | summary
    return "$rc"
  fi
  grep -E 'holdElapsed=|txErr=|aliveAtDeadline=' "${base}.log" | summary
}

echo "===== TCP STREAM 5x n=1,2,4,8,16,32 =====" | summary
for n in 1 2 4 8 16 32; do
  for r in $(seq 1 "$REPS"); do
    stream_one direct "$D_TCP" "$n" "$r"
    stream_one umbra "$U_TCP" "$n" "$r"
  done
done

udp_one() {
  local tag=$1 addr=$2 n=$3 pps=$4 hold=$5
  local base="$OUT/${tag}-udp-n${n}-pps${pps}"
  rm -f "${base}.json"
  $B -proto udp -mode openloop -addr "$addr" -n "$n" -par "$n" -size 1200 \
    -pps "$pps" -hold "$hold" -timeout 1s -json "${base}.json" > "${base}.log" 2>&1
  local rc=$?
  echo "RC=$rc $tag udp n=$n pps=$pps" | summary
  if [ "$rc" -ne 0 ]; then
    echo "INVALID $tag udp n=$n pps=$pps bench rc=$rc" | summary
    return "$rc"
  fi
  grep -E 'openloop sent=|deliveryRate=|holdDelivery=' "${base}.log" | summary
}

echo "===== UDP Direct climb pps=20 hold=8s =====" | summary
last_ok=""
first_bad=""
for n in 20 40 80 160 320 640 800; do
  if ! udp_one direct "$D_UDP" "$n" 20 8s; then
    echo "ABORT direct n=$n: bench non-zero exit, skip this n and stop climb" | summary
    first_bad=$n
    break
  fi
  json="${OUT}/direct-udp-n${n}-pps20.json"
  if [ ! -f "$json" ]; then
    echo "ABORT direct n=$n: missing json after success rc, skip this n" | summary
    first_bad=$n
    break
  fi
  rate=$(python3 - <<PY
import json
p="${json}"
d=json.load(open(p))
print("%.6f" % float(d.get("UDPLossRate") or 0))
PY
)
  echo "direct n=$n lossRate=$rate" | summary
  awk -v r="$rate" 'BEGIN{exit !(r+0 > 0.001)}' && { first_bad=$n; break; }
  last_ok=$n
done
echo "direct last_ok=${last_ok:-none} first_bad=${first_bad:-none}" | summary
if [ -z "$last_ok" ]; then
  echo "ABORT: no Direct UDP baseline (last_ok empty)" | summary
  exit 1
fi

echo "===== UDP Umbra at last_ok and first_bad, 5 reps =====" | summary
for n in $last_ok $first_bad; do
  [ -n "$n" ] || continue
  require_udp_admit_for_n "$n"
  for r in $(seq 1 "$REPS"); do
    require_udp_idle "umbra n=$n r=$r"
    before=$(udp_active || true)
    echo "start umbra n=$n r=$r udp_active=${before:-unknown}" | summary
    rm -f "$OUT/umbra-udp-n${n}-pps20-r${r}.json"
    $B -proto udp -mode openloop -addr "$U_UDP" -n "$n" -par "$n" -size 1200 \
      -pps 20 -hold 8s -timeout 1s \
      -json "$OUT/umbra-udp-n${n}-pps20-r${r}.json" > "$OUT/umbra-udp-n${n}-pps20-r${r}.log" 2>&1
    rc=$?
    echo "RC=$rc umbra udp n=$n r=$r udp_active_at_start=${before:-unknown}" | summary
    if [ "$rc" -ne 0 ]; then
      echo "INVALID umbra n=$n r=$r bench rc=$rc" | summary
      echo "ABORT umbra n=$n r=$r: bench non-zero exit, round invalid" | summary
      exit 1
    fi
    grep -E 'openloop sent=|deliveryRate=|holdDelivery=' "$OUT/umbra-udp-n${n}-pps20-r${r}.log" | summary
  done
  # matching Direct 5 reps at last_ok
  if [ "$n" = "$last_ok" ]; then
    for r in $(seq 1 "$REPS"); do
      rm -f "$OUT/direct-udp-n${n}-pps20-r${r}.json"
      $B -proto udp -mode openloop -addr "$D_UDP" -n "$n" -par "$n" -size 1200 \
        -pps 20 -hold 8s -timeout 1s \
        -json "$OUT/direct-udp-n${n}-pps20-r${r}.json" > "$OUT/direct-udp-n${n}-pps20-r${r}.log" 2>&1
      rc=$?
      echo "RC=$rc direct udp n=$n r=$r" | summary
      if [ "$rc" -ne 0 ]; then
        echo "INVALID direct udp n=$n r=$r bench rc=$rc" | summary
        continue
      fi
      grep -E 'openloop sent=|deliveryRate=|holdDelivery=' "$OUT/direct-udp-n${n}-pps20-r${r}.log" | summary
    done
  fi
done

echo "r4 done $(date -u +%Y-%m-%dT%H:%M:%SZ)" | summary
