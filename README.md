# ARGYNIX Status

The outside monitor and public status page for ARGYNIX. It runs on GitHub, not on
ARGYNIX's servers, so it keeps working — and keeps telling people — when they fail.

- `checks.json` — what is checked. `internal: true` checks alert but stay off the
  public page (backups, certificates).
- `scripts/check.mjs` — the checker (Node 20+, no dependencies). `node scripts/check.mjs --dry-run`
  runs it locally without writing or alerting.
- `.github/workflows/monitor.yml` — runs it every five minutes and commits `data/`.
- `index.html` — the status page, served by GitHub Pages from `data/`.

## Alerts

- **GitHub issues** — a service going down opens an issue labelled `outage`
  (GitHub emails the repository's watchers); coming back closes it.
- **Telegram** (optional) — set the repository secrets `TELEGRAM_BOT_TOKEN` and
  `TELEGRAM_CHAT_ID`.

## Custom domain

To serve the page as `status.argynix.com`: add a DNS `CNAME status → argynix.github.io`,
then set the custom domain in the repository's Pages settings (which writes `CNAME`).
