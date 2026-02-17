use std::process::{Command, Stdio, Child};
use std::path::PathBuf;

use crate::platform::{DdgCapabilities, fetch_privacy_config};

pub(crate) const BUNDLE_ID: &str = "com.duckduckgo.macos.browser";
pub(crate) const BUNDLE_ID_DEBUG: &str = "com.duckduckgo.macos.browser.debug";

// Development team ID for DuckDuckGo macOS apps
const DEVELOPMENT_TEAM: &str = "HKE973VLUW";

// Get bundle ID from app's Info.plist
pub(crate) fn get_bundle_id(app_path: &str) -> String {
    let info_plist = format!("{}/Contents/Info.plist", app_path);
    let output = Command::new("defaults")
        .args(&["read", &info_plist, "CFBundleIdentifier"])
        .output();

    match output {
        Ok(out) if out.status.success() => {
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        },
        _ => {
            // Fallback: check if path contains DEBUG
            if app_path.contains("DEBUG") || app_path.contains("Debug") {
                BUNDLE_ID_DEBUG.to_string()
            } else {
                BUNDLE_ID.to_string()
            }
        }
    }
}

pub(crate) fn write_defaults(bundle_id: &str, key: &str, key_type: &str, value: &str) {
    let output = Command::new("defaults")
        .args(&[
            "write",
            bundle_id,
            key,
            &format!("-{}", key_type),
            value,
        ])
        .output()
        .expect("Failed to write defaults");
    if !output.status.success() {
        info!(
            "Failed to write defaults: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

/// Derive the app configuration group identifier from the bundle ID
fn derive_app_config_group(bundle_id: &str) -> String {
    let known_suffixes = [".debug", ".alpha", ".review", ".ci"];

    let (base_id, suffix) = known_suffixes
        .iter()
        .find(|s| bundle_id.ends_with(*s))
        .map(|s| {
            let base = &bundle_id[..bundle_id.len() - s.len()];
            (base, *s)
        })
        .unwrap_or((bundle_id, ""));

    format!("{}.{}.app-configuration{}", DEVELOPMENT_TEAM, base_id, suffix)
}

/// Write a string value to the app configuration group defaults on macOS
fn write_app_config_defaults(bundle_id: &str, key: &str, value: &str) {
    let group_id = derive_app_config_group(bundle_id);
    info!("Writing to app config group {}: {} = {}", group_id, key, value);

    let output = Command::new("defaults")
        .args(&[
            "write",
            &group_id,
            key,
            "-string",
            value,
        ])
        .output()
        .expect("Failed to write app config defaults");

    if !output.status.success() {
        info!(
            "Failed to write app config defaults to {}: {}",
            group_id,
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

/// Get the macOS app group container path
fn get_group_container_path(group_id: &str) -> Option<PathBuf> {
    if let Ok(home) = std::env::var("HOME") {
        let path = PathBuf::from(home)
            .join("Library")
            .join("Group Containers")
            .join(group_id);
        Some(path)
    } else {
        None
    }
}

/// Set up custom privacy configuration for macOS
/// This pre-fetches the config and writes it directly to the app's cache
pub(crate) fn setup_privacy_config(bundle_id: &str, config_url: &str) {
    let group_id = derive_app_config_group(bundle_id);
    info!("Setting up custom privacy config for {}", bundle_id);
    info!("  Config group: {}", group_id);
    info!("  Config URL: {}", config_url);

    // Fetch the config data
    let config_data = match fetch_privacy_config(config_url) {
        Ok(data) => data,
        Err(e) => {
            info!("Failed to fetch privacy config: {}", e);
            set_config_url(&group_id, config_url);
            return;
        }
    };

    // Get the group container path
    let container_path = match get_group_container_path(&group_id) {
        Some(path) => path,
        None => {
            info!("Failed to get group container path, falling back to URL mode");
            set_config_url(&group_id, config_url);
            return;
        }
    };

    // Create the directory if it doesn't exist
    if let Err(e) = std::fs::create_dir_all(&container_path) {
        info!("Failed to create group container directory: {}", e);
        set_config_url(&group_id, config_url);
        return;
    }

    // Write the config file (macOS uses "macos-config.json")
    let config_file = container_path.join("macos-config.json");
    info!("Writing config to: {:?}", config_file);

    if let Err(e) = std::fs::write(&config_file, &config_data) {
        info!("Failed to write config file: {}", e);
        set_config_url(&group_id, config_url);
        return;
    }

    // CRITICAL: Write to the GROUP CONTAINER plist, not ~/Library/Preferences
    let prefs_dir = container_path.join("Library").join("Preferences");
    let plist_path = prefs_dir.join(format!("{}.plist", group_id));

    if let Err(e) = std::fs::create_dir_all(&prefs_dir) {
        info!("Failed to create Preferences directory: {}", e);
        set_config_url(&group_id, config_url);
        return;
    }

    info!("Writing UserDefaults to: {:?}", plist_path);

    let file_url = format!("file://{}", config_file.display());

    // Create the plist if it doesn't exist
    let _ = Command::new("/usr/libexec/PlistBuddy")
        .args(&["-c", "Save", plist_path.to_str().unwrap()])
        .output();

    // Set isInternalUser = true
    let _ = Command::new("/usr/libexec/PlistBuddy")
        .args(&["-c", "Delete :isInternalUser", plist_path.to_str().unwrap()])
        .output();

    let output = Command::new("/usr/libexec/PlistBuddy")
        .args(&["-c", "Add :isInternalUser bool true", plist_path.to_str().unwrap()])
        .output()
        .expect("Failed to run PlistBuddy");

    if !output.status.success() {
        info!("PlistBuddy isInternalUser failed: {}", String::from_utf8_lossy(&output.stderr));
    } else {
        info!("Set isInternalUser = true");
    }

    // Set CustomConfigurationURL.privacyConfiguration
    let _ = Command::new("/usr/libexec/PlistBuddy")
        .args(&["-c", "Delete :CustomConfigurationURL.privacyConfiguration", plist_path.to_str().unwrap()])
        .output();

    let output = Command::new("/usr/libexec/PlistBuddy")
        .args(&[
            "-c", &format!("Add :CustomConfigurationURL.privacyConfiguration string {}", file_url),
            plist_path.to_str().unwrap()
        ])
        .output()
        .expect("Failed to run PlistBuddy");

    if !output.status.success() {
        info!("PlistBuddy CustomConfigurationURL failed: {}", String::from_utf8_lossy(&output.stderr));
    } else {
        info!("Set CustomConfigurationURL.privacyConfiguration = {}", file_url);
    }

    info!("Successfully pre-cached privacy config ({} bytes) and set UserDefaults in group container", config_data.len());
}

/// Fallback: Set the custom config URL (used if pre-fetching fails)
fn set_config_url(group_id: &str, config_url: &str) {
    info!("Setting config URL fallback mode for group {}", group_id);

    let output = Command::new("defaults")
        .args(&["write", group_id, "isInternalUser", "-bool", "true"])
        .output()
        .expect("Failed to write isInternalUser");

    if !output.status.success() {
        info!("Failed to set isInternalUser: {}", String::from_utf8_lossy(&output.stderr));
    }

    let output = Command::new("defaults")
        .args(&["write", group_id, "CustomConfigurationURL.privacyConfiguration", "-string", config_url])
        .output()
        .expect("Failed to write custom config URL");

    if !output.status.success() {
        info!("Failed to set custom config URL: {}", String::from_utf8_lossy(&output.stderr));
    }
}

pub(crate) fn is_app_running(_bundle_id: &str) -> bool {
    let output = Command::new("osascript")
        .args(&["-e", "tell application \"System Events\" to (name of processes) contains \"DuckDuckGo\""])
        .output();

    match output {
        Ok(out) if out.status.success() => {
            let result = String::from_utf8_lossy(&out.stdout);
            result.trim() == "true"
        },
        _ => false,
    }
}

pub(crate) fn launch_app(app_path: &str, port: u16, ddg_caps: &DdgCapabilities) -> Result<(Child, String), String> {
    info!("Launching macOS app at: {}", app_path);

    let bundle_id = get_bundle_id(app_path);
    info!("Detected bundle ID: {}", bundle_id);

    // Quit any running instance gracefully
    if is_app_running(&bundle_id) {
        info!("App is running, quitting gracefully...");

        let _ = Command::new("osascript")
            .args(&["-e", &format!("tell application id \"{}\" to quit", bundle_id)])
            .output();

        let mut attempts = 0;
        while is_app_running(&bundle_id) && attempts < 30 {
            std::thread::sleep(std::time::Duration::from_millis(200));
            attempts += 1;
        }

        if is_app_running(&bundle_id) {
            info!("App still running, sending SIGTERM...");
            let _ = Command::new("pkill")
                .args(&["-TERM", "-f", &bundle_id])
                .output();

            let mut attempts = 0;
            while is_app_running(&bundle_id) && attempts < 20 {
                std::thread::sleep(std::time::Duration::from_millis(200));
                attempts += 1;
            }
        }

        if is_app_running(&bundle_id) {
            info!("App still running, force killing...");
            let _ = Command::new("pkill")
                .args(&["-KILL", "-f", &bundle_id])
                .output();
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    }

    write_defaults(&bundle_id, "automationPort", "int", &port.to_string());
    write_defaults(&bundle_id, "isUITesting", "bool", "true");
    write_defaults(&bundle_id, "isOnboardingCompleted", "string", "true");

    if let Some(ref config_url) = ddg_caps.privacy_config_url {
        setup_privacy_config(&bundle_id, config_url);
    }

    let child = if let Some(ref config_path) = ddg_caps.privacy_config_path {
        let binary_path = format!("{}/Contents/MacOS/DuckDuckGo", app_path);
        info!("Launching binary directly with TEST_PRIVACY_CONFIG_PATH={}", config_path);
        Command::new(&binary_path)
            .args(&["-isUITesting", "true"])
            .env("TEST_PRIVACY_CONFIG_PATH", config_path)
            .env_remove("CI")
            .spawn()
            .map_err(|e| format!("Failed to launch app binary: {}", e))?
    } else {
        Command::new("open")
            .args(&["-a", app_path, "--args", "-isUITesting", "true"])
            .env_remove("CI")
            .spawn()
            .map_err(|e| format!("Failed to launch app: {}", e))?
    };

    Ok((child, bundle_id))
}

pub(crate) fn monitor_logs(bundle_id: &str) -> Child {
    Command::new("log")
        .args(&[
            "stream",
            "--info",
            "--debug",
            "--predicate",
            &format!("subsystem == \"{}\"", bundle_id),
        ])
        .stdout(Stdio::piped())
        .spawn()
        .expect("Failed to start log stream")
}

pub(crate) fn quit_app_with_port(port: Option<u16>) {
    info!("Quitting macOS app gracefully via /shutdown endpoint...");

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build();

    let ports_to_try: Vec<u16> = match port {
        Some(p) => vec![p],
        None => (8557..=8570).collect(),
    };

    if let Ok(client) = client {
        for port in ports_to_try {
            let url = format!("http://localhost:{}/shutdown", port);
            info!("Trying shutdown on port {}...", port);
            match client.get(&url).send() {
                Ok(response) => {
                    info!("Shutdown response on port {}: {:?}", port, response.status());
                    if response.status().is_success() {
                        break;
                    }
                },
                Err(e) => {
                    info!("Shutdown on port {} failed: {}", port, e);
                }
            }
        }
    }

    std::thread::sleep(std::time::Duration::from_millis(1500));

    for _ in 0..10 {
        if !is_app_running(BUNDLE_ID) {
            info!("macOS app terminated cleanly");
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }

    info!("App still running, trying AppleScript quit...");
    let _ = Command::new("osascript")
        .args(&["-e", "tell application \"DuckDuckGo\" to quit"])
        .output();

    std::thread::sleep(std::time::Duration::from_millis(1000));

    if !is_app_running(BUNDLE_ID) {
        info!("macOS app quit via AppleScript");
        return;
    }

    info!("App not responding, sending SIGTERM...");
    let _ = Command::new("pkill")
        .args(&["-TERM", "-f", "DuckDuckGo.app"])
        .output();
}
