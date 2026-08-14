declare module "write-file-atomic" {
  export type WriteFileAtomicOptions = Readonly<{
    chown?: Readonly<{ uid: number; gid: number }> | false;
    encoding?: BufferEncoding | null;
    fsync?: boolean;
    mode?: number | false;
    tmpfileCreated?: (temporaryPath: string) => void | Promise<void>;
  }>;

  export default function writeFileAtomic(
    filename: string,
    data: string | NodeJS.ArrayBufferView,
    options?: WriteFileAtomicOptions | BufferEncoding,
  ): Promise<void>;
}
