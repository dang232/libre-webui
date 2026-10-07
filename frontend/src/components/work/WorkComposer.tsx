/*
 * Alcore
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
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
  ArrowUp,
  CircleAlert,
  Loader2,
  Mic,
  Paperclip,
  Square,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ModelSelector } from '@/components/ModelSelector';
import {
  composerSendButtonClass,
  composerSurfaceClass,
} from '@/components/composer/composerStyles';
import { Button } from '@/components/ui';
import { useDictation } from '@/hooks/useDictation';
import type { ChatModel } from '@/types';
import { workModelSelectionKey, type WorkModelOption } from '@/types/work';
import { cn } from '@/utils';
import {
  WORK_ATTACHMENT_MAX_FILES,
  partitionWorkAttachmentCandidates,
  readWorkAttachmentDraft,
  type WorkAttachmentDraft,
  type WorkAttachmentRejectionNote,
} from '@/utils/workAttachments';

interface WorkComposerProps {
  models: WorkModelOption[];
  selectorModels: ChatModel[];
  modelKey: string;
  running: boolean;
  loading: boolean;
  variant?: 'landing' | 'task';
  disabled?: boolean;
  /** Hired agents offered by the @-mention picker (excludes this task). */
  mentionAgents?: Array<{ id: string; name: string }>;
  /** Dictation ownership: a recording dies when this changes (task id). */
  dictationOwnerKey?: string;
  /** Delegated goal seeding the new-task composer once when empty. */
  initialMessage?: string;
  remoteDisclosureDismissed: boolean;
  remoteDisclosureSaving: boolean;
  onModelChange: (modelKey: string) => void | Promise<void>;
  onDismissRemoteDisclosure: () => Promise<boolean>;
  onModelsRefresh: () => void | Promise<void>;
  onSubmit: (message: string, files: WorkAttachmentDraft[]) => Promise<boolean>;
  onCancel: () => void | Promise<void>;
}

const workSelectorModelValue = (model: ChatModel): string =>
  workModelSelectionKey({
    model: model.name,
    providerType: model.isPlugin ? 'plugin' : 'ollama',
    providerId: model.isPlugin ? model.pluginId : undefined,
  });

const workSelectorModelLabel = (model: ChatModel): string => {
  const pathSegments = model.name.split('/').filter(Boolean);
  const modelName = pathSegments[pathSegments.length - 1] || model.name;
  const readableModelName =
    pathSegments.length > 1 ? modelName.replace(/[-_]+/g, ' ') : modelName;

  return readableModelName;
};

const modelFromOption = (option: WorkModelOption): ChatModel => {
  const providerPrefix = `${option.model} · `;
  return {
    name: option.model,
    model: option.model,
    size: 0,
    digest: '',
    modified_at: '',
    details: {},
    isPlugin: option.providerType === 'plugin',
    pluginId: option.providerId,
    pluginName:
      option.providerType === 'plugin'
        ? option.label.startsWith(providerPrefix)
          ? option.label.slice(providerPrefix.length)
          : option.providerId
        : undefined,
  };
};

export function WorkComposer({
  models,
  selectorModels,
  modelKey,
  running,
  loading,
  variant = 'task',
  disabled = false,
  mentionAgents,
  dictationOwnerKey,
  initialMessage,
  remoteDisclosureDismissed,
  remoteDisclosureSaving,
  onModelChange,
  onDismissRemoteDisclosure,
  onModelsRefresh,
  onSubmit,
  onCancel,
}: WorkComposerProps) {
  const { t } = useTranslation();
  const [message, setMessage] = useState(initialMessage ?? '');
  const appliedInitialRef = useRef<string | null>(initialMessage ?? null);
  useEffect(() => {
    if (!initialMessage) return;
    if (appliedInitialRef.current === initialMessage) return;
    // Seed only an empty composer so typed text and unsent drafts win.
    if (message.trim()) {
      appliedInitialRef.current = initialMessage;
      return;
    }
    appliedInitialRef.current = initialMessage;
    setMessage(initialMessage);
  }, [initialMessage, message]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Dictated text appends to whatever was typed before the mic started.
  const dictationBaseRef = useRef('');
  const dictation = useDictation({
    onStart: () => {
      dictationBaseRef.current = textareaRef.current?.value ?? '';
    },
    onText: text => {
      const base = dictationBaseRef.current;
      setMessage(base ? `${base} ${text}` : text);
    },
    ownerKey: dictationOwnerKey,
  });
  const dictationActive = dictation.phase !== 'idle';
  const [attachments, setAttachments] = useState<WorkAttachmentDraft[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const rejectionMessage = (note: WorkAttachmentRejectionNote): string => {
    if (note.reason === 'too-large') {
      return t('work.composer.attachments.attachTooLarge', {
        defaultValue: '"{{name}}" exceeds the 1 MB attachment limit.',
        name: note.name,
      });
    }
    if (note.reason === 'too-many') {
      return t('work.composer.attachments.attachTooMany', {
        defaultValue: 'Only {{max}} files can be attached at once.',
        max: WORK_ATTACHMENT_MAX_FILES,
      });
    }
    return t('work.composer.attachments.attachUnreadable', {
      defaultValue: '"{{name}}" could not be attached (empty or binary).',
      name: note.name,
    });
  };
  const addFiles = async (list: FileList | File[]): Promise<void> => {
    const incoming = Array.from(list);
    if (!incoming.length) return;
    setAttachError(null);
    const { accepted, rejected } = partitionWorkAttachmentCandidates(
      incoming,
      attachments.length
    );
    const notes = [...rejected];
    const drafts: WorkAttachmentDraft[] = [];
    for (const file of accepted) {
      const result = await readWorkAttachmentDraft(file);
      if ('draft' in result) drafts.push(result.draft);
      else notes.push(result.rejected);
    }
    if (drafts.length) {
      setAttachments(previous => [...previous, ...drafts]);
    }
    const first = notes[0];
    if (first) setAttachError(rejectionMessage(first));
  };
  const removeAttachment = (index: number): void => {
    setAttachments(previous => previous.filter((_, i) => i !== index));
  };
  const desktopModelTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileModelTriggerRef = useRef<HTMLButtonElement>(null);
  const selectedModel = models.find(item => item.key === modelKey);
  const remoteProvider = selectedModel?.remote === true;
  const landing = variant === 'landing';
  const effectiveSelectorModels = useMemo(() => {
    const availableValues = new Set(selectorModels.map(workSelectorModelValue));
    const persistedModels = models
      .filter(option => !availableValues.has(option.key))
      .map(modelFromOption);
    return [...selectorModels, ...persistedModels];
  }, [models, selectorModels]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
  }, [message]);

  const dismissRemoteDisclosure = async () => {
    if (await onDismissRemoteDisclosure()) {
      const triggers = [
        desktopModelTriggerRef.current,
        mobileModelTriggerRef.current,
      ];
      const visibleTrigger = triggers.find(
        trigger => trigger && trigger.offsetParent !== null
      );
      (visibleTrigger || desktopModelTriggerRef.current)?.focus();
    }
  };

  const changeModel = (value: string) => {
    const option =
      models.find(item => item.key === value) ||
      models.find(
        item => item.providerType === 'ollama' && item.model === value
      );
    if (option) void onModelChange(option.key);
  };

  const submit = async () => {
    const trimmed = message.trim();
    // A running task still accepts messages: they reach the agent at its
    // next round without stopping the run.
    if (!trimmed || loading || disabled || (!running && !selectedModel)) {
      return;
    }
    if (await onSubmit(trimmed, attachments)) {
      setMessage('');
      setAttachments([]);
      setAttachError(null);
    }
  };

  // @-mention picker over the user's other hired agents. The mention is
  // plain text; the agent's roster and message_agent tool do the rest.
  const [mention, setMention] = useState<{
    start: number;
    end: number;
    query: string;
  } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const detectMention = (value: string, caret: number) => {
    if (!mentionAgents?.length) {
      setMention(null);
      return;
    }
    const match = /(?:^|\s)@([^\n@]{0,60})$/.exec(value.slice(0, caret));
    if (!match) {
      setMention(null);
      return;
    }
    const query = match[1];
    setMention({ start: caret - query.length - 1, end: caret, query });
    setMentionIndex(0);
  };
  const mentionMatches =
    mention === null
      ? []
      : (mentionAgents ?? []).filter(agent =>
          agent.name
            .toLowerCase()
            .startsWith(mention.query.trimStart().toLowerCase())
        );
  const mentionOpen = mention !== null && mentionMatches.length > 0;
  const applyMention = (agent: { id: string; name: string }) => {
    if (!mention) return;
    const next = `${message.slice(0, mention.start)}@${agent.name} ${message.slice(mention.end)}`;
    const caret = mention.start + agent.name.length + 2;
    setMessage(next);
    setMention(null);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(caret, caret);
    });
  };

  return (
    <div
      data-testid={landing ? 'work-landing-composer' : 'work-task-composer'}
      data-variant={variant}
      className={cn(
        'relative shrink-0',
        landing
          ? 'mt-6 w-full'
          : 'border-t border-line bg-surface/95 px-3 py-3 backdrop-blur md:px-5'
      )}
    >
      {remoteProvider && !remoteDisclosureDismissed && (
        <div
          className={cn(
            'mx-auto mb-3 max-w-3xl',
            !landing && 'absolute inset-x-3 bottom-full z-30 md:inset-x-5'
          )}
        >
          <aside
            data-testid='work-provider-disclosure-popover'
            aria-labelledby='work-provider-disclosure-title'
            aria-live='polite'
            className='relative rounded-2xl border border-warning-500/40 bg-surface-overlay p-3 pe-10 shadow-overlay backdrop-blur dark:border-warning-500/45'
          >
            <button
              type='button'
              onClick={() => void dismissRemoteDisclosure()}
              disabled={remoteDisclosureSaving}
              className='absolute end-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-warning-500/20 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning-500 disabled:cursor-wait disabled:opacity-50'
              aria-label={t('work.composer.remoteDismissLabel', {
                defaultValue: 'Dismiss remote provider notice',
              })}
            >
              <X className='h-4 w-4' />
            </button>
            <div className='flex items-start gap-3'>
              <div className='mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-warning-500/20'>
                <CircleAlert
                  data-testid='work-provider-disclosure-accent'
                  className='h-4 w-4 text-warning-500'
                  aria-hidden='true'
                />
              </div>
              <div className='min-w-0 flex-1'>
                <p
                  id='work-provider-disclosure-title'
                  className='text-sm font-semibold text-ink'
                >
                  {t('work.composer.remoteTitle', {
                    defaultValue: 'Remote provider',
                  })}
                </p>
                <p className='mt-0.5 text-xs leading-relaxed text-ink-muted'>
                  {t('work.composer.remoteHint', {
                    defaultValue:
                      'Conversation and tool output are sent to the configured service. One autonomous run can make multiple provider calls and may incur charges. Workspace files stay local unless a tool returns their contents.',
                  })}
                </p>
                <div className='mt-2.5 flex justify-end'>
                  <Button
                    data-testid='work-provider-disclosure-dismiss'
                    type='button'
                    variant='ghost'
                    size='sm'
                    loading={remoteDisclosureSaving}
                    className='h-7 border-warning-500 bg-warning-500 px-2.5 text-xs text-[#3d120c] hover:bg-warning-500/90 hover:text-[#3d120c]'
                    onClick={() => void dismissRemoteDisclosure()}
                  >
                    {t('work.composer.remoteDismiss', {
                      defaultValue: 'Dismiss',
                    })}
                  </Button>
                </div>
              </div>
            </div>
          </aside>
        </div>
      )}

      <form
        className='relative mx-auto w-full max-w-3xl'
        onSubmit={event => {
          event.preventDefault();
          void submit();
        }}
      >
        {mentionOpen && (
          <div
            data-testid='work-mention-menu'
            role='listbox'
            aria-label={t('work.composer.mentionAgents', {
              defaultValue: 'Mention an agent',
            })}
            className='absolute bottom-full start-2 z-40 mb-2 w-64 overflow-hidden rounded-xl border border-line bg-surface-overlay shadow-overlay backdrop-blur'
          >
            {mentionMatches.slice(0, 6).map((agent, index) => (
              <button
                key={agent.id}
                type='button'
                role='option'
                aria-selected={index === mentionIndex}
                data-testid='work-mention-option'
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-2 text-start text-sm transition-colors',
                  index === mentionIndex
                    ? 'bg-primary-500/10 text-ink'
                    : 'text-ink-muted hover:bg-surface-subtle hover:text-ink'
                )}
                onMouseDown={event => {
                  event.preventDefault();
                  applyMention(agent);
                }}
              >
                <span dir='auto' className='truncate'>
                  @{agent.name}
                </span>
              </button>
            ))}
          </div>
        )}
        <div
          data-testid='work-composer-surface'
          className={cn(
            composerSurfaceClass,
            dragActive && 'ring-2 ring-primary-500'
          )}
          onDragOver={event => {
            if (Array.from(event.dataTransfer.types).includes('Files')) {
              event.preventDefault();
              setDragActive(true);
            }
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={event => {
            event.preventDefault();
            setDragActive(false);
            if (event.dataTransfer.files.length) {
              void addFiles(event.dataTransfer.files);
            }
          }}
        >
          {attachments.length > 0 && (
            <div
              data-testid='work-attachment-list'
              className='flex flex-wrap gap-1.5 px-2 pt-2'
            >
              {attachments.map((file, index) => (
                <span
                  key={`${file.name}-${index}`}
                  data-testid='work-attachment-chip'
                  className='inline-flex max-w-full items-center gap-1 rounded-lg border border-line bg-surface-subtle px-2 py-1 text-xs text-ink'
                >
                  <span className='max-w-[180px] truncate'>{file.name}</span>
                  <button
                    type='button'
                    data-testid='work-attachment-remove'
                    aria-label={t(
                      'work.composer.attachments.removeAttachment',
                      { defaultValue: 'Remove attachment' }
                    )}
                    onClick={() => removeAttachment(index)}
                    className='inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-ink-muted transition-colors hover:text-ink'
                  >
                    <X className='h-3 w-3' />
                  </button>
                </span>
              ))}
            </div>
          )}
          {attachError && (
            <p
              role='alert'
              className='px-2 pt-1.5 text-xs text-error-600 dark:text-error-400'
            >
              {attachError}
            </p>
          )}
          <input
            ref={fileInputRef}
            data-testid='work-attach-input'
            type='file'
            multiple
            accept='.txt,.md,.markdown,.csv,.tsv,.json,.jsonl,.log,.yaml,.yml,.toml,.xml,.html,.css,.js,.jsx,.ts,.tsx,.py,.sh,.sql,.graphql,.ini,.cfg,.env,.tex,.rst,.java,.c,.h,.cpp,.hpp,.cs,.go,.rs,.rb,.php,.swift,.kt'
            className='hidden'
            onChange={event => {
              if (event.target.files?.length) {
                void addFiles(event.target.files);
              }
              event.currentTarget.value = '';
            }}
          />
          <textarea
            ref={textareaRef}
            data-testid='work-composer-input'
            dir='auto'
            value={message}
            onChange={event => {
              setMessage(event.target.value);
              detectMention(
                event.target.value,
                event.target.selectionStart ?? event.target.value.length
              );
            }}
            onClick={event =>
              detectMention(
                event.currentTarget.value,
                event.currentTarget.selectionStart ??
                  event.currentTarget.value.length
              )
            }
            onBlur={() => setMention(null)}
            onKeyDown={event => {
              if (mentionOpen) {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  const shown = Math.min(mentionMatches.length, 6);
                  setMentionIndex(current =>
                    event.key === 'ArrowDown'
                      ? (current + 1) % shown
                      : (current - 1 + shown) % shown
                  );
                  return;
                }
                if (event.key === 'Enter' || event.key === 'Tab') {
                  event.preventDefault();
                  applyMention(mentionMatches[mentionIndex]);
                  return;
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setMention(null);
                  return;
                }
              }
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
            disabled={disabled}
            rows={1}
            className={cn(
              'm-0 block max-h-[160px] w-full resize-none overflow-y-auto rounded-none border-0 bg-transparent px-2 pt-1.5 pb-2 text-[0.9375rem] leading-relaxed text-ink shadow-none outline-none placeholder:text-ink-subtle focus:border-0 focus:bg-transparent focus:ring-0 disabled:cursor-not-allowed disabled:opacity-60',
              landing ? 'min-h-20' : 'min-h-9'
            )}
            placeholder={t('work.composer.placeholder', {
              defaultValue: 'Describe what you want to build or change…',
            })}
          />

          <div className='mt-1 flex min-w-0 items-center gap-2'>
            <div className='hidden min-w-0 flex-1 sm:block'>
              <ModelSelector
                models={effectiveSelectorModels}
                selectedModel={modelKey}
                onModelChange={event => changeModel(event.target.value)}
                onModelsRefresh={() => void onModelsRefresh()}
                getModelValue={workSelectorModelValue}
                getModelLabel={workSelectorModelLabel}
                getModelTitle={model => model.name}
                triggerRef={desktopModelTriggerRef}
                triggerTestId='work-model-selector-trigger'
                selectTestId='work-model-select'
                ariaLabel={t('work.composer.model', {
                  defaultValue: 'Work model',
                })}
                disabled={running || models.length === 0}
                className='min-w-0 w-full max-w-[230px]'
                compact
              />
            </div>

            <div className='min-w-0 flex-1 sm:hidden'>
              <ModelSelector
                models={effectiveSelectorModels}
                selectedModel={modelKey}
                onModelChange={event => changeModel(event.target.value)}
                onModelsRefresh={() => void onModelsRefresh()}
                getModelValue={workSelectorModelValue}
                getModelLabel={workSelectorModelLabel}
                getModelTitle={model => model.name}
                triggerRef={mobileModelTriggerRef}
                triggerTestId='work-model-selector-trigger-mobile'
                selectTestId='work-model-select-mobile'
                ariaLabel={t('work.composer.model', {
                  defaultValue: 'Work model',
                })}
                disabled={running || models.length === 0}
                className='min-w-0 w-full'
                compact
              />
            </div>

            <Button
              data-testid='work-attach-button'
              type='button'
              variant='ghost'
              size='sm'
              disabled={disabled}
              title={t('work.composer.attachments.attachFiles', {
                defaultValue: 'Attach files',
              })}
              aria-label={t('work.composer.attachments.attachFiles', {
                defaultValue: 'Attach files',
              })}
              onClick={() => fileInputRef.current?.click()}
              className='flex h-9 w-9 shrink-0 touch-manipulation items-center justify-center rounded-full p-0 text-ink-muted transition-colors duration-150 hover:bg-surface-subtle hover:text-ink'
            >
              <Paperclip className='h-4 w-4' />
            </Button>
            {dictation.supported && (
              <Button
                data-testid='work-voice-input'
                type='button'
                variant='ghost'
                size='sm'
                disabled={disabled}
                aria-pressed={dictationActive}
                className={cn(
                  'flex h-9 w-9 shrink-0 touch-manipulation items-center justify-center rounded-full p-0 transition-colors duration-150',
                  dictationActive
                    ? 'animate-pulse bg-red-50 text-red-500 dark:bg-red-900/20'
                    : 'text-ink-muted hover:bg-surface-subtle hover:text-ink'
                )}
                title={
                  dictationActive
                    ? t('chat.input.voiceStop')
                    : t('chat.input.voiceInput')
                }
                aria-label={
                  dictationActive
                    ? t('chat.input.voiceStop')
                    : t('chat.input.voiceInput')
                }
                onClick={() => void dictation.toggle()}
              >
                {dictation.phase === 'starting' ? (
                  <Loader2 className='h-4 w-4 animate-spin' />
                ) : dictation.phase === 'transcribing' ? (
                  <Square className='h-4 w-4 fill-current' />
                ) : (
                  <Mic className='h-4 w-4' />
                )}
              </Button>
            )}
            {running && (
              <Button
                data-testid='work-cancel-button'
                type='button'
                variant='ghost'
                size='sm'
                disabled={loading}
                className='flex h-9 w-9 shrink-0 touch-manipulation items-center justify-center rounded-full bg-error-500/15 p-0 text-error-600 transition-colors duration-150 hover:bg-error-500/25 dark:text-error-400'
                title={t('work.composer.cancel', { defaultValue: 'Stop' })}
                aria-label={t('work.composer.cancel', {
                  defaultValue: 'Stop',
                })}
                onClick={() => void onCancel()}
              >
                {loading ? (
                  <Loader2 className='h-4 w-4 animate-spin' />
                ) : (
                  <Square className='h-4 w-4 fill-current' />
                )}
              </Button>
            )}
            {
              <Button
                data-testid='work-submit-button'
                type='submit'
                variant='primary'
                size='sm'
                disabled={
                  loading ||
                  disabled ||
                  !message.trim() ||
                  (!running && !selectedModel)
                }
                className={composerSendButtonClass}
                title={t('work.composer.send', { defaultValue: 'Run' })}
                aria-label={t('work.composer.send', {
                  defaultValue: 'Run',
                })}
              >
                {loading ? (
                  <Loader2 className='h-4 w-4 animate-spin' />
                ) : (
                  <ArrowUp className='h-4 w-4' />
                )}
              </Button>
            }
          </div>
        </div>
      </form>
    </div>
  );
}
