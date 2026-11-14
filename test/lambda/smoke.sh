#!/usr/bin/env bash
set -euo pipefail

bundle=$(cd "${1:-dist/lambda}" && pwd)
name=notify-relay-lambda-$$
trap 'docker rm --force "$name" >/dev/null 2>&1 || true' EXIT

fail() {
    echo "lambda smoke test failed: $*" >&2
    docker logs "$name" >&2 || true
    exit 1
}

docker run --detach --name "$name" --publish 127.0.0.1::8080 --volume "$bundle:/var/task:ro" \
    --env TOKEN_TEST=nr_test \
    --env CHANNEL_LOGS_TYPE=loki \
    --env CHANNEL_LOGS_URL=https://logs.invalid/loki/api/v1/push \
    --env CHANNEL_LOGS_USER=1 \
    --env CHANNEL_LOGS_TOKEN=x \
    public.ecr.aws/lambda/nodejs:24 index.handler >/dev/null
invocations="http://$(docker port "$name" 8080/tcp | head -n 1)/2015-03-31/functions/function/invocations"

# event <method> <path> <query> [body]
event() {
    local body=${4+,\"body\":$(printf '%s' "$4" | sed 's/["\\]/\\&/g; s/.*/"&"/')}
    printf '{"version":"2.0","rawPath":"%s","rawQueryString":"%s","headers":{"authorization":"Bearer nr_test"},"requestContext":{"http":{"method":"%s"}},"isBase64Encoded":false%s}' \
        "$2" "$3" "$1" "$body"
}

for _ in $(seq 50); do
    curl --silent --fail --data "$(event GET /healthz '')" "$invocations" >/dev/null && break
    sleep 0.2
done

health=$(curl --silent --data "$(event GET /healthz '')" "$invocations")
case $health in
    *'"statusCode":200'*'"body":"ok"'*) ;;
    *) fail "unexpected /healthz answer: $health" ;;
esac

# An unreachable channel yields 502 only after routing and delivery are attempted.
answer=$(curl --silent --data "$(event POST /webhook channels=logs '{"title":"smoke"}')" "$invocations")
case $answer in
    *'"statusCode":502'*'\"failed\":[{\"channel\":\"logs\"'*) ;;
    *) fail "unexpected /webhook answer: $answer" ;;
esac

echo "lambda smoke test passed"
