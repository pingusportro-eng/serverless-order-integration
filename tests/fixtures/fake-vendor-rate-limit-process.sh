#!/usr/bin/env bash

set -euo pipefail

: "${FAKE_VENDOR_DRILL_STATE_DIRECTORY:?FAKE_VENDOR_DRILL_STATE_DIRECTORY is required}"

mkdir -p "$FAKE_VENDOR_DRILL_STATE_DIRECTORY"
printf '%q ' "$@" >>"$FAKE_VENDOR_DRILL_STATE_DIRECTORY/process-commands.log"
printf '\n' >>"$FAKE_VENDOR_DRILL_STATE_DIRECTORY/process-commands.log"

option_value() {
  local option="$1"
  shift
  while (($# > 0)); do
    if [[ "$1" == "$option" ]]; then
      printf '%s\n' "$2"
      return
    fi
    shift
  done
  return 1
}

command_name="${1:?process command is required}"
shift

case "$command_name" in
  assert-stopped)
    [[ ! -f "$FAKE_VENDOR_DRILL_STATE_DIRECTORY/vendor-running" ]] || exit 80
    [[ ! -f "$FAKE_VENDOR_DRILL_STATE_DIRECTORY/tunnel-running" ]] || exit 81
    ;;

  start-vendor)
    scenario="$(option_value --scenario "$@")"
    token_file="$(option_value --token-file "$@")"
    attempt_log="$(option_value --attempt-log "$@")"
    [[ "$scenario" == 'rate-limit' || "$scenario" == 'success' ]] || exit 82
    [[ -f "$token_file" && "$(stat -c '%a' "$token_file")" == '600' ]] || exit 83
    jq -e 'type == "string" and length == 64' "$token_file" >/dev/null || exit 84
    printf '%s\n' "$scenario" >"$FAKE_VENDOR_DRILL_STATE_DIRECTORY/vendor-scenario"
    printf '%s\n' "$attempt_log" >"$FAKE_VENDOR_DRILL_STATE_DIRECTORY/attempt-log-path"
    touch "$FAKE_VENDOR_DRILL_STATE_DIRECTORY/vendor-running"
    ;;

  stop-vendor)
    rm -f \
      "$FAKE_VENDOR_DRILL_STATE_DIRECTORY/vendor-running" \
      "$FAKE_VENDOR_DRILL_STATE_DIRECTORY/vendor-scenario"
    ;;

  start-tunnel)
    [[ -f "$FAKE_VENDOR_DRILL_STATE_DIRECTORY/vendor-running" ]] || exit 85
    touch "$FAKE_VENDOR_DRILL_STATE_DIRECTORY/tunnel-running"
    printf 'https://vendor-rate-limit-drill.trycloudflare.com\n'
    ;;

  check-tunnel)
    [[ -f "$FAKE_VENDOR_DRILL_STATE_DIRECTORY/vendor-running" ]] || exit 86
    [[ -f "$FAKE_VENDOR_DRILL_STATE_DIRECTORY/tunnel-running" ]] || exit 87
    [[ "$(option_value --url "$@")" == \
      'https://vendor-rate-limit-drill.trycloudflare.com' ]] || exit 88
    ;;

  stop-tunnel)
    rm -f "$FAKE_VENDOR_DRILL_STATE_DIRECTORY/tunnel-running"
    ;;

  *)
    printf 'Unexpected fake process command: %s\n' "$command_name" >&2
    exit 89
    ;;
esac
