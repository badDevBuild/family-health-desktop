export type BinaryTarget = 'darwin-arm64' | 'darwin-x64' | 'win32-x64';

export function inspectBinaryTarget(buffer: Buffer): string;
export function assertBinaryTarget(path: string, expectedTarget: BinaryTarget, label?: string): Promise<void>;
