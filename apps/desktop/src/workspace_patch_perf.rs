//! 补丁执行的阶段耗时与收尾日志。

use std::time::Instant;

pub(super) const PERF_LOG_TARGET: &str = "web_agent::perf";

pub(super) struct WorkspacePatchPerf {
    operation_id: String,
    started_at: Instant,
    phase_started_at: Instant,
    finished: bool,
}

impl WorkspacePatchPerf {
    pub(super) fn new(
        operation_id: String,
        operation_count: usize,
        dry_run: bool,
        journal_enabled: bool,
    ) -> Self {
        log::info!(
            target: PERF_LOG_TARGET,
            "workspace_patch.start operation_id={} operation_count={} dry_run={} journal_enabled={}",
            operation_id,
            operation_count,
            dry_run,
            journal_enabled,
        );
        let now = Instant::now();
        Self {
            operation_id,
            started_at: now,
            phase_started_at: now,
            finished: false,
        }
    }

    pub(super) fn phase(&mut self, phase: &str) {
        let now = Instant::now();
        log::info!(
            target: PERF_LOG_TARGET,
            "workspace_patch.phase operation_id={} phase={} phase_ms={:.1} total_ms={:.1}",
            self.operation_id,
            phase,
            now.duration_since(self.phase_started_at).as_secs_f64() * 1000.0,
            now.duration_since(self.started_at).as_secs_f64() * 1000.0,
        );
        self.phase_started_at = now;
    }

    pub(super) fn finish(
        &mut self,
        status: &str,
        changed_file_count: usize,
        rejected_count: usize,
    ) {
        self.finished = true;
        log::info!(
            target: PERF_LOG_TARGET,
            "workspace_patch.finish operation_id={} status={} duration_ms={:.1} changed_file_count={} rejected_count={}",
            self.operation_id,
            status,
            self.started_at.elapsed().as_secs_f64() * 1000.0,
            changed_file_count,
            rejected_count,
        );
    }
}

impl Drop for WorkspacePatchPerf {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        log::error!(
            target: PERF_LOG_TARGET,
            "workspace_patch.finish operation_id={} status=error duration_ms={:.1}",
            self.operation_id,
            self.started_at.elapsed().as_secs_f64() * 1000.0,
        );
    }
}
