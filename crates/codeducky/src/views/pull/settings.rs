//! GitHub settings: who you are signed in as and how, a fallback token to paste (kept in the
//! Keychain), and signing in again.

use ducky_session::github::GitHubStatus;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{ActiveTheme, Sizable as _, h_flex, v_flex};
use gpui_kit::*;

use crate::keymap::SubmitDialog;
use crate::state::GitHubModel;
use crate::theme::ActiveCode;
use crate::views::dialog::{backdrop, field, frame};
use crate::views::widgets::muted;

pub struct GitHubSettingsDialog {
    github: Entity<GitHubModel>,
    pub token: Entity<InputState>,
    _subscriptions: Vec<Subscription>,
}

impl GitHubSettingsDialog {
    pub fn new(github: Entity<GitHubModel>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let token = cx.new(|cx| {
            InputState::new(window, cx)
                .masked(true)
                .placeholder("github_pat_… or ghp_…")
        });
        let subscriptions = vec![
            cx.subscribe_in(&token, window, |this, _, event: &InputEvent, _, cx| {
                if matches!(event, InputEvent::PressEnter { .. }) {
                    this.save(cx);
                }
            }),
            cx.observe(&github, |_, _, cx| cx.notify()),
        ];
        token.update(cx, |input, cx| input.focus(window, cx));
        Self {
            github,
            token,
            _subscriptions: subscriptions,
        }
    }

    pub fn save(&mut self, cx: &mut Context<Self>) {
        let value = self.token.read(cx).text().to_string();
        if value.trim().is_empty() {
            return;
        }
        self.github.update(cx, |g, cx| g.save_token(value, cx));
    }
}

impl Render for GitHubSettingsDialog {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let code = *cx.code();
        let github = self.github.read(cx);
        let persists = github.setup.store.persists();
        let (line, color, detail) = match &github.status {
            GitHubStatus::SignedIn {
                login,
                origin,
                scope_hint,
            } => (
                format!("Signed in as {login} ({})", origin.label()),
                code.add,
                scope_hint.clone(),
            ),
            GitHubStatus::SignedOut { reason } => {
                ("Signed out".into(), code.del, Some(reason.clone()))
            }
            GitHubStatus::RateLimited { message, .. } => {
                (github.status_label(), code.modified, Some(message.clone()))
            }
            GitHubStatus::Failed { message } => {
                ("GitHub unreachable".into(), code.del, Some(message.clone()))
            }
            GitHubStatus::Checking => ("Checking…".into(), cx.theme().muted_foreground, None),
            GitHubStatus::Unchecked => {
                ("Not checked yet".into(), cx.theme().muted_foreground, None)
            }
        };
        let where_kept = if persists {
            "Kept in the macOS Keychain, never in the preferences file. `gh auth login` is used \
             first when it is logged in."
        } else if github.setup.fake {
            "This run talks to a fake GitHub: the token stays in memory."
        } else {
            "Kept in memory for this session only (no keychain support on this platform yet)."
        };
        let github_handle = self.github.clone();
        let forget = self.github.clone();
        let card = frame("github-settings", "GitHub", 560., cx)
            .on_action(cx.listener(|this, _: &SubmitDialog, _, cx| this.save(cx)))
            .child(
                v_flex()
                    .gap_1()
                    .child(div().text_color(color).child(line))
                    .children(detail.map(|d| muted(d, cx))),
            )
            .child(field(
                "personal access token (used when gh is not logged in)",
                Input::new(&self.token).small(),
                cx,
            ))
            .child(muted(where_kept, cx))
            .child(
                h_flex()
                    .gap_2()
                    .justify_end()
                    .child(
                        Button::new("github-forget")
                            .label("Forget saved token")
                            .small()
                            .on_click(move |_, _, cx| {
                                forget.update(cx, |g, cx| g.forget_token(cx));
                            }),
                    )
                    .child(
                        Button::new("github-retry")
                            .label("Sign in again")
                            .small()
                            .on_click(move |_, _, cx| {
                                github_handle.update(cx, |g, cx| g.sign_in(cx));
                            }),
                    )
                    .child(
                        Button::new("github-save")
                            .label("Save token")
                            .small()
                            .primary()
                            .on_click(cx.listener(|this, _, _, cx| this.save(cx))),
                    ),
            );
        backdrop(v_flex().child(card), cx)
    }
}
