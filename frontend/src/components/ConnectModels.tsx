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

import React, { useState } from 'react';
import { toast } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { Server, Check, PlugZap, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui';
import { pluginApi } from '@/utils/api';
import { useAuthStore } from '@/store/authStore';
import { useChatStore } from '@/store/chatStore';
import { cn } from '@/utils';
import { customKeyEnv, customProviderId } from '@/utils/customProvider';
import { createLogger } from '@/utils/logger';
import type { Plugin } from '@/types';

const logger = createLogger('components:connect-models');

/**
 * Local OpenAI-compatible servers. They all speak /v1, so one flow covers
 * every engine — only the default port and the display name differ.
 */
const LOCAL_PRESETS = [
  { id: 'vllm', name: 'vLLM', baseUrl: 'http://localhost:8000/v1' },
  { id: 'llama-swap', name: 'llama-swap', baseUrl: 'http://localhost:8080/v1' },
  { id: 'lm-studio', name: 'LM Studio', baseUrl: 'http://localhost:1234/v1' },
] as const;

interface ConnectModelsProps {
  /** 'setup' renders wizard-sized cards; 'inline' fits the chat empty state. */
  variant?: 'setup' | 'inline';
  onDone?: () => void;
}

export const ConnectModels: React.FC<ConnectModelsProps> = ({
  variant = 'setup',
  onDone,
}) => {
  const { t } = useTranslation();
  const { user, systemInfo } = useAuthStore();
  const loadModels = useChatStore(state => state.loadModels);
  const isAdmin = user?.role === 'admin' || systemInfo?.requiresAuth === false;

  const [openSection, setOpenSection] = useState<'local' | null>(null);

  // Local-server form
  const [preset, setPreset] = useState<(typeof LOCAL_PRESETS)[number]>(
    LOCAL_PRESETS[0]
  );
  const [localUrl, setLocalUrl] = useState<string>(LOCAL_PRESETS[0].baseUrl);
  const [localName, setLocalName] = useState<string>(LOCAL_PRESETS[0].name);
  const [localKey, setLocalKey] = useState('');
  const [probing, setProbing] = useState(false);
  const [probedModels, setProbedModels] = useState<string[] | null>(null);
  const [enablingLocal, setEnablingLocal] = useState(false);

  const handleProbe = async () => {
    setProbing(true);
    setProbedModels(null);
    try {
      const response = await pluginApi.probeEndpoint(localUrl, 'openai');
      if (response.success && response.data?.reachable) {
        setProbedModels(response.data.models);
        toast.success(
          t('connectModels.local.reachable', {
            count: response.data.models.length,
          })
        );
      } else {
        setProbedModels([]);
        toast.error(response.message || t('connectModels.local.unreachable'));
      }
    } catch (error) {
      logger.error('Endpoint probe failed:', error);
      setProbedModels([]);
      toast.error(t('connectModels.local.unreachable'));
    } finally {
      setProbing(false);
    }
  };

  const handleEnableLocal = async () => {
    setEnablingLocal(true);
    try {
      const displayName = localName.trim() || preset.name;
      const trimmed = localUrl.replace(/\/+$/, '');
      const root = trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
      // Custom names get their own provider id so several endpoints can
      // coexist. A name resolving to an installed id with the same root
      // updates that entry in place instead of duplicating it.
      const installedResponse = await pluginApi.getAllPlugins();
      const installedPlugins =
        installedResponse.success && installedResponse.data
          ? installedResponse.data
          : [];
      const takenIds = installedPlugins.map(plugin => plugin.id);
      const baseId = customProviderId(displayName, []);
      const baseMatch = installedPlugins.find(plugin => plugin.id === baseId);
      const id =
        baseMatch && baseMatch.base_url === root
          ? baseId
          : customProviderId(displayName, takenIds);
      const usesKey = localKey.trim().length > 0;
      const keyEnv = customKeyEnv(id);
      const definition: Omit<Plugin, 'created_at' | 'updated_at'> = {
        id,
        name: displayName,
        type: 'completion',
        endpoint: `${root}/chat/completions`,
        api_mode: 'chat_completions',
        base_url: root,
        auth: usesKey
          ? { header: 'Authorization', prefix: 'Bearer ', key_env: keyEnv }
          : { header: '', prefix: '', key_env: '' },
        model_map: (probedModels ?? []).slice(0, 50),
      };
      const installed = await pluginApi.installPlugin(definition);
      if (!installed.success) {
        // Already-installed entries are updated in place, but only when the
        // stored root matches — a colliding id with another root surfaces
        // the failure instead of overwriting it.
        const existing = installedPlugins.find(plugin => plugin.id === id);
        if (!existing || existing.base_url !== root) {
          toast.error(t('connectModels.local.enableFailed'));
          return;
        }
        const updated = await pluginApi.updatePlugin(id, definition);
        if (!updated.success) {
          toast.error(t('connectModels.local.enableFailed'));
          return;
        }
      }
      if (usesKey) {
        await pluginApi.setApiKey(id, localKey.trim());
      }
      await pluginApi.activatePlugin(id);
      await loadModels({ quiet: true });
      toast.success(t('connectModels.local.enabled', { name: displayName }));
      onDone?.();
    } catch (error) {
      logger.error('Failed to enable local provider:', error);
      toast.error(t('connectModels.local.enableFailed'));
    } finally {
      setEnablingLocal(false);
    }
  };

  const cardClass =
    'rounded-2xl border border-gray-200/80 bg-white/80 p-4 dark:border-white/10 dark:bg-white/[0.04]';
  const inputClass =
    'w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-primary-400 focus:outline-none dark:border-white/10 dark:bg-white/[0.035] dark:text-dark-800 dark:placeholder-dark-500';

  return (
    <div
      className={cn(
        'flex w-full flex-col gap-3',
        variant === 'setup' ? 'max-w-lg' : 'max-w-lg'
      )}
    >
      {/* ------------------------------------------------ Local server */}
      <div className={cardClass}>
        <button
          type='button'
          className='flex w-full items-center gap-3 text-start'
          onClick={() =>
            setOpenSection(openSection === 'local' ? null : 'local')
          }
        >
          <div className='rounded-xl border border-gray-200 bg-gray-50 p-2 dark:border-white/10 dark:bg-white/[0.05]'>
            <Server className='h-5 w-5 text-gray-700 dark:text-dark-700' />
          </div>
          <div className='min-w-0 flex-1'>
            <span className='text-sm font-medium text-gray-900 dark:text-dark-900'>
              {t('connectModels.local.title')}
            </span>
            <p className='truncate text-xs text-gray-500 dark:text-dark-500'>
              {t('connectModels.local.subtitle')}
            </p>
          </div>
          <ChevronRight
            className={cn(
              'h-4 w-4 text-gray-400 transition-transform',
              openSection === 'local' && 'rotate-90'
            )}
          />
        </button>

        {openSection === 'local' && (
          <div className='mt-4 flex flex-col gap-3'>
            {!isAdmin ? (
              <p className='text-xs text-gray-500 dark:text-dark-500'>
                {t('connectModels.adminOnly')}
              </p>
            ) : (
              <>
                <div className='flex flex-wrap gap-1.5'>
                  {LOCAL_PRESETS.map(candidate => (
                    <button
                      key={candidate.id}
                      type='button'
                      onClick={() => {
                        setPreset(candidate);
                        setLocalName(candidate.name);
                        setLocalUrl(candidate.baseUrl);
                        setProbedModels(null);
                      }}
                      className={cn(
                        'rounded-full border px-3 py-1 text-xs transition-colors',
                        preset.id === candidate.id
                          ? 'border-primary-400 bg-primary-500/10 text-primary-600 dark:text-primary-400'
                          : 'border-gray-200 text-gray-600 hover:border-gray-300 dark:border-white/10 dark:text-dark-600'
                      )}
                    >
                      {candidate.name}
                    </button>
                  ))}
                </div>
                <input
                  className={inputClass}
                  value={localName}
                  onChange={event => setLocalName(event.target.value)}
                  placeholder={t('connectModels.local.nameLabel')}
                  aria-label={t('connectModels.local.nameLabel')}
                  spellCheck={false}
                />
                <input
                  className={inputClass}
                  value={localUrl}
                  onChange={event => {
                    setLocalUrl(event.target.value);
                    setProbedModels(null);
                  }}
                  placeholder='http://localhost:8080/v1'
                  spellCheck={false}
                />
                <input
                  className={inputClass}
                  value={localKey}
                  onChange={event => setLocalKey(event.target.value)}
                  placeholder={t('connectModels.local.keyPlaceholder')}
                  type='password'
                  autoComplete='off'
                />
                <div className='flex items-center gap-2'>
                  <Button
                    variant='outline'
                    size='sm'
                    onClick={() => void handleProbe()}
                    disabled={probing || !localUrl.trim()}
                  >
                    <PlugZap className='me-1.5 h-4 w-4' />
                    {probing
                      ? t('connectModels.local.testing')
                      : t('connectModels.local.test')}
                  </Button>
                  <Button
                    size='sm'
                    onClick={() => void handleEnableLocal()}
                    disabled={
                      enablingLocal ||
                      !probedModels ||
                      probedModels.length === 0
                    }
                  >
                    <Check className='me-1.5 h-4 w-4' />
                    {enablingLocal
                      ? t('connectModels.local.enabling')
                      : t('connectModels.local.enable')}
                  </Button>
                </div>
                {probedModels && probedModels.length > 0 && (
                  <div className='flex flex-wrap gap-1'>
                    {probedModels.slice(0, 8).map(model => (
                      <span
                        key={model}
                        className='rounded-md bg-gray-100 px-2 py-0.5 font-mono text-[10px] text-gray-700 dark:bg-white/[0.06] dark:text-dark-700'
                      >
                        {model}
                      </span>
                    ))}
                    {probedModels.length > 8 && (
                      <span className='px-1 text-[10px] text-gray-400'>
                        +{probedModels.length - 8}
                      </span>
                    )}
                  </div>
                )}
                {probedModels && probedModels.length === 0 && (
                  <p className='text-xs text-red-500'>
                    {t('connectModels.local.noModels')}
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {variant === 'setup' && (
        <div className='mt-1 text-center'>
          <button
            type='button'
            onClick={() => onDone?.()}
            className='text-sm text-gray-500 underline-offset-4 hover:underline dark:text-dark-500'
          >
            {t('connectModels.skip')}
          </button>
        </div>
      )}
    </div>
  );
};
