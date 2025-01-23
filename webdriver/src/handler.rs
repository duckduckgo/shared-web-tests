/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use std::process::{Command, Stdio};
use urlencoding;
use webdriver::server::{Session, WebDriverHandler};
use webdriver::httpapi::WebDriverExtensionRoute;
use webdriver::Parameters;
use webdriver::command::{WebDriverCommand, WebDriverExtensionCommand, WebDriverMessage};
use webdriver::error::{ErrorStatus, WebDriverError, WebDriverResult};
use webdriver::{capabilities::CapabilitiesMatching, server::SessionTeardownKind};
use serde::de::{self, Deserialize, Deserializer};
use serde::ser::{Serialize, Serializer};
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
use regex::Regex;
use std::fs;
use std::collections::HashMap;
use std::sync::OnceLock;
use std::sync::Mutex;
use std::str;


 #[derive(Clone, PartialEq, Eq, Debug)]
 pub enum DuckDuckGoExtensionRoute {
     GetContext,
     SetContext,
     InstallAddon,
     UninstallAddon,
     TakeFullScreenshot,
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
            GetContext => DuckDuckGoExtensionCommand::GetContext,
            SetContext => {
                DuckDuckGoExtensionCommand::SetContext(serde_json::from_value(body_data.clone())?)
            }
            InstallAddon => {
                DuckDuckGoExtensionCommand::InstallAddon(serde_json::from_value(body_data.clone())?)
            }
            UninstallAddon => {
                DuckDuckGoExtensionCommand::UninstallAddon(serde_json::from_value(body_data.clone())?)
            }
            TakeFullScreenshot => DuckDuckGoExtensionCommand::TakeFullScreenshot,
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

#[derive(Clone, Debug, PartialEq)]
pub struct VoidWebDriverExtensionRoute;

impl WebDriverExtensionRoute for VoidWebDriverExtensionRoute {
    type Command = VoidWebDriverExtensionCommand;

    fn command(
        &self,
        _: &Parameters,
        _: &Value,
    ) -> WebDriverResult<WebDriverCommand<VoidWebDriverExtensionCommand>> {
        panic!("No extensions implemented");
    }
}

#[derive(Clone, Debug)]
pub struct VoidWebDriverExtensionCommand;

impl WebDriverExtensionCommand for VoidWebDriverExtensionCommand {
    fn parameters_json(&self) -> Option<Value> {
        panic!("No extensions implemented");
    }
}

/*
#[derive(Debug, PartialEq)]
pub struct WebDriverMessage<U: WebDriverExtensionRoute = VoidWebDriverExtensionRoute> {
    pub session_id: Option<String>,
    pub command: WebDriverCommand<U::Command>,
}*/

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AddonInstallParameters {
    //AddonBase64(AddonBase64),
    AddonPath(AddonPath),
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
    GetContext,
    SetContext(DuckDuckGoContextParameters),
    InstallAddon(AddonInstallParameters),
    UninstallAddon(AddonUninstallParameters),
    TakeFullScreenshot,
}

impl WebDriverExtensionCommand for DuckDuckGoExtensionCommand {
    fn parameters_json(&self) -> Option<Value> {
        use self::DuckDuckGoExtensionCommand::*;
        match self {
            GetContext => None,
            InstallAddon(x) => Some(serde_json::to_value(x).unwrap()),
            SetContext(x) => Some(serde_json::to_value(x).unwrap()),
            UninstallAddon(x) => Some(serde_json::to_value(x).unwrap()),
            TakeFullScreenshot => None,
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
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

static PORT_MANAGER: OnceLock<PortManager> = OnceLock::new();

fn get_port(udid: &str) -> u16 {
    let port_manager = PORT_MANAGER.get_or_init(|| PortManager::new());
    port_manager.get_port(udid)
}

 fn runMaestroFlow(udid: &str, flow: &str, env: Vec<String>) -> Result<String, String> {
    let port = get_port(udid);
    let mut args = vec![
        format!("--udid={udid}"),
        "test".to_string(),
        format!("-e AUTOMATION_PORT={port}"),
        "-e ONBOARDING_COMPLETED=true".to_string(),
    ];
    env.iter().for_each(|x| args.push(x.to_string()));
    args.push(flow.to_string());

    let output = Command::new("maestro")
        .args(&args)
        .env("ONBOARDING_COMPLETED", "true")
        .env("AUTOMATION_PORT", port.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("Failed to run onboarding flow");
    if !output.status.success() {
        info!(
            "Failed to run {} flow:\nErr: {}\nOut: {}\n\n---\n\n",
            flow,
            String::from_utf8_lossy(&output.stderr),
            String::from_utf8_lossy(&output.stdout)
        );
        let out = String::from(String::from_utf8(output.stdout).expect("Error").trim());
        return Err(out);
    }
    let out = String::from(String::from_utf8(output.stdout).expect("Result"));
    Ok(out)
 }

fn serverRequest(udid: &str, method: &str, params: &std::collections::HashMap<&str, &str>) -> String {
    let port = get_port(udid);
    let query_string: String = params.iter()
        .map(|(key, value)| format!("{}={}", key, value))
        .collect::<Vec<String>>()
        .join("&");
    let url = format!("http://localhost:{}/{method}?{}", port, query_string);
    info!("URL to send: {:?}", url);
    let client = reqwest::blocking::Client::new();
    info!("Sending request");
    let resp = client.get(url)
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .expect("Request failed")
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

fn find_or_create_simulator(target_device: &str, target_os: &str) -> Result<String, String> {
    // Step 1: List existing simulators
    let list_output = Command::new("xcrun")
        .args(&["simctl", "list", "devices", "-j"])
        .output()
        .expect("Failed to list simulators");
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
    info!("No matching simulator found");

    // Step 3: Create a new simulator if no match is found
    let create_output = Command::new("xcrun")
        .args(&[
            "simctl",
            "create",
            &device_name,
            &("com.apple.CoreSimulator.SimDeviceType.".to_owned() + target_device),
            &("com.apple.CoreSimulator.SimRuntime.".to_owned() + target_os),
        ])
        .output()
        .expect("Failed to create simulator");

    if !create_output.status.success() {
        return Err("Failed to create a new simulator".to_string());
    }

    let new_udid = str::from_utf8(&create_output.stdout)
        .expect("Invalid UTF-8 in create simulator output")
        .trim();
    Ok(new_udid.to_string())
}
 

 impl WebDriverHandler<DuckDuckGoExtensionRoute> for Handler {
     fn handle_command(
         &mut self,
         _: &Option<Session>,
         msg: WebDriverMessage<DuckDuckGoExtensionRoute>,
     ) -> WebDriverResult<WebDriverResponse> {

        // Replace with your simulator's UDID and app's bundle identifier
        let target_device="iPhone-16";
        let target_os="iOS-18-2";
        let app_bundle_id = "com.duckduckgo.mobile.ios";

        info!("Message received {:?}", msg);
        return match msg.command {
            WebDriverCommand::NewSession(_) => {
                info!("Starting automation...");
                let simulator_udid = match find_or_create_simulator(target_device, target_os) {
                    Ok(udid) => udid,
                    Err(e) => {
                        info!("Failed to find or create simulator: {}", e);
                        return Ok(WebDriverResponse::Generic(ValueResponse(Value::Null)));
                    }
                };
                info!("Simulator UDID: {:?}", simulator_udid);
            
                // Boot the simulator (if it's not already booted)
                Command::new("xcrun")
                    .args(&["simctl", "boot", &simulator_udid])
                    .status()
                    .expect("Failed to boot the simulator");
            
                // Launch the simulator app
                Command::new("open")
                    .args(&["-a", "Simulator"])
                    .status()
                    .expect("Failed to open the Simulator app");
            
                // Install the app on the simulator
                let derived_data_path = "/Users/jonathanKingston/duckduckgo/iOS/DerivedData";
                let app_path = format!("{derived_data_path}/Build/Products/Debug-iphonesimulator/DuckDuckGo.app");
                Command::new("xcrun")
                    .args(&["simctl", "install", &simulator_udid, &app_path])
                    .status()
                    .expect("Failed to install the app");
            
                // Launch the app on the simulator
                /*
                Command::new("xcrun")
                    .args(&["simctl", "launch", &simulator_udid, app_bundle_id, "-isOnboardingCompleted true", "-isUITesting"])
                    .status()
                    .expect("Failed to launch the app");
                */

                let flow = "/Users/jonathanKingston/duckduckgo/iOS/.maestro/shared/setup.yaml";
                /*
                Command::new("maestro")
                    .args(&[&format!("--udid={simulator_udid}"), "test", flow])
                    .status()
                    .expect("Failed to run flow");
                */
                runMaestroFlow(&simulator_udid, flow, vec![]).expect("Failed to run flow after install");

                Command::new("xcrun")
                    .args(&["simctl", "spawn", &simulator_udid, "ps",  "aux"])
                    .status()
                    .expect("Failed to launch the app");

                let mut capabilities = Map::new();
                Ok(WebDriverResponse::NewSession(NewSessionResponse {
                    session_id: simulator_udid.to_string(),
                    capabilities: Value::Object(capabilities),
                }))
            },
            DeleteSession => {
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                info!("Deleting session {:?}", session_id);
                // Shutdown the simulator
                Command::new("xcrun")
                    .args(&["simctl", "shutdown", session_id])
                    .status()
                    .expect("Failed to shutdown the simulator");
                Ok(WebDriverResponse::Generic(ValueResponse(Value::Null)))
            },
            Get(params) => {
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let url = params.url.as_str();
                let mut params = std::collections::HashMap::new();
                params.insert("url", url);
                serverRequest(session_id, "navigate", &params);
                return Ok(WebDriverResponse::Void);
            },
            ExecuteScript(params) => {
                let script = params.script.as_str();
                info!("Script: {:#?}", params);
                let script_args = params.args.as_ref().expect("Expected args");
                // Serialize each argument to a JavaScript-compatible string
                let mut script_args_str = script_args
                .iter()
                .map(|arg| serde_json::to_string(arg).expect("Failed to serialize argument"))
                .collect::<Vec<_>>();

                // Join the arguments with commas
                let script_args_str = script_args_str.join(", ");

                let script_wrapper = r#"
                  (function () {
                    document.body.style.backgroundColor = "blue";
                    __SCRIPT__
                  }(__SCRIPT_ARGS__));
                "#;
                // Replace SCRIPT and SCRIPT_ARGS with the actual script and arguments
                let script = script_wrapper.replace("__SCRIPT__", script).replace("__SCRIPT_ARGS__", script_args_str.as_str());
                let mut params = std::collections::HashMap::new();
                // Escape the script
                let script = urlencoding::encode(&script).to_string();
                params.insert("script", script.as_str());
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let response = serverRequest(session_id, "execute", &params);
                return Ok(WebDriverResponse::Generic(ValueResponse(response.into())));
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
                  (function asyncMethod () {
                    __SCRIPT__
                  }(__SCRIPT_ARGS__));
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
                let response = serverRequest(session_id, "execute", &params);
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
                let element = serverRequest(session_id, "execute", &url_params);
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
                serverRequest(session_id, "execute", &params);
                // return Ok(WebDriverResponse::Generic(ValueResponse(Value::Null)));
                return Ok(WebDriverResponse::Void);
            },
            NewWindow(_) => {
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let window_handle = serverRequest(session_id, "newWindow", &std::collections::HashMap::new());
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
                let window_handle = serverRequest(session_id, "closeWindow", &std::collections::HashMap::new());
                info!("Close window handle: {:#?}", window_handle);
                return Ok(WebDriverResponse::Generic(ValueResponse(Value::Null)));
            },
            SwitchToWindow(params_in) => {
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let mut params = std::collections::HashMap::new();
                params.insert("handle", params_in.handle.as_str());
                serverRequest(session_id, "switchToWindow", &params);
                return Ok(WebDriverResponse::Generic(ValueResponse(Value::Null)));
            },
            GetWindowHandle => {
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let window_handle = serverRequest(session_id, "getWindowHandle", &std::collections::HashMap::new());
                info!("Window handle: {:#?}", window_handle);
                return Ok(WebDriverResponse::Generic(ValueResponse(Value::String(window_handle))));
            },
            GetWindowHandles => {
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let window_handles = serverRequest(session_id, "getWindowHandles", &std::collections::HashMap::new());
                // Parse json string
                let window_handles: Vec<String> = serde_json::from_str(&window_handles).expect("Failed to parse window handles");
                info!("Window handles: {:#?}", window_handles);
                return Ok(WebDriverResponse::Generic(ValueResponse(window_handles.into())));
            },
            GetCurrentUrl => {
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                info!("Session {:?}", session_id);

                // let params = vec!["-e URL=javascript:throw new Error('my url:' + window.location.href)".to_owned(), "-e TITLE=jsgeturl".to_owned()];
                // runMaestroFlow(session_id, "/Users/jonathanKingston/duckduckgo/iOS/.maestro/shared/create_bookmarklette.yaml", params).expect("Failed to run flow");
                // let params = vec!["-e URL=javascript:throw new Error('my url:' + window.location.href)".to_owned()];
                // runMaestroFlow(session_id, "/Users/jonathanKingston/duckduckgo/iOS/.maestro/shared/set-url.yaml", params).expect("Failed to run flow");

                // Request to SocketServer on 8786
                /*
                let script = "document.write('Hello World')";
                let url = format!("http://localhost:8786/?script={script}");
                info!("URL {:?}", url);
                let resp = reqwest::blocking::get(url).expect("blah").text().expect("blah");
                info!("{:#?}", resp);
                #[derive(Deserialize)]
                struct Response {
                    message: String,
                }
                let json: Response = serde_json::from_str(&resp).expect("blah");
                info!("{:#?}", json.message);
                */
                // let urlString = serverRequest("execute", "script", "window.location.href");
                // return Ok(WebDriverResponse::Generic(ValueResponse(Value::String(urlString))));
                let url_string = serverRequest(session_id, "getUrl", &std::collections::HashMap::new());
                info!("UrlString response: {:#?}", url_string);
                return Ok(WebDriverResponse::Generic(ValueResponse(Value::String(url_string))));
                /*
                let urlOutput = runMaestroFlow(session_id, "/Users/jonathanKingston/duckduckgo/iOS/.maestro/shared/get-url.yaml", vec![]).expect_err("Failed to run flow");
                // Find URL in output:
                let pattern = r#"JavaScriptException: Error: URL text:[\\]?["'](.*?)[\\]?["']"#;

                // Compile the regex
                let re = Regex::new(&pattern).unwrap();
                let matches: Vec<_> = re.captures_iter(&urlOutput).collect();
                // Check if there are any matches
                if let Some(caps) = matches.last() {
                    let url = &caps[1];
                    if url == "Search or enter address" {
                        return Ok(WebDriverResponse::Generic(ValueResponse(Value::String("about:blank".to_string()))));
                    }
                    return Ok(WebDriverResponse::Generic(ValueResponse(Value::String(url.to_string()))));
                }
                */

                return Ok(WebDriverResponse::Generic(ValueResponse(Value::Null)));  
            },
            _ => Ok(WebDriverResponse::Generic(ValueResponse(Value::Null))),
        };
        /*
         // First handle the status message which doesn't actually require a marionette
         // connection or message
         if let Status = msg.command {
             let (ready, message) = self
                 .connection
                 .get_mut()
                 .map(|ref connection| {
                     connection
                         .as_ref()
                         .map(|_| (false, "Session already started"))
                         .unwrap_or((true, ""))
                 })
                 .unwrap_or((false, "geckodriver internal error"));
             let mut value = Map::new();
             value.insert("ready".to_string(), Value::Bool(ready));
             value.insert("message".to_string(), Value::String(message.into()));
             return Ok(WebDriverResponse::Generic(ValueResponse(Value::Object(
                 value,
             ))));
         }
 
         match self.connection.lock() {
             Ok(mut connection) => {
                 if connection.is_none() {
                     if let NewSession(ref capabilities) = msg.command {
                         let conn = self.create_connection(msg.session_id.clone(), capabilities)?;
                         *connection = Some(conn);
                     } else {
                         return Err(WebDriverError::new(
                             ErrorStatus::InvalidSessionId,
                             "Tried to run command without establishing a connection",
                         ));
                     }
                 }
                 let conn = connection.as_mut().expect("Missing connection");
                 conn.send_command(&msg).map_err(|mut err| {
                     // Shutdown the browser if no session can
                     // be established due to errors.
                     if let NewSession(_) = msg.command {
                         err.delete_session = true;
                     }
                     err
                 })
             }
             Err(_) => Err(WebDriverError::new(
                 ErrorStatus::UnknownError,
                 "Failed to aquire Marionette connection",
             )),
         }
             */
        Ok(WebDriverResponse::Generic(ValueResponse(Value::Null)))
     }
 
     fn teardown_session(&mut self, kind: SessionTeardownKind) {
         let wait_for_shutdown = match kind {
             SessionTeardownKind::Deleted => true,
             SessionTeardownKind::NotDeleted => false,
         };
         // self.close_connection(wait_for_shutdown);
     }
 }