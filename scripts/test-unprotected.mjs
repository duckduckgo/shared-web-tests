import { createRequire } from 'node:module';
const localRequire = createRequire(import.meta.url);
const selenium = localRequire('selenium-webdriver');

const configPath = process.argv[2];
console.log(`Config: ${configPath}`);

const driver = await new selenium.Builder()
    .usingServer('http://localhost:4444')
    .withCapabilities({ 
        browserName: 'duckduckgo',
        'ddg:privacyConfigPath': configPath
    })
    .build();

await driver.get('https://www.publisher-company.site/product.html?p=12');
await driver.sleep(3000);
console.log(`Page: ${await driver.executeScript('return location.href')}`);
console.log('');

// Check page content for blocked status
const pageContent = await driver.executeScript('return document.body.innerText');
console.log('Page tracker status:');
const lines = pageContent.split('\n').filter(l => l.includes('blocked') || l.includes('ad-company'));
lines.forEach(l => console.log(`  ${l}`));

await driver.quit();
console.log('\nDone');
