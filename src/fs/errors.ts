export type FsErrorCode = 'ENOENT' | 'ENOTDIR' | 'EISDIR' | 'EINVAL' | 'EROFS'

export class FsError extends Error {
  readonly code: FsErrorCode

  constructor(code: FsErrorCode, syscall: string, path: string) {
    super(`${code}: ${syscall} '${path}'`)
    this.name = 'FsError'
    this.code = code
  }
}

export function isFsError(error: unknown, code?: FsErrorCode): error is FsError {
  return error instanceof FsError && (code === undefined || error.code === code)
}
