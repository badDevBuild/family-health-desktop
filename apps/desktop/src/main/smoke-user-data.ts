import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

const SMOKE_ARGUMENT_PREFIX = '--family-health-smoke-user-data=';
const SMOKE_DIRECTORY_PREFIX = 'family-health-app-smoke-';

/**
 * 仅供发行工件冒烟测试使用。测试目录必须是系统临时目录下的直接子目录，
 * 防止命令行参数把应用数据写入真实工作区或其他任意路径。
 */
export function resolveSmokeUserDataDirectory(args: readonly string[], temporaryRoot: string): string | null {
  const rawArgument = args.find((argument) => argument.startsWith(SMOKE_ARGUMENT_PREFIX));
  if (!rawArgument) return null;

  const rawPath = rawArgument.slice(SMOKE_ARGUMENT_PREFIX.length);
  if (!rawPath) throw new Error('SMOKE_USER_DATA_PATH_REQUIRED');

  const root = resolve(temporaryRoot);
  const candidate = resolve(rawPath);
  const candidateRelativePath = relative(root, candidate);
  const isDirectChild = candidateRelativePath.length > 0
    && !candidateRelativePath.startsWith(`..${sep}`)
    && candidateRelativePath !== '..'
    && !isAbsolute(candidateRelativePath)
    && !candidateRelativePath.includes(sep);

  if (!isDirectChild || !basename(candidate).startsWith(SMOKE_DIRECTORY_PREFIX)) {
    throw new Error('SMOKE_USER_DATA_PATH_NOT_ALLOWED');
  }
  return candidate;
}
