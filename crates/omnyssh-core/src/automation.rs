//! Local automation engine.
//!
//! An [`Automation`] is an ordered list of steps — run a local command, run a
//! remote command over SSH, or upload/download a file — executed sequentially
//! against a single target host. This is the general-purpose primitive behind
//! flows like "build a Docker image locally, zip it, ship it to a server": each
//! part is an ordinary step, there is nothing Docker-specific here.
//!
//! [`run_automation`] mirrors how snippet execution works
//! (`SshSession::run_command` fired from a `tokio::spawn` task, reporting back
//! over [`CoreEvent`]s) but walks a sequence instead of firing once, and adds
//! the local-command and file-transfer step kinds snippets don't have.

use std::collections::HashMap;
use std::time::Duration;

use tokio::sync::mpsc;

use crate::config::automations::{substitute_params, Automation, AutomationStepKind};
use crate::event::CoreEvent;
use crate::local_exec::run_local_command;
use crate::ssh::client::Host;
use crate::ssh::session::SshSession;
use crate::ssh::sftp::{download_file_once, upload_file_once};

/// Runs every step of `automation` in order against `host`, reporting progress
/// over `event_tx`.
///
/// A step's `command`/`local_path`/`remote_path` have `automation.params`
/// substituted in via [`substitute_params`] before it runs. Execution stops at
/// the first step that fails unless that step's `continue_on_error` is set;
/// `Remote`/`Upload`/`Download` steps fail immediately (as a single
/// `AutomationStepDone`) when `host` is `None`, since there is nothing to act
/// against.
///
/// Intended to be called from inside a `tokio::spawn` (fire-and-forget), the
/// same pattern the TUI/GUI use for snippet execution — this function itself
/// does not spawn.
pub async fn run_automation(
    automation: Automation,
    host: Option<Host>,
    params: HashMap<String, String>,
    event_tx: mpsc::Sender<CoreEvent>,
) {
    let total_steps = automation.steps.len();
    let mut overall_ok = true;

    for (index, step) in automation.steps.iter().enumerate() {
        let _ = event_tx
            .send(CoreEvent::AutomationStepStarted {
                automation_name: automation.name.clone(),
                step_index: index,
                total_steps,
            })
            .await;

        let timeout = Duration::from_secs(step.timeout_secs);
        let declared = automation.params.as_deref();
        let result = match step.kind {
            AutomationStepKind::Local => {
                let cmd = step.command.as_deref().unwrap_or_default();
                let cmd = substitute_params(cmd, declared, &params);
                match run_local_command(&cmd, timeout).await {
                    Ok((output, Some(0))) | Ok((output, None)) => Ok(output),
                    // A non-zero exit is a failed step, but the captured
                    // output (often on stderr) is kept for the results view.
                    Ok((output, Some(code))) => Err(format!("{output}\n(exit code {code})")),
                    Err(e) => Err(e.to_string()),
                }
            }
            AutomationStepKind::Remote => match &host {
                Some(host) => {
                    let cmd = step.command.as_deref().unwrap_or_default();
                    let cmd = substitute_params(cmd, declared, &params);
                    run_remote_command(host, &cmd).await
                }
                None => Err("automation has no target host for a remote step".to_string()),
            },
            AutomationStepKind::Upload => match &host {
                Some(host) => {
                    let local = substitute_params(
                        step.local_path.as_deref().unwrap_or_default(),
                        declared,
                        &params,
                    );
                    let remote = substitute_params(
                        step.remote_path.as_deref().unwrap_or_default(),
                        declared,
                        &params,
                    );
                    upload_file_once(host, &local, &remote)
                        .await
                        .map(|()| format!("Uploaded {local} -> {remote}"))
                        .map_err(|e| e.to_string())
                }
                None => Err("automation has no target host for an upload step".to_string()),
            },
            AutomationStepKind::Download => match &host {
                Some(host) => {
                    let remote = substitute_params(
                        step.remote_path.as_deref().unwrap_or_default(),
                        declared,
                        &params,
                    );
                    let local = substitute_params(
                        step.local_path.as_deref().unwrap_or_default(),
                        declared,
                        &params,
                    );
                    download_file_once(host, &remote, &local)
                        .await
                        .map(|()| format!("Downloaded {remote} -> {local}"))
                        .map_err(|e| e.to_string())
                }
                None => Err("automation has no target host for a download step".to_string()),
            },
        };

        let ok = result.is_ok();
        let output = match result {
            Ok(output) => output,
            Err(message) => message,
        };

        let _ = event_tx
            .send(CoreEvent::AutomationStepDone {
                automation_name: automation.name.clone(),
                step_index: index,
                ok,
                output,
            })
            .await;

        if !ok {
            overall_ok = false;
            if !step.continue_on_error {
                break;
            }
        }
    }

    let _ = event_tx
        .send(CoreEvent::AutomationFinished {
            automation_name: automation.name.clone(),
            ok: overall_ok,
        })
        .await;
}

/// Opens a fresh SSH connection, runs `command`, disconnects, and returns
/// stdout or a human-readable error — mirrors the snippet execution helpers in
/// the TUI/GUI, kept here so the automation engine doesn't depend on either
/// frontend.
async fn run_remote_command(host: &Host, command: &str) -> Result<String, String> {
    let session = SshSession::connect(host)
        .await
        .map_err(|e| format!("Connect failed: {e}"))?;
    let output = session
        .run_command(command)
        .await
        .map_err(|e| format!("Command failed: {e}"));
    session.disconnect().await;
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::automations::AutomationStep;

    fn step(kind: AutomationStepKind, command: Option<&str>) -> AutomationStep {
        AutomationStep {
            kind,
            command: command.map(str::to_string),
            local_path: None,
            remote_path: None,
            continue_on_error: false,
            timeout_secs: 5,
        }
    }

    fn automation(steps: Vec<AutomationStep>) -> Automation {
        Automation {
            name: "test".to_string(),
            host: None,
            steps,
            params: None,
        }
    }

    async fn collect_events(rx: &mut mpsc::Receiver<CoreEvent>) -> Vec<CoreEvent> {
        let mut events = Vec::new();
        while let Ok(event) = rx.try_recv() {
            events.push(event);
        }
        events
    }

    #[tokio::test]
    async fn runs_local_steps_in_order_and_reports_success() {
        let echo = if cfg!(windows) { "echo a" } else { "echo a" };
        let a = automation(vec![
            step(AutomationStepKind::Local, Some(echo)),
            step(AutomationStepKind::Local, Some(echo)),
        ]);
        let (tx, mut rx) = mpsc::channel(32);
        run_automation(a, None, HashMap::new(), tx).await;

        let events = collect_events(&mut rx).await;
        let started: Vec<_> = events
            .iter()
            .filter(|e| matches!(e, CoreEvent::AutomationStepStarted { .. }))
            .collect();
        let done: Vec<_> = events
            .iter()
            .filter(|e| matches!(e, CoreEvent::AutomationStepDone { .. }))
            .collect();
        assert_eq!(started.len(), 2);
        assert_eq!(done.len(), 2);
        for e in &done {
            if let CoreEvent::AutomationStepDone { ok, .. } = e {
                assert!(ok);
            }
        }
        match events.last() {
            Some(CoreEvent::AutomationFinished { ok, .. }) => assert!(ok),
            other => panic!("expected AutomationFinished last, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn stops_after_a_failing_step_by_default() {
        let fail_cmd = "exit 1";
        let echo = "echo unreachable";
        let a = automation(vec![
            step(AutomationStepKind::Local, Some(fail_cmd)),
            step(AutomationStepKind::Local, Some(echo)),
        ]);
        let (tx, mut rx) = mpsc::channel(32);
        run_automation(a, None, HashMap::new(), tx).await;

        let events = collect_events(&mut rx).await;
        let done: Vec<_> = events
            .iter()
            .filter(|e| matches!(e, CoreEvent::AutomationStepDone { .. }))
            .collect();
        // Only the failing first step runs — the second is never reached.
        assert_eq!(done.len(), 1);
        match events.last() {
            Some(CoreEvent::AutomationFinished { ok, .. }) => assert!(!ok),
            other => panic!("expected AutomationFinished last, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn continue_on_error_runs_every_step() {
        let mut failing = step(AutomationStepKind::Local, Some("exit 1"));
        failing.continue_on_error = true;
        let succeeding = step(AutomationStepKind::Local, Some("echo done"));
        let a = automation(vec![failing, succeeding]);

        let (tx, mut rx) = mpsc::channel(32);
        run_automation(a, None, HashMap::new(), tx).await;

        let events = collect_events(&mut rx).await;
        let done: Vec<_> = events
            .iter()
            .filter(|e| matches!(e, CoreEvent::AutomationStepDone { .. }))
            .collect();
        assert_eq!(done.len(), 2);
        match events.last() {
            // Overall run is still reported as failed even though it ran to completion.
            Some(CoreEvent::AutomationFinished { ok, .. }) => assert!(!ok),
            other => panic!("expected AutomationFinished last, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn remote_step_without_a_host_fails_immediately() {
        let a = automation(vec![step(AutomationStepKind::Remote, Some("echo hi"))]);
        let (tx, mut rx) = mpsc::channel(32);
        run_automation(a, None, HashMap::new(), tx).await;

        let events = collect_events(&mut rx).await;
        match events
            .iter()
            .find(|e| matches!(e, CoreEvent::AutomationStepDone { .. }))
        {
            Some(CoreEvent::AutomationStepDone { ok, output, .. }) => {
                assert!(!ok);
                assert!(output.contains("no target host"));
            }
            other => panic!("expected AutomationStepDone, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn substitutes_params_into_local_commands() {
        let a = Automation {
            name: "test".to_string(),
            host: None,
            steps: vec![step(AutomationStepKind::Local, Some("echo {{word}}"))],
            params: Some(vec!["word".to_string()]),
        };
        let mut params = HashMap::new();
        params.insert("word".to_string(), "substituted".to_string());

        let (tx, mut rx) = mpsc::channel(32);
        run_automation(a, None, params, tx).await;

        let events = collect_events(&mut rx).await;
        match events
            .iter()
            .find(|e| matches!(e, CoreEvent::AutomationStepDone { .. }))
        {
            Some(CoreEvent::AutomationStepDone { output, .. }) => {
                assert!(output.contains("substituted"), "output was: {output:?}");
            }
            other => panic!("expected AutomationStepDone, got {other:?}"),
        }
    }
}
