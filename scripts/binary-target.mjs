import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';

const MACHO_64_LE = 0xfeedfacf;
const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;
const PE_MACHINE_AMD64 = 0x8664;

export function inspectBinaryTarget(buffer) {
  if (buffer.length >= 8 && buffer.readUInt32LE(0) === MACHO_64_LE) {
    const cpuType = buffer.readUInt32LE(4);
    if (cpuType === CPU_TYPE_ARM64) return 'darwin-arm64';
    if (cpuType === CPU_TYPE_X86_64) return 'darwin-x64';
    return `darwin-unknown-${cpuType.toString(16)}`;
  }

  if (buffer.length >= 64 && buffer[0] === 0x4d && buffer[1] === 0x5a) {
    const peOffset = buffer.readUInt32LE(0x3c);
    if (
      peOffset >= 0 &&
      peOffset + 6 <= buffer.length &&
      buffer.subarray(peOffset, peOffset + 4).equals(Buffer.from([0x50, 0x45, 0, 0]))
    ) {
      const machine = buffer.readUInt16LE(peOffset + 4);
      if (machine === PE_MACHINE_AMD64) return 'win32-x64';
      return `win32-unknown-${machine.toString(16)}`;
    }
  }

  return 'unknown';
}

export async function assertBinaryTarget(path, expectedTarget, label = path) {
  const buffer = await readFile(path);
  const actualTarget = inspectBinaryTarget(buffer);
  if (actualTarget !== expectedTarget) {
    throw new Error(`BINARY_TARGET_MISMATCH:${label}:expected=${expectedTarget}:actual=${actualTarget}`);
  }
}
