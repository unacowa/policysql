// Resource release must not replace a validated response or the original failure.
// Never use this helper around a SQL command (including cleanup rollback).
export async function releaseTransportResource(resource) {
  try { await resource?.dispose(); }
  catch { /* Disposal is local cleanup, not a database outcome. */ }
}
