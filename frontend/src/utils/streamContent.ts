/**
 * Resolve the text to display when a streamed generation completes.
 *
 * The streaming buffer accumulates every delta the client receives, so when
 * the backend retries a generation the buffer holds all attempts
 * concatenated. The persisted message is always exactly one (successful)
 * attempt, so it wins whenever present. The buffer is kept only as a
 * fallback for completions that carry no saved text (finalization failed).
 */
export function resolveFinalStreamedContent(
  savedContent: string | undefined,
  bufferedContent: string
): string {
  return savedContent || bufferedContent;
}
