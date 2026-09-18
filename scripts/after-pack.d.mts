export interface AfterPackContextLike {
  electronPlatformName: string;
  arch: number;
  appOutDir: string;
  packager: { appInfo: { productFilename: string } };
}

export function expectedCanvasPackage(platform: string, arch: number): string;
export function expectedTarget(platform: string, arch: number): import('./binary-target.mjs').BinaryTarget;
export default function afterPack(context: AfterPackContextLike): Promise<void>;
