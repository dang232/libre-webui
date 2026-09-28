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

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  tokenpanelBillingApi,
  type TopupIntentShape,
} from '@/utils/api/tokenpanelApi';
import {
  formatCountdown,
  formatMicros,
  parseMajorToMicros,
  qrExpiryState,
} from '@/utils/billingMicros';

interface HistoryRow {
  _id?: string;
  amountMicros?: number;
  currency?: string;
  reason?: string;
  createdAt?: string;
}

const asList = (value: unknown): HistoryRow[] => {
  if (Array.isArray(value)) return value as HistoryRow[];
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.items)) return record.items as HistoryRow[];
  }
  return [];
};

const asIntent = (value: unknown): TopupIntentShape | null => {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const wrapped = record.intent as Record<string, unknown> | undefined;
  const source = wrapped ?? record;
  if (typeof source.amountMicros !== 'number') return null;
  return {
    _id: typeof source._id === 'string' ? source._id : undefined,
    id: typeof source.id === 'string' ? source.id : undefined,
    orderCode:
      typeof source.orderCode === 'string' ? source.orderCode : undefined,
    amountMicros: source.amountMicros,
    currency: typeof source.currency === 'string' ? source.currency : 'USD',
    method: typeof source.method === 'string' ? source.method : undefined,
    status: typeof source.status === 'string' ? source.status : undefined,
    qrExpiresAt:
      typeof source.qrExpiresAt === 'string' ? source.qrExpiresAt : null,
    vietqr: typeof source.vietqr === 'string' ? source.vietqr : null,
    qrPayload: typeof source.qrPayload === 'string' ? source.qrPayload : null,
    qrLink: typeof source.qrLink === 'string' ? source.qrLink : null,
  };
};

const newIdempotencyKey = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.floor(Math.random() * 1_000_000_000)}`;

/**
 * Native billing surface (todo 21): history reads match the BFF passthrough,
 * recharge creates a server-side intent and renders the server-issued QR
 * honoring its TTL, redeem forwards the code. No ledger math lives here —
 * every amount shown is integer micros formatted without floats.
 */
export const SettingsBillingTab: React.FC = () => {
  const { t } = useTranslation();
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [amount, setAmount] = useState('');
  const [amountError, setAmountError] = useState<string | null>(null);
  const [intent, setIntent] = useState<TopupIntentShape | null>(null);
  const [intentBusy, setIntentBusy] = useState(false);
  const [intentError, setIntentError] = useState<string | null>(null);
  const [redeemCode, setRedeemCode] = useState('');
  const [redeemBusy, setRedeemBusy] = useState(false);
  const [redeemResult, setRedeemResult] = useState<string | null>(null);
  const [redeemError, setRedeemError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const response = await tokenpanelBillingApi.history({ limit: 20 });
      if (!response.success) throw new Error(response.error || 'load failed');
      setHistory(asList(response.data));
    } catch {
      setHistoryError(t('settings.billing.historyFailed'));
    } finally {
      setHistoryLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const expiry = useMemo(
    () => qrExpiryState(intent?.qrExpiresAt ?? null, nowMs),
    [intent, nowMs]
  );

  useEffect(() => {
    if (!intent?.qrExpiresAt) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [intent?.qrExpiresAt]);

  const createIntent = async (): Promise<void> => {
    const micros = parseMajorToMicros(amount);
    if (micros === null) {
      setAmountError(t('settings.billing.amountInvalid'));
      return;
    }
    setAmountError(null);
    setIntentBusy(true);
    setIntentError(null);
    try {
      const response = await tokenpanelBillingApi.createIntent(
        micros,
        newIdempotencyKey()
      );
      if (!response.success) throw new Error(response.error || 'create failed');
      const created = asIntent(response.data);
      if (!created) throw new Error('unexpected intent shape');
      setIntent(created);
      setNowMs(Date.now());
      void loadHistory();
    } catch {
      setIntentError(t('settings.billing.intentFailed'));
    } finally {
      setIntentBusy(false);
    }
  };

  const refreshIntent = async (): Promise<void> => {
    const id = intent?._id ?? intent?.id;
    if (!id) return;
    setIntentBusy(true);
    setIntentError(null);
    try {
      const response = await tokenpanelBillingApi.intent(id);
      if (!response.success)
        throw new Error(response.error || 'refresh failed');
      const fresh = asIntent(response.data);
      if (!fresh) throw new Error('unexpected intent shape');
      setIntent(fresh);
      setNowMs(Date.now());
    } catch {
      // An expired/decided intent reads as not found server-side: the QR is
      // dead and the user must create a fresh intent (refresh path proven).
      setIntentError(t('settings.billing.intentExpired'));
      setIntent(null);
    } finally {
      setIntentBusy(false);
    }
  };

  const cancelIntent = async (): Promise<void> => {
    const id = intent?._id ?? intent?.id;
    if (!id) return;
    setIntentBusy(true);
    setIntentError(null);
    try {
      const response = await tokenpanelBillingApi.cancelIntent(id);
      if (!response.success) throw new Error(response.error || 'cancel failed');
      setIntent(null);
      void loadHistory();
    } catch {
      setIntentError(t('settings.billing.intentFailed'));
    } finally {
      setIntentBusy(false);
    }
  };

  const redeem = async (): Promise<void> => {
    const code = redeemCode.trim();
    if (code.length < 4 || code.length > 64) {
      setRedeemError(t('settings.billing.redeemInvalid'));
      return;
    }
    setRedeemError(null);
    setRedeemResult(null);
    setRedeemBusy(true);
    try {
      const response = await tokenpanelBillingApi.redeem(code);
      if (!response.success) throw new Error(response.error || 'redeem failed');
      const record =
        typeof response.data === 'object' && response.data !== null
          ? (response.data as Record<string, unknown>)
          : {};
      const credited = record.credited as
        { amountMicros?: number; currency?: string } | undefined;
      setRedeemResult(
        typeof credited?.amountMicros === 'number'
          ? formatMicros(credited.amountMicros, credited.currency ?? '')
          : t('settings.billing.redeemDone')
      );
      setRedeemCode('');
      void loadHistory();
    } catch {
      setRedeemError(t('settings.billing.redeemFailed'));
    } finally {
      setRedeemBusy(false);
    }
  };

  const qrText = intent?.vietqr ?? intent?.qrPayload ?? null;
  const qrExpired = expiry?.expired ?? false;

  return (
    <div className='flex flex-col gap-4'>
      <section
        aria-labelledby='billing-history-heading'
        className='rounded-xl border border-gray-200/70 p-4 dark:border-white/[0.08]'
      >
        <h4
          id='billing-history-heading'
          className='text-sm font-medium text-gray-900 dark:text-dark-800'
        >
          {t('settings.billing.historyTitle')}
        </h4>
        <p className='mt-1 text-sm leading-6 text-gray-600 dark:text-dark-600'>
          {t('settings.billing.historyDescription')}
        </p>
        {historyLoading ? (
          <p className='mt-3 text-sm text-gray-600 dark:text-dark-600'>
            {t('common.loading')}
          </p>
        ) : historyError ? (
          <p
            role='alert'
            className='mt-3 text-sm text-red-600 dark:text-red-400'
          >
            {historyError}
          </p>
        ) : history.length === 0 ? (
          <p className='mt-3 text-sm text-gray-600 dark:text-dark-600'>
            {t('settings.billing.historyEmpty')}
          </p>
        ) : (
          <ul className='mt-3 flex flex-col gap-2'>
            {history.map((row, index) => (
              <li
                key={row._id ?? `${row.createdAt ?? 'row'}-${index}`}
                className='flex items-center justify-between gap-3 text-sm'
              >
                <span className='text-gray-900 dark:text-dark-800'>
                  {typeof row.amountMicros === 'number'
                    ? formatMicros(row.amountMicros, row.currency ?? '')
                    : '—'}
                </span>
                <span className='text-gray-600 dark:text-dark-600'>
                  {[row.reason, row.createdAt].filter(Boolean).join(' · ')}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className='mt-3'>
          <button
            type='button'
            onClick={() => void loadHistory()}
            disabled={historyLoading}
            className='inline-flex min-h-11 items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-60 dark:border-white/10 dark:text-dark-700 dark:hover:bg-white/5'
          >
            {t('common.refresh')}
          </button>
        </div>
      </section>

      <section
        aria-labelledby='billing-recharge-heading'
        className='rounded-xl border border-gray-200/70 p-4 dark:border-white/[0.08]'
      >
        <h4
          id='billing-recharge-heading'
          className='text-sm font-medium text-gray-900 dark:text-dark-800'
        >
          {t('settings.billing.rechargeTitle')}
        </h4>
        <p className='mt-1 text-sm leading-6 text-gray-600 dark:text-dark-600'>
          {t('settings.billing.rechargeDescription')}
        </p>
        <div className='mt-3 flex flex-wrap items-end gap-2'>
          <label className='flex flex-col gap-1 text-sm'>
            <span className='text-gray-700 dark:text-dark-700'>
              {t('settings.billing.amountLabel')}
            </span>
            <input
              type='text'
              inputMode='decimal'
              value={amount}
              onChange={event => setAmount(event.target.value)}
              placeholder='10'
              className='min-h-11 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-white/10 dark:bg-white/5 dark:text-dark-800'
            />
          </label>
          <button
            type='button'
            onClick={() => void createIntent()}
            disabled={intentBusy}
            className='inline-flex min-h-11 items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-60'
          >
            {t('settings.billing.createIntent')}
          </button>
        </div>
        {amountError && (
          <p
            role='alert'
            className='mt-2 text-sm text-red-600 dark:text-red-400'
          >
            {amountError}
          </p>
        )}
        {intentError && (
          <p
            role='alert'
            className='mt-2 text-sm text-red-600 dark:text-red-400'
          >
            {intentError}
          </p>
        )}
        {intent && (
          <div className='mt-3 rounded-lg bg-gray-50 p-3 dark:bg-white/5'>
            <p className='text-sm font-medium text-gray-900 dark:text-dark-800'>
              {formatMicros(intent.amountMicros, intent.currency)}
              {intent.orderCode ? ` · ${intent.orderCode}` : ''}
            </p>
            {expiry ? (
              <p
                className='mt-1 text-sm text-gray-700 dark:text-dark-700'
                aria-live='polite'
              >
                {qrExpired
                  ? t('settings.billing.qrExpired')
                  : t('settings.billing.qrExpiresIn', {
                      countdown: formatCountdown(expiry.remainingMs),
                    })}
              </p>
            ) : (
              <p className='mt-1 text-sm text-gray-600 dark:text-dark-600'>
                {t('settings.billing.qrNoExpiry')}
              </p>
            )}
            {!qrExpired && qrText ? (
              <pre
                dir='ltr'
                className='mt-2 max-h-32 overflow-auto rounded bg-white p-2 text-start text-xs leading-5 text-gray-900 dark:bg-black/30 dark:text-dark-800'
              >
                {qrText}
              </pre>
            ) : null}
            {intent.qrLink && !qrExpired ? (
              <a
                href={intent.qrLink}
                target='_blank'
                rel='noopener noreferrer'
                className='mt-2 inline-block text-sm text-blue-600 underline dark:text-blue-400'
              >
                {t('settings.billing.qrOpenLink')}
              </a>
            ) : null}
            <div className='mt-3 flex flex-wrap gap-2'>
              <button
                type='button'
                onClick={() => void refreshIntent()}
                disabled={intentBusy}
                className='inline-flex min-h-11 items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-60 dark:border-white/10 dark:text-dark-700 dark:hover:bg-white/5'
              >
                {t('settings.billing.refreshIntent')}
              </button>
              <button
                type='button'
                onClick={() => void cancelIntent()}
                disabled={intentBusy}
                className='inline-flex min-h-11 items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-60 dark:border-white/10 dark:text-dark-700 dark:hover:bg-white/5'
              >
                {t('settings.billing.cancelIntent')}
              </button>
            </div>
          </div>
        )}
      </section>

      <section
        aria-labelledby='billing-redeem-heading'
        className='rounded-xl border border-gray-200/70 p-4 dark:border-white/[0.08]'
      >
        <h4
          id='billing-redeem-heading'
          className='text-sm font-medium text-gray-900 dark:text-dark-800'
        >
          {t('settings.billing.redeemTitle')}
        </h4>
        <p className='mt-1 text-sm leading-6 text-gray-600 dark:text-dark-600'>
          {t('settings.billing.redeemDescription')}
        </p>
        <div className='mt-3 flex flex-wrap items-end gap-2'>
          <label className='flex flex-col gap-1 text-sm'>
            <span className='text-gray-700 dark:text-dark-700'>
              {t('settings.billing.redeemLabel')}
            </span>
            <input
              type='text'
              value={redeemCode}
              onChange={event => setRedeemCode(event.target.value)}
              autoComplete='off'
              spellCheck={false}
              className='min-h-11 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-white/10 dark:bg-white/5 dark:text-dark-800'
            />
          </label>
          <button
            type='button'
            onClick={() => void redeem()}
            disabled={redeemBusy}
            className='inline-flex min-h-11 items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-60'
          >
            {t('settings.billing.redeemAction')}
          </button>
        </div>
        {redeemError && (
          <p
            role='alert'
            className='mt-2 text-sm text-red-600 dark:text-red-400'
          >
            {redeemError}
          </p>
        )}
        {redeemResult && (
          <p
            role='status'
            className='mt-2 text-sm text-green-700 dark:text-green-400'
          >
            {t('settings.billing.redeemCredited', { amount: redeemResult })}
          </p>
        )}
      </section>
    </div>
  );
};
