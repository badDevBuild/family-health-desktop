import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { inspectBinaryTarget } from './binary-target.mjs';

function macho(cpuType: number) {
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32LE(0xfeedfacf, 0);
  buffer.writeUInt32LE(cpuType, 4);
  return buffer;
}

function pe(machine: number) {
  const buffer = Buffer.alloc(0x90);
  buffer.write('MZ', 0, 'ascii');
  buffer.writeUInt32LE(0x80, 0x3c);
  buffer.write('PE\0\0', 0x80, 'binary');
  buffer.writeUInt16LE(machine, 0x84);
  return buffer;
}

describe('原生二进制目标识别', () => {
  it('识别 macOS arm64 与 x64 Mach-O', () => {
    expect(inspectBinaryTarget(macho(0x0100000c))).toBe('darwin-arm64');
    expect(inspectBinaryTarget(macho(0x01000007))).toBe('darwin-x64');
  });

  it('识别 Windows x64 PE', () => {
    expect(inspectBinaryTarget(pe(0x8664))).toBe('win32-x64');
  });

  it('拒绝普通数据伪装成原生模块', () => {
    expect(inspectBinaryTarget(Buffer.from('not-a-binary'))).toBe('unknown');
  });
});
