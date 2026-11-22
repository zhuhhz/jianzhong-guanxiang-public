declare module 'pako' {
  export class Inflate {
    constructor(options?: { chunkSize?: number });
    err: number;
    ended: boolean;
    onData: (bytes: Uint8Array) => void;
    push(bytes: Uint8Array, finish?: boolean): boolean;
  }
  export class Deflate {
    constructor(options?: { level?: number; chunkSize?: number });
    ended: boolean;
    onData: (bytes: Uint8Array) => void;
    onEnd: (status: number) => void;
    push(bytes: Uint8Array, finish?: boolean): boolean;
  }
}
