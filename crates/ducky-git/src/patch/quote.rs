//! Git's C-style path quoting: `"a/tab\there"`, octal escapes for bytes it will not print raw.

/// The bytes of a quoted path and the rest of the input after its closing quote, or `None`
/// when `input` does not start with a well-formed quoted string.
pub fn unquote(input: &[u8]) -> Option<(Vec<u8>, &[u8])> {
    let mut rest = input.strip_prefix(b"\"")?;
    let mut out = Vec::new();
    loop {
        let (&byte, tail) = rest.split_first()?;
        rest = tail;
        match byte {
            b'"' => return Some((out, rest)),
            b'\\' => {
                let (&escape, tail) = rest.split_first()?;
                rest = tail;
                out.push(match escape {
                    b'a' => 0x07,
                    b'b' => 0x08,
                    b'f' => 0x0c,
                    b'n' => b'\n',
                    b'r' => b'\r',
                    b't' => b'\t',
                    b'v' => 0x0b,
                    b'0'..=b'3' => {
                        let digits = [escape, *rest.first()?, *rest.get(1)?];
                        rest = &rest[2..];
                        let value = digits.iter().try_fold(0u16, |acc, d| {
                            (b'0'..=b'7')
                                .contains(d)
                                .then(|| acc * 8 + u16::from(d - b'0'))
                        })?;
                        u8::try_from(value).ok()?
                    }
                    other => other,
                });
            }
            other => out.push(other),
        }
    }
}

/// A path as git prints it in a header: quoted or raw, then lossily decoded.
pub fn path(input: &[u8]) -> String {
    match unquote(input) {
        Some((bytes, _)) => String::from_utf8_lossy(&bytes).into_owned(),
        None => String::from_utf8_lossy(input).into_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unquotes_escapes_and_octal_utf8() {
        let cases: &[(&[u8], &str, &[u8])] = &[
            (br#""a/tab\there" rest"#, "a/tab\there", b" rest"),
            (br#""q\"uote\\back""#, "q\"uote\\back", b""),
            (br#""n\303\244me""#, "näme", b""),
            (br#""line\nbreak""#, "line\nbreak", b""),
        ];
        for (input, expected, rest) in cases {
            let (bytes, tail) = unquote(input).unwrap();
            assert_eq!(String::from_utf8(bytes).unwrap(), *expected);
            assert_eq!(tail, *rest);
        }
    }

    #[test]
    fn rejects_malformed_and_passes_raw_paths() {
        assert!(unquote(b"plain").is_none());
        assert!(unquote(br#""unterminated"#).is_none());
        assert!(unquote(br#""bad\3x7""#).is_none());
        assert_eq!(path(b"plain name"), "plain name");
        assert_eq!(path(br#""x\ty""#), "x\ty");
    }
}
