//! Platform-independent logic of the Planner desktop shell.
//!
//! Nothing here depends on Tauri or on a webview library, so `cargo test` runs
//! on Linux. The Tauri glue lives in the `planner` crate (`../src`).

pub mod chat;
pub mod engram;
pub mod fsutil;
pub mod hyprbind;
pub mod idle;
pub mod launch;
pub mod loopback;
pub mod oauth;
pub mod pkce;
pub mod route;
pub mod webview;
