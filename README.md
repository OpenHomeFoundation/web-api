# web-api

Public web API for [openhomefoundation.org](https://www.openhomefoundation.org).

It currently serves the livestream status of the Open Home Foundation's YouTube
channels — Home Assistant, ESPHome, Open Home Foundation and Music Assistant —
so the project websites can show upcoming, live and recently-ended streams, and
the events of the foundation's Luma calendars, read from their iCalendar feeds,
so the sites can show meetups and other community events.

Built to the [OHF engineering standards](https://standards.openhomefoundation.org):
NestJS on Node LTS, TypeScript in strict mode, pnpm, and Mise for task running.

## Quick start

```bash
mise run setup   # install dependencies and create .env from example.env
mise run dev     # start the server in watch mode on http://localhost:3000
```

Without Mise, `./script/setup` and `./script/server` do the same thing.

Then fill in `YOUTUBE_API_KEY` in `.env` — see [Configuration](#configuration).
Without it the endpoints stay reachable but every channel reports `none`.

## API

Interactive documentation is generated from the code and served at
[`/docs`](http://localhost:3000/docs), with the OpenAPI document itself at
`/docs-json` (and `/docs-yaml`).

| Method | Path                | Description                                       |
| ------ | ------------------- | ------------------------------------------------- |
| `GET`  | `/livestream`       | Livestream status for every configured channel    |
| `GET`  | `/livestream/:slug` | Status for one channel; `404` for an unknown slug |
| `GET`  | `/events`           | Every configured Luma calendar with its events    |
| `GET`  | `/events/:slug`     | One calendar's events; `404` for an unknown slug  |
| `GET`  | `/__heartbeat__`    | Application health probe                          |
| `GET`  | `/__lbheartbeat__`  | Load-balancer probe                               |
| `GET`  | `/__version__`      | Running build's version and commit                |

A livestream entry looks like this:

```json
{
  "channel": "home-assistant",
  "channelName": "Home Assistant",
  "status": "upcoming",
  "title": "Home Assistant 2026.8 Release Party",
  "url": "https://www.youtube.com/watch?v=Pu7JLCxZmaI",
  "startTime": "2026-08-05T19:00:00Z",
  "updatedAt": "2026-07-28T12:38:57.580Z"
}
```

`status` is one of `live`, `upcoming`, `past` (ended within the last 24 hours) or
`none`. `title`, `url` and `startTime` are present only when there is a stream to
describe. `updatedAt` changes only when the reported state changes, so it is safe
to use for caching and change detection.

An events calendar entry looks like this:

```json
{
  "calendar": "home-assistant-meetups",
  "calendarName": "Home Assistant Meetups",
  "events": [
    {
      "id": "evt-HJ5eO3aJOiCob3z@events.lu.ma",
      "summary": "Dublin - Hosted by the OHF",
      "start": "2026-06-04T17:30:00.000Z",
      "end": "2026-06-04T20:30:00.000Z",
      "description": "Get up-to-date information at: https://luma.com/n5mzdtvb",
      "location": "26 Wexford St, Portobello, Dublin, D02 HX93, Ireland",
      "url": "https://luma.com/n5mzdtvb",
      "host": "Missy Quarry",
      "address": ["26 Wexford St", "Dublin 8, County Dublin", "Ireland"],
      "latitude": 53.336691,
      "longitude": -6.26573,
      "status": "tentative"
    }
  ],
  "updatedAt": "2026-08-18T12:00:00.000Z"
}
```

Events are everything the calendar's Luma feed advertises — past ones included,
sorted soonest first — so the consumer decides the window it shows. Times are
UTC; an all-day event carries a bare `YYYY-MM-DD` date instead. `url` is the
event's Luma page, and `host` is who is hosting — both lifted from the feed's
templated description, which is the only place Luma carries them. `address` is
the venue as that description's `Address:` block lists it, one line per array
item; it is always present, and `[]` both when the feed carries no such block
and when the block only holds Luma's "Check event page for more details."
no-venue placeholder. As with livestreams, `updatedAt` moves only when the
served content changes.

Every response carries the security headers [helmet](https://helmetjs.github.io)
applies by default, including a `Content-Security-Policy`, `nosniff`, and HSTS.
The defaults are used unchanged; `test/security.e2e-spec.ts` asserts them and
checks that the policy still fits what the Swagger UI at `/docs` needs.

Reads are open to no one by default and to the origins in `CORS_ORIGINS` when it
is set — the same list the Socket.IO endpoint honours, which refuses a handshake
from an origin that is not on it. A `404` reports only that the channel or
calendar is unknown, without repeating the requested slug back. Rate limiting belongs to
Cloudflare in front of this service, not to the app — see
[Configuration](#configuration).

## Configuration

Configuration is environment variables only. `example.env` documents every one;
copy it to `.env` for local development (`.env` is gitignored and must never be
committed). In production these are set on the container.

| Variable              | Required | Purpose                                             |
| --------------------- | -------- | --------------------------------------------------- |
| `YOUTUBE_API_KEY`     | yes      | YouTube Data API v3 key, used to classify videos    |
| `LIVESTREAM_CHANNELS` | yes      | Channels to track, as `handle:slug` pairs           |
| `EVENTS_CALENDARS`    | yes      | Luma calendars to serve, as `calendarId:slug` pairs |
| `CORS_ORIGINS`        | no       | Sites allowed to read the API from a browser        |
| `PORT`                | no       | Listen port, defaults to `3000`                     |

`LIVESTREAM_CHANNELS` is a comma-separated list of `handle:slug` pairs:

```
LIVESTREAM_CHANNELS=home_assistant:home-assistant,esphomeio:esphome
```

- `handle` is the YouTube handle used to find the channel, with or without `@`.
- `slug` is the path this API serves the channel under (`/livestream/<slug>`) and
  the `channel` field in the response. It is pinned in configuration rather than
  derived from the channel's YouTube name, so renaming a channel on YouTube
  cannot silently change our public URLs.

Display names are read from each channel's feed at runtime, so they are not
configured. Adding or removing a project is a configuration change, not a code
change. Malformed configuration fails startup rather than silently tracking
nothing.

`EVENTS_CALENDARS` works the same way for Luma calendars, as a comma-separated
list of `calendarId:slug` pairs:

```
EVENTS_CALENDARS=cal-6Tm2FkWzoBpLXWr:home-assistant-meetups
```

- `calendarId` is the Luma calendar ID the iCalendar feed is fetched by
  (`api.luma.com/ics/get?entity=calendar&id=<calendarId>`).
- `slug` is the path this API serves the calendar under (`/events/<slug>`) and
  the `calendar` field in the response — pinned in configuration for the same
  reason channel slugs are.

Calendar display names come from each feed's `X-WR-CALNAME` at runtime. The
feeds are public, so no API key is involved; they are re-fetched every 15
minutes, and a calendar whose fetch fails keeps serving what it served before.

`CORS_ORIGINS` is a comma-separated list of the origins allowed to read the API
from a browser — the sites that consume it are deployed separately, so this is
configuration too:

```
CORS_ORIGINS=https://openhomefoundation.org,https://*.openhomefoundation.org
```

Each entry is a scheme and host (with a port if it is not the default) and
nothing else, since that is all a browser's `Origin` header carries. A leading
`*.` label covers every subdomain of a domain at any depth — `https://*.esphome.io`
allows `www.esphome.io` and `a.b.esphome.io`, but not the bare `esphome.io`, so
list the domain itself as well if it serves pages. It will not match a lookalike
such as `evil-esphome.io`. Use `*` on its own to allow any origin.

Left unset, no cross-origin headers are sent: the
API still answers every request, but a browser will not hand the response to a
page on another site. As with the channel list, a malformed entry fails startup
rather than quietly dropping a site that was meant to be allowed.

The same list governs the Socket.IO endpoint, which refuses a handshake from an
origin that is not on it. That check runs on the handshake itself rather than
through socket.io's CORS option, because a WebSocket upgrade is not subject to
CORS at all — without it, the socket transport would be the way around the
allow-list. A client that sends no `Origin` header, which is anything that is not
a browser, is still accepted, exactly as it is over HTTP.

Rate limiting is not done here. The service is served through Cloudflare
(`cloudflare_proxy = true` on its DNS record in the `deployments` repository),
which counts requests at the edge where the real client address is visible — a
limit in the app would have to infer that address from a forwarded header, and
one keyed wrongly throttles every visitor against a single shared budget.

## How it works

```
RSS feed (free)  ──▶  discovery sweep  ──┐
                       every 5 min        ├──▶  tracked videos  ──▶  channel status
videos.list (quota) ─▶ reconcile poll  ──┘
                       every 10 s
```

- **Discovery** reads each channel's RSS feed, which costs no API quota, and
  classifies the videos it lists with a `videos.list` lookup. It fingerprints the
  feed and skips that lookup entirely when nothing has changed, so steady-state
  discovery is free.
- **Reconciliation** re-queries only the videos that are live or start within 15
  minutes, which is what catches a stream going live or ending. A tick with
  nothing active issues no requests at all.
- YouTube's push notifications (WebSub) are deliberately **not** used: the hub
  notifies on uploads and metadata edits, not on a broadcast going live, so it
  cannot deliver the signal this service is about.

Events are simpler: one fetch of each calendar's iCalendar feed every 15
minutes, parsed in place — no API key, no quota, no per-event classification.

Architecturally each feature is one Nest module (`src/livestream`, `src/events`)
with a controller over an in-memory state map; there is no database. State is
rebuilt from the upstream feeds on every boot. The low-level upstream calls
live in dedicated client modules (`src/youtube`, `src/luma`) the feature
modules import, so each external API is talked to from exactly one place.

The C4 diagrams in [`docs/architecture`](docs/architecture) say the same thing at
each level the [OHF architecture standards](https://standards.openhomefoundation.org/architecture/c4-documentation/)
ask for — context, containers, components, and the two polling loops as
sequences. Browse them with `mise run diagrams`.

## Development

Tasks are defined in `.mise.toml` and delegate to `script/`, so local runs and CI
execute the same code paths. Run `mise tasks` to list them all.

| Task                | Does                                                          |
| ------------------- | ------------------------------------------------------------- |
| `mise run setup`    | Install dependencies, create `.env` if missing                |
| `mise run update`   | Sync dependencies after pulling                               |
| `mise run dev`      | Start the server in watch mode                                |
| `mise run test`     | Unit and e2e tests                                            |
| `mise run diagrams` | Browse the C4 architecture diagrams                           |
| `mise run ci`       | The full gate: format, lint, typecheck, diagrams, test, build |
| `mise run check`    | Same gate without the container build                         |

Tests are Jest, with Supertest for the HTTP layer. Unit specs live beside the
code as `*.spec.ts`; end-to-end specs live in `test/` as `*.e2e-spec.ts` and boot
a real Nest application with YouTube stubbed at the `fetch` boundary. No test
touches the network.

```bash
pnpm test            # unit
pnpm test:e2e        # end-to-end
pnpm run test:cov    # coverage
```

## Contributing

- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org),
  which drives releases through Release Please. Commits must be signed.
- **Before pushing**, run `mise run ci`. A Husky pre-commit hook runs ESLint and
  Prettier over staged files, and CI re-checks formatting, lint, types and both
  test suites.
- **Dependencies** are updated by Renovate. Nothing published within the last
  seven days is adopted, which is enforced by both Renovate and pnpm as a
  supply-chain measure — so a manual `pnpm add` of a brand-new release will be
  refused.
- **Tests are expected** with behaviour changes. If a test fails after your
  change, treat it as a finding about the change rather than something to edit
  away.

## Deployment

The service ships as a container built by `Dockerfile` (multi-stage, running as a
non-root user, with a `HEALTHCHECK` against `/__heartbeat__`). Pushes to `main`
build and publish the image with a signed build-provenance attestation, and the
release workflow rolls the new version out through Terraform Cloud.
