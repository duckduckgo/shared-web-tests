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
        body_data: &Value,
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

    // Step 2: Search for a matching simulator
    if let Some(devices) = simulators.get("devices") {
        for (runtime, device_list) in devices.as_object().unwrap() {
            info!("Runtime: {:?}", runtime);
            if runtime.contains(target_os) {
                for device in device_list.as_array().unwrap() {
                    if device["name"] == device_name && device["isAvailable"] == true && device["state"] == "Shutdown" {
                        info!("Found matching simulator {:?}", device);
                        return Ok(device["udid"].as_str().unwrap().to_string());
                    }
                }
            }
        }
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

    let mut cargo_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let path_to_ca_cert = cargo_path.join("cacert.pem");

    // Install CA Key
    let install_ca_key = xcrun_command(&[
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
        match std::env::var("TARGET_PLATFORM").as_deref() {
            Ok("macos") | Ok("macOS") | Ok("mac") => Platform::MacOS,
            _ => Platform::IOS, // Default to iOS for backward compatibility
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

fn launch_macos_app(app_path: &str, port: u16) -> Result<(Child, String), String> {
    info!("Launching macOS app at: {}", app_path);

    // Get the bundle ID from the app
    let bundle_id = get_macos_bundle_id(app_path);
    info!("Detected bundle ID: {}", bundle_id);

    // First, quit any running instance
    let _ = Command::new("osascript")
        .args(&["-e", "tell application \"DuckDuckGo\" to quit"])
        .output();

    // Wait a bit for the app to quit
    std::thread::sleep(std::time::Duration::from_millis(500));

    // Write the automation port to defaults using correct bundle ID
    write_macos_defaults(&bundle_id, "automationPort", "int", &port.to_string());
    write_macos_defaults(&bundle_id, "isUITesting", "bool", "true");
    write_macos_defaults(&bundle_id, "isOnboardingCompleted", "string", "true");

    // Launch the app
    let child = Command::new("open")
        .args(&["-a", app_path, "--args", "-isUITesting", "true"])
        .spawn()
        .map_err(|e| format!("Failed to launch app: {}", e))?;

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

fn quit_macos_app() {
    let _ = Command::new("osascript")
        .args(&["-e", "tell application \"DuckDuckGo\" to quit"])
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
            WebDriverCommand::NewSession(_) => {
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
                        
                        // Launch the macOS app
                        let bundle_id = match launch_macos_app(&app_path, port) {
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
                        
                        // Wait for the server to start
                        info!("Waiting for automation server on port {}...", port);
                        let mut attempts = 0;
                        loop {
                            if !port_is_available(port) {
                                info!("Server started on port {}", port);
                                break;
                            }
                            attempts += 1;
                            if attempts > 100 { // 10 seconds timeout
                                panic!("Timeout waiting for automation server to start");
                            }
                            std::thread::sleep(std::time::Duration::from_millis(100));
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
                        quit_macos_app();
                    },
                    Platform::IOS => {
                        // Shutdown the simulator
                        xcrun_command(&["simctl", "shutdown", &session_id]);
                    }
                }
                Ok(WebDriverResponse::Generic(ValueResponse(Value::Null)))
            },
            Get(params) => {
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let url = params.url.as_str();
                let mut params = std::collections::HashMap::new();
                params.insert("url", url);
                server_request(session_id, "navigate", &params);
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

                // Wrapper that handles DOM element returns by converting them to element references
                // Uses the standard WebDriver element key for compatibility
                let script_wrapper = r#"
                  return (function () {
                    const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";
                    const result = (function () {
                      __SCRIPT__
                    }(__SCRIPT_ARGS__));
                    
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
                let response = server_request(session_id, "execute", &params);
                
                // Parse response and check for element references
                let parsed: Value = serde_json::from_str(&response)?;
                if let Some(message) = parsed.get("message") {
                    // Try to parse message as JSON to check for element reference
                    if let Some(msg_str) = message.as_str() {
                        if let Ok(msg_value) = serde_json::from_str::<Value>(msg_str) {
                            // Check for element reference with standard WebDriver key
                            if let Some(element_id) = msg_value.get(webdriver::common::ELEMENT_KEY).and_then(|v| v.as_str()) {
                                // Return as WebElement reference
                                let mut res = Map::new();
                                res.insert(webdriver::common::ELEMENT_KEY.to_string(), Value::String(element_id.to_string()));
                                return Ok(WebDriverResponse::Generic(ValueResponse(res.into())));
                            }
                            // Return parsed JSON object
                            return Ok(WebDriverResponse::Generic(ValueResponse(msg_value)));
                        }
                    }
                    // Return the message value directly
                    return Ok(WebDriverResponse::Generic(ValueResponse(message.clone())));
                }
                return Ok(WebDriverResponse::Generic(ValueResponse(parsed.into())));
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
                let response = server_request(session_id, "execute", &params);
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
                let response = server_request(session_id, "execute", &url_params);
                // Parse the response to extract the element UUID from the "message" field
                let parsed: Value = serde_json::from_str(&response)?;
                let element_id = parsed["message"].as_str().unwrap_or("").to_string();
                info!("FindElement response: {:?}, element_id: {:?}", response, element_id);
                let mut res = Map::new();
                res.insert(webdriver::common::ELEMENT_KEY.to_string(), Value::String(element_id));
                return Ok(WebDriverResponse::Generic(ValueResponse(res.into())));
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
                server_request(session_id, "execute", &params);
                return Ok(WebDriverResponse::Void);
            },
            NewWindow(_) => {
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let window_handle = server_request(session_id, "newWindow", &std::collections::HashMap::new());
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
                let window_handle = server_request(session_id, "closeWindow", &std::collections::HashMap::new());
                info!("Close window handle: {:#?}", window_handle);

                let window_handles = server_request(session_id, "getWindowHandles", &std::collections::HashMap::new());
                // Parse json string
                let window_handles: Vec<String> = serde_json::from_str(&window_handles).expect("Failed to parse window handles");
                info!("Window handles: {:#?}", window_handles);
                return Ok(WebDriverResponse::Generic(ValueResponse(window_handles.into())));
            },
            SwitchToWindow(params_in) => {
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let mut params = std::collections::HashMap::new();
                params.insert("handle", params_in.handle.as_str());
                server_request(session_id, "switchToWindow", &params);
                return Ok(WebDriverResponse::Generic(ValueResponse(Value::Null)));
            },
            GetWindowHandle => {
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let window_handle = server_request(session_id, "getWindowHandle", &std::collections::HashMap::new());
                info!("Window handle: {:#?}", window_handle);
                return Ok(WebDriverResponse::Generic(ValueResponse(Value::String(window_handle))));
            },
            GetWindowHandles => {
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let window_handles = server_request(session_id, "getWindowHandles", &std::collections::HashMap::new());
                // Parse json string
                let window_handles: Vec<String> = serde_json::from_str(&window_handles).expect("Failed to parse window handles");
                info!("Window handles: {:#?}", window_handles);
                return Ok(WebDriverResponse::Generic(ValueResponse(window_handles.into())));
            },
            GetCurrentUrl => {
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                info!("Session {:?}", session_id);
                let url_string = server_request(session_id, "getUrl", &std::collections::HashMap::new());
                info!("UrlString response: {:#?}", url_string);
                return Ok(WebDriverResponse::Generic(ValueResponse(Value::String(url_string))));
            },
            _ => Ok(WebDriverResponse::Generic(ValueResponse(Value::Null))),
        };
     }
 
     fn teardown_session(&mut self, kind: SessionTeardownKind) {
        println!("Tearing down session");
        info!("Tearing down session");
        /*
         let wait_for_shutdown = match kind {
             SessionTeardownKind::Deleted => true,
             SessionTeardownKind::NotDeleted => false,
         };
         self.close_connection(wait_for_shutdown);
        */
     }
 }