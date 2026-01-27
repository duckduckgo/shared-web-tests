#!/usr/bin/env node
/**
 * Test Config Server
 *
 * Serves a modified privacy configuration via HTTP for testing.
 * The macOS browser can fetch this during config refresh cycles.
 *
 * Usage:
 *   node scripts/serve-test-config.mjs [--port=8899] [--config=path/to/config.json]
 *
 * Default port: 8899
 * Default config: Uses base config from remote-config with Nintendo fix applied
 *
 * To use with macOS browser:
 *   1. Start this server
 *   2. Set custom config URL in UserDefaults:
 *      defaults write HKE973VLUW.com.duckduckgo.macos.browser.app-configuration.debug \
 *        "CustomConfigurationURL.privacyConfiguration" "http://localhost:8899/v4/macos-config.json"
 *   3. Restart the browser
 *
 * Note: For startup testing, use `npm run build:macos-with-fix` instead to bake the config
 * into the app binary.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const metaRoot = path.resolve(projectRoot, '..');

// Parse CLI args
const args = process.argv.slice(2);
const portArg = args.find((a) => a.startsWith('--port='));
const configArg = args.find((a) => a.startsWith('--config='));

const PORT = portArg ? parseInt(portArg.split('=')[1], 10) : 8899;
const customConfigPath = configArg ? configArg.split('=')[1] : null;

/**
 * Load the base macOS config and apply the Nintendo fix
 */
function loadConfigWithFix() {
    // Try to load from remote-config generated output first
    const generatedConfigPath = path.join(metaRoot, 'remote-config/generated/v4/macos-config.json');
    const bundledConfigPath = path.join(
        metaRoot,
        'apple-browsers/macOS/DuckDuckGo/ContentBlocker/Resources/macos-config.json'
    );

    let baseConfig;
    let sourceUsed;

    if (fs.existsSync(generatedConfigPath)) {
        baseConfig = JSON.parse(fs.readFileSync(generatedConfigPath, 'utf-8'));
        sourceUsed = 'remote-config/generated';
    } else if (fs.existsSync(bundledConfigPath)) {
        baseConfig = JSON.parse(fs.readFileSync(bundledConfigPath, 'utf-8'));
        sourceUsed = 'apple-browsers bundled';
    } else {
        throw new Error('No base config found. Run `npm run build` in remote-config first.');
    }

    console.log(`📦 Base config loaded from: ${sourceUsed}`);

    // Apply Nintendo fix - add to unprotectedTemporary
    const nintendoEntry = {
        domain: 'nintendo.com',
        reason: 'Testing - checkout flow breakage investigation',
    };

    // Ensure unprotectedTemporary exists
    if (!baseConfig.unprotectedTemporary) {
        baseConfig.unprotectedTemporary = [];
    }

    // Check if Nintendo is already in the list
    const alreadyExists = baseConfig.unprotectedTemporary.some(
        (entry) => entry.domain === 'nintendo.com' || entry === 'nintendo.com'
    );

    if (!alreadyExists) {
        baseConfig.unprotectedTemporary.push(nintendoEntry);
        console.log('🔧 Added nintendo.com to unprotectedTemporary');
    } else {
        console.log('ℹ️  nintendo.com already in unprotectedTemporary');
    }

    // Also add to feature exceptions for complete protection disabling
    const featuresToExcept = [
        'contentBlocking',
        'autoconsent',
        'gpc',
        'cookie',
        'trackerAllowlist',
        'fingerprintingCanvas',
        'fingerprintingHardware',
        'fingerprintingScreenSize',
    ];

    for (const featureName of featuresToExcept) {
        if (baseConfig.features[featureName]) {
            if (!baseConfig.features[featureName].exceptions) {
                baseConfig.features[featureName].exceptions = [];
            }
            const featureHasNintendo = baseConfig.features[featureName].exceptions.some(
                (e) => e.domain === 'nintendo.com'
            );
            if (!featureHasNintendo) {
                baseConfig.features[featureName].exceptions.push({
                    domain: 'nintendo.com',
                    reason: 'Testing checkout flow',
                });
            }
        }
    }

    // Update version timestamp so the app thinks it's a new config
    baseConfig.version = Date.now();

    return baseConfig;
}

/**
 * Load custom config file
 */
function loadCustomConfig(configPath) {
    const absolutePath = path.isAbsolute(configPath) ? configPath : path.resolve(process.cwd(), configPath);
    if (!fs.existsSync(absolutePath)) {
        throw new Error(`Config file not found: ${absolutePath}`);
    }
    return JSON.parse(fs.readFileSync(absolutePath, 'utf-8'));
}

// Load the config
let config;
try {
    if (customConfigPath) {
        config = loadCustomConfig(customConfigPath);
        console.log(`📄 Custom config loaded from: ${customConfigPath}`);
    } else {
        config = loadConfigWithFix();
    }
} catch (error) {
    console.error(`❌ Failed to load config: ${error.message}`);
    process.exit(1);
}

// Calculate ETag
const configJson = JSON.stringify(config);
const etag = `"${Buffer.from(configJson).length}-${config.version}"`;

// Create HTTP server
const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    console.log(`${new Date().toISOString()} ${req.method} ${url.pathname}`);

    // CORS headers for debugging
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, If-None-Match');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // Serve config at /v4/macos-config.json (matching production URL structure)
    if (url.pathname === '/v4/macos-config.json' || url.pathname === '/macos-config.json' || url.pathname === '/') {
        // Check If-None-Match for caching
        const clientEtag = req.headers['if-none-match'];
        if (clientEtag === etag) {
            res.writeHead(304);
            res.end();
            return;
        }

        res.writeHead(200, {
            'Content-Type': 'application/json',
            ETag: etag,
            'Cache-Control': 'no-cache',
        });
        res.end(configJson);
        return;
    }

    // Health check
    if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
            JSON.stringify({
                status: 'ok',
                config: {
                    version: config.version,
                    features: Object.keys(config.features).length,
                    unprotectedTemporary: config.unprotectedTemporary?.length || 0,
                    nintendoProtected:
                        !config.unprotectedTemporary?.some(
                            (e) => e.domain === 'nintendo.com' || e === 'nintendo.com'
                        ),
                },
            })
        );
        return;
    }

    // 404 for everything else
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(
        JSON.stringify({
            error: 'Not found',
            availableEndpoints: ['/v4/macos-config.json', '/macos-config.json', '/', '/health'],
        })
    );
});

server.listen(PORT, () => {
    console.log(`
🌐 Test Config Server Running
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Config URL: http://localhost:${PORT}/v4/macos-config.json
  Health:     http://localhost:${PORT}/health

  Config version: ${config.version}
  Features: ${Object.keys(config.features).length}
  Nintendo unprotected: ${config.unprotectedTemporary?.some((e) => e.domain === 'nintendo.com' || e === 'nintendo.com') ? 'YES ✓' : 'NO ✗'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

To use with macOS browser (for refresh-based testing):

  defaults write HKE973VLUW.com.duckduckgo.macos.browser.app-configuration.debug \\
    isInternalUser -bool true

  defaults write HKE973VLUW.com.duckduckgo.macos.browser.app-configuration.debug \\
    "CustomConfigurationURL.privacyConfiguration" \\
    "http://localhost:${PORT}/v4/macos-config.json"

Note: For startup testing, the config must be baked into the build.
See: npm run build:macos-with-fix

Press Ctrl+C to stop.
`);
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`❌ Port ${PORT} is already in use. Try --port=<different-port>`);
    } else {
        console.error(`❌ Server error: ${err.message}`);
    }
    process.exit(1);
});
