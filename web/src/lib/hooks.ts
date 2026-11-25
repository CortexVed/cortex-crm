import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get } from './api';
import type { Blueprint, Member } from './types';
import type { WorkspaceSettingsView } from './session';

export function useBlueprint(enabled = true) {
  return useQuery({
    queryKey: ['blueprint'],
    queryFn: () => get<{ version: number; blueprint: Blueprint; settings: WorkspaceSettingsView }>('/blueprint'),
    staleTime: 30_000,
    enabled,
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

/** Si se cumple una media query; se actualiza al cambiar (girar la pantalla, redimensionar la ventana…). */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mq = window.matchMedia(query);
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
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
const THEME_KEY = 'evolve-theme';
const THEME_EXPLICIT_KEY = 'evolve-theme-explicit';

/** Tema que la persona ha elegido EXPLÍCITAMENTE (null si nunca lo ha cambiado). */
function readExplicitTheme(): Theme | null {
  try {
    const v = localStorage.getItem(THEME_KEY);
    // Las versiones anteriores guardaban «system» aunque nadie lo eligiera: solo cuenta con la marca explícita.
    if (v === 'light' || v === 'dark') return v;
    if (v === 'system' && localStorage.getItem(THEME_EXPLICIT_KEY) === '1') return 'system';
  } catch {
    /* almacenamiento no disponible */
  }
  return null;
}

/**
 * Tema claro/oscuro/sistema. La elección explícita de la persona manda; si no ha elegido ninguno, se usa el tema
 * por defecto de su organización (`appearance.defaultTheme`) y, si tampoco hay, el del sistema.
 */
export function useTheme(orgDefault?: Theme): [Theme, (t: Theme) => void] {
  const [explicit, setExplicit] = useState<Theme | null>(readExplicitTheme);
  const theme: Theme = explicit ?? orgDefault ?? 'system';
  // useLayoutEffect: antes de pintar (con useEffect se veía un fotograma con el tema anterior).
  useLayoutEffect(() => {
    const apply = () => {
      const root = document.documentElement;
      const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      if (root.classList.contains('dark') !== dark) {
        // Sin transiciones durante el cambio: si no, lo que tiene transition se funde y el resto salta.
        root.classList.add('theme-switching');
        root.classList.toggle('dark', dark);
        requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')));
      }
      // Los controles nativos (fecha, select, barras de scroll) siguen el tema de la aplicación, no el del sistema.
      root.style.colorScheme = dark ? 'dark' : 'light';
    };
    apply();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
  const setTheme = useCallback((t: Theme) => {
    setExplicit(t);
    try {
      localStorage.setItem(THEME_KEY, t);
      localStorage.setItem(THEME_EXPLICIT_KEY, '1');
    } catch {
      /* almacenamiento no disponible */
    }
  }, []);
  return [theme, setTheme];
}
