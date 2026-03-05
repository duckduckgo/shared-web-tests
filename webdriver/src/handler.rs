use std::process::{Command, Stdio};
use urlencoding;
use webdriver::server::{Session, WebDriverHandler};
use webdriver::httpapi::WebDriverExtensionRoute;
use webdriver::Parameters;
use webdriver::command::{WebDriverCommand, WebDriverExtensionCommand, WebDriverMessage};
use webdriver::error::WebDriverResult;
use webdriver::server::SessionTeardownKind;
use serde_json::{Map, Value};
use webdriver::command::WebDriverCommand::{
    AcceptAlert, AddCookie, CloseWindow, DeleteCookie, DeleteCookies, DeleteSession, DismissAlert,
    ElementClear, ElementClick, ElementSendKeys, ExecuteAsyncScript, ExecuteScript, Extension,
    FindElement, FindElementElement, FindElementElements, FindElements, FindShadowRootElement,
    FindShadowRootElements, FullscreenWindow, Get, GetActiveElement, GetAlertText, GetCSSValue,
    GetComputedLabel, GetComputedRole, GetCookies, GetCurrentUrl, GetElementAttribute,
    GetElementProperty, GetElementRect, GetElementTagName, GetElementText, GetNamedCookie,
    GetPageSource, GetShadowRoot, GetTimeouts, GetTitle, GetWindowHandle, GetWindowHandles,
    GetWindowRect, GoBack, GoForward, IsDisplayed, IsEnabled, IsSelected, MaximizeWindow,
    MinimizeWindow, NewSession, NewWindow, PerformActions, Print, Refresh, ReleaseActions,
    SendAlertText, SetPermission, SetTimeouts, SetWindowRect, Status, SwitchToFrame,
    SwitchToParentFrame, SwitchToWindow, TakeElementScreenshot, TakeScreenshot,
    WebAuthnAddCredential, WebAuthnAddVirtualAuthenticator, WebAuthnGetCredentials,
    WebAuthnRemoveAllCredentials, WebAuthnRemoveCredential, WebAuthnRemoveVirtualAuthenticator,
    WebAuthnSetUserVerified,
};
use webdriver::response::{
    CloseWindowResponse, CookieResponse, CookiesResponse, ElementRectResponse, NewSessionResponse,
    NewWindowResponse, TimeoutsResponse, ValueResponse, WebDriverResponse, WindowRectResponse,
};
use std::collections::HashMap;
use std::sync::OnceLock;
use std::sync::Mutex;
use std::str;
use std::process::Child;
use std::io::{BufReader, BufRead};
use std::thread;
use std::env;
use std::path::PathBuf;
use uuid::Uuid;


 #[derive(Clone, PartialEq, Eq, Debug)]
 pub enum DuckDuckGoExtensionRoute {
     GetContext
 }

 impl WebDriverExtensionRoute for DuckDuckGoExtensionRoute {
    type Command = DuckDuckGoExtensionCommand;

    fn command(
        &self,
        _params: &Parameters,
        _body_data: &Value,
    ) -> WebDriverResult<WebDriverCommand<DuckDuckGoExtensionCommand>> {
        use self::DuckDuckGoExtensionRoute::*;

        let command = match *self {
            GetContext => DuckDuckGoExtensionCommand::GetContext
        };

        Ok(WebDriverCommand::Extension(command))
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DuckDuckGoContext {
    Content,
    Chrome,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DuckDuckGoContextParameters {
   //pub context: DuckDuckGoContext,
}

#[derive(Clone, Debug)]
pub struct VoidWebDriverExtensionCommand;

impl WebDriverExtensionCommand for VoidWebDriverExtensionCommand {
    fn parameters_json(&self) -> Option<Value> {
        panic!("No extensions implemented");
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AddonPath {
    pub path: String,
    pub temporary: Option<bool>,
    #[serde(rename = "allowPrivateBrowsing")]
    pub allow_private_browsing: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AddonUninstallParameters {
    pub id: String,
}

#[derive(Clone, Debug)]
pub enum DuckDuckGoExtensionCommand {
    GetContext
}

impl WebDriverExtensionCommand for DuckDuckGoExtensionCommand {
    fn parameters_json(&self) -> Option<Value> {
        use self::DuckDuckGoExtensionCommand::*;
        match self {
            GetContext => None
        }
    }
}


#[derive(Default)]
pub(crate) struct Handler {
}

impl Handler {
    pub fn new() -> Self {
        Handler {}
    }
}

struct PortManager {
    ports: Mutex<HashMap<&'static str, u16>>,
}

impl PortManager {
    fn new() -> Self {
        PortManager {
            ports: Mutex::new(HashMap::new()),
        }
    }

    fn get_port(&self, udid: &str) -> u16 {
        let mut ports = self.ports.lock().unwrap();
        if let Some(&port) = ports.get(udid) {
            return port;
        }

        for port in 8557..=65535 {
            if port_is_available(port) {
                ports.insert(Box::leak(udid.to_string().into_boxed_str()), port);
                return port;
            }
        }
        panic!("No available ports found");
    }
}

fn port_is_available(port: u16) -> bool {
    std::net::TcpListener::bind(("0.0.0.0", port)).is_ok()
}

static PORT_MANAGER: OnceLock<PortManager> = OnceLock::new();

fn get_port(udid: &str) -> u16 {
    let port_manager = PORT_MANAGER.get_or_init(|| PortManager::new());
    port_manager.get_port(udid)
}

fn server_request(udid: &str, method: &str, params: &std::collections::HashMap<&str, &str>) -> String {
    let mut child = monitor_simulator_logs(&udid);
    let stdout = child.stdout.take().expect("Failed to capture stdout");
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        info!("Simulator logs:");
        for line in reader.lines() {
            if let Ok(log_line) = line {
                info!("{}", log_line);
            }
        }
        info!("Simulator logs end");
    });
    let port = get_port(udid);
    let query_string: String = params.iter()
        .map(|(key, value)| format!("{}={}", key, value))
        .collect::<Vec<String>>()
        .join("&");
    let url = format!("http://localhost:{}/{method}?{}", port, query_string);
    info!("URL to send: {:?}", url);
    let client = reqwest::blocking::Client::new();
    let resp = client.get(url)
        .timeout(std::time::Duration::from_secs(30)) // TODO Handle variadic timeout set by command
        .send()
        .map_err(|e| {
            if e.is_timeout() {
            info!("Request timed out");
            // TODO construct serialised error like: Error::new(ErrorKind::TimedOut, "Request timed out")
            "Request timed out".to_string()
            } else {
            "Other error".to_string()
            }
        })
        .expect("Failed to send request")
        .text()
        .expect("Failed to read response text");
    info!("Response: {:#?}", resp);
    #[derive(Deserialize)]
    struct Response {
        message: String,
    }
    let json: Response = serde_json::from_str(&resp).expect("Failed to parse response");
    let _ = child.kill();
    return json.message;
}

fn find_or_create_simulator(target_device: &str, target_os: &str) -> Result<String, String> {
    // Step 1: List existing simulators
    let list_output = xcrun_command(&["simctl", "list", "devices", "-j"]);
    let device_name = format!("{target_device} {target_os} (webdriver)");

    let list_stdout = str::from_utf8(&list_output.stdout).expect("Invalid UTF-8 in simulator list");
    let simulators: serde_json::Value = serde_json::from_str(list_stdout).expect("Failed to parse simulator list");

    // Step 2: Search for a matching simulator (prefer Shutdown, but accept Booted)
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
                            // Prefer shutdown simulators - return immediately
                            info!("Found matching shutdown simulator {:?}", device);
                            return Ok(udid);
                        } else if state == "Booted" && booted_candidate.is_none() {
                            // Remember first booted simulator as fallback
                            info!("Found matching booted simulator {:?}", device);
                            booted_candidate = Some(udid);
                        }
                    }
                }
            }
        }
    }
    
    // Use booted simulator if no shutdown one was found
    if let Some(udid) = booted_candidate {
        info!("Reusing booted simulator: {}", udid);
        return Ok(udid);
    }
    
    info!("No matching simulator found, creating a new one...");

    // Step 3: Create a new simulator if no match is found
    let create_output = xcrun_command(&[
        "simctl",
        "create",
        &device_name,
        &("com.apple.CoreSimulator.SimDeviceType.".to_owned() + target_device),
        &("com.apple.CoreSimulator.SimRuntime.".to_owned() + target_os),
    ]);

    let cargo_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let path_to_ca_cert = cargo_path.join("cacert.pem");

    // Install CA Key
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

// Platform configuration
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Platform {
    IOS,
    MacOS,
}

impl Platform {
    fn from_env() -> Self {
        let env_value = std::env::var("TARGET_PLATFORM");
        info!("TARGET_PLATFORM env var: {:?}", env_value);
        match env_value.as_deref() {
            Ok("macos") | Ok("macOS") | Ok("mac") => {
                info!("Detected macOS platform");
                Platform::MacOS
            },
            Ok(val) => {
                info!("TARGET_PLATFORM={} not recognized, defaulting to iOS", val);
                Platform::IOS
            },
            Err(_) => {
                info!("TARGET_PLATFORM not set, defaulting to iOS");
                Platform::IOS // Default to iOS for backward compatibility
            }
        }
    }

    fn bundle_id(&self) -> &'static str {
        match self {
            Platform::IOS => "com.duckduckgo.mobile.ios",
            Platform::MacOS => "com.duckduckgo.macos.browser",
        }
    }
}

const APP_BUNDLE_ID_IOS: &str = "com.duckduckgo.mobile.ios";
const APP_BUNDLE_ID_MACOS: &str = "com.duckduckgo.macos.browser";
const APP_BUNDLE_ID_MACOS_DEBUG: &str = "com.duckduckgo.macos.browser.debug";

// Development team ID for DuckDuckGo macOS apps
const MACOS_DEVELOPMENT_TEAM: &str = "HKE973VLUW";

/// DuckDuckGo-specific session capabilities
#[derive(Clone, Debug, Default)]
pub struct DdgCapabilities {
    /// Custom URL for privacy configuration (overrides bundled config via cache write)
    pub privacy_config_url: Option<String>,
    /// Local file path for privacy configuration (uses TEST_PRIVACY_CONFIG_PATH env var)
    pub privacy_config_path: Option<String>,
}

impl DdgCapabilities {
    /// Parse DuckDuckGo capabilities from WebDriver NewSession parameters
    pub fn from_new_session_params(params: &webdriver::command::NewSessionParameters) -> Self {
        let mut caps = DdgCapabilities::default();
        
        // NewSessionParameters is an enum, try multiple serialization approaches
        if let Ok(value) = serde_json::to_value(params) {
            info!("Serialized NewSessionParameters: {}", value);
            
            // Approach 1: Direct capabilities.alwaysMatch (Spec variant)
            if let Some(capabilities) = value.get("capabilities") {
                if let Some(always_match) = capabilities.get("alwaysMatch") {
                    caps.extract_from_value(always_match);
                }
                if let Some(first_match) = capabilities.get("firstMatch").and_then(|v| v.as_array()) {
                    for match_caps in first_match {
                        caps.extract_from_value(match_caps);
                    }
                }
            }
            
            // Approach 2: Spec enum variant wrapper { "Spec": { "alwaysMatch": ... } }
            if caps.privacy_config_url.is_none() {
                if let Some(spec) = value.get("Spec") {
                    if let Some(always_match) = spec.get("alwaysMatch") {
                        caps.extract_from_value(always_match);
                    }
                    if let Some(first_match) = spec.get("firstMatch").and_then(|v| v.as_array()) {
                        for match_caps in first_match {
                            caps.extract_from_value(match_caps);
                        }
                    }
                }
            }
            
            // Approach 3: Direct alwaysMatch at root level
            if caps.privacy_config_url.is_none() {
                if let Some(always_match) = value.get("alwaysMatch") {
                    caps.extract_from_value(always_match);
                }
            }
        } else {
            info!("Failed to serialize NewSessionParameters to JSON");
        }
        
        info!("Parsed DuckDuckGo capabilities: {:?}", caps);
        caps
    }
    
    fn extract_from_value(&mut self, caps: &Value) {
        // Look for ddg:privacyConfigURL (writes to cache)
        if let Some(url) = caps.get("ddg:privacyConfigURL").and_then(|v| v.as_str()) {
            info!("Found ddg:privacyConfigURL: {}", url);
            self.privacy_config_url = Some(url.to_string());
        }
        // Look for ddg:privacyConfigPath (uses TEST_PRIVACY_CONFIG_PATH env var)
        if let Some(path) = caps.get("ddg:privacyConfigPath").and_then(|v| v.as_str()) {
            info!("Found ddg:privacyConfigPath: {}", path);
            self.privacy_config_path = Some(path.to_string());
        }
    }
}

// Get bundle ID from app's Info.plist
fn get_macos_bundle_id(app_path: &str) -> String {
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
                APP_BUNDLE_ID_MACOS_DEBUG.to_string()
            } else {
                APP_BUNDLE_ID_MACOS.to_string()
            }
        }
    }
}

// macOS-specific functions
fn write_macos_defaults(bundle_id: &str, key: &str, key_type: &str, value: &str) {
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
/// For macOS DuckDuckGo browser:
/// - Debug: com.duckduckgo.macos.browser.debug -> HKE973VLUW.com.duckduckgo.macos.browser.app-configuration.debug
/// - Release: com.duckduckgo.macos.browser -> HKE973VLUW.com.duckduckgo.macos.browser.app-configuration
fn derive_macos_app_config_group(bundle_id: &str) -> String {
    // Pattern: <team_id>.<base_bundle_id>.app-configuration[.suffix]
    // The bundle ID may have a suffix like .debug, .alpha, .review
    let known_suffixes = [".debug", ".alpha", ".review", ".ci"];
    
    let (base_id, suffix) = known_suffixes
        .iter()
        .find(|s| bundle_id.ends_with(*s))
        .map(|s| {
            let base = &bundle_id[..bundle_id.len() - s.len()];
            (base, *s)
        })
        .unwrap_or((bundle_id, ""));
    
    format!("{}.{}.app-configuration{}", MACOS_DEVELOPMENT_TEAM, base_id, suffix)
}

/// Write a string value to the app configuration group defaults on macOS
fn write_macos_app_config_defaults(bundle_id: &str, key: &str, value: &str) {
    let group_id = derive_macos_app_config_group(bundle_id);
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

/// Fetch privacy configuration from URL (supports http://, https://, and file://)
fn fetch_privacy_config(config_url: &str) -> Result<Vec<u8>, String> {
    info!("Fetching privacy config from: {}", config_url);
    
    if config_url.starts_with("file://") {
        // Handle local file paths
        let file_path = config_url.strip_prefix("file://").unwrap();
        match std::fs::read(file_path) {
            Ok(data) => {
                info!("Read {} bytes from local file", data.len());
                Ok(data)
            },
            Err(e) => Err(format!("Failed to read file {}: {}", file_path, e))
        }
    } else {
        // Handle HTTP/HTTPS URLs
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| format!("Failed to create HTTP client: {}", e))?;
        
        let response = client.get(config_url)
            .send()
            .map_err(|e| format!("Failed to fetch config: {}", e))?;
        
        if !response.status().is_success() {
            return Err(format!("HTTP error: {}", response.status()));
        }
        
        let data = response.bytes()
            .map_err(|e| format!("Failed to read response body: {}", e))?;
        
        info!("Fetched {} bytes from URL", data.len());
        Ok(data.to_vec())
    }
}

/// Get the macOS app group container path
fn get_macos_group_container_path(group_id: &str) -> Option<PathBuf> {
    // On macOS, group containers are at ~/Library/Group Containers/<group-id>/
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
fn setup_macos_privacy_config(bundle_id: &str, config_url: &str) {
    let group_id = derive_macos_app_config_group(bundle_id);
    info!("Setting up custom privacy config for {}", bundle_id);
    info!("  Config group: {}", group_id);
    info!("  Config URL: {}", config_url);
    
    // Fetch the config data
    let config_data = match fetch_privacy_config(config_url) {
        Ok(data) => data,
        Err(e) => {
            info!("Failed to fetch privacy config: {}", e);
            // Fall back to just setting the URL
            set_macos_config_url(&group_id, config_url);
            return;
        }
    };
    
    // Get the group container path
    let container_path = match get_macos_group_container_path(&group_id) {
        Some(path) => path,
        None => {
            info!("Failed to get group container path, falling back to URL mode");
            set_macos_config_url(&group_id, config_url);
            return;
        }
    };
    
    // Create the directory if it doesn't exist
    if let Err(e) = std::fs::create_dir_all(&container_path) {
        info!("Failed to create group container directory: {}", e);
        set_macos_config_url(&group_id, config_url);
        return;
    }
    
    // Write the config file (macOS uses "macos-config.json")
    let config_file = container_path.join("macos-config.json");
    info!("Writing config to: {:?}", config_file);
    
    if let Err(e) = std::fs::write(&config_file, &config_data) {
        info!("Failed to write config file: {}", e);
        set_macos_config_url(&group_id, config_url);
        return;
    }
    
    // CRITICAL: Write to the GROUP CONTAINER plist, not ~/Library/Preferences
    // `defaults write <group>` writes to ~/Library/Preferences/<group>.plist
    // but UserDefaults(suiteName: <group>) reads from ~/Library/Group Containers/<group>/Library/Preferences/<group>.plist
    let prefs_dir = container_path.join("Library").join("Preferences");
    let plist_path = prefs_dir.join(format!("{}.plist", group_id));
    
    // Create the Preferences directory if needed
    if let Err(e) = std::fs::create_dir_all(&prefs_dir) {
        info!("Failed to create Preferences directory: {}", e);
        set_macos_config_url(&group_id, config_url);
        return;
    }
    
    info!("Writing UserDefaults to: {:?}", plist_path);
    
    // Build the custom config URL pointing to our cached file
    let file_url = format!("file://{}", config_file.display());
    
    // Use PlistBuddy to set values in the correct plist
    // First, create the plist if it doesn't exist
    let _ = Command::new("/usr/libexec/PlistBuddy")
        .args(&["-c", "Save", plist_path.to_str().unwrap()])
        .output();
    
    // Set isInternalUser = true (required for custom config URLs to work)
    let output = Command::new("/usr/libexec/PlistBuddy")
        .args(&[
            "-c", "Delete :isInternalUser",
            plist_path.to_str().unwrap()
        ])
        .output();
    // Ignore delete errors (key might not exist)
    
    let output = Command::new("/usr/libexec/PlistBuddy")
        .args(&[
            "-c", "Add :isInternalUser bool true",
            plist_path.to_str().unwrap()
        ])
        .output()
        .expect("Failed to run PlistBuddy");
    
    if !output.status.success() {
        info!(
            "PlistBuddy isInternalUser failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    } else {
        info!("Set isInternalUser = true");
    }
    
    // Set CustomConfigurationURL.privacyConfiguration
    let _ = Command::new("/usr/libexec/PlistBuddy")
        .args(&[
            "-c", "Delete :CustomConfigurationURL.privacyConfiguration",
            plist_path.to_str().unwrap()
        ])
        .output();
    
    let output = Command::new("/usr/libexec/PlistBuddy")
        .args(&[
            "-c", &format!("Add :CustomConfigurationURL.privacyConfiguration string {}", file_url),
            plist_path.to_str().unwrap()
        ])
        .output()
        .expect("Failed to run PlistBuddy");
    
    if !output.status.success() {
        info!(
            "PlistBuddy CustomConfigurationURL failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    } else {
        info!("Set CustomConfigurationURL.privacyConfiguration = {}", file_url);
    }
    
    info!("Successfully pre-cached privacy config ({} bytes) and set UserDefaults in group container", config_data.len());
}

/// Fallback: Set the custom config URL (used if pre-fetching fails)
fn set_macos_config_url(group_id: &str, config_url: &str) {
    info!("Setting config URL fallback mode for group {}", group_id);
    
    // Set isInternalUser to true (required for custom config URLs to be used)
    let output = Command::new("defaults")
        .args(&[
            "write",
            group_id,
            "isInternalUser",
            "-bool",
            "true",
        ])
        .output()
        .expect("Failed to write isInternalUser");
    
    if !output.status.success() {
        info!(
            "Failed to set isInternalUser: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    
    // Set the custom privacy configuration URL
    let output = Command::new("defaults")
        .args(&[
            "write",
            group_id,
            "CustomConfigurationURL.privacyConfiguration",
            "-string",
            config_url,
        ])
        .output()
        .expect("Failed to write custom config URL");
    
    if !output.status.success() {
        info!(
            "Failed to set custom config URL: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

fn is_macos_app_running(_bundle_id: &str) -> bool {
    // Check if DuckDuckGo app is running using osascript
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

fn launch_macos_app(app_path: &str, port: u16, ddg_caps: &DdgCapabilities) -> Result<(Child, String), String> {
    info!("Launching macOS app at: {}", app_path);

    // Get the bundle ID from the app
    let bundle_id = get_macos_bundle_id(app_path);
    info!("Detected bundle ID: {}", bundle_id);

    // First, quit any running instance gracefully
    if is_macos_app_running(&bundle_id) {
        info!("App is running, quitting gracefully...");
        
        // Try graceful quit via AppleScript
        let _ = Command::new("osascript")
            .args(&["-e", &format!("tell application id \"{}\" to quit", bundle_id)])
            .output();

        // Wait and check if it quit
        let mut attempts = 0;
        while is_macos_app_running(&bundle_id) && attempts < 30 {
            std::thread::sleep(std::time::Duration::from_millis(200));
            attempts += 1;
        }

        // If still running, try SIGTERM (graceful termination)
        if is_macos_app_running(&bundle_id) {
            info!("App still running, sending SIGTERM...");
            let _ = Command::new("pkill")
                .args(&["-TERM", "-f", &bundle_id])
                .output();
            
            // Wait for graceful shutdown
            let mut attempts = 0;
            while is_macos_app_running(&bundle_id) && attempts < 20 {
                std::thread::sleep(std::time::Duration::from_millis(200));
                attempts += 1;
            }
        }

        // Last resort: SIGKILL (will show crash dialog, but at least continues)
        if is_macos_app_running(&bundle_id) {
            info!("App still running, force killing...");
            let _ = Command::new("pkill")
                .args(&["-KILL", "-f", &bundle_id])
                .output();
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    }

    // Write the automation port to defaults using correct bundle ID
    write_macos_defaults(&bundle_id, "automationPort", "int", &port.to_string());
    write_macos_defaults(&bundle_id, "isUITesting", "bool", "true");
    write_macos_defaults(&bundle_id, "isOnboardingCompleted", "string", "true");

    // Set up custom privacy configuration if provided via URL (writes to cache)
    if let Some(ref config_url) = ddg_caps.privacy_config_url {
        setup_macos_privacy_config(&bundle_id, config_url);
    }

    // Launch the app
    // Remove CI env var to prevent app from thinking it's in UI test mode
    // (which would cause it to try loading MockEncryptionKeyStore that doesn't exist)
    let child = if let Some(ref config_path) = ddg_caps.privacy_config_path {
        // When using privacy_config_path, we launch the binary directly to pass env vars
        // The `open -a` command doesn't support passing environment variables to the app
        let binary_path = format!("{}/Contents/MacOS/DuckDuckGo", app_path);
        info!("Launching binary directly with TEST_PRIVACY_CONFIG_PATH={}", config_path);
        Command::new(&binary_path)
            .args(&["-isUITesting", "true"])
            .env("TEST_PRIVACY_CONFIG_PATH", config_path)
            .env_remove("CI")
            .spawn()
            .map_err(|e| format!("Failed to launch app binary: {}", e))?
    } else {
        // Use standard `open -a` approach
        Command::new("open")
            .args(&["-a", app_path, "--args", "-isUITesting", "true"])
            .env_remove("CI")
            .spawn()
            .map_err(|e| format!("Failed to launch app: {}", e))?
    };

    Ok((child, bundle_id))
}

fn monitor_macos_logs(bundle_id: &str) -> Child {
    let child = Command::new("log")
        .args(&[
            "stream",
            "--info",
            "--debug",
            "--predicate",
            &format!("subsystem == \"{}\"", bundle_id),
        ])
        .stdout(Stdio::piped())
        .spawn()
        .expect("Failed to start log stream");
    child
}

fn quit_macos_app_with_port(port: Option<u16>) {
    info!("Quitting macOS app gracefully via /shutdown endpoint...");
    
    // Call the /shutdown endpoint which cleanly closes the automation server
    // and then terminates the app via exit(0) - avoiding crash dialogs
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build();
    
    // If we have the actual port, use it; otherwise try common ports as fallback
    let ports_to_try: Vec<u16> = match port {
        Some(p) => vec![p],
        None => (8557..=8570).collect(), // Try a range of ports as fallback
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
    
    // Wait for the app to terminate (the /shutdown endpoint schedules exit after 0.5s)
    std::thread::sleep(std::time::Duration::from_millis(1500));
    
    // Verify it's not running
    for _ in 0..10 {
        if !is_macos_app_running("com.duckduckgo.macos.browser") {
            info!("macOS app terminated cleanly");
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    
    // Fallback: if /shutdown didn't work, try AppleScript
    info!("App still running, trying AppleScript quit...");
    let _ = Command::new("osascript")
        .args(&["-e", "tell application \"DuckDuckGo\" to quit"])
        .output();
    
    std::thread::sleep(std::time::Duration::from_millis(1000));
    
    if !is_macos_app_running("com.duckduckgo.macos.browser") {
        info!("macOS app quit via AppleScript");
        return;
    }
    
    // Last resort - SIGTERM
    info!("App not responding, sending SIGTERM...");
    let _ = Command::new("pkill")
        .args(&["-TERM", "-f", "DuckDuckGo.app"])
        .output();
}

fn server_request_for_platform(session_id: &str, platform: &Platform, method: &str, params: &std::collections::HashMap<&str, &str>) -> String {
    match platform {
        Platform::IOS => {
            // iOS uses simulator logs
            let mut child = monitor_simulator_logs(&session_id);
            let stdout = child.stdout.take().expect("Failed to capture stdout");
            thread::spawn(move || {
                let reader = BufReader::new(stdout);
                info!("Simulator logs:");
                for line in reader.lines() {
                    if let Ok(log_line) = line {
                        info!("{}", log_line);
                    }
                }
                info!("Simulator logs end");
            });
            let port = get_port(session_id);
            let result = make_server_request(port, method, params);
            let _ = child.kill();
            result
        },
        Platform::MacOS => {
            // macOS uses direct log stream
            let mut child = monitor_macos_logs(APP_BUNDLE_ID_MACOS);
            let stdout = child.stdout.take().expect("Failed to capture stdout");
            thread::spawn(move || {
                let reader = BufReader::new(stdout);
                info!("macOS app logs:");
                for line in reader.lines() {
                    if let Ok(log_line) = line {
                        info!("{}", log_line);
                    }
                }
                info!("macOS app logs end");
            });
            let port = get_port(session_id);
            let result = make_server_request(port, method, params);
            let _ = child.kill();
            result
        }
    }
}

fn make_server_request(port: u16, method: &str, params: &std::collections::HashMap<&str, &str>) -> String {
    let query_string: String = params.iter()
        .map(|(key, value)| format!("{}={}", key, value))
        .collect::<Vec<String>>()
        .join("&");
    let url = format!("http://localhost:{}/{method}?{}", port, query_string);
    info!("URL to send: {:?}", url);
    let client = reqwest::blocking::Client::new();
    let resp = client.get(url)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .map_err(|e| {
            if e.is_timeout() {
                info!("Request timed out");
                "Request timed out".to_string()
            } else {
                format!("Request error: {}", e)
            }
        })
        .expect("Failed to send request")
        .text()
        .expect("Failed to read response text");
    info!("Response: {:#?}", resp);

    #[derive(Deserialize)]
    struct Response {
        message: String,
    }
    let json: Response = serde_json::from_str(&resp).expect("Failed to parse response");
    return json.message;
}

// iOS-specific constants (kept for backward compatibility)
const APP_BUNDLE_ID: &str = "com.duckduckgo.mobile.ios";

fn monitor_simulator_logs(udid: &str) -> Child {

/*
xcrun

simctl
spawn
booted
log
show
--last 900m --info --debug --predicate 'subsystem == "com.duckduckgo.mobile.ios"' --style compact

*/
    let child = Command::new("xcrun")
        .args(&[
            "simctl",
            "spawn",
            udid,
            "log",
            "stream",
            // "--level",
            // "debug",
            "--info",
            "--debug",
            "--predicate",
            &format!("subsystem == \"{}\"", APP_BUNDLE_ID),
            //&format!("processImagePath CONTAINS \"{}\"", APP_BUNDLE_ID)
        ])
        .stdout(Stdio::piped()) // Capture stdout
        .spawn()
        .expect("Failed to start tail process");

    // Spawn a new thread to handle tail -f output
    /*
    let stdout = child.stdout.take().expect("Failed to capture stdout");
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            if let Ok(log_line) = line {
                info!("Simulator: {}", log_line);
            }
        }
    });
    */
    return child;
}

fn xcrun_command(args: &[&str]) -> std::process::Output {
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
    /*
    // Convert stdout from bytes to a String
    let stdout_str = str::from_utf8(&output.stdout).unwrap_or("Failed to parse stdout");
    let stderr_str = str::from_utf8(&output.stderr).unwrap_or("Failed to parse stderr");

    // Print the captured output
    println!("stdout: {}", stdout_str);
    println!("stderr: {}", stderr_str);
    */
    return output;
}

fn write_defaults(udid: &str, key: &str, key_type: &str, value: &str) {
    xcrun_command(&[
        "simctl",
        "spawn",
        udid,
        "defaults",
        "write",
        APP_BUNDLE_ID,
        key,
        &format!("-{key_type}"),
        value,
    ]);
}

/// iOS app configuration group identifier
/// For iOS DuckDuckGo browser: group.com.duckduckgo.app-configuration
const IOS_APP_CONFIG_GROUP: &str = "group.com.duckduckgo.app-configuration";
/// iOS content blocker group (where config files are stored)
const IOS_CONTENT_BLOCKER_GROUP: &str = "group.com.duckduckgo.contentblocker";

/// Write a value to the iOS app configuration group defaults via simulator
fn write_ios_app_config_defaults(udid: &str, key: &str, key_type: &str, value: &str) {
    info!("Writing to iOS app config group {}: {} = {}", IOS_APP_CONFIG_GROUP, key, value);
    xcrun_command(&[
        "simctl",
        "spawn",
        udid,
        "defaults",
        "write",
        IOS_APP_CONFIG_GROUP,
        key,
        &format!("-{}", key_type),
        value,
    ]);
}

/// Get the iOS simulator's group container path
fn get_ios_simulator_group_container(udid: &str, group_id: &str) -> Option<PathBuf> {
    // Use simctl to get the container path
    let output = Command::new("xcrun")
        .args(&[
            "simctl",
            "get_app_container",
            udid,
            APP_BUNDLE_ID,
            "groups",
        ])
        .output();
    
    match output {
        Ok(out) if out.status.success() => {
            // Output contains paths for all groups, need to find the right one
            let stdout = String::from_utf8_lossy(&out.stdout);
            for line in stdout.lines() {
                if line.contains(group_id) {
                    // Line format: "group.com.duckduckgo.contentblocker  /path/to/container"
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
/// This pre-fetches the config and writes it directly to the app's cache
fn setup_ios_privacy_config(udid: &str, config_url: &str) {
    info!("Setting up custom privacy config for iOS simulator {}", udid);
    info!("  Config URL: {}", config_url);
    
    // Fetch the config data
    let config_data = match fetch_privacy_config(config_url) {
        Ok(data) => data,
        Err(e) => {
            info!("Failed to fetch privacy config: {}", e);
            // Fall back to just setting the URL
            set_ios_config_url_fallback(udid, config_url);
            return;
        }
    };
    
    // Try to get the group container path
    // Note: The app must be installed first for the container to exist
    let container_path = get_ios_simulator_group_container(udid, IOS_CONTENT_BLOCKER_GROUP);
    
    if let Some(container) = container_path {
        info!("Found group container: {:?}", container);
        
        // Write the config file (iOS uses "privacyConfiguration")
        let config_file = container.join("privacyConfiguration");
        info!("Writing config to: {:?}", config_file);
        
        // Use simctl to write the file
        let temp_file = std::env::temp_dir().join(format!("privacyConfig-{}.json", udid));
        if let Err(e) = std::fs::write(&temp_file, &config_data) {
            info!("Failed to write temp file: {}", e);
            set_ios_config_url_fallback(udid, config_url);
            return;
        }
        
        // Copy to simulator using simctl
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
        
        // Clean up temp file
        let _ = std::fs::remove_file(&temp_file);
        
        match result {
            Ok(out) if out.status.success() => {
                info!("Successfully wrote config file to simulator");
                
                // Set etag in the content blocker group defaults
                let etag = format!("webdriver-{}", std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs());
                
                // The etag key for iOS (from UserDefaultsETagStorage)
                xcrun_command(&[
                    "simctl",
                    "spawn",
                    udid,
                    "defaults",
                    "write",
                    IOS_CONTENT_BLOCKER_GROUP,
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
    
    // Fall back to setting the URL
    set_ios_config_url_fallback(udid, config_url);
}

/// Fallback: Set the custom config URL for iOS (used if pre-fetching fails)
fn set_ios_config_url_fallback(udid: &str, config_url: &str) {
    info!("Using URL fallback mode for iOS");
    
    // Set isInternalUser to true in the app config group
    write_ios_app_config_defaults(udid, "isInternalUser", "bool", "true");
    
    // Set the custom privacy configuration URL
    write_ios_app_config_defaults(udid, "CustomConfigurationURL.privacyConfiguration", "string", config_url);
}

 impl WebDriverHandler<DuckDuckGoExtensionRoute> for Handler {
     fn handle_command(
         &mut self,
         _: &Option<Session>,
         msg: WebDriverMessage<DuckDuckGoExtensionRoute>,
     ) -> WebDriverResult<WebDriverResponse> {

        let platform = Platform::from_env();
        info!("Target platform: {:?}", platform);

        let target_device = if let Ok(env_path) = std::env::var("TARGET_DEVICE") {
            env_path
        } else {
            "iPhone-16".to_string()
        };
        let target_os = if let Ok(env_path) = std::env::var("TARGET_OS") {
            env_path
        } else {
            "iOS-18-2".to_string()
        };

        info!("Message received {:?}", msg);
        return match msg.command {
            WebDriverCommand::NewSession(ref params) => {
                // Parse DuckDuckGo-specific capabilities from the session parameters
                let ddg_caps = DdgCapabilities::from_new_session_params(params);
                
                match platform {
                    Platform::MacOS => {
                        info!("Starting macOS automation...");
                        
                        // Generate a unique session ID for macOS
                        let session_id = Uuid::new_v4().to_string();
                        
                        // Get app path from environment or use default
                        let app_path = if let Ok(env_path) = std::env::var("MACOS_APP_PATH") {
                            env_path
                        } else {
                            let derived_data_path = if let Ok(env_path) = std::env::var("DERIVED_DATA_PATH") {
                                PathBuf::from(env_path)
                            } else {
                                let current_dir = std::env::current_dir().expect("Failed to get current directory");
                                // apple-browsers DerivedData is in the ddg-workflow monorepo
                                current_dir.join("../ddg-workflow/apple-browsers/DerivedData")
                            };
                            format!("{}/Build/Products/Debug/DuckDuckGo.app", derived_data_path.to_str().expect("Failed to convert path to string"))
                        };
                        
                        info!("macOS App Path: {:?}", app_path);
                        
                        // Get port for this session
                        let port = get_port(&session_id);
                        
                        // Launch the macOS app with DuckDuckGo capabilities
                        let bundle_id = match launch_macos_app(&app_path, port, &ddg_caps) {
                            Ok((_, bundle_id)) => {
                                info!("Launched macOS app");
                                bundle_id
                            },
                            Err(e) => {
                                info!("Failed to launch macOS app: {}", e);
                                return Ok(WebDriverResponse::Generic(ValueResponse(Value::Null)));
                            }
                        };
                        
                        // Start monitoring logs with correct bundle ID
                        let mut child = monitor_macos_logs(&bundle_id);
                        let stdout = child.stdout.take().expect("Failed to capture stdout");
                        thread::spawn(move || {
                            let reader = BufReader::new(stdout);
                            info!("macOS app logs:");
                            for line in reader.lines() {
                                if let Ok(log_line) = line {
                                    info!("{}", log_line);
                                }
                            }
                            info!("macOS app logs end");
                        });
                        
                        // Wait for the server to start by testing connectivity
                        info!("Waiting for automation server on port {}...", port);
                        let mut attempts = 0;
                        loop {
                            // Try to actually connect to the server
                            let client = reqwest::blocking::Client::builder()
                                .timeout(std::time::Duration::from_millis(500))
                                .build()
                                .expect("Failed to create client");
                            match client.get(format!("http://localhost:{}/getUrl", port)).send() {
                                Ok(_) => {
                                    info!("Server responding on port {}", port);
                                    break;
                                }
                                Err(_) => {
                                    // Server not ready yet
                                }
                            }
                            attempts += 1;
                            if attempts > 120 { // 60 seconds timeout
                                panic!("Timeout waiting for automation server to start");
                            }
                            std::thread::sleep(std::time::Duration::from_millis(500));
                        }
                        
                        // Wait for content blocker rules to be compiled
                        // This ensures the browser is fully ready before WebDriver considers the session started
                        info!("Waiting for content blocker to be ready...");
                        let cb_start = std::time::Instant::now();
                        let mut cb_attempts = 0;
                        loop {
                            let client = reqwest::blocking::Client::builder()
                                .timeout(std::time::Duration::from_millis(500))
                                .build()
                                .expect("Failed to create client");
                            match client.get(format!("http://localhost:{}/contentBlockerReady", port)).send() {
                                Ok(response) => {
                                    if let Ok(text) = response.text() {
                                        // Parse JSON: { "message": "true"|"false", "requestPath": "/contentBlockerReady" }
                                        if let Ok(json) = serde_json::from_str::<Value>(&text) {
                                            if let Some(message) = json.get("message").and_then(|v| v.as_str()) {
                                                if message == "true" {
                                                    let elapsed = cb_start.elapsed();
                                                    info!("Content blocker ready after {:?} ({} attempts)", elapsed, cb_attempts + 1);
                                                    break;
                                                }
                                            }
                                            info!("Content blocker not ready yet (attempt {}, message: {:?})", cb_attempts + 1, json.get("message"));
                                        } else {
                                            info!("Content blocker check: failed to parse JSON (attempt {}): {}", cb_attempts + 1, text);
                                        }
                                    }
                                }
                                Err(e) => {
                                    info!("Content blocker check failed (attempt {}): {}", cb_attempts + 1, e);
                                }
                            }
                            cb_attempts += 1;
                            if cb_attempts > 60 { // 30 seconds timeout for content blocker
                                info!("Warning: Timeout waiting for content blocker after {:?}, proceeding anyway", cb_start.elapsed());
                                break;
                            }
                            std::thread::sleep(std::time::Duration::from_millis(500));
                        }
                        
                        let _ = child.kill();
                        let capabilities = Map::new();
                        Ok(WebDriverResponse::NewSession(NewSessionResponse {
                            session_id: session_id,
                            capabilities: Value::Object(capabilities),
                        }))
                    },
                    Platform::IOS => {
                        info!("Starting iOS automation... {:?} {:?}", target_device, target_os);
                        let simulator_udid = match find_or_create_simulator(&target_device, &target_os) {
                            Ok(udid) => udid,
                            Err(e) => {
                                info!("Failed to find or create simulator: {}", e);
                                return Ok(WebDriverResponse::Generic(ValueResponse(Value::Null)));
                            }
                        };
                        info!("Simulator UDID: {:?}", simulator_udid);
                    
                        // Boot the simulator (if it's not already booted)
                        xcrun_command(&["simctl", "boot", &simulator_udid]);
                    
                        // Launch the simulator app
                        Command::new("open")
                            .args(&["-a", "Simulator"])
                            .status()
                            .expect("Failed to open the Simulator app");
                        info!("Opened Simulator app");
                        xcrun_command(&["simctl", "terminate", &simulator_udid, APP_BUNDLE_ID]);
                        xcrun_command(&["simctl", "uninstall", &simulator_udid, APP_BUNDLE_ID]);
                        info!("Uninstalled app");
                        // Install the app on the simulator
                        let derived_data_path = if let Ok(env_path) = std::env::var("DERIVED_DATA_PATH") {
                            PathBuf::from(env_path)
                        } else {
                            let current_dir = std::env::current_dir().expect("Failed to get current directory");
                            current_dir.join("../DerivedData")
                        };
                        let derived_data_path = derived_data_path.to_str().expect("Failed to convert path to string");
                        let app_path = format!("{derived_data_path}/Build/Products/Debug-iphonesimulator/DuckDuckGo.app");
                        info!("App Path: {:?}", app_path);
                        if !xcrun_command(&["simctl", "install", &simulator_udid, app_path.as_str()]).status.success() {
                            panic!("Failed to install the app");
                        }
                        info!("Installed app");
                        let mut child = monitor_simulator_logs(&simulator_udid);
                        let stdout = child.stdout.take().expect("Failed to capture stdout");
                        thread::spawn(move || {
                            let reader = BufReader::new(stdout);
                            info!("Simulator logs:");
                            for line in reader.lines() {
                                if let Ok(log_line) = line {
                                    info!("{}", log_line);
                                }
                            }
                            info!("Simulator logs end");
                        });
                        let logger = xcrun_command(&[
                            "simctl",
                            "spawn",
                            &simulator_udid,
                            "log",
                            "config",
                            "--mode",
                            "level:debug",
                            "-subsystem",
                            &APP_BUNDLE_ID
                        ]);
                        if !logger.status.success() {
                            panic!("Failed to set log level\n{}", String::from_utf8_lossy(&logger.stderr));
                        }

                        let persist_logs = xcrun_command(&[
                            "simctl",
                            "spawn",
                            &simulator_udid,
                            "log",
                            "config",
                            "--mode",
                            "persist:debug",
                            "-subsystem",
                            &APP_BUNDLE_ID
                        ]);
                        if !persist_logs.status.success() {
                            panic!("Failed to perist log level\n{}", String::from_utf8_lossy(&persist_logs.stderr));
                        }

                        write_defaults(&simulator_udid, "isUITesting", "bool", "true");
                        write_defaults(&simulator_udid, "isOnboardingCompleted", "string", "true");
                        let port = get_port(&simulator_udid);
                        write_defaults(&simulator_udid, "automationPort", "int", port.to_string().as_str());

                        // Set up custom privacy configuration if provided
                        if let Some(ref config_url) = ddg_caps.privacy_config_url {
                            setup_ios_privacy_config(&simulator_udid, config_url);
                        }

                        if !xcrun_command(&[
                                "simctl",
                                "launch",
                                &simulator_udid,
                                APP_BUNDLE_ID,
                                "isUITesting",
                                "true"
                            ]).status.success() {
                            panic!("Failed to launch the app");
                        }

                        // Wait for the server to start
                        loop {
                            if !port_is_available(port) {
                                break;
                            }
                        }

                        // Wait for content blocker rules to be compiled
                        // This ensures the browser is fully ready before WebDriver considers the session started
                        info!("Waiting for content blocker to be ready (iOS)...");
                        let cb_start = std::time::Instant::now();
                        let mut cb_attempts = 0;
                        loop {
                            let client = reqwest::blocking::Client::builder()
                                .timeout(std::time::Duration::from_millis(500))
                                .build()
                                .expect("Failed to create client");
                            match client.get(format!("http://localhost:{}/contentBlockerReady", port)).send() {
                                Ok(response) => {
                                    if let Ok(text) = response.text() {
                                        // Parse JSON: { "message": "true"|"false", "requestPath": "/contentBlockerReady" }
                                        if let Ok(json) = serde_json::from_str::<Value>(&text) {
                                            if let Some(message) = json.get("message").and_then(|v| v.as_str()) {
                                                if message == "true" {
                                                    let elapsed = cb_start.elapsed();
                                                    info!("Content blocker ready (iOS) after {:?} ({} attempts)", elapsed, cb_attempts + 1);
                                                    break;
                                                }
                                            }
                                            info!("Content blocker not ready yet (iOS, attempt {}, message: {:?})", cb_attempts + 1, json.get("message"));
                                        } else {
                                            info!("Content blocker check (iOS): failed to parse JSON (attempt {}): {}", cb_attempts + 1, text);
                                        }
                                    }
                                }
                                Err(e) => {
                                    info!("Content blocker check failed (iOS, attempt {}): {}", cb_attempts + 1, e);
                                }
                            }
                            cb_attempts += 1;
                            if cb_attempts > 60 { // 30 seconds timeout for content blocker
                                info!("Warning: Timeout waiting for content blocker (iOS) after {:?}, proceeding anyway", cb_start.elapsed());
                                break;
                            }
                            std::thread::sleep(std::time::Duration::from_millis(500));
                        }

                        let _ = child.kill(); // Gracefully kill the child process
                        let capabilities = Map::new();
                        Ok(WebDriverResponse::NewSession(NewSessionResponse {
                            session_id: simulator_udid.to_string(),
                            capabilities: Value::Object(capabilities),
                        }))
                    }
                }
            },
            DeleteSession => {
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                info!("Deleting session {:?}", session_id);
                match platform {
                    Platform::MacOS => {
                        let port = get_port(session_id);
                        quit_macos_app_with_port(Some(port));
                    },
                    Platform::IOS => {
                        // Shutdown the simulator
                        xcrun_command(&["simctl", "shutdown", &session_id]);
                    }
                }
                Ok(WebDriverResponse::Generic(ValueResponse(Value::Null)))
            },
            Status => {
                // W3C WebDriver status endpoint - indicates server readiness
                let status = serde_json::json!({
                    "ready": true,
                    "message": "DuckDuckGo WebDriver ready"
                });
                Ok(WebDriverResponse::Generic(ValueResponse(status)))
            },
            Get(params) => {
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let url = params.url.as_str();
                let mut params = std::collections::HashMap::new();
                params.insert("url", url);
                server_request_for_platform(session_id, &platform, "navigate", &params);
                return Ok(WebDriverResponse::Void);
            },
            ExecuteScript(params) => {
                let script = params.script.as_str();
                info!("Script: {:#?}", params);
                let script_args = params.args.as_ref().expect("Expected args");
                // Serialize each argument to a JavaScript-compatible string
                let script_args_str = script_args
                .iter()
                .map(|arg| serde_json::to_string(arg).expect("Failed to serialize argument"))
                .collect::<Vec<_>>();

                // Join the arguments with commas
                let script_args_str = script_args_str.join(", ");

                // Wrapper that handles:
                // 1. Converting element references in args to actual DOM elements
                // 2. Converting DOM element returns to element references
                let script_wrapper = r#"
                  return (function () {
                    const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";
                    
                    // Convert element references in arguments to actual DOM elements
                    function resolveElementRefs(args) {
                      return args.map(arg => {
                        if (arg && typeof arg === 'object' && arg[ELEMENT_KEY]) {
                          // This is an element reference - look up the actual element
                          const uuid = arg[ELEMENT_KEY];
                          if (window.__webdriver_script_results) {
                            for (const [el, id] of window.__webdriver_script_results) {
                              if (id === uuid) {
                                return el;
                              }
                            }
                          }
                          throw new Error('Element not found for reference: ' + uuid);
                        }
                        return arg;
                      });
                    }
                    
                    const rawArgs = [__SCRIPT_ARGS__];
                    const resolvedArgs = resolveElementRefs(rawArgs);
                    
                    const result = (function () {
                      __SCRIPT__
                    }).apply(null, resolvedArgs);
                    
                    // Check if result is a DOM element
                    if (result instanceof Element || result instanceof Document) {
                      if (!window.__webdriver_script_results) {
                        window.__webdriver_script_results = new Map();
                      }
                      let uuid;
                      if (window.__webdriver_script_results.has(result)) {
                        uuid = window.__webdriver_script_results.get(result);
                      } else {
                        uuid = window.crypto.randomUUID();
                        window.__webdriver_script_results.set(result, uuid);
                      }
                      const elementRef = {};
                      elementRef[ELEMENT_KEY] = uuid;
                      return elementRef;
                    }
                    return result;
                  }());
                "#;
                // Replace SCRIPT and SCRIPT_ARGS with the actual script and arguments
                let script = script_wrapper.replace("__SCRIPT__", script).replace("__SCRIPT_ARGS__", script_args_str.as_str());
                let mut params = std::collections::HashMap::new();
                // Escape the script
                let script = urlencoding::encode(&script).to_string();
                params.insert("script", script.as_str());
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let response = server_request_for_platform(session_id, &platform, "execute", &params);
                
                // Response is the raw message value from the server
                // It could be:
                // 1. A JSON object string like {"element-6066-...": "uuid"}
                // 2. A JSON array or primitive
                // 3. A plain string (URL, text content, etc.)
                // 4. "null" for null values
                // 5. "true"/"false" for booleans
                
                // Try to parse as JSON first
                if let Ok(json_value) = serde_json::from_str::<Value>(&response) {
                    // Check for element reference with standard WebDriver key
                    if let Some(element_id) = json_value.get(webdriver::common::ELEMENT_KEY).and_then(|v| v.as_str()) {
                        let mut res = Map::new();
                        res.insert(webdriver::common::ELEMENT_KEY.to_string(), Value::String(element_id.to_string()));
                        return Ok(WebDriverResponse::Generic(ValueResponse(res.into())));
                    }
                    // Return parsed JSON value (could be array, object, null, bool, number)
                    return Ok(WebDriverResponse::Generic(ValueResponse(json_value)));
                }
                
                // Not valid JSON - treat as plain string
                return Ok(WebDriverResponse::Generic(ValueResponse(Value::String(response))));
            },
            ExecuteAsyncScript(params) => {
                let script = params.script.as_str();
                info!("Script: {:#?}", params);
                let script_args = params.args.as_ref().expect("Expected args");
                // Serialize each argument to a JavaScript-compatible string
                let mut script_args_str = script_args
                .iter()
                .map(|arg| serde_json::to_string(arg).expect("Failed to serialize argument"))
                .collect::<Vec<_>>();

                // Append the string "res" as the last argument
                script_args_str.push("res".to_string());

                // Join the arguments with commas
                let script_args_str = script_args_str.join(", ");

                let script_wrapper = r#"
                let promiseResult = new Promise((res, rej) => {
                  const timeout = setTimeout(() => {
                    rej("Script execution timed out");
                  }, 15000); // 15 secs

                  (async function asyncMethod () {
                    __SCRIPT__
                  }(__SCRIPT_ARGS__)).then(result => {
                    clearTimeout(timeout);
                    res(result);
                  }).catch(error => {
                    clearTimeout(timeout);
                    rej(error);
                  });
                });
                return promiseResult;
                "#;
                // Replace SCRIPT and SCRIPT_ARGS with the actual script and arguments
                let script = script_wrapper.replace("__SCRIPT__", script).replace("__SCRIPT_ARGS__", script_args_str.as_str());
                let mut params = std::collections::HashMap::new();
                // Escape the script
                let script = urlencoding::encode(&script).to_string();
                params.insert("script", script.as_str());
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let response = server_request_for_platform(session_id, &platform, "execute", &params);
                info!("Script Response: {:#?}", response);
                let parsed: Value = serde_json::from_str(&response)?;
                return Ok(WebDriverResponse::Generic(ValueResponse(parsed.into())));
            },
            FindElement(params) => {
                // Read file
                let script = include_str!("find-element.js");
                // URL encode the script
                let script = urlencoding::encode(&script).to_string();
                let mut url_params = std::collections::HashMap::new();
                url_params.insert("script", script.as_str());
                let json_string = serde_json::to_string(&params).unwrap();
                let json_string = urlencoding::encode(&json_string).to_string();
                url_params.insert("args", json_string.as_str());
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let response = server_request_for_platform(session_id, &platform, "execute", &url_params);
                // server_request already extracts the "message" field, so response is the UUID string directly
                // The response might be a JSON-encoded string, so try parsing it
                let response_clone = response.clone();
                let element_id = if let Ok(parsed) = serde_json::from_str::<Value>(&response) {
                    // If it's a JSON string, extract it
                    parsed.as_str().unwrap_or(&response).to_string()
                } else {
                    // If it's already a plain string, use it directly
                    response
                };
                info!("FindElement response: {:?}, element_id: {:?}", response_clone, element_id);
                let mut res = Map::new();
                res.insert(webdriver::common::ELEMENT_KEY.to_string(), Value::String(element_id));
                return Ok(WebDriverResponse::Generic(ValueResponse(res.into())));
            },
            FindElements(params) => {
                // Read file
                let script = include_str!("find-elements.js");
                // URL encode the script
                let script = urlencoding::encode(&script).to_string();
                let mut url_params = std::collections::HashMap::new();
                url_params.insert("script", script.as_str());
                let json_string = serde_json::to_string(&params).unwrap();
                let json_string = urlencoding::encode(&json_string).to_string();
                url_params.insert("args", json_string.as_str());
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let response = server_request_for_platform(session_id, &platform, "execute", &url_params);
                info!("FindElements raw response: {:?} (length: {})", response, response.len());
                // server_request extracts the "message" field, which contains a JSON array string like "[\"uuid1\",\"uuid2\",...]"
                // The response is the actual string content (not JSON-encoded), so we parse it directly as JSON
                let element_ids_array: Value = match serde_json::from_str::<Value>(&response) {
                    Ok(arr @ Value::Array(_)) => {
                        info!("FindElements: Parsed as array directly ({} elements)", arr.as_array().unwrap().len());
                        arr
                    }
                    Ok(Value::String(s)) => {
                        info!("FindElements: Parsed as JSON string, trying to parse inner string: {:?}", s);
                        // If it's a JSON string (double-encoded), parse it again to get the array
                        serde_json::from_str::<Value>(&s).unwrap_or_else(|e| {
                            error!("FindElements: Failed to parse inner JSON string: {} (string: {:?})", e, s);
                            Value::Array(Vec::new())
                        })
                    }
                    Ok(error_obj @ Value::Object(_)) => {
                        info!("FindElements: Parsed as object: {:?}", error_obj);
                        // Check if it's an error object
                        if let Some(error_msg) = error_obj.get("error").and_then(|v| v.as_str()) {
                            error!("FindElements script execution failed: {}", error_msg);
                            return Ok(WebDriverResponse::Generic(ValueResponse(Value::Array(Vec::new()))));
                        }
                        Value::Array(Vec::new())
                    }
                    Ok(other) => {
                        error!("FindElements: Unexpected response format: {:?}", other);
                        Value::Array(Vec::new())
                    }
                    Err(e) => {
                        error!("FindElements: Failed to parse response as JSON: {} (response: {:?})", e, response);
                        Value::Array(Vec::new())
                    }
                };
                info!("FindElements: Parsed array type: {:?}, is_array: {}, array_len: {:?}", 
                    element_ids_array, 
                    element_ids_array.is_array(),
                    element_ids_array.as_array().map(|a| a.len()));
                let element_ids: Vec<String> = element_ids_array
                    .as_array()
                    .unwrap_or(&Vec::new())
                    .iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect();
                info!("FindElements response: {:?}, element_ids: {:?}", response, element_ids);
                // Return array of element objects
                let elements: Vec<Value> = element_ids
                    .into_iter()
                    .map(|id| {
                        let mut elem = Map::new();
                        elem.insert(webdriver::common::ELEMENT_KEY.to_string(), Value::String(id));
                        Value::Object(elem)
                    })
                    .collect();
                return Ok(WebDriverResponse::Generic(ValueResponse(elements.into())));
            },
            ElementClick(element_ref) => {
                let script_body = r#"
                let element;
                if (!window.__webdriver_script_results) {
                    throw new Error('No elements found');
                }
                // Find element by UUID
                for (const [el, id] of window.__webdriver_script_results) {
                    if (id === elementId) {
                        element = el;
                        break;
                    }
                }

                if (!element) {
                    throw new Error('Element not found');
                }
                element.click();
                return "clicked";
                "#;
                let script = [
                    format!("let elementId = '{}';", &element_ref),
                    script_body.to_string(),
                ].join(" ");
                let script = urlencoding::encode(&script).to_string();
                let mut params = std::collections::HashMap::new();
                params.insert("script", script.as_str());
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                server_request_for_platform(session_id, &platform, "execute", &params);
                return Ok(WebDriverResponse::Void);
            },
            GetElementText(element_ref) => {
                let script_body = r#"
                if (!window.__webdriver_script_results) {
                    return '';
                }
                for (const [el, id] of window.__webdriver_script_results) {
                    if (id === elementId) {
                        return el.textContent || el.innerText || '';
                    }
                }
                return '';
                "#;
                let script = [
                    format!("let elementId = '{}';", &element_ref),
                    script_body.to_string(),
                ].join(" ");
                let script = urlencoding::encode(&script).to_string();
                let mut params = std::collections::HashMap::new();
                params.insert("script", script.as_str());
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let response = server_request_for_platform(session_id, &platform, "execute", &params);
                // Response might be JSON string, extract text
                let text = serde_json::from_str::<Value>(&response)
                    .ok()
                    .and_then(|v| v.as_str().map(|s| s.to_string()))
                    .unwrap_or(response);
                return Ok(WebDriverResponse::Generic(ValueResponse(Value::String(text))));
            },
            GetElementAttribute(element_ref, attr_name) => {
                info!("GetElementAttribute called: element={}, attr={}", element_ref, attr_name);
                let script_body = r#"
                if (!window.__webdriver_script_results) {
                    return null;
                }
                for (const [el, id] of window.__webdriver_script_results) {
                    if (id === elementId) {
                        return el.getAttribute(attrName);
                    }
                }
                return null;
                "#;
                let script = [
                    format!("let elementId = '{}';", &element_ref),
                    format!("let attrName = '{}';", &attr_name),
                    script_body.to_string(),
                ].join(" ");
                let script = urlencoding::encode(&script).to_string();
                let mut params = std::collections::HashMap::new();
                params.insert("script", script.as_str());
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let response = server_request_for_platform(session_id, &platform, "execute", &params);
                // Response is the raw attribute value (not JSON-encoded)
                // If it's "null" string, return null, otherwise return the string
                if response == "null" || response.is_empty() {
                    return Ok(WebDriverResponse::Generic(ValueResponse(Value::Null)));
                }
                return Ok(WebDriverResponse::Generic(ValueResponse(Value::String(response))));
            },
            IsDisplayed(element_ref) => {
                let script_body = r#"
                if (!window.__webdriver_script_results) {
                    return false;
                }
                for (const [el, id] of window.__webdriver_script_results) {
                    if (id === elementId) {
                        const style = window.getComputedStyle(el);
                        const rect = el.getBoundingClientRect();
                        return style.display !== 'none' && 
                               style.visibility !== 'hidden' && 
                               style.opacity !== '0' &&
                               rect.width > 0 && 
                               rect.height > 0;
                    }
                }
                return false;
                "#;
                let script = [
                    format!("let elementId = '{}';", &element_ref),
                    script_body.to_string(),
                ].join(" ");
                let script = urlencoding::encode(&script).to_string();
                let mut params = std::collections::HashMap::new();
                params.insert("script", script.as_str());
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let response = server_request_for_platform(session_id, &platform, "execute", &params);
                // Response is "true" or "false" string, or "1"/"0"
                let is_displayed = response == "true" || response == "1";
                return Ok(WebDriverResponse::Generic(ValueResponse(Value::Bool(is_displayed))));
            },
            ElementSendKeys(element_ref, keys) => {
                info!("ElementSendKeys called: element={}, keys={:?}", element_ref, keys);
                let script_body = r#"
                if (!window.__webdriver_script_results) {
                    throw new Error('No elements found');
                }
                let element;
                for (const [el, id] of window.__webdriver_script_results) {
                    if (id === elementId) {
                        element = el;
                        break;
                    }
                }
                if (!element) {
                    throw new Error('Element not found: ' + elementId);
                }
                // Focus the element
                element.focus();
                // Set the value - handle different input types
                if ('value' in element) {
                    element.value = textToSend;
                } else if (element.isContentEditable) {
                    element.textContent = textToSend;
                }
                // Dispatch events to trigger any listeners
                element.dispatchEvent(new Event('input', { bubbles: true }));
                element.dispatchEvent(new Event('change', { bubbles: true }));
                return 'sent';
                "#;
                // The keys parameter contains a "text" field with the text to send
                let text = keys.text.as_str();
                let script = [
                    format!("let elementId = '{}';", &element_ref),
                    format!("let textToSend = {};", serde_json::to_string(text).unwrap()),
                    script_body.to_string(),
                ].join(" ");
                let script = urlencoding::encode(&script).to_string();
                let mut params = std::collections::HashMap::new();
                params.insert("script", script.as_str());
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let response = server_request_for_platform(session_id, &platform, "execute", &params);
                info!("ElementSendKeys response: {:?}", response);
                return Ok(WebDriverResponse::Void);
            },
            ElementClear(element_ref) => {
                info!("ElementClear called: element={}", element_ref);
                let script_body = r#"
                if (!window.__webdriver_script_results) {
                    throw new Error('No elements found');
                }
                let element;
                for (const [el, id] of window.__webdriver_script_results) {
                    if (id === elementId) {
                        element = el;
                        break;
                    }
                }
                if (!element) {
                    throw new Error('Element not found: ' + elementId);
                }
                // Focus the element
                element.focus();
                // Clear the value
                if ('value' in element) {
                    element.value = '';
                } else if (element.isContentEditable) {
                    element.textContent = '';
                }
                // Dispatch events to trigger any listeners
                element.dispatchEvent(new Event('input', { bubbles: true }));
                element.dispatchEvent(new Event('change', { bubbles: true }));
                return 'cleared';
                "#;
                let script = [
                    format!("let elementId = '{}';", &element_ref),
                    script_body.to_string(),
                ].join(" ");
                let script = urlencoding::encode(&script).to_string();
                let mut params = std::collections::HashMap::new();
                params.insert("script", script.as_str());
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let response = server_request_for_platform(session_id, &platform, "execute", &params);
                info!("ElementClear response: {:?}", response);
                return Ok(WebDriverResponse::Void);
            },
            GetTitle => {
                let script = "return document.title || '';";
                let script = urlencoding::encode(script).to_string();
                let mut params = std::collections::HashMap::new();
                params.insert("script", script.as_str());
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let response = server_request_for_platform(session_id, &platform, "execute", &params);
                let title = serde_json::from_str::<Value>(&response)
                    .ok()
                    .and_then(|v| v.as_str().map(|s| s.to_string()))
                    .unwrap_or_default();
                return Ok(WebDriverResponse::Generic(ValueResponse(Value::String(title))));
            },
            NewWindow(_) => {
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let window_handle = server_request_for_platform(session_id, &platform, "newWindow", &std::collections::HashMap::new());
                info!("New window handle: {:#?}", window_handle);
                #[derive(Deserialize, Debug)]
                struct ResponseNewWindow {
                    handle: String,
                    r#type: String
                }
                let response: ResponseNewWindow = serde_json::from_str(&window_handle).expect("Failed to parse window handles");
                info!("Window handle json: {:#?}", response);
                return Ok(WebDriverResponse::NewWindow(NewWindowResponse {
                    handle: response.handle,
                    typ: response.r#type,
                }));
            },
            CloseWindow => {
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let window_handle = server_request_for_platform(session_id, &platform, "closeWindow", &std::collections::HashMap::new());
                info!("Close window handle: {:#?}", window_handle);

                let window_handles = server_request_for_platform(session_id, &platform, "getWindowHandles", &std::collections::HashMap::new());
                // Parse json string
                let window_handles: Vec<String> = serde_json::from_str(&window_handles).expect("Failed to parse window handles");
                info!("Window handles: {:#?}", window_handles);
                return Ok(WebDriverResponse::Generic(ValueResponse(window_handles.into())));
            },
            SwitchToWindow(params_in) => {
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let mut params = std::collections::HashMap::new();
                params.insert("handle", params_in.handle.as_str());
                server_request_for_platform(session_id, &platform, "switchToWindow", &params);
                return Ok(WebDriverResponse::Generic(ValueResponse(Value::Null)));
            },
            GetWindowHandle => {
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let window_handle = server_request_for_platform(session_id, &platform, "getWindowHandle", &std::collections::HashMap::new());
                info!("Window handle: {:#?}", window_handle);
                return Ok(WebDriverResponse::Generic(ValueResponse(Value::String(window_handle))));
            },
            GetWindowHandles => {
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let window_handles = server_request_for_platform(session_id, &platform, "getWindowHandles", &std::collections::HashMap::new());
                // Parse json string
                let window_handles: Vec<String> = serde_json::from_str(&window_handles).expect("Failed to parse window handles");
                info!("Window handles: {:#?}", window_handles);
                return Ok(WebDriverResponse::Generic(ValueResponse(window_handles.into())));
            },
            GetCurrentUrl => {
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                info!("Session {:?}", session_id);
                let url_string = server_request_for_platform(session_id, &platform, "getUrl", &std::collections::HashMap::new());
                info!("UrlString response: {:#?}", url_string);
                return Ok(WebDriverResponse::Generic(ValueResponse(Value::String(url_string))));
            },
            ReleaseActions | PerformActions(_) => {
                info!("Actions command - no-op, returning void");
                return Ok(WebDriverResponse::Void);
            },
            TakeScreenshot => {
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let response = server_request_for_platform(session_id, &platform, "screenshot", &std::collections::HashMap::new());
                // WebDriver spec requires base64-encoded PNG data
                return Ok(WebDriverResponse::Generic(ValueResponse(Value::String(response))));
            },
            TakeElementScreenshot(element_ref) => {
                let script_body = r#"
                if (!window.__webdriver_script_results) {
                    return null;
                }
                for (const [el, id] of window.__webdriver_script_results) {
                    if (id === elementId) {
                        const rect = el.getBoundingClientRect();
                        return JSON.stringify({
                            x: Math.round(rect.x),
                            y: Math.round(rect.y),
                            width: Math.round(rect.width),
                            height: Math.round(rect.height)
                        });
                    }
                }
                return null;
                "#;
                let script = [
                    format!("let elementId = '{}';", &element_ref),
                    script_body.to_string(),
                ].join(" ");
                let script = urlencoding::encode(&script).to_string();
                let mut params = std::collections::HashMap::new();
                params.insert("script", script.as_str());
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let rect_response = server_request_for_platform(session_id, &platform, "execute", &params);
                
                // Parse the rect JSON and pass to screenshot endpoint
                let mut screenshot_params = std::collections::HashMap::new();
                screenshot_params.insert("rect", rect_response.as_str());
                let response = server_request_for_platform(session_id, &platform, "screenshot", &screenshot_params);
                return Ok(WebDriverResponse::Generic(ValueResponse(Value::String(response))));
            },
            _ => {
                info!("Unhandled command: {:?}", msg.command);
                Ok(WebDriverResponse::Generic(ValueResponse(Value::Null)))
            },
        };
     }
 
    fn teardown_session(&mut self, kind: SessionTeardownKind) {
       info!("Tearing down session (kind: {:?})", kind);
       
       let platform = Platform::from_env();
       match platform {
           Platform::MacOS => {
               if matches!(kind, SessionTeardownKind::Deleted) {
                   // Quit app via /shutdown endpoint which cleanly terminates
                   // without crash dialogs (no port known here, use fallback)
                   quit_macos_app_with_port(None);
               }
           },
           Platform::IOS => {
               // iOS cleanup handled by DeleteSession command
           }
       }
    }
}