import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { DeepSeekEvalResult } from './runner'

export function defaultDeepSeekResultPath(now = new Date()): string {
  const timestamp = now.toISOString().replaceAll(':', '-')
  return path.resolve('evals/deepseek-agent/results', `${timestamp}.jsonl`)
}

export async function writeDeepSeekResults(
  results: DeepSeekEvalResult[],
  resultPath = defaultDeepSeekResultPath(),
): Promise<string> {
  const absolutePath = path.resolve(resultPath)
  await mkdir(path.dirname(absolutePath), { recursive: true })
  const jsonl = results.map((result) => JSON.stringify(result)).join('\n')
  await writeFile(absolutePath, `${jsonl}\n`, 'utf8')
  return absolutePath
}
