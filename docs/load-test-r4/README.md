r4 artifacts. Independent Linux generator `192.168.10.62` (32c / 31GiB / 1GbE `enp9s0`).

- Direct: G → 192.168.10.111:19224 (TCP echo) / :19300 (UDP echo)
- Umbra: G → 192.168.10.112:18000 / :18102 → tunnel → node echo

JSON+logs from `scripts/r4-run.sh`. Gate/node/echo `umbra-obs.sh` traces. See `docs/load-test-2026-08-28.md` §r4.
