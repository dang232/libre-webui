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

import {
  BookOpen,
  ExternalLink,
  Globe,
  MessageSquare,
  ScrollText,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Logo } from '@/components/Logo';
import { LogoMark } from '@/components/LogoMark';

interface SettingsAboutTabProps {
  appVersion: string;
}

const aboutLinks = [
  {
    href: 'https://alcore.io.vn',
    icon: Globe,
    labelKey: 'settings.about.links.website',
    descriptionKey: 'settings.about.links.websiteDescription',
  },
  {
    href: 'https://alcore.io.vn',
    icon: BookOpen,
    labelKey: 'settings.about.links.documentation',
    descriptionKey: 'settings.about.links.documentationDescription',
  },
  {
    href: 'https://github.com/dang232/libre-webui/issues',
    icon: MessageSquare,
    labelKey: 'settings.about.links.reportIssue',
    descriptionKey: 'settings.about.links.reportIssueDescription',
  },
];

const featureKeys = [
  'settings.about.features.privacy',
  'settings.about.features.openSource',
  'settings.about.features.localInference',
];

export function SettingsAboutTab({ appVersion }: SettingsAboutTabProps) {
  const { t } = useTranslation();
  const hasReleaseNotes = Boolean(__LATEST_RELEASE_NOTES__);

  return (
    <div className='space-y-6'>
      <div>
        <div className='mb-4 flex items-center gap-2.5 text-gray-900 dark:text-gray-100'>
          <LogoMark size='md' label={null} />
          <Logo />
        </div>
        <div className='text-sm text-gray-700 dark:text-gray-300 mb-6'>
          <span>{t('settings.about.title')}</span>
        </div>
        <div className='bg-gray-50 dark:bg-dark-100 rounded-lg p-6 border border-gray-200 dark:border-dark-300'>
          <div className='space-y-4 text-sm text-gray-700 dark:text-gray-300'>
            {featureKeys.map(key => (
              <div key={key} className='flex items-start gap-3'>
                <div className='w-2 h-2 bg-primary-500 rounded-full mt-2 shrink-0'></div>
                <div>
                  <p className='font-semibold text-gray-900 dark:text-gray-100 mb-1'>
                    {t(`${key}.title`)}
                  </p>
                  <p>{t(`${key}.description`)}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className='mt-6 space-y-4'>
          <h4 className='text-sm font-semibold text-gray-900 dark:text-gray-100'>
            {t('settings.about.links.title')}
          </h4>
          <div className='grid grid-cols-1 sm:grid-cols-2 gap-3'>
            {aboutLinks.map(link => {
              const Icon = link.icon;

              return (
                <a
                  key={link.labelKey}
                  href={link.href}
                  target='_blank'
                  rel='noopener noreferrer'
                  className='flex items-center gap-3 p-3 bg-white dark:bg-dark-100 border border-gray-200 dark:border-dark-300 rounded-lg hover:bg-gray-50 dark:hover:bg-dark-200 hover:border-gray-300 dark:hover:border-dark-400 transition-all duration-200 group'
                >
                  <Icon className='h-5 w-5 text-gray-600 dark:text-gray-400 group-hover:text-gray-900 dark:group-hover:text-gray-200' />
                  <div>
                    <p className='text-sm font-medium text-gray-900 dark:text-gray-100'>
                      {t(link.labelKey)}
                    </p>
                    <p className='text-xs text-gray-500 dark:text-gray-400'>
                      {t(link.descriptionKey)}
                    </p>
                  </div>
                  <ExternalLink className='h-4 w-4 text-gray-400 ms-auto opacity-0 group-hover:opacity-100 transition-opacity' />
                </a>
              );
            })}
          </div>
        </div>

        <div className='mt-6 p-4 bg-gray-50 dark:bg-dark-100 border border-gray-200 dark:border-dark-300 rounded-lg'>
          <div className='flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs'>
            <div className='flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5'>
              <span className='text-gray-500 dark:text-gray-400'>
                {t('settings.about.version', { version: appVersion })}
              </span>
              {hasReleaseNotes && (
                <button
                  type='button'
                  onClick={() =>
                    window.dispatchEvent(new Event('alcore:open-whats-new'))
                  }
                  className='inline-flex items-center gap-1.5 text-gray-500 transition-colors hover:text-gray-900 dark:text-gray-400 dark:hover:text-dark-900'
                  data-testid='about-view-changelog'
                >
                  <ScrollText className='h-3.5 w-3.5' />
                  {t('settings.about.updates.viewChangelog')}
                </button>
              )}
            </div>
            <span className='text-gray-500 dark:text-gray-400'>
              {t('settings.about.openSourceBy', { company: '' })}
              <a
                href='https://kroonen.ai'
                target='_blank'
                rel='noopener noreferrer'
                className='text-primary-600 dark:text-primary-400 hover:text-primary-700 dark:hover:text-primary-300 transition-colors'
              >
                Kroonen AI
              </a>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
