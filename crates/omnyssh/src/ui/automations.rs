//! Automations screen — list of saved local automations with CRUD and
//! execution, mirroring `ui::snippets` in structure.
//!
//! Layout (schematic):
//!
//! ```text
//! ┌ header (1 line): "Automations (N)"  n:new  e:edit  d:del  Enter:run  /:search
//! ├─ list (rest of area) ─────────────────────────────────────────────────────
//! │  deploy-image      host:web-1   3 steps   {{tag}}
//! │  backup-db          local-only   2 steps
//! └──────────────────────────────────────────────────────────────────────────
//! (popups rendered as overlays via popup::*)
//! ```

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, BorderType, Borders, Paragraph},
    Frame,
};

use crate::app::{
    parse_steps_text, steps_to_text, AppAction, AppState, AutomationForm, AutomationPopup,
    AutomationsView, ViewState,
};
use crate::ui::popup;

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/// Renders the Automations screen.
pub fn render(frame: &mut Frame, area: Rect, state: &AppState, view: &ViewState) {
    if area.width < 40 || area.height < 6 {
        frame.render_widget(
            Paragraph::new("Terminal too small for automations screen.")
                .style(Style::default().fg(view.theme.text_error)),
            area,
        );
        return;
    }

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(1), Constraint::Min(0)])
        .split(area);

    render_header(frame, chunks[0], view);
    render_list(frame, chunks[1], state, view);

    let av = &view.automations_view;
    if let Some(popup_val) = &av.popup {
        match popup_val {
            AutomationPopup::Add(form) => {
                popup::render_automation_form(frame, form, "Add Automation", &view.theme)
            }
            AutomationPopup::Edit { form, .. } => {
                popup::render_automation_form(frame, form, "Edit Automation", &view.theme)
            }
            AutomationPopup::DeleteConfirm(idx) => {
                let name = state
                    .automations
                    .get(*idx)
                    .map(|a| a.name.as_str())
                    .unwrap_or("?");
                popup::render_automation_delete_confirm(frame, name, &view.theme);
            }
            AutomationPopup::StepsEditor {
                lines,
                cursor_line,
                cursor_col,
                error,
                ..
            } => {
                popup::render_automation_steps_editor(
                    frame,
                    lines,
                    *cursor_line,
                    *cursor_col,
                    error.as_deref(),
                    &view.theme,
                );
            }
            AutomationPopup::ParamInput {
                automation_idx,
                param_names,
                param_fields,
                focused_field,
            } => {
                let aname = state
                    .automations
                    .get(*automation_idx)
                    .map(|a| a.name.as_str())
                    .unwrap_or("?");
                popup::render_param_input(
                    frame,
                    aname,
                    param_names,
                    param_fields,
                    *focused_field,
                    &view.theme,
                );
            }
            AutomationPopup::Results { .. } => {
                // Rendered by ui/mod.rs overlay so it appears above every screen.
            }
        }
    }
}

fn render_header(frame: &mut Frame, area: Rect, view: &ViewState) {
    let av = &view.automations_view;
    let count = av.filtered_indices.len();

    let mut spans: Vec<Span> = vec![Span::styled(
        format!(" Automations ({}) ", count),
        Style::default()
            .fg(Color::White)
            .add_modifier(Modifier::BOLD),
    )];

    if av.search_mode {
        spans.push(Span::styled(
            format!("[search: {}] ", av.search_query),
            Style::default().fg(view.theme.accent),
        ));
    } else if !av.search_query.is_empty() {
        spans.push(Span::styled(
            format!("[filter: {}] ", av.search_query),
            Style::default().fg(view.theme.text_warning),
        ));
    }

    spans.push(Span::styled(
        "  n:new  e:edit  d:del  Enter:run  /:search",
        Style::default().fg(view.theme.text_muted),
    ));

    frame.render_widget(Paragraph::new(Line::from(spans)), area);
}

fn render_list(frame: &mut Frame, area: Rect, state: &AppState, view: &ViewState) {
    let av = &view.automations_view;

    let block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(Style::default().fg(view.theme.text_muted));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    if av.filtered_indices.is_empty() {
        let msg = if !av.search_query.is_empty() {
            "  No automations match."
        } else {
            "  No automations. Press  n  to create your first automation."
        };
        frame.render_widget(
            Paragraph::new(Line::from(Span::styled(
                msg,
                Style::default()
                    .fg(Color::DarkGray)
                    .add_modifier(Modifier::ITALIC),
            ))),
            inner,
        );
        return;
    }

    let visible_height = inner.height as usize;
    let selected = av.selected.min(av.filtered_indices.len().saturating_sub(1));
    let offset = if selected >= visible_height {
        selected - visible_height + 1
    } else {
        0
    };

    let rows: Vec<Line> = av
        .filtered_indices
        .iter()
        .enumerate()
        .skip(offset)
        .take(visible_height)
        .map(|(row_idx, &idx)| {
            let a = &state.automations[idx];
            let is_selected = row_idx == selected;

            let (badge_text, badge_color) = match &a.host {
                Some(host) => (format!("host:{host}"), Color::Yellow),
                None => ("local-only".to_string(), Color::Cyan),
            };

            let name_style = if is_selected {
                Style::default()
                    .fg(Color::White)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(view.theme.text_primary)
            };

            let scope_span = Span::styled(
                format!("  [{badge_text}]  "),
                Style::default()
                    .fg(badge_color)
                    .add_modifier(Modifier::BOLD),
            );
            let name_span = Span::styled(format!("{:<28}", a.name), name_style);
            let steps_span = Span::styled(
                format!("  {} step(s)", a.steps.len()),
                Style::default().fg(view.theme.text_muted),
            );
            let params_str = a.params.as_deref().unwrap_or(&[]);
            let params_span = if params_str.is_empty() {
                Span::raw("")
            } else {
                Span::styled(
                    format!(" {{…{}…}}", params_str.join(", ")),
                    Style::default().fg(view.theme.text_warning),
                )
            };

            let mut line = Line::from(vec![scope_span, name_span, steps_span, params_span]);
            if is_selected {
                line = line.style(Style::default().bg(view.theme.selected_bg));
            }
            line
        })
        .collect();

    for (i, row) in rows.into_iter().enumerate() {
        if i >= visible_height {
            break;
        }
        let row_area = Rect {
            x: inner.x,
            y: inner.y + i as u16,
            width: inner.width,
            height: 1,
        };
        frame.render_widget(Paragraph::new(row), row_area);
    }
}

// ---------------------------------------------------------------------------
// Input handling
// ---------------------------------------------------------------------------

/// Handles key events for the Automations screen and all its popups.
pub fn handle_input(key: KeyEvent, view: &mut ViewState) -> Option<AppAction> {
    let av = &mut view.automations_view;

    if av.search_mode {
        return handle_search_input(key, av);
    }

    if av.popup.is_some() {
        return handle_popup_input(key, view);
    }

    handle_normal_input(key, av)
}

fn handle_normal_input(key: KeyEvent, av: &mut AutomationsView) -> Option<AppAction> {
    match key.code {
        KeyCode::Char('j') | KeyCode::Down => {
            av.select_next();
            None
        }
        KeyCode::Char('k') | KeyCode::Up => {
            av.select_prev();
            None
        }
        KeyCode::Char('n') | KeyCode::Char('a') => Some(AppAction::OpenAutomationAdd),
        KeyCode::Char('e') => Some(AppAction::OpenAutomationEdit),
        KeyCode::Char('d') => Some(AppAction::OpenAutomationDeleteConfirm),
        KeyCode::Enter | KeyCode::Char('x') => {
            av.selected_automation_idx()
                .map(|idx| AppAction::ExecuteAutomation {
                    automation_idx: idx,
                })
        }
        KeyCode::Char('/') => {
            av.search_mode = true;
            None
        }
        KeyCode::Esc => {
            if !av.search_query.is_empty() {
                av.search_query.clear();
                Some(AppAction::AutomationSearchChanged)
            } else {
                None
            }
        }
        _ => None,
    }
}

fn handle_search_input(key: KeyEvent, av: &mut AutomationsView) -> Option<AppAction> {
    match key.code {
        KeyCode::Esc => {
            av.search_mode = false;
            av.search_query.clear();
            Some(AppAction::AutomationSearchChanged)
        }
        KeyCode::Enter => {
            av.search_mode = false;
            None
        }
        KeyCode::Backspace => {
            av.search_query.pop();
            Some(AppAction::AutomationSearchChanged)
        }
        KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
            av.search_query.push(c);
            Some(AppAction::AutomationSearchChanged)
        }
        _ => None,
    }
}

fn handle_popup_input(key: KeyEvent, view: &mut ViewState) -> Option<AppAction> {
    // Esc closes form popups before taking a mutable borrow on the popup.
    if key.code == KeyCode::Esc {
        let av = &mut view.automations_view;
        let close = matches!(
            av.popup,
            Some(AutomationPopup::Add(_)) | Some(AutomationPopup::Edit { .. })
        );
        if close {
            av.popup = None;
            return None;
        }
    }

    // The steps editor and the add/edit form need to swap the popup in place
    // (Ctrl+S / Done / cancel), which needs full ownership — handled first.
    if matches!(
        view.automations_view.popup,
        Some(AutomationPopup::StepsEditor { .. })
    ) {
        return handle_steps_editor_key(key, view);
    }
    if key.modifiers.contains(KeyModifiers::CONTROL)
        && key.code == KeyCode::Char('s')
        && matches!(
            view.automations_view.popup,
            Some(AutomationPopup::Add(_)) | Some(AutomationPopup::Edit { .. })
        )
    {
        open_steps_editor(view);
        return None;
    }

    let av = &mut view.automations_view;
    match &mut av.popup {
        Some(AutomationPopup::Add(form)) => {
            handle_form_key(key, form, AppAction::ConfirmAutomationForm)
        }
        Some(AutomationPopup::Edit { form, .. }) => {
            handle_form_key(key, form, AppAction::ConfirmAutomationForm)
        }
        Some(AutomationPopup::DeleteConfirm(_)) => match key.code {
            KeyCode::Char('y') => Some(AppAction::ConfirmAutomationDelete),
            KeyCode::Char('n') | KeyCode::Esc => {
                av.popup = None;
                None
            }
            _ => None,
        },
        Some(AutomationPopup::ParamInput {
            param_fields,
            focused_field,
            ..
        }) => {
            let n = param_fields.len();
            match key.code {
                KeyCode::Enter => Some(AppAction::ConfirmAutomationParamInput),
                KeyCode::Esc => {
                    av.popup = None;
                    None
                }
                KeyCode::Tab => {
                    *focused_field = (*focused_field + 1) % n.max(1);
                    None
                }
                KeyCode::BackTab => {
                    *focused_field = if *focused_field == 0 {
                        n.saturating_sub(1)
                    } else {
                        *focused_field - 1
                    };
                    None
                }
                KeyCode::Backspace => {
                    let f = *focused_field;
                    param_fields[f].backspace();
                    None
                }
                KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                    let f = *focused_field;
                    param_fields[f].insert_char(c);
                    None
                }
                _ => None,
            }
        }
        Some(AutomationPopup::Results { scroll, .. }) => match key.code {
            KeyCode::Char('j') | KeyCode::Down => {
                *scroll = scroll.saturating_add(1);
                None
            }
            KeyCode::Char('k') | KeyCode::Up => {
                *scroll = scroll.saturating_sub(1);
                None
            }
            KeyCode::Esc | KeyCode::Enter | KeyCode::Char('q') => {
                Some(AppAction::DismissAutomationResult)
            }
            _ => None,
        },
        Some(AutomationPopup::StepsEditor { .. }) | None => None,
    }
}

/// Generic form key handler for the 3-field Add/Edit automation form.
/// Ctrl+S (steps editor) is intercepted by the caller before this runs.
fn handle_form_key(
    key: KeyEvent,
    form: &mut AutomationForm,
    confirm_action: AppAction,
) -> Option<AppAction> {
    match key.code {
        KeyCode::Enter => Some(confirm_action),
        KeyCode::Esc => None, // handled before entering this function
        KeyCode::Tab => {
            form.focus_next();
            None
        }
        KeyCode::BackTab => {
            form.focus_prev();
            None
        }
        KeyCode::Backspace => {
            form.fields[form.focused_field].backspace();
            None
        }
        KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
            form.fields[form.focused_field].insert_char(c);
            None
        }
        _ => None,
    }
}

/// Opens the steps editor over the current Add/Edit popup, seeding its text
/// from the form's staged `steps`.
fn open_steps_editor(view: &mut ViewState) {
    let Some(current) = view.automations_view.popup.take() else {
        return;
    };
    let steps = match &current {
        AutomationPopup::Add(form) => &form.steps,
        AutomationPopup::Edit { form, .. } => &form.steps,
        _ => unreachable!("checked by caller"),
    };
    let text = steps_to_text(steps);
    let lines: Vec<String> = if text.is_empty() {
        vec![String::new()]
    } else {
        text.lines().map(str::to_string).collect()
    };
    view.automations_view.popup = Some(AutomationPopup::StepsEditor {
        return_to: Box::new(current),
        lines,
        cursor_line: 0,
        cursor_col: 0,
        error: None,
    });
}

/// Handles keys while the steps editor is open. `Enter` inserts a newline;
/// `Tab` parses and saves; `Esc` discards and returns to the parent form.
fn handle_steps_editor_key(key: KeyEvent, view: &mut ViewState) -> Option<AppAction> {
    let Some(AutomationPopup::StepsEditor {
        lines,
        cursor_line,
        cursor_col,
        error,
        ..
    }) = &mut view.automations_view.popup
    else {
        return None;
    };

    match key.code {
        KeyCode::Esc => {
            let Some(AutomationPopup::StepsEditor { return_to, .. }) =
                view.automations_view.popup.take()
            else {
                unreachable!("checked above")
            };
            view.automations_view.popup = Some(*return_to);
        }
        KeyCode::Tab => {
            let text = lines.join("\n");
            match parse_steps_text(&text) {
                Ok(steps) => {
                    let Some(AutomationPopup::StepsEditor { return_to, .. }) =
                        view.automations_view.popup.take()
                    else {
                        unreachable!("checked above")
                    };
                    let mut restored = *return_to;
                    match &mut restored {
                        AutomationPopup::Add(form) => form.steps = steps,
                        AutomationPopup::Edit { form, .. } => form.steps = steps,
                        _ => {}
                    }
                    view.automations_view.popup = Some(restored);
                }
                Err(e) => {
                    *error = Some(e);
                }
            }
        }
        KeyCode::Enter => {
            let line = lines[*cursor_line].split_off(*cursor_col);
            lines.insert(*cursor_line + 1, line);
            *cursor_line += 1;
            *cursor_col = 0;
            *error = None;
        }
        KeyCode::Backspace => {
            if *cursor_col > 0 {
                let prev = lines[*cursor_line][..*cursor_col]
                    .char_indices()
                    .next_back()
                    .map(|(i, _)| i)
                    .unwrap_or(0);
                lines[*cursor_line].drain(prev..*cursor_col);
                *cursor_col = prev;
            } else if *cursor_line > 0 {
                let current = lines.remove(*cursor_line);
                *cursor_line -= 1;
                *cursor_col = lines[*cursor_line].len();
                lines[*cursor_line].push_str(&current);
            }
            *error = None;
        }
        KeyCode::Up => {
            if *cursor_line > 0 {
                *cursor_line -= 1;
                *cursor_col = (*cursor_col).min(lines[*cursor_line].len());
            }
        }
        KeyCode::Down => {
            if *cursor_line + 1 < lines.len() {
                *cursor_line += 1;
                *cursor_col = (*cursor_col).min(lines[*cursor_line].len());
            }
        }
        KeyCode::Left => {
            if *cursor_col > 0 {
                *cursor_col = lines[*cursor_line][..*cursor_col]
                    .char_indices()
                    .next_back()
                    .map(|(i, _)| i)
                    .unwrap_or(0);
            }
        }
        KeyCode::Right => {
            if *cursor_col < lines[*cursor_line].len() {
                let rest = &lines[*cursor_line][*cursor_col..];
                let step = rest.chars().next().map(char::len_utf8).unwrap_or(1);
                *cursor_col += step;
            }
        }
        KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
            lines[*cursor_line].insert(*cursor_col, c);
            *cursor_col += c.len_utf8();
            *error = None;
        }
        _ => {}
    }
    None
}
