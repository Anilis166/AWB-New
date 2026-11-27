# AWB Tracker · SiCepat + SPX

Vercel-ready web app based on the SiCepat AWB dashboard, with a second SPX mode. The **SiCepat** option keeps the live tracking/search workflow. The **SPX** option matches local candidate/status snapshots from files selected by the user; it does not call a live SPX tracking API.

## Run locally

```bash
npm ci
npm run build
npx vercel dev --listen 3000
```

Open `http://localhost:3000`. To preview only the static UI, serve the `public/` directory; Vercel API routes will not work on a plain static server.

## SPX snapshot mode

Select **SPX** in the carrier switcher. For date/time search, load:

- a candidate file such as `valid_spx.jsonl` or `candidates.json`;
- enter a date (`YYYY-MM-DD`) or month (`YYYY-MM`), and optionally a time (`HH:mm` or `HH:mm-HH:mm`);
- press **Lacak** in the specific-search section. Candidate AWBs are filtered by their recorded date/time and checked against live SPX tracking history when available.

Alternatively, paste known AWB numbers and use the batch-tracking button. Snapshot JSON files can still be loaded for offline result matching.
The date/month search is limited to AWBs present in the selected candidate file; it does not generate unknown SPX numbers. If an event is older than the history returned by SPX, the search uses the candidate's recorded timestamp. SPX timestamps are compared in WIB.

## Vercel deployment

Import the `AWB-New` repository as a new Vercel project. Set the build command to `npm run build` and the output directory to `public`. Configure the server-side environment variables listed in `.env.example` in Vercel Project Settings; never put API credentials in frontend files or send them in chat.

The SiCepat live API requires `BITESHIP_SECRET` and Upstash rate-limit variables. Optional Binderbyte and R2-backed music features need their respective values. The previous public source repository contained hard-coded provider/storage credentials; revoke and rotate those credentials before using them in any deployment.

## Tests

```bash
node --test spx-data.test.js
```
