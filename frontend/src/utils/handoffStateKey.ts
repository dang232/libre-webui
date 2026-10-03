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

/**
 * Session-storage key binding the redirect-handoff state to one tab.
 *
 * The declaration lives in this leaf module — free of imports — because both
 * the sign-in panel (`AlcoreAuthNotice`) and the handoff state machine
 * (`canonicalHandoff`) need the SAME binding. Declaring it in either of those
 * two creates a component↔state-machine import cycle; under the production
 * bundler that cycle collapses react-hot-toast/goober into a lazy chunk and
 * the built app dies at boot (`TypeError: a is not a function` in
 * ui-vendor). Re-exports keep exactly one key in the product with no cycle.
 * See `.omo/research/alcore-auth-browser-handoff/task-8-e2e.log`.
 */
export const ALCORE_AUTH_STATE_KEY = 'alcore-auth-state';
