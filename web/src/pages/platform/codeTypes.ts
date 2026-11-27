/** Tipos de las respuestas de /api/platform/code/* y etiquetas de la interfaz del motor de código fuente. */

import { msg } from '../../lib/i18n';

export interface Flag {
  key: string;
  level: 'info' | 'warning';
  message: string;
  paths?: string[];
}

export interface ProgressEntry {
  step: string;
  status: 'running' | 'done' | 'failed' | 'skipped';
  detail?: string;
  at: string;
}

export interface CiAttempt {
  n: number;
  deploymentId: string | null;
  status: 'running' | 'passed' | 'failed' | 'cancelled';
  railwayStatus?: string;
  startedAt: string;
  finishedAt?: string;
  files: number;
  bytes: number;
  summary?: string[];
  errors?: string[];
  failedTests?: string[];
  excerpt?: string;
  removed?: boolean;
  note?: string;
  sourceVersion: { id: string; base: string | null; createdAt: string | null };
}

export interface Review {
  status: 'done' | 'skipped' | 'error';
  verdict?: 'approve' | 'concerns' | 'reject';
  summary?: string;
  concerns?: { severity: 'low' | 'medium' | 'high' | 'critical'; file?: string; message: string }[];
  provider?: string;
  model?: string;
  sameProvider?: boolean;
  truncated?: boolean;
  message?: string;
  at: string;
}

export interface FileEntry {
  path: string;
  action: 'add' | 'modify' | 'delete';
  before: string | null;
  after: string | null;
}

export interface ServiceDeployment {
  serviceId: string;
  deploymentId: string;
  status?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface DeployState {
  phase?: string;
  requestedAt?: string;
  attempt?: number;
  sourceVersion?: { id: string };
  previous?: { worker?: ServiceDeployment; web?: ServiceDeployment };
  worker?: ServiceDeployment;
  web?: ServiceDeployment;
  continuedBy?: string;
  verification?: { ok: boolean; at: string; checks: { name: string; passed: boolean; detail?: string }[] };
  rollback?: { reason: 'failure' | 'manual'; requestedAt: string; message?: string; services: { service: 'worker' | 'web'; deploymentId: string; ok: boolean; error?: string }[]; verified?: boolean; detail?: string };
}

export interface Stats {
  files?: number;
  added?: number;
  modified?: number;
  deleted?: number;
  linesAdded?: number;
  linesRemoved?: number;
  bytes?: number;
}

export interface ChangeSummary {
  id: string;
  title: string | null;
  status: string;
  prompt: string;
  risk: string;
  stats: Stats;
  flags: Flag[];
  error: string | null;
  base_version: string | null;
  origin: { type: 'evolve'; workspaceName?: string; requestId: string } | null;
  created_at: string;
  updated_at: string;
  deployed_at: string | null;
  rolled_back_at: string | null;
  ci_attempts: number;
  ci_status: string | null;
  source_version: string | null;
  review_verdict: string | null;
  requested_by_name: string | null;
  workspace_name: string | null;
}

export interface ChangeDetail extends Omit<ChangeSummary, 'ci_attempts' | 'ci_status' | 'source_version' | 'review_verdict'> {
  summary: string | null;
  prompt: string;
  guards: { ok: boolean; violations: { rule: string; path?: string; line?: number; message: string }[]; at: string } | null;
  ci: { attempts: CiAttempt[] };
  review: Review | null;
  approvals: { userId: string; name: string; at: string; comment?: string; confirmation: string; attempt: number }[];
  deploy: DeployState;
  conversation: { role: 'request' | 'feedback'; content: string; byName?: string; at: string }[];
  progress: ProgressEntry[];
  llm: { phase: string; provider: string; model: string; costUsd: number | null; steps?: number; at: string }[];
  files: FileEntry[];
  testsAdded: string[];
  steps: { key: string; label: string }[];
  policy: {
    runningVersion: string;
    baseMatches: boolean;
    approveConfirmation: string;
    canApprove: boolean;
    rollbackConfirmation: string;
    canRollback: boolean;
    canRefine: boolean;
    canCancel: boolean;
    stalled: boolean;
  };
}

export interface WorkerReport {
  role: string;
  projectId: string | null;
  environmentId: string | null;
  serviceId: string | null;
  webServiceId: string | null;
  ciServiceId: string | null;
  sourceVersion: string | null;
  reportedAt: string;
}

export interface CodeSettings {
  configured: boolean;
  missing: string[];
  warnings: string[];
  token: { configured: boolean; hint: string | null; updatedAt: string | null; projectId: string | null; environmentId: string | null };
  railway: { detected: boolean; projectId: string | null; environmentId: string | null; serviceId: string | null; role: string };
  worker: WorkerReport | null;
  services: { web: string | null; worker: string | null; ci: string | null };
  running: { version: string; treeHash: string };
}

export interface PlatformRequest {
  id: string;
  workspace_id: string;
  workspace_name: string;
  prompt: string;
  status: string;
  kind: string;
  created_at: string;
  title: string | null;
  platform_request: string | null;
  requested_by_name: string | null;
  source_change_id: string | null;
  source_change_status: string | null;
}

/** Etiquetas marcadas con msg(): se muestran con tk(STATUS[s].label). */
export const STATUS: Record<string, { label: string; color: string }> = {
  queued: { label: msg('En cola'), color: 'slate' },
  planning: { label: msg('Desarrollando'), color: 'violet' },
  testing: { label: msg('En el CI'), color: 'sky' },
  needs_input: { label: msg('Necesita información'), color: 'amber' },
  ready_for_review: { label: msg('Pendiente de aprobación'), color: 'fuchsia' },
  deploying: { label: msg('Desplegando'), color: 'sky' },
  deployed: { label: msg('Desplegado'), color: 'emerald' },
  failed: { label: msg('Fallido'), color: 'red' },
  rolling_back: { label: msg('Revirtiendo'), color: 'orange' },
  rolled_back: { label: msg('Revertido'), color: 'orange' },
  cancelled: { label: msg('Cancelado'), color: 'slate' },
};

export const ACTIVE = new Set(['queued', 'planning', 'testing', 'deploying', 'rolling_back']);

export const shortId = (id: string | null | undefined) => (id ? id.slice(0, 8) : '—');

export const changeLink = (id: string) => `/platform/code?change=${encodeURIComponent(id)}`;
