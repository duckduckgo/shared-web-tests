use webdriver::server::{Session, WebDriverHandler};
use webdriver::httpapi::WebDriverExtensionRoute;
use webdriver::Parameters;
use webdriver::command::{WebDriverCommand, WebDriverExtensionCommand, WebDriverMessage};
use webdriver::error::WebDriverResult;
use webdriver::server::SessionTeardownKind;
use serde_json::{Map, Value};
use webdriver::command::WebDriverCommand::{
    CloseWindow, DeleteSession, ElementClick, ExecuteAsyncScript, ExecuteScript,
    FindElement, Get, GetCurrentUrl, GetWindowHandle, GetWindowHandles,
    NewWindow, SwitchToWindow,
};
use webdriver::response::{
    NewSessionResponse, NewWindowResponse, ValueResponse, WebDriverResponse,
};

use crate::platform::{self, Platform};

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum DuckDuckGoExtensionRoute {
    GetContext,
}

impl WebDriverExtensionRoute for DuckDuckGoExtensionRoute {
    type Command = DuckDuckGoExtensionCommand;

    fn command(
        &self,
        _params: &Parameters,
        _body_data: &Value,
    ) -> WebDriverResult<WebDriverCommand<DuckDuckGoExtensionCommand>> {
        let command = match *self {
            DuckDuckGoExtensionRoute::GetContext => DuckDuckGoExtensionCommand::GetContext,
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
pub struct DuckDuckGoContextParameters {}

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
    GetContext,
}

impl WebDriverExtensionCommand for DuckDuckGoExtensionCommand {
    fn parameters_json(&self) -> Option<Value> {
        match self {
            DuckDuckGoExtensionCommand::GetContext => None,
        }
    }
}

pub(crate) struct Handler {
    platform: Box<dyn Platform>,
}

impl Handler {
    pub fn new() -> Self {
        Handler {
            platform: platform::detect_platform(),
        }
    }
}

impl WebDriverHandler<DuckDuckGoExtensionRoute> for Handler {
    fn handle_command(
        &mut self,
        _: &Option<Session>,
        msg: WebDriverMessage<DuckDuckGoExtensionRoute>,
    ) -> WebDriverResult<WebDriverResponse> {
        info!("Message received {:?}", msg);

        match msg.command {
            WebDriverCommand::NewSession(_) => {
                match self.platform.new_session() {
                    Ok(session_id) => {
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
            }
            DeleteSession => {
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                let _ = self.platform.delete_session(session_id);
                Ok(WebDriverResponse::Generic(ValueResponse(Value::Null)))
            }
            Get(params) => {
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                match self.platform.navigate(session_id, params.url.as_str()) {
                    Ok(()) => Ok(WebDriverResponse::Void),
                    Err(e) => {
                        info!("Navigate error: {}", e);
                        Ok(WebDriverResponse::Generic(ValueResponse(Value::Null)))
                    }
                }
            }
            ExecuteScript(params) => {
                let script = params.script.as_str();
                info!("Script: {:#?}", params);
                let script_args = params.args.as_ref().expect("Expected args");
                let script_args_str = script_args
                    .iter()
                    .map(|arg| serde_json::to_string(arg).expect("Failed to serialize argument"))
                    .collect::<Vec<_>>()
                    .join(", ");

                let script_wrapper = r#"
                  (function () {
                    __SCRIPT__
                  }(__SCRIPT_ARGS__));
                "#;
                let script = script_wrapper
                    .replace("__SCRIPT__", script)
                    .replace("__SCRIPT_ARGS__", &script_args_str);

                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                match self.platform.execute_script(session_id, &script, &script_args_str) {
                    Ok(response) => Ok(WebDriverResponse::Generic(ValueResponse(response.into()))),
                    Err(e) => {
                        info!("ExecuteScript error: {}", e);
                        Ok(WebDriverResponse::Generic(ValueResponse(Value::Null)))
                    }
                }
            }
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
                let script = script_wrapper
                    .replace("__SCRIPT__", script)
                    .replace("__SCRIPT_ARGS__", &script_args_str);

                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                match self.platform.execute_async_script(session_id, &script, &script_args_str) {
                    Ok(response) => {
                        info!("Script Response: {:#?}", response);
                        let parsed: Value = serde_json::from_str(&response)?;
                        Ok(WebDriverResponse::Generic(ValueResponse(parsed)))
                    }
                    Err(e) => {
                        info!("ExecuteAsyncScript error: {}", e);
                        Ok(WebDriverResponse::Generic(ValueResponse(Value::Null)))
                    }
                }
            }
            FindElement(params) => {
                let script = include_str!("find-element.js");
                let json_string = serde_json::to_string(&params).unwrap();
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                match self.platform.find_element(session_id, script, &json_string) {
                    Ok(element) => {
                        let mut res = Map::new();
                        res.insert(
                            webdriver::common::ELEMENT_KEY.to_string(),
                            Value::String(element),
                        );
                        Ok(WebDriverResponse::Generic(ValueResponse(res.into())))
                    }
                    Err(e) => {
                        info!("FindElement error: {}", e);
                        Ok(WebDriverResponse::Generic(ValueResponse(Value::Null)))
                    }
                }
            }
            ElementClick(element_ref) => {
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                match self.platform.click_element(session_id, &format!("{}", element_ref)) {
                    Ok(()) => Ok(WebDriverResponse::Void),
                    Err(e) => {
                        info!("ElementClick error: {}", e);
                        Ok(WebDriverResponse::Generic(ValueResponse(Value::Null)))
                    }
                }
            }
            NewWindow(_) => {
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                match self.platform.new_window(session_id) {
                    Ok((handle, typ)) => {
                        Ok(WebDriverResponse::NewWindow(NewWindowResponse {
                            handle,
                            typ,
                        }))
                    }
                    Err(e) => {
                        info!("NewWindow error: {}", e);
                        Ok(WebDriverResponse::Generic(ValueResponse(Value::Null)))
                    }
                }
            }
            CloseWindow => {
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                match self.platform.close_window(session_id) {
                    Ok(handles) => {
                        Ok(WebDriverResponse::Generic(ValueResponse(handles.into())))
                    }
                    Err(e) => {
                        info!("CloseWindow error: {}", e);
                        Ok(WebDriverResponse::Generic(ValueResponse(Value::Null)))
                    }
                }
            }
            SwitchToWindow(params_in) => {
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                match self.platform.switch_to_window(session_id, &params_in.handle) {
                    Ok(()) => Ok(WebDriverResponse::Generic(ValueResponse(Value::Null))),
                    Err(e) => {
                        info!("SwitchToWindow error: {}", e);
                        Ok(WebDriverResponse::Generic(ValueResponse(Value::Null)))
                    }
                }
            }
            GetWindowHandle => {
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                match self.platform.get_window_handle(session_id) {
                    Ok(handle) => Ok(WebDriverResponse::Generic(ValueResponse(
                        Value::String(handle),
                    ))),
                    Err(e) => {
                        info!("GetWindowHandle error: {}", e);
                        Ok(WebDriverResponse::Generic(ValueResponse(Value::Null)))
                    }
                }
            }
            GetWindowHandles => {
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                match self.platform.get_window_handles(session_id) {
                    Ok(handles) => {
                        Ok(WebDriverResponse::Generic(ValueResponse(handles.into())))
                    }
                    Err(e) => {
                        info!("GetWindowHandles error: {}", e);
                        Ok(WebDriverResponse::Generic(ValueResponse(Value::Null)))
                    }
                }
            }
            GetCurrentUrl => {
                let session_id = msg.session_id.as_ref().expect("Expected a session id");
                match self.platform.get_current_url(session_id) {
                    Ok(url_string) => Ok(WebDriverResponse::Generic(ValueResponse(
                        Value::String(url_string),
                    ))),
                    Err(e) => {
                        info!("GetCurrentUrl error: {}", e);
                        Ok(WebDriverResponse::Generic(ValueResponse(Value::Null)))
                    }
                }
            }
            _ => Ok(WebDriverResponse::Generic(ValueResponse(Value::Null))),
        }
    }

    fn teardown_session(&mut self, _kind: SessionTeardownKind) {
        info!("Tearing down session");
    }
}
