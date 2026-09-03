use std::collections::{HashMap, HashSet};

use anyhow::Context;
use serde::{Deserialize, Serialize};

use crate::utils::platform;

/// What an [`AutomationStep`] does when it runs.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AutomationStepKind {
    /// Run a shell command on the local machine.
    Local,
    /// Run a shell command on the automation's target host over SSH.
    Remote,
    /// Upload a local file to the target host via SFTP.
    Upload,
    /// Download a file from the target host to local via SFTP.
    Download,
}

/// One step of an [`Automation`], run in order.
///
/// `command` is used by `Local`/`Remote` steps; `local_path`/`remote_path` are
/// used by `Upload`/`Download` steps. Fields are all-optional at the type level
/// because TOML has no natural tagged-union shape here — validity per `kind` is
/// enforced by callers building/running an automation, not by this type.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutomationStep {
    pub kind: AutomationStepKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_path: Option<String>,
    /// When `true`, a failing step does not stop the automation.
    #[serde(default)]
    pub continue_on_error: bool,
    /// Timeout for this step in seconds. Defaults to 300s (local packaging
    /// commands like `docker save` run far longer than the 30s remote-command
    /// budget the engine otherwise uses).
    #[serde(default = "default_step_timeout_secs")]
    pub timeout_secs: u64,
}

fn default_step_timeout_secs() -> u64 {
    300
}

/// A saved local automation stored in `~/.config/omnyssh/automations.toml`.
///
/// An ordered pipeline of [`AutomationStep`]s run sequentially against a single
/// target `host` (required when any step is `Remote`/`Upload`/`Download`;
/// ignored by `Local` steps).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Automation {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    pub steps: Vec<AutomationStep>,
    /// Named placeholder parameters, e.g. `["image_tag"]`, substituted into
    /// every step's `command`/`local_path`/`remote_path`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Vec<String>>,
}

/// Root container that maps to the TOML array-of-tables format.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct AutomationsFile {
    #[serde(default)]
    pub automations: Vec<Automation>,
}

/// Loads automations from `~/.config/omnyssh/automations.toml`.
///
/// Returns an empty `Vec` if the file does not exist yet.
///
/// # Errors
/// Returns an error if the file exists but cannot be read or parsed.
pub fn load_automations() -> anyhow::Result<Vec<Automation>> {
    let path =
        platform::automations_config_path().context("Cannot determine automations config path")?;

    if !path.exists() {
        return Ok(Vec::new());
    }

    let content = std::fs::read_to_string(&path)
        .with_context(|| format!("Failed to read {}", path.display()))?;

    let file: AutomationsFile =
        toml::from_str(&content).with_context(|| format!("Failed to parse {}", path.display()))?;

    Ok(file.automations)
}

/// Persists automations to `~/.config/omnyssh/automations.toml`.
///
/// # Errors
/// Returns an error if the directory cannot be created or the file cannot
/// be written.
pub fn save_automations(automations: &[Automation]) -> anyhow::Result<()> {
    let dir = platform::app_config_dir().context("Cannot determine app config directory")?;

    std::fs::create_dir_all(&dir)
        .with_context(|| format!("Failed to create directory {}", dir.display()))?;

    let path = dir.join("automations.toml");

    let file = AutomationsFile {
        automations: automations.to_vec(),
    };
    let content = toml::to_string_pretty(&file).context("Failed to serialise automations")?;

    // Write to a temp file and rename for atomic replacement (avoids a corrupt
    // automations.toml if the process is interrupted mid-write).
    let tmp_path = path.with_extension("toml.tmp");
    std::fs::write(&tmp_path, &content)
        .with_context(|| format!("Failed to write {}", tmp_path.display()))?;
    if let Err(e) = std::fs::rename(&tmp_path, &path) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(e).with_context(|| {
            format!(
                "Failed to rename {} to {}",
                tmp_path.display(),
                path.display()
            )
        });
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o600);
        let _ = std::fs::set_permissions(&path, perms);
    }

    Ok(())
}

/// Substitutes `{{name}}` placeholders in `text`, but only for names the
/// automation declares and that a value was supplied for. Single-pass by
/// design: an inserted value is never re-scanned, so a value containing
/// `{{other}}` cannot inject a further substitution, and any undeclared
/// `{{token}}` is left byte-for-byte. Shared by every step field
/// (`command`/`local_path`/`remote_path`) so automations get one canonical
/// implementation instead of a third copy of the pattern already duplicated
/// between the TUI and GUI snippet code.
pub fn substitute_params(
    text: &str,
    declared: Option<&[String]>,
    values: &HashMap<String, String>,
) -> String {
    let Some(declared) = declared else {
        return text.to_string();
    };
    let declared: HashSet<&str> = declared.iter().map(String::as_str).collect();

    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find("{{") {
        out.push_str(&rest[..open]);
        let after = &rest[open + 2..];
        match after.find("}}") {
            Some(close) => {
                let name = &after[..close];
                match values.get(name) {
                    Some(value) if declared.contains(name) => out.push_str(value),
                    _ => {
                        out.push_str("{{");
                        out.push_str(name);
                        out.push_str("}}");
                    }
                }
                rest = &after[close + 2..];
            }
            None => {
                out.push_str("{{");
                out.push_str(after);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step_local(cmd: &str) -> AutomationStep {
        AutomationStep {
            kind: AutomationStepKind::Local,
            command: Some(cmd.to_string()),
            local_path: None,
            remote_path: None,
            continue_on_error: false,
            timeout_secs: default_step_timeout_secs(),
        }
    }

    fn step_upload(local: &str, remote: &str) -> AutomationStep {
        AutomationStep {
            kind: AutomationStepKind::Upload,
            command: None,
            local_path: Some(local.to_string()),
            remote_path: Some(remote.to_string()),
            continue_on_error: false,
            timeout_secs: default_step_timeout_secs(),
        }
    }

    fn automation(name: &str, host: Option<&str>, steps: Vec<AutomationStep>) -> Automation {
        Automation {
            name: name.to_string(),
            host: host.map(str::to_string),
            steps,
            params: None,
        }
    }

    // --- load/save round-trip ------------------------------------------------

    #[test]
    fn automations_file_round_trips_through_toml() {
        let original = vec![automation(
            "deploy-image",
            Some("web-1"),
            vec![
                step_local("docker save myimage:latest -o image.tar"),
                step_upload("image.tar", "/srv/deploy/image.tar"),
            ],
        )];
        let toml_str = toml::to_string_pretty(&AutomationsFile {
            automations: original.clone(),
        })
        .unwrap();
        let parsed: AutomationsFile = toml::from_str(&toml_str).unwrap();

        assert_eq!(parsed.automations.len(), 1);
        let a = &parsed.automations[0];
        assert_eq!(a.name, "deploy-image");
        assert_eq!(a.host.as_deref(), Some("web-1"));
        assert_eq!(a.steps.len(), 2);
        assert_eq!(a.steps[0].kind, AutomationStepKind::Local);
        assert_eq!(
            a.steps[0].command.as_deref(),
            Some("docker save myimage:latest -o image.tar")
        );
        assert_eq!(a.steps[1].kind, AutomationStepKind::Upload);
        assert_eq!(a.steps[1].local_path.as_deref(), Some("image.tar"));
        assert_eq!(
            a.steps[1].remote_path.as_deref(),
            Some("/srv/deploy/image.tar")
        );
    }

    #[test]
    fn automations_file_empty_input_parses_to_empty() {
        let parsed: AutomationsFile = toml::from_str("").unwrap();
        assert!(parsed.automations.is_empty());
    }

    #[test]
    fn step_timeout_defaults_when_absent_from_toml() {
        // An automation hand-written (or from an older version) without a
        // `timeout_secs` field must still parse, falling back to the default.
        let toml_str = r#"
            [[automations]]
            name = "x"
            [[automations.steps]]
            kind = "local"
            command = "echo hi"
        "#;
        let parsed: AutomationsFile = toml::from_str(toml_str).unwrap();
        assert_eq!(parsed.automations[0].steps[0].timeout_secs, 300);
        assert!(!parsed.automations[0].steps[0].continue_on_error);
    }

    #[test]
    fn automation_omits_none_optional_fields() {
        let toml_str = toml::to_string_pretty(&AutomationsFile {
            automations: vec![automation("x", None, vec![])],
        })
        .unwrap();
        assert!(!toml_str.contains("host"));
        assert!(!toml_str.contains("params"));
    }

    #[test]
    fn step_kind_uses_lowercase_wire_names() {
        // `toml::to_string` requires a table at the document root, so the
        // bare enum is wrapped for serialisation.
        #[derive(Serialize)]
        struct Wrapper {
            kind: AutomationStepKind,
        }
        for (kind, name) in [
            (AutomationStepKind::Local, "local"),
            (AutomationStepKind::Remote, "remote"),
            (AutomationStepKind::Upload, "upload"),
            (AutomationStepKind::Download, "download"),
        ] {
            let toml_str = toml::to_string(&Wrapper { kind }).unwrap();
            assert_eq!(toml_str.trim(), format!("kind = \"{name}\""));
        }
    }

    // --- substitute_params (shared with the automation engine) ---------------

    fn map(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn substitutes_a_declared_param() {
        let out = substitute_params(
            "docker save {{tag}} -o out.tar",
            Some(&names(&["tag"])),
            &map(&[("tag", "myimage:latest")]),
        );
        assert_eq!(out, "docker save myimage:latest -o out.tar");
    }

    #[test]
    fn none_declared_returns_text_unchanged() {
        let out = substitute_params("echo {{x}}", None, &map(&[("x", "v")]));
        assert_eq!(out, "echo {{x}}");
    }

    #[test]
    fn undeclared_placeholder_is_left_literal_even_with_a_value() {
        let out = substitute_params("run {{x}}", Some(&names(&["y"])), &map(&[("x", "boom")]));
        assert_eq!(out, "run {{x}}");
    }

    #[test]
    fn a_substituted_value_is_not_re_expanded() {
        let out = substitute_params(
            "{{a}}",
            Some(&names(&["a", "b"])),
            &map(&[("a", "{{b}}"), ("b", "SENTINEL")]),
        );
        assert_eq!(out, "{{b}}");
    }

    #[test]
    fn applies_across_command_and_paths_identically() {
        let declared = names(&["tag"]);
        let values = map(&[("tag", "v1")]);
        assert_eq!(
            substitute_params("docker save {{tag}}", Some(&declared), &values),
            "docker save v1"
        );
        assert_eq!(
            substitute_params("/out/{{tag}}.tar", Some(&declared), &values),
            "/out/v1.tar"
        );
    }
}
