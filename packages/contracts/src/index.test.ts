import { describe, expect, it } from 'vitest';
import { localDateSchema } from './index.js';

describe('本地日期契约', () => {
  it('接受真实日历日，拒绝只是格式像日期的无效值', () => {
    expect(localDateSchema.safeParse('2024-02-29').success).toBe(true);
    expect(localDateSchema.safeParse('2025-02-29').success).toBe(false);
    expect(localDateSchema.safeParse('2026-13-40').success).toBe(false);
  });
});
