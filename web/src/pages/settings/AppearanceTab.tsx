import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, History, LayoutTemplate, Palette, RotateCcw, Send, ShieldCheck, Wand2 } from 'lucide-react';
import { errorMessage, post } from '../../lib/api';
import { useBlueprint } from '../../lib/hooks';
import { FONT_STACKS, resolveAppearance } from '../../lib/theme';
import type { Appearance, AppearancePatch } from '../../lib/types';
import {
  APPEARANCE_DENSITIES,
  APPEARANCE_FONTS,
  APPEARANCE_RADII,
  DENSITY_LABELS,
  FONT_LABELS,
  HEX_COLOR_RE,
  MAX_CUSTOM_CSS,
  RADIUS_LABELS,
  SIDEBAR_LABELS,
  SIDEBAR_STYLES,
  THEME_LABELS,
  THEME_MODES,
  contrastRatio,
  sanitizeCustomCss,
} from '../../../../shared/appearance';
import { Alert, Badge, Button, Card, cx, ErrorState, Field, Input, Skeleton, Textarea, Toggle } from '../../components/ui';
import { AppearancePreview } from '../../components/AppearancePreview';
import { useToast } from '../../components/toast';
import { FieldGroup, Segmented } from './ai/shared';

/** Colores de partida habituales (el primero es el de Cortex CRM). */
const SWATCHES = ['#6938ef', '#2563eb', '#0a7f6b', '#059669', '#0891b2', '#e11d48', '#ea580c', '#ca8a04', '#334155', '#111827'];

const EXAMPLES = [
  'Agrupa el menú en «Comercial» (empresas, contactos y oportunidades) y «Operaciones» (tareas y actividades).',
  'Crea una página de inicio para ventas con KPIs del pipeline y la lista de oportunidades abiertas.',
  'Pon el menú lateral oscuro y usa una tipografía con bordes más redondeados.',
];

/** Parche mínimo entre la apariencia publicada y el borrador (null quita los campos opcionales). */
export function appearancePatch(current: Appearance | undefined, draft: Appearance): AppearancePatch {
  const base = resolveAppearance(current);
  const patch: AppearancePatch = {};
  if (draft.brandColor !== base.brandColor) patch.brandColor = draft.brandColor;
  if (draft.font !== base.font) patch.font = draft.font;
  if (draft.radius !== base.radius) patch.radius = draft.radius;
  if (draft.density !== base.density) patch.density = draft.density;
  if (draft.sidebar !== base.sidebar) patch.sidebar = draft.sidebar;
  if (draft.defaultTheme !== base.defaultTheme) patch.defaultTheme = draft.defaultTheme;
  if ((draft.accentColor ?? null) !== (base.accentColor ?? null)) patch.accentColor = draft.accentColor ?? null;
  if ((draft.appName?.trim() || null) !== (base.appName ?? null)) patch.appName = draft.appName?.trim() || null;
  const css = draft.customCss?.trim() ? draft.customCss : undefined;
  if ((css ?? null) !== (base.customCss ?? null)) patch.customCss = css ?? null;
  return patch;
}

function ColorInput({ label, value, onChange, hint }: { label: string; value: string; onChange: (hex: string) => void; hint?: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <FieldGroup label={label} hint={hint}>
      <div className="flex items-center gap-2">
        <input type="color" aria-label={label} value={value} onChange={(e) => onChange(e.target.value.toLowerCase())} className="h-9 w-12 shrink-0 cursor-pointer rounded-lg border-0 bg-transparent p-0" />
        <Input
          value={text}
          aria-label={`${label} (hexadecimal)`}
          className="w-32 font-mono"
          maxLength={7}
          invalid={!HEX_COLOR_RE.test(text)}
          onChange={(e) => {
            const v = e.target.value.trim();
            setText(v);
            if (HEX_COLOR_RE.test(v)) onChange(v.toLowerCase());
          }}
          onBlur={() => setText(value)}
        />
      </div>
    </FieldGroup>
  );
}

/**
 * Ajustes › Apariencia: editor visual de la capa de presentación de la organización con vista previa en directo.
 * «Publicar» no aplica nada directamente: crea un cambio manual (update_appearance) que recorre el mismo circuito
 * que los de EVOLVE (sandbox, riesgo, aprobación, versión con rollback).
 */
export default function AppearanceTab() {
  const bp = useBlueprint();
  const toast = useToast();
  const navigate = useNavigate();
  const published = bp.data?.blueprint.appearance;
  const [draft, setDraft] = useState<Appearance>(() => resolveAppearance(published));
  // Al publicarse otra versión, el borrador vuelve a partir de lo publicado.
  useEffect(() => setDraft(resolveAppearance(bp.data?.blueprint.appearance)), [bp.data?.version, bp.data?.blueprint.appearance]);
  const patch = useMemo(() => appearancePatch(published, draft), [published, draft]);
  const changed = Object.keys(patch).length > 0;
  const css = draft.customCss ?? '';
  const cssCheck = useMemo(() => (css.trim() ? sanitizeCustomCss(css) : null), [css]);
  const contrast = contrastRatio(draft.brandColor, '#ffffff');
  const set = <K extends keyof Appearance>(k: K, v: Appearance[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const publish = useMutation({
    mutationFn: () =>
      post<{ id: string }>('/evolve/requests/manual', {
        changeSet: {
          title: 'Apariencia del CRM',
          summary: `Cambia la apariencia del CRM desde Ajustes › Apariencia (${Object.keys(patch).length} ajuste(s)).`,
          operations: [{ op: 'update_appearance', changes: patch }],
        },
      }),
    onSuccess: (r) => {
      toast('Cambio enviado: se prueba en el sandbox y queda pendiente de aprobación');
      navigate(`/evolve/requests/${r.id}`);
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  });

  if (bp.isLoading) {
    return (
      <div className="grid gap-5 xl:grid-cols-2">
        <Skeleton className="h-96" />
        <Skeleton className="h-96" />
      </div>
    );
  }
  if (bp.error || !bp.data) return <ErrorState error={bp.error} onRetry={() => bp.refetch()} />;
  const blueprint = bp.data.blueprint;
  const pages = blueprint.pages ?? [];
  const groups = blueprint.navigation?.groups ?? [];

  return (
    <div className="space-y-5">
      <div className="rounded-2xl bg-white p-5 ring-1 ring-zinc-200/80 shadow-xs dark:bg-zinc-900 dark:ring-zinc-800">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-600 text-white">
              <Palette className="size-5" />
            </span>
            <div>
              <h2 className="text-base font-semibold tracking-tight">Apariencia de tu CRM</h2>
              <p className="mt-0.5 max-w-2xl text-sm text-zinc-500">Colores, tipografía, bordes, densidad y menú lateral de tu organización. Al publicar se crea un cambio que se prueba, se aprueba y queda como una versión nueva que puedes revertir.</p>
            </div>
          </div>
          <Badge color="slate">Versión actual v{bp.data.version}</Badge>
        </div>
      </div>

      {/* Dos columnas solo si el propio contenedor es ancho (con el panel de IA abierto queda en una, con la vista previa arriba). */}
      <div className="@container">
        <div className="grid items-start gap-5 @5xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
          <div className="min-w-0 space-y-5">
            <Card title="Marca" description="El color principal se usa en botones, enlaces y selección; la paleta completa se calcula a partir de él.">
              <div className="space-y-4">
                <ColorInput
                  label="Color principal"
                  value={draft.brandColor}
                  onChange={(v) => set('brandColor', v)}
                  hint={contrast < 3 ? undefined : `Contraste con texto blanco: ${contrast.toFixed(1)}:1`}
                />
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Colores sugeridos">
                  {SWATCHES.map((c) => (
                    <button key={c} type="button" title={c} aria-label={`Usar ${c}`} onClick={() => set('brandColor', c)} className={cx('size-6 rounded-full ring-2 ring-offset-2 ring-offset-white transition dark:ring-offset-zinc-900', draft.brandColor === c ? 'ring-zinc-900 dark:ring-white' : 'ring-transparent hover:ring-zinc-300')} style={{ background: c }} />
                  ))}
                </div>
                {contrast < 3 && (
                  <Alert tone="warning" title="Poco contraste">
                    El texto blanco sobre {draft.brandColor} tiene un contraste de {contrast.toFixed(1)}:1: los botones principales pueden leerse mal. Prueba un tono más oscuro.
                  </Alert>
                )}
                <div className="flex flex-wrap items-end gap-4">
                  <Toggle checked={!!draft.accentColor} onChange={(on) => set('accentColor', on ? '#d946ef' : undefined)} label="Color de acento propio" />
                  {draft.accentColor && <ColorInput label="Color de acento" value={draft.accentColor} onChange={(v) => set('accentColor', v)} hint="Avisos y degradados (logotipo y botones de IA)." />}
                </div>
                <Field label="Nombre de la aplicación" hint="Sustituye a «Cortex CRM» en el menú lateral y en la pestaña del navegador (máximo 40 caracteres).">
                  <Input value={draft.appName ?? ''} maxLength={40} placeholder="Cortex CRM" onChange={(e) => set('appName', e.target.value || undefined)} />
                </Field>
              </div>
            </Card>

            <Card title="Tipografía y forma">
              <div className="space-y-4">
                <FieldGroup label="Tipografía" hint="Fuentes incluidas o del sistema: no se descarga nada de fuera.">
                  <Segmented size="sm" value={draft.font} onChange={(v) => set('font', v)} options={APPEARANCE_FONTS.map((f) => ({ key: f, label: <span style={{ fontFamily: FONT_STACKS[f] }}>{FONT_LABELS[f]}</span> }))} />
                </FieldGroup>
                <FieldGroup label="Bordes">
                  <Segmented size="sm" value={draft.radius} onChange={(v) => set('radius', v)} options={APPEARANCE_RADII.map((r) => ({ key: r, label: RADIUS_LABELS[r] }))} />
                </FieldGroup>
                <FieldGroup label="Densidad" hint="Escala los espacios y la altura de los controles.">
                  <Segmented size="sm" value={draft.density} onChange={(v) => set('density', v)} options={APPEARANCE_DENSITIES.map((d) => ({ key: d, label: DENSITY_LABELS[d] }))} />
                </FieldGroup>
              </div>
            </Card>

            <Card title="Menú lateral y tema">
              <div className="space-y-4">
                <FieldGroup label="Menú lateral">
                  <Segmented size="sm" value={draft.sidebar} onChange={(v) => set('sidebar', v)} options={SIDEBAR_STYLES.map((s) => ({ key: s, label: SIDEBAR_LABELS[s] }))} />
                </FieldGroup>
                <FieldGroup label="Tema por defecto" hint="Solo para quien no ha elegido un tema: la elección de cada persona siempre manda.">
                  <Segmented size="sm" value={draft.defaultTheme} onChange={(v) => set('defaultTheme', v)} options={THEME_MODES.map((t) => ({ key: t, label: THEME_LABELS[t] }))} />
                </FieldGroup>
              </div>
            </Card>

            <Card title="CSS personalizado (avanzado)" description="Para ajustes que no cubren las opciones anteriores. Es de riesgo medio: lo aprueba un administrador.">
              <Textarea rows={8} spellCheck={false} className="font-mono text-xs" value={css} maxLength={MAX_CUSTOM_CSS} placeholder={'.mi-clase {\n  letter-spacing: 0.01em;\n}'} onChange={(e) => set('customCss', e.target.value || undefined)} invalid={!!cssCheck && !cssCheck.ok} />
              <div className="mt-1 flex justify-between text-[11px] text-zinc-400">
                <span>{css.length.toLocaleString('es-ES')} / {MAX_CUSTOM_CSS.toLocaleString('es-ES')} caracteres</span>
                {cssCheck?.ok && <span className="text-emerald-600 dark:text-emerald-400">CSS válido</span>}
              </div>
              {cssCheck && !cssCheck.ok && (
                <Alert tone="danger" title="Este CSS no se puede publicar" className="mt-2">
                  <ul className="list-disc pl-5">
                    {cssCheck.errors.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                </Alert>
              )}
              <p className="mt-2 flex gap-1.5 text-xs text-zinc-500">
                <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
                Solo CSS plano: sin @import, url(), expression(), javascript:, HTML ni secuencias de escape, así que no puede cargar nada de fuera. Nunca se aplica en EVOLVE, Ajustes ni Plataforma, para que no pueda ocultar o falsear aprobaciones, versiones ni este editor. Tampoco se aplica en la vista previa.
              </p>
            </Card>
          </div>

          <div className="order-first min-w-0 space-y-5 @5xl:order-none @5xl:sticky @5xl:top-4">
            <Card title="Vista previa en directo" description="Así se verá tu CRM con estos ajustes (datos de ejemplo).">
              <AppearancePreview appearance={draft} blueprint={blueprint} />
            </Card>
            <Card>
              <div className="space-y-3">
                {changed ? (
                  <p className="text-sm text-zinc-600 dark:text-zinc-400">
                    {Object.keys(patch).length} ajuste(s) sin publicar. Se creará un cambio que se prueba en el sandbox y espera la aprobación de un administrador.
                  </p>
                ) : (
                  <p className="text-sm text-zinc-500">No hay cambios respecto a la versión publicada.</p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button variant="primary" icon={<Send className="size-4" />} disabled={!changed || (!!cssCheck && !cssCheck.ok)} loading={publish.isPending} onClick={() => publish.mutate()}>
                    Publicar
                  </Button>
                  <Button icon={<RotateCcw className="size-4" />} disabled={!changed} onClick={() => setDraft(resolveAppearance(published))}>
                    Descartar
                  </Button>
                  <Button variant="ghost" onClick={() => setDraft(resolveAppearance(null))}>
                    Valores por defecto
                  </Button>
                </div>
                <p className="flex items-center gap-1.5 text-xs text-zinc-500">
                  <History className="size-3.5" /> Cada publicación es una versión nueva: si algo no te convence, puedes revertirla desde EVOLVE › Versiones.
                </p>
              </div>
            </Card>
            <Card title={<span className="flex items-center gap-2"><LayoutTemplate className="size-4 text-brand-500" /> Menú y páginas</span>} description="El menú agrupado, la página de inicio y las pantallas propias se piden a EVOLVE AI ENGINE en lenguaje natural.">
              <div className="space-y-3">
                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                  {groups.length ? `Menú en ${groups.length} grupo(s): ${groups.map((g) => g.label).join(', ')}.` : 'Menú por defecto (lista de módulos).'} {pages.length ? `${pages.length} página(s) propia(s): ${pages.map((p) => p.label).join(', ')}.` : 'Sin páginas propias.'}
                </p>
                <ul className="space-y-1.5">
                  {EXAMPLES.map((ex) => (
                    <li key={ex}>
                      <button
                        type="button"
                        className="group flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-zinc-600 transition hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                        onClick={() => {
                          sessionStorage.setItem('evolve-prefill', ex);
                          navigate('/evolve');
                        }}
                      >
                        <Wand2 className="mt-0.5 size-3.5 shrink-0 text-fuchsia-500" />
                        <span className="min-w-0 flex-1">«{ex}»</span>
                        <ArrowRight className="mt-0.5 size-3.5 shrink-0 opacity-0 transition group-hover:opacity-100" />
                      </button>
                    </li>
                  ))}
                </ul>
                {groups.length > 0 && (
                  <p className="flex items-start gap-1.5 text-xs text-zinc-500">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    Los módulos que no estén en ningún grupo se muestran al final del menú, en «Otros».
                  </p>
                )}
              </div>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
