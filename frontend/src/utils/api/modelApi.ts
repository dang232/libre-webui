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

export const notifyModelsChanged = (): void => {
  window.dispatchEvent(new Event(MODELS_CHANGED_EVENT));
};

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

/**
 * Shared model-list curation (visibility, order, starred). Served by the
 * backend models router; unrelated to any inference provider.
 */
export const modelsApi = {
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
