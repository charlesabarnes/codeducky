//! Terminals: a source's byte stream fed through libghostty-vt, drawn by GPUI.
//!
//! The app creates a [`TerminalView`] from a [`source::TerminalSource`] (an hc attach in the
//! app, [`source::LocalPtySource`] behind the `pty` feature for demos) and subscribes to its
//! [`TerminalEvent`]s. Call [`init`] once to bind the terminal's keys.

pub mod actions;
mod boxdraw;
mod color;
mod config;
mod element;
mod emulator;
mod frame;
mod ime;
mod input;
mod links;
mod selection;
mod session;
pub mod source;
mod theme;
mod view;

pub use actions::init;
pub use color::Rgb;
pub use config::TerminalConfig;
pub use session::{PasteOutcome, TerminalEvent};
pub use theme::TerminalColors;
pub use view::TerminalView;
