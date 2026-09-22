#!/usr/bin/env bash
# Run only this checkout's container, retaining 20 GiB of host available RAM.
# Docker access is a prerequisite; this script never invokes sudo or installs
# host packages. Keep it running: it owns the container's lifetime.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || { echo 'This launcher requires Linux x86_64.' >&2; exit 1; }
command -v docker >/dev/null || { echo 'An administrator must provide Docker access for this isolated task.' >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo 'Docker is unavailable to this account. Ask an administrator to run this task container; no server settings were changed.' >&2; exit 1; }
docker compose version >/dev/null

RESERVE_KB=$((20 * 1024 * 1024))
available_kb() { awk '/^MemAvailable:/ {print $2}' /proc/meminfo; }
AVAILABLE_KB="$(available_kb)"
[[ "$AVAILABLE_KB" =~ ^[0-9]+$ && "$AVAILABLE_KB" -gt "$RESERVE_KB" ]] || { echo 'Less than 20 GiB of available host RAM; not starting.' >&2; exit 1; }
export CALL_BOTS_MEMORY_BUDGET="$(((AVAILABLE_KB - RESERVE_KB) * 1024))"
export CALL_BOTS_UID="${CALL_BOTS_UID:-$(stat -c %u "$ROOT")}"
export CALL_BOTS_GID="${CALL_BOTS_GID:-$(stat -c %g "$ROOT")}"
[[ "$CALL_BOTS_UID" =~ ^[0-9]+$ && "$CALL_BOTS_UID" -gt 0 && "$CALL_BOTS_GID" =~ ^[0-9]+$ ]] || { echo 'Set CALL_BOTS_UID and CALL_BOTS_GID to the non-root owner of this task directory.' >&2; exit 1; }
COMPOSE=(docker compose -p call-bots-linux-meet -f "$ROOT/compose.linux.yml")

# A label alone is not permission to modify somebody else's existing workload.
EXISTING="$(docker ps -aq --filter label=com.docker.compose.project=call-bots-linux-meet)"
[[ -z "$EXISTING" ]] || { echo 'A call-bots-linux-meet container already exists. Inspect its ownership before starting another.' >&2; exit 1; }

mkdir -p "$ROOT/.server/container-data"
# The container runs with the task owner's uid, without exposing the owner's
# home directory. A root operator may create the directory on their behalf.
if [[ "$(stat -c %u "$ROOT/.server/container-data")" != "$CALL_BOTS_UID" ]]; then
  if [[ "$(id -u)" == 0 ]]; then chown "$CALL_BOTS_UID:$CALL_BOTS_GID" "$ROOT/.server/container-data"
  else echo "The container data directory belongs to another user; ask its administrator to correct ownership." >&2; exit 1
  fi
fi

CID=''
export CALL_BOTS_LAUNCH_ID="$(cat /proc/sys/kernel/random/uuid)"
cleanup() {
  trap - EXIT INT TERM HUP
  # A failed/interrupted Compose create may have made the container before
  # returning its id. Recover only containers carrying this launch's nonce.
  if [[ -z "$CID" ]]; then
    CID="$(docker ps -aq --no-trunc --filter "label=org.call-bots.launch=$CALL_BOTS_LAUNCH_ID" 2>/dev/null || true)"
  fi
  if [[ "$CID" =~ ^[a-f0-9]{64}$ ]]; then
    # CID was captured from this launch; never sweep other containers/processes.
    docker stop --time 30 "$CID" >/dev/null 2>&1 || true
    docker rm "$CID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

"${COMPOSE[@]}" build
# Recompute after the build; a busy production host can change underneath us.
AVAILABLE_KB="$(available_kb)"
[[ "$AVAILABLE_KB" =~ ^[0-9]+$ && "$AVAILABLE_KB" -gt "$RESERVE_KB" ]] || { echo 'The 20 GiB reserve would be crossed; not starting.' >&2; exit 1; }
export CALL_BOTS_MEMORY_BUDGET="$(((AVAILABLE_KB - RESERVE_KB) * 1024))"
"${COMPOSE[@]}" create dashboard
CID="$("${COMPOSE[@]}" ps -aq dashboard)"
[[ "$CID" =~ ^[a-f0-9]{64}$ ]] || { echo 'Could not identify the task container.' >&2; exit 1; }
docker start "$CID" >/dev/null
echo 'Call Bots: http://127.0.0.1:14610 (use an SSH tunnel). Ctrl-C closes only this task container.'
while [[ "$(docker inspect --format '{{.State.Running}}' "$CID")" == true ]]; do
  AVAILABLE_KB="$(available_kb)"
  if [[ ! "$AVAILABLE_KB" =~ ^[0-9]+$ || "$AVAILABLE_KB" -lt "$RESERVE_KB" ]]; then
    echo 'Host available RAM reached the 20 GiB reserve; stopping only Call Bots.' >&2
    exit 1
  fi
  sleep 2
done
docker logs --tail 30 "$CID"
exit "$(docker inspect --format '{{.State.ExitCode}}' "$CID")"
