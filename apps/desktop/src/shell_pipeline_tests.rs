// 真 spawn 子进程的集成测试：不 mock，真的起 shell 跑 echo/pwd/sleep，
// 验证 stdout 捕获、退出码、cwd 生效、以及超时真的杀掉进程（用例整体 ~1s 内返回，不真等 5s）。
use super::*;
use crate::shell::test_support::{host_platform, unique_dir};
use crate::shell::types::ORPHAN_DRAIN_GRACE_MS;
use std::{
    fs, thread,
    time::{Duration, Instant},
};

#[test]
fn echo_captures_stdout_and_exit_code() {
    // 真跑 `echo hello`（zsh / PowerShell 都识别）：stdout 含 hello、退出码 0、未超时。
    let result = run_shell_command_blocking(
        host_platform(),
        "echo hello".to_string(),
        None,
        None,
        None,
        None,
    )
    .expect("worker 层不应报错");
    assert!(
        result.stdout.contains("hello"),
        "stdout 应含 hello，实际: {:?}",
        result.stdout
    );
    assert_eq!(result.exit_code, Some(0), "echo 应以 0 退出");
    assert!(!result.timed_out, "echo 不应超时");
}

#[test]
fn pwd_reflects_requested_cwd() {
    // 真跑 pwd（win: Get-Location）在指定 cwd 下 → stdout 含该目录的物理路径，且结果 cwd 字段回显它。
    let dir = unique_dir();
    let command = if cfg!(target_os = "windows") {
        "Get-Location | ForEach-Object { $_.Path }".to_string()
    } else {
        "pwd".to_string()
    };
    let result = run_shell_command_blocking(
        host_platform(),
        command,
        Some(dir.to_string_lossy().into_owned()),
        None,
        None,
        None,
    )
    .expect("worker 层不应报错");
    assert_eq!(result.exit_code, Some(0), "pwd 应以 0 退出");
    let expected = dir.to_string_lossy();
    assert!(
        result.stdout.contains(expected.as_ref()),
        "stdout 应含 cwd `{expected}`，实际: {:?}",
        result.stdout
    );
    assert_eq!(
        result.cwd.as_str(),
        expected.as_ref(),
        "结果 cwd 应为解析后的目录"
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn sleep_beyond_timeout_is_killed() {
    // 真跑 sleep 5（win: Start-Sleep 5）配 timeout_ms=200：
    // 断言 timed_out==true，且用例整体远早于 5s 返回（证明进程被杀、没有真等满）。
    let command = if cfg!(target_os = "windows") {
        "Start-Sleep -Seconds 5".to_string()
    } else {
        "sleep 5".to_string()
    };
    let started = Instant::now();
    let result =
        run_shell_command_blocking(host_platform(), command, None, Some(200), None, None)
            .expect("worker 层不应报错");
    let elapsed = started.elapsed();
    assert!(result.timed_out, "sleep 应被判定超时");
    assert!(
        elapsed < Duration::from_secs(3),
        "超时应快速返回(杀掉进程)，实际耗时 {:?}",
        elapsed
    );
}

#[cfg(unix)]
#[test]
fn background_process_holding_pipe_does_not_hang_the_call() {
    // 回归用例（对应实测的 96 分钟挂死）：`cmd &` 让孙进程继承 stdout 管道，
    // 父 shell 立刻退出 —— 超时只管直接子进程，所以修复前读线程等不到 EOF、
    // 整个调用一直挂到孤儿自己退出为止（`npm run dev` 这种就是永久）。
    //
    // 两个后台进程各自证明一件事：`sleep 30` 长期握着管道，修复前会把调用拖满
    // 30s（远超下面的 5s 断言）；短命的 touch 则证明进程组真的被杀掉了——
    // 只要它还活着，1s 后 marker 就会出现。
    let dir = unique_dir();
    let marker = dir.join("orphan-survived");
    let command = format!(
        "sleep 30 & (sleep 1 && touch {}) & echo started",
        marker.to_string_lossy()
    );

    let started = Instant::now();
    let result =
        run_shell_command_blocking(host_platform(), command, None, Some(10_000), None, None)
            .expect("worker 层不应报错");
    let elapsed = started.elapsed();

    assert!(
        elapsed < Duration::from_secs(5),
        "后台进程握住管道时调用仍应快速返回，实际耗时 {:?}",
        elapsed
    );
    assert_eq!(result.exit_code, Some(0), "父 shell 应以 0 退出");
    assert!(
        result.stdout.contains("started"),
        "放弃读线程前已捕获的输出不应丢失，实际: {:?}",
        result.stdout
    );
    assert!(
        result.background_processes_killed,
        "应标记后台进程已被清理"
    );
    assert!(!result.timed_out, "父 shell 未超时，不应标记 timed_out");

    // 跨过孤儿的 1s touch 时点再检查：文件不存在才说明进程组真的被杀了。
    thread::sleep(Duration::from_millis(1_500));
    assert!(
        !marker.exists(),
        "孤儿进程应已被杀死，不应还能创建 {}",
        marker.to_string_lossy()
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn normal_command_does_not_report_background_kill() {
    // 反向断言：正常退出、管道正常 EOF 的命令不进 kill 分支，也不该被加上 grace 延迟。
    let started = Instant::now();
    let result = run_shell_command_blocking(
        host_platform(),
        "echo done".to_string(),
        None,
        None,
        None,
        None,
    )
    .expect("worker 层不应报错");
    let elapsed = started.elapsed();

    assert!(
        !result.background_processes_killed,
        "普通命令不应报告清理后台进程"
    );
    assert!(
        elapsed < Duration::from_millis(ORPHAN_DRAIN_GRACE_MS),
        "普通命令不应等满 drain grace，实际耗时 {:?}",
        elapsed
    );
}
