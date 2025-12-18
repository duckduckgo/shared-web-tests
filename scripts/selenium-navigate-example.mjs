import { createRequire } from 'node:module';

const localRequire = createRequire(import.meta.url);

/** @type {typeof import('selenium-webdriver')} */
const selenium = localRequire('selenium-webdriver');

const args = process.argv.slice(2);
const keepOpen = args.includes('--keep');
const url = args.find((arg) => !arg.startsWith('--')) ?? 'https://example.com';

const serverUrl = process.env.WEBDRIVER_SERVER_URL ?? 'http://localhost:4444';

const driver = await new selenium.Builder().usingServer(serverUrl).withCapabilities({ browserName: 'duckduckgo' }).build();

try {
    await driver.get(url);
    const title = await driver.getTitle();
    console.log(JSON.stringify({ ok: true, url, title }));

    if (keepOpen) {
        console.log('\nBrowser will stay open. Press Ctrl+C to quit.');
        // Keep the process alive
        await new Promise(() => {});
    }
} finally {
    if (!keepOpen) {
        await driver.quit();
    }
}
