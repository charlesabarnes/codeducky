//! herdr-core's machines as the start screen and title bar show them. Calls run on the
//! background executor; the add and rename forms await theirs to show errors in place.

use ducky_session::Connection;
use ducky_session::machines::{
    MachineEntry, MachineError, MachineState, MachinesService, NewMachine,
};
use gpui_kit::*;

pub enum MachinesEvent {
    Renamed { from: String, to: String },
    Removed { name: String },
    Failed(String),
}

impl EventEmitter<MachinesEvent> for MachinesModel {}

#[derive(Default)]
pub struct MachinesModel {
    service: Option<MachinesService>,
    pub machines: Vec<MachineEntry>,
    /// The machine the start screen opens repos on; `None` for this one.
    pub picked: Option<String>,
    pub busy: Option<String>,
    /// Why the list could not be read.
    pub problem: Option<String>,
    /// A machine waiting for the person to confirm forgetting it.
    pub confirm_remove: Option<String>,
    polling: bool,
}

const POLL: std::time::Duration = std::time::Duration::from_secs(2);

type Outcome<T> = Result<T, MachineError>;

impl MachinesModel {
    pub fn new(picked: Option<String>) -> Self {
        Self {
            picked,
            ..Self::default()
        }
    }

    pub fn entry(&self, name: &str) -> Option<&MachineEntry> {
        self.machines.iter().find(|m| m.name == name)
    }

    pub fn set_connection(&mut self, connection: Option<&Connection>, cx: &mut Context<Self>) {
        self.service = connection.and_then(|c| MachinesService::new(c).ok());
        self.machines.clear();
        self.problem = None;
        self.refresh(cx);
    }

    fn call<T: Send + 'static>(
        &mut self,
        label: String,
        cx: &mut Context<Self>,
        work: impl FnOnce(&MachinesService) -> Outcome<T> + Send + 'static,
    ) -> Task<Outcome<T>> {
        let Some(service) = self.service.clone() else {
            return Task::ready(Err(MachineError::input(
                "machines need herdr-core, which is not running",
            )));
        };
        self.busy = Some(label);
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move { work(&service) })
                .await;
            this.update(cx, |this, cx| {
                this.busy = None;
                cx.notify();
            })
            .ok();
            result
        })
    }

    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        if self.service.is_none() {
            return;
        }
        let task = self.call("listing machines".into(), cx, |s| s.list());
        cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |this, cx| {
                match result {
                    Ok(machines) => {
                        this.machines = machines;
                        this.problem = None;
                        if this
                            .machines
                            .iter()
                            .any(|m| m.state == MachineState::Connecting)
                        {
                            this.refresh_soon(cx);
                        }
                    }
                    Err(error) => this.problem = Some(error.text),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// A machine still dialling: look again shortly, once.
    fn refresh_soon(&mut self, cx: &mut Context<Self>) {
        if self.polling {
            return;
        }
        self.polling = true;
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(POLL).await;
            this.update(cx, |this, cx| {
                this.polling = false;
                this.refresh(cx);
            })
            .ok();
        })
        .detach();
    }

    /// Resolves once the core has dialled the machine (or failed to).
    pub fn add(&mut self, new: NewMachine, cx: &mut Context<Self>) -> Task<Outcome<MachineEntry>> {
        let task = self.call("adding a machine".into(), cx, move |s| s.add(&new));
        self.then_refresh(task, cx)
    }

    pub fn rename(
        &mut self,
        from: String,
        to: String,
        cx: &mut Context<Self>,
    ) -> Task<Outcome<MachineEntry>> {
        let name = from.clone();
        let task = self.call(format!("renaming {from}"), cx, move |s| {
            s.rename(&name, &to)
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            if let Ok(entry) = &result {
                let to = entry.name.clone();
                this.update(cx, |this, cx| {
                    if this.picked.as_deref() == Some(from.as_str()) {
                        this.picked = Some(to.clone());
                    }
                    cx.emit(MachinesEvent::Renamed { from, to });
                    this.refresh(cx);
                })
                .ok();
            }
            result
        })
    }

    pub fn reconnect(&mut self, name: String, cx: &mut Context<Self>) {
        let target = name.clone();
        let task = self.call(format!("connecting to {name}"), cx, move |s| {
            s.reconnect(&target)
        });
        self.report(task, cx);
    }

    /// Forgets the machine here; its terminals keep running there.
    pub fn remove(&mut self, name: String, cx: &mut Context<Self>) {
        self.confirm_remove = None;
        let target = name.clone();
        let task = self.call(format!("forgetting {name}"), cx, move |s| s.remove(&target));
        cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |this, cx| {
                match result {
                    Ok(()) => {
                        if this.picked.as_deref() == Some(name.as_str()) {
                            this.picked = None;
                        }
                        cx.emit(MachinesEvent::Removed { name });
                    }
                    Err(error) => cx.emit(MachinesEvent::Failed(error.text)),
                }
                this.refresh(cx);
            })
            .ok();
        })
        .detach();
    }

    fn then_refresh<T: 'static>(
        &mut self,
        task: Task<Outcome<T>>,
        cx: &mut Context<Self>,
    ) -> Task<Outcome<T>> {
        cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |this, cx| this.refresh(cx)).ok();
            result
        })
    }

    fn report<T: 'static>(&mut self, task: Task<Outcome<T>>, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |this, cx| {
                if let Err(error) = result {
                    cx.emit(MachinesEvent::Failed(error.text));
                }
                this.refresh(cx);
            })
            .ok();
        })
        .detach();
    }

    pub fn pick(&mut self, machine: Option<String>, cx: &mut Context<Self>) {
        self.picked = machine;
        self.confirm_remove = None;
        cx.notify();
    }
}
