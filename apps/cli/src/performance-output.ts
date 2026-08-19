import type {
  PerformanceDiagnosticLog,
  PerformanceDiagnosticSink,
} from '@einfach-agent/core/observability'

interface DiagnosticOutput {
  write(text: string): void
}

function formatPerformanceDiagnostic(diagnostic: PerformanceDiagnosticLog): string {
  return `[perf] ${diagnostic.level} ${diagnostic.name} ${JSON.stringify(diagnostic.attrs)}\n`
}

/** Creates the CLI-owned performance output boundary. */
export function createCliPerformanceDiagnosticSink(
  verbose: boolean,
  output: DiagnosticOutput = process.stderr,
): PerformanceDiagnosticSink {
  if (!verbose) return () => {}
  return (diagnostic) => output.write(formatPerformanceDiagnostic(diagnostic))
}
