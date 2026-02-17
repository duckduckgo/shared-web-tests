use std::process::{Command, Stdio, Child};
use std::path::PathBuf;
use std::str;

use crate::platform::fetch_privacy_config;

pub(crate) const BUNDLE_ID: &str = "com.duckduckgo.mobile.ios";

/// iOS app configuration group identifier
const APP_CONFIG_GROUP: &str = "group.com.duckduckgo.app-configuration";
/// iOS content blocker group (where config files are stored)
const CONTENT_BLOCKER_GROUP: &str = "group.com.duckduckgo.contentblocker";

pub(crate) fn xcrun_command(args: &[&str]) -> std::process::Output {
    let output = Command::new("xcrun")
        .args(args)
        .output()
        .expect("Failed to run xcrun command");
    if !output.status.success() {
        info!(
            "Failed to run xcrun command: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    output
}

pub(crate) fn write_defaults(udid: &str, key: &str, key_type: &str, value: &str) {
    xcrun_command(&[
        "simctl",
        "spawn",
        udid,
        "defaults",
        "write",
        BUNDLE_ID,
        key,
        &format!("-{key_type}"),
        value,
    ]);
}

pub(crate) fn monitor_simulator_logs(udid: &str) -> Child {
    Command::new("xcrun")
        .args(&[
            "simctl",
            "spawn",
            udid,
            "log",
            "stream",
            "--info",
            "--debug",
            "--predicate",
            &format!("subsystem == \"{}\"", BUNDLE_ID),
        ])
        .stdout(Stdio::piped())
        .spawn()
        .expect("Failed to start tail process")
}

pub(crate) fn find_or_create_simulator(target_device: &str, target_os: &str) -> Result<String, String> {
    let list_output = xcrun_command(&["simctl", "list", "devices", "-j"]);
    let device_name = format!("{target_device} {target_os} (webdriver)");

    let list_stdout = str::from_utf8(&list_output.stdout).expect("Invalid UTF-8 in simulator list");
    let simulators: serde_json::Value = serde_json::from_str(list_stdout).expect("Failed to parse simulator list");

    let mut booted_candidate: Option<String> = None;
    if let Some(devices) = simulators.get("devices") {
        for (runtime, device_list) in devices.as_object().unwrap() {
            info!("Runtime: {:?}", runtime);
            if runtime.contains(target_os) {
                for device in device_list.as_array().unwrap() {
                    if device["name"] == device_name && device["isAvailable"] == true {
                        let state = device["state"].as_str().unwrap_or("");
                        let udid = device["udid"].as_str().unwrap().to_string();

                        if state == "Shutdown" {
                            info!("Found matching shutdown simulator {:?}", device);
                            return Ok(udid);
                        } else if state == "Booted" && booted_candidate.is_none() {
                            info!("Found matching booted simulator {:?}", device);
                            booted_candidate = Some(udid);
                        }
                    }
                }
            }
        }
    }

    if let Some(udid) = booted_candidate {
        info!("Reusing booted simulator: {}", udid);
        return Ok(udid);
    }

    info!("No matching simulator found, creating a new one...");

    let create_output = xcrun_command(&[
        "simctl",
        "create",
        &device_name,
        &("com.apple.CoreSimulator.SimDeviceType.".to_owned() + target_device),
        &("com.apple.CoreSimulator.SimRuntime.".to_owned() + target_os),
    ]);

    let cargo_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let path_to_ca_cert = cargo_path.join("cacert.pem");

    let _install_ca_key = xcrun_command(&[
        "simctl",
        "keychain",
        &device_name,
        "add-root-cert",
        path_to_ca_cert.to_str().expect("Failed to convert path to string"),
    ]);

    if !create_output.status.success() {
        return Err("Failed to create a new simulator".to_string());
    }

    let new_udid = str::from_utf8(&create_output.stdout)
        .expect("Invalid UTF-8 in create simulator output")
        .trim();
    Ok(new_udid.to_string())
}

/// Write a value to the iOS app configuration group defaults via simulator
fn write_app_config_defaults(udid: &str, key: &str, key_type: &str, value: &str) {
    info!("Writing to iOS app config group {}: {} = {}", APP_CONFIG_GROUP, key, value);
    xcrun_command(&[
        "simctl",
        "spawn",
        udid,
        "defaults",
        "write",
        APP_CONFIG_GROUP,
        key,
        &format!("-{}", key_type),
        value,
    ]);
}

/// Get the iOS simulator's group container path
fn get_simulator_group_container(udid: &str, group_id: &str) -> Option<PathBuf> {
    let output = Command::new("xcrun")
        .args(&[
            "simctl",
            "get_app_container",
            udid,
            BUNDLE_ID,
            "groups",
        ])
        .output();

    match output {
        Ok(out) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            for line in stdout.lines() {
                if line.contains(group_id) {
                    if let Some(path) = line.split_whitespace().last() {
                        return Some(PathBuf::from(path));
                    }
                }
            }
            None
        },
        _ => None
    }
}

/// Set up custom privacy configuration for iOS simulator
pub(crate) fn setup_privacy_config(udid: &str, config_url: &str) {
    info!("Setting up custom privacy config for iOS simulator {}", udid);
    info!("  Config URL: {}", config_url);

    let config_data = match fetch_privacy_config(config_url) {
        Ok(data) => data,
        Err(e) => {
            info!("Failed to fetch privacy config: {}", e);
            set_config_url_fallback(udid, config_url);
            return;
        }
    };

    let container_path = get_simulator_group_container(udid, CONTENT_BLOCKER_GROUP);

    if let Some(container) = container_path {
        info!("Found group container: {:?}", container);

        let config_file = container.join("privacyConfiguration");
        info!("Writing config to: {:?}", config_file);

        let temp_file = std::env::temp_dir().join(format!("privacyConfig-{}.json", udid));
        if let Err(e) = std::fs::write(&temp_file, &config_data) {
            info!("Failed to write temp file: {}", e);
            set_config_url_fallback(udid, config_url);
            return;
        }

        let result = Command::new("xcrun")
            .args(&[
                "simctl",
                "spawn",
                udid,
                "cp",
                temp_file.to_str().unwrap(),
                config_file.to_str().unwrap(),
            ])
            .output();

        let _ = std::fs::remove_file(&temp_file);

        match result {
            Ok(out) if out.status.success() => {
                info!("Successfully wrote config file to simulator");

                let etag = format!("webdriver-{}", std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs());

                xcrun_command(&[
                    "simctl",
                    "spawn",
                    udid,
                    "defaults",
                    "write",
                    CONTENT_BLOCKER_GROUP,
                    "com.duckduckgo.ios.etag.privacyConfiguration",
                    "-string",
                    &etag,
                ]);

                info!("Successfully pre-cached privacy config ({} bytes)", config_data.len());
                return;
            },
            _ => {
                info!("Failed to copy config to simulator, falling back to URL mode");
            }
        }
    } else {
        info!("Could not get group container path, falling back to URL mode");
    }

    set_config_url_fallback(udid, config_url);
}

/// Fallback: Set the custom config URL for iOS
fn set_config_url_fallback(udid: &str, config_url: &str) {
    info!("Using URL fallback mode for iOS");
    write_app_config_defaults(udid, "isInternalUser", "bool", "true");
    write_app_config_defaults(udid, "CustomConfigurationURL.privacyConfiguration", "string", config_url);
}
