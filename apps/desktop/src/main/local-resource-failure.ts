/** 只识别明确的本机存储失败；返回固定码，不让文件路径或报告正文进入任务原因。 */
export function localResourceFailureCode(error: unknown): 'LOCAL_STORAGE_FULL' | null {
  const seen = new Set<Error>();
  let current = error;
  for (let depth = 0; depth < 5 && current instanceof Error && !seen.has(current); depth += 1) {
    seen.add(current);
    const code = (current as NodeJS.ErrnoException).code;
    if (code === 'ENOSPC' || code === 'SQLITE_FULL' || code === 'LOCAL_STORAGE_FULL'
      || /^(?:ENOSPC|SQLITE_FULL|LOCAL_STORAGE_FULL)(?:\b|:)/.test(current.message)
      || /\bno space left on device\b/i.test(current.message)) return 'LOCAL_STORAGE_FULL';
    current = current.cause;
  }
  return null;
}
