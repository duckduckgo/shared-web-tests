/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use std::process::{Command, Stdio};

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

 fn runMaestroFlow(udid: &str, flow: &str, env: Vec<String>) -> Result<String, String> {
    let mut args = vec![format!("--udid={udid}"), "test".to_string()];
    env.iter().for_each(|x| args.push(x.to_string()));
    args.push(flow.to_string());


    let output = Command::new("maestro")
        .args(&args)
        //.stdout(Stdio::inherit())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("Failed to run flow");
    if !output.status.success() {
        eprintln!(
            "Failed to run flow:\nErr: {}\nOut: {}",
            String::from_utf8_lossy(&output.stderr),
            String::from_utf8_lossy(&output.stdout)
        );
        let out = String::from(String::from_utf8(output.stdout).expect("Error").trim());
        return Err(out);
    }
    let out = String::from(String::from_utf8(output.stdout).expect("Result"));
    Ok(out)
 }

 

 impl WebDriverHandler<DuckDuckGoExtensionRoute> for Handler {
     fn handle_command(
         &mut self,
         _: &Option<Session>,
         msg: WebDriverMessage<DuckDuckGoExtensionRoute>,
     ) -> WebDriverResult<WebDriverResponse> {

        // Replace with your simulator's UDID and app's bundle identifier
        let target_device="iPhone-16";
        let target_os="iOS-18-1";
        let app_bundle_id = "com.duckduckgo.mobile.ios";


        println!("Message received {:?}", msg);
        return match msg.command {
            WebDriverCommand::NewSession(_) => {
                println!("Starting automation...");
                let output = Command::new("xcrun")
                    .args(&["simctl", "create", &format!("{target_device} {target_os} (maestro)"), &("com.apple.CoreSimulator.SimDeviceType.".to_owned() + target_device), &("com.apple.CoreSimulator.SimRuntime.".to_owned() + target_os)])
                    .output()
                    .expect("Failed to boot the simulator");
    
    
                if !output.status.success() {
                    eprintln!(
                        "Failed to boot simulator: {}",
                        String::from_utf8_lossy(&output.stderr)
                    );
                    return Ok(WebDriverResponse::Generic(ValueResponse(Value::Null)));
                } else {
                    println!(
                        "Simulator booted successfully: {}",
                        String::from_utf8_lossy(&output.stdout)
                    );
                }
                let simulator_udid = String::from(String::from_utf8(output.stdout).expect("Invalid UDID").trim());
                println!("Starting automation... {:?}", simulator_udid);
            
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
                runMaestroFlow(&simulator_udid, flow, vec![]).expect("Failed to run flow");

                let mut capabilities = Map::new();
                Ok(WebDriverResponse::NewSession(NewSessionResponse {
                    session_id: simulator_udid.to_string(),
                    capabilities: Value::Object(capabilities),
                }))
            },
            Get(params) => {
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                println!("BEEPO {:?} {:?}", params, session_id);
                let params = vec!["-e URL=".to_owned() + params.url.as_str()];
                runMaestroFlow(session_id, "/Users/jonathanKingston/duckduckgo/iOS/.maestro/shared/set-url.yaml", params).expect("Failed to run flow");
                return Ok(WebDriverResponse::Generic(ValueResponse(Value::Null)));
            },
            GetCurrentUrl => {
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                println!("Session {:?}", session_id);

                let params = vec!["-e URL=javascript:throw new Error('my url:' + window.location.href)".to_owned(), "-e TITLE=jsgeturl".to_owned()];
                runMaestroFlow(session_id, "/Users/jonathanKingston/duckduckgo/iOS/.maestro/shared/create_bookmarklette.yaml", params).expect("Failed to run flow");

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