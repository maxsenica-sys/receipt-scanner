# Receipt Scanner

A phone web app that finds a receipt in the camera, takes the photo itself, flattens it and sends it to the
Season Expenses spreadsheet, where Claude reads it into line items on the Expenses tab.

- **App:** `index.html`, served by GitHub Pages at https://maxsenica-sys.github.io/receipt-scanner/
- **Back end:** `apps-script/Code.gs`, pasted into the spreadsheet's Apps Script project
  (Extensions → Apps Script) and deployed as a web app.

The app holds no secrets. The spreadsheet's web app URL and the scanner key travel in the link after `#`
(never sent to any server) and are remembered on the phone. Every request carries the key and the script
refuses anything without it.

## Setup

1. Apps Script: replace `Code.gs` with `apps-script/Code.gs`, delete any `Scanner` HTML file, Save.
2. Deploy → Manage deployments → pencil on the web app → Version: **New version**,
   Execute as: **Me**, Who has access: **Anyone** → Deploy.
3. In the spreadsheet (reload it): Receipts → **Set up scanner app**, paste the Web app URL
   (use the Copy button in Manage deployments).
4. Open the link it shows on the phone in Safari or Chrome, allow the camera, Share → Add to Home Screen.

The bar at the top of the app says whether it is connected, and if not, why.
