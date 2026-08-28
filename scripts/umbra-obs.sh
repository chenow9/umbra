#!/bin/bash
# Sample ONE pid at 1Hz.
#
# CPU is a 1-second window from /proc/<pid>/stat utime+stime deltas
# (not ps %CPU, which is lifetime average).
# sock_fd is that process's socket-backed FDs.
# host_* columns are whole-namespace ss totals and MUST NOT be
# attributed to the process (host network containers share the table).
set -e
label=${1:?label}
pid=${2:?pid}
out=${3:?outfile}
expect=${4:-}

if ! kill -0 "$pid" 2>/dev/null; then
  echo "obs: pid $pid not running" >&2
  exit 2
fi
cmdline=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
{
  echo "# label=$label pid=$pid expect=${expect:-<none>}"
  echo "# cmdline=$cmdline"
} >"$out"
if [ -n "$expect" ]; then
  case "$cmdline" in
    *"$expect"*) ;;
    *)
      echo "obs: PID_MISMATCH pid=$pid want substring '$expect' got '$cmdline'" | tee -a "$out" >&2
      exit 2
      ;;
  esac
fi

clk=$(getconf CLK_TCK)
cpu_jif() {
  local rest
  rest=$(sed 's/.*) //' "/proc/$1/stat" 2>/dev/null) || { echo 0; return; }
  # after comm: 1=state ... 12=utime 13=stime
  set -- $rest
  echo $(( ${12:-0} + ${13:-0} ))
}
sock_fd() {
  find "/proc/$1/fd" -lname 'socket:*' 2>/dev/null | wc -l | awk '{print $1}'
}

echo "ts cpu_1s rss_kb nproc fd sock_fd host_tcp_est host_udp_socks host_tcp_tw" >>"$out"
prev=$(cpu_jif "$pid")
tprev=$(date +%s%N)
sleep 0.2
while kill -0 "$pid" 2>/dev/null; do
  now=$(cpu_jif "$pid")
  tnow=$(date +%s%N)
  dt=$(awk -v a="$tnow" -v b="$tprev" 'BEGIN{d=(a-b)/1e9; if(d<=0)d=1; print d}')
  cpu=$(awk -v d="$now" -v p="$prev" -v hz="$clk" -v dt="$dt" 'BEGIN{printf "%.1f", 100*(d-p)/hz/dt}')
  rss=$(awk '/^VmRSS:/ {print $2}' "/proc/$pid/status" 2>/dev/null)
  if [ -z "$rss" ]; then
    rss=$(ps -p "$pid" -o rss= | awk '{print $1}')
  fi
  nproc=$(ls "/proc/$pid/task" 2>/dev/null | wc -l | awk '{print $1}')
  fd=$(ls "/proc/$pid/fd" 2>/dev/null | wc -l | awk '{print $1}')
  socks=$(sock_fd "$pid")
  host_tcp=$(ss -tH state established 2>/dev/null | wc -l | awk '{print $1}')
  host_udp=$(ss -uH 2>/dev/null | wc -l | awk '{print $1}')
  host_tw=$(ss -tH state time-wait 2>/dev/null | wc -l | awk '{print $1}')
  printf "%s %s %s %s %s %s %s %s %s\n" "$(date +%H:%M:%S)" "$cpu" "$rss" "$nproc" "$fd" "$socks" "$host_tcp" "$host_udp" "$host_tw" >>"$out"
  prev=$now
  tprev=$tnow
  sleep 1
done
echo "${label} observer stopped pid=$pid" >>"$out"
