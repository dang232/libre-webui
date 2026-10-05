/**
 * Map a backend chat-generation error code to its user-facing recovery
 * copy. Returns the i18n key, or null when the code is unknown so callers
 * keep the previous raw-message behavior.
 */
export function chatFailureToastKey(code: string | undefined): string | null {
  switch (code) {
    case 'chat-generation-rate-limited':
      return 'chat.toasts.generationRateLimited';
    case 'chat-generation-unverified':
      return 'chat.toasts.generationUnverified';
    case 'chat-generation-model-unavailable':
      return 'chat.toasts.generationModelUnavailable';
    case 'chat-generation-upstream-incomplete':
      return 'chat.toasts.generationUpstreamIncomplete';
    default:
      return null;
  }
}
