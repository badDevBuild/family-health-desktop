import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveSmokeUserDataDirectory } from './smoke-user-data.js';

describe('发行工件冒烟工作区隔离', () => {
  const temporaryRoot = '/private/tmp';

  it('没有专用参数时保持正常用户目录', () => {
    expect(resolveSmokeUserDataDirectory(['家庭健康看板'], temporaryRoot)).toBeNull();
  });

  it('只接受系统临时目录下固定前缀的直接子目录', () => {
    const target = join(temporaryRoot, 'family-health-app-smoke-arm64-001');
    expect(resolveSmokeUserDataDirectory([
      '家庭健康看板',
      `--family-health-smoke-user-data=${target}`
    ], temporaryRoot)).toBe(target);
  });

  it.each([
    '/Users/example/Library/Application Support/family-health-desktop',
    '/private/tmp/not-family-health',
    '/private/tmp/family-health-app-smoke-parent/child',
    '/private/tmp/family-health-app-smoke-parent/../outside'
  ])('拒绝可能命中真实工作区或越界的路径：%s', (target) => {
    expect(() => resolveSmokeUserDataDirectory([
      `--family-health-smoke-user-data=${target}`
    ], temporaryRoot)).toThrow('SMOKE_USER_DATA_PATH_NOT_ALLOWED');
  });
});
