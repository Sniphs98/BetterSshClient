//! Automations screen state: forms, the steps text editor, popups, list view,
//! and the `App` methods that save, delete, and run automations.
//!
//! An automation's steps are edited as plain text (one step per line, e.g.
//! `local: docker save {{tag}} -o image.tar`) rather than through a nested
//! per-step form — see [`parse_steps_text`]. This keeps the editor a single
//! flat popup instead of a popup-within-a-popup stack, consistent with how
//! the rest of the TUI models one active popup at a time.

use std::collections::HashMap;

use super::*;
use omnyssh_core::config::automations::{Automation, AutomationStep, AutomationStepKind};

// ---------------------------------------------------------------------------
// Steps text format — one step per line
// ---------------------------------------------------------------------------
//
//   local: <command>
//   remote: <command>
//   upload: <local path> -> <remote path>
//   download: <remote path> -> <local path>
//
// Blank lines are ignored. Steps created this way always take the default
// timeout (300s) and stop-on-error (false); a user who needs per-step
// overrides can hand-edit automations.toml, same as snippets.toml today.

/// Parses the steps textarea into a step list. Returns a human-readable error
/// naming the offending line on the first failure.
pub(crate) fn parse_steps_text(text: &str) -> Result<Vec<AutomationStep>, String> {
    let mut steps = Vec::new();
    for (i, raw_line) in text.lines().enumerate() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        let line_no = i + 1;
        let (prefix, rest) = line
            .split_once(':')
            .ok_or_else(|| format!("Line {line_no}: expected 'kind: ...', got '{line}'"))?;
        let rest = rest.trim();
        if rest.is_empty() {
            return Err(format!("Line {line_no}: missing content after '{prefix}:'"));
        }

        let step = match prefix.trim().to_lowercase().as_str() {
            "local" => AutomationStep {
                kind: AutomationStepKind::Local,
                command: Some(rest.to_string()),
                local_path: None,
                remote_path: None,
                continue_on_error: false,
                timeout_secs: 300,
            },
            "remote" => AutomationStep {
                kind: AutomationStepKind::Remote,
                command: Some(rest.to_string()),
                local_path: None,
                remote_path: None,
                continue_on_error: false,
                timeout_secs: 300,
            },
            "upload" => {
                let (local, remote) = split_arrow(rest)
                    .ok_or_else(|| format!("Line {line_no}: expected 'local -> remote'"))?;
                AutomationStep {
                    kind: AutomationStepKind::Upload,
                    command: None,
                    local_path: Some(local),
                    remote_path: Some(remote),
                    continue_on_error: false,
                    timeout_secs: 300,
                }
            }
            "download" => {
                let (remote, local) = split_arrow(rest)
                    .ok_or_else(|| format!("Line {line_no}: expected 'remote -> local'"))?;
                AutomationStep {
                    kind: AutomationStepKind::Download,
                    command: None,
                    local_path: Some(local),
                    remote_path: Some(remote),
                    continue_on_error: false,
                    timeout_secs: 300,
                }
            }
            other => {
                return Err(format!(
                    "Line {line_no}: unknown step kind '{other}' (expected local/remote/upload/download)"
                ))
            }
        };
        steps.push(step);
    }
    Ok(steps)
}

fn split_arrow(text: &str) -> Option<(String, String)> {
    let (a, b) = text.split_once("->")?;
    let a = a.trim();
    let b = b.trim();
    if a.is_empty() || b.is_empty() {
        return None;
    }
    Some((a.to_string(), b.to_string()))
}

/// Renders a step list back into editable text — the inverse of
/// [`parse_steps_text`], used to populate the editor when opened on an
/// existing automation.
pub(crate) fn steps_to_text(steps: &[AutomationStep]) -> String {
    steps
        .iter()
        .map(|s| match s.kind {
            AutomationStepKind::Local => format!("local: {}", s.command.as_deref().unwrap_or("")),
            AutomationStepKind::Remote => {
                format!("remote: {}", s.command.as_deref().unwrap_or(""))
            }
            AutomationStepKind::Upload => format!(
                "upload: {} -> {}",
                s.local_path.as_deref().unwrap_or(""),
                s.remote_path.as_deref().unwrap_or("")
            ),
            AutomationStepKind::Download => format!(
                "download: {} -> {}",
                s.remote_path.as_deref().unwrap_or(""),
                s.local_path.as_deref().unwrap_or("")
            ),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// A one-line human description of a step, used in the Results popup.
pub(crate) fn describe_step(step: &AutomationStep) -> String {
    match step.kind {
        AutomationStepKind::Local => format!("Local: {}", step.command.as_deref().unwrap_or("")),
        AutomationStepKind::Remote => format!("Remote: {}", step.command.as_deref().unwrap_or("")),
        AutomationStepKind::Upload => format!(
            "Upload: {} → {}",
            step.local_path.as_deref().unwrap_or(""),
            step.remote_path.as_deref().unwrap_or("")
        ),
        AutomationStepKind::Download => format!(
            "Download: {} → {}",
            step.remote_path.as_deref().unwrap_or(""),
            step.local_path.as_deref().unwrap_or("")
        ),
    }
}

/// Whether a step kind needs a target host to run.
fn step_needs_host(kind: AutomationStepKind) -> bool {
    !matches!(kind, AutomationStepKind::Local)
}

// ---------------------------------------------------------------------------
// Automation add/edit form
// ---------------------------------------------------------------------------

pub const AUTOMATION_FORM_FIELD_LABELS: &[&str] =
    &["Name", "Host (blank = local-only)", "Params (comma-sep)"];

/// The automation add/edit form. `steps` is edited out-of-line via the
/// [`AutomationPopup::StepsEditor`] sub-popup (Ctrl+S), not through `fields`.
#[derive(Debug, Clone)]
pub struct AutomationForm {
    /// Parallel to `AUTOMATION_FORM_FIELD_LABELS`.
    pub fields: Vec<FormField>,
    pub focused_field: usize,
    pub steps: Vec<AutomationStep>,
}

impl AutomationForm {
    pub fn empty() -> Self {
        Self {
            fields: AUTOMATION_FORM_FIELD_LABELS
                .iter()
                .map(|_| FormField::default())
                .collect(),
            focused_field: 0,
            steps: Vec::new(),
        }
    }

    pub fn from_automation(a: &Automation) -> Self {
        let mut form = Self::empty();
        form.fields[0] = FormField::with_value(&a.name);
        form.fields[1] = FormField::with_value(a.host.as_deref().unwrap_or(""));
        form.fields[2] = FormField::with_value(a.params.as_deref().unwrap_or(&[]).join(", "));
        form.steps = a.steps.clone();
        form
    }

    pub fn focus_next(&mut self) {
        self.focused_field = (self.focused_field + 1) % self.fields.len();
    }

    pub fn focus_prev(&mut self) {
        if self.focused_field == 0 {
            self.focused_field = self.fields.len() - 1;
        } else {
            self.focused_field -= 1;
        }
    }

    /// Validates the form and converts it into an [`Automation`].
    ///
    /// # Errors
    /// Returns a human-readable error string if validation fails.
    pub fn to_automation(&self) -> Result<Automation, String> {
        let name = self.fields[0].value.trim().to_string();
        if name.is_empty() {
            return Err("Name cannot be empty".to_string());
        }

        let host_raw = self.fields[1].value.trim();
        let host = if host_raw.is_empty() {
            None
        } else {
            Some(host_raw.to_string())
        };

        if self.steps.is_empty() {
            return Err("Add at least one step (Ctrl+S to edit steps)".to_string());
        }

        if host.is_none() && self.steps.iter().any(|s| step_needs_host(s.kind)) {
            return Err(
                "This automation has a remote/upload/download step — set a Host".to_string(),
            );
        }

        let params: Vec<String> = self.fields[2]
            .value
            .split(',')
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty())
            .collect();

        Ok(Automation {
            name,
            host,
            steps: self.steps.clone(),
            params: if params.is_empty() {
                None
            } else {
                Some(params)
            },
        })
    }
}

// ---------------------------------------------------------------------------
// Popups
// ---------------------------------------------------------------------------

/// One step's live/finished result, shown in execution order in the Results popup.
#[derive(Debug, Clone)]
pub struct AutomationResultEntry {
    pub description: String,
    /// `true` once `AutomationStepStarted` has arrived for this step.
    pub started: bool,
    /// `Ok(output)` / `Err(message)` once finished; `Ok("")` while pending.
    pub output: Result<String, String>,
    pub pending: bool,
}

/// Which popup is currently shown over the Automations screen.
#[derive(Debug)]
pub enum AutomationPopup {
    Add(AutomationForm),
    Edit {
        automation_idx: usize,
        form: AutomationForm,
    },
    DeleteConfirm(usize),
    /// A freeform multi-line editor for `return_to`'s step list (Ctrl+S from
    /// `Add`/`Edit`). Boxes the parent popup so it can be restored verbatim
    /// on cancel, or with `steps` replaced on confirm.
    StepsEditor {
        return_to: Box<AutomationPopup>,
        lines: Vec<String>,
        cursor_line: usize,
        cursor_col: usize,
        error: Option<String>,
    },
    ParamInput {
        automation_idx: usize,
        param_names: Vec<String>,
        param_fields: Vec<FormField>,
        focused_field: usize,
    },
    Results {
        automation_name: String,
        entries: Vec<AutomationResultEntry>,
        scroll: usize,
    },
}

/// UI state specific to the Automations screen.
#[derive(Debug, Default)]
pub struct AutomationsView {
    pub selected: usize,
    pub search_mode: bool,
    pub search_query: String,
    pub filtered_indices: Vec<usize>,
    pub popup: Option<AutomationPopup>,
}

impl AutomationsView {
    pub fn selected_automation_idx(&self) -> Option<usize> {
        self.filtered_indices.get(self.selected).copied()
    }

    pub fn rebuild_filter(&mut self, automations: &[Automation], query: &str) {
        self.filtered_indices = filter_automations(automations, query);
        if self.filtered_indices.is_empty() {
            self.selected = 0;
        } else if self.selected >= self.filtered_indices.len() {
            self.selected = self.filtered_indices.len() - 1;
        }
    }

    pub fn select_next(&mut self) {
        if self.filtered_indices.is_empty() {
            return;
        }
        self.selected = (self.selected + 1).min(self.filtered_indices.len() - 1);
    }

    pub fn select_prev(&mut self) {
        self.selected = self.selected.saturating_sub(1);
    }
}

/// Case-insensitive substring filter over automation name / host / step text.
pub fn filter_automations(automations: &[Automation], query: &str) -> Vec<usize> {
    if query.is_empty() {
        return (0..automations.len()).collect();
    }
    let q = query.to_lowercase();
    automations
        .iter()
        .enumerate()
        .filter(|(_, a)| {
            a.name.to_lowercase().contains(&q)
                || a.host.as_deref().unwrap_or("").to_lowercase().contains(&q)
                || steps_to_text(&a.steps).to_lowercase().contains(&q)
        })
        .map(|(i, _)| i)
        .collect()
}

// ---------------------------------------------------------------------------
// App methods
// ---------------------------------------------------------------------------

impl App {
    /// Checks whether the automation needs param input; if yes, opens the
    /// `ParamInput` popup, otherwise runs it immediately.
    pub(crate) async fn execute_automation(&mut self, automation_idx: usize) {
        let automation = {
            let state = self.state.read().await;
            state.automations.get(automation_idx).cloned()
        };
        let Some(automation) = automation else { return };

        let param_names: Vec<String> = automation.params.as_deref().unwrap_or(&[]).to_vec();
        if !param_names.is_empty() {
            let param_fields = param_names.iter().map(|_| FormField::default()).collect();
            self.view.automations_view.popup = Some(AutomationPopup::ParamInput {
                automation_idx,
                param_names,
                param_fields,
                focused_field: 0,
            });
        } else {
            self.spawn_automation_run(&automation, HashMap::new()).await;
        }
    }

    /// Called when the user confirms the automation `ParamInput` popup.
    pub(crate) async fn handle_confirm_automation_param_input(&mut self) {
        let popup = self.view.automations_view.popup.take();
        match popup {
            Some(AutomationPopup::ParamInput {
                automation_idx,
                param_names,
                param_fields,
                ..
            }) => {
                let params: HashMap<String, String> = param_names
                    .iter()
                    .zip(param_fields.iter())
                    .map(|(name, field)| (name.clone(), field.value.trim().to_string()))
                    .collect();

                let automation = {
                    let state = self.state.read().await;
                    state.automations.get(automation_idx).cloned()
                };
                if let Some(automation) = automation {
                    self.spawn_automation_run(&automation, params).await;
                }
            }
            other => {
                self.view.automations_view.popup = other;
            }
        }
    }

    /// Resolves the target host, opens a `Results` popup pre-populated with
    /// one pending entry per step, and spawns the automation engine.
    async fn spawn_automation_run(
        &mut self,
        automation: &Automation,
        params: HashMap<String, String>,
    ) {
        let host = if let Some(host_name) = &automation.host {
            let state = self.state.read().await;
            match state.hosts.iter().find(|h| &h.name == host_name).cloned() {
                Some(h) => Some(h),
                None => {
                    self.view.automations_view.popup = Some(AutomationPopup::Results {
                        automation_name: automation.name.clone(),
                        entries: vec![AutomationResultEntry {
                            description: "(resolve host)".to_string(),
                            started: true,
                            output: Err(format!("Host '{host_name}' not found.")),
                            pending: false,
                        }],
                        scroll: 0,
                    });
                    return;
                }
            }
        } else {
            None
        };

        let entries: Vec<AutomationResultEntry> = automation
            .steps
            .iter()
            .map(|s| AutomationResultEntry {
                description: describe_step(s),
                started: false,
                output: Ok(String::new()),
                pending: true,
            })
            .collect();
        self.view.automations_view.popup = Some(AutomationPopup::Results {
            automation_name: automation.name.clone(),
            entries,
            scroll: 0,
        });

        let tx = self.core_tx.clone();
        let automation = automation.clone();
        tokio::spawn(async move {
            omnyssh_core::automation::run_automation(automation, host, params, tx).await;
        });
    }

    /// Confirms the automation add/edit form and saves.
    pub(crate) async fn handle_confirm_automation_form(&mut self) {
        match self.view.automations_view.popup.take() {
            Some(AutomationPopup::Add(form)) => match form.to_automation() {
                Ok(automation) => {
                    {
                        let mut state = self.state.write().await;
                        state.automations.push(automation);
                    }
                    self.save_automations().await;
                    let state = self.state.read().await;
                    let q = self.view.automations_view.search_query.clone();
                    self.view
                        .automations_view
                        .rebuild_filter(&state.automations, &q);
                    self.view.status_message = Some("Automation added.".to_string());
                }
                Err(e) => {
                    self.view.automations_view.popup = Some(AutomationPopup::Add(form));
                    self.view.status_message = Some(format!("Error: {e}"));
                }
            },

            Some(AutomationPopup::Edit {
                automation_idx,
                form,
            }) => match form.to_automation() {
                Ok(automation) => {
                    {
                        let mut state = self.state.write().await;
                        if let Some(slot) = state.automations.get_mut(automation_idx) {
                            *slot = automation;
                        }
                    }
                    self.save_automations().await;
                    let state = self.state.read().await;
                    let q = self.view.automations_view.search_query.clone();
                    self.view
                        .automations_view
                        .rebuild_filter(&state.automations, &q);
                    self.view.status_message = Some("Automation updated.".to_string());
                }
                Err(e) => {
                    self.view.automations_view.popup = Some(AutomationPopup::Edit {
                        automation_idx,
                        form,
                    });
                    self.view.status_message = Some(format!("Error: {e}"));
                }
            },

            other => {
                self.view.automations_view.popup = other;
            }
        }
    }

    /// Confirms automation deletion.
    pub(crate) async fn handle_confirm_automation_delete(&mut self) {
        if let Some(AutomationPopup::DeleteConfirm(idx)) = self.view.automations_view.popup.take() {
            {
                let mut state = self.state.write().await;
                if idx < state.automations.len() {
                    let removed = state.automations.remove(idx);
                    self.view.status_message =
                        Some(format!("Deleted automation '{}'.", removed.name));
                }
            }
            self.save_automations().await;
            let state = self.state.read().await;
            let q = self.view.automations_view.search_query.clone();
            self.view
                .automations_view
                .rebuild_filter(&state.automations, &q);
        }
    }

    /// Persists `AppState.automations` to `automations.toml`.
    async fn save_automations(&mut self) {
        let automations = self.state.read().await.automations.clone();
        if let Err(e) = config::automations::save_automations(&automations) {
            self.view.status_message = Some(format!("Save failed: {e}"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- parse_steps_text / steps_to_text -------------------------------

    #[test]
    fn parses_a_local_step() {
        let steps = parse_steps_text("local: echo hi").unwrap();
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].kind, AutomationStepKind::Local);
        assert_eq!(steps[0].command.as_deref(), Some("echo hi"));
    }

    #[test]
    fn parses_a_remote_step() {
        let steps = parse_steps_text("remote: systemctl restart app").unwrap();
        assert_eq!(steps[0].kind, AutomationStepKind::Remote);
        assert_eq!(steps[0].command.as_deref(), Some("systemctl restart app"));
    }

    #[test]
    fn parses_an_upload_step() {
        let steps = parse_steps_text("upload: image.tar -> /srv/deploy/image.tar").unwrap();
        assert_eq!(steps[0].kind, AutomationStepKind::Upload);
        assert_eq!(steps[0].local_path.as_deref(), Some("image.tar"));
        assert_eq!(
            steps[0].remote_path.as_deref(),
            Some("/srv/deploy/image.tar")
        );
    }

    #[test]
    fn parses_a_download_step() {
        let steps = parse_steps_text("download: /var/log/app.log -> ./app.log").unwrap();
        assert_eq!(steps[0].kind, AutomationStepKind::Download);
        assert_eq!(steps[0].remote_path.as_deref(), Some("/var/log/app.log"));
        assert_eq!(steps[0].local_path.as_deref(), Some("./app.log"));
    }

    #[test]
    fn parses_multiple_steps_in_order() {
        let text = "local: docker save x -o x.tar\nupload: x.tar -> /srv/x.tar";
        let steps = parse_steps_text(text).unwrap();
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0].kind, AutomationStepKind::Local);
        assert_eq!(steps[1].kind, AutomationStepKind::Upload);
    }

    #[test]
    fn blank_lines_are_ignored() {
        let steps = parse_steps_text("local: a\n\n\nlocal: b\n").unwrap();
        assert_eq!(steps.len(), 2);
    }

    #[test]
    fn unknown_kind_errs_with_line_number() {
        let err = parse_steps_text("local: a\ndocker: b").unwrap_err();
        assert!(err.contains("Line 2"), "{err}");
        assert!(err.contains("docker"), "{err}");
    }

    #[test]
    fn missing_colon_errs() {
        let err = parse_steps_text("just some text").unwrap_err();
        assert!(err.contains("Line 1"));
    }

    #[test]
    fn upload_without_arrow_errs() {
        let err = parse_steps_text("upload: image.tar").unwrap_err();
        assert!(err.contains("->"));
    }

    #[test]
    fn steps_to_text_round_trips_through_parse() {
        let original = "local: a\nremote: b\nupload: c -> d\ndownload: e -> f";
        let steps = parse_steps_text(original).unwrap();
        let rendered = steps_to_text(&steps);
        let reparsed = parse_steps_text(&rendered).unwrap();
        assert_eq!(reparsed.len(), 4);
        assert_eq!(reparsed[2].local_path.as_deref(), Some("c"));
        assert_eq!(reparsed[2].remote_path.as_deref(), Some("d"));
    }

    // --- describe_step ----------------------------------------------------

    #[test]
    fn describe_step_covers_every_kind() {
        let local = AutomationStep {
            kind: AutomationStepKind::Local,
            command: Some("echo hi".to_string()),
            local_path: None,
            remote_path: None,
            continue_on_error: false,
            timeout_secs: 300,
        };
        assert_eq!(describe_step(&local), "Local: echo hi");

        let upload = AutomationStep {
            kind: AutomationStepKind::Upload,
            command: None,
            local_path: Some("a".to_string()),
            remote_path: Some("b".to_string()),
            continue_on_error: false,
            timeout_secs: 300,
        };
        assert_eq!(describe_step(&upload), "Upload: a → b");
    }

    // --- AutomationForm::to_automation -------------------------------------

    fn form_with(name: &str, host: &str, params: &str, steps_text: &str) -> AutomationForm {
        let mut form = AutomationForm::empty();
        form.fields[0] = FormField::with_value(name);
        form.fields[1] = FormField::with_value(host);
        form.fields[2] = FormField::with_value(params);
        form.steps = parse_steps_text(steps_text).unwrap_or_default();
        form
    }

    #[test]
    fn to_automation_empty_name_errs() {
        assert!(form_with("", "", "", "local: a").to_automation().is_err());
    }

    #[test]
    fn to_automation_no_steps_errs() {
        assert!(form_with("x", "", "", "").to_automation().is_err());
    }

    #[test]
    fn to_automation_remote_step_without_host_errs() {
        let err = form_with("x", "", "", "remote: echo hi")
            .to_automation()
            .unwrap_err();
        assert!(err.contains("Host"), "{err}");
    }

    #[test]
    fn to_automation_local_only_needs_no_host() {
        let automation = form_with("x", "", "", "local: echo hi")
            .to_automation()
            .unwrap();
        assert!(automation.host.is_none());
    }

    #[test]
    fn to_automation_upload_step_requires_host() {
        assert!(form_with("x", "web-1", "", "upload: a -> b")
            .to_automation()
            .is_ok());
        assert!(form_with("x", "", "", "upload: a -> b")
            .to_automation()
            .is_err());
    }

    #[test]
    fn to_automation_params_split_and_trimmed() {
        let automation = form_with("x", "", "a, b ,,", "local: echo {{a}}")
            .to_automation()
            .unwrap();
        assert_eq!(
            automation.params,
            Some(vec!["a".to_string(), "b".to_string()])
        );
    }

    // --- filter_automations -------------------------------------------------

    fn automation(name: &str, host: Option<&str>) -> Automation {
        Automation {
            name: name.to_string(),
            host: host.map(str::to_string),
            steps: vec![AutomationStep {
                kind: AutomationStepKind::Local,
                command: Some("echo hi".to_string()),
                local_path: None,
                remote_path: None,
                continue_on_error: false,
                timeout_secs: 300,
            }],
            params: None,
        }
    }

    #[test]
    fn filter_automations_matches_name() {
        let autos = [automation("deploy", None), automation("backup", None)];
        assert_eq!(filter_automations(&autos, "depl"), vec![0]);
    }

    #[test]
    fn filter_automations_matches_host() {
        let autos = [
            automation("a", Some("web-1")),
            automation("b", Some("db-1")),
        ];
        assert_eq!(filter_automations(&autos, "web"), vec![0]);
    }

    #[test]
    fn filter_automations_empty_query_returns_all() {
        let autos = [automation("a", None), automation("b", None)];
        assert_eq!(filter_automations(&autos, ""), vec![0, 1]);
    }

    // --- AutomationsView navigation -----------------------------------------

    #[test]
    fn automationsview_rebuild_clamps_selection() {
        let autos = [automation("a", None), automation("b", None)];
        let mut view = AutomationsView {
            selected: 5,
            ..Default::default()
        };
        view.rebuild_filter(&autos, "");
        assert_eq!(view.selected, 1);
    }

    // --- run parameter substitution sanity (shared with core) --------------

    #[test]
    fn substitute_params_is_reexported_and_works_for_step_text() {
        use omnyssh_core::config::automations::substitute_params;
        let mut declared = HashMap::new();
        declared.insert("tag".to_string(), "v1".to_string());
        let out = substitute_params("docker save {{tag}}", Some(&["tag".to_string()]), &declared);
        assert_eq!(out, "docker save v1");
    }
}
