import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get } from './api';
import type { Blueprint, Member } from './types';
import type { WorkspaceSettingsView } from './session';

export function useBlueprint() {
  return useQuery({
    queryKey: ['blueprint'],
    queryFn: () => get<{ version: number; blueprint: Blueprint; settings: WorkspaceSettingsView }>('/blueprint'),
    staleTime: 30_000,
  });
}

export function useMembers() {
  return useQuery({ queryKey: ['members-lookup'], queryFn: () => get<Member[]>('/members/lookup'), staleTime: 60_000 });
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const isTyping = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
};

/** Atajos de teclado: "mod+k", "mod+j", "c", "g d" (secuencias de dos teclas), "?". */
export function useHotkeys(bindings: Record<string, (e: KeyboardEvent) => void>, deps: unknown[] = []) {
  const seq = useRef<{ key: string; at: number } | null>(null);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod) {
        const fn = bindings[`mod+${key}`];
        if (fn) {
          e.preventDefault();
          fn(e);
        }
        return;
      }
      if (isTyping(e) || e.altKey) return;
      const prev = seq.current;
      if (prev && Date.now() - prev.at < 900) {
        const fn = bindings[`${prev.key} ${key}`];
        seq.current = null;
        if (fn) {
          e.preventDefault();
          fn(e);
          return;
        }
      }
      if (Object.keys(bindings).some((b) => b.startsWith(`${key} `))) seq.current = { key, at: Date.now() };
      const fn = bindings[key === '/' && e.shiftKey ? '?' : e.key === '?' ? '?' : key];
      if (fn) {
        e.preventDefault();
        fn(e);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

type Theme = 'light' | 'dark' | 'system';
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem('evolve-theme') as Theme) || 'system';
    } catch {
      return 'system';
    }
  });
  useEffect(() => {
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.classList.toggle('dark', dark);
    };
    apply();
    try {
      localStorage.setItem('evolve-theme', theme);
    } catch {
      /* almacenamiento no disponible */
    }
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
  return [theme, setTheme];
}
