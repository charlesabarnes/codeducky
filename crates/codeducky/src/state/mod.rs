pub mod agents;
pub mod checklists;
pub mod cursor;
pub mod editor;
mod lens;
pub mod machines;
pub mod model;
pub mod patch;

pub use agents::{AgentsEvent, AgentsModel};
pub use machines::{MachinesEvent, MachinesModel};
pub use model::{Composer, ModelEvent, NoteAction, Pane, ReviewModel, SidebarTab};
