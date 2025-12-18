import puppeteer from 'puppeteer-core';

const url = process.argv[2];
if (!url) {
    console.error('Usage: node puppeteer_navigate.mjs <url>');
    process.exit(2);
}

const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_BIN || process.env.GOOGLE_CHROME_BIN;

if (!executablePath) {
    console.error('No browser executable configured. Set PUPPETEER_EXECUTABLE_PATH (or CHROME_BIN) to a Chromium/Chrome binary.');
    process.exit(2);
}

const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
    const title = await page.title().catch(() => '');
    process.stdout.write(JSON.stringify({ ok: true, url, title }));
} finally {
    await browser.close();
}
