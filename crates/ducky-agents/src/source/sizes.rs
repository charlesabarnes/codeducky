//! Telling our own resizes apart from another viewer's in the terminal's `size` events.
//!
//! Every size change, ours included, comes back as a `size` event on a separate channel, so an
//! echo of a size we set earlier can arrive after we have moved on. Those echoes are dropped;
//! the echo of our latest size and any size we never set pass through.

const REMEMBERED: usize = 6;

#[derive(Debug, Default)]
pub struct OwnSizes {
    sent: Vec<(u16, u16)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SizeEcho {
    /// The size we set last: the program runs at our grid again.
    Ours,
    /// An older size of ours, overtaken since.
    Stale,
    /// Another viewer took over the size.
    Foreign,
}

impl OwnSizes {
    pub fn sent(&mut self, cols: u16, rows: u16) {
        self.sent.retain(|size| *size != (cols, rows));
        self.sent.push((cols, rows));
        if self.sent.len() > REMEMBERED {
            self.sent.remove(0);
        }
    }

    pub fn classify(&self, cols: u16, rows: u16) -> SizeEcho {
        match self.sent.iter().rposition(|size| *size == (cols, rows)) {
            Some(at) if at + 1 == self.sent.len() => SizeEcho::Ours,
            Some(_) => SizeEcho::Stale,
            None => SizeEcho::Foreign,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn echoes_of_older_sizes_are_stale_and_unknown_sizes_foreign() {
        let mut sizes = OwnSizes::default();
        sizes.sent(80, 24);
        sizes.sent(100, 30);
        assert_eq!(sizes.classify(80, 24), SizeEcho::Stale);
        assert_eq!(sizes.classify(100, 30), SizeEcho::Ours);
        assert_eq!(sizes.classify(120, 40), SizeEcho::Foreign);

        sizes.sent(80, 24);
        assert_eq!(sizes.classify(80, 24), SizeEcho::Ours);
        assert_eq!(sizes.classify(100, 30), SizeEcho::Stale);
    }

    #[test]
    fn only_recent_sizes_are_remembered() {
        let mut sizes = OwnSizes::default();
        for cols in 1..=10 {
            sizes.sent(cols, 24);
        }
        assert_eq!(sizes.classify(1, 24), SizeEcho::Foreign);
        assert_eq!(sizes.classify(9, 24), SizeEcho::Stale);
    }
}
