#!/usr/bin/env bash

set -euo pipefail

readonly endpoint_url='http://127.0.0.1:8000'
readonly region='eu-central-1'
readonly table_name='serverless-order-integration-local'
readonly script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly table_definition="${script_dir}/orders-table.json"

aws_local() {
  AWS_ACCESS_KEY_ID='DUMMYIDEXAMPLE' \
    AWS_SECRET_ACCESS_KEY='DUMMYEXAMPLEKEY' \
    AWS_SESSION_TOKEN='' \
    aws "$@" \
    --endpoint-url "${endpoint_url}" \
    --region "${region}" \
    --no-cli-pager
}

if aws_local dynamodb describe-table --table-name "${table_name}" >/dev/null 2>&1; then
  echo "DynamoDB Local table already exists: ${table_name}"
else
  echo "Creating DynamoDB Local table: ${table_name}"
  aws_local dynamodb create-table --cli-input-json "file://${table_definition}" >/dev/null
  aws_local dynamodb wait table-exists --table-name "${table_name}"
fi

aws_local dynamodb describe-table \
  --table-name "${table_name}" \
  --query 'Table.{TableName:TableName,TableStatus:TableStatus,BillingMode:BillingModeSummary.BillingMode,KeySchema:KeySchema,Indexes:GlobalSecondaryIndexes[].{IndexName:IndexName,IndexStatus:IndexStatus,KeySchema:KeySchema}}'
