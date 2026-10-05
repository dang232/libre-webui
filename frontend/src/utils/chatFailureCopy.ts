/**
 * Map a backend chat-generation error code to its user-facing recovery
 * copy. Returns the i18n key, or null when the code is unknown so callers
 * keep the previous raw-message behavior. A finished-but-unclassified
 * failure (`chat-generation-failed`) points at the support path instead of
 * echoing the sanitized summary, so an unknown error is never silent.
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
    case 'chat-generation-failed':
      return 'chat.toasts.generationFailedSupport';
    default:
      return null;
  }
}

/**
 * Pick the quota toast naming the actual reset time for a budget period.
 * Unknown periods fall back to the generic quota copy, which names no time
 * rather than naming a wrong one.
 */
export function chatBudgetToastKey(period: string | undefined): string {
  switch (period) {
    case 'daily':
      return 'chat.toasts.generationRateLimitedDaily';
    case 'weekly':
      return 'chat.toasts.generationRateLimitedWeekly';
    case 'monthly':
      return 'chat.toasts.generationRateLimitedMonthly';
    default:
      return 'chat.toasts.generationRateLimited';
  }
}

export interface ChatSendFailure {
  status?: number;
  code?: string;
  period?: string;
  message?: string;
}

/**
 * Map a rejected chat send to its toast key. Budget 429s name the reset
 * time, verification 403s point at the inbox and Portal profile, and
 * pending-approval 403s say who can unlock the account. Anything else
 * keeps the previous generic send-failure copy.
 */
export function chatSendFailureToastKey(failure: ChatSendFailure): string {
  if (failure.status === 429) return chatBudgetToastKey(failure.period);
  if (failure.status === 403) {
    if (failure.code === 'ACCOUNT_PENDING')
      return 'chat.toasts.generationAccountPending';
    if (/verif/i.test(`${failure.code ?? ''} ${failure.message ?? ''}`))
      return 'chat.toasts.generationUnverified';
  }
  return 'chat.toasts.sendFailed';
}
