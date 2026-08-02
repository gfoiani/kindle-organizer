/**
 * Machine-readable error codes that survive the IPC boundary.
 *
 * Electron serializes an `ipcMain.handle` rejection into a plain Error on the
 * renderer side, wrapping the message ("Error invoking remote method '…': Error:
 * <message>") and dropping every custom field — so a `code` property would not
 * make the trip. The code therefore lives IN THE MESSAGE, and the renderer
 * matches on it to pick a localized string (see renderer `utils/appError.ts`).
 *
 * This mirrors the convention the classifier worker already uses for its
 * NEED_TWO_LABELS / WORKER_INIT_FAILED codes.
 *
 * Adding a code here is a compile error in the renderer until it is given a
 * message: the mapping table there is typed `Record<AppErrorCode, string>`.
 */
export type AppErrorCode = 'COLLECTION_NAME_TAKEN' | 'COLLECTION_NAME_EMPTY'

/** An error whose message is a stable code the renderer can translate. */
export class AppError extends Error {
  constructor(public readonly code: AppErrorCode) {
    super(code)
    this.name = 'AppError'
  }
}
