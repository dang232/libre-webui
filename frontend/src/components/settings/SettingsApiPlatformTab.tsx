/*
 * Alcore
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at:
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { preferencesApi } from '@/utils/api/preferencesApi';
import { pluginApi } from '@/utils/api/pluginApi';
import { TOKENPANEL_BASE_URL, portalSectionUrl } from '@/utils/config';
import {
  tokenpanelApi,
  tokenpanelKeysApi,
  tokenpanelProjectsApi,
  type TokenpanelKey,
  type TokenpanelProject,
} from '@/utils/api/tokenpanelApi';
import {
  tokenpanelAccountApi,
  type AccountBudget,
  type AccountLimit,
  type AccountProfile,
  type AccountSubscription,
  type BillingPeriod,
} from '@/utils/api/tokenpanelAccountApi';
import { formatSpendMicros, groupMajorDigits } from '@/utils/usageMicros';
import { MICROS_PER_MAJOR } from '@/utils/billingMicros';
import { SettingsBillingTab } from './SettingsBillingTab';
import { TokenpanelUsagePanel } from './TokenpanelUsagePanel';
import { SettingsTabHeader } from './SettingsTabHeader';

export { TOKENPANEL_BASE_URL };

const inputClassName =
  'min-h-11 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-white/10 dark:bg-white/5 dark:text-dark-800';

const primaryButtonClassName =
  'inline-flex min-h-11 items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-60';

const secondaryButtonClassName =
  'inline-flex min-h-11 items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-60 dark:border-white/10 dark:text-dark-700 dark:hover:bg-white/5';

const parseMicrosInt = (raw: string): number | null => {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
};

const parseThresholds = (raw: string): number[] | null => {
  const parts = raw
    .split(',')
    .map(part => part.trim())
    .filter(part => part.length > 0);
  const out: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const value = Number(part);
    if (value < 0 || value > 100) return null;
    if (!out.includes(value)) out.push(value);
  }
  return out.sort((a, b) => a - b);
};

/**
 * Major-unit money helpers for this tab's editors (budget caps, key
 * quotas): 1 major = 1,000,000 micros. Integer string ops only — no float
 * math anywhere on this path, mirroring `@/utils/billingMicros` (which
 * stays positive-only for recharges, while quotas/caps accept zero, so
 * this tab carries its own zero-tolerant parser).
 */

/** Format integer micros as plain major units (`5`, `1.5`) — no currency. */
export const formatMajorUnits = (amountMicros: number): string => {
  if (!Number.isSafeInteger(amountMicros)) return '—';
  const sign = amountMicros < 0 ? '-' : '';
  const abs = Math.abs(amountMicros);
  const major = Math.trunc(abs / MICROS_PER_MAJOR);
  const minor = abs % MICROS_PER_MAJOR;
  const grouped = groupMajorDigits(String(major));
  if (minor === 0) return `${sign}${grouped}`;
  const fraction = String(minor).padStart(6, '0').replace(/0+$/, '');
  return `${sign}${grouped}.${fraction}`;
};

/**
 * Parse a major-unit decimal string to integer micros (up to 6 fraction
 * digits). `''` means "field left blank" (undefined); anything
 * unparseable is null. Zero is allowed — callers decide positivity.
 */
export const parseMajorUnitsToMicros = (
  raw: string
): number | undefined | null => {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  // Accept the grouping commas `formatMajorUnits` emits, so an editor
  // value round-trips (`2,590` -> 2590000000 micros) and pasted grouped
  // input parses the way a human wrote it.
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(trimmed.replace(/,/g, ''));
  if (!match) return null;
  const micros =
    Number(match[1]) * MICROS_PER_MAJOR +
    Number((match[2] ?? '').padEnd(6, '0'));
  return Number.isSafeInteger(micros) ? micros : null;
};

interface AccountSnapshot {
  subscription: AccountSubscription | null;
  plans: Array<
    { _id?: unknown; id?: unknown; name?: unknown } & Record<string, unknown>
  >;
  budgets: AccountBudget[];
  limits: AccountLimit[];
  profile: AccountProfile | null;
}

const planIdOf = (plan: { _id?: unknown; id?: unknown }): string => {
  if (typeof plan.id === 'string') return plan.id;
  if (typeof plan._id === 'string') return plan._id;
  return '';
};

const planNameOf = (plan: Record<string, unknown>): string => {
  const name = plan.name;
  return typeof name === 'string' && name.length > 0 ? name : '—';
};

/**
 * Account panel: subscription, budgets, spending limits and profile persisted
 * through the Libre BFF (todo 22). The browser sends the Libre user session
 * only; every read/write round-trips through TokenPanel server-side. A 401
 * (stale session or upstream-invalid customer JWT) is handled by the shared
 * API client — clearToken + AUTH_INVALIDATED_EVENT, single-fire — so this
 * panel only reports the server message verbatim and never retries.
 */
const AccountPanel: React.FC = () => {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<AccountSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const [planId, setPlanId] = useState('');
  const [billing, setBilling] = useState<BillingPeriod>('month');
  const [budgetEdits, setBudgetEdits] = useState<
    Record<string, { amount: string; thresholds: string }>
  >({});
  const [capAmount, setCapAmount] = useState('');
  const [capWindow, setCapWindow] = useState('2592000');
  const [profileName, setProfileName] = useState('');
  const [profileEmail, setProfileEmail] = useState('');

  const serverMessage = (error: unknown, fallback: string): string =>
    error instanceof Error && error.message ? error.message : fallback;

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [subscription, plans, budgets, limits, profile] = await Promise.all(
        [
          tokenpanelAccountApi.subscription(),
          tokenpanelAccountApi.plans(),
          tokenpanelAccountApi.budgets(),
          tokenpanelAccountApi.limits(),
          tokenpanelAccountApi.profile(),
        ]
      );
      if (
        !subscription.success ||
        !plans.success ||
        !budgets.success ||
        !limits.success ||
        !profile.success
      ) {
        throw new Error(
          subscription.error ||
            plans.error ||
            budgets.error ||
            limits.error ||
            profile.error ||
            'load failed'
        );
      }
      setSnapshot({
        subscription: subscription.data ?? null,
        plans: Array.isArray((plans.data as { items?: unknown })?.items)
          ? ((plans.data as { items: AccountSnapshot['plans'] }).items ?? [])
          : [],
        budgets: budgets.data?.items ?? [],
        limits: limits.data?.items ?? [],
        profile: profile.data ?? null,
      });
      setProfileName(
        typeof profile.data?.name === 'string' ? profile.data.name : ''
      );
      setProfileEmail(
        typeof profile.data?.email === 'string' ? profile.data.email : ''
      );
      const cap = limits.data?.items?.[0]?.spendingCap ?? null;
      // The cap editor works in major units; micros cross the BFF only.
      setCapAmount(cap ? formatMajorUnits(cap.maxSpendMicros) : '');
      setCapWindow(cap ? String(cap.windowSeconds) : '2592000');
    } catch (error) {
      setLoadError(
        serverMessage(error, t('settings.apiPlatform.accountLoadFailed'))
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const mutate = async (
    label: string,
    run: () => Promise<void>
  ): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    setFormError(null);
    try {
      await run();
      setNotice(t('settings.apiPlatform.savedOk'));
      await load();
    } catch (error) {
      setFormError(
        serverMessage(error, t('settings.apiPlatform.saveFailed', { label }))
      );
    } finally {
      setBusy(false);
    }
  };

  const onSubscribe = (): Promise<void> =>
    mutate(t('settings.apiPlatform.subscriptionTitle'), async () => {
      const response = await tokenpanelAccountApi.subscribe({
        planId,
        billing,
      });
      if (!response.success)
        throw new Error(response.error || 'subscribe failed');
    });

  const onSaveBudget = (budget: AccountBudget): Promise<void> => {
    const edit = budgetEdits[budget._id] ?? {
      amount: String(budget.amountMicros),
      thresholds: budget.alertThresholds.join(', '),
    };
    const amount = parseMicrosInt(edit.amount);
    const thresholds = parseThresholds(edit.thresholds);
    if (amount === null || thresholds === null) {
      setFormError(
        t('settings.apiPlatform.saveFailed', {
          label: t('settings.apiPlatform.budgetsTitle'),
        })
      );
      return Promise.resolve();
    }
    return mutate(t('settings.apiPlatform.budgetsTitle'), async () => {
      const response = await tokenpanelAccountApi.updateBudget(budget._id, {
        amountMicros: amount,
        alertThresholds: thresholds,
      });
      if (!response.success)
        throw new Error(response.error || 'budget update failed');
    });
  };

  const onSaveCap = (): Promise<void> => {
    const amount = parseMajorUnitsToMicros(capAmount);
    const windowSeconds = parseMicrosInt(capWindow);
    if (
      amount === null ||
      amount === undefined ||
      windowSeconds === null ||
      windowSeconds < 1 ||
      windowSeconds > 31536000
    ) {
      setFormError(
        t('settings.apiPlatform.saveFailed', {
          label: t('settings.apiPlatform.limitsTitle'),
        })
      );
      return Promise.resolve();
    }
    return mutate(t('settings.apiPlatform.limitsTitle'), async () => {
      const response = await tokenpanelAccountApi.updateLimits({
        maxSpendMicros: amount,
        windowSeconds,
      });
      if (!response.success)
        throw new Error(response.error || 'limits update failed');
    });
  };

  const onClearCap = (): Promise<void> =>
    mutate(t('settings.apiPlatform.limitsTitle'), async () => {
      const response = await tokenpanelAccountApi.updateLimits(null);
      if (!response.success)
        throw new Error(response.error || 'limits update failed');
    });

  const onSaveProfile = (): Promise<void> =>
    mutate(t('settings.apiPlatform.profileTitle'), async () => {
      const response = await tokenpanelAccountApi.updateProfile({
        ...(profileName.trim() ? { name: profileName.trim() } : {}),
        ...(profileEmail.trim() ? { email: profileEmail.trim() } : {}),
      });
      if (!response.success)
        throw new Error(response.error || 'profile update failed');
    });

  const activeSubscription =
    snapshot?.subscription?.subscription &&
    typeof snapshot.subscription.subscription === 'object'
      ? (snapshot.subscription.subscription as Record<string, unknown>)
      : null;

  return (
    <section
      aria-label={t('settings.apiPlatform.accountTitle')}
      className='rounded-xl border border-gray-200/70 p-4 dark:border-white/[0.08]'
    >
      <h4 className='text-sm font-medium text-gray-900 dark:text-dark-800'>
        {t('settings.apiPlatform.accountTitle')}
      </h4>
      <p className='mt-1 text-sm leading-6 text-gray-600 dark:text-dark-600'>
        {t('settings.apiPlatform.accountDescription')}
      </p>
      {loading && (
        <p className='mt-3 text-sm leading-6 text-gray-600 dark:text-dark-600'>
          {t('settings.apiPlatform.accountLoading')}
        </p>
      )}
      {!loading && loadError && (
        <div className='mt-3'>
          <p
            role='alert'
            className='text-sm leading-6 text-red-600 dark:text-red-400'
          >
            {loadError}
          </p>
          <button
            type='button'
            onClick={() => void load()}
            className={secondaryButtonClassName}
          >
            {t('settings.apiPlatform.accountRetry')}
          </button>
        </div>
      )}
      {!loading && !loadError && snapshot && (
        <div className='mt-3 flex flex-col gap-4'>
          <div>
            <h5 className='text-sm font-medium text-gray-900 dark:text-dark-800'>
              {t('settings.apiPlatform.subscriptionTitle')}
            </h5>
            <p className='mt-1 text-sm leading-6 text-gray-600 dark:text-dark-600'>
              {activeSubscription
                ? t('settings.apiPlatform.subscriptionActive')
                : t('settings.apiPlatform.subscriptionNone')}
            </p>
            <div className='mt-2 flex flex-wrap items-end gap-2'>
              <label className='flex min-w-44 flex-1 flex-col gap-1 text-sm text-gray-600 dark:text-dark-600'>
                {t('settings.apiPlatform.plansTitle')}
                <select
                  value={planId}
                  onChange={event => setPlanId(event.target.value)}
                  className={inputClassName}
                >
                  <option value=''>—</option>
                  {snapshot.plans.map(plan => {
                    const id = planIdOf(plan);
                    return (
                      <option key={id || planNameOf(plan)} value={id}>
                        {planNameOf(plan)}
                      </option>
                    );
                  })}
                </select>
              </label>
              <label className='flex flex-col gap-1 text-sm text-gray-600 dark:text-dark-600'>
                {t('settings.apiPlatform.billingPeriod')}
                <select
                  value={billing}
                  onChange={event =>
                    setBilling(event.target.value as BillingPeriod)
                  }
                  className={inputClassName}
                >
                  <option value='month'>
                    {t('settings.apiPlatform.billingPeriodMonth')}
                  </option>
                  <option value='quarter'>
                    {t('settings.apiPlatform.billingPeriodQuarter')}
                  </option>
                  <option value='year'>
                    {t('settings.apiPlatform.billingPeriodYear')}
                  </option>
                </select>
              </label>
              <button
                type='button'
                disabled={busy || planId === ''}
                onClick={() => void onSubscribe()}
                className={primaryButtonClassName}
              >
                {busy
                  ? t('settings.apiPlatform.saving')
                  : t('settings.apiPlatform.planSubscribe')}
              </button>
            </div>
          </div>
          <div>
            <h5 className='text-sm font-medium text-gray-900 dark:text-dark-800'>
              {t('settings.apiPlatform.budgetsTitle')}
            </h5>
            {snapshot.budgets.length === 0 && (
              <p className='mt-1 text-sm leading-6 text-gray-600 dark:text-dark-600'>
                {t('settings.apiPlatform.budgetsEmpty')}
              </p>
            )}
            {snapshot.budgets.map(budget => {
              const edit = budgetEdits[budget._id] ?? {
                amount: String(budget.amountMicros),
                thresholds: budget.alertThresholds.join(', '),
              };
              return (
                <div
                  key={budget._id}
                  className='mt-2 flex flex-wrap items-end gap-2'
                >
                  <span className='text-sm text-gray-600 dark:text-dark-600'>
                    {formatSpendMicros(budget.amountMicros, budget.currency)}
                  </span>
                  <label className='flex flex-col gap-1 text-sm text-gray-600 dark:text-dark-600'>
                    {t('settings.apiPlatform.budgetAmount')}
                    <input
                      value={edit.amount}
                      inputMode='numeric'
                      onChange={event =>
                        setBudgetEdits(previous => ({
                          ...previous,
                          [budget._id]: { ...edit, amount: event.target.value },
                        }))
                      }
                      className={inputClassName}
                    />
                  </label>
                  <label className='flex flex-col gap-1 text-sm text-gray-600 dark:text-dark-600'>
                    {t('settings.apiPlatform.budgetThresholds')}
                    <input
                      value={edit.thresholds}
                      onChange={event =>
                        setBudgetEdits(previous => ({
                          ...previous,
                          [budget._id]: {
                            ...edit,
                            thresholds: event.target.value,
                          },
                        }))
                      }
                      className={inputClassName}
                    />
                  </label>
                  <button
                    type='button'
                    disabled={busy}
                    onClick={() => void onSaveBudget(budget)}
                    className={secondaryButtonClassName}
                  >
                    {t('settings.apiPlatform.budgetSave')}
                  </button>
                </div>
              );
            })}
          </div>
          <div>
            <h5 className='text-sm font-medium text-gray-900 dark:text-dark-800'>
              {t('settings.apiPlatform.limitsTitle')}
            </h5>
            <p className='mt-1 text-sm leading-6 text-gray-600 dark:text-dark-600'>
              {snapshot.limits[0]?.spendingCap
                ? formatSpendMicros(
                    snapshot.limits[0].spendingCap.maxSpendMicros,
                    snapshot.profile?.balance &&
                      typeof snapshot.profile.balance === 'object'
                      ? String(
                          (snapshot.profile.balance as { currency?: unknown })
                            .currency ?? ''
                        )
                      : ''
                  )
                : t('settings.apiPlatform.limitsNone')}
            </p>
            <div className='mt-2 flex flex-wrap items-end gap-2'>
              <label className='flex flex-col gap-1 text-sm text-gray-600 dark:text-dark-600'>
                {t('settings.apiPlatform.capAmount')}
                <input
                  value={capAmount}
                  inputMode='numeric'
                  onChange={event => setCapAmount(event.target.value)}
                  className={inputClassName}
                />
              </label>
              <label className='flex flex-col gap-1 text-sm text-gray-600 dark:text-dark-600'>
                {t('settings.apiPlatform.capWindow')}
                <input
                  value={capWindow}
                  inputMode='numeric'
                  onChange={event => setCapWindow(event.target.value)}
                  className={inputClassName}
                />
              </label>
              <button
                type='button'
                disabled={busy}
                onClick={() => void onSaveCap()}
                className={secondaryButtonClassName}
              >
                {t('settings.apiPlatform.capSave')}
              </button>
              <button
                type='button'
                disabled={busy}
                onClick={() => void onClearCap()}
                className={secondaryButtonClassName}
              >
                {t('settings.apiPlatform.capClear')}
              </button>
            </div>
          </div>
          <div>
            <h5 className='text-sm font-medium text-gray-900 dark:text-dark-800'>
              {t('settings.apiPlatform.profileTitle')}
            </h5>
            <div className='mt-2 flex flex-wrap items-end gap-2'>
              <label className='flex min-w-44 flex-1 flex-col gap-1 text-sm text-gray-600 dark:text-dark-600'>
                {t('settings.apiPlatform.profileName')}
                <input
                  value={profileName}
                  onChange={event => setProfileName(event.target.value)}
                  className={inputClassName}
                />
              </label>
              <label className='flex min-w-44 flex-1 flex-col gap-1 text-sm text-gray-600 dark:text-dark-600'>
                {t('settings.apiPlatform.profileEmail')}
                <input
                  id='api-platform-profile-email'
                  type='email'
                  value={profileEmail}
                  onChange={event => setProfileEmail(event.target.value)}
                  className={inputClassName}
                />
              </label>
              <button
                type='button'
                disabled={busy}
                onClick={() => void onSaveProfile()}
                className={secondaryButtonClassName}
              >
                {busy
                  ? t('settings.apiPlatform.saving')
                  : t('settings.apiPlatform.profileSave')}
              </button>
            </div>
          </div>
          {notice && (
            <p
              role='status'
              className='text-sm leading-6 text-green-700 dark:text-green-400'
            >
              {notice}
            </p>
          )}
          {formError && (
            <p
              role='alert'
              className='text-sm leading-6 text-red-600 dark:text-red-400'
            >
              {formError}
            </p>
          )}
        </div>
      )}
    </section>
  );
};

/**
 * Native keys manager through the Libre BFF (todo 19). The browser sends
 * the Libre user session only; the backend attaches the management
 * credential server-side and answers `no-store`. Full secrets are shown
 * exactly once: the one-time banner clears from state on dismiss, and the
 * list carries fingerprints/prefixes only. A 401 engages the shared
 * invalid-session path (same contract as the account panel), so mutations
 * report the server message verbatim and never retry.
 */
/** Page size for the native keys list (the BFF allows 1..200). */
const KEYS_PAGE_SIZE = 20;

const KeysPanel: React.FC = () => {
  const { t } = useTranslation();
  const [keys, setKeys] = useState<TokenpanelKey[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newQuota, setNewQuota] = useState('');
  const [onceSecret, setOnceSecret] = useState<{
    name: string;
    secret: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  const serverMessage = (error: unknown, fallback: string): string =>
    error instanceof Error && error.message ? error.message : fallback;

  const load = useCallback(
    async (skip: number) => {
      setLoading(true);
      setLoadError(null);
      try {
        const response = await tokenpanelKeysApi.list({
          limit: KEYS_PAGE_SIZE,
          skip,
        });
        if (!response.success || !response.data) {
          throw new Error(response.error || 'load failed');
        }
        let items = response.data.items;
        const serverTotal =
          typeof response.data.total === 'number'
            ? response.data.total
            : items.length;
        if (items.length === 0 && skip > 0 && serverTotal > 0) {
          // The last key on this page just went away (e.g. revoked) —
          // step back one page instead of showing an empty list.
          const prev = Math.max(0, skip - KEYS_PAGE_SIZE);
          const retry = await tokenpanelKeysApi.list({
            limit: KEYS_PAGE_SIZE,
            skip: prev,
          });
          if (!retry.success || !retry.data) {
            throw new Error(retry.error || 'load failed');
          }
          items = retry.data.items;
          setPage(Math.floor(prev / KEYS_PAGE_SIZE));
          setTotal(
            typeof retry.data.total === 'number'
              ? retry.data.total
              : items.length
          );
        } else {
          setTotal(serverTotal);
        }
        setKeys(items);
      } catch (error) {
        setLoadError(
          serverMessage(error, t('settings.apiPlatform.keysLoadFailed'))
        );
      } finally {
        setLoading(false);
      }
    },
    [t]
  );

  useEffect(() => {
    void load(page * KEYS_PAGE_SIZE);
  }, [load, page]);

  const mutate = async (
    label: string,
    run: () => Promise<{ secret: string; name: string } | null>
  ): Promise<void> => {
    if (busy !== null) return;
    setBusy(label);
    setFormError(null);
    setNotice(null);
    try {
      const minted = await run();
      if (minted) {
        // The full secret lives in state only until dismissed — once shown,
        // the list below keeps carrying fingerprints/prefixes only.
        setOnceSecret({ name: minted.name, secret: minted.secret });
        setCopied(false);
      }
      await load(page * KEYS_PAGE_SIZE);
    } catch (error) {
      setFormError(
        serverMessage(error, t('settings.apiPlatform.actionFailed'))
      );
    } finally {
      setBusy(null);
    }
  };

  const onCreate = (): Promise<void> =>
    mutate(t('settings.apiPlatform.keyCreate'), async () => {
      const name = newName.trim();
      // The quota editor works in major units; micros cross the BFF only.
      const quota = parseMajorUnitsToMicros(newQuota);
      if (name.length < 1 || name.length > 120 || quota === null) {
        throw new Error(t('settings.apiPlatform.actionFailed'));
      }
      const response = await tokenpanelKeysApi.create({
        name,
        ...(quota !== undefined ? { quotaMicros: quota } : {}),
      });
      if (!response.success || !response.data) {
        throw new Error(response.error || 'create failed');
      }
      setNewName('');
      setNewQuota('');
      return { secret: response.data.key, name: response.data.apiKey.name };
    });

  const onReveal = (key: TokenpanelKey): Promise<void> =>
    mutate(t('settings.apiPlatform.keyReveal'), async () => {
      const response = await tokenpanelKeysApi.reveal(key._id);
      if (!response.success || !response.data) {
        throw new Error(response.error || 'reveal failed');
      }
      return { secret: response.data.key, name: key.name };
    });

  const onRotate = (key: TokenpanelKey): Promise<void> =>
    mutate(t('settings.apiPlatform.keyRotate'), async () => {
      const response = await tokenpanelKeysApi.rotate(key._id);
      if (!response.success || !response.data) {
        throw new Error(response.error || 'rotate failed');
      }
      return { secret: response.data.key, name: response.data.apiKey.name };
    });

  const onRevoke = (key: TokenpanelKey): Promise<void> =>
    mutate(t('settings.apiPlatform.keyRevoke'), async () => {
      const response = await tokenpanelKeysApi.revoke(key._id);
      if (!response.success) {
        throw new Error(response.error || 'revoke failed');
      }
      setNotice(t('settings.apiPlatform.keyRevoked', { name: key.name }));
      return null;
    });

  const onCopy = async (): Promise<void> => {
    if (!onceSecret) return;
    try {
      await navigator.clipboard.writeText(onceSecret.secret);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  // Server-reported total drives paging; at most one page hides controls.
  const pageCount = Math.max(1, Math.ceil(total / KEYS_PAGE_SIZE));

  return (
    <section
      aria-label={t('settings.apiPlatform.keysNativeTitle')}
      className='rounded-xl border border-gray-200/70 p-4 dark:border-white/[0.08]'
    >
      <h4 className='text-sm font-medium text-gray-900 dark:text-dark-800'>
        {t('settings.apiPlatform.keysNativeTitle')}
      </h4>
      <p className='mt-1 text-sm leading-6 text-gray-600 dark:text-dark-600'>
        {t('settings.apiPlatform.keysNativeDescription')}
      </p>
      {loading && (
        <p className='mt-3 text-sm leading-6 text-gray-600 dark:text-dark-600'>
          {t('settings.apiPlatform.accountLoading')}
        </p>
      )}
      {!loading && loadError && (
        <div className='mt-3 flex flex-wrap items-center gap-2'>
          <p
            role='alert'
            className='text-sm leading-6 text-red-600 dark:text-red-400'
          >
            {loadError}
          </p>
          <button
            type='button'
            onClick={() => void load(page * KEYS_PAGE_SIZE)}
            className={secondaryButtonClassName}
          >
            {t('settings.apiPlatform.keysRetry')}
          </button>
        </div>
      )}
      {!loading && !loadError && (
        <div className='mt-3 flex flex-col gap-3'>
          <p className='text-sm leading-6 text-gray-600 dark:text-dark-600'>
            {t('settings.apiPlatform.keysCount', { count: total })}
          </p>
          {keys.length === 0 && (
            <p className='text-sm leading-6 text-gray-600 dark:text-dark-600'>
              {t('settings.apiPlatform.keysEmpty')}
            </p>
          )}
          {keys.map(key => (
            <div
              key={key._id}
              className='flex flex-wrap items-center gap-2 rounded-lg border border-gray-200/70 px-3 py-2 dark:border-white/[0.08]'
            >
              <span className='min-w-32 flex-1 text-sm font-medium text-gray-900 dark:text-dark-800'>
                {key.name}
              </span>
              <span
                dir='ltr'
                className='text-sm text-gray-600 dark:text-dark-600'
              >
                {key.prefix}…
              </span>
              <span className='text-sm text-gray-600 dark:text-dark-600'>
                {key.status === 'revoked'
                  ? t('settings.apiPlatform.keyStatusRevoked')
                  : t('settings.apiPlatform.keyStatusActive')}
              </span>
              {typeof key.quotaMicros === 'number' && (
                <span className='text-sm text-gray-600 dark:text-dark-600'>
                  {t('settings.apiPlatform.quotaLabel')}:{' '}
                  {formatMajorUnits(key.quotaMicros)}
                </span>
              )}
              <span className='flex flex-wrap gap-2'>
                <button
                  type='button'
                  disabled={busy !== null}
                  onClick={() => void onReveal(key)}
                  className={secondaryButtonClassName}
                >
                  {t('settings.apiPlatform.keyReveal')}
                </button>
                {key.status !== 'revoked' && (
                  <button
                    type='button'
                    disabled={busy !== null}
                    onClick={() => void onRotate(key)}
                    className={secondaryButtonClassName}
                  >
                    {busy !== null
                      ? t('settings.apiPlatform.keyRotating')
                      : t('settings.apiPlatform.keyRotate')}
                  </button>
                )}
                {key.status !== 'revoked' && (
                  <button
                    type='button'
                    disabled={busy !== null}
                    onClick={() => void onRevoke(key)}
                    className={secondaryButtonClassName}
                  >
                    {t('settings.apiPlatform.keyRevoke')}
                  </button>
                )}
              </span>
            </div>
          ))}
          {pageCount > 1 && (
            <div className='flex flex-wrap items-center gap-2'>
              <button
                type='button'
                disabled={busy !== null || page === 0}
                onClick={() => setPage(previous => Math.max(0, previous - 1))}
                className={secondaryButtonClassName}
              >
                {t('settings.apiPlatform.keysPrev')}
              </button>
              <span className='text-sm text-gray-600 dark:text-dark-600'>
                {t('settings.apiPlatform.keysPage', {
                  page: page + 1,
                  pages: pageCount,
                })}
              </span>
              <button
                type='button'
                disabled={busy !== null || page >= pageCount - 1}
                onClick={() =>
                  setPage(previous => Math.min(pageCount - 1, previous + 1))
                }
                className={secondaryButtonClassName}
              >
                {t('settings.apiPlatform.keysNext')}
              </button>
            </div>
          )}
          <div className='flex flex-wrap items-end gap-2'>
            <label className='flex min-w-44 flex-1 flex-col gap-1 text-sm text-gray-600 dark:text-dark-600'>
              {t('settings.apiPlatform.keyNameLabel')}
              <input
                value={newName}
                maxLength={120}
                placeholder={t('settings.apiPlatform.keyNamePlaceholder')}
                onChange={event => setNewName(event.target.value)}
                className={inputClassName}
              />
            </label>
            <label className='flex flex-col gap-1 text-sm text-gray-600 dark:text-dark-600'>
              {t('settings.apiPlatform.quotaMicrosLabel')}
              <input
                value={newQuota}
                inputMode='numeric'
                placeholder={t('settings.apiPlatform.quotaMicrosPlaceholder')}
                onChange={event => setNewQuota(event.target.value)}
                className={inputClassName}
              />
            </label>
            <button
              type='button'
              disabled={busy !== null || newName.trim() === ''}
              onClick={() => void onCreate()}
              className={primaryButtonClassName}
            >
              {busy !== null
                ? t('settings.apiPlatform.keyCreating')
                : t('settings.apiPlatform.keyCreate')}
            </button>
          </div>
          {onceSecret && (
            <div
              role='alert'
              className='rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-400/30 dark:bg-amber-400/10'
            >
              <p className='text-sm font-medium text-gray-900 dark:text-dark-800'>
                {t('settings.apiPlatform.secretForLabel', {
                  name: onceSecret.name,
                })}
              </p>
              <p
                dir='ltr'
                className='mt-1 break-all text-sm leading-6 text-gray-900 dark:text-dark-800'
              >
                <code>{onceSecret.secret}</code>
              </p>
              <p className='mt-1 text-sm leading-6 text-gray-600 dark:text-dark-600'>
                {t('settings.apiPlatform.secretOnceWarning')}
              </p>
              <div className='mt-2 flex flex-wrap gap-2'>
                <button
                  type='button'
                  onClick={() => void onCopy()}
                  className={secondaryButtonClassName}
                >
                  {copied ? (
                    <Check className='h-4 w-4' aria-hidden />
                  ) : (
                    <Copy className='h-4 w-4' aria-hidden />
                  )}
                  {copied
                    ? t('settings.apiPlatform.keyCopied')
                    : t('settings.apiPlatform.keyCopy')}
                </button>
                <button
                  type='button'
                  onClick={() => {
                    setOnceSecret(null);
                    setCopied(false);
                  }}
                  className={secondaryButtonClassName}
                >
                  {t('settings.apiPlatform.keyDismiss')}
                </button>
              </div>
            </div>
          )}
          {notice && (
            <p
              role='status'
              className='text-sm leading-6 text-green-700 dark:text-green-400'
            >
              {notice}
            </p>
          )}
          {formError && (
            <p
              role='alert'
              className='text-sm leading-6 text-red-600 dark:text-red-400'
            >
              {formError}
            </p>
          )}
        </div>
      )}
    </section>
  );
};

/**
 * Native projects list through the Libre BFF (todo 19, read-only: no
 * upstream project-create exists, so none is offered here).
 */
const ProjectsPanel: React.FC = () => {
  const { t } = useTranslation();
  const [projects, setProjects] = useState<TokenpanelProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await tokenpanelProjectsApi.list();
      if (!response.success || !response.data) {
        throw new Error(response.error || 'load failed');
      }
      setProjects(response.data.items);
    } catch (error) {
      setLoadError(
        error instanceof Error && error.message
          ? error.message
          : t('settings.apiPlatform.projectsLoadFailed')
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section
      aria-label={t('settings.apiPlatform.projectsNativeTitle')}
      className='rounded-xl border border-gray-200/70 p-4 dark:border-white/[0.08]'
    >
      <h4 className='text-sm font-medium text-gray-900 dark:text-dark-800'>
        {t('settings.apiPlatform.projectsNativeTitle')}
      </h4>
      <p className='mt-1 text-sm leading-6 text-gray-600 dark:text-dark-600'>
        {t('settings.apiPlatform.projectsNativeDescription')}
      </p>
      {loading && (
        <p className='mt-3 text-sm leading-6 text-gray-600 dark:text-dark-600'>
          {t('settings.apiPlatform.accountLoading')}
        </p>
      )}
      {!loading && loadError && (
        <div className='mt-3 flex flex-wrap items-center gap-2'>
          <p
            role='alert'
            className='text-sm leading-6 text-red-600 dark:text-red-400'
          >
            {loadError}
          </p>
          <button
            type='button'
            onClick={() => void load()}
            className={secondaryButtonClassName}
          >
            {t('settings.apiPlatform.keysRetry')}
          </button>
        </div>
      )}
      {!loading && !loadError && (
        <div className='mt-3 flex flex-col gap-2'>
          {projects.length === 0 && (
            <p className='text-sm leading-6 text-gray-600 dark:text-dark-600'>
              {t('settings.apiPlatform.projectsEmpty')}
            </p>
          )}
          {projects.map(project => (
            <div
              key={project.id}
              className='flex flex-wrap items-center gap-2 rounded-lg border border-gray-200/70 px-3 py-2 dark:border-white/[0.08]'
            >
              <span className='min-w-32 flex-1 text-sm font-medium text-gray-900 dark:text-dark-800'>
                {project.name}
              </span>
              <span className='text-sm text-gray-600 dark:text-dark-600'>
                {project.slug}
              </span>
              <span className='text-sm text-gray-600 dark:text-dark-600'>
                {project.status}
              </span>
              <span className='text-sm text-gray-600 dark:text-dark-600'>
                {t('settings.apiPlatform.keyCountLabel', {
                  count: project.keyCount,
                })}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
};

/**
 * Default chat model: the ALcore API Platform is provisioned automatically
 * at signup/first login (server-held credential, never in the browser), so
 * new chats start there with zero setup. This panel only reflects and re-selects the persisted
 * default through the preferences API — provisioning itself happens
 * server-side. Store access is dynamic (click-time only) so this settings
 * tab keeps rendering without the chat store, matching the lane convention
 * of panels talking to BFF clients directly.
 */
const PlatformDefaultPanel: React.FC = () => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [isCurrent, setIsCurrent] = useState(false);
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [prefs, plugins] = await Promise.all([
          preferencesApi.getPreferences(),
          pluginApi.getAllPlugins(),
        ]);
        if (cancelled) return;
        const current =
          prefs.success &&
          prefs.data?.defaultModel === 'default-chat' &&
          prefs.data?.defaultProviderType === 'plugin' &&
          prefs.data?.defaultProviderId === 'alcore';
        const provisioned =
          plugins.success &&
          (plugins.data ?? []).some(
            plugin =>
              plugin.id === 'alcore' &&
              plugin.active &&
              plugin.model_map.includes('default-chat')
          );
        setIsCurrent(current);
        setAvailable(provisioned);
      } catch {
        if (!cancelled) {
          setIsCurrent(false);
          setAvailable(false);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onUse = (): void => {
    if (busy || isCurrent) return;
    setBusy(true);
    void (async () => {
      const response = await preferencesApi.setDefaultModel(
        'default-chat',
        'plugin',
        'alcore'
      );
      if (!response.success) {
        throw new Error(response.error || 'persist failed');
      }
      // Sync the live composer without a reload; the persisted default
      // already covers the next visit if the store is unreachable here.
      const { useChatStore } = await import('@/store/chatStore');
      await useChatStore
        .getState()
        .setSelectedModel('default-chat', 'plugin', 'alcore');
      setIsCurrent(true);
    })()
      .catch(() => undefined)
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <section
      aria-label={t('settings.apiPlatform.platformDefaultTitle')}
      className='rounded-xl border border-gray-200/70 p-4 dark:border-white/[0.08]'
    >
      <h4 className='text-sm font-medium text-gray-900 dark:text-dark-800'>
        {t('settings.apiPlatform.platformDefaultTitle')}
      </h4>
      <p className='mt-1 text-sm leading-6 text-gray-600 dark:text-dark-600'>
        {t('settings.apiPlatform.platformDefaultDescription')}
      </p>
      {!loading && (
        <p className='mt-2 text-sm leading-6 text-gray-600 dark:text-dark-600'>
          {isCurrent
            ? t('settings.apiPlatform.platformDefaultCurrent')
            : t('settings.apiPlatform.platformDefaultUnavailable')}
        </p>
      )}
      {!loading && !isCurrent && (
        <div className='mt-3'>
          <button
            type='button'
            disabled={busy || !available}
            onClick={onUse}
            className={primaryButtonClassName}
          >
            {busy
              ? t('settings.apiPlatform.platformDefaultUsing')
              : t('settings.apiPlatform.platformDefaultUse')}
          </button>
        </div>
      )}
    </section>
  );
};

/**
 * API Platform tab: single-login cross-link into the TokenPanel customer
 * portal (alcore.io.vn), which stays the permanent home for API keys, usage,
 * billing and the customer playground. Opening a section mints a 120s viewer
 * JWT through the Libre backend and hands it to the portal in a one-time URL
 * fragment the portal consumes and strips. Both apps keep their own login
 * until the unified identity (auth.alcore.io.vn) lands.
 */
/** R36/R37: what a failed portal open carries for the retry UI. */
interface BridgeFailure {
  message: string;
  code: string | null;
  requestId: string | null;
  retryable: boolean;
}

const readBridgeFailure = (error: unknown, fallback: string): BridgeFailure => {
  const response = (
    error as {
      response?: {
        data?: { message?: unknown; code?: unknown; requestId?: unknown };
      };
    }
  )?.response;
  const data = response?.data;
  const code = typeof data?.code === 'string' ? data.code : null;
  const requestId = typeof data?.requestId === 'string' ? data.requestId : null;
  const message =
    typeof data?.message === 'string' && data.message ? data.message : fallback;
  // 409 collisions stay human: the same request must never auto-retry.
  return { message, code, requestId, retryable: code !== 'BRIDGE_COLLISION' };
};

export const SettingsApiPlatformTab: React.FC = () => {
  const { t } = useTranslation();
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [failed, setFailed] = useState<BridgeFailure | null>(null);
  const [lastPath, setLastPath] = useState<string | null>(null);
  // R36: null until the BFF advertisement answers; false disables the
  // portal buttons with a "not configured" tooltip instead of a 503.
  const [bridgeConfigured, setBridgeConfigured] = useState<boolean | null>(
    null
  );
  // R38: why auto-provisioning did not happen — a banner, never silent.
  const [provision, setProvision] = useState<{
    provisioned: boolean;
    reason: string;
  } | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    tokenpanelApi
      .bridgeStatus()
      .then(response => {
        if (!cancelled && response.success && response.data) {
          setBridgeConfigured(response.data.configured);
        }
      })
      .catch(() => undefined);
    tokenpanelApi
      .provisionStatus()
      .then(response => {
        if (cancelled) return;
        // Never silent: an unreachable status reads as unavailable with
        // the generic fallback copy instead of hiding the banner.
        if (response.success && response.data) {
          setProvision({
            provisioned: response.data.provisioned,
            reason: response.data.reason,
          });
        } else {
          setProvision({ provisioned: false, reason: 'status-unavailable' });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProvision({ provisioned: false, reason: 'status-unavailable' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const provisionText = (reason: string): string => {
    if (reason === 'no-email')
      return t('settings.apiPlatform.provisionNoEmail');
    if (reason === 'bridge-not-configured')
      return t('settings.apiPlatform.provisionNotConfigured');
    // Unreachable status or an empty reason carries no server detail —
    // fall back to generic copy instead of interpolating a blank/code.
    if (reason === 'status-unavailable' || reason.trim() === '')
      return t('settings.apiPlatform.provisionUnknown');
    return t('settings.apiPlatform.provisionUnavailable', { reason });
  };

  // R38: the account email editor lives in this tab's AccountPanel —
  // bring it into view and focus it instead of describing where it is.
  const openProfileSettings = (): void => {
    const field = document.getElementById('api-platform-profile-email');
    field?.scrollIntoView({ behavior: 'auto', block: 'center' });
    (field as HTMLInputElement | null)?.focus?.();
  };

  const openSection = async (path: string): Promise<void> => {
    if (busyPath !== null) return;
    setBusyPath(path);
    setLastPath(path);
    setFailed(null);
    try {
      const response = await tokenpanelApi.exchangePortalToken();
      if (!response.success || !response.data) {
        throw new Error(response.error || 'exchange failed');
      }
      window.open(
        portalSectionUrl(TOKENPANEL_BASE_URL, path, response.data.token),
        '_blank',
        'noopener,noreferrer'
      );
    } catch (error) {
      setFailed(
        readBridgeFailure(error, t('settings.apiPlatform.bridgeFailed'))
      );
    } finally {
      setBusyPath(null);
    }
  };

  const cards: Array<{
    title: string;
    description: string;
    links: Array<{ path: string; label: string; primary?: boolean }>;
  }> = [
    {
      title: t('settings.apiPlatform.keysTitle'),
      description: t('settings.apiPlatform.keysDescription'),
      links: [
        {
          path: '/keys',
          label: t('settings.apiPlatform.keysOpen'),
          primary: true,
        },
      ],
    },
    {
      title: t('settings.apiPlatform.usageTitle'),
      description: t('settings.apiPlatform.usageDescription'),
      links: [
        {
          path: '/usage',
          label: t('settings.apiPlatform.usageOpen'),
          primary: true,
        },
        { path: '/billing', label: t('settings.apiPlatform.billingOpen') },
      ],
    },
    {
      title: t('settings.apiPlatform.playgroundTitle'),
      description: t('settings.apiPlatform.playgroundDescription'),
      links: [
        {
          path: '/playground',
          label: t('settings.apiPlatform.playgroundOpen'),
        },
      ],
    },
  ];

  return (
    <div>
      <SettingsTabHeader
        title={t('settings.apiPlatform.title')}
        description={t('settings.apiPlatform.description', {
          host: new URL(TOKENPANEL_BASE_URL).host,
        })}
      />
      <div className='flex flex-col gap-4'>
        <PlatformDefaultPanel />
        {cards.map(card => (
          <section
            key={card.title}
            className='rounded-xl border border-gray-200/70 p-4 dark:border-white/[0.08]'
          >
            <h4 className='text-sm font-medium text-gray-900 dark:text-dark-800'>
              {card.title}
            </h4>
            <p className='mt-1 text-sm leading-6 text-gray-600 dark:text-dark-600'>
              {card.description}
            </p>
            <div className='mt-3 flex flex-wrap gap-2'>
              {card.links.map(link => (
                <button
                  key={link.path}
                  type='button'
                  disabled={busyPath !== null || bridgeConfigured === false}
                  title={
                    bridgeConfigured === false
                      ? t('settings.apiPlatform.bridgeNotConfiguredTip')
                      : undefined
                  }
                  onClick={() => void openSection(link.path)}
                  className={
                    link.primary
                      ? 'inline-flex min-h-11 items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-60'
                      : 'inline-flex min-h-11 items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-60 dark:border-white/10 dark:text-dark-700 dark:hover:bg-white/5'
                  }
                >
                  {busyPath === link.path
                    ? t('settings.apiPlatform.opening')
                    : link.label}
                  <ExternalLink className='h-4 w-4' aria-hidden />
                </button>
              ))}
            </div>
          </section>
        ))}
        {bridgeConfigured === false && (
          <p
            role='status'
            data-testid='bridge-not-configured'
            className='text-sm leading-6 text-gray-600 dark:text-dark-600'
          >
            {t('settings.apiPlatform.bridgeNotConfigured')}
          </p>
        )}
        {provision !== null && !provision.provisioned && (
          <div
            role='status'
            data-testid='provision-banner'
            className='rounded-xl border border-gray-200/70 p-4 dark:border-white/[0.08]'
          >
            <p className='text-sm leading-6 text-gray-600 dark:text-dark-600'>
              {t('settings.apiPlatform.provisionBanner', {
                reason: provisionText(provision.reason),
              })}
            </p>
            {provision.reason === 'no-email' && (
              <button
                type='button'
                onClick={openProfileSettings}
                className='mt-2 inline-flex min-h-11 items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-white/10 dark:text-dark-700 dark:hover:bg-white/5'
              >
                {t('settings.apiPlatform.provisionAddEmail')}
              </button>
            )}
          </div>
        )}
        {failed !== null && (
          <div
            role='alert'
            data-testid='bridge-failure'
            className='text-sm leading-6 text-red-600 dark:text-red-400'
          >
            <p>{failed.message}</p>
            {(failed.code !== null || failed.requestId !== null) && (
              <p className='mt-1 font-mono text-[11px]'>
                {[failed.code, failed.requestId].filter(Boolean).join(' · ')}
              </p>
            )}
            {failed.retryable && lastPath !== null && (
              <button
                type='button'
                onClick={() => void openSection(lastPath)}
                className='mt-2 inline-flex min-h-11 items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-white/10 dark:text-dark-700 dark:hover:bg-white/5'
              >
                {t('settings.apiPlatform.bridgeRetry')}
              </button>
            )}
          </div>
        )}
        <KeysPanel />
        <ProjectsPanel />
        <SettingsBillingTab />
        <TokenpanelUsagePanel />
        <AccountPanel />
        <p className='text-sm leading-6 text-gray-600 dark:text-dark-600'>
          {t('settings.apiPlatform.note')}
        </p>
      </div>
    </div>
  );
};
