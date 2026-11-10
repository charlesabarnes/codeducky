/// Splits a command line into words: spaces separate, quotes group, `\` escapes. No
/// expansion: the core runs the program directly.
pub fn split_command(line: &str) -> Result<Vec<String>, String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut in_word = false;
    let mut quote: Option<char> = None;
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some('"'), '\\') | (None, '\\') => match chars.next() {
                Some(next) => {
                    word.push(next);
                    in_word = true;
                }
                None => return Err("the command ends with a lone \\".into()),
            },
            (Some(_), c) => word.push(c),
            (None, '"' | '\'') => {
                quote = Some(c);
                in_word = true;
            }
            (None, c) if c.is_whitespace() => {
                if in_word {
                    words.push(std::mem::take(&mut word));
                    in_word = false;
                }
            }
            (None, c) => {
                word.push(c);
                in_word = true;
            }
        }
    }
    if quote.is_some() {
        return Err("the command has an unclosed quote".into());
    }
    if in_word {
        words.push(word);
    }
    if words.is_empty() {
        return Err("enter a command".into());
    }
    Ok(words)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_words_quotes_and_escapes() {
        assert_eq!(split_command("claude").unwrap(), ["claude"]);
        assert_eq!(
            split_command(r#"  python3 "/tmp/a b.py"  'x y' c\ d "" "#).unwrap(),
            ["python3", "/tmp/a b.py", "x y", "c d", ""]
        );
        assert!(split_command("  ").is_err());
        assert!(split_command("a 'b").is_err());
    }
}
