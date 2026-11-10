//! Host names from ~/.ssh/config, offered as targets when adding a machine.

/// The concrete `Host` names in an ssh config, in order; patterns (`*`, `?`, `!`) are skipped.
pub fn ssh_hosts(config: &str) -> Vec<String> {
    let mut hosts = Vec::new();
    for line in config.lines() {
        let line = line.trim();
        let mut words = line.split_whitespace();
        let Some(keyword) = words.next() else {
            continue;
        };
        if !keyword.eq_ignore_ascii_case("host") {
            continue;
        }
        for name in words {
            if name.starts_with('#') {
                break;
            }
            let pattern = name.contains(['*', '?', '!']);
            if !pattern && !hosts.iter().any(|h| h == name) {
                hosts.push(name.to_owned());
            }
        }
    }
    hosts
}

/// This user's ~/.ssh/config hosts; empty when there is none.
pub fn ssh_config_hosts() -> Vec<String> {
    std::env::var_os("HOME")
        .map(|home| std::path::Path::new(&home).join(".ssh/config"))
        .and_then(|path| std::fs::read_to_string(path).ok())
        .map(|text| ssh_hosts(&text))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_concrete_hosts_only() {
        let config = "Host *\n  User me\nHost vps box # comment\n  HostName 10.0.0.7\n\
                      host web-?? !bad\nMatch host x\nHost vps\n";
        assert_eq!(ssh_hosts(config), ["vps", "box"]);
    }
}
