# Known Issues with FindElements Implementation

This document tracks all known issues encountered during the implementation of the `FindElements` WebDriver command.

## Issue 1: "Invalid device" Error

**Status:** ✅ Resolved  
**Severity:** Medium  
**Location:** macOS Automation Server logs

### Description

When executing `FindElements` commands (and other commands), the macOS automation server logs showed:

```
Invalid device: 5b7970ec-fbe6-490f-8c3d-15c9a9fd1cf1
```

### Symptoms

- Error appeared in macOS app logs before script execution
- The script still executed and returned a response (empty array `[]`)
- The error didn't prevent the command from completing, but indicated a session management issue

### Root Cause Analysis

**Root Cause:** The `FindElements` handler (and many other handlers) were using `server_request()` which is the iOS-only function that calls `monitor_simulator_logs()`. On macOS, this function tried to use the session ID (a UUID) as a simulator UDID, causing the "Invalid device" error.

The correct function `server_request_for_platform()` exists and properly handles both iOS and macOS platforms, but it wasn't being used.

### Fix Applied

Replaced all calls to `server_request()` with `server_request_for_platform()` throughout the handler, passing the detected platform:

```rust
// Before (incorrect):
let response = server_request(session_id, "execute", &url_params);

// After (correct):
let response = server_request_for_platform(session_id, &platform, "execute", &url_params);
```

**Commands Fixed:**

- `FindElements`
- `FindElement`
- `ExecuteScript`
- `ExecuteAsyncScript`
- `ElementClick`
- `Navigate`
- `NewWindow`
- `CloseWindow`
- `SwitchToWindow`
- `GetWindowHandle`
- `GetWindowHandles`
- `GetCurrentUrl`

### Related Files

- `shared-web-tests/webdriver/src/handler.rs` - All command handlers updated

---

## Issue 2: FindElements Returns Empty Array

**Status:** 🔴 Unresolved  
**Severity:** High  
**Location:** `FindElements` command handler

### Description

The `FindElements` command executes successfully but returns an empty array `[]` even when elements matching the selector should exist on the page.

### Symptoms

- Command executes without errors
- Response format is correct: `{"requestPath": "/execute", "message": "[]"}`
- `element_ids` vector is empty: `FindElements response: "[]", element_ids: []`
- Test script reports "Found 0 clickable element(s)"

### Root Cause Analysis

**Hypothesis 1: JavaScript variables `using` and `value` are undefined**

- The automation server decodes the `args` JSON string into `[String: String]`
- These dictionary keys should become JavaScript variables via `callAsyncJavaScript`
- If `using` and `value` are undefined, `selectElements(using, value)` would fail silently or return empty results

**Hypothesis 2: Page not ready when script executes**

- The script checks `document.readyState != 'complete'` and waits for load event
- However, elements might not be rendered yet even after load event
- The retry logic (5 attempts with exponential backoff) might not be sufficient

**Hypothesis 3: Selector not matching elements**

- The CSS selector `"button, input[type=\"button\"], input[type=\"submit\"]"` might not match elements on the page
- Elements might be dynamically created after the script runs
- Elements might be in shadow DOM or iframes

### Evidence

- The URL-encoded args are correctly formatted: `args=%7B%22using%22%3A%22css%20selector%22%2C%22value%22%3A%22button%2C%20input%5Btype%3D%5C%22button%5C%22%5D%2C%20input%5Btype%3D%5C%22submit%5C%22%5D%22%7D`
- When decoded: `{"using":"css selector","value":"button, input[type=\"button\"], input[type=\"submit\"]"}`
- The script structure matches `find-element.js` which works correctly

### Fixes Attempted

1. ✅ Added error handling to detect undefined `using`/`value` variables in `find-elements.js`
2. ✅ Fixed response parsing to handle the `message` field extraction correctly
3. ✅ Added try-catch error handling to catch JavaScript errors
4. ✅ Added `readyState` check inside retry logic to ensure page is loaded
5. ✅ Fixed `FindElement` response parsing (was incorrectly accessing `parsed["message"]` when response is already the message)
6. ⏳ Changes added but not yet tested (requires rebuild)

### Next Steps

1. **Rebuild WebDriver** and test with error handling to see if `using`/`value` are undefined
2. **Add logging** in the JavaScript to log the values of `using` and `value` when the script runs
3. **Verify page state** - check if the page is fully loaded and elements are rendered
4. **Test selector manually** - verify the CSS selector works in browser DevTools
5. **Compare with FindElement** - check if `FindElement` works with the same selector on the same page

### Related Files

- `shared-web-tests/webdriver/src/handler.rs` (lines 960-993) - FindElements handler
- `shared-web-tests/webdriver/src/find-elements.js` - JavaScript implementation
- `shared-web-tests/webdriver/src/find-element.js` - Reference implementation (works)

---

## Issue 3: Response Parsing Logic

**Status:** ✅ Resolved  
**Severity:** Low  
**Location:** `FindElements` handler response parsing

### Description

Initial implementation attempted to parse the response as a JSON object with a `message` field, but `server_request` already extracts the `message` field.

### Root Cause

The `make_server_request` function (line 473-502) already extracts the `message` field from the automation server's JSON response and returns it as a string. The `FindElements` handler was incorrectly trying to parse this string as a JSON object and access a `message` field again.

### Fix Applied

Changed parsing logic to directly parse the `response` string (which is already the JSON array string) into a `Value::Array`:

```rust
let element_ids_array: Value = serde_json::from_str(&response)
    .unwrap_or(Value::Array(Vec::new()));
```

### Related Files

- `shared-web-tests/webdriver/src/handler.rs` (lines 971-986)

---

## Issue 4: Missing Error Handling for Undefined Variables

**Status:** ⏳ In Progress  
**Severity:** Medium  
**Location:** `find-elements.js`

### Description

The JavaScript script doesn't check if `using` and `value` variables are defined before using them. If they're undefined, the script would fail silently or throw an error that's not properly handled.

### Fix Applied

Added error handling at the start of `findElements()` function:

```javascript
if (typeof using === 'undefined' || typeof value === 'undefined') {
    reject(new Error('using or value is undefined. using: ' + typeof using + ', value: ' + typeof value));
    return;
}
```

### Status

- ✅ Code added to `find-elements.js`
- ✅ Added try-catch wrapper to catch all JavaScript errors
- ✅ Added `readyState` check in retry logic
- ⏳ Not yet tested (requires rebuild)

### Related Files

- `shared-web-tests/webdriver/src/find-elements.js` (line 40-43)

---

## Summary

### Critical Issues (Blocking)

1. **FindElements Returns Empty Array** - The command doesn't find elements that should exist

### Non-Critical Issues

1. **"Invalid device" Error** - Appears in logs but doesn't prevent execution
2. **Missing Error Handling** - Added but not yet tested

### Resolved Issues

1. ✅ Response parsing logic fixed

---

## Testing Checklist

- [ ] Rebuild WebDriver binary
- [ ] Test FindElements with error handling enabled
- [ ] Verify `using` and `value` variables are defined in JavaScript context
- [ ] Test with a simple page that has known button elements
- [ ] Compare behavior with `FindElement` command on same page
- [ ] Check macOS app logs for additional error messages
- [ ] Verify session management and port mapping

---

## Notes

- The `FindElement` command works correctly, so the pattern should be the same for `FindElements`
- The automation server's `callAsyncJavaScript` API should make dictionary keys available as JavaScript variables
- The "Invalid device" error might be a red herring if the command still executes successfully

---

## Issue 5: "DuckDuckGo quit unexpectedly" Crash Dialog

**Status:** ✅ Resolved  
**Severity:** Medium  
**Location:** `quit_macos_app()` function and `teardown_session()` trait method

### Description

When the WebDriver server was killed or crashed, the macOS DuckDuckGo app would show a crash dialog because it wasn't receiving clean shutdown signals.

### Root Cause

1. `quit_macos_app()` only sent an AppleScript quit command without waiting or retrying
2. `teardown_session()` was commented out and never performed cleanup
3. No graceful shutdown sequence with fallback to SIGTERM before SIGKILL

### Fix Applied

1. **Enhanced `quit_macos_app()`** to include:
    - AppleScript quit with 5-second wait
    - SIGTERM fallback with 3-second wait
    - SIGKILL as last resort (may still show dialog)

2. **Enabled `teardown_session()`** to:
    - Detect platform via `Platform::from_env()`
    - Call `quit_macos_app()` on explicit session delete

3. **Added NPM cleanup scripts:**
    - `npm run driver:cleanup` - Graceful cleanup of sessions and processes
    - `npm run driver:kill` - Force kill for recovery
    - `npm run driver:restart:macos` - Cleanup + restart

### Prevention

- Always use `npm run driver:cleanup` before starting tests
- Use `--no-keep` flag to auto-close browser when test ends
- Use `npm run test:search-company:auto` which handles cleanup automatically

---

## Issue 6: getText() Returns Empty for Button Elements

**Status:** 🟡 Documented (Workaround Available)  
**Severity:** Low  
**Location:** WebDriver `GetElementText` command

### Description

The WebDriver `getText()` method returns empty strings for button elements, even when those elements have visible text content. Debug output shows elements are found correctly (e.g., "101 buttons found") but `getText()` returns empty for all of them.

### Symptoms

- `findElements()` correctly finds button elements
- `getText()` on those elements returns empty string `""`
- Visual inspection confirms buttons have text content
- Issue appears to be WebDriver-specific, not DOM-related

### Root Cause

This appears to be a quirk with how WebDriver's `getText()` implementation handles certain button elements. The WebDriver spec's text extraction algorithm may not handle all button content patterns correctly (e.g., nested elements, pseudo-elements, or specific CSS configurations).

### Workaround

Use `executeScript()` to get button text directly via JavaScript instead of `getText()`:

```javascript
// Instead of:
const text = await button.getText();

// Use:
const text = await driver.executeScript(
  'return arguments[0].innerText || arguments[0].textContent || arguments[0].value || "";',
  button
);
```

### Related Files

- `shared-web-tests/webdriver/src/handler.rs` - GetElementText handler
- `shared-web-tests/scripts/debug-utils.mjs` - Debug utilities (see Debug Tools section below)
- `shared-web-tests/scripts/diagnose-site.mjs` - Site diagnostic crawler

---

## Debug Tools

**Location:** `shared-web-tests/scripts/debug-utils.mjs`

### Available Debug Scripts

| Script | Description | Returns |
|--------|-------------|---------|
| `actionableElements` | Get all clickable elements (buttons, links, etc.) | Array of `{ tag, text, href, selector, rect, visible }` |
| `findByText` | Find elements containing specific text | Array of `{ tag, text, selector, visible }` |
| `linkAnalysis` | Group links by type (navigation, JS-triggered, external) | `{ navigation: [], jsTriggered: [], external: [] }` |
| `domTracker` | Track DOM mutations (start/stop mode) | `{ added: [], removed: [], attributes: [] }` |
| `debugClick` | Click an element and report what happened | `{ element, events, urlChanged, newUrl }` |
| `formInputs` | Get all form inputs on page | Array of `{ name, type, id, selector, value }` |
| `detectModals` | Check for open modals/dialogs | `{ hasModal: boolean, modals: [] }` |
| `startConsoleCapture` | Begin capturing console.log/warn/error | `{ status: 'capturing' }` |
| `getConsoleLogs` | Retrieve captured console logs | `{ logs: [], count: number }` |
| `clearConsoleLogs` | Clear captured logs without stopping | `{ cleared: number }` |
| `getResourceErrors` | Find failed resource loads | `{ errors: [], resources: [] }` |
| `pageState` | Get page state summary | `{ url, title, readyState, viewport, cookies }` |

### Helper Functions

```javascript
import { runDebug, logActionableElements, trackDomChanges, captureConsoleDuring } from './debug-utils.mjs';

// Run any debug script
const elements = await runDebug(driver, 'actionableElements');

// Log clickable elements with formatting
await logActionableElements(driver, { filter: 'submit', buttonsOnly: true });

// Track DOM changes around an action
const changes = await trackDomChanges(driver, async () => {
    await element.click();
});

// Capture console during action
const { logs, result } = await captureConsoleDuring(driver, async () => {
    return await someAction();
});
```

### Site Diagnostic Mode

**Script:** `npm run diagnose -- <url>`

Automated crawler that randomly explores a site:

```bash
# Basic usage
npm run diagnose -- https://example.com

# With screenshots after each click
npm run diagnose:screenshot -- https://example.com

# Deep exploration (30 clicks, 5 levels deep)
npm run diagnose:deep -- https://example.com

# Custom options
npm run diagnose -- https://example.com --max-clicks 20 --max-depth 3 --screenshot --report report.json
```

**Options:**
- `--max-clicks N` - Maximum clicks to perform (default: 15)
- `--max-depth N` - Maximum navigation depth (default: 3)
- `--screenshot` - Take screenshot after each click
- `--stay-on-domain` / `--no-stay-on-domain` - Restrict to same domain (default: stay)
- `--keep` - Keep browser open after completion
- `--report FILE` - Save JSON report to file

**Output:**
- Logs each click with selector, text, and target URL
- Reports DOM changes and console errors per click
- Summarizes pages visited, errors logged, modals encountered
- Identifies potential issues (JS errors, failed clicks, modal blockers)

---

## Issue 7: Popup Blocker Prevents window.open() in Automation

**Status:** ✅ Resolved (macOS)  
**Severity:** High  
**Location:** `ElementClick` handler, browser popup blocker

### Description

Sites that use `window.open()` on click (e.g., Nintendo's "Add to Cart" button) fail in automation because the browser's popup blocker prevents the new window/tab from opening. This works in normal browser usage but fails under WebDriver automation.

### Root Cause

Browsers only allow `window.open()` within a **user activation context** - an event chain initiated by a trusted user gesture. The current `ElementClick` implementation uses JavaScript's `element.click()`:

```rust
// handler.rs ElementClick handler
element.click();
return "clicked";
```

This creates a synthetic click event with `isTrusted: false`, which browsers don't consider a user gesture for popup blocking purposes.

### Why Native Clicks Won't Work

**Option 1 (Native event dispatch via accessibility APIs) is not viable because:**

1. **iOS**: No accessibility-based click mechanism available - all interactions must go through WebKit's JavaScript APIs
2. **macOS**: Requires user to grant accessibility permissions (`System Preferences > Security & Privacy > Privacy > Accessibility`), which is not practical for automated testing scenarios
3. Even with accessibility permissions, some browsers may still track the "user initiated" flag separately

### Fix Applied (macOS)

**Option 2: Disable popup blocker in automation mode**

The DDG macOS browser now detects when it's running with the automation server active and bypasses popup blocking for all popups.

**Implementation:**
- Added `automationSession` case to `PopupPermissionBypassReason` enum
- Modified `shouldAllowPopupBypassingPermissionRequest()` in `PopupHandlingTabExtension` to check `LaunchOptionsHandler().isAutomationSession` and return `.automationSession` bypass reason
- When automation is active (WebDriver port set or UI testing mode), all popups are allowed without permission prompts

**Files Changed:**
- `apple-browsers/macOS/DuckDuckGo/Tab/TabExtensions/PopupHandlingTabExtension.swift`

### iOS Status

iOS implementation still pending - needs similar changes to the iOS popup handling code.

### Affected Sites (Known)

- `nintendo.com` - "Add to Cart" opens cart in new tab via `window.open()`

### Related Files

- `shared-web-tests/webdriver/src/handler.rs` (lines 1157-1176) - ElementClick handler
- `apple-browsers/macOS/DuckDuckGo/Tab/TabExtensions/PopupHandlingTabExtension.swift` - Popup bypass logic
- `apple-browsers/macOS/DuckDuckGo/Automation/LaunchOptionsHandler.swift` - `isAutomationSession` property

---

## DuckDuckGo-Specific WebDriver Capabilities

The DuckDuckGo WebDriver implementation supports custom capabilities for testing privacy features.

### `ddg:privacyConfigURL`

**Status:** ✅ Implemented  
**Platforms:** macOS, iOS Simulator

Override the bundled privacy remote configuration with a custom URL. The config is **pre-fetched and cached** before the app launches, ensuring the exact config is used without requiring network access at runtime.

#### Usage

Pass the capability in the WebDriver `NewSession` request:

```javascript
const capabilities = {
  alwaysMatch: {
    'ddg:privacyConfigURL': 'https://example.com/custom-privacy-config.json'
  }
};

const session = await driver.newSession({ capabilities });
```

Or when using a WebDriver client:

```javascript
// Example with webdriverio-style client
const browser = await remote({
  capabilities: {
    'ddg:privacyConfigURL': 'https://privacy-test-pages.site/path/to/config.json'
  }
});
```

#### Supported URL Schemes

- `https://` - Fetched from the network by the WebDriver server
- `http://` - Fetched from the network (useful for local test servers)
- `file://` - Read directly from the local filesystem

**Local file example:**
```javascript
const capabilities = {
  alwaysMatch: {
    'ddg:privacyConfigURL': 'file:///path/to/local-config.json'
  }
};
```

#### How It Works

1. **Pre-fetch**: The WebDriver server fetches the config from the URL before launching the app
2. **Cache**: The config data is written directly to the app's cache location:
   - **macOS:** `~/Library/Group Containers/<group-id>/macos-config.json`
   - **iOS:** `<simulator-container>/privacyConfiguration`
3. **Etag**: A fake etag is set so the app uses the cached config instead of re-fetching
4. **Fallback**: If pre-fetching fails, falls back to setting the URL for runtime fetch

#### Configuration Groups / Cache Locations

**macOS:**
- Group: `HKE973VLUW.<bundle-id>.app-configuration[.suffix]`  
  (e.g., `HKE973VLUW.com.duckduckgo.macos.browser.app-configuration.debug`)
- File: `~/Library/Group Containers/<group>/macos-config.json`
- Etag key: `configurationPrivacyConfigurationEtag`

**iOS Simulator:**
- Config group: `group.com.duckduckgo.app-configuration`
- Cache group: `group.com.duckduckgo.contentblocker`
- File: `<container>/privacyConfiguration`
- Etag key: `com.duckduckgo.ios.etag.privacyConfiguration`

#### Notes

- The config is fetched **once** when the session starts; it's not re-fetched during the session
- For `file://` URLs, the file must exist on the machine running the WebDriver server
- The app must be built with DEBUG or ALPHA configuration for some features to work
- If pre-fetching fails (network error, invalid URL, etc.), the system falls back to setting the URL for runtime fetch
