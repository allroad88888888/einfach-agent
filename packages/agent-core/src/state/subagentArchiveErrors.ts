export function isMissingSubagentArchiveError(error: string): boolean {
  return /does not exist|not found|no such file/i.test(error)
}
