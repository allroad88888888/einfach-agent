/**
 * Public lifecycle boundary for a main-agent model run.
 *
 * The loop implementation is deliberately kept behind this small facade: commands
 * and consumers retain one stable import path while runtime concerns live in their
 * own modules.
 */
export {
  resumeInterruptedSession,
  resumePlanSession,
  runSession,
  runToolLoop,
} from './runToolLoop'
