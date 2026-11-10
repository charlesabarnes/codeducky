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
//!
//!   agents and machines (terminal work needs --scratch or --hc-socket, never the live core):
//!           [--scratch | --hc-socket <path>] [--scratch-machine <name>]
//!           [--scratch-template <name>=<command>]...
//!           [--panel] [--panel-height <px>] [--agent-command <cmd>]
//!           [--start-agent <name>[=<cmd>]]... [--check-note <id>]...
//!           [--task <agent>=fix|review|msg:<text>]... [--force] [--wait-task]
//!           [--agent <name>] [--agent-type <text>] [--focus-terminal]
//!           [--ask review|fix|message] [--start-dialog]
//!           [--add-machine-dialog [--add-machine-target <t>]] [--machine-menu]
//!           [--rename-machine <name>] [--forget-machine <name>]
//!           [--browse-machine <name> [--browse-path <path>]] [--stop-core]
//!
//!   since last look, commits, checklists, the file editor (--tab also takes `checks`):
//!           [--mark-viewed <path>]... [--mark-reviewed] [--review-mode all|since]
//!           [--show-unchanged] [--commit <n>[-<m>]] [--commit-picker]
//!           [--new-checklist "<title>[!]:<item>;<item>"]... [--new-global-checklist ...]...
//!           [--import-checklists <file>]... [--import-global-checklists <file>]...
//!           [--check <item number>]... [--export-checklists <file.json|file.md>]
//!           [--checklists-manager [--checklist-form "<title>:<item>;<item>"]]
//!           [--edit [--edit-text <text, \n for newlines>] [--disk-write <path>=<text>]
//!            [--save-file] [--leave-editor]]
//!
//!   GitHub (writes only against a fake; without one a run reads charlesabarnes/codeducky only):
//!           [--fake-github [--fake-auth ok|signed-out|missing-scopes] | --github-base-url <url>]
//!           [--inbox [--inbox-cursor <n>]] [--open-pr <url|owner/repo#n>] [--open-branch-pr]
//!           [--pr-note <path>:<line>:<text>]... [--tab threads|ci] [--focus-thread <id>]
//!           [--reply-thread <id> [--reply-text <md>] [--send-reply]] [--resolve-thread <id>]
//!           [--push-dialog] [--push] [--submit-dialog [--submit-event comment|approve|
//!            request-changes] [--submit-body <md>] [--submit-review]] [--head-move]
//!           [--github-settings [--paste-token <t>]]
//! ```
//!
//! `--mark-viewed` and `--mark-reviewed` write the repo's review state, and global checklists
//! are only kept when `CODEDUCKY_CONFIG_DIR` points somewhere: use fixture repos and a scratch
//! config dir. `--disk-write` writes into the checkout, to stage an on-disk conflict.
//!
//! Any of these flags keeps preferences from being written. `--scratch` starts a throwaway
//! herdr-core (and `--scratch-machine` a second one, added as a machine through a local `via`
//! command); both stop, and their folders go, when the run ends.

mod github;
mod modes;
mod scratch;
mod screenshot;
mod script;
mod steps;

pub use script::{Script, run};
