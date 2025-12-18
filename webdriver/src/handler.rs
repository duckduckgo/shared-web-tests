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

// Platform-specific imports
#[cfg(windows)]
use crate::windows::WindowsSessionManager;
#[cfg(windows)]
use crate::cdp::CdpClient;

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

// ============================================================================
// Handler struct - platform-specific fields
// ============================================================================

#[cfg(windows)]
pub(crate) struct Handler {
    session_manager: WindowsSessionManager,
    cdp_clients: Mutex<HashMap<String, CdpClient>>,
}

#[cfg(not(windows))]
#[derive(Default)]
pub(crate) struct Handler {
}

impl Handler {
    pub fn new() -> Self {
        #[cfg(windows)]
        {
            Handler {
                session_manager: WindowsSessionManager::new(),
                cdp_clients: Mutex::new(HashMap::new()),
            }
        }
        #[cfg(not(windows))]
        {
            Handler {}
        }
    }
}

// ============================================================================
// Port management (shared)
// ============================================================================

fn port_is_available(port: u16) -> bool {
    std::net::TcpListener::bind(("0.0.0.0", port)).is_ok()
}

// ============================================================================
// macOS/iOS specific code
// ============================================================================

#[cfg(target_os = "macos")]
mod macos {
    use super::*;

    pub struct PortManager {
        ports: Mutex<HashMap<&'static str, u16>>,
    }

    impl PortManager {
        pub fn new() -> Self {
            PortManager {
                ports: Mutex::new(HashMap::new()),
            }
        }

        pub fn get_port(&self, udid: &str) -> u16 {
            let mut ports = self.ports.lock().unwrap();
            if let Some(&port) = ports.get(udid) {
                return port;
            }

            for port in 8557..=65535 {
                if super::port_is_available(port) {
                    ports.insert(Box::leak(udid.to_string().into_boxed_str()), port);
                    return port;
                }
            }
            panic!("No available ports found");
        }
    }

    static PORT_MANAGER: OnceLock<PortManager> = OnceLock::new();

    pub fn get_port(udid: &str) -> u16 {
        let port_manager = PORT_MANAGER.get_or_init(|| PortManager::new());
        port_manager.get_port(udid)
    }

    pub fn server_request(udid: &str, method: &str, params: &std::collections::HashMap<&str, &str>) -> String {
        let mut child = monitor_simulator_logs(&udid);
        let port = get_port(udid);
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

    pub fn find_or_create_simulator(target_device: &str, target_os: &str) -> Result<String, String> {
        let list_output = xcrun_command(&["simctl", "list", "devices", "-j"]);
        let device_name = format!("{target_device} {target_os} (webdriver)");

        let list_stdout = str::from_utf8(&list_output.stdout).expect("Invalid UTF-8 in simulator list");
        let simulators: serde_json::Value = serde_json::from_str(list_stdout).expect("Failed to parse simulator list");

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

    pub const APP_BUNDLE_ID: &str = "com.duckduckgo.mobile.ios";

    pub fn log_level() -> String {
        match log::max_level() {
            log::LevelFilter::Error => "error",
            log::LevelFilter::Warn => "warn",
            log::LevelFilter::Info => "info",
            log::LevelFilter::Debug => "debug",
            log::LevelFilter::Trace => "trace",
            log::LevelFilter::Off => "off",
        }.to_string()
    }

    pub fn monitor_simulator_logs(udid: &str) -> Child {
        let mut child = Command::new("xcrun")
            .args(&[
                "simctl",
                "spawn",
                udid,
                "log",
                "stream",
                "--level",
                &log_level(),
                "--predicate",
                &format!("subsystem == \"{}\"", APP_BUNDLE_ID),
            ])
            .stdout(Stdio::piped())
            .spawn()
            .expect("Failed to start tail process");

        let stdout = child.stdout.take().expect("Failed to capture stdout");
        thread::spawn(move || {
            info!("Simulator logs:");
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                if let Ok(log_line) = line {
                    info!("Simulator: {}", log_line);
                }
            }
            info!("Simulator logs end");
        });

        return child;
    }

    pub fn xcrun_command(args: &[&str]) -> std::process::Output {
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
        return output;
    }

    pub fn write_defaults(udid: &str, key: &str, key_type: &str, value: &str) {
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
}

// ============================================================================
// WebDriver Handler implementation
// ============================================================================

impl WebDriverHandler<DuckDuckGoExtensionRoute> for Handler {
    fn handle_command(
        &mut self,
        _: &Option<Session>,
        msg: WebDriverMessage<DuckDuckGoExtensionRoute>,
    ) -> WebDriverResult<WebDriverResponse> {

        info!("Message received {:?}", msg);

        // ====================================================================
        // Windows implementation
        // ====================================================================
        #[cfg(windows)]
        {
            return match msg.command {
                WebDriverCommand::NewSession(_) => {
                    info!("Starting Windows browser automation...");
                    
                    match self.session_manager.create_session() {
                        Ok((session_id, port)) => {
                            info!("Created session {} on port {}", session_id, port);
                            
                            // Connect CDP client
                            match CdpClient::connect(port) {
                                Ok(cdp) => {
                                    self.cdp_clients.lock().unwrap().insert(session_id.clone(), cdp);
                                    info!("CDP client connected for session {}", session_id);
                                }
                                Err(e) => {
                                    info!("Failed to connect CDP client: {}", e);
                                    // Continue anyway - CDP might be slow to start
                                }
                            }
                            
                            let capabilities = Map::new();
                            Ok(WebDriverResponse::NewSession(NewSessionResponse {
                                session_id,
                                capabilities: Value::Object(capabilities),
                            }))
                        }
                        Err(e) => {
                            info!("Failed to create session: {}", e);
                            Ok(WebDriverResponse::Generic(ValueResponse(Value::Null)))
                        }
                    }
                },
                
                DeleteSession => {
                    let session_id = msg.session_id.as_ref().expect("Expected a session id");
                    info!("Deleting session {:?}", session_id);
                    
                    // Remove CDP client
                    self.cdp_clients.lock().unwrap().remove(session_id);
                    
                    // Delete session (kills browser)
                    let _ = self.session_manager.delete_session(session_id);
                    
                    Ok(WebDriverResponse::Generic(ValueResponse(Value::Null)))
                },
                
                Get(params) => {
                    let session_id = msg.session_id.as_ref().expect("Expected a session id");
                    let url = params.url.as_str();
                    info!("Navigating to: {}", url);
                    
                    let mut clients = self.cdp_clients.lock().unwrap();
                    if let Some(cdp) = clients.get_mut(session_id) {
                        match cdp.navigate(url) {
                            Ok(_) => info!("Navigation successful"),
                            Err(e) => info!("Navigation error: {}", e),
                        }
                    } else {
                        // Try to reconnect CDP if not available
                        if let Some(port) = self.session_manager.get_port(session_id) {
                            if let Ok(mut cdp) = CdpClient::connect(port) {
                                let _ = cdp.navigate(url);
                                clients.insert(session_id.clone(), cdp);
                            }
                        }
                    }
                    
                    Ok(WebDriverResponse::Void)
                },
                
                ExecuteScript(params) => {
                    let session_id = msg.session_id.as_ref().expect("Expected a session id");
                    let script = params.script.as_str();
                    info!("ExecuteScript: {}", script);
                    
                    let script_args = params.args.as_ref().expect("Expected args");
                    let script_args_str = script_args
                        .iter()
                        .map(|arg| serde_json::to_string(arg).expect("Failed to serialize argument"))
                        .collect::<Vec<_>>()
                        .join(", ");

                    let wrapped_script = format!(
                        "(function () {{ {} }})({})",
                        script, script_args_str
                    );
                    
                    let mut clients = self.cdp_clients.lock().unwrap();
                    if let Some(cdp) = clients.get_mut(session_id) {
                        match cdp.execute_script(&wrapped_script) {
                            Ok(result) => {
                                info!("Script result: {}", result);
                                return Ok(WebDriverResponse::Generic(ValueResponse(result.into())));
                            }
                            Err(e) => {
                                info!("Script error: {}", e);
                            }
                        }
                    }
                    
                    Ok(WebDriverResponse::Generic(ValueResponse(Value::Null)))
                },
                
                ExecuteAsyncScript(params) => {
                    let session_id = msg.session_id.as_ref().expect("Expected a session id");
                    let script = params.script.as_str();
                    info!("ExecuteAsyncScript: {}", script);
                    
                    let script_args = params.args.as_ref().expect("Expected args");
                    let mut script_args_str = script_args
                        .iter()
                        .map(|arg| serde_json::to_string(arg).expect("Failed to serialize argument"))
                        .collect::<Vec<_>>();
                    script_args_str.push("innerResolve".to_string());
                    let script_args_str = script_args_str.join(", ");

                    let wrapped_script = format!(r#"
                        new Promise((outerResolve, outerReject) => {{
                            const timeout = setTimeout(() => {{
                                outerReject({{reason: "Script execution timed out"}});
                            }}, 15000);
                            
                            let innerPromise = new Promise((innerResolve, innerReject) => {{
                                (async function asyncMethod () {{
                                    {}
                                }})({}));
                            }});
                            
                            innerPromise.then(result => {{
                                clearTimeout(timeout);
                                outerResolve(result);
                            }}).catch(error => {{
                                clearTimeout(timeout);
                                outerReject({{error: error, reason: "Async script failed"}});
                            }});
                        }})
                    "#, script, script_args_str);
                    
                    let mut clients = self.cdp_clients.lock().unwrap();
                    if let Some(cdp) = clients.get_mut(session_id) {
                        match cdp.execute_async_script(&wrapped_script) {
                            Ok(result) => {
                                info!("Async script result: {}", result);
                                let parsed: Value = serde_json::from_str(&result).unwrap_or(Value::String(result));
                                return Ok(WebDriverResponse::Generic(ValueResponse(parsed)));
                            }
                            Err(e) => {
                                info!("Async script error: {}", e);
                            }
                        }
                    }
                    
                    Ok(WebDriverResponse::Generic(ValueResponse(Value::Null)))
                },
                
                FindElement(params) => {
                    let session_id = msg.session_id.as_ref().expect("Expected a session id");
                    info!("FindElement: {:?}", params);
                    
                    // Get selector from params - use the value directly as CSS selector
                    // The find-element.js script on macOS handles different locator strategies
                    // For Windows CDP, we'll use the value as a CSS selector for now
                    let selector = params.value.clone();
                    
                    let mut clients = self.cdp_clients.lock().unwrap();
                    if let Some(cdp) = clients.get_mut(session_id) {
                        match cdp.find_element(&selector) {
                            Ok(element_id) => {
                                let mut res = Map::new();
                                res.insert(webdriver::common::ELEMENT_KEY.to_string(), Value::String(element_id));
                                return Ok(WebDriverResponse::Generic(ValueResponse(res.into())));
                            }
                            Err(e) => {
                                info!("FindElement error: {}", e);
                            }
                        }
                    }
                    
                    let mut res = Map::new();
                    res.insert(webdriver::common::ELEMENT_KEY.to_string(), Value::String("not-found".to_string()));
                    Ok(WebDriverResponse::Generic(ValueResponse(res.into())))
                },
                
                ElementClick(element_ref) => {
                    let session_id = msg.session_id.as_ref().expect("Expected a session id");
                    // WebElement has an id field that contains the element reference
                    let element_id = element_ref.to_string();
                    info!("ElementClick: {}", element_id);
                    
                    let mut clients = self.cdp_clients.lock().unwrap();
                    if let Some(cdp) = clients.get_mut(session_id) {
                        match cdp.click_element(&element_id) {
                            Ok(_) => info!("Click successful"),
                            Err(e) => info!("Click error: {}", e),
                        }
                    }
                    
                    Ok(WebDriverResponse::Void)
                },
                
                NewWindow(_) => {
                    let session_id = msg.session_id.as_ref().expect("Expected a session id");
                    info!("NewWindow");
                    
                    let mut clients = self.cdp_clients.lock().unwrap();
                    if let Some(cdp) = clients.get_mut(session_id) {
                        match cdp.new_window() {
                            Ok((handle, typ)) => {
                                return Ok(WebDriverResponse::NewWindow(NewWindowResponse {
                                    handle,
                                    typ,
                                }));
                            }
                            Err(e) => info!("NewWindow error: {}", e),
                        }
                    }
                    
                    Ok(WebDriverResponse::NewWindow(NewWindowResponse {
                        handle: "unknown".to_string(),
                        typ: "tab".to_string(),
                    }))
                },
                
                CloseWindow => {
                    let session_id = msg.session_id.as_ref().expect("Expected a session id");
                    info!("CloseWindow");
                    
                    let mut handles = vec![];
                    let mut clients = self.cdp_clients.lock().unwrap();
                    if let Some(cdp) = clients.get_mut(session_id) {
                        let _ = cdp.close_window();
                        handles = cdp.get_window_handles().unwrap_or_default();
                    }
                    
                    Ok(WebDriverResponse::Generic(ValueResponse(handles.into())))
                },
                
                GetWindowHandle => {
                    let session_id = msg.session_id.as_ref().expect("Expected a session id");
                    info!("GetWindowHandle");
                    
                    let mut clients = self.cdp_clients.lock().unwrap();
                    if let Some(cdp) = clients.get_mut(session_id) {
                        let handles = cdp.get_window_handles().unwrap_or_default();
                        if let Some(handle) = handles.first() {
                            return Ok(WebDriverResponse::Generic(ValueResponse(Value::String(handle.clone()))));
                        }
                    }
                    
                    Ok(WebDriverResponse::Generic(ValueResponse(Value::String("unknown".to_string()))))
                },
                
                GetWindowHandles => {
                    let session_id = msg.session_id.as_ref().expect("Expected a session id");
                    info!("GetWindowHandles");
                    
                    let mut clients = self.cdp_clients.lock().unwrap();
                    if let Some(cdp) = clients.get_mut(session_id) {
                        let handles = cdp.get_window_handles().unwrap_or_default();
                        return Ok(WebDriverResponse::Generic(ValueResponse(handles.into())));
                    }
                    
                    Ok(WebDriverResponse::Generic(ValueResponse(vec!["unknown"].into())))
                },
                
                GetCurrentUrl => {
                    let session_id = msg.session_id.as_ref().expect("Expected a session id");
                    info!("GetCurrentUrl");
                    
                    let mut clients = self.cdp_clients.lock().unwrap();
                    if let Some(cdp) = clients.get_mut(session_id) {
                        match cdp.get_url() {
                            Ok(url) => {
                                return Ok(WebDriverResponse::Generic(ValueResponse(Value::String(url))));
                            }
                            Err(e) => info!("GetCurrentUrl error: {}", e),
                        }
                    }
                    
                    Ok(WebDriverResponse::Generic(ValueResponse(Value::String("about:blank".to_string()))))
                },
                
                SwitchToWindow(_params) => {
                    // TODO: Implement window switching via CDP Target.activateTarget
                    info!("SwitchToWindow - not fully implemented");
                    Ok(WebDriverResponse::Generic(ValueResponse(Value::Null)))
                },
                
                _ => {
                    info!("Unhandled command: {:?}", msg.command);
                    Ok(WebDriverResponse::Generic(ValueResponse(Value::Null)))
                },
            };
        }

        // ====================================================================
        // macOS/iOS implementation
        // ====================================================================
        #[cfg(target_os = "macos")]
        {
            use macos::*;
            
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

            return match msg.command {
                WebDriverCommand::NewSession(_) => {
                    info!("Starting automation... {:?} {:?}", target_device, target_os);
                    let simulator_udid = match find_or_create_simulator(&target_device, &target_os) {
                        Ok(udid) => udid,
                        Err(e) => {
                            info!("Failed to find or create simulator: {}", e);
                            return Ok(WebDriverResponse::Generic(ValueResponse(Value::Null)));
                        }
                    };
                    info!("Simulator UDID: {:?}", simulator_udid);
                
                    xcrun_command(&["simctl", "boot", &simulator_udid]);
                
                    Command::new("open")
                        .args(&["-a", "Simulator"])
                        .status()
                        .expect("Failed to open the Simulator app");
                    info!("Opened Simulator app");
                    xcrun_command(&["simctl", "terminate", &simulator_udid, APP_BUNDLE_ID]);
                    xcrun_command(&["simctl", "uninstall", &simulator_udid, APP_BUNDLE_ID]);
                    info!("Uninstalled app");
                    
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
                    let logger = xcrun_command(&[
                        "simctl",
                        "spawn",
                        &simulator_udid,
                        "log",
                        "config",
                        "--mode",
                        &format!("level:{}", log_level()),
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
                        &format!("persist:{}", log_level()),
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

                    loop {
                        if !port_is_available(port) {
                            break;
                        }
                    }

                    let _ = child.kill();
                    let capabilities = Map::new();
                    Ok(WebDriverResponse::NewSession(NewSessionResponse {
                        session_id: simulator_udid.to_string(),
                        capabilities: Value::Object(capabilities),
                    }))
                },
                DeleteSession => {
                    let session_id = msg.session_id.as_ref().expect("Expected a session id");
                    info!("Deleting session {:?}", session_id);
                    xcrun_command(&["simctl", "shutdown", &session_id]);
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
                    let script_args_str = script_args
                    .iter()
                    .map(|arg| serde_json::to_string(arg).expect("Failed to serialize argument"))
                    .collect::<Vec<_>>();

                    let script_args_str = script_args_str.join(", ");

                    let script_wrapper = r#"
                      (function () {
                        __SCRIPT__
                      }(__SCRIPT_ARGS__));
                    "#;
                    let script = script_wrapper.replace("__SCRIPT__", script).replace("__SCRIPT_ARGS__", script_args_str.as_str());
                    let mut params = std::collections::HashMap::new();
                    let script = urlencoding::encode(&script).to_string();
                    params.insert("script", script.as_str());
                    let session_id = msg.session_id.as_ref().expect("Expected a session id");
                    let response = server_request(session_id, "execute", &params);
                    return Ok(WebDriverResponse::Generic(ValueResponse(response.into())));
                },
                ExecuteAsyncScript(params) => {
                    let script = params.script.as_str();
                    info!("Script: {:#?}", params);
                    let script_args = params.args.as_ref().expect("Expected args");
                    let mut script_args_str = script_args
                    .iter()
                    .map(|arg| serde_json::to_string(arg).expect("Failed to serialize argument"))
                    .collect::<Vec<_>>();

                    script_args_str.push("innerResolve".to_string());
                    let script_args_str = script_args_str.join(", ");

                    let script_wrapper = r#"
                    let promiseResult = new Promise((outerResolve, outerReject) => {
                      const timeout = setTimeout(() => {
                        outerReject({reason: "Script execution timed out"});
                      }, 15000);

                      let innerPromise = new Promise((innerResolve, innerReject) => {
                          (async function asyncMethod () {
                          __SCRIPT__
                          }(__SCRIPT_ARGS__));
                      });

                      innerPromise.then(result => {
                        clearTimeout(timeout);
                        outerResolve(result);
                      }).catch(error => {
                        clearTimeout(timeout);
                        outerReject({error: error, reason: "Async script failed"});
                      });
                    });
                    return promiseResult;
                    "#;
                    let script = script_wrapper.replace("__SCRIPT__", script).replace("__SCRIPT_ARGS__", script_args_str.as_str());
                    let mut params = std::collections::HashMap::new();
                    let script = urlencoding::encode(&script).to_string();
                    params.insert("script", script.as_str());
                    let session_id = msg.session_id.as_ref().expect("Expected a session id");
                    let response = server_request(session_id, "execute", &params);
                    info!("Script Response: {:#?}", response);
                    let parsed: Value = serde_json::from_str(&response)?;
                    return Ok(WebDriverResponse::Generic(ValueResponse(parsed.into())));
                },
                FindElement(params) => {
                    let script = include_str!("find-element.js");
                    let script = urlencoding::encode(&script).to_string();
                    let mut url_params = std::collections::HashMap::new();
                    url_params.insert("script", script.as_str());
                    let json_string = serde_json::to_string(&params).unwrap();
                    let json_string = urlencoding::encode(&json_string).to_string();
                    url_params.insert("args", json_string.as_str());
                    let session_id = msg.session_id.as_ref().expect("Expected a session id");
                    let element = server_request(session_id, "execute", &url_params);
                    let mut res = Map::new();
                    res.insert(webdriver::common::ELEMENT_KEY.to_string(), Value::String(element));
                    return Ok(WebDriverResponse::Generic(ValueResponse(res.into())));
                },
                ElementClick(element_ref) => {
                    let script_body = r#"
                    let element;
                    if (!window.__webdriver_script_results) {
                        throw new Error('No elements found');
                    }
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

        // Fallback for other platforms
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            info!("Unsupported platform");
            Ok(WebDriverResponse::Generic(ValueResponse(Value::Null)))
        }
    }
 
    fn teardown_session(&mut self, _kind: SessionTeardownKind) {
        println!("Tearing down session");
        info!("Tearing down session");
    }
}
