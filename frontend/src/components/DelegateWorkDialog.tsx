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
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui';
import {
  ModalShell,
  modalFieldClass,
  modalLabelClass,
} from '@/components/ui/ModalShell';

export interface DelegateWorkInput {
  goal: string;
  hostPath?: string;
}

/**
 * Build the task payload from dialog state. A blank goal is unusable and
 * a host folder from a non-admin is dropped, never sent: folder grants
 * stay an admin-only server decision.
 */
export function buildDelegateWorkPayload(
  goal: string,
  hostPath: string,
  isAdmin: boolean
): DelegateWorkInput | null {
  const trimmedGoal = goal.trim();
  if (trimmedGoal.length === 0) return null;
  const trimmedPath = hostPath.trim();
  return {
    goal: trimmedGoal,
    ...(isAdmin && trimmedPath ? { hostPath: trimmedPath } : {}),
  };
}

interface DelegateWorkDialogProps {
  initialGoal: string;
  isAdmin: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (input: DelegateWorkInput) => void;
}

/**
 * Turns one chat message into a Work task: the message becomes the agent's
 * goal in an isolated workspace with files, shell, and tools. Admins may
 * also bind a host folder, which the server allowlists and mounts
 * read-write at /workspace; everyone else gets a fresh empty workspace.
 */
export const DelegateWorkDialog: React.FC<DelegateWorkDialogProps> = ({
  initialGoal,
  isAdmin,
  busy,
  error,
  onClose,
  onSubmit,
}) => {
  const { t } = useTranslation();
  const [goal, setGoal] = useState(initialGoal);
  const [hostPath, setHostPath] = useState('');
  const ready = goal.trim().length > 0 && !busy;
  const submit = () => {
    const payload = buildDelegateWorkPayload(goal, hostPath, isAdmin);
    if (payload) onSubmit(payload);
  };

  return (
    <ModalShell
      titleId='delegate-work-title'
      title={t('chat.delegate.title')}
      subtitle={t('chat.delegate.subtitle')}
      onClose={onClose}
      testId='delegate-work-dialog'
      footer={
        <>
          <Button variant='ghost' onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant='primary'
            disabled={!ready}
            onClick={submit}
            data-testid='delegate-work-submit'
          >
            {busy ? t('chat.delegate.creating') : t('chat.delegate.submit')}
          </Button>
        </>
      }
    >
      <label className={modalLabelClass} htmlFor='delegate-work-goal'>
        {t('chat.delegate.goalLabel')}
      </label>
      <textarea
        id='delegate-work-goal'
        value={goal}
        onChange={event => setGoal(event.target.value)}
        rows={5}
        className={modalFieldClass}
        data-testid='delegate-work-goal'
      />
      {isAdmin && (
        <>
          <label
            className={`${modalLabelClass} mt-4`}
            htmlFor='delegate-work-folder'
          >
            {t('chat.delegate.folderLabel')}
          </label>
          <input
            id='delegate-work-folder'
            value={hostPath}
            onChange={event => setHostPath(event.target.value)}
            placeholder={t('chat.delegate.folderPlaceholder')}
            className={modalFieldClass}
            data-testid='delegate-work-folder'
          />
          <p className='mt-1 text-[12px] text-gray-500 dark:text-dark-500'>
            {t('chat.delegate.folderHint')}
          </p>
        </>
      )}
      {error && (
        <p className='mt-3 text-[13px] text-red-600 dark:text-red-400'>
          {error}
        </p>
      )}
    </ModalShell>
  );
};
