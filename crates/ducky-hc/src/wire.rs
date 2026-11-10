//! Framed mode: `[channel u32 LE][kind u8][len u32 LE][payload]`.

use std::io::{self, Read};

pub const HEADER: usize = 9;
pub const MAX_PAYLOAD: usize = 16 << 20;
/// Credit a stream starts with before the client acknowledges anything.
pub const WINDOW: usize = 256 * 1024;
/// The channel JSON-RPC requests, replies and notifications travel on.
pub const CONTROL: u32 = 0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Kind {
    Data = 0,
    Credit = 1,
    Close = 2,
    Resize = 3,
    Focus = 4,
    Facts = 5,
    AutomaticInput = 6,
}

impl Kind {
    pub fn from_u8(byte: u8) -> Option<Self> {
        Some(match byte {
            0 => Self::Data,
            1 => Self::Credit,
            2 => Self::Close,
            3 => Self::Resize,
            4 => Self::Focus,
            5 => Self::Facts,
            6 => Self::AutomaticInput,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub channel: u32,
    /// Raw, so kinds a newer core adds pass through and are skipped.
    pub kind: u8,
    pub payload: Vec<u8>,
}

pub fn encode(channel: u32, kind: Kind, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER + payload.len());
    out.extend_from_slice(&channel.to_le_bytes());
    out.push(kind as u8);
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(payload);
    out
}

/// `Ok(None)` on a clean end of stream between frames.
pub fn read_frame(reader: &mut impl Read) -> io::Result<Option<Frame>> {
    let mut header = [0u8; HEADER];
    match reader.read_exact(&mut header) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let channel = u32::from_le_bytes([header[0], header[1], header[2], header[3]]);
    let len = u32::from_le_bytes([header[5], header[6], header[7], header[8]]) as usize;
    if len > MAX_PAYLOAD {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("frame of {len} bytes exceeds {MAX_PAYLOAD}"),
        ));
    }
    let mut payload = vec![0; len];
    reader.read_exact(&mut payload)?;
    Ok(Some(Frame {
        channel,
        kind: header[4],
        payload,
    }))
}

pub fn size_payload(cols: u16, rows: u16) -> [u8; 4] {
    let [c0, c1] = cols.to_le_bytes();
    let [r0, r1] = rows.to_le_bytes();
    [c0, c1, r0, r1]
}

pub fn parse_size(payload: &[u8]) -> Option<(u16, u16)> {
    match payload {
        [c0, c1, r0, r1] => Some((
            u16::from_le_bytes([*c0, *c1]),
            u16::from_le_bytes([*r0, *r1]),
        )),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_round_trip() {
        let bytes = encode(7, Kind::Resize, &size_payload(120, 40));
        let frame = read_frame(&mut &bytes[..]).unwrap().unwrap();
        assert_eq!(frame.channel, 7);
        assert_eq!(Kind::from_u8(frame.kind), Some(Kind::Resize));
        assert_eq!(parse_size(&frame.payload), Some((120, 40)));
    }

    #[test]
    fn clean_eof_is_none_and_partial_is_error() {
        assert!(read_frame(&mut &[][..]).unwrap().is_none());
        let bytes = encode(1, Kind::Data, b"hello");
        assert!(read_frame(&mut &bytes[..bytes.len() - 1]).is_err());
    }

    #[test]
    fn oversized_frames_are_rejected() {
        let mut header = [0u8; HEADER];
        header[5..9].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(read_frame(&mut &header[..]).is_err());
    }

    #[test]
    fn unknown_kinds_are_none() {
        assert_eq!(Kind::from_u8(42), None);
        assert_eq!(Kind::from_u8(6), Some(Kind::AutomaticInput));
    }
}
