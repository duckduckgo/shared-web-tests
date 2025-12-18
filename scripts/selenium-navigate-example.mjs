import { createRequire } from 'node:module';

const localRequire = createRequire(import.meta.url);

/** @type {typeof import('selenium-webdriver')} */
const selenium = localRequire('selenium-webdriver');

const serverUrl = process.env.WEBDRIVER_SERVER_URL ?? 'http://localhost:4444';
const url = process.argv[2] ?? 'https://example.com';

const driver = await new selenium.Builder().usingServer(serverUrl).withCapabilities({ browserName: 'duckduckgo' }).build();

try {
    await driver.get(url);
    const title = await driver.getTitle();
    console.log(JSON.stringify({ ok: true, url, title }));
} finally {
    await driver.quit();
}
