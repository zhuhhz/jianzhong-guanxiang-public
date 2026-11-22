// tiff 7.1.3 exposes its declarations through package exports, while this
// project's existing moduleResolution is node. Keep the adapter surface local.
declare module 'tiff' {
  export interface TiffIfd {
    width: number; height: number; components: number; bitsPerSample: number;
    compression: number; type: number; orientation?: number;
    planarConfiguration: number; fillOrder: number; predictor: number;
    stripOffsets: number[]; stripByteCounts: number[]; rowsPerStrip: number;
    data: Uint8Array | Uint16Array;
    get(tag: number): unknown;
  }
  export function decode(data: ArrayBuffer, options: { pages: number[]; ignoreImageData?: boolean }): TiffIfd[];
}
