use std::path::PathBuf;
use std::time::{Duration, Instant};

use ducky_review::order::FileOrder;
use ducky_review::summary::StatusFilter;
use ducky_review::{NoteId, NoteStatus, Side};
use ducky_session::ReviewRequest;
use gpui_kit::*;

use super::scratch;
use super::steps::Steps;
use crate::config::{DiffMode, Prefs};
use crate::state::cursor::LinePos;
use crate::state::{ReviewModel, SidebarTab};
use crate::theme::{Appearance, Density, Palette};
use crate::views::workspace::Workspace;

const SETTLE: Duration = Duration::from_millis(700);
const TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Default)]
pub struct Script {
    open: Option<String>,
    machine: Option<String>,
    base: Option<String>,
    select: Option<String>,
    mode: Option<DiffMode>,
    appearance: Option<Appearance>,
    palette: Option<Palette>,
    density: Option<Density>,
    wrap: bool,
    ignore_whitespace: bool,
    tab: Option<SidebarTab>,
    notes_filter: Option<StatusFilter>,
    order: Option<FileOrder>,
    filter: Option<String>,
    collapse: Vec<String>,
    cursor: Option<u32>,
    compose: Option<(u32, Option<u32>)>,
    side: Side,
    compose_text: Option<String>,
    edit_note: Option<String>,
    submit: bool,
    keys: Vec<String>,
    quit: bool,
    help: bool,
    palette_open: bool,
    size: Option<(f32, f32)>,
    screenshot: Option<PathBuf>,
    steps: Steps,
    any: bool,
}

/// Stops the run's scratch cores, then exits.
pub fn fail(message: String) -> ! {
    eprintln!("codeducky: {message}");
    scratch::stop_all();
    std::process::exit(2);
}

fn parse<T>(flag: &str, value: &str, parse: impl Fn(&str) -> Option<T>) -> T {
    parse(value).unwrap_or_else(|| fail(format!("{flag}: unexpected value {value:?}")))
}

impl Script {
    pub fn from_args() -> Self {
        let mut script = Self::default();
        let mut args = std::env::args().skip(1);
        while let Some(flag) = args.next() {
            let mut value = || {
                args.next()
                    .unwrap_or_else(|| fail(format!("{flag} needs a value")))
            };
            match flag.as_str() {
                "--open" => script.open = Some(value()),
                "--machine" => script.machine = Some(value()),
                "--base" => script.base = Some(value()),
                "--select" => script.select = Some(value()),
                "--mode" => {
                    script.mode = Some(parse(&flag, &value(), |v| match v {
                        "unified" => Some(DiffMode::Unified),
                        "split" => Some(DiffMode::Split),
                        _ => None,
                    }))
                }
                "--appearance" => {
                    script.appearance = Some(parse(&flag, &value(), Appearance::parse))
                }
                "--palette" => script.palette = Some(parse(&flag, &value(), Palette::parse)),
                "--density" => script.density = Some(parse(&flag, &value(), Density::parse)),
                "--wrap" => script.wrap = true,
                "--ignore-whitespace" => script.ignore_whitespace = true,
                "--tab" => {
                    script.tab = Some(parse(&flag, &value(), |v| match v {
                        "files" => Some(SidebarTab::Files),
                        "notes" => Some(SidebarTab::Notes),
                        _ => None,
                    }))
                }
                "--notes-filter" => {
                    script.notes_filter = Some(parse(&flag, &value(), |v| match v {
                        "all" => Some(StatusFilter::All),
                        "open" => Some(StatusFilter::Active),
                        "resolved" => Some(StatusFilter::Status(NoteStatus::Resolved)),
                        "possibly" => Some(StatusFilter::PossiblyResolved),
                        _ => None,
                    }))
                }
                "--order" => {
                    script.order = Some(parse(&flag, &value(), |v| match v {
                        "folders" => Some(FileOrder::Folders),
                        "risk" => Some(FileOrder::Risk),
                        _ => None,
                    }))
                }
                "--filter" => script.filter = Some(value()),
                "--collapse" => script.collapse.push(value()),
                "--cursor" => script.cursor = Some(parse(&flag, &value(), |v| v.parse().ok())),
                "--compose" => {
                    script.compose = Some(parse(&flag, &value(), |v| match v.split_once('-') {
                        Some((a, b)) => Some((a.parse().ok()?, Some(b.parse().ok()?))),
                        None => Some((v.parse().ok()?, None)),
                    }))
                }
                "--side" => {
                    script.side = parse(&flag, &value(), |v| match v {
                        "old" => Some(Side::Old),
                        "new" => Some(Side::New),
                        _ => None,
                    })
                }
                "--compose-text" => script.compose_text = Some(value()),
                "--edit-note" => script.edit_note = Some(value()),
                "--submit" => script.submit = true,
                "--quit" => script.quit = true,
                "--keys" => script
                    .keys
                    .extend(value().split_whitespace().map(str::to_owned)),
                "--help-overlay" => script.help = true,
                "--palette-open" => script.palette_open = true,
                "--size" => {
                    script.size = Some(parse(&flag, &value(), |v| {
                        let (w, h) = v.split_once('x')?;
                        Some((w.parse().ok()?, h.parse().ok()?))
                    }))
                }
                "--screenshot" => script.screenshot = Some(PathBuf::from(value())),
                other => {
                    if !script.steps.parse(other, &mut value) {
                        fail(format!("unknown flag {other}"))
                    }
                }
            }
            script.any = true;
        }
        script
    }

    /// Applies the look and view flags; returns whether any flag was given.
    pub fn apply_prefs(&self, prefs: &mut Prefs) -> bool {
        if let Some(appearance) = self.appearance {
            prefs.appearance = appearance;
        }
        if let Some(palette) = self.palette {
            prefs.palette = palette;
        }
        if let Some(density) = self.density {
            prefs.density = density;
        }
        if let Some(mode) = self.mode {
            prefs.diff_mode = mode;
        }
        if self.any {
            prefs.wrap = self.wrap;
            prefs.ignore_whitespace = self.ignore_whitespace;
        }
        if let Some(size) = self.size {
            prefs.window = Some(size);
        }
        self.steps.apply_prefs(prefs);
        self.any
    }

    pub fn core_target(&mut self) -> Option<ducky_session::CoreTarget> {
        self.steps.core_target()
    }
}

async fn settle_until(
    cx: &mut AsyncApp,
    model: &Entity<ReviewModel>,
    what: &str,
    done: impl Fn(&ReviewModel) -> bool,
) {
    let start = Instant::now();
    loop {
        cx.background_executor()
            .timer(Duration::from_millis(50))
            .await;
        let state = cx.update(|cx| {
            let m = model.read(cx);
            (
                done(m),
                m.status
                    .as_ref()
                    .filter(|s| s.error)
                    .map(|s| s.text.clone()),
            )
        });
        match state {
            (true, _) => return,
            (false, Some(error)) => fail(format!("{what}: {error}")),
            _ if start.elapsed() > TIMEOUT => fail(format!("{what}: timed out")),
            _ => {}
        }
    }
}

pub fn run(script: Script, model: Entity<ReviewModel>, workspace: Entity<Workspace>, cx: &mut App) {
    if !script.any {
        return;
    }
    super::screenshot::pump_frames(cx);
    cx.spawn(async move |cx| {
        settle_until(cx, &model, "connecting", |m| {
            m.connection.is_some() && m.is_ready()
        })
        .await;
        script.steps.before_open(&workspace, cx).await;
        if let Some(path) = script.open.clone() {
            let request = ReviewRequest {
                path,
                machine: script.machine.clone(),
                base: script.base.clone(),
            };
            let started = Instant::now();
            cx.update(|cx| model.update(cx, |m, cx| m.open(request, cx)));
            settle_until(cx, &model, "opening", |m| {
                m.review.is_some() && m.is_ready()
            })
            .await;
            let opened = started.elapsed();
            settle_until(cx, &model, "loading the first file", |m| {
                m.is_ready() && (m.diff.is_some() || m.selected.is_none())
            })
            .await;
            cx.update(|cx| {
                let m = model.read(cx);
                eprintln!(
                    "opened in {opened:?} ({} files), first diff after {:?}",
                    m.review.as_ref().map_or(0, |r| r.files.len()),
                    started.elapsed()
                );
            });
        }
        cx.update(|cx| {
            model.update(cx, |m, cx| {
                if let Some(tab) = script.tab {
                    m.tab = tab;
                }
                if let Some(filter) = script.notes_filter {
                    m.notes_filter = filter;
                }
                if let Some(order) = script.order {
                    m.order = order;
                }
                if let Some(filter) = &script.filter {
                    m.filter = filter.clone();
                }
                m.collapsed.extend(script.collapse.iter().cloned());
                m.show_help = script.help;
                if let Some(path) = &script.select {
                    m.select(path.clone(), cx);
                }
                cx.notify();
            })
        });
        if let Some(path) = &script.select {
            let started = Instant::now();
            let path = path.clone();
            settle_until(cx, &model, "selecting", move |m| {
                m.is_ready() && m.selected.as_deref() == Some(path.as_str()) && m.diff.is_some()
            })
            .await;
            eprintln!("selected in {:?}", started.elapsed());
        }
        let window = cx.update(|cx| cx.windows().first().copied());
        if let Some(window) = window {
            window
                .update(cx, |_, window, cx| {
                    workspace.update(cx, |ws, cx| {
                        if let Some(line) = script.cursor {
                            ws.model.update(cx, |m, cx| {
                                m.cursor = Some(LinePos {
                                    side: script.side,
                                    line,
                                });
                                cx.emit(crate::state::ModelEvent::ScrollTo(LinePos {
                                    side: script.side,
                                    line,
                                }));
                                cx.emit(crate::state::ModelEvent::Select(Some((
                                    LinePos {
                                        side: script.side,
                                        line,
                                    },
                                    LinePos {
                                        side: script.side,
                                        line,
                                    },
                                ))));
                            });
                        }
                        if let Some(id) = &script.edit_note {
                            let id = NoteId::new(id.clone());
                            ws.model.update(cx, |m, cx| m.start_edit(&id, cx));
                        }
                        if let Some((line, end)) = script.compose {
                            ws.model
                                .update(cx, |m, cx| m.start_compose(script.side, line, end, cx));
                        }
                        if script.palette_open {
                            ws.toggle_palette(window, cx);
                        }
                    });
                })
                .ok();
            if let Some(text) = &script.compose_text {
                cx.background_executor()
                    .timer(Duration::from_millis(100))
                    .await;
                let text = text.clone();
                window
                    .update(cx, |_, window, cx| {
                        workspace.update(cx, |ws, cx| {
                            if let Some(input) = &ws.note_input {
                                input.update(cx, |input, cx| input.set_value(text, window, cx));
                            }
                            if script.submit {
                                ws.save_note(window, cx);
                            }
                        });
                    })
                    .ok();
            }
        }
        if let Some(window) = window {
            script.steps.after_open(window, &workspace, cx).await;
        }
        for key in &script.keys {
            let keystroke: &'static str = Box::leak(key.clone().into_boxed_str());
            let keystroke = Keystroke::parse(keystroke)
                .unwrap_or_else(|_| fail(format!("--keys: cannot parse {key:?}")));
            if let Some(window) = window {
                window
                    .update(cx, |_, window, cx| {
                        window.dispatch_keystroke(keystroke, cx);
                    })
                    .ok();
            }
            cx.background_executor()
                .timer(Duration::from_millis(120))
                .await;
            settle_until(cx, &model, "running keys", ReviewModel::is_ready).await;
        }
        if script.submit {
            settle_until(cx, &model, "saving the note", |m| {
                m.composer.is_none() && m.is_ready()
            })
            .await;
        }
        cx.background_executor().timer(SETTLE).await;
        if let Some(path) = script.screenshot.clone() {
            cx.update(|cx| {
                match super::screenshot::capture(&path, cx) {
                    Ok(()) => eprintln!("screenshot saved to {}", path.display()),
                    Err(error) => fail(format!("screenshot failed: {error:#}")),
                }
                scratch::stop_all();
                cx.quit();
            });
        } else if script.quit {
            scratch::stop_all();
            cx.update(|cx| cx.quit());
        }
    })
    .detach();
}
