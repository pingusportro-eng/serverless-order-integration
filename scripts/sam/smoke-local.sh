#!/usr/bin/env bash

set -euo pipefail
export SAM_CLI_TELEMETRY=0

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$project_root"

npm run dynamodb:bootstrap
npm run sam:build

temporary_directory="$(mktemp -d)"
api_log="$project_root/.aws-sam/local-api.log"
api_pid=''

cleanup() {
  if [[ -n "$api_pid" ]]; then
    kill "$api_pid" 2>/dev/null || true
    wait "$api_pid" 2>/dev/null || true
  fi
  rm -rf "$temporary_directory"
}
trap cleanup EXIT

sam local start-api \
  --docker-network serverless-order-integration_default \
  --env-vars sam-local-fixture.json \
  --host 127.0.0.1 \
  --port 3000 >"$api_log" 2>&1 &
api_pid=$!

for _ in {1..90}; do
  if ! kill -0 "$api_pid" 2>/dev/null; then
    echo "SAM local API stopped before becoming ready. See $api_log." >&2
    exit 1
  fi
  if curl --silent --fail --output /dev/null 'http://127.0.0.1:3000/orders?limit=1'; then
    break
  fi
  sleep 1
done

if ! curl --silent --fail --output /dev/null 'http://127.0.0.1:3000/orders?limit=1'; then
  echo "SAM local API did not become ready. See $api_log." >&2
  exit 1
fi

suffix="$(date +%s%N)"
create_body="{\"merchantOrderReference\":\"sam-$suffix\",\"items\":[{\"itemReference\":\"item-1\",\"description\":\"SAM smoke test\",\"quantity\":1,\"unitPrice\":{\"amountMinor\":1000,\"currency\":\"RON\"}}],\"pickup\":{\"addressLine\":\"10 Example Street\",\"city\":\"Bucharest\",\"postalCode\":\"010101\",\"countryCode\":\"RO\"},\"dropoff\":{\"addressLine\":\"20 Example Avenue\",\"city\":\"Bucharest\",\"postalCode\":\"020202\",\"countryCode\":\"RO\"}}"

create_status="$(curl --silent --output "$temporary_directory/create.json" --write-out '%{http_code}' \
  --request POST \
  --header 'Content-Type: application/json' \
  --header "Idempotency-Key: sam-$suffix" \
  --data "$create_body" \
  'http://127.0.0.1:3000/orders')"
[[ "$create_status" == '201' ]]

order_id="$(node -e "const fs=require('node:fs');const value=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));if(typeof value.orderId!=='string')process.exit(1);process.stdout.write(value.orderId);" "$temporary_directory/create.json")"

get_status="$(curl --silent --output "$temporary_directory/get.json" --write-out '%{http_code}' \
  "http://127.0.0.1:3000/orders/$order_id")"
[[ "$get_status" == '200' ]]
node -e "const fs=require('node:fs');const value=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));if(value.orderId!==process.argv[2])process.exit(1);" "$temporary_directory/get.json" "$order_id"

list_status="$(curl --silent --output "$temporary_directory/list.json" --write-out '%{http_code}' \
  'http://127.0.0.1:3000/orders?limit=1')"
[[ "$list_status" == '200' ]]
node -e "const fs=require('node:fs');const value=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));if(!Array.isArray(value.items))process.exit(1);" "$temporary_directory/list.json"

change_status="$(curl --silent --output "$temporary_directory/change.json" --write-out '%{http_code}' \
  --request PATCH \
  --header 'Content-Type: application/json' \
  --header 'If-Match: "1"' \
  --data "{\"targetStatus\":\"SUBMITTED\",\"reason\":\"SAM local reconciliation.\",\"providerOrderId\":\"provider-$suffix\"}" \
  "http://127.0.0.1:3000/orders/$order_id/status")"
[[ "$change_status" == '200' ]]

node -e "const fs=require('node:fs');const value=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));if(value.status!=='SUBMITTED'||value.version!==2)process.exit(1);" "$temporary_directory/change.json"

webhook_timestamp="$(date +%s)"
webhook_occurred_at="$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')"
webhook_body="{\"eventId\":\"provider-event-$suffix\",\"eventType\":\"DELIVERY_DELIVERED\",\"occurredAt\":\"$webhook_occurred_at\",\"providerOrderId\":\"provider-$suffix\"}"
webhook_signature="$(node -e "const crypto=require('node:crypto');const [secret,timestamp,body]=process.argv.slice(1);process.stdout.write('sha256='+crypto.createHmac('sha256',secret).update(timestamp+'.'+body,'utf8').digest('hex'));" \
  'LOCAL_ONLY_WEBHOOK_SECRET_0123456789' "$webhook_timestamp" "$webhook_body")"

webhook_status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --request POST \
  --header 'Content-Type: application/json' \
  --header "X-Webhook-Timestamp: $webhook_timestamp" \
  --header "X-Webhook-Signature: $webhook_signature" \
  --data "$webhook_body" \
  'http://127.0.0.1:3000/webhooks/vendor')"
[[ "$webhook_status" == '204' ]]

duplicate_webhook_status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --request POST \
  --header 'Content-Type: application/json' \
  --header "X-Webhook-Timestamp: $webhook_timestamp" \
  --header "X-Webhook-Signature: $webhook_signature" \
  --data "$webhook_body" \
  'http://127.0.0.1:3000/webhooks/vendor')"
[[ "$duplicate_webhook_status" == '204' ]]

delivered_status="$(curl --silent --output "$temporary_directory/delivered.json" --write-out '%{http_code}' \
  "http://127.0.0.1:3000/orders/$order_id")"
[[ "$delivered_status" == '200' ]]
node -e "const fs=require('node:fs');const value=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));if(value.status!=='DELIVERED'||value.version!==3)process.exit(1);" "$temporary_directory/delivered.json"

echo "SAM local smoke test passed: REST routes and signed duplicate-safe vendor webhook."
