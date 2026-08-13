//! 单次写入的分阶段耗时日志。

use super::result::WorkspaceWriteResult;
use std::time::Instant;

pub(super) const PERF_LOG_TARGET: &str = "web_agent::perf";

pub(super) struct WorkspaceWritePerf {
    operation_id: String,
    started_at: Instant,
    phase_started_at: Instant,
}

impl WorkspaceWritePerf {
    pub(super) fn new(
        operation_id: String,
        content_bytes: usize,
        mode: Option<&str>,
        exclusive_path_lock: bool,
        journal_enabled: bool,
    ) -> Self {
        log::info!(
            target: PERF_LOG_TARGET,
            "workspace_write.start operation_id={} content_bytes={} mode={} exclusive_path_lock={} journal_enabled={}",
            operation_id,
            content_bytes,
            mode.unwrap_or("overwrite"),
            exclusive_path_lock,
            journal_enabled,
        );
        let now = Instant::now();
        Self {
            operation_id,
            started_at: now,
            phase_started_at: now,
        }
    }

    pub(super) fn phase(&mut self, phase: &str) {
        let now = Instant::now();
        log::info!(
            target: PERF_LOG_TARGET,
            "workspace_write.phase operation_id={} phase={} phase_ms={:.1} total_ms={:.1}",
            self.operation_id,
            phase,
            now.duration_since(self.phase_started_at).as_secs_f64() * 1000.0,
            now.duration_since(self.started_at).as_secs_f64() * 1000.0,
        );
        self.phase_started_at = now;
    }

    pub(super) fn finish(&self, result: &Result<WorkspaceWriteResult, String>) {
        let duration_ms = self.started_at.elapsed().as_secs_f64() * 1000.0;
        match result {
            Ok(value) => log::info!(
                target: PERF_LOG_TARGET,
                "workspace_write.finish operation_id={} status=ok duration_ms={:.1} bytes_written={} created={} overwritten={} appended={}",
                self.operation_id,
                duration_ms,
                value.bytes_written,
                value.created,
                value.overwritten,
                value.appended,
            ),
            Err(error) => log::error!(
                target: PERF_LOG_TARGET,
                "workspace_write.finish operation_id={} status=error duration_ms={:.1} reason={:?}",
                self.operation_id,
                duration_ms,
                error,
            ),
        }
    }
}
