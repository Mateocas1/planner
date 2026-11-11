//! The quick-add chord as a Hyprland bind.
//!
//! Under Wayland the shell cannot grab the chord chosen in Day settings, so the
//! Hyprland snippet (`packaging/linux/hyprland/planner.lua`) binds it instead.
//! The shell keeps the two in step by writing the chosen chord, in Hyprland's
//! key-string form, to a one-line text file the snippet reads on every config
//! load (`$XDG_DATA_HOME/planner/quickadd.bind`), then asking Hyprland to
//! reload. The snippet treats the file as data, never as code, and falls back
//! to the default chord when the file is missing or Hyprland rejects it.
//!
//! The conversion is a strict whitelist: four modifiers and a fixed table of
//! key names. Anything else yields `None` and the file is left as it was, so
//! the output is always `[A-Za-z0-9_]` tokens joined by ` + `.

use std::path::PathBuf;

/// The Hyprland form of the default chord (`ctrl+alt+Space`). The snippet
/// carries the same literal as its fallback.
pub const DEFAULT_BIND: &str = "CTRL + ALT + space";

/// The bind file, relative to the XDG data home.
pub const BIND_FILE: &str = "planner/quickadd.bind";

/// Where the bind file lives: `$XDG_DATA_HOME/planner/quickadd.bind` when
/// `XDG_DATA_HOME` is an absolute path, else `$HOME/.local/share/...`. The
/// snippet resolves the same path the same way. `None` without either.
pub fn bind_file(xdg_data_home: Option<&str>, home: Option<&str>) -> Option<PathBuf> {
    let base = match xdg_data_home.filter(|dir| dir.starts_with('/')) {
        Some(dir) => PathBuf::from(dir),
        None => PathBuf::from(home.filter(|dir| dir.starts_with('/'))?).join(".local/share"),
    };
    Some(base.join(BIND_FILE))
}

/// The bind file's contents for a Hyprland key string: the string and a newline.
pub fn bind_file_contents(bind: &str) -> String {
    format!("{bind}\n")
}

/// Named keys: accepted accelerator spellings (lowercase, `|`-separated) and
/// the xkb keysym Hyprland binds. The snippet whitelists the same keysyms
/// (tested below): Hyprland reports an unknown keysym as a config error
/// instead of raising one the snippet could catch.
const NAMED_KEYS: &[(&str, &str)] = &[
    ("space", "space"),
    ("enter|return", "Return"),
    ("tab", "Tab"),
    ("escape|esc", "Escape"),
    ("backspace", "BackSpace"),
    ("delete", "Delete"),
    ("insert", "Insert"),
    ("home", "Home"),
    ("end", "End"),
    ("pageup", "Page_Up"),
    ("pagedown", "Page_Down"),
    ("arrowup|up", "Up"),
    ("arrowdown|down", "Down"),
    ("arrowleft|left", "Left"),
    ("arrowright|right", "Right"),
    ("comma", "comma"),
    ("period", "period"),
    ("slash", "slash"),
    ("backquote", "grave"),
    ("minus", "minus"),
    ("equal", "equal"),
    ("bracketleft", "bracketleft"),
    ("bracketright", "bracketright"),
    ("semicolon", "semicolon"),
    ("quote", "apostrophe"),
    ("backslash", "backslash"),
    ("numpadadd", "KP_Add"),
    ("numpadsubtract", "KP_Subtract"),
    ("numpadmultiply", "KP_Multiply"),
    ("numpaddivide", "KP_Divide"),
    ("numpaddecimal", "KP_Decimal"),
    ("numpadenter", "KP_Enter"),
];

/// Whether the bind file must be (re)written for `bind`, given its current
/// contents. A missing file already means the default chord to the snippet, so
/// at startup the default does not create it (and does not reload Hyprland).
pub fn bind_needs_write(current: Option<&str>, bind: &str, startup: bool) -> bool {
    match current {
        Some(text) => text != bind_file_contents(bind),
        None => !(startup && bind == DEFAULT_BIND),
    }
}

/// Hyprland's name for an accelerator modifier, or `None` when it is not one.
/// The index fixes the output order.
fn modifier(token: &str) -> Option<(usize, &'static str)> {
    match token.to_ascii_lowercase().as_str() {
        "ctrl" | "control" => Some((0, "CTRL")),
        "alt" | "option" => Some((1, "ALT")),
        "shift" => Some((2, "SHIFT")),
        "meta" | "super" | "cmd" | "command" => Some((3, "SUPER")),
        _ => None,
    }
}

/// The xkb keysym for an accelerator key (DOM `code` vocabulary, as the
/// settings recorder stores it, or the short forms the Rust parser also
/// takes), or `None` when the key is not in the table.
fn key(token: &str) -> Option<String> {
    let lower = token.to_ascii_lowercase();
    let letter_or_digit = |rest: &str, accept: fn(char) -> bool| {
        let mut chars = rest.chars();
        match (chars.next(), chars.next()) {
            (Some(c), None) if accept(c) => Some(c.to_ascii_uppercase().to_string()),
            _ => None,
        }
    };
    if let Some(found) = letter_or_digit(lower.strip_prefix("key").unwrap_or(&lower), |c| c.is_ascii_lowercase()) {
        return Some(found);
    }
    if let Some(found) = letter_or_digit(lower.strip_prefix("digit").unwrap_or(&lower), |c| c.is_ascii_digit()) {
        return Some(found);
    }
    if let Some(number) = lower.strip_prefix('f') {
        if let Ok(n @ 1..=24) = number.parse::<u8>() {
            if !number.starts_with('0') && !number.starts_with('+') {
                return Some(format!("F{n}"));
            }
        }
    }
    if let Some(rest) = lower.strip_prefix("numpad") {
        let mut chars = rest.chars();
        if let (Some(c), None) = (chars.next(), chars.next()) {
            if c.is_ascii_digit() {
                return Some(format!("KP_{c}"));
            }
        }
    }
    NAMED_KEYS
        .iter()
        .find(|(names, _)| names.split('|').any(|name| name == lower))
        .map(|(_, keysym)| keysym.to_string())
}

/// Converts an accelerator (`ctrl+alt+Space`, modifiers first, key last) to a
/// Hyprland key string (`CTRL + ALT + space`). `None` unless it has one to four
/// distinct whitelisted modifiers and a whitelisted key; a bare key would
/// swallow that key system-wide.
pub fn hyprland_bind(accelerator: &str) -> Option<String> {
    let parts: Vec<&str> = accelerator.trim().split('+').map(str::trim).collect();
    let (last, modifiers) = parts.split_last()?;
    if modifiers.is_empty() {
        return None;
    }
    let mut slots: [Option<&str>; 4] = [None; 4];
    for token in modifiers {
        let (index, name) = modifier(token)?;
        if slots[index].replace(name).is_some() {
            return None;
        }
    }
    let key = key(last)?;
    let mut out: Vec<String> = slots.iter().flatten().map(|name| name.to_string()).collect();
    out.push(key);
    Some(out.join(" + "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_chord_matches_the_snippet_fallback() {
        assert_eq!(hyprland_bind("ctrl+alt+Space").as_deref(), Some(DEFAULT_BIND));
        let snippet = include_str!("../../../../packaging/linux/hyprland/planner.lua");
        assert!(snippet.contains(&format!("\"{DEFAULT_BIND}\"")), "snippet fallback drifted");
        assert!(snippet.contains(BIND_FILE), "snippet reads another file");
        for (_, keysym) in NAMED_KEYS {
            assert!(snippet.contains(&format!(" {keysym} = true,")), "snippet does not accept {keysym}");
        }
    }

    #[test]
    fn recorder_accelerators_convert() {
        for (accelerator, bind) in [
            ("ctrl+KeyK", "CTRL + K"),
            ("ctrl+shift+KeyJ", "CTRL + SHIFT + J"),
            ("alt+meta+Digit1", "ALT + SUPER + 1"),
            ("meta+alt+shift+ctrl+F12", "CTRL + ALT + SHIFT + SUPER + F12"),
            ("ctrl+alt+Enter", "CTRL + ALT + Return"),
            ("ctrl+Comma", "CTRL + comma"),
            ("ctrl+Backquote", "CTRL + grave"),
            ("ctrl+Quote", "CTRL + apostrophe"),
            ("shift+alt+BracketLeft", "ALT + SHIFT + bracketleft"),
            ("ctrl+PageDown", "CTRL + Page_Down"),
            ("ctrl+ArrowUp", "CTRL + Up"),
            ("ctrl+Numpad7", "CTRL + KP_7"),
            ("ctrl+NumpadAdd", "CTRL + KP_Add"),
            ("alt+F24", "ALT + F24"),
        ] {
            assert_eq!(hyprland_bind(accelerator).as_deref(), Some(bind), "{accelerator}");
        }
    }

    #[test]
    fn rust_spellings_and_case_are_tolerated() {
        assert_eq!(hyprland_bind(" Ctrl+Alt+Space\n").as_deref(), Some(DEFAULT_BIND));
        assert_eq!(hyprland_bind("CONTROL + option + k").as_deref(), Some("CTRL + ALT + K"));
        assert_eq!(hyprland_bind("super+9").as_deref(), Some("SUPER + 9"));
        assert_eq!(hyprland_bind("command+keyz").as_deref(), Some("SUPER + Z"));
    }

    #[test]
    fn anything_outside_the_whitelist_is_rejected() {
        for accelerator in [
            "",
            "+",
            "Space",
            "KeyK",
            "ctrl+",
            "+KeyK",
            "ctrl++KeyK",
            "ctrl+ctrl+KeyK",
            "ctrl+control+KeyK",
            "hyper+KeyK",
            "cmdorctrl+KeyK",
            "ctrl+KeyKK",
            "ctrl+Key1",
            "ctrl+Digit",
            "ctrl+Digit10",
            "ctrl+F0",
            "ctrl+F25",
            "ctrl+F01",
            "ctrl+F+1",
            "ctrl+Numpad",
            "ctrl+Unidentified",
            "ctrl+alt+exec, rm -rf ~",
            "ctrl+alt+\"); os.execute(\"x\") --",
            "ctrl+alt+space\nhl.exec_cmd('x')",
            "ctrl+alt+ñ",
            "ctrl+alt+K\u{0}",
            "ctrl+Space+alt",
        ] {
            assert_eq!(hyprland_bind(accelerator), None, "{accelerator:?}");
        }
    }

    #[test]
    fn every_bind_is_plain_tokens_joined_by_plus() {
        let keys = ["KeyA", "Digit0", "F7", "Space", "Slash", "Escape", "Numpad0", "NumpadEnter", "ArrowLeft"];
        for key in keys {
            let bind = hyprland_bind(&format!("ctrl+alt+shift+meta+{key}")).expect(key);
            for token in bind.split(" + ") {
                assert!(!token.is_empty() && token.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'), "{bind}");
            }
        }
    }

    #[test]
    fn the_file_is_written_only_when_it_changes() {
        let default = bind_file_contents(DEFAULT_BIND);
        assert!(!bind_needs_write(None, DEFAULT_BIND, true));
        assert!(bind_needs_write(None, DEFAULT_BIND, false));
        assert!(bind_needs_write(None, "CTRL + K", true));
        assert!(!bind_needs_write(Some(&default), DEFAULT_BIND, false));
        assert!(bind_needs_write(Some(&default), "CTRL + K", true));
        assert!(bind_needs_write(Some("CTRL + K\n"), DEFAULT_BIND, true));
        assert!(bind_needs_write(Some(""), DEFAULT_BIND, true));
    }

    #[test]
    fn the_file_lives_under_the_xdg_data_home() {
        assert_eq!(
            bind_file(Some("/x/data"), Some("/home/u")),
            Some(PathBuf::from("/x/data/planner/quickadd.bind"))
        );
        assert_eq!(
            bind_file(None, Some("/home/u")),
            Some(PathBuf::from("/home/u/.local/share/planner/quickadd.bind"))
        );
        // A relative XDG_DATA_HOME is invalid per the spec and ignored.
        assert_eq!(
            bind_file(Some("rel"), Some("/home/u")),
            Some(PathBuf::from("/home/u/.local/share/planner/quickadd.bind"))
        );
        assert_eq!(bind_file(Some(""), None), None);
        assert_eq!(bind_file(None, Some("relative")), None);
        assert_eq!(bind_file_contents(DEFAULT_BIND), "CTRL + ALT + space\n");
    }
}
