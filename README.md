# notify-relay

A stateless notification relay for Cloudflare Workers and Node. Senders POST a message; the relay
authenticates them, validates the message and delivers it to the channels named in the URL, within the
same request. There is no queue, no database and no history.

- **Delivers, never stores.** Anything stateful (deduplication, grouping, acknowledgement, escalation,
  dead-man's switches) belongs upstream or in a service built for it, e.g. your alerting system.
- **The sender picks the channels.** They are part of the URL. The relay has no routing rules and no
  default channel.
- **The sender owns the content.** Channels put each field in its slot and add nothing; the relay never
  joins, converts or strips text. A sender writing for a constrained channel controls every character
  that arrives.
- **Adapters on both sides.** Inbound adapters turn a sender's native payload into one message format;
  outbound adapters turn that message into a channel's API call. The core knows neither.
- **Not a pager.** If something must wake you up, send it to a paging service directly. A relay outage
  should cost you routine messages, not an incident.

```text
inbound adapters          message           outbound adapters
/webhook  ──→  Message  ──→  deliver  ──→  loki, smtp, gmail, bark, ntfy, slack, discord, feishu
```

## API

```http
POST /webhook?channels=loki HTTP/1.1
Authorization: Bearer nr_...
Content-Type: application/json

{"title": "deploy done", "level": "low"}
```

The URL says where to deliver and the body says what the message is. Every inbound endpoint works this
way; for an adapter that translates a third-party payload, the body is that payload unchanged.

| Query | Required | Meaning |
|---|---|---|
| `channels` | yes | Primary group: names of configured channels, comma-separated, delivered in parallel |
| `fallback` | no | Tried in order, only when the whole primary group failed, until one succeeds |

A channel that is not configured, a channel in both groups or a missing `channels` is a 400. Channel
names are the deployment's own (see [Channels](#channels)), not channel types.

`/webhook` takes the relay's own format:

| Field | Required | Meaning |
|---|---|---|
| `title` | yes | One line |
| `text` | no | Plain text |
| `rich` | no | Formatted text in the channel's own markup: HTML for `smtp` and `gmail`, mrkdwn for `slack`, Markdown where a channel renders it |
| `level` | no | `low`, `normal` (default), `high` or `critical`. How loudly each channel notifies, never which channels |
| `url` | no | A link back to the source; https only |
| `key` | no | On channels that support it, a new message with the same key replaces the previous one |
| `group` | no | Display grouping |
| `to` | no | Recipients by channel name, e.g. `{"mail": "ops@example.com"}`; see [Recipients](#recipients) |

`title`, `text` and `rich` are the content. A channel that renders markup shows `rich` when it is given,
the others show `text`; the relay neither checks that the two agree nor derives one from the other.
`level`, `url`, `key` and `group` are metadata, used by the channels that have a place for them and
ignored by the rest; each channel type below says which it uses. `to` is checked as
[Recipients](#recipients) describes. An empty `text`, `rich`, `key` or `group` counts as left out.

Unknown fields are a 400, so a misspelled field fails at the sender instead of being dropped. Bodies over
64 KB are a 413.

### Recipients

A channel delivers to its configured recipients (`TO` on mail channels) unless `to` names others for it:

```json
{"title": "invoice paid", "to": {"mail": "Jane <jane@example.com>"}}
```

Each entry must name a channel in `channels` or `fallback`, of a type that takes recipients (`smtp`,
`gmail`), written in that type's syntax and admitted by the channel's `ALLOW_TO`; otherwise the request is
a 400 and nothing is delivered. A channel without an entry, a fallback included, uses its own recipients.
Any sender token can reach whoever `ALLOW_TO` admits, so keep it narrow.

### Responses

| Status | Meaning |
|---|---|
| 200 | At least one primary channel succeeded, or the primary group failed and a fallback succeeded |
| 204 | The inbound adapter produced no message (e.g. an empty alert group) |
| 400, 401, 404, 405, 413 | The request is wrong; retrying will not help |
| 502 | Every channel failed; retry |

200 and 502 list the outcome per channel, without any secret:

```json
{"messages": [{"delivered": ["loki"], "failed": [{"channel": "bark", "error": "timeout"}]}]}
```

A 400 body is `{"error": "<reason>"}`. A 401 has no body, only `WWW-Authenticate: Bearer`. Delivery is
at-least-once: an occasional duplicate is preferred to a silent loss, and `key` lets channels collapse
duplicates.

Each channel attempt times out after 5 seconds, enforced by the relay rather than left to the adapter.
A 429 whose `Retry-After` is a number of seconds no greater than 2 is retried once within the request.
A missing `Retry-After`, an HTTP date or a longer wait counts as a failure rather than blocking the
request; the caller retries.

### Health

`GET /healthz` needs no token and calls no channel. It answers 200 when at least one channel is
configured, every configured channel has a known type and all of that type's required parameters, and at
least one source token exists; 503 otherwise, without saying what is missing. Channel types nobody
configured are not checked. Deploys do not check settings (see [Platforms](#platforms)), so point an
external probe here.

## Authentication

`Authorization: Bearer <token>`, one token per sender, stored as a secret named `TOKEN_<SOURCE>`. A
token in `TOKEN_GITHUB` authenticates the source `github` (lowercase, `_` becomes `-`). The source comes
only from the token, never from the request, and adding a sender means adding a secret, not changing
code.

- A secret may hold several tokens separated by spaces, so a rotation can overlap.
- Tokens are compared in constant time against every candidate. Failures are a bare 401.
- Tokens are never accepted in the query string, which ends up in logs.
- Tokens travel in a header, so give senders `https://` URLs. A platform's redirect from HTTP to HTTPS
  comes after the request, token included, has crossed in the clear: it makes a sender misconfigured
  with `http://` fail, it does not protect it. Rotate a token sent that way.

Generate a token with the `nr_` prefix, which makes it easy for secret scanners to recognise:

```bash
printf 'nr_%s\n' "$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
```

## Channels

A *channel type* is code (`loki`); a *channel* is a configured instance of one, named by the deployment.
A deployment can configure several channels of the same type and none of another. Each channel is a set
of settings, which are Worker bindings or environment variables depending on the [platform](#platforms):

```text
CHANNEL_<NAME>_TYPE     the type, e.g. loki; declares the channel
CHANNEL_<NAME>_<PARAM>  one per parameter of that type; optional ones may be left out
```

The channel's name is `<NAME>` in lowercase with `_` turned into `-`, so `CHANNEL_HOME_LAB_TYPE` declares
`home-lab`, used as `?channels=home-lab`. Parameters are looked up by their exact names. The relay reads
variables and secrets alike; keep the sensitive parameters as secrets.

```text
CHANNEL_LOGS_TYPE=loki                  # variable
CHANNEL_LOGS_URL=https://logs-prod-000.grafana.net/loki/api/v1/push
CHANNEL_LOGS_USER=123456
CHANNEL_LOGS_TOKEN=...                  # secret
CHANNEL_ARCHIVE_TYPE=loki               # a second channel of the same type
...
```

### `loki`

Pushes each message as one log line to Loki's `/loki/api/v1/push` with basic auth. Labels hold only
low-cardinality fields (`job="notify-relay"`, `source`, `level`); every other field is in the line's JSON
as sent. Handy as a first channel: a line you can query is a positive signal that delivery works, and it
doubles as a record of everything sent.

| Parameter | Keep as | Meaning |
|---|---|---|
| `URL` | variable | e.g. `https://logs-prod-000.grafana.net/loki/api/v1/push` |
| `USER` | variable | Basic auth user (the Loki instance ID on Grafana Cloud) |
| `TOKEN` | secret | Basic auth password; on Grafana Cloud, an access policy token with `logs:write` only |

### `smtp`

Submits an email to an SMTP server, a mailbox provider's or a sending service's. `title` is the subject,
`text` the plain-text body (the title again when there is none), and `rich`, when given, the HTML
alternative. `url`, `key`, `group` and `level` are not used: a link belongs in the content.

Each message opens its own connection and authenticates with `AUTH PLAIN` over TLS: implicit on port 465,
`STARTTLS` on any other. A server that refuses `STARTTLS` fails the delivery.

| Parameter | Keep as | Meaning |
|---|---|---|
| `HOST` | variable | The submission server, e.g. `smtp.example.com` |
| `PORT` | variable, optional | Defaults to 587. Workers cannot connect to port 25 |
| `USER` | variable or secret | The SMTP user name |
| `PASSWORD` | secret | Its password |
| `FROM` | variable | The sender; the server must let `USER` send as it |
| `TO` | variable or secret | The recipients unless `to` names others for this channel |
| `ALLOW_TO` | variable, optional | Recipients a message may name in `to`: `*`, `*@example.com` (not its subdomains) or addresses, comma-separated. Without it, none |

`TO` and recipients in `to` are one address or several, comma-separated, and `FROM` exactly one; each is
`address` or `Name <address>`, with a name holding a comma in double quotes. Names may be in any script;
addresses are ASCII, so an internationalised domain goes in its `xn--` form. A rejected SMTP step fails
delivery as e.g. `SMTP 535 on AUTH`, without the server's text, which can quote an address.

With a mailbox provider, send from an account of its own: an app password usually opens the whole
mailbox over IMAP too, not only sending.

### `gmail`

Sends an email through the Gmail API, as the Google account that granted the refresh token. The mail is
the one `smtp` sends. Each message first exchanges the refresh token for an access token; nothing is
cached.

| Parameter | Keep as | Meaning |
|---|---|---|
| `CLIENT_ID` | variable | OAuth client of type *Desktop app* |
| `CLIENT_SECRET` | secret | That client's secret |
| `REFRESH_TOKEN` | secret | Granted with the `https://www.googleapis.com/auth/gmail.send` scope only |
| `TO` | variable or secret | The recipients unless `to` names others for this channel |
| `FROM` | variable, optional | The sender's name, as `Name <address>`. Without it, Gmail uses the account's own name |
| `ALLOW_TO` | variable, optional | Which recipients a message may name in `to`. Without it, none |

`TO`, `FROM` and `ALLOW_TO` work as for `smtp`. The `FROM` address must be the account's own or one of its
verified *Send mail as* aliases.

Getting the refresh token, once:

- Use a dedicated Google account for sending, so a runaway sender hits its daily limit, not yours.
- In Google Cloud, enable the Gmail API, add `gmail.send` under the OAuth consent screen's data access,
  and **publish the app to production**: in testing, refresh tokens expire after 7 days. An unverified app
  works for its owner; the consent screen shows a warning.
- Run the authorization-code flow with a loopback redirect (`http://127.0.0.1:<port>`),
  `access_type=offline` and `prompt=consent`, then exchange the code for the refresh token.

The token stays valid until the grant is revoked, the account's password changes, or it goes unused for
six months. A dead token fails delivery with `refresh token revoked or expired (invalid_grant)`;
`/healthz` cannot see it, since the parameters are still set.

### `bark`

Pushes to an iPhone or iPad through [Bark](https://github.com/Finb/Bark). `title` is the notification's
title, `text` its body, and `rich`, when given, Markdown that Bark shows instead of the body. `level` is
how it interrupts: `low` is passive (no sound, screen stays off), `normal` active, `high`
time-sensitive (breaks through a Focus), and `critical` a critical alert, which rings even in silent mode
once the app has that permission. `url` opens on tap, `group` gathers notifications, which Bark can mute
by group, and a message with the same `key` replaces the notification.

| Parameter | Keep as | Meaning |
|---|---|---|
| `KEY` | secret | The device key Bark's app shows. Whoever has it can push to the device |
| `SERVER` | variable, optional | A Bark server of your own, e.g. `https://bark.example.com`. Defaults to `https://api.day.app` |
| `ENCRYPTION` | variable, optional | `AES128-GCM`, `AES192-GCM`, `AES256-GCM` or the same with `CBC`: encrypts each push end to end |
| `ENCRYPTION_KEY` | secret, optional | The key set in Bark's encryption settings, 16, 24 or 32 ASCII characters to match `ENCRYPTION` |

- A channel pushes to one device. To reach several, configure a channel for each and name them all in
  `channels`.
- Without encryption, Bark's server and Apple's push service see each notification as sent. With it, they
  see the device key, the `key` digest, which the server replaces by, and ciphertext only the device can
  decrypt. Set the same algorithm, mode and key in the app; its IV does not matter, since each push
  carries a fresh one. Prefer GCM, which also detects tampering. The app's ECB is not offered. A push the
  app cannot decrypt shows as *Decryption Failed*.
- `key` reaches Bark as a digest, so a key of any length works. Replacing needs Bark 1.5.2 and
  bark-server 2.2.5 or later.
- Apple takes at most 4 KB per push, so a longer message fails, as `HTTP 500`; encrypted, about a quarter
  less fits.
- A refused push fails as e.g. `HTTP 400`, without the server's text, which can name the key. A wrong
  `ENCRYPTION` or `ENCRYPTION_KEY` fails without pushing.

### `ntfy`

Publishes to a topic on [ntfy](https://ntfy.sh), whose Android, iOS and web apps subscribe to it. `title` is
the notification's title and `text` its message, which `rich`, when given, replaces as Markdown. A
message with only a title shows it as the message, since ntfy fills an empty one with `triggered`.
`level` sets the priority: `low` is 2 (no sound or vibration), `normal` 3, `high` 4 and `critical` 5
(long vibration bursts and a pop-over). `url` opens on tap, and a message with the same `key` replaces
the notification. `group` is not used.

| Parameter | Keep as | Meaning |
|---|---|---|
| `TOPIC` | secret | Up to 64 of `A-Z`, `a-z`, `0-9`, `-` and `_`. Without access control on the server, whoever knows it can read and publish, so make it unguessable |
| `SERVER` | variable, optional | A server of your own, e.g. `https://ntfy.example.com`. Defaults to `https://ntfy.sh` |
| `TOKEN` | secret, optional | An access token (`tk_...`) for a server or topic that requires one |

- ntfy.sh needs no account. It limits each publisher, by IP address unless a token names an account,
  and a Worker shares its addresses with others; a token, or a server of your own, avoids that.
- A message over 4,096 bytes arrives as an attachment, or is refused where the server keeps none.
- `key` reaches ntfy as a digest, so a key of any length works. Replacing needs ntfy server 2.16 or
  later.
- iOS gets instant notifications through ntfy.sh's push relay, also for a server of your own, which then
  passes ntfy.sh only the message's ID.
- A refused publish fails as e.g. `HTTP 403`, without the server's text.

### `slack`

Posts to a Slack channel through an
[incoming webhook](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks), always the
channel it was created for. `title` is a header, and the text the notification shows; `text` a
plain-text section, which `rich`, when given, replaces; `url` a link below them. `rich` is Slack's own
[mrkdwn](https://docs.slack.dev/messaging/formatting-message-text), not Markdown, passed on as written,
so a mention such as `<!channel>` in it notifies. Slack has nothing `level`, `key` or `group` could map
to.

| Parameter | Keep as | Meaning |
|---|---|---|
| `URL` | secret | The webhook URL, `https://hooks.slack.com/services/...`. Whoever has it can post to the channel |

- Slack refuses a header over 150 characters, and `text` or `rich` over 3,000.
- Slack takes about one post a second per webhook. A 429 is retried as for every channel.
- A refused post fails as e.g. `HTTP 400`, without Slack's text.

### `discord`

Posts an embed to a Discord channel through a
[webhook](https://discord.com/developers/docs/resources/webhook#execute-webhook), always the channel it
was created for. `title` is the embed's title, linked to `url` when one is given, and `text` its
description, which `rich`, when given, replaces. Discord renders Markdown in both, so the title and
`text` are escaped to show as written; `rich` is
[Discord's Markdown](https://support.discord.com/hc/articles/210298617), passed on as written. `level`
colours the embed grey, blue, orange or red, and a `low` message goes silently, without a push or
desktop notification. `key` and `group` are not used.

| Parameter | Keep as | Meaning |
|---|---|---|
| `URL` | secret | The webhook URL, `https://discord.com/api/webhooks/...`. Whoever has it can post to the channel. With `?thread_id=...` appended, it posts into that thread |

- The relay sets `wait=true` on the URL, so a post counts as delivered only once Discord has saved the
  message; without it, Discord answers success even for one it dropped.
- A mention in `rich`, such as `<@123>`, shows but notifies no one: Discord never notifies of mentions in
  an embed.
- Discord refuses a title over 256 characters and a description over 4,096; the escapes in the title
  and `text` count.
- Members who turned off *Show embeds and preview website links* in their settings see the post empty.
- A 429 is retried as for every channel. Discord also blocks, for a while, an IP address that makes too
  many refused requests, and a Worker shares its addresses with others, so it may meet a 429 it did not
  cause; the container on a host of its own avoids that.
- A deleted webhook answers `HTTP 404`, and posting to it again and again gets the address blocked too,
  so remove a channel whose webhook is gone.
- A refused post fails as e.g. `HTTP 400`, without Discord's text.

### `feishu`

Posts a card to a [Feishu](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot) or Lark
group through a custom bot, always the group it was added to. `title` is the card's header, and the
preview the chat list shows; `text` a plain-text block, which `rich`, when given, replaces; `url` the link
the card opens when tapped. `rich` is the card's own
[Markdown](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/content-components/rich-text),
passed on as written, so a mention such as `<at id=all></at>` in it notifies; Feishu refuses a post
mentioning all where the group does not allow it. `level` colours the header grey, blue, orange or
red. `key` and `group` are not used.

| Parameter | Keep as | Meaning |
|---|---|---|
| `URL` | secret | The bot's webhook URL, `https://open.feishu.cn/open-apis/bot/v2/hook/...`, or `https://open.larksuite.com/...` for Lark. Whoever has it can post to the group |
| `SECRET` | secret, optional | The bot's signing secret, when it has *signature verification* on. Each post is signed with the time, which must be within an hour of Feishu's |

- Feishu answers 200 for a refused post, with the reason in a code, so a failure reads e.g. `code 19024`:
  `19021` a wrong signature or clock, `19022` an address outside the bot's IP allowlist, `19024` no
  configured keyword in the message, `9499` a malformed post. With *custom keywords* on, the sender must
  put one in the title, `text` or `rich`. An IP allowlist cannot name a Worker, whose addresses are shared
  and change.
- The card needs Feishu 7.20 or later; older clients show only the header.
- A bot takes 100 posts a minute and 5 a second, and the whole post may be 20 KB. Code `11232`, Feishu
  being busy, is retried once after a second.

## Platforms

The relay is the same on every platform: the same endpoints, settings and channels.

### Cloudflare Workers

`wrangler.jsonc` holds nothing deployment-specific. Variables are passed at deploy time and secrets are
set on the Worker:

```bash
npm ci
npx wrangler deploy --var CHANNEL_LOGS_TYPE:loki --var CHANNEL_LOGS_URL:https://... --var CHANNEL_LOGS_USER:123456
npx wrangler secret put CHANNEL_LOGS_TOKEN
npx wrangler secret put TOKEN_GITHUB
```

- wrangler removes variables a deploy does not mention, so pass every `--var` on every deploy (or keep
  them in a config of your own).
- Secrets cannot be set on a Worker that does not exist yet, which is why none are listed under
  `secrets.required`: the first deploy succeeds, then `/healthz` stays 503 until the secrets are in.
- `workers_dev` and preview URLs are off and no routes are declared. Attach a custom domain yourself
  (dashboard, Terraform, or `routes` in your own config); deploys then leave it alone.
- A custom domain answers plain HTTP too, and passes it to the Worker, unless the zone's *Always Use
  HTTPS* is on.

### Node

An HTTP server on Node 24 or later, built into one file with no dependencies:

```bash
npm ci
npm run build:node
PORT=8080 TOKEN_GITHUB=nr_... CHANNEL_LOGS_TYPE=loki CHANNEL_LOGS_URL=https://... ... node dist/node/index.mjs
```

- Settings are environment variables with the same names as on Workers. Every `TOKEN_*` variable is a
  sender token and every `CHANNEL_*_TYPE` declares a channel, so keep other variables of those shapes out
  of the process's environment.
- `PORT` is where it listens, 8080 by default, over plain HTTP: put a proxy or load balancer that
  terminates TLS in front of it.
- `SIGTERM` or `SIGINT` stops new connections; requests in flight finish first.
- Unlike a Worker, it can reach hosts on a private network, and port 25 where the host allows it.

### Docker

The Node server in an image of its own: `node:24-alpine` and the one bundled file, run as `node`, not
root. It runs wherever containers do, such as Cloud Run, Fly.io, Railway, Render, ECS or Kubernetes.

Each commit on `main` that passes CI is published for linux/amd64 and linux/arm64 as
`ghcr.io/therank/notify-relay:sha-<commit>`, and as `latest` while it is the newest:

```bash
docker run --publish 8080:8080 --env-file relay.env ghcr.io/therank/notify-relay:latest
```

- `relay.env` holds the settings, one `NAME=value` per line. Docker takes each value as written, quotes
  included.
- It serves plain HTTP, as on Node. Platforms such as Cloud Run terminate TLS in front of it; with
  `docker run`, a proxy has to.
- `latest` moves with every merge; pin `sha-<commit>` where a deploy must be repeatable.
- To build it yourself: `docker build --tag notify-relay .`. The base image is pinned by digest, and
  Dependabot proposes its updates weekly.
- Its `HEALTHCHECK` probes `/healthz`, so a relay that is not ready shows as unhealthy. A platform that
  probes on its own can point at `/healthz` as well.

#### Cloud Run

Cloud Run deploys public GHCR images directly. A Cloud Run function is a Cloud Run service built from
source and billed the same way, so on Google Cloud the image is also the serverless deploy:

```bash
gcloud run deploy notify-relay --image ghcr.io/therank/notify-relay:sha-<commit> \
    --region <region> --allow-unauthenticated --env-vars-file relay.env \
    --startup-probe httpGet.path=/healthz
```

- Settings come from the same `relay.env` as `docker run`, without `PORT`, which Cloud Run sets itself.
  gcloud reads a file ending in `.env` with python-dotenv, which, unlike Docker, drops quotes and a
  trailing ` #` comment and expands `${NAME}`; plain values mean the same to both.
- `--allow-unauthenticated` leaves authentication to the relay's tokens.
- Cloud Run ignores the image's `HEALTHCHECK` and by default only waits for the port to open. The startup
  probe holds a revision back until `/healthz` answers 200, so a deploy with incomplete settings fails
  instead of taking traffic.
- Each revision keeps the image it was deployed with, and Cloud Run caches GHCR images for up to an hour,
  so deploy a `sha-<commit>`. For higher availability, Google recommends pulling through an Artifact
  Registry remote repository.
- Google Cloud blocks port 25. A private network is reachable through Direct VPC egress or a connector.

### AWS Lambda

A function behind a Function URL or an HTTP API, which send events in payload format 2.0. REST APIs send
1.0, which the relay answers with a 500.

```bash
npm ci
npm run build:lambda
(cd dist/lambda && zip ../lambda.zip index.mjs)
aws lambda create-function --function-name notify-relay --runtime nodejs24.x --handler index.handler \
    --zip-file fileb://dist/lambda.zip --role <execution role ARN> \
    --timeout 30 --environment file://env.json
aws lambda create-function-url-config --function-name notify-relay --auth-type NONE
aws lambda add-permission --function-name notify-relay --statement-id function-url \
    --action lambda:InvokeFunctionUrl --principal '*' --function-url-auth-type NONE
aws lambda add-permission --function-name notify-relay --statement-id function-invoke \
    --action lambda:InvokeFunction --principal '*' --invoked-via-function-url
aws lambda put-function-concurrency --function-name notify-relay --reserved-concurrent-executions <n>
```

- Settings are the function's environment variables, as on Node: `env.json` is
  `{"Variables": {"TOKEN_GITHUB": "nr_...", ...}}`. Lambda allows 4 KB of them in all.
- `--auth-type NONE` leaves authentication to the relay's tokens; with `AWS_IAM`, senders would have to
  sign their requests. The two `add-permission` statements are the resource policy a public URL needs,
  which the console creates by itself; without either, the URL answers 403.
- The timeout must cover the slowest delivery: up to 5 seconds per channel attempt, with fallbacks tried
  one after another. Lambda's default of 3 seconds is too short.
- Every request is an invocation, one without a token too, and draws on the concurrency the account
  shares among all its functions in the region, 1,000 by default. Reserving `n` caps the relay at `n`
  and sets those aside for it, so a flood throttles only the relay. Lambda keeps 100 unreserved, so an
  account still on the lower quota AWS gives new accounts cannot reserve any yet; skip that command
  until AWS raises it.
- A function reaches a private network only from inside a VPC, and AWS blocks port 25 unless asked.

### Azure Functions

An HTTP function on the Node.js v4 programming model, in the Flex Consumption plan. `npm run build:azure`
writes the deploy package to `dist/azure`: the bundle, which holds `@azure/functions`, and the
`host.json` and `package.json` the host reads.

```bash
npm ci
npm run build:azure
(cd dist/azure && zip ../azure.zip host.json package.json index.js)
az functionapp create --name <app> --resource-group <group> --storage-account <account> \
    --flexconsumption-location <region> --runtime node --runtime-version 24 \
    --https-only true --maximum-instance-count <n>
az functionapp config appsettings set --name <app> --resource-group <group> \
    --settings FUNCTIONS_REQUEST_BODY_SIZE_LIMIT=1048576 @settings.json
az functionapp deployment source config-zip --name <app> --resource-group <group> --src dist/azure.zip
```

- Settings are the app's application settings, which the function sees as environment variables, as on
  Node: `settings.json` is `{"TOKEN_GITHUB": "nr_...", ...}`, with every value a string.
- The function takes every path and method under the app's root, without the usual `/api` prefix, and
  as `anonymous`, leaving authentication to the relay's tokens.
- An app accepts plain HTTP unless created with `--https-only true`, which redirects it to HTTPS.
- Every request is an execution, one without a token too, and the app scales out with them, to 100
  instances by default. `--maximum-instance-count` caps that; `az functionapp scale config set` changes
  it later.
- The host reads a body that comes with a length into memory before the function runs, up to 100 MB by
  default. `FUNCTIONS_REQUEST_BODY_SIZE_LIMIT` bounds that: up to 1 MB, a body over 64 KB still gets the
  relay's 413; past it, the host answers an empty 500. A chunked body streams to the function, which
  turns on HTTP streams because the host would otherwise hand it over empty.
- A private network, and port 25 on the subscription types Azure allows it, are reachable only through
  virtual network integration.

## Development

TypeScript, with no runtime dependencies, except that the Azure bundle holds `@azure/functions`, through
which the host calls a function. The core (`src/app.ts`, `src/core`, `src/inbound`, `src/outbound`) uses
only web-standard APIs such as `fetch`, `crypto` and streams. Each platform's entry under
`src/platforms` adapts its runtime to the core and passes in a TCP `connect`: `cloudflare:sockets` on
Workers, `node:net` and `node:tls` on Node, Lambda and Azure. The toolchain (wrangler, esbuild, vitest
with Cloudflare's plugin, typescript) is development-only. Node 24.

```bash
npm ci
npm test            # vitest: the core on both Workers (Miniflare) and Node, and each platform's own
npm run typecheck   # wrangler types, then tsc over src and test, with Workers' types and with Node's
npm run build       # bundles for Workers (wrangler deploy --dry-run, no credentials), Node, Lambda, Azure
npm run dev         # a local Worker
```

`worker-configuration.d.ts` is generated by `wrangler types` and not committed, since it changes with
every wrangler release. Outbound adapters get `fetch` and `connect` passed in, so tests assert on what a
fake `fetch` or a scripted fake server receives instead of mocking globals. The Node tests need `openssl`
on the path, to make a throwaway certificate. `test/docker/smoke.sh <image>` runs a built image as a
deployment would and checks it serves, runs as a user other than root, passes its `HEALTHCHECK` and stops
cleanly on `docker stop`. `test/lambda/smoke.sh [dist/lambda]` runs the Lambda bundle in AWS's Node 24
base image, whose Runtime Interface Emulator invokes it as Lambda would. `test/azure/smoke.sh
[dist/azure]` runs the Azure package in Microsoft's Functions host image for Node 24, with bodies sent
with a length and chunked, and one past the host's limit.

`npm run test:live` sends through real channels instead: a Loki push that it then reads back, an ntfy
message on a fresh topic on ntfy.sh, read back with its priority, Markdown and sequence ID, mail to one
SMTP server, plain text over 587 and HTML over 465, and HTML mail through the Gmail API. Mail passes once
it shows up in the recipients' mailbox, among the newest mail read over IMAP on 993, so `LIVE_SMTP_TO`
and `LIVE_GMAIL_TO` must both deliver there. That mailbox may be the sender's own: folders that may hold
the sender's copy (sent, drafts, trash, and virtual ones such as all mail) are skipped. Landing in junk
still passes, with a warning. It also checks that the relay refuses a request without a token and a body
over 64 KB, and takes one sent chunked. Each body links the commit and the run. It needs `LIVE_LOKI_URL`,
`LIVE_LOKI_USER` and `LIVE_LOKI_TOKEN` (`logs:write` and `logs:read`); `LIVE_SMTP_HOST`,
`LIVE_SMTP_USER`, `LIVE_SMTP_PASSWORD`, `LIVE_SMTP_FROM` and `LIVE_SMTP_TO`; `LIVE_GMAIL_CLIENT_ID`,
`LIVE_GMAIL_CLIENT_SECRET`, `LIVE_GMAIL_REFRESH_TOKEN`, `LIVE_GMAIL_FROM` and `LIVE_GMAIL_TO`; and
`LIVE_IMAP_HOST`, `LIVE_IMAP_USER` and `LIVE_IMAP_PASSWORD`. With `LIVE_BARK_KEY` set, it also pushes
through Bark to that device, in a group of its own; nothing reads the push back, so the test passes once
Bark's server accepts it, and the phone shows the rest. With `LIVE_BARK_ENCRYPTION` and
`LIVE_BARK_ENCRYPTION_KEY` too, as set in the app, a second push goes encrypted, as `bark-sealed`; the
phone shows *Decryption Failed* if it cannot decrypt it. With `LIVE_SLACK_URL`, it posts mrkdwn and a
link to that webhook's channel, with `LIVE_DISCORD_URL` an embed with Markdown, and with
`LIVE_FEISHU_URL` a card with Markdown to that bot's group, signed with `LIVE_FEISHU_SECRET` when the
bot verifies signatures; likewise, only the channel shows the result. With `LIVE_IMAGE` naming an image,
the relay under test is a container of it, given the same settings, instead of the Worker. The
[Live](.github/workflows/live.yml) workflow runs it both ways on `main`, weekly and by hand.

To test a deployment instead, set `LIVE_RELAY_URL` to its URL and `LIVE_RELAY_TOKEN` to a token of its
own, and `LIVE_NTFY_TOPIC` to an unguessable topic for its ntfy channel; `LIVE_TARGET` names it in the
messages, its host by default. The deployment needs the same settings, with that token as `TOKEN_LIVE`.
`node test/live/settings.ts` prints them from the `LIVE_*` variables in the form a platform takes: `env`
for `relay.env`, `json` for Azure's `settings.json` or `wrangler secret bulk`, and `lambda` for
`env.json`:

```bash
export LIVE_RELAY_TOKEN=nr_... LIVE_NTFY_TOPIC=notify-relay-live-$(openssl rand -hex 16)
node test/live/settings.ts lambda > env.json
LIVE_RELAY_URL=https://... LIVE_TARGET=Lambda npm run test:live
```

The file holds every secret the live test has; delete it, and the deployment, when done.

### Adding an adapter

- Inbound: implement `Inbound` (`parse(body) → Draft[]`, throwing `BadRequest` on invalid input) and map
  a path to it in `src/app.ts`.
- Outbound: implement `Outbound` (`type`, `params`, `send(message, params, ctx)`) and register it in
  `src/outbound/index.ts`. `send` gets the channel's own parameters, never the environment; `params` is
  what a channel of the type must configure and what `/healthz` checks; `optional` lists the ones it may
  configure, passed when set and never checked. A type that takes recipients implements
  `recipients(value, params)`, returning why it refuses an entry of `to`, and reads its own entry as
  `message.to?.[ctx.channel]`. `TYPE` is reserved.
- Platform: add an entry under `src/platforms` that turns the platform's request into a `Request` and
  calls `handle(request, env, deps)`, with the platform's settings as `env`, and `fetch`, `connect`, `now`
  and `sleep` in `deps`. `connect` provides `Connection` from `src/core/deliver.ts`, the part of
  Cloudflare's sockets API that `smtp` uses.

### Contract

The message format only grows: new optional fields are fine, changing or removing fields is not. A
format that needs an incompatible change gets a new endpoint instead.

## Security

See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
