//! The main window: title bar, sidebar, diff and status bar over one [`ReviewModel`].

use ducky_review::Side;
use ducky_session::ReviewRequest;
use gpui_kit::component::diff::{DiffEvent, DiffLinePosition, DiffLineRange, DiffSide, DiffState};
use gpui_kit::component::input::{InputEvent, InputState, TextareaState};
use gpui_kit::component::{
    ActiveTheme, WindowExt as _, h_flex, notification::Notification, v_flex,
};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::config::DiffMode;
use crate::keymap::*;
use crate::state::cursor::LinePos;
use crate::state::{
    AgentsModel, MachinesEvent, MachinesModel, ModelEvent, NoteAction, ReviewModel, SidebarTab,
};
use crate::theme::{self, Look};
use crate::views::agents::handoff_dialog::HandOffDialog;
use crate::views::agents::start_dialog::StartAgentDialog;
use crate::views::agents::{AgentsPanel, Ask};
use crate::views::checklist_manager::ChecklistManager;
use crate::views::editor_pane::EditorPane;
use crate::views::machines::add_dialog::AddMachineDialog;
use crate::views::machines::browser::FolderBrowser;
use crate::views::machines::rename_dialog::RenameMachineDialog;
use crate::views::{diff_pane, help, palette, sidebar, start, status_bar, title};

/// The one dialog open over the window.
pub enum Dialog {
    StartAgent(Entity<StartAgentDialog>),
    HandOff(Entity<HandOffDialog>),
    AddMachine(Entity<AddMachineDialog>),
    RenameMachine(Entity<RenameMachineDialog>),
    Browse(Entity<FolderBrowser>),
    Checklists(Entity<ChecklistManager>),
}

impl Dialog {
    fn view(&self) -> AnyView {
        match self {
            Self::StartAgent(d) => d.clone().into(),
            Self::HandOff(d) => d.clone().into(),
            Self::AddMachine(d) => d.clone().into(),
            Self::RenameMachine(d) => d.clone().into(),
            Self::Browse(d) => d.clone().into(),
            Self::Checklists(d) => d.clone().into(),
        }
    }
}

const MIN_PANEL: f32 = 120.;

pub struct Workspace {
    pub model: Entity<ReviewModel>,
    pub agents: Entity<AgentsModel>,
    pub machines: Entity<MachinesModel>,
    pub panel: Entity<AgentsPanel>,
    pub diff_state: Entity<DiffState>,
    pub focus: FocusHandle,
    pub filter_input: Entity<InputState>,
    pub path_input: Entity<InputState>,
    pub note_input: Option<Entity<TextareaState>>,
    /// The file editor; kept while it holds unsaved edits, even on the diff.
    pub editor: Option<Entity<EditorPane>>,
    pub palette: Option<Entity<palette::Palette>>,
    pub dialog: Option<Dialog>,
    pub show_machine_menu: bool,
    /// The text of the last toast, for dev scripting to print.
    pub last_toast: Option<String>,
    /// While resizing the panel: where the drag started and the height then.
    panel_drag: Option<(Pixels, f32)>,
    _subscriptions: Vec<Subscription>,
}

pub fn side_of(side: Side) -> DiffSide {
    match side {
        Side::Old => DiffSide::Original,
        Side::New => DiffSide::Modified,
    }
}

pub fn side_from(side: DiffSide) -> Side {
    match side {
        DiffSide::Original => Side::Old,
        DiffSide::Modified => Side::New,
    }
}

impl Workspace {
    pub fn new(model: Entity<ReviewModel>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let diff_state = cx.new(|cx| DiffState::new([], cx).with_expansion_lines(20));
        let filter_input = cx.new(|cx| InputState::new(window, cx).placeholder("filter files"));
        let path_input =
            cx.new(|cx| InputState::new(window, cx).placeholder("/path/to/a/checkout"));
        let agents = cx.new(|_| AgentsModel::new());
        let picked = model.read(cx).prefs.machine.clone();
        let machines = cx.new(|_| MachinesModel::new(picked));
        let panel = cx.new(|cx| AgentsPanel::new(agents.clone(), window, cx));
        let subscriptions = vec![
            cx.subscribe_in(&agents, window, Self::on_agents_event),
            cx.subscribe_in(&machines, window, Self::on_machines_event),
            cx.observe(&machines, |_, _, cx| cx.notify()),
            cx.observe_window_activation(window, |this, window, cx| {
                if window.is_window_active() && this.model.read(cx).review.is_some() {
                    this.model.update(cx, |m, cx| m.reload_notes(true, cx));
                }
            }),
            cx.observe_window_appearance(window, |this, window, cx| {
                this.apply_look(Some(window), cx);
            }),
            cx.observe(&model, |_, _, cx| cx.notify()),
            cx.observe_window_bounds(window, |this, window, cx| {
                let size = window.bounds().size;
                this.model.update(cx, |m, _| {
                    m.prefs.window = Some((f32::from(size.width), f32::from(size.height)));
                });
            }),
            cx.subscribe_in(&model, window, Self::on_model_event),
            cx.subscribe_in(&diff_state, window, Self::on_diff_event),
            cx.subscribe(&filter_input, |this, input, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    let query = input.read(cx).value().to_string();
                    this.model.update(cx, |model, cx| {
                        model.filter = query;
                        cx.notify();
                    });
                }
            }),
            cx.subscribe_in(
                &path_input,
                window,
                |this, _, event: &InputEvent, window, cx| {
                    if matches!(event, InputEvent::PressEnter { .. }) {
                        this.open_from_inputs(window, cx);
                    }
                },
            ),
        ];
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        let mut this = Self {
            model,
            agents,
            machines,
            panel,
            diff_state,
            focus,
            filter_input,
            path_input,
            note_input: None,
            editor: None,
            palette: None,
            dialog: None,
            show_machine_menu: false,
            last_toast: None,
            panel_drag: None,
            _subscriptions: subscriptions,
        };
        this.apply_look(Some(window), cx);
        this
    }

    pub fn look(&self, cx: &App) -> Look {
        let prefs = &self.model.read(cx).prefs;
        Look {
            appearance: prefs.appearance,
            palette: prefs.palette,
            density: prefs.density,
        }
    }

    pub fn apply_look(&mut self, window: Option<&Window>, cx: &mut Context<Self>) {
        theme::apply(self.look(cx), window, cx);
        cx.notify();
    }

    fn on_model_event(
        &mut self,
        _: &Entity<ReviewModel>,
        event: &ModelEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            ModelEvent::DiffReady => {
                self.show_diff(cx);
                self.follow_selection_in_editor(window, cx);
            }
            ModelEvent::EditorGoto(line) => self.editor_goto(*line, window, cx),
            ModelEvent::ScrollTo(at) => self.scroll_to(*at, cx),
            ModelEvent::Select(selection) => self.select_lines(*selection, cx),
            ModelEvent::ComposerOpened => self.open_composer(window, cx),
            ModelEvent::ExpandAll => self
                .diff_state
                .update(cx, |state, cx| state.expand_unchanged(cx)),
            ModelEvent::Error(message) => {
                window.push_notification(Notification::error(message.clone()), cx);
            }
            ModelEvent::Connected => {
                let connection = self.model.read(cx).connection.clone();
                self.machines
                    .update(cx, |m, cx| m.set_connection(connection.as_ref(), cx));
                self.follow_review(cx);
            }
            ModelEvent::ReviewOpened => self.follow_review(cx),
        }
    }

    /// Points the agents panel at the open review (or at nothing).
    fn follow_review(&mut self, cx: &mut Context<Self>) {
        let model = self.model.read(cx);
        let (connection, generation, review) = (
            model.connection.clone(),
            model.connection_generation,
            model.review.clone(),
        );
        self.agents.update(cx, |agents, cx| {
            agents.follow(connection.as_ref(), generation, review.as_ref(), cx)
        });
    }

    fn on_machines_event(
        &mut self,
        _: &Entity<MachinesModel>,
        event: &MachinesEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (from, to) = match event {
            MachinesEvent::Failed(text) => {
                window.push_notification(Notification::error(text.clone()), cx);
                return;
            }
            MachinesEvent::Renamed { from, to } => (from.clone(), Some(to.clone())),
            MachinesEvent::Removed { name } => {
                window.push_notification(
                    Notification::info(format!(
                        "Forgot {name}. Its terminals keep running there; add it again to reach \
                         them."
                    )),
                    cx,
                );
                (name.clone(), None)
            }
        };
        self.model.update(cx, |m, cx| {
            m.prefs.rename_machine(&from, to.as_deref());
            m.save_prefs();
            cx.notify();
        });
    }

    pub fn pick_machine(
        &mut self,
        machine: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.machines
            .update(cx, |m, cx| m.pick(machine.clone(), cx));
        self.model.update(cx, |m, cx| {
            m.prefs.machine = machine;
            m.save_prefs();
            cx.notify();
        });
        if self.model.read(cx).review.is_none() {
            self.path_input
                .update(cx, |input, cx| input.focus(window, cx));
        }
    }

    pub fn open_add_machine(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let workspace = cx.entity().downgrade();
        let dialog = cx.new(|cx| AddMachineDialog::new(workspace, window, cx));
        self.dialog = Some(Dialog::AddMachine(dialog));
        cx.notify();
    }

    pub fn open_rename_machine(
        &mut self,
        machine: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let workspace = cx.entity().downgrade();
        let dialog = cx.new(|cx| RenameMachineDialog::new(workspace, machine, window, cx));
        self.dialog = Some(Dialog::RenameMachine(dialog));
        cx.notify();
    }

    pub fn close_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.dialog.take().is_some() {
            if self.model.read(cx).review.is_some() {
                window.focus(&self.focus, cx);
            } else {
                self.path_input
                    .update(cx, |input, cx| input.focus(window, cx));
            }
        }
        cx.notify();
    }

    fn on_diff_event(
        &mut self,
        _: &Entity<DiffState>,
        event: &DiffEvent,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let DiffEvent::SelectionEnded(range) = event {
            let at = LinePos {
                side: side_from(range.end_side()),
                line: range.end() as u32,
            };
            self.model.update(cx, |model, cx| {
                model.cursor = Some(at);
                model.anchor = (range.side() == range.end_side()).then_some(LinePos {
                    side: side_from(range.side()),
                    line: range.start() as u32,
                });
                cx.notify();
            });
        }
    }

    fn show_diff(&mut self, cx: &mut Context<Self>) {
        let model = self.model.read(cx);
        let files: Vec<_> = model
            .diff
            .as_ref()
            .and_then(|loaded| loaded.file.clone())
            .into_iter()
            .collect();
        let cursor = model.cursor;
        let mode = model.prefs.diff_mode;
        self.diff_state.update(cx, |state, cx| {
            state.set_files(files, cx);
            state.set_mode(kit_mode(mode), cx);
        });
        if let Some(at) = cursor {
            self.scroll_to(at, cx);
        }
        cx.notify();
    }

    fn position(&self, at: LinePos, cx: &App) -> Option<DiffLinePosition> {
        let path = self.model.read(cx).selected.clone()?;
        Some(DiffLinePosition::new(
            path,
            side_of(at.side),
            at.line as usize,
        ))
    }

    fn scroll_to(&mut self, at: LinePos, cx: &mut Context<Self>) {
        if let Some(position) = self.position(at, cx) {
            self.diff_state
                .update(cx, |state, cx| state.scroll_to_line(position, cx));
        }
    }

    fn select_lines(&mut self, selection: Option<(LinePos, LinePos)>, cx: &mut Context<Self>) {
        let path = self.model.read(cx).selected.clone();
        let range = selection.zip(path).map(|((from, to), path)| {
            DiffLineRange::new(
                path,
                side_of(from.side),
                from.line as usize,
                to.line as usize,
            )
            .with_end_side(side_of(to.side))
        });
        self.diff_state
            .update(cx, |state, cx| state.set_selected_lines(range, cx));
    }

    fn open_composer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let body = self
            .model
            .read(cx)
            .composer
            .as_ref()
            .map(|c| c.body.clone())
            .unwrap_or_default();
        let input = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(3, 16)
                .placeholder("Leave a note (Markdown)")
                .default_value(body)
        });
        input.update(cx, |input, cx| input.focus(window, cx));
        self.note_input = Some(input);
        if let Some(composer) = self.model.read(cx).composer.clone() {
            self.scroll_to(
                LinePos {
                    side: composer.side,
                    line: composer.last_line(),
                },
                cx,
            );
        }
    }

    pub fn save_note(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(input) = &self.note_input else {
            return;
        };
        let body = input.read(cx).value().to_string();
        self.model
            .update(cx, |model, cx| model.save_composer(body, cx));
        window.focus(&self.focus, cx);
    }

    pub fn cancel_note(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.note_input = None;
        self.model.update(cx, |model, cx| model.cancel_compose(cx));
        window.focus(&self.focus, cx);
    }

    pub fn open_from_inputs(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let path = self.path_input.read(cx).value().trim().to_owned();
        let machine = self.machines.read(cx).picked.clone();
        if path.is_empty() {
            self.model.update(cx, |model, cx| {
                model.fail("enter a path to a git checkout".into(), cx)
            });
            return;
        }
        let path = expand_home(&path, machine.is_none());
        if machine.is_none() && !std::path::Path::new(&path).is_dir() {
            self.model.update(cx, |model, cx| {
                model.fail(format!("{path} is not a folder here"), cx)
            });
            return;
        }
        self.open(
            ReviewRequest {
                path,
                machine,
                base: None,
            },
            window,
            cx,
        );
    }

    pub fn open(&mut self, request: ReviewRequest, window: &mut Window, cx: &mut Context<Self>) {
        self.model.update(cx, |model, cx| model.open(request, cx));
        window.focus(&self.focus, cx);
    }

    /// The native folder dialog on this machine; a folder list through herdr-core on another.
    pub fn browse(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(machine) = self.machines.read(cx).picked.clone() {
            self.browse_on(machine, String::new(), window, cx);
            return;
        }
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Review".into()),
        });
        cx.spawn_in(window, async move |this, cx| {
            let Ok(Ok(Some(mut paths))) = paths.await else {
                return;
            };
            let Some(path) = paths.pop() else {
                return;
            };
            this.update_in(cx, |this, window, cx| {
                let request = ReviewRequest::local(path.to_string_lossy().into_owned());
                this.open(request, window, cx);
            })
            .ok();
        })
        .detach();
    }

    pub fn browse_on(
        &mut self,
        machine: String,
        start: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let host = self
            .model
            .read(cx)
            .connection
            .as_ref()
            .map(|c| c.host(Some(&machine)));
        let host = match host {
            Some(Ok(host)) => host,
            Some(Err(error)) => {
                let text = error.to_string();
                self.model.update(cx, |m, cx| m.fail(text, cx));
                return;
            }
            None => return,
        };
        let workspace = cx.entity().downgrade();
        let dialog =
            cx.new(|cx| FolderBrowser::new(workspace, Some(machine), host, start, window, cx));
        self.dialog = Some(Dialog::Browse(dialog));
        cx.notify();
    }

    fn on_comment(&mut self, _: &Comment, _: &mut Window, cx: &mut Context<Self>) {
        let selected = self.diff_state.read(cx).selected_lines();
        self.model.update(cx, |model, cx| match selected {
            Some(range) if range.side() == range.end_side() => model.start_compose(
                side_from(range.side()),
                range.start() as u32,
                Some(range.end() as u32),
                cx,
            ),
            _ => model.comment_at_cursor(cx),
        });
    }

    fn note_action(&mut self, action: NoteAction, cx: &mut Context<Self>) {
        self.model.update(cx, |model, cx| {
            if let Some(id) = model.note_near_cursor() {
                model.note_action(id, action, cx);
            }
        });
    }

    fn bind_actions(&self, cx: &mut Context<Self>) -> Div {
        div()
            .on_action(cx.listener(|this, _: &NextLine, _, cx| {
                this.model.update(cx, |m, cx| m.move_line(1, false, cx))
            }))
            .on_action(cx.listener(|this, _: &PrevLine, _, cx| {
                this.model.update(cx, |m, cx| m.move_line(-1, false, cx))
            }))
            .on_action(cx.listener(|this, _: &ExtendDown, _, cx| {
                this.model.update(cx, |m, cx| m.move_line(1, true, cx))
            }))
            .on_action(cx.listener(|this, _: &ExtendUp, _, cx| {
                this.model.update(cx, |m, cx| m.move_line(-1, true, cx))
            }))
            .on_action(cx.listener(|this, _: &ClearSelection, _, cx| {
                this.show_machine_menu = false;
                this.model.update(cx, |m, cx| {
                    m.show_help = false;
                    m.show_base_picker = false;
                    m.show_commit_picker = false;
                    m.clear_selection(cx)
                })
            }))
            .on_action(cx.listener(|this, _: &NextChange, _, cx| {
                this.model
                    .update(cx, |m, cx| m.step_change(true, false, cx))
            }))
            .on_action(cx.listener(|this, _: &PrevChange, _, cx| {
                this.model
                    .update(cx, |m, cx| m.step_change(false, false, cx))
            }))
            .on_action(cx.listener(|this, _: &NextHunk, _, cx| {
                this.model.update(cx, |m, cx| m.step_change(true, true, cx))
            }))
            .on_action(cx.listener(|this, _: &PrevHunk, _, cx| {
                this.model
                    .update(cx, |m, cx| m.step_change(false, true, cx))
            }))
            .on_action(cx.listener(|this, _: &NextFile, _, cx| {
                this.model.update(cx, |m, cx| {
                    m.step_file(true, false, cx);
                })
            }))
            .on_action(cx.listener(|this, _: &PrevFile, _, cx| {
                this.model.update(cx, |m, cx| {
                    m.step_file(false, false, cx);
                })
            }))
            .on_action(cx.listener(|this, _: &NextUnviewed, _, cx| {
                this.model.update(cx, |m, cx| {
                    if !m.step_file(true, true, cx) {
                        m.say("no more unviewed files", cx);
                    }
                })
            }))
            .on_action(cx.listener(|this, _: &PrevUnviewed, _, cx| {
                this.model.update(cx, |m, cx| {
                    if !m.step_file(false, true, cx) {
                        m.say("no earlier unviewed files", cx);
                    }
                })
            }))
            .on_action(cx.listener(|this, _: &NextNote, _, cx| {
                this.model.update(cx, |m, cx| m.step_note(true, cx))
            }))
            .on_action(cx.listener(|this, _: &PrevNote, _, cx| {
                this.model.update(cx, |m, cx| m.step_note(false, cx))
            }))
            .on_action(cx.listener(|this, _: &ExpandAll, _, cx| {
                this.model.update(cx, |m, cx| m.expand_all(cx))
            }))
            .on_action(cx.listener(Self::on_comment))
            .on_action(cx.listener(|this, _: &EditNote, _, cx| {
                this.model.update(cx, |m, cx| {
                    if let Some(id) = m.note_near_cursor() {
                        m.start_edit(&id, cx);
                    }
                })
            }))
            .on_action(cx.listener(|this, _: &ResolveNote, _, cx| {
                this.note_action(NoteAction::ResolveOrReopen, cx)
            }))
            .on_action(
                cx.listener(|this, _: &DismissNote, _, cx| {
                    this.note_action(NoteAction::Dismiss, cx)
                }),
            )
            .on_action(cx.listener(|this, _: &ToggleViewed, _, cx| {
                this.model.update(cx, |m, cx| {
                    if let Some(path) = m.selected.clone() {
                        m.toggle_viewed(path, true, cx);
                    }
                })
            }))
            .on_action(cx.listener(|this, _: &ToggleMode, _, cx| {
                this.toggle_mode(cx);
            }))
            .on_action(cx.listener(|this, _: &ToggleWhitespace, _, cx| {
                this.model.update(cx, |m, cx| m.toggle_whitespace(cx))
            }))
            .on_action(cx.listener(|this, _: &ToggleWrap, _, cx| {
                this.model.update(cx, |m, cx| m.toggle_wrap(cx))
            }))
            .on_action(cx.listener(|this, _: &ToggleOrder, _, cx| {
                this.model.update(cx, |m, cx| m.toggle_order(cx))
            }))
            .on_action(cx.listener(|this, _: &ChangeBase, _, cx| {
                this.model.update(cx, |m, cx| {
                    m.show_base_picker = !m.show_base_picker;
                    cx.notify();
                })
            }))
            .on_action(cx.listener(|this, _: &FocusFilter, window, cx| {
                this.model.update(cx, |m, cx| {
                    m.tab = SidebarTab::Files;
                    cx.notify();
                });
                this.filter_input
                    .update(cx, |input, cx| input.focus(window, cx));
            }))
            .on_action(cx.listener(|this, _: &FilesTab, _, cx| {
                this.model.update(cx, |m, cx| {
                    m.tab = SidebarTab::Files;
                    cx.notify();
                })
            }))
            .on_action(cx.listener(|this, _: &NotesTab, _, cx| {
                this.model.update(cx, |m, cx| {
                    m.tab = SidebarTab::Notes;
                    cx.notify();
                })
            }))
            .on_action(cx.listener(|this, _: &ToggleHelp, _, cx| {
                this.model.update(cx, |m, cx| {
                    m.show_help = !m.show_help;
                    cx.notify();
                })
            }))
            .on_action(
                cx.listener(|this, _: &Refresh, _, cx| {
                    this.model.update(cx, |m, cx| m.refresh(cx))
                }),
            )
            .on_action(cx.listener(|this, _: &ReloadNotes, _, cx| {
                this.model.update(cx, |m, cx| m.reload_notes(false, cx))
            }))
            .on_action(cx.listener(|this, _: &OpenRepo, window, cx| {
                this.close_review(window, cx);
            }))
            .on_action(cx.listener(|this, _: &CycleAppearance, window, cx| {
                this.model
                    .update(cx, |m, _| m.prefs.appearance = m.prefs.appearance.next());
                this.after_look_change(window, cx);
            }))
            .on_action(cx.listener(|this, _: &CyclePalette, window, cx| {
                this.model
                    .update(cx, |m, _| m.prefs.palette = m.prefs.palette.next());
                this.after_look_change(window, cx);
            }))
            .on_action(cx.listener(|this, _: &CycleDensity, window, cx| {
                this.model
                    .update(cx, |m, _| m.prefs.density = m.prefs.density.next());
                this.after_look_change(window, cx);
            }))
            .on_action(cx.listener(|this, _: &CommandPalette, window, cx| {
                this.toggle_palette(window, cx);
            }))
            .on_action(cx.listener(|this, _: &ToggleAgents, window, cx| {
                this.toggle_agents(window, cx);
            }))
            .on_action(cx.listener(|this, _: &FocusTerminal, window, cx| {
                this.focus_terminal(window, cx);
            }))
            .on_action(cx.listener(|this, _: &StartAgent, window, cx| {
                this.open_start_dialog(None, window, cx);
            }))
            .on_action(cx.listener(|this, _: &AskReview, window, cx| {
                this.ask(Ask::Review, window, cx);
            }))
            .on_action(cx.listener(|this, _: &AskFix, window, cx| {
                this.ask(Ask::Fix, window, cx);
            }))
            .on_action(cx.listener(|this, _: &AskMessage, window, cx| {
                this.ask(Ask::Message, window, cx);
            }))
            .on_action(cx.listener(|this, _: &ReconnectCore, _, cx| {
                this.model.update(cx, |m, cx| m.reconnect(cx));
            }))
            .on_action(cx.listener(|this, _: &PickMachine, _, cx| {
                this.show_machine_menu = !this.show_machine_menu;
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &CloseDialog, window, cx| {
                this.close_dialog(window, cx);
            }))
            .on_action(cx.listener(|this, _: &ToggleSince, _, cx| {
                this.model.update(cx, |m, cx| m.toggle_since(cx))
            }))
            .on_action(cx.listener(|this, _: &AllChanges, _, cx| {
                this.model.update(cx, |m, cx| {
                    m.show_commit_picker = false;
                    m.set_review_mode(ducky_session::ReviewMode::All, cx)
                })
            }))
            .on_action(cx.listener(|this, _: &NextCommit, _, cx| {
                this.model.update(cx, |m, cx| {
                    m.step_commit(ducky_review::commit_range::Step::Forward, cx)
                })
            }))
            .on_action(cx.listener(|this, _: &PrevCommit, _, cx| {
                this.model.update(cx, |m, cx| {
                    m.step_commit(ducky_review::commit_range::Step::Back, cx)
                })
            }))
            .on_action(cx.listener(|this, _: &CommitPicker, _, cx| {
                this.model.update(cx, |m, cx| {
                    m.show_commit_picker = !m.show_commit_picker;
                    cx.notify();
                })
            }))
            .on_action(cx.listener(|this, _: &ToggleUnchanged, _, cx| {
                this.model.update(cx, |m, cx| m.toggle_unchanged(cx))
            }))
            .on_action(cx.listener(|this, _: &MarkReviewed, _, cx| {
                this.model.update(cx, |m, cx| m.mark_reviewed(cx))
            }))
            .on_action(cx.listener(|this, _: &ChecksTab, _, cx| {
                this.model.update(cx, |m, cx| {
                    m.tab = SidebarTab::Checks;
                    cx.notify();
                })
            }))
            .on_action(cx.listener(|this, _: &ManageChecklists, _, cx| {
                this.open_checklist_manager(cx);
            }))
            .on_action(cx.listener(|this, _: &ToggleEditor, window, cx| {
                this.toggle_editor(window, cx);
            }))
            .on_action(cx.listener(|this, _: &SaveFile, _, cx| {
                if let Some(editor) = this.editor.clone() {
                    editor.update(cx, |editor, cx| editor.save(false, cx));
                }
            }))
            .on_action(cx.listener(|this, _: &RevertFile, window, cx| {
                if let Some(editor) = this.editor.clone() {
                    editor.update(cx, |editor, cx| editor.revert(window, cx));
                }
            }))
    }

    pub fn open_checklist_manager(&mut self, cx: &mut Context<Self>) {
        if self.model.read(cx).review.is_none() {
            return;
        }
        let workspace = cx.entity().downgrade();
        let global = self.model.read(cx).has_global_checklists();
        let manager = cx.new(|_| ChecklistManager::new(workspace, global));
        cx.observe(&self.model, {
            let manager = manager.downgrade();
            move |_, _, cx| {
                manager.update(cx, |_, cx| cx.notify()).ok();
            }
        })
        .detach();
        self.dialog = Some(Dialog::Checklists(manager));
        cx.notify();
    }

    pub fn after_look_change(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.model.read(cx).save_prefs();
        self.apply_look(Some(window), cx);
    }

    pub fn toggle_mode(&mut self, cx: &mut Context<Self>) {
        let mode = match self.model.read(cx).prefs.diff_mode {
            DiffMode::Unified => DiffMode::Split,
            DiffMode::Split => DiffMode::Unified,
        };
        self.set_mode(mode, cx);
    }

    pub fn set_mode(&mut self, mode: DiffMode, cx: &mut Context<Self>) {
        self.model.update(cx, |m, cx| m.set_mode(mode, cx));
        self.diff_state
            .update(cx, |state, cx| state.set_mode(kit_mode(mode), cx));
    }

    pub fn close_review(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(path) = self.model.read(cx).unsaved.clone() {
            self.model.update(cx, |m, cx| {
                m.fail(
                    format!("{path} has unsaved changes: save them (cmd-s) or revert them first"),
                    cx,
                )
            });
            return;
        }
        self.editor = None;
        self.model.update(cx, |m, cx| {
            m.review = None;
            m.diff = None;
            m.selected = None;
            m.composer = None;
            m.view = None;
            m.visible.clear();
            m.pane = crate::state::Pane::Diff;
            m.mode = ducky_session::ReviewMode::All;
            m.show_commit_picker = false;
            cx.notify();
        });
        self.follow_review(cx);
        self.machines.update(cx, |m, cx| m.refresh(cx));
        self.diff_state
            .update(cx, |state, cx| state.set_files([], cx));
        self.path_input
            .update(cx, |input, cx| input.focus(window, cx));
    }

    pub fn toggle_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.palette.take().is_none() {
            let this = cx.entity().downgrade();
            let palette = cx.new(|cx| palette::Palette::new(this, window, cx));
            palette.update(cx, |p, cx| p.focus(window, cx));
            self.palette = Some(palette);
        } else {
            window.focus(&self.focus, cx);
        }
        cx.notify();
    }
}

pub fn kit_mode(mode: DiffMode) -> gpui_kit::component::diff::DiffMode {
    match mode {
        DiffMode::Unified => gpui_kit::component::diff::DiffMode::Unified,
        DiffMode::Split => gpui_kit::component::diff::DiffMode::Split,
    }
}

fn expand_home(path: &str, local: bool) -> String {
    match (path.strip_prefix("~/"), std::env::var("HOME")) {
        (Some(rest), Ok(home)) if local => format!("{home}/{rest}"),
        _ => path.to_owned(),
    }
}

impl Focusable for Workspace {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for Workspace {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let has_review = self.model.read(cx).review.is_some();
        let show_help = self.model.read(cx).show_help;
        let show_base_picker = self.model.read(cx).show_base_picker;
        let (background, foreground) = (cx.theme().background, cx.theme().foreground);
        let text_size = crate::theme::ActiveCode::code(&**cx).metrics.text;
        let panel = self.model.read(cx).prefs.agents;
        let body = if has_review {
            let border = cx.theme().border;
            h_flex()
                .flex_1()
                .min_h_0()
                .child(sidebar::render(self, window, cx))
                .child(
                    v_flex()
                        .flex_1()
                        .min_w_0()
                        .h_full()
                        .child(
                            div()
                                .flex_1()
                                .min_h_0()
                                .flex()
                                .flex_col()
                                .child(diff_pane::render(self, window, cx)),
                        )
                        .when(panel.open, |this| {
                            this.child(
                                div()
                                    .id("panel-resize")
                                    .h(px(5.))
                                    .flex_none()
                                    .border_t_1()
                                    .border_color(border)
                                    .cursor(CursorStyle::ResizeUpDown)
                                    .on_mouse_down(
                                        MouseButton::Left,
                                        cx.listener(|this, event: &MouseDownEvent, _, cx| {
                                            let height = this.model.read(cx).prefs.agents.height;
                                            this.panel_drag = Some((event.position.y, height));
                                        }),
                                    ),
                            )
                            .child(
                                div()
                                    .h(px(panel.height))
                                    .flex_none()
                                    .child(self.panel.clone()),
                            )
                        }),
                )
                .into_any_element()
        } else {
            start::render(self, window, cx).into_any_element()
        };
        let window_height = f32::from(window.bounds().size.height);
        let root = self
            .bind_actions(cx)
            .on_mouse_move(cx.listener(move |this, event: &MouseMoveEvent, _, cx| {
                let Some((start, height)) = this.panel_drag else {
                    return;
                };
                let max = (window_height - 220.).max(MIN_PANEL);
                let next = (height + f32::from(start - event.position.y)).clamp(MIN_PANEL, max);
                this.model.update(cx, |m, cx| {
                    m.prefs.agents.height = next;
                    cx.notify();
                });
            }))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, _, _, cx| {
                    if this.panel_drag.take().is_some() {
                        this.model.read(cx).save_prefs();
                    }
                }),
            )
            .id("workspace")
            .key_context("Review")
            .track_focus(&self.focus)
            .size_full()
            .relative()
            .flex()
            .flex_col()
            .bg(background)
            .text_color(foreground)
            .text_size(text_size)
            .child(title::render(self, window, cx))
            .child(body)
            .child(status_bar::render(self, window, cx));
        let root = if show_base_picker && has_review {
            root.child(crate::views::base_picker::render(self, cx))
        } else {
            root
        };
        let root = if self.model.read(cx).show_commit_picker && has_review {
            root.child(crate::views::commit_picker::render(self, cx))
        } else {
            root
        };
        let root = if show_help {
            root.child(help::render(cx))
        } else {
            root
        };
        let root = if self.show_machine_menu {
            root.child(crate::views::machines::menu::render(self, cx))
        } else {
            root
        };
        let root = match &self.palette {
            Some(palette) => root.child(palette.clone()),
            None => root,
        };
        match &self.dialog {
            Some(dialog) => root.child(dialog.view()),
            None => root,
        }
    }
}
