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

import type { ApiResponse } from '@/types';
import { isDemoMode } from '@/utils/demoMode';
import { api, createDemoResponse } from './client';

/**
 * Announces that the set of installed models changed, so every list in the
 * app can catch up.
 */
export const MODELS_CHANGED_EVENT = 'alcore:models-changed';

/** Presentation an administrator set for a single model. */
export interface ModelPresentation {
  label?: string;
  avatar?: string;
}

/** Administrator-managed model catalog: what is hidden, in what order, shown how. */
export interface ModelCatalogConfig {
  hidden: string[];
  order: string[];
  starred: string[];
  metadata: Record<string, ModelPresentation>;
}

export const modelsApi = {
  // Who may manage models: 'admins' or 'all-users', plus whether the current
  // account may manage right now.
  getModelAccess: (): Promise<
    ApiResponse<{ mode: 'admins' | 'all-users'; allowed: boolean }>
  > => {
    if (isDemoMode()) {
      return createDemoResponse({ mode: 'admins' as const, allowed: false });
    }
    return api.get('/models/access').then(res => res.data);
  },

  setModelAccess: (
    mode: 'admins' | 'all-users'
  ): Promise<ApiResponse<{ mode: 'admins' | 'all-users' }>> => {
    if (isDemoMode()) {
      return createDemoResponse({ mode });
    }
    return api.put('/models/access', { mode }).then(res => res.data);
  },

  // Shared model-list curation.
  getModelVisibility: (): Promise<ApiResponse<ModelCatalogConfig>> => {
    if (isDemoMode()) {
      return createDemoResponse({
        hidden: [],
        order: [],
        starred: [],
        metadata: {},
      });
    }
    return api.get('/models/visibility').then(res => res.data);
  },

  setModelVisibility: (
    update: Partial<ModelCatalogConfig>
  ): Promise<ApiResponse<ModelCatalogConfig>> => {
    if (isDemoMode()) {
      return createDemoResponse({
        hidden: update.hidden ?? [],
        order: update.order ?? [],
        starred: update.starred ?? [],
        metadata: update.metadata ?? {},
      });
    }
    return api.put('/models/visibility', update).then(res => res.data);
  },
};
