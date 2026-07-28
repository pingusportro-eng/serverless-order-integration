#!/usr/bin/bash

set -euo pipefail

printf '%s\n' "$*" >>"${FAKE_EXECUTE_SMOKE_LOG:?}"
