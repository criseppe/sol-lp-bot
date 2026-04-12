/**
 * Safely serialize any error value to a readable string.
 * Handles Error objects, plain objects (Orca SDK), and primitives.
 */
export function errStr(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null) {
    try { return JSON.stringify(err).slice(0, 500); } catch { return String(err); }
  }
  return String(err);
}
