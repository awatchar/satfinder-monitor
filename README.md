# SatFinder Monitor

This repository connects three managed resources without requiring ongoing browser automation:

- Google Sheet: `SatFinder Worldmonitor`
- Bound Google Apps Script project: `SatFinder Worldmonitor`
- GitHub repository: `awatchar/satfinder-monitor`

## One-time Google setup

1. Enable the Google Apps Script API in Apps Script user settings.
2. In one standard Google Cloud project, enable Google Sheets API and Apps Script API.
3. Configure the OAuth consent screen and create a **Desktop app** OAuth client.
4. Download its JSON to `.secrets/oauth-client.json`.
5. Install dependencies and authorize the account:

```powershell
npm.cmd install
npm.cmd run google:auth
```

OAuth client secrets, refresh tokens, and API backups are excluded by `.gitignore`.

## Automatic TinyGS refresh

TinyGS does not respond to a plain request to `/v3/stations`. Its web app adds a short-lived `x-client-timestamp` header to each request. The local API worker reproduces that public request contract, validates the response, filters `SatFinder`/`SatFider` stations, and updates `SatFinder_Stations` through Google Sheets API:

```powershell
npm.cmd run tinygs:sync -- --yes
```

The production worker is defined in `.github/workflows/tinygs-sync.yml` for every six hours in the `Asia/Bangkok` timezone. Its Google authorized-user credential is stored only in the encrypted repository secret `GOOGLE_AUTHORIZED_USER_JSON`. Because TinyGS may block anonymous cloud-runner traffic, scheduled cloud execution is enabled only when the repository variable `TINYGS_CLOUD_ENABLED` is `true`; store an official TinyGS API token as the encrypted secret `TINYGS_BEARER_TOKEN` before enabling it. The worker does not use Chrome, browser cookies, or TinyGS login state.

Run the same worker locally when needed:

```powershell
npm.cmd run tinygs:sync -- --yes
Get-Content -Raw .data\tinygs-last-run.json
```

## Google Sheets API

Read workbook metadata and values:

```powershell
npm.cmd run sheet:info
npm.cmd run sheet:read
npm.cmd run sheet:read -- --range "Config!A1:C20"
```

Writes require an explicit `--yes` and automatically back up the previous range under `.api-backups/`:

```powershell
npm.cmd run sheet:write -- --range "Config!B2" --value "SatFinder" --yes
npm.cmd run sheet:clear -- --range "Config!A12:C14" --yes
```

## Apps Script API

Direct API sync:

```powershell
npm.cmd run script:pull
npm.cmd run script:push -- --yes
```

`script:push` replaces the complete remote project, matching Google's API behavior. It therefore requires `--yes` and saves a complete remote backup before updating.

## GitHub

The local `main` branch tracks `https://github.com/awatchar/satfinder-monitor.git`. GitHub API access is available through the connected GitHub integration; local Git credentials are never stored in this repository.

The modern static monitor is under `docs/` and is deployed by `.github/workflows/pages.yml`. The deployment refreshes a compact, read-only Google Sheets snapshot every six hours. Browsers load that same-origin snapshot immediately and keep a local fallback copy, so a temporary Apps Script delay does not leave the dashboard empty. TinyGS and Google OAuth credentials are never sent to the browser.
