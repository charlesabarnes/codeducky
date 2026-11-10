use ducky_host::{Host, HostError};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::error::NotesError;

/// The file format version this build writes and reads.
pub const VERSION: u64 = 1;

/// A JSON file of ours. Parsing is lenient where it can be and names the problem where it cannot.
/// Serialized as a struct, so keys come out in declaration order, unknown ones last.
pub trait Document: Serialize + Sized {
    fn parse(root: Map<String, Value>, path: &str) -> Result<Self, NotesError>;
}

/// Pretty-printed with a trailing newline.
pub fn render(document: &impl Document) -> Vec<u8> {
    let mut bytes = serde_json::to_vec_pretty(document).expect("our documents serialize");
    bytes.push(b'\n');
    bytes
}

/// The file's bytes, or `None` when it does not exist yet.
pub fn read_bytes(host: &dyn Host, path: &str) -> Result<Option<Vec<u8>>, NotesError> {
    match host.read_file(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(HostError::NotFound(_)) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub fn parse<D: Document>(bytes: &[u8], path: &str) -> Result<D, NotesError> {
    let value: Value =
        serde_json::from_slice(bytes).map_err(|error| NotesError::malformed(path, error))?;
    let Value::Object(root) = value else {
        return Err(NotesError::malformed(
            path,
            "expected a JSON object at the top",
        ));
    };
    match root.get("version") {
        None => {}
        Some(Value::Number(n)) if n.as_u64().is_some_and(|v| v <= VERSION) => {}
        Some(Value::Number(n)) if n.as_u64().is_some() => {
            return Err(NotesError::NewerVersion {
                path: path.to_owned(),
                found: n.as_u64().unwrap_or_default(),
                supported: VERSION,
            });
        }
        Some(other) => {
            return Err(NotesError::malformed(
                path,
                format!("`version` should be 1, not {other}"),
            ));
        }
    }
    D::parse(root, path)
}

pub fn load<D: Document>(
    host: &dyn Host,
    path: &str,
    empty: impl FnOnce() -> D,
) -> Result<D, NotesError> {
    match read_bytes(host, path)? {
        Some(bytes) => parse(&bytes, path),
        None => Ok(empty()),
    }
}

const ATTEMPTS: usize = 4;

/// Read, change, write: re-reads the file right before writing and starts over if someone else
/// (an agent) changed it meanwhile, so their edit is merged rather than lost. A file that does
/// not parse is never written. Returns `change`'s result and whether the file was written.
pub fn update<D: Document, R>(
    host: &dyn Host,
    path: &str,
    empty: impl Fn() -> D,
    mut change: impl FnMut(&mut D) -> Result<R, NotesError>,
) -> Result<(R, bool), NotesError> {
    for _ in 0..ATTEMPTS {
        let before = read_bytes(host, path)?;
        let mut document = match &before {
            Some(bytes) => parse(bytes, path)?,
            None => empty(),
        };
        let result = change(&mut document)?;
        let after = render(&document);
        if before.as_deref() == Some(after.as_slice()) {
            return Ok((result, false));
        }
        if read_bytes(host, path)? != before {
            continue;
        }
        host.write_file(path, &after)?;
        return Ok((result, true));
    }
    Err(NotesError::Contended {
        path: path.to_owned(),
    })
}

/// Takes a typed field out of the root object, naming the field when it is the wrong shape.
pub fn take<T: serde::de::DeserializeOwned + Default>(
    root: &mut Map<String, Value>,
    key: &str,
    path: &str,
) -> Result<T, NotesError> {
    match root.remove(key) {
        None | Some(Value::Null) => Ok(T::default()),
        Some(value) => serde_json::from_value(value)
            .map_err(|error| NotesError::malformed(path, format!("`{key}`: {error}"))),
    }
}
