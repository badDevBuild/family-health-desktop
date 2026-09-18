import { stdout } from 'node:process';
import { expect, test } from 'vitest';
import { runLocalCapacityBenchmark } from './benchmark-local-capacity.js';

test('10 位成员、500 份文档、5 万条指标的本地快照 P95 不超过 1 秒', async () => {
  const result = await runLocalCapacityBenchmark();
  stdout.write(`\nCAPACITY_BENCHMARK_RESULT\n${JSON.stringify(result, null, 2)}\n`);
  expect(result.snapshotReadMs.passed).toBe(true);
}, 120_000);
