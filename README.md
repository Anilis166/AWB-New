# AWB Tracker · SiCepat + SPX

Vercel-ready web app based on the SiCepat AWB dashboard, with a second SPX mode. The **SiCepat** option keeps the live tracking/search workflow. The **SPX** option searches candidate AWBs and checks their status against the live SPX tracking API. The web app does not require an access code or login.

## Run locally

```bash
npm ci
npm run build
npx vercel dev --listen 3000
```

Open `http://localhost:3000`. To preview only the static UI, serve the `public/` directory; Vercel API routes will not work on a plain static server.

## SPX live tracking and date search

Select **SPX** in the carrier switcher. The tracking and search fields are the same as SiCepat. Enter known SPX AWBs in **NOMOR RESI** to track them live and filter their tracking history by date/time:

- enter a date (`YYYY-MM-DD`) or month (`YYYY-MM`), and optionally a time (`HH:mm` or `HH:mm-HH:mm`);
- press **Lacak** in the specific-search section. The app checks live SPX tracking history and filters results by the requested date/time.

SPX's tracking endpoint requires a known AWB, so date/time search cannot discover unknown AWB numbers. SPX timestamps are compared in WIB.

## Vercel deployment

Import the `AWB-New` repository as a new Vercel project. Set the build command to `npm run build` and the output directory to `public`. Configure the server-side environment variables listed in `.env.example` in Vercel Project Settings; never put API credentials in frontend files or send them in chat.

The SiCepat live API requires `BITESHIP_SECRET` and Upstash rate-limit variables. Optional Binderbyte and R2-backed music features need their respective values. The previous public source repository contained hard-coded provider/storage credentials; revoke and rotate those credentials before using them in any deployment.

## Tests

```bash
node --test spx-data.test.js
```
