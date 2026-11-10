//! Dev only (`screenshot` feature): script the app into a state from the command line, then
//! optionally render the window to a PNG and quit. Later phases add flags here.
//!
//! ```text
//! codeducky --open <path> [--machine <name>] [--base <rev>] [--select <file>]
//!           [--mode unified|split] [--appearance light|dark] [--palette <name>]
//!           [--density compact|default|comfortable] [--wrap] [--ignore-whitespace]
//!           [--tab files|notes] [--notes-filter all|open|resolved|possibly]
//!           [--order folders|risk] [--filter <text>] [--collapse <folder>]...
//!           [--cursor <line>] [--compose <line>[-<end>] [--side old|new] [--compose-text <md>]]
//!           [--edit-note <id>] [--submit] [--keys "j j shift-down c"] [--help-overlay] [--palette-open] [--size <w>x<h>]
//!           [--screenshot <png> | --quit]
//! ```
//!
//! Any of these flags keeps preferences from being written.

mod screenshot;
mod script;

pub use script::{Script, run};
