# TimeTree ICS Exporter

Standalone CLI that logs into your own [TimeTree](https://timetreeapp.com/)
account and exports a calendar to a standard `.ics` file, so you have a real
backup file instead of only a live subscription link.

Unrelated to the momentum screener in the rest of this repo - it's bundled
here only because that's where this session's work landed. It's a Node/TS
reimplementation of the ideas in the community project
[TimeTree-exporter](https://github.com/eoleedi/TimeTree-exporter) (Python),
rewritten from scratch to fit this repo's toolchain (Node 20+, `tsx`, no new
runtime dependencies beyond `@types/node` for editor/type support).

> **Unofficial and unsupported.** This scrapes TimeTree's undocumented web-app
> API (the same one their own web client uses). TimeTree does not support or
> endorse this, and the API can change or break without notice. Your
> credentials are sent directly to `timetreeapp.com` over HTTPS to obtain a
> session cookie - never to any third-party server - and are never written to
> disk or logged.

## Usage

```bash
npm install   # once, to pick up @types/node
npm run timetree:export -- --calendar-code YOUR_CODE --output ./timetree.ics
```

You'll be prompted for your email and password (input is masked), or set
them up front:

```bash
export TIMETREE_EMAIL="you@example.com"
export TIMETREE_PASSWORD="..."
npm run timetree:export -- --calendar-code YOUR_CODE
```

The calendar code is the part of your calendar's TimeTree URL after
`/calendars/`. If you omit `--calendar-code` and your account has exactly one
calendar, that one is used automatically; otherwise the tool lists your
calendars (with their codes) so you can pick one.

### Options

| Flag | Purpose |
|---|---|
| `-o, --output <path>` | Output `.ics` path (default `./timetree.ics`) |
| `-e, --email <email>` | Login email (else `TIMETREE_EMAIL` env or prompt) |
| `-c, --calendar-code <c>` | Calendar to export |
| `--list-labels` | Print the calendar's labels and exit |
| `--split-by-label` | Write one `.ics` file per label instead of one combined file |
| `--include-comments` | Also export per-event comments (extra request per event) |
| `--include-images` | Download per-event images into `timetree_images/` next to the output, plus a `timetree_images.json` manifest (extra request per event) |
| `--num-workers <n>` | Concurrency for the per-event comment/image requests (default 10) |
| `-v, --verbose` | Extra log output |

`--include-comments` and `--include-images` each make one additional request
per event, so a calendar with many events will take noticeably longer and is
more likely to hit TimeTree's rate limits.

## Known limitations

- **Private calendars only.** TimeTree's public (shareable, no-login)
  calendars use a different API response shape and aren't implemented here -
  use TimeTree's own iCal subscription link for those instead.
- **Recurring, non-all-day events and DST.** Event times are emitted as
  absolute UTC instants (there's no embedded `VTIMEZONE` block). For a
  one-off event this is exactly correct. For a *recurring* event whose
  series crosses a daylight-saving change, the wall-clock time of later
  occurrences can shift by the DST offset, since the recurrence is anchored
  to a fixed UTC time rather than a floating local time.
- Birthday events and memos are skipped, matching TimeTree's own web app
  behavior for calendar exports.
