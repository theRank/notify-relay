#!/usr/bin/env bash
set -euo pipefail

package=$(cd "${1:-dist/azure}" && pwd)
name=notify-relay-azure-$$
trap 'docker rm --force "$name" >/dev/null 2>&1 || true' EXIT

fail() {
    echo "azure smoke test failed: $*" >&2
    docker logs "$name" >&2 || true
    exit 1
}

docker run --detach --name "$name" --platform linux/amd64 --publish 127.0.0.1::80 \
    --volume "$package:/home/site/wwwroot:ro" \
    --env AzureWebJobsScriptRoot=/home/site/wwwroot \
    --env AzureFunctionsJobHost__Logging__Console__IsEnabled=true \
    --env FUNCTIONS_REQUEST_BODY_SIZE_LIMIT=1048576 \
    --env TOKEN_TEST=nr_test \
    --env CHANNEL_LOGS_TYPE=loki \
    --env CHANNEL_LOGS_URL=https://logs.invalid/loki/api/v1/push \
    --env CHANNEL_LOGS_USER=1 \
    --env CHANNEL_LOGS_TOKEN=x \
    mcr.microsoft.com/azure-functions/node:4-node24 >/dev/null
origin="http://$(docker port "$name" 80/tcp | head -n 1)"

# The host takes a while to start, longer under emulation
for _ in $(seq 120); do
    curl --silent --fail --max-time 2 "$origin/healthz" >/dev/null && break
    sleep 1
done

health=$(curl --silent --max-time 10 "$origin/healthz")
[ "$health" = ok ] || fail "unexpected /healthz answer: $health"

# send <expected status> <curl arguments...>, with the body on stdin
send() {
    local expected=$1
    shift
    answer=$(curl --silent --max-time 30 --write-out '\n%{http_code}' --data-binary @- "$@" "$origin/webhook?channels=logs")
    [ "${answer##*$'\n'}" = "$expected" ] || fail "expected $expected, got: $answer"
}

# An unreachable channel yields 502 only after routing and delivery are attempted.
send 502 --header 'authorization: Bearer nr_test' --header 'content-type: application/json' <<<'{"title":"smoke"}'
case $answer in *'"failed":[{"channel":"logs"'*) ;; *) fail "unexpected /webhook answer: $answer" ;; esac
send 502 --header 'authorization: Bearer nr_test' --header 'transfer-encoding: chunked' <<<'{"title":"chunked"}'

send 401 <<<'{"title":"smoke"}'
head -c 100000 /dev/zero | tr '\0' x | send 413 --header 'authorization: Bearer nr_test'
head -c 2000000 /dev/zero | tr '\0' x | send 500 --header 'authorization: Bearer nr_test'

echo "azure smoke test passed"
