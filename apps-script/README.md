# Apps Script source

This directory is populated from the bound Apps Script project with:

```powershell
npm run script:pull
```

Apps Script publishes the existing Google Sheet as the dashboard and a read-only JSON/JSONP endpoint for the modern `docs/` frontend. TinyGS ingestion is handled by `scripts/tinygs-sync.mjs` because the TinyGS endpoint does not return reliably to Google `UrlFetchApp` infrastructure.
