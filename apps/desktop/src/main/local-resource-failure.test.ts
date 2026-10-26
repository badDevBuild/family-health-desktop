import { describe, expect, it } from 'vitest';
import { localResourceFailureCode } from './local-resource-failure.js';

describe('本机存储失败固定分类', () => {
  it.each(['ENOSPC', 'SQLITE_FULL', 'LOCAL_STORAGE_FULL'])('识别结构化 %s，丢弃原错误详情', (code) => {
    const error = Object.assign(new Error('合成私密正文与路径'), { code });
    expect(localResourceFailureCode(error)).toBe('LOCAL_STORAGE_FULL');
  });

  it.each(['ENOSPC: write failed', 'SQLITE_FULL: database or disk is full', 'no space left on device'])('兼容明确底层存储错误 %s', (message) => {
    expect(localResourceFailureCode(new Error(message))).toBe('LOCAL_STORAGE_FULL');
  });

  it('只沿有限 cause 查找，不扫描任意嵌套数据', () => {
    const cause = Object.assign(new Error('合成私密详情'), { code: 'ENOSPC' });
    expect(localResourceFailureCode(new Error('准备原件失败', { cause }))).toBe('LOCAL_STORAGE_FULL');
    expect(localResourceFailureCode({ code: 'ENOSPC', message: '任意资料对象' })).toBeNull();
    const circular = new Error('普通错误'); circular.cause = circular;
    expect(localResourceFailureCode(circular)).toBeNull();
  });

  it.each([new Error('Storage is at capacity'), new Error('CODEX_MODEL_BUSY'), new Error('SQLITE_CORRUPT'),
    new Error('EACCES: permission denied'), null, 'ENOSPC'])('不猜测其他容量或文件错误 %#', (error) => {
    expect(localResourceFailureCode(error)).toBeNull();
  });
});
