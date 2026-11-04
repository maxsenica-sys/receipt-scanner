# Receipt Scanner

A phone web app that finds a receipt in the camera, takes the photo itself, flattens it and sends it to the
Season Expenses spreadsheet, where Claude reads it into line items on the Expenses tab.

- **App:** `index.html`, served by GitHub Pages at https://maxsenica-sys.github.io/receipt-scanner/
- **Back end:** `apps-script/Code.gs`, pasted into the spreadsheet's Apps Script project
  (Extensions → Apps Script) and deployed as a web app.

The app holds no secrets. The spreadsheet's web app URL and the scanner key travel in the link after `#`
(never sent to any server) and are remembered on the phone. Every request carries the key and the script
refuses anything without it.

## In-house app (Vercel + Supabase)

The newer version runs on its own: `app/index.html` is the phone app, `api/index.js` is one Vercel function,
receipts and items live in Supabase Postgres (`db/schema.sql`), photos in the private Supabase Storage bucket
`receipts`, and Claude reads each photo directly. The Google Sheet and Drive keep receiving every receipt
as a backup (`record` / `unrecord` in `apps-script/Code.gs`), and a daily job retries any backup that failed.

Vercel environment variables:

| Name | Value |
|---|---|
| `DATABASE_URL` | Supabase → Connect → Transaction pooler connection string |
| `SUPABASE_URL` | `https://<project>.supabase.co` |
| `SUPABASE_SECRET_KEY` | Supabase → Settings → API Keys → secret key |
| `ANTHROPIC_API_KEY` | the same key the Apps Script uses |
| `APP_KEY` | any long random string; the app link is `https://<app>/#k=<APP_KEY>` |
| `GOOGLE_BACKUP_URL` | the Apps Script web app `/exec` URL |
| `GOOGLE_BACKUP_KEY` | the scanner key the Apps Script already uses |
| `CRON_SECRET` | optional |

Tests: `TEST_DATABASE_URL=postgres://... npm test` (API against a real Postgres with stand-ins for storage,
Claude, exchange rates and Google) and `test/browser/e2e.js` (the whole app in Chromium with a fake camera).

## Setup (original Google-only app)

1. Apps Script: replace `Code.gs` with `apps-script/Code.gs`, delete any `Scanner` HTML file, Save.
2. Deploy → Manage deployments → pencil on the web app → Version: **New version**,
   Execute as: **Me**, Who has access: **Anyone** → Deploy.
3. In the spreadsheet (reload it): Receipts → **Set up scanner app**, paste the Web app URL
   (use the Copy button in Manage deployments).
4. Open the link it shows on the phone in Safari or Chrome, allow the camera, Share → Add to Home Screen.

The bar at the top of the app says whether it is connected, and if not, why.
