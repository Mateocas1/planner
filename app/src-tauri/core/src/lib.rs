//! Platform-independent logic of the Planner desktop shell.
//!
//! Nothing here depends on Tauri or on a webview library, so `cargo test` runs
//! on Linux. The Tauri glue lives in the `planner` crate (`../src`).

pub mod loopback;
pub mod oauth;
pub mod pkce;
pub mod route;
