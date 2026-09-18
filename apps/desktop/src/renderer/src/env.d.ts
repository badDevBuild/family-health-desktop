import type { HealthDesktopBridge } from '../../preload/index.js';

declare global {
  interface Window {
    healthDesktop?: HealthDesktopBridge;
  }
}

export {};

