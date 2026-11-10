//! Between ducky-terminal's viewer types and herdr-core's attach vocabulary.

use ducky_hc::{AttachParams, Display};
use ducky_terminal::Rgb;
use ducky_terminal::source::{AttachRequest, CloseReason, DisplayFacts};
use serde_json::Value;

pub fn display(facts: &DisplayFacts) -> Display {
    Display {
        fg: Some(hex(facts.foreground)),
        bg: Some(hex(facts.background)),
        cursor: Some(hex(facts.cursor)),
        cell: Some([facts.cell_width, facts.cell_height]),
    }
}

pub fn cell(cell_width: u32, cell_height: u32) -> Display {
    Display {
        cell: Some([cell_width, cell_height]),
        ..Display::default()
    }
}

fn hex(rgb: Rgb) -> String {
    format!("#{:02x}{:02x}{:02x}", rgb.r, rgb.g, rgb.b)
}

pub fn attach_params(terminal: &str, request: &AttachRequest) -> AttachParams {
    let mut params = AttachParams::new(terminal, request.size.cols, request.size.rows);
    params.history = request.history as u64;
    params.display = Some(display(&request.display));
    params
}

/// How a stream ended, from the core's CLOSE payload (the terminal's finish facts).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ending {
    Exited(Option<i32>),
    /// The program was lost; a kept terminal comes back with a shell after `restarted`.
    Lost(String),
    /// No reason given: we detached, or the core dropped the stream.
    Unexplained,
}

pub fn ending(reason: Option<&Value>) -> Ending {
    let Some(reason) = reason else {
        return Ending::Unexplained;
    };
    let code = reason["exit_code"]
        .as_i64()
        .and_then(|c| i32::try_from(c).ok());
    match reason["reason"].as_str() {
        Some("exited" | "killed") => Ending::Exited(code),
        Some(other) => Ending::Lost(other.to_owned()),
        None if code.is_some() => Ending::Exited(code),
        None => Ending::Unexplained,
    }
}

impl Ending {
    pub fn close_reason(self) -> CloseReason {
        match self {
            Self::Exited(code) => CloseReason::Exited { code },
            Self::Lost(why) => CloseReason::Lost(why),
            Self::Unexplained => CloseReason::Lost("the stream ended".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn colours_go_as_hex_and_cells_as_pixels() {
        let facts = DisplayFacts {
            foreground: Rgb {
                r: 0xff,
                g: 0x80,
                b: 0,
            },
            background: Rgb { r: 0, g: 0, b: 0 },
            cursor: Rgb {
                r: 1,
                g: 0x22,
                b: 0xab,
            },
            cell_width: 8,
            cell_height: 17,
        };
        let display = display(&facts);
        assert_eq!(display.fg.as_deref(), Some("#ff8000"));
        assert_eq!(display.bg.as_deref(), Some("#000000"));
        assert_eq!(display.cursor.as_deref(), Some("#0122ab"));
        assert_eq!(display.cell, Some([8, 17]));
    }

    #[test]
    fn close_payloads_map_to_exit_or_loss() {
        let exited = json!({"reason": "exited", "exit_code": 3});
        assert_eq!(ending(Some(&exited)), Ending::Exited(Some(3)));
        let killed = json!({"reason": "killed", "exit_code": null, "signal": 1});
        assert_eq!(ending(Some(&killed)), Ending::Exited(None));
        let lost = json!({"reason": "holder_lost"});
        assert_eq!(ending(Some(&lost)), Ending::Lost("holder_lost".into()));
        assert_eq!(ending(None), Ending::Unexplained);
        assert_eq!(
            Ending::Unexplained.close_reason(),
            CloseReason::Lost("the stream ended".into())
        );
    }
}
