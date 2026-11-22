export interface Rect { x: number; y: number; width: number; height: number }
export interface SensorMetadata { metadata: { camera: { model: string }; orientation: number };
  frame: { width: number; height: number; crop: Rect; orientation: number; bitsPerSample: number;
    layout: string; compression: string; blackLevel: { mean: number }; whiteBalance: number[] } }
export function initWechat(path: string): Promise<void>;
export function memoryBytes(): number;
export function inspectRaw(bytes: Uint8Array): SensorMetadata;
export function decodeRaw(bytes: Uint8Array, rect: Rect, exposure?: number): { width: number; height: number; pixels: Uint8ClampedArray };
