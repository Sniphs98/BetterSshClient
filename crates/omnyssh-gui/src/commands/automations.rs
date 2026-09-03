//! Automation CRUD + execution. CRUD round-trips through the shared
//! `automations.toml` (`load_automations`/`save_automations`); execute resolves the
//! automation and its optional target host, then runs the core's `run_automation`
//! engine on a private channel and emits `automation-step-started` /
//! `automation-step-result` / `automation-finished` events directly — the same
//! "the command owns the result" pattern `execute_snippet` uses, not the shared
//! bridge.

use std::collections::HashMap;

use tauri::{AppHandle, State};
use tauri_specta::Event;
use tokio::sync::mpsc;

use omnyssh_core::config::automations::{load_automations, save_automations, Automation};
use omnyssh_core::event::CoreEvent;
use omnyssh_core::ssh::client::Host;

use crate::dto::AutomationDto;
use crate::error::CommandError;
use crate::events;
use crate::state::GuiState;

/// List saved automations from the shared `automations.toml`.
#[tauri::command]
#[specta::specta]
pub async fn list_automations() -> Result<Vec<AutomationDto>, CommandError> {
    let automations = load().await?;
    Ok(automations.iter().map(AutomationDto::from).collect())
}

/// Upsert an automation by name and persist the whole list. A new name appends; an
/// existing name is replaced in place.
#[tauri::command]
#[specta::specta]
pub async fn save_automation(automation: AutomationDto) -> Result<(), CommandError> {
    persist(move |automations| {
        let incoming: Automation = automation.into();
        match automations.iter_mut().find(|a| a.name == incoming.name) {
            Some(slot) => *slot = incoming,
            None => automations.push(incoming),
        }
    })
    .await
}

/// Delete the automation named `name` and persist. A missing name is a no-op
/// success — the desired end state (absent) already holds.
#[tauri::command]
#[specta::specta]
pub async fn delete_automation(name: String) -> Result<(), CommandError> {
    persist(move |automations| automations.retain(|a| a.name != name)).await
}

/// Run the automation named `automation_name`. Resolves the target host (if the
/// automation declares one) here — secret material stays backend-side — then
/// fires the run in the background. Fire-and-forget: progress and results arrive
/// as `automation-step-started` / `automation-step-result` / `automation-finished`
/// events.
#[tauri::command]
#[specta::specta]
pub async fn execute_automation(
    app: AppHandle,
    state: State<'_, GuiState>,
    automation_name: String,
    params: HashMap<String, String>,
) -> Result<(), CommandError> {
    let automation = load()
        .await?
        .into_iter()
        .find(|a| a.name == automation_name)
        .ok_or_else(|| CommandError {
            message: format!("automation '{automation_name}' not found"),
        })?;

    let host: Option<Host> = match &automation.host {
        Some(host_name) => Some(state.host_by_name(host_name).ok_or_else(|| CommandError {
            message: format!("host '{host_name}' not found"),
        })?),
        None => None,
    };

    tauri::async_runtime::spawn(run_and_forward(app, automation, host, params));
    Ok(())
}

/// Runs the automation to completion, forwarding its `CoreEvent`s as typed Tauri
/// events on a private channel — never the shared engine channel, which the
/// generic bridge doesn't map these variants on (they're this command's alone to
/// report, same as snippet results).
async fn run_and_forward(
    app: AppHandle,
    automation: Automation,
    host: Option<Host>,
    params: HashMap<String, String>,
) {
    let (tx, mut rx) = mpsc::channel::<CoreEvent>(32);
    let forwarder = tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CoreEvent::AutomationStepStarted {
                    automation_name,
                    step_index,
                    total_steps,
                } => {
                    let _ = events::AutomationStepStarted {
                        automation_name,
                        step_index: step_index as u32,
                        total_steps: total_steps as u32,
                    }
                    .emit(&app);
                }
                CoreEvent::AutomationStepDone {
                    automation_name,
                    step_index,
                    ok,
                    output,
                } => {
                    let _ = events::AutomationStepResult {
                        automation_name,
                        step_index: step_index as u32,
                        ok,
                        output,
                    }
                    .emit(&app);
                }
                CoreEvent::AutomationFinished {
                    automation_name,
                    ok,
                } => {
                    let _ = events::AutomationFinished {
                        automation_name,
                        ok,
                    }
                    .emit(&app);
                }
                _ => {}
            }
        }
    });

    omnyssh_core::automation::run_automation(automation, host, params, tx).await;
    let _ = forwarder.await;
}

/// Load the automation list off the async worker (parsing is blocking I/O).
async fn load() -> Result<Vec<Automation>, CommandError> {
    tauri::async_runtime::spawn_blocking(load_automations)
        .await
        .map_err(|e| CommandError {
            message: format!("automation load task failed: {e}"),
        })?
        .map_err(|e| CommandError {
            message: e.to_string(),
        })
}

/// Load the list, apply `mutate`, and write it back atomically off the async worker.
async fn persist(
    mutate: impl FnOnce(&mut Vec<Automation>) + Send + 'static,
) -> Result<(), CommandError> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut automations = load_automations()?;
        mutate(&mut automations);
        save_automations(&automations)
    })
    .await
    .map_err(|e| CommandError {
        message: format!("automation save task failed: {e}"),
    })?
    .map_err(|e| CommandError {
        message: e.to_string(),
    })
}
