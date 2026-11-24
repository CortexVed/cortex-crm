import type { Color } from '../../../shared/constants';

// Clases completas y estáticas (Tailwind solo genera las clases que aparecen literalmente).
export const BADGE: Record<Color, string> = {
  slate: 'bg-zinc-100 text-zinc-700 ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-700',
  red: 'bg-red-50 text-red-700 ring-red-200 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-500/30',
  orange: 'bg-orange-50 text-orange-700 ring-orange-200 dark:bg-orange-500/15 dark:text-orange-300 dark:ring-orange-500/30',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/30',
  yellow: 'bg-yellow-50 text-yellow-800 ring-yellow-200 dark:bg-yellow-500/15 dark:text-yellow-300 dark:ring-yellow-500/30',
  lime: 'bg-lime-50 text-lime-800 ring-lime-200 dark:bg-lime-500/15 dark:text-lime-300 dark:ring-lime-500/30',
  green: 'bg-green-50 text-green-700 ring-green-200 dark:bg-green-500/15 dark:text-green-300 dark:ring-green-500/30',
  emerald: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-500/30',
  teal: 'bg-teal-50 text-teal-700 ring-teal-200 dark:bg-teal-500/15 dark:text-teal-300 dark:ring-teal-500/30',
  cyan: 'bg-cyan-50 text-cyan-700 ring-cyan-200 dark:bg-cyan-500/15 dark:text-cyan-300 dark:ring-cyan-500/30',
  sky: 'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-500/15 dark:text-sky-300 dark:ring-sky-500/30',
  blue: 'bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-500/15 dark:text-blue-300 dark:ring-blue-500/30',
  indigo: 'bg-indigo-50 text-indigo-700 ring-indigo-200 dark:bg-indigo-500/15 dark:text-indigo-300 dark:ring-indigo-500/30',
  violet: 'bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-500/15 dark:text-violet-300 dark:ring-violet-500/30',
  purple: 'bg-purple-50 text-purple-700 ring-purple-200 dark:bg-purple-500/15 dark:text-purple-300 dark:ring-purple-500/30',
  fuchsia: 'bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-200 dark:bg-fuchsia-500/15 dark:text-fuchsia-300 dark:ring-fuchsia-500/30',
  pink: 'bg-pink-50 text-pink-700 ring-pink-200 dark:bg-pink-500/15 dark:text-pink-300 dark:ring-pink-500/30',
  rose: 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-500/15 dark:text-rose-300 dark:ring-rose-500/30',
};

export const DOT: Record<Color, string> = {
  slate: 'bg-zinc-400',
  red: 'bg-red-500',
  orange: 'bg-orange-500',
  amber: 'bg-amber-500',
  yellow: 'bg-yellow-400',
  lime: 'bg-lime-500',
  green: 'bg-green-500',
  emerald: 'bg-emerald-500',
  teal: 'bg-teal-500',
  cyan: 'bg-cyan-500',
  sky: 'bg-sky-500',
  blue: 'bg-blue-500',
  indigo: 'bg-indigo-500',
  violet: 'bg-violet-500',
  purple: 'bg-purple-500',
  fuchsia: 'bg-fuchsia-500',
  pink: 'bg-pink-500',
  rose: 'bg-rose-500',
};

/** Colores hex para gráficos SVG. */
export const HEX: Record<Color, string> = {
  slate: '#a1a1aa',
  red: '#ef4444',
  orange: '#f97316',
  amber: '#f59e0b',
  yellow: '#eab308',
  lime: '#84cc16',
  green: '#22c55e',
  emerald: '#10b981',
  teal: '#14b8a6',
  cyan: '#06b6d4',
  sky: '#0ea5e9',
  blue: '#3b82f6',
  indigo: '#6366f1',
  violet: '#8b5cf6',
  purple: '#a855f7',
  fuchsia: '#d946ef',
  pink: '#ec4899',
  rose: '#f43f5e',
};

export const CHART_SEQUENCE = ['#7a5af8', '#0ea5e9', '#10b981', '#f59e0b', '#f43f5e', '#14b8a6', '#d946ef', '#6366f1', '#84cc16', '#f97316', '#a1a1aa', '#ec4899'];

export const MODULE_ACCENT: Record<Color, string> = {
  slate: 'bg-zinc-500/10 text-zinc-600 dark:text-zinc-300',
  red: 'bg-red-500/10 text-red-600 dark:text-red-300',
  orange: 'bg-orange-500/10 text-orange-600 dark:text-orange-300',
  amber: 'bg-amber-500/10 text-amber-600 dark:text-amber-300',
  yellow: 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-300',
  lime: 'bg-lime-500/10 text-lime-600 dark:text-lime-300',
  green: 'bg-green-500/10 text-green-600 dark:text-green-300',
  emerald: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
  teal: 'bg-teal-500/10 text-teal-600 dark:text-teal-300',
  cyan: 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-300',
  sky: 'bg-sky-500/10 text-sky-600 dark:text-sky-300',
  blue: 'bg-blue-500/10 text-blue-600 dark:text-blue-300',
  indigo: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-300',
  violet: 'bg-violet-500/10 text-violet-600 dark:text-violet-300',
  purple: 'bg-purple-500/10 text-purple-600 dark:text-purple-300',
  fuchsia: 'bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-300',
  pink: 'bg-pink-500/10 text-pink-600 dark:text-pink-300',
  rose: 'bg-rose-500/10 text-rose-600 dark:text-rose-300',
};
