#!/usr/bin/env node
/**
 * Build macOS Browser with Modified Privacy Config
 *
 * This script:
 * 1. Adds nintendo.com to unprotectedTemporary in the remote-config
 * 2. Builds the config
 * 3. Copies it to the apple-browsers bundled location
 * 4. Rebuilds the macOS browser
 *
 * Usage:
 *   node scripts/build-macos-with-config-fix.mjs [--dry-run] [--skip-app-build]
 *
 * Options:
 *   --dry-run         Show what would be done without making changes
 *   --skip-app-build  Only update the config, don't rebuild the app
 *   --restore         Restore original config (undo changes)
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const metaRoot = path.resolve(projectRoot, '..');

// Paths
const PATHS = {
    remoteConfig: path.join(metaRoot, 'remote-config'),
    macosOverride: path.join(metaRoot, 'remote-config/overrides/macos-override.json'),
    generatedConfig: path.join(metaRoot, 'remote-config/generated/v4/macos-config.json'),
    bundledConfig: path.join(metaRoot, 'apple-browsers/macOS/DuckDuckGo/ContentBlocker/Resources/macos-config.json'),
    bundledConfigProvider: path.join(
        metaRoot,
        'apple-browsers/macOS/DuckDuckGo/ContentBlocker/AppPrivacyConfigurationDataProvider.swift'
    ),
    appleBrowsers: path.join(metaRoot, 'apple-browsers'),
    backupSuffix: '.nintendo-test-backup',
};

// Parse CLI args
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const skipAppBuild = args.includes('--skip-app-build');
const restore = args.includes('--restore');

function log(message, type = 'info') {
    const prefix = {
        info: 'ℹ️ ',
        success: '✅',
        warn: '⚠️ ',
        error: '❌',
        step: '▶️ ',
    }[type] || '';
    console.log(`${prefix} ${message}`);
}

function exec(command, options = {}) {
    log(`Running: ${command}`, 'step');
    if (dryRun) {
        log('  (dry-run, skipping)', 'warn');
        return '';
    }
    try {
        return execSync(command, { encoding: 'utf-8', stdio: 'inherit', ...options });
    } catch (error) {
        throw new Error(`Command failed: ${command}\n${error.message}`);
    }
}

function readJSON(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeJSON(filePath, data, minified = false) {
    if (dryRun) {
        log(`Would write to: ${filePath}`, 'warn');
        return;
    }
    // Use minified JSON for generated configs (matches remote-config output)
    // Use pretty JSON for override files (easier to read/diff)
    const content = minified ? JSON.stringify(data) : JSON.stringify(data, null, 4) + '\n';
    fs.writeFileSync(filePath, content);
}

function backup(filePath) {
    const backupPath = filePath + PATHS.backupSuffix;
    if (!fs.existsSync(backupPath)) {
        if (dryRun) {
            log(`Would backup: ${filePath}`, 'warn');
        } else {
            fs.copyFileSync(filePath, backupPath);
            log(`Backed up: ${path.basename(filePath)}`, 'info');
        }
    }
}

function restoreBackup(filePath) {
    const backupPath = filePath + PATHS.backupSuffix;
    if (fs.existsSync(backupPath)) {
        if (dryRun) {
            log(`Would restore: ${filePath}`, 'warn');
        } else {
            fs.copyFileSync(backupPath, filePath);
            fs.unlinkSync(backupPath);
            log(`Restored: ${path.basename(filePath)}`, 'success');
        }
    } else {
        log(`No backup found for: ${path.basename(filePath)}`, 'warn');
    }
}

async function main() {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║  Build macOS Browser with Nintendo Protection Disabled   ║
╚══════════════════════════════════════════════════════════╝
`);

    if (dryRun) {
        log('DRY RUN MODE - No changes will be made\n', 'warn');
    }

    // Handle restore
    if (restore) {
        log('Restoring original configuration...', 'step');
        restoreBackup(PATHS.macosOverride);
        restoreBackup(PATHS.bundledConfig);
        log('Done! Run the app build to complete restoration.', 'success');
        return;
    }

    // Step 1: Backup original files
    log('Step 1: Backing up original files', 'step');
    backup(PATHS.macosOverride);
    backup(PATHS.bundledConfig);

    // Step 2: Modify macos-override.json
    log('Step 2: Adding Nintendo to unprotectedTemporary', 'step');
    const override = readJSON(PATHS.macosOverride);

    const nintendoEntry = {
        domain: 'nintendo.com',
        reason: 'Testing - checkout flow breakage investigation',
    };

    if (!override.unprotectedTemporary) {
        override.unprotectedTemporary = [];
    }

    const alreadyExists = override.unprotectedTemporary.some(
        (entry) => (typeof entry === 'string' ? entry : entry.domain) === 'nintendo.com'
    );

    if (!alreadyExists) {
        override.unprotectedTemporary.push(nintendoEntry);
        writeJSON(PATHS.macosOverride, override);
        log('Added nintendo.com to macos-override.json', 'success');
    } else {
        log('nintendo.com already in unprotectedTemporary', 'info');
    }

    // Step 3: Build remote-config
    log('Step 3: Building remote-config', 'step');
    exec('npm run build', { cwd: PATHS.remoteConfig });

    // Step 4: Verify and patch the generated config
    // Note: The remote-config build applies unprotectedTemporary to feature exceptions
    // but doesn't include it in the output array. We need to patch it.
    log('Step 4: Patching generated config with unprotectedTemporary', 'step');
    if (!dryRun) {
        const generatedConfig = readJSON(PATHS.generatedConfig);

        // Ensure unprotectedTemporary array exists
        if (!generatedConfig.unprotectedTemporary) {
            generatedConfig.unprotectedTemporary = [];
        }

        const hasNintendo = generatedConfig.unprotectedTemporary.some(
            (e) => (typeof e === 'string' ? e : e.domain) === 'nintendo.com'
        );

        if (!hasNintendo) {
            generatedConfig.unprotectedTemporary.push({
                domain: 'nintendo.com',
                reason: 'Testing - checkout flow breakage investigation',
            });
            log('Patched: added nintendo.com to unprotectedTemporary', 'success');
        } else {
            log('nintendo.com already in unprotectedTemporary', 'info');
        }

        // Also add tracker allowlist entries for known trackers on Nintendo
        // This is needed because the Content Blocker operates separately from unprotectedTemporary
        const trackersToAllowlist = [
            { tracker: 'optimizely.com', rule: 'logx.optimizely.com' },
            { tracker: 'optimizely.com', rule: 'cdn.optimizely.com' },
            { tracker: 'google-analytics.com', rule: 'google-analytics.com' },
            { tracker: 'googletagmanager.com', rule: 'googletagmanager.com' },
            { tracker: 'facebook.net', rule: 'connect.facebook.net' },
            { tracker: 'facebook.com', rule: 'facebook.com' },
            { tracker: 'doubleclick.net', rule: 'doubleclick.net' },
        ];

        if (generatedConfig.features?.trackerAllowlist?.settings?.allowlistedTrackers) {
            const allowlist = generatedConfig.features.trackerAllowlist.settings.allowlistedTrackers;

            for (const { tracker, rule } of trackersToAllowlist) {
                if (!allowlist[tracker]) {
                    allowlist[tracker] = { rules: [] };
                }

                const existingRule = allowlist[tracker].rules.find(
                    (r) => r.rule === rule && r.domains?.includes('nintendo.com')
                );

                if (!existingRule) {
                    allowlist[tracker].rules.push({
                        rule: rule,
                        domains: ['nintendo.com'],
                        reason: 'Testing Nintendo checkout flow',
                    });
                }
            }
            log('Patched: added tracker allowlist entries for nintendo.com', 'success');
        } else {
            log('WARNING: trackerAllowlist not found in config', 'warn');
        }

        // Update version to ensure the app sees it as new
        generatedConfig.version = Date.now();
        writeJSON(PATHS.generatedConfig, generatedConfig, true); // minified to match original format

        // Verify patch worked
        const verifyConfig = readJSON(PATHS.generatedConfig);
        const verified = verifyConfig.unprotectedTemporary?.some(
            (e) => (typeof e === 'string' ? e : e.domain) === 'nintendo.com'
        );
        if (verified) {
            log('Verified: nintendo.com is in unprotectedTemporary', 'success');
        } else {
            log('ERROR: Patch verification failed!', 'error');
            process.exit(1);
        }
    }

    // Step 5: Copy to apple-browsers
    log('Step 5: Copying config to apple-browsers', 'step');
    if (!dryRun) {
        fs.copyFileSync(PATHS.generatedConfig, PATHS.bundledConfig);
        log(`Copied to: ${PATHS.bundledConfig}`, 'success');
    }

    // Step 6: Update the ETag/SHA in the provider
    log('Step 6: Updating ETag/SHA in AppPrivacyConfigurationDataProvider.swift', 'step');
    if (!dryRun) {
        const configContent = fs.readFileSync(PATHS.bundledConfig);
        const crypto = await import('node:crypto');
        const newSHA = crypto.createHash('sha256').update(configContent).digest('hex');

        let providerContent = fs.readFileSync(PATHS.bundledConfigProvider, 'utf-8');

        // Update SHA
        const shaRegex = /public static let embeddedDataSHA = "([a-f0-9]+)"/;
        const shaMatch = providerContent.match(shaRegex);
        if (shaMatch) {
            providerContent = providerContent.replace(shaRegex, `public static let embeddedDataSHA = "${newSHA}"`);
            log(`Updated SHA: ${shaMatch[1].substring(0, 16)}... -> ${newSHA.substring(0, 16)}...`, 'info');
        }

        // Generate a new ETag based on the config
        // Format: "\"<length>-<timestamp>\"" (escaped quotes inside the string)
        const newETag = `${configContent.length}-${Date.now()}`;
        // Match the entire line to avoid regex issues with escaped quotes
        const etagLineRegex = /public static let embeddedDataETag = "\\\"[^"]*\\\""/;
        const etagMatch = providerContent.match(etagLineRegex);
        if (etagMatch) {
            providerContent = providerContent.replace(
                etagLineRegex,
                `public static let embeddedDataETag = "\\\"${newETag}\\\""`
            );
            log(`Updated ETag: ${etagMatch[0].substring(40, 60)}... -> ${newETag}`, 'info');
        } else {
            log('WARNING: Could not find ETag line to update', 'warn');
        }

        fs.writeFileSync(PATHS.bundledConfigProvider, providerContent);
        log('Updated AppPrivacyConfigurationDataProvider.swift', 'success');
    }

    // Step 7: Build macOS app
    if (!skipAppBuild) {
        log('Step 7: Building macOS app', 'step');
        log('This may take several minutes...', 'info');

        // Use the shared-web-tests build script
        exec('npm run build:macos', { cwd: projectRoot });
        log('macOS app built successfully', 'success');
    } else {
        log('Step 7: Skipping app build (--skip-app-build)', 'warn');
    }

    // Summary
    console.log(`
╔══════════════════════════════════════════════════════════╗
║  Build Complete                                          ║
╚══════════════════════════════════════════════════════════╝

Nintendo.com protections have been DISABLED in the built app.

To test:
  1. Start the driver: npm run driver:macos
  2. Run the test: PLATFORM=macos npm run test:nintendo-basket

To restore original config:
  node scripts/build-macos-with-config-fix.mjs --restore
  npm run build:macos

Modified files:
  - ${PATHS.macosOverride}
  - ${PATHS.bundledConfig}
  - ${PATHS.bundledConfigProvider}

Backups saved with suffix: ${PATHS.backupSuffix}
`);
}

main().catch((error) => {
    log(error.message, 'error');
    process.exit(1);
});
