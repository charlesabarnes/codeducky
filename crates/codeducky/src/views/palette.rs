//! The command palette: every command by name, with its shortcut.

use gpui_kit::component::command::{Command, CommandItem, CommandState};
use gpui_kit::component::{ActiveTheme, v_flex};
use gpui_kit::*;

use crate::keymap::*;
use crate::views::workspace::Workspace;

pub struct Palette {
    state: Entity<CommandState>,
    workspace: WeakEntity<Workspace>,
}

fn commands() -> Vec<(&'static str, Box<dyn Action>)> {
    vec![
        ("Next file", Box::new(NextFile)),
        ("Previous file", Box::new(PrevFile)),
        ("Next unviewed file", Box::new(NextUnviewed)),
        ("Next change", Box::new(NextHunk)),
        ("Previous change", Box::new(PrevHunk)),
        ("Comment on the focused line", Box::new(Comment)),
        ("Toggle viewed", Box::new(ToggleViewed)),
        ("Switch split and unified", Box::new(ToggleMode)),
        (
            "Hide or show whitespace changes",
            Box::new(ToggleWhitespace),
        ),
        ("Wrap long lines", Box::new(ToggleWrap)),
        ("Order files by folder or risk", Box::new(ToggleOrder)),
        ("Expand all collapsed lines", Box::new(ExpandAll)),
        ("Change the base", Box::new(ChangeBase)),
        ("Files tab", Box::new(FilesTab)),
        ("Notes tab", Box::new(NotesTab)),
        ("Refresh the review", Box::new(Refresh)),
        ("Reload notes", Box::new(ReloadNotes)),
        ("Open a repository", Box::new(OpenRepo)),
        ("Agents: show or hide the panel", Box::new(ToggleAgents)),
        (
            "Agents: move between diff and terminal",
            Box::new(FocusTerminal),
        ),
        ("Agents: start an agent", Box::new(StartAgent)),
        ("Agents: ask for a review", Box::new(AskReview)),
        ("Agents: fix the open or checked notes", Box::new(AskFix)),
        ("Agents: send a message", Box::new(AskMessage)),
        ("herdr-core: connect again", Box::new(ReconnectCore)),
        (
            "Machines: open a repository on another machine",
            Box::new(PickMachine),
        ),
        ("Theme: light, dark or system", Box::new(CycleAppearance)),
        ("Theme: next palette", Box::new(CyclePalette)),
        (
            "Density: compact, default or comfortable",
            Box::new(CycleDensity),
        ),
        ("Keyboard shortcuts", Box::new(ToggleHelp)),
        ("Quit", Box::new(Quit)),
    ]
}

impl Palette {
    pub fn new(
        workspace: WeakEntity<Workspace>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        Self {
            state: cx.new(|cx| CommandState::new(window, cx)),
            workspace,
        }
    }

    pub fn focus(&self, window: &mut Window, cx: &mut App) {
        self.state.update(cx, |state, cx| state.focus(window, cx));
    }
}

impl Render for Palette {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let close = {
            let workspace = self.workspace.clone();
            move |window: &mut Window, cx: &mut App| {
                workspace
                    .update(cx, |ws, cx| {
                        ws.palette = None;
                        window.focus(&ws.focus, cx);
                        cx.notify();
                    })
                    .ok();
            }
        };
        let on_confirm = close.clone();
        let items = commands()
            .into_iter()
            .map(|(label, action)| CommandItem::new().label(label).action(action));
        div()
            .absolute()
            .inset_0()
            .flex()
            .justify_center()
            .items_start()
            .pt(px(80.))
            .bg(cx.theme().background.opacity(0.4))
            .child(
                v_flex()
                    .w(px(520.))
                    .bg(cx.theme().popover)
                    .border_1()
                    .border_color(cx.theme().border)
                    .rounded(cx.theme().radius_lg)
                    .child(
                        Command::new(&self.state)
                            .placeholder("Type a command")
                            .items(items)
                            .max_h(px(420.))
                            .on_confirm(move |_, window, cx| on_confirm(window, cx))
                            .on_cancel(move |window, cx| close(window, cx)),
                    ),
            )
    }
}
