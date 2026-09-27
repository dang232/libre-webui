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

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  tokenpanelUsageApi,
  type UsageDayShape,
  type UsageRecordShape,
  type UsageSummaryShape,
} from '@/utils/api/tokenpanelUsageApi';
import {
  formatCount,
  formatSpendMicros,
  formatSpendWhole,
} from '@/utils/usageMicros';

/**
 * Live usage/requests panel (todo 20): renders EXACTLY what the TokenPanel
 * usage API returns through the Libre BFF (`GET /api/tokenpanel/usage/*`).
 * Raw integer micros flow untouched into `formatSpendMicros` /
 * `formatSpendWhole` at this render boundary — no float math, no
 * client-side currency conversion (the server currency is pinned and shown
 * verbatim). Token sums below are exact integer additions over the
 * server-returned daily buckets.
 */

/** Exact integer sum; falls back to null when any leg is not a safe int. */
const sumInts = (values: readonly number[]): number | null => {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value)) return null;
    total += value;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
};

const textOf = (value: string | null | undefined): string => value ?? '—';

export const TokenpanelUsagePanel: React.FC = () => {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<UsageSummaryShape | null>(null);
  const [days, setDays] = useState<UsageDayShape[] | null>(null);
  const [records, setRecords] = useState<UsageRecordShape[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setFailed(false);
    try {
      const [summaryRes, dailyRes, recordsRes] = await Promise.all([
        tokenpanelUsageApi.summary(),
        tokenpanelUsageApi.daily(),
        tokenpanelUsageApi.records(),
      ]);
      if (!summaryRes.success || !summaryRes.data) {
        throw new Error(summaryRes.error || 'summary failed');
      }
      if (!dailyRes.success || !Array.isArray(dailyRes.data)) {
        throw new Error(dailyRes.error || 'daily failed');
      }
      if (!recordsRes.success || !Array.isArray(recordsRes.data)) {
        throw new Error(recordsRes.error || 'records failed');
      }
      setSummary(summaryRes.data);
      setDays(dailyRes.data);
      setRecords(recordsRes.data);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const currency = summary?.currency ?? '';
  const inputTokens = sumInts((days ?? []).map(day => day.promptTokens));
  const outputTokens = sumInts((days ?? []).map(day => day.completionTokens));

  return (
    <section
      aria-label={t('settings.apiPlatform.usageLiveTitle')}
      className='rounded-xl border border-gray-200/70 p-4 dark:border-white/[0.08]'
    >
      <h4 className='text-sm font-medium text-gray-900 dark:text-dark-800'>
        {t('settings.apiPlatform.usageLiveTitle')}
      </h4>
      <p className='mt-1 text-sm leading-6 text-gray-600 dark:text-dark-600'>
        {t('settings.apiPlatform.usageLiveDescription')}
      </p>
      {loading && (
        <p className='mt-3 text-sm leading-6 text-gray-600 dark:text-dark-600'>
          {t('settings.apiPlatform.usageLoading')}
        </p>
      )}
      {!loading && failed && (
        <div className='mt-3 flex flex-wrap items-center gap-2'>
          <p
            role='alert'
            className='text-sm leading-6 text-red-600 dark:text-red-400'
          >
            {t('settings.apiPlatform.usageFailed')}
          </p>
          <button
            type='button'
            onClick={() => void load()}
            className='inline-flex min-h-11 items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-white/10 dark:text-dark-700 dark:hover:bg-white/5'
          >
            {t('settings.apiPlatform.usageRetry')}
          </button>
        </div>
      )}
      {!loading && !failed && summary && (
        <div className='mt-3 flex flex-col gap-4'>
          <dl className='grid grid-cols-2 gap-2 sm:grid-cols-5'>
            <div className='rounded-lg bg-gray-50 p-3 dark:bg-white/5'>
              <dt className='text-xs text-gray-600 dark:text-dark-600'>
                {t('settings.apiPlatform.usageRequests')}
              </dt>
              <dd className='mt-1 text-sm font-medium text-gray-900 dark:text-dark-800'>
                {formatCount(summary.totalRequests)}
              </dd>
            </div>
            <div className='rounded-lg bg-gray-50 p-3 dark:bg-white/5'>
              <dt className='text-xs text-gray-600 dark:text-dark-600'>
                {t('settings.apiPlatform.usageInputTokens')}
              </dt>
              <dd className='mt-1 text-sm font-medium text-gray-900 dark:text-dark-800'>
                {inputTokens === null ? '—' : formatCount(inputTokens)}
              </dd>
            </div>
            <div className='rounded-lg bg-gray-50 p-3 dark:bg-white/5'>
              <dt className='text-xs text-gray-600 dark:text-dark-600'>
                {t('settings.apiPlatform.usageOutputTokens')}
              </dt>
              <dd className='mt-1 text-sm font-medium text-gray-900 dark:text-dark-800'>
                {outputTokens === null ? '—' : formatCount(outputTokens)}
              </dd>
            </div>
            <div className='rounded-lg bg-gray-50 p-3 dark:bg-white/5'>
              <dt className='text-xs text-gray-600 dark:text-dark-600'>
                {t('settings.apiPlatform.usageTotalTokens')}
              </dt>
              <dd className='mt-1 text-sm font-medium text-gray-900 dark:text-dark-800'>
                {formatCount(summary.totalTokens)}
              </dd>
            </div>
            <div className='rounded-lg bg-gray-50 p-3 dark:bg-white/5'>
              <dt className='text-xs text-gray-600 dark:text-dark-600'>
                {t('settings.apiPlatform.usageSpend')}
              </dt>
              <dd className='mt-1 text-sm font-medium text-gray-900 dark:text-dark-800'>
                {formatSpendMicros(summary.totalPriceMicros, currency)}
                <span className='block text-xs font-normal text-gray-600 dark:text-dark-600'>
                  {formatSpendWhole(summary.totalPriceMicros, currency)}
                </span>
              </dd>
            </div>
          </dl>
          <p className='text-xs leading-5 text-gray-600 dark:text-dark-600'>
            {t('settings.apiPlatform.usageTotalsNote')}
          </p>
          {summary.byModel.length > 0 && (
            <div className='overflow-x-auto'>
              <table className='w-full text-sm'>
                <caption className='py-1 text-left text-xs text-gray-600 dark:text-dark-600'>
                  {t('settings.apiPlatform.usageByModel')}
                </caption>
                <thead>
                  <tr className='text-left text-xs text-gray-600 dark:text-dark-600'>
                    <th scope='col' className='py-1 pr-3 font-medium'>
                      {t('settings.apiPlatform.usageModel')}
                    </th>
                    <th scope='col' className='py-1 pr-3 font-medium'>
                      {t('settings.apiPlatform.usageRequests')}
                    </th>
                    <th scope='col' className='py-1 pr-3 font-medium'>
                      {t('settings.apiPlatform.usageTotalTokens')}
                    </th>
                    <th scope='col' className='py-1 font-medium'>
                      {t('settings.apiPlatform.usageSpend')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {summary.byModel.map(row => (
                    <tr
                      key={row.modelAliasId}
                      className='border-t border-gray-200/70 text-gray-900 dark:border-white/[0.08] dark:text-dark-800'
                    >
                      <td className='py-1 pr-3'>{row.modelAliasId}</td>
                      <td className='py-1 pr-3'>{formatCount(row.requests)}</td>
                      <td className='py-1 pr-3'>{formatCount(row.tokens)}</td>
                      <td className='py-1'>
                        {formatSpendMicros(row.priceMicros, currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {(records ?? []).length > 0 && (
            <div className='overflow-x-auto'>
              <table className='w-full text-sm'>
                <caption className='py-1 text-left text-xs text-gray-600 dark:text-dark-600'>
                  {t('settings.apiPlatform.usageRecent')}
                </caption>
                <thead>
                  <tr className='text-left text-xs text-gray-600 dark:text-dark-600'>
                    <th scope='col' className='py-1 pr-3 font-medium'>
                      {t('settings.apiPlatform.usageOccurredAt')}
                    </th>
                    <th scope='col' className='py-1 pr-3 font-medium'>
                      {t('settings.apiPlatform.usageModel')}
                    </th>
                    <th scope='col' className='py-1 pr-3 font-medium'>
                      {t('settings.apiPlatform.usageTotalTokens')}
                    </th>
                    <th scope='col' className='py-1 font-medium'>
                      {t('settings.apiPlatform.usageSpend')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(records ?? []).slice(0, 10).map(record => (
                    <tr
                      key={record.id}
                      className='border-t border-gray-200/70 text-gray-900 dark:border-white/[0.08] dark:text-dark-800'
                    >
                      <td className='py-1 pr-3'>{textOf(record.occurredAt)}</td>
                      <td className='py-1 pr-3'>{record.modelAliasId}</td>
                      <td className='py-1 pr-3'>
                        {formatCount(record.tokens)}
                      </td>
                      <td className='py-1'>
                        {formatSpendMicros(record.priceMicros, record.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {(records ?? []).length === 0 && (
            <p className='text-sm leading-6 text-gray-600 dark:text-dark-600'>
              {t('settings.apiPlatform.usageEmpty')}
            </p>
          )}
        </div>
      )}
    </section>
  );
};
