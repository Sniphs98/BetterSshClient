//! Local shell command execution.
//!
//! The one general-purpose "run a command on this machine" primitive in the
//! engine. Everything else that executes anything (snippets, quick-execute,
//! service detection) runs exclusively over SSH via [`crate::ssh::session::SshSession`];
//! this module exists for [`crate::automation`] steps that need to act on the
//! local filesystem before or after a transfer — e.g. `docker save` then `zip`
//! before an SFTP upload.

use std::time::Duration;

use anyhow::{anyhow, Context};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time;

/// Runs `cmd` in the platform's shell and returns its combined stdout+stderr
/// and exit code.
///
/// Unlike [`crate::ssh::session::SshSession::run_command`] (stdout-only —
/// remote commands are usually well-behaved unattended scripts), stderr is
/// captured here too: local packaging steps (`docker`, `zip`, ...) commonly
/// report failures there.
///
/// # Errors
/// Returns an error if the shell cannot be spawned, its output cannot be
/// read, or the command runs longer than `timeout`.
pub async fn run_local_command(
    cmd: &str,
    timeout: Duration,
) -> anyhow::Result<(String, Option<i32>)> {
    let mut command = shell_command(cmd);
    command
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null());

    let mut child = command.spawn().context("spawn local command")?;

    let mut stdout = child.stdout.take().context("capture child stdout")?;
    let mut stderr = child.stderr.take().context("capture child stderr")?;

    let output = time::timeout(timeout, async {
        let mut out = Vec::new();
        let mut err = Vec::new();
        // Both streams must be drained concurrently — a child that fills one
        // pipe's OS buffer while we wait on the other would deadlock.
        tokio::try_join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err))
            .context("read local command output")?;
        let status = child.wait().await.context("wait for local command")?;
        anyhow::Ok((out, err, status.code()))
    })
    .await
    .map_err(|_| anyhow!("local command timed out ({}s): {cmd}", timeout.as_secs()))??;

    let (out, err, code) = output;
    let mut combined = String::from_utf8_lossy(&out).into_owned();
    if !err.is_empty() {
        if !combined.is_empty() && !combined.ends_with('\n') {
            combined.push('\n');
        }
        combined.push_str(&String::from_utf8_lossy(&err));
    }

    Ok((combined, code))
}

/// Like [`run_local_command`] but returns an error when the command exits
/// with a non-zero status (or is killed by a signal, on Unix).
///
/// # Errors
/// As [`run_local_command`], plus a non-zero/missing exit status.
pub async fn run_local_command_checked(cmd: &str, timeout: Duration) -> anyhow::Result<String> {
    let (output, code) = run_local_command(cmd, timeout).await?;
    match code {
        Some(0) => Ok(output),
        Some(code) => Err(anyhow!("local command exited with status {code}: {cmd}")),
        None => Err(anyhow!("local command terminated by signal: {cmd}")),
    }
}

/// Builds the platform shell invocation for `cmd`: `cmd /C` on Windows,
/// `sh -c` elsewhere.
fn shell_command(cmd: &str) -> Command {
    if cfg!(windows) {
        let mut command = Command::new("cmd");
        command.arg("/C").arg(cmd);
        command
    } else {
        let mut command = Command::new("sh");
        command.arg("-c").arg(cmd);
        command
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn echo_cmd(text: &str) -> String {
        format!("echo {text}")
    }

    #[tokio::test]
    async fn runs_a_successful_command_and_captures_stdout() {
        let (output, code) = run_local_command(&echo_cmd("hello"), Duration::from_secs(5))
            .await
            .unwrap();
        assert!(output.contains("hello"), "output was: {output:?}");
        assert_eq!(code, Some(0));
    }

    #[tokio::test]
    async fn checked_ok_on_success() {
        let output = run_local_command_checked(&echo_cmd("ok"), Duration::from_secs(5))
            .await
            .unwrap();
        assert!(output.contains("ok"));
    }

    #[tokio::test]
    async fn checked_errs_on_non_zero_exit() {
        let result = run_local_command_checked("exit 3", Duration::from_secs(5)).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn non_zero_exit_is_reported_via_the_code_not_an_error() {
        let cmd = "exit 7";
        let (_, code) = run_local_command(cmd, Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(code, Some(7));
    }

    #[tokio::test]
    async fn times_out_a_long_running_command() {
        let cmd = if cfg!(windows) {
            "ping -n 10 127.0.0.1 > NUL"
        } else {
            "sleep 10"
        };
        let result = run_local_command(cmd, Duration::from_millis(200)).await;
        assert!(result.is_err(), "expected a timeout error");
    }
}
