/**
 * Humanized elapsed time between two timestamps, for the admin sessions list
 * ("how long the client was in this session"). A long duration flags a session
 * where the AI likely struggled and the client kept trying — worth opening the
 * chat to review.
 */
export const formatDuration = (
  from: Date | null | undefined,
  to: Date | null | undefined
): string => {
  if (!from || !to) return '—';
  const ms = to.getTime() - from.getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
};
