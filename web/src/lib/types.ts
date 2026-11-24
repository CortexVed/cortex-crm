import type { Role } from '../../../shared/constants';
export type { Blueprint, Module, Field, View, Automation, Widget, Dashboard, Condition, SelectOption, LayoutSection } from '../../../shared/blueprint';
export type { ChangeSet, Operation } from '../../../shared/changeset';

export interface Me {
  user: { id: string; name: string; email: string; emailVerified: boolean; isPlatformAdmin: boolean };
  workspace: { id: string; name: string; slug: string; role: Role; version: number } | null;
  workspaces: { id: string; name: string; role: Role }[];
  csrfToken: string | null;
  features: { emailEnabled: boolean; signupEnabled: boolean; platformSetupAvailable?: boolean };
}

export interface RecordItem {
  id: string;
  module: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  createdBy: string | null;
  updatedBy: string | null;
}

export interface Refs {
  records: Record<string, { title: string; module: string }>;
  users: Record<string, string>;
  files: Record<string, { name: string; size: number; mime: string }>;
}

export interface RecordList {
  items: RecordItem[];
  total: number;
  page: number;
  pageSize: number;
  refs: Refs;
}

export interface Member {
  id: string;
  name: string;
  email: string;
  role: Role;
}

export interface SeriesPoint {
  key: string;
  label: string;
  value: number;
  color?: string;
}

export type WidgetData =
  | { type: 'metric'; value: number; format: 'currency' | 'number' | 'percent'; currency?: string }
  | { type: 'bar' | 'donut' | 'line'; points: SeriesPoint[]; format: 'currency' | 'number' | 'percent'; currency?: string }
  | { type: 'list'; items: { id: string; title: string; subtitle?: string }[]; module: string }
  | { type: 'error'; message: string };

export interface EvolutionRequestSummary {
  id: string;
  kind: string;
  source: string;
  prompt: string;
  status: string;
  risk: 'low' | 'medium' | 'high' | null;
  title: string | null;
  created_at: string;
  updated_at: string;
  requested_by_name: string | null;
}
