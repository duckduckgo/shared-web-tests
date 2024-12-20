extern crate webdriver;
#[macro_use]
extern crate log;

extern crate serde;
#[macro_use]
extern crate serde_derive;
extern crate serde_json;

mod handler;

use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use anyhow::{bail, Result as ProgramResult};
use url::{Host, Url};
use crate::handler::{Handler};
use std::process::ExitCode;
use std::env;
const EXIT_UNAVAILABLE: u8 = 69;
use clap::Parser;


/// Simple program to greet a person
#[derive(Parser, Debug)]
#[command(version, about, long_about = None)]
struct Args {
    /// Name of the person to greet
    #[arg(short, long)]
    port: u16,
}

/// Get a socket address from the provided host and port
///
/// # Arguments
/// * `webdriver_host` - The hostname on which the server will listen
/// * `webdriver_port` - The port on which the server will listen
///
/// When the host and port resolve to multiple addresses, prefer
/// IPv4 addresses vs IPv6.
fn server_address(webdriver_host: &str, webdriver_port: u16) -> ProgramResult<SocketAddr> {
    let mut socket_addrs = match format!("{}:{}", webdriver_host, webdriver_port).to_socket_addrs()
    {
        Ok(addrs) => addrs.collect::<Vec<_>>(),
        Err(e) => bail!("{}: {}:{}", e, webdriver_host, webdriver_port),
    };
    if socket_addrs.is_empty() {
        bail!(
            "Unable to resolve host: {}:{}",
            webdriver_host,
            webdriver_port
        )
    }
    // Prefer ipv4 address
    socket_addrs.sort_by(|a, b| {
        let a_val = i32::from(!a.ip().is_ipv4());
        let b_val = i32::from(!b.ip().is_ipv4());
        a_val.partial_cmp(&b_val).expect("Comparison failed")
    });
    Ok(socket_addrs.remove(0))
}

fn get_program_name() -> String {
    env::args().next().unwrap()
}

/*
fn print_help(cmd: &mut Command) {
    cmd.print_help().ok();
    println!();
}*/

fn main() -> ExitCode {
    println!("Hello, world!");
    let args = Args::parse();
    let port = args.port;

    if let Err(e) = inner_main(port) {
        eprintln!("{}: error: {}", get_program_name(), e);
        //print_help(&mut cmd);
        return ExitCode::from(EXIT_UNAVAILABLE);
    }

    ExitCode::SUCCESS
}

fn inner_main(port: u16) -> ProgramResult<()> {
    //let handler = MarionetteHandler::new(settings);
    let address = server_address("localhost", port).unwrap();
    let allow_hosts = vec![Host::Domain("localhost".to_string())];
    let origin = format!("http://localhost:{}", port);
    let allow_origins = vec![Url::parse(&origin).unwrap()];
    let handler = Handler::new();
    let listening = webdriver::server::start(
        address,
        allow_hosts,
        allow_origins,
        handler,
        vec![],
    )?;

    info!("Listening on {}", listening.socket);
    return Ok(());
}
