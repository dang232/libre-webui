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

/**
 * Client-side intake for Work composer attachments. Files are read as text
 * in the browser and land in the task workspace through the existing
 * saveFile endpoint (ownership, path containment, and the 2MB server cap
 * stay server-side). Binary content is rejected here so garbage never
 * reaches the workspace.
 */

export const WORK_ATTACHMENT_MAX_FILES = 5;

/** Stays comfortably under the server's 2,000,000 byte content cap. */
export const WORK_ATTACHMENT_MAX_BYTES = 1_000_000;

export type WorkAttachmentRejection =
  'too-many' | 'too-large' | 'not-text' | 'empty';

export interface WorkAttachmentCandidate {
  name: string;
  size: number;
  text: () => Promise<string>;
}

export interface WorkAttachmentDraft {
  name: string;
  content: string;
  size: number;
}

export interface WorkAttachmentRejectionNote {
  name: string;
  reason: WorkAttachmentRejection;
}

const TEXT_SAMPLE_CHARS = 8000;

/** True when the sample looks like binary content rather than text. */
export const looksLikeBinaryText = (sample: string): boolean =>
  sample.includes('\0');

/**
 * Split incoming files into accepted candidates and per-file rejections.
 * alreadyHeld counts files already staged in the composer so the cap spans
 * multiple drops. Pure and synchronous: reading happens later per file.
 */
export const partitionWorkAttachmentCandidates = (
  files: WorkAttachmentCandidate[],
  alreadyHeld: number
): {
  accepted: WorkAttachmentCandidate[];
  rejected: WorkAttachmentRejectionNote[];
} => {
  const accepted: WorkAttachmentCandidate[] = [];
  const rejected: WorkAttachmentRejectionNote[] = [];
  for (const file of files) {
    const name = file.name || 'unnamed';
    if (accepted.length + alreadyHeld >= WORK_ATTACHMENT_MAX_FILES) {
      rejected.push({ name, reason: 'too-many' });
      continue;
    }
    if (file.size > WORK_ATTACHMENT_MAX_BYTES) {
      rejected.push({ name, reason: 'too-large' });
      continue;
    }
    accepted.push(file);
  }
  return { accepted, rejected };
};

/**
 * Read one accepted file to workspace-ready text. Returns the draft, or a
 * rejection note when the content is empty or binary.
 */
export const readWorkAttachmentDraft = async (
  file: WorkAttachmentCandidate
): Promise<
  { draft: WorkAttachmentDraft } | { rejected: WorkAttachmentRejectionNote }
> => {
  const name = file.name || 'unnamed';
  let content: string;
  try {
    content = await file.text();
  } catch {
    return { rejected: { name, reason: 'empty' } };
  }
  if (!content) {
    return { rejected: { name, reason: 'empty' } };
  }
  if (looksLikeBinaryText(content.slice(0, TEXT_SAMPLE_CHARS))) {
    return { rejected: { name, reason: 'not-text' } };
  }
  return { draft: { name, content, size: file.size } };
};
