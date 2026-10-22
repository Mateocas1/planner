//! Platform-independent logic of the Planner desktop shell.
//!
//! Nothing here depends on Tauri or on a webview library, so `cargo test` runs
//! on Linux. The Tauri glue lives in the `planner` crate (`../src`).

pub mod route;
