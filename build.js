import fs from 'fs';
import path from 'path';

// Generate a build version/timestamp
const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const buildId = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
const formattedDate = `${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

// Update splash footer build info in public/index.html
const htmlPath = path.resolve('public/index.html');
if (fs.existsSync(htmlPath)) {
  let htmlContent = fs.readFileSync(htmlPath, 'utf8');

  // Cache-bust: app.js, style.css — match dengan atau tanpa ?v=...
  htmlContent = htmlContent.replace(
    /src="app\.js(\?[^\"]*)?"/g,
    `src="app.js?v=${buildId}"`
  );
  htmlContent = htmlContent.replace(
    /href="style\.css(\?[^\"]*)?"/g,
    `href="style.css?v=${buildId}"`
  );

  // Update splash footer build info
  htmlContent = htmlContent.replace(
    /<div class="splash-footer">([\s\S]*?)<\/div>/,
    `<div class="splash-footer">v2.1.0 WEB &nbsp;•&nbsp; build ${formattedDate}</div>`
  );

  fs.writeFileSync(htmlPath, htmlContent, 'utf8');
  console.log(`Updated index.html with cache-busting ?v=${buildId}`);
  console.log(`Updated index.html build footer to build ${formattedDate}`);
}

const appJsPath = path.resolve('public/app.js');
if (fs.existsSync(appJsPath)) {
  let appContent = fs.readFileSync(appJsPath, 'utf8');
  appContent = appContent.replace(
    /from\s+["']\.\/guest\.js(?:\?[^"']*)?["']/g,
    `from "./guest.js?v=${buildId}"`
  );
  fs.writeFileSync(appJsPath, appContent, 'utf8');
  console.log(`Updated app.js auth import with cache-busting ?v=${buildId}`);
}
