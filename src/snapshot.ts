import type { Snapshot } from '../server/types.ts';

// A POST response may arrive after a newer SSE snapshot. Never roll the view back.
export function latestSnapshot<T extends Snapshot>(previous: T | null, next: T): T {
  if (previous?.revision && next.revision && previous.revision.instanceId === next.revision.instanceId && previous.revision.sequence > next.revision.sequence) return previous;
  return next;
}
