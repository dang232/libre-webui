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
 * Exporting artifact previews: printing (PDF via the browser) and CSV for
 * rendered tables. Table data lives inside the sandboxed preview frame,
 * which the page cannot read directly, so tables are requested over the
 * sandbox message channel and answered by the host document.
 */

export const ARTIFACT_TABLES_REQUEST = 'libre-artifact:tables-request';
export const ARTIFACT_TABLES_RESPONSE = 'libre-artifact:tables';

/** One tableful of cell text: tables of rows of cells. */
export type PreviewTables = string[][][];

const CSV_CELL_NEEDS_QUOTES = /[",\n\r]/;

/** Quote one CSV cell per RFC 4180; plain cells pass through untouched. */
export function escapeCsvCell(value: string): string {
  if (!CSV_CELL_NEEDS_QUOTES.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Serialize preview tables to CSV. Tables join with a blank line so a
 * multi-table artifact stays readable; rows join with CRLF per RFC 4180.
 */
export function tablesToCsv(tables: PreviewTables): string {
  return tables
    .map(rows =>
      rows.map(cells => cells.map(escapeCsvCell).join(',')).join('\r\n')
    )
    .join('\r\n\r\n');
}

export interface PreviewTablesOptions {
  timeoutMs?: number;
  /** Nonce factory; random per request by default, fixed in tests. */
  nonce?: () => string;
}

const DEFAULT_TABLES_TIMEOUT_MS = 3000;

const isStringTable = (value: unknown): value is string[][][] =>
  Array.isArray(value) &&
  value.every(
    table =>
      Array.isArray(table) &&
      table.every(
        row => Array.isArray(row) && row.every(cell => typeof cell === 'string')
      )
  );

/**
 * Ask the sandbox host for its rendered tables. Resolves `null` when the
 * frame is missing, the host never answers, or the answer is malformed —
 * callers treat that as "no exportable tables".
 */
export function requestPreviewTables(
  frame: HTMLIFrameElement | null | undefined,
  options: PreviewTablesOptions = {}
): Promise<PreviewTables | null> {
  const target = frame?.contentWindow;
  if (!target || typeof window === 'undefined') return Promise.resolve(null);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TABLES_TIMEOUT_MS;
  const nonce = (
    options.nonce ?? (() => Math.random().toString(36).slice(2))
  )();
  return new Promise(resolve => {
    let settled = false;
    const finish = (tables: PreviewTables | null): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(tables);
    };
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== target) return;
      const data = event.data as {
        type?: unknown;
        nonce?: unknown;
        tables?: unknown;
      } | null;
      if (!data || data.type !== ARTIFACT_TABLES_RESPONSE) return;
      if (data.nonce !== nonce) return;
      finish(isStringTable(data.tables) ? data.tables : null);
    };
    const timer = window.setTimeout(() => finish(null), timeoutMs);
    window.addEventListener('message', onMessage);
    target.postMessage({ type: ARTIFACT_TABLES_REQUEST, nonce }, '*');
  });
}

/** Download text as a file through a temporary anchor. */
export function downloadTextFile(
  filename: string,
  content: string,
  mimeType: string
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
