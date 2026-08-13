//! 子进程 stdout/stderr 的后台读取：读满上限即截断，读线程与调用线程共享捕获缓冲。

use super::types::{CapturedOutput, OutputSink};
use std::{
    io::{self, Read},
    sync::{Arc, MutexGuard},
    thread,
};

pub(super) fn spawn_output_reader<R: Read + Send + 'static>(
    reader: R,
    max_chars: usize,
    sink: &OutputSink,
) -> thread::JoinHandle<io::Result<()>> {
    let sink = Arc::clone(sink);
    thread::spawn(move || read_capped_into(reader, max_chars, &sink))
}

fn read_capped_into<R: Read>(mut reader: R, max_chars: usize, sink: &OutputSink) -> io::Result<()> {
    let mut buffer = [0u8; 8192];

    loop {
        let bytes_read = reader.read(&mut buffer)?;
        if bytes_read == 0 {
            return Ok(());
        }

        let chunk = String::from_utf8_lossy(&buffer[..bytes_read]);
        let chunk_chars = chunk.chars().count();
        let mut captured = lock_sink(sink);

        if captured.chars_written < max_chars {
            let remaining = max_chars - captured.chars_written;
            if chunk_chars <= remaining {
                captured.text.push_str(&chunk);
                captured.chars_written += chunk_chars;
            } else {
                captured.text.extend(chunk.chars().take(remaining));
                captured.chars_written = max_chars;
                captured.truncated = true;
            }
        } else {
            captured.truncated = true;
        }
    }
}

// 读线程 panic 会毒化锁，但缓冲里已捕获的内容仍然有效，照常取用。
fn lock_sink(sink: &OutputSink) -> MutexGuard<'_, CapturedOutput> {
    sink.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(super) fn take_captured(sink: &OutputSink) -> CapturedOutput {
    let mut captured = lock_sink(sink);
    CapturedOutput {
        text: std::mem::take(&mut captured.text),
        chars_written: captured.chars_written,
        truncated: captured.truncated,
    }
}
