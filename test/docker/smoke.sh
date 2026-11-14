#!/usr/bin/env bash
set -euo pipefail

image=${1:?usage: test/docker/smoke.sh <image>}
name=notify-relay-smoke-$$
trap 'docker rm --force "$name" >/dev/null 2>&1 || true' EXIT

fail() {
    echo "smoke test failed: $*" >&2
    docker logs "$name" >&2 || true
    exit 1
}

docker run --detach --name "$name" --publish 127.0.0.1::8080 \
    --env TOKEN_TEST=nr_test \
    --env CHANNEL_LOGS_TYPE=loki \
    --env CHANNEL_LOGS_URL=https://logs.invalid/loki/api/v1/push \
    --env CHANNEL_LOGS_USER=1 \
    --env CHANNEL_LOGS_TOKEN=x \
    "$image" >/dev/null
origin="http://$(docker port "$name" 8080/tcp | head -n 1)"

for _ in $(seq 50); do
    curl --silent --fail "$origin/healthz" >/dev/null && break
    sleep 0.1
done

[ "$(curl --silent "$origin/healthz")" = ok ] || fail "/healthz is not ok"

# An unreachable channel yields 502 only after routing and delivery are attempted.
answer=$(curl --silent --request POST --header 'authorization: Bearer nr_test' --data '{"title":"smoke"}' \
    "$origin/webhook?channels=logs")
case $answer in
    *'"failed":[{"channel":"logs"'*) ;;
    *) fail "unexpected /webhook answer: $answer" ;;
esac

[ "$(docker exec "$name" id -u)" != 0 ] || fail "runs as root"

healthcheck=$(docker inspect --format '{{index .Config.Healthcheck.Test 1}}' "$name")
docker exec "$name" sh -c "$healthcheck" || fail "HEALTHCHECK fails: $healthcheck"

started=$(date +%s)
docker stop --time 10 "$name" >/dev/null
stopped=$(date +%s)
[ $((stopped - started)) -lt 5 ] || fail "took $((stopped - started))s to stop"
code=$(docker inspect --format '{{.State.ExitCode}}' "$name")
[ "$code" = 0 ] || fail "exited with $code"

echo "smoke test passed: $image"
