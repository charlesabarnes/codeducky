//! Pick a checkout on another machine, where there is no native folder dialog: its folders,
//! listed through herdr-core.

use std::sync::Arc;

use ducky_host::Host;
use ducky_session::{Listing, list_folders};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{ActiveTheme, Disableable as _, Sizable as _, h_flex, v_flex};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::keymap::SubmitDialog;
use crate::theme::ActiveCode;
use crate::views::dialog::{backdrop, error_line, frame};
use crate::views::widgets::muted;
use crate::views::workspace::Workspace;

pub struct FolderBrowser {
    workspace: WeakEntity<Workspace>,
    machine: Option<String>,
    host: Arc<dyn Host>,
    path: Entity<InputState>,
    listing: Option<Listing>,
    loading: bool,
    /// A new listing arrived: show its resolved path in the field on the next render.
    path_changed: bool,
    error: Option<String>,
    _subscription: Subscription,
}

impl FolderBrowser {
    pub fn new(
        workspace: WeakEntity<Workspace>,
        machine: Option<String>,
        host: Arc<dyn Host>,
        start: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let path = cx.new(|cx| InputState::new(window, cx).default_value(start.clone()));
        let subscription =
            cx.subscribe_in(&path, window, |this, input, event: &InputEvent, _, cx| {
                if matches!(event, InputEvent::PressEnter { .. }) {
                    let path = input.read(cx).value().to_string();
                    this.go(path, cx);
                }
            });
        let mut this = Self {
            workspace,
            machine,
            host,
            path,
            listing: None,
            loading: false,
            path_changed: false,
            error: None,
            _subscription: subscription,
        };
        this.go(start, cx);
        this
    }

    fn go(&mut self, path: String, cx: &mut Context<Self>) {
        let host = self.host.clone();
        self.loading = true;
        self.error = None;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { list_folders(&*host, &path) })
                .await;
            this.update(cx, |this, cx| {
                this.loading = false;
                match result {
                    Ok(listing) => {
                        this.listing = Some(listing);
                        this.path_changed = true;
                    }
                    Err(error) => this.error = Some(error.to_string()),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn open(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(listing) = &self.listing else {
            return;
        };
        let path = listing.path.clone();
        let machine = self.machine.clone();
        self.workspace
            .update(cx, |ws, cx| {
                ws.close_dialog(window, cx);
                ws.open(
                    ducky_session::ReviewRequest {
                        path,
                        machine,
                        base: None,
                    },
                    window,
                    cx,
                );
            })
            .ok();
    }
}

impl Render for FolderBrowser {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if std::mem::take(&mut self.path_changed)
            && let Some(listing) = &self.listing
        {
            let path = listing.path.clone();
            self.path
                .update(cx, |input, cx| input.set_value(path, window, cx));
        }
        let theme = cx.theme().clone();
        let code = *cx.code();
        let listing = self.listing.clone();
        let parent = listing.as_ref().and_then(Listing::parent);
        let rows = listing.iter().flat_map(|l| {
            l.folders
                .iter()
                .enumerate()
                .map(|(i, folder)| {
                    let target = l.child(&folder.name);
                    h_flex()
                        .id(("folder", i))
                        .gap_2()
                        .px_2()
                        .py_0p5()
                        .cursor_pointer()
                        .hover(|this| this.bg(code.bg_2))
                        .child(div().text_color(theme.muted_foreground).child("▸"))
                        .child(folder.name.clone())
                        .when(folder.is_repo, |this| {
                            this.child(div().text_color(code.add).child("git"))
                        })
                        .on_click(cx.listener(move |this, _, _, cx| this.go(target.clone(), cx)))
                        .into_any_element()
                })
                .collect::<Vec<_>>()
        });
        let is_repo = listing.as_ref().is_some_and(|l| l.is_repo);
        let title = match &self.machine {
            Some(machine) => format!("Open a repository on {machine}"),
            None => "Open a repository".into(),
        };
        let card = frame("folder-browser", title, 600., cx)
            .on_action(cx.listener(|this, _: &SubmitDialog, window, cx| this.open(window, cx)))
            .child(Input::new(&self.path).small())
            .child(
                v_flex()
                    .id("folder-list")
                    .h(px(320.))
                    .overflow_y_scroll()
                    .border_1()
                    .border_color(theme.border)
                    .rounded(theme.radius)
                    .font_family(theme.mono_font_family.clone())
                    .children(parent.map(|parent| {
                        div()
                            .id("folder-up")
                            .px_2()
                            .py_0p5()
                            .cursor_pointer()
                            .hover(|this| this.bg(code.bg_2))
                            .child("..")
                            .on_click(
                                cx.listener(move |this, _, _, cx| this.go(parent.clone(), cx)),
                            )
                    }))
                    .children(rows)
                    .when(self.loading, |this| {
                        this.child(muted("listing…", cx).px_2())
                    }),
            )
            .children(error_line(self.error.as_deref(), cx))
            .child(
                h_flex()
                    .gap_2()
                    .child(
                        muted(
                            if is_repo {
                                "this folder is a git checkout"
                            } else {
                                "pick a checkout (marked git), or open this folder"
                            },
                            cx,
                        )
                        .flex_1(),
                    )
                    .child(
                        Button::new("folder-open")
                            .label("Open this folder")
                            .small()
                            .primary()
                            .disabled(listing.is_none())
                            .on_click(cx.listener(|this, _, window, cx| this.open(window, cx))),
                    ),
            );
        backdrop(v_flex().child(card), cx)
    }
}
