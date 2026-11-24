import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart3, Bell, Check, ChevronsUpDown, GitBranch, History, LayoutDashboard, LogOut, Menu, Monitor, Moon, Plus, Search, Settings, ShieldCheck, Sparkles, Sun, X } from 'lucide-react';
import { useSession } from '../lib/session';
import { useBlueprint, useHotkeys, useTheme } from '../lib/hooks';
import { ModuleIcon } from '../lib/icons';
import { MODULE_ACCENT } from '../lib/colors';
import { get, post } from '../lib/api';
import { relativeTime } from '../lib/format';
import { ROLE_LABELS, hasRole, type Color } from '../../../shared/constants';
import { Avatar, Button, cx, IconButton, Input, Kbd, Modal, PageLoader, Spinner } from './ui';
import { CommandPalette } from './CommandPalette';
import { AiPanel } from './AiPanel';
import { useToast } from './toast';

function Logo() {
  return (
    <div className="flex items-center gap-2">
      <img src="/favicon.svg" alt="" className="size-7" />
      <span className="text-[15px] font-bold tracking-tight">
        Cortex <span className="evolve-text">CRM</span>
      </span>
    </div>
  );
}

function WorkspaceSwitcher() {
  const { me, setMe } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const navigate = useNavigate();
  const switchTo = async (id: string) => {
    const next = await post('/auth/switch-workspace', { workspaceId: id });
    setMe(next);
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
    setOpen(false);
    navigate('/');
  };
  const create = useMutation({
    mutationFn: () => post('/auth/workspaces', { name }),
    onSuccess: (next) => {
      setMe(next);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
      setCreating(false);
      setName('');
      toast('Organización creada');
      navigate('/');
    },
    onError: (e) => toast((e as Error).message, 'error'),
  });
  if (!me?.workspace) return null;
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-zinc-100 dark:hover:bg-zinc-800/70">
        <span className="flex size-7 items-center justify-center rounded-md bg-zinc-900 text-xs font-bold text-white dark:bg-white dark:text-zinc-900">{me.workspace.name.slice(0, 1).toUpperCase()}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{me.workspace.name}</span>
          <span className="block text-[11px] text-zinc-500">{ROLE_LABELS[me.workspace.role]}</span>
        </span>
        <ChevronsUpDown className="size-3.5 text-zinc-400" />
      </button>
      {open && (
        <div className="absolute inset-x-0 top-full z-30 mt-1 rounded-xl bg-white p-1 shadow-xl ring-1 ring-zinc-200 animate-pop dark:bg-zinc-900 dark:ring-zinc-800">
          {me.workspaces.map((w) => (
            <button key={w.id} onClick={() => switchTo(w.id)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">
              <span className="min-w-0 flex-1 truncate text-left">{w.name}</span>
              {w.id === me.workspace!.id && <Check className="size-3.5 text-brand-600" />}
            </button>
          ))}
          <div className="my-1 border-t border-zinc-100 dark:border-zinc-800" />
          <button onClick={() => { setCreating(true); setOpen(false); }} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800">
            <Plus className="size-3.5" /> Nueva organización
          </button>
        </div>
      )}
      <Modal open={creating} onClose={() => setCreating(false)} title="Nueva organización" description="Cada organización tiene sus propios datos, usuarios y configuración, totalmente aislados." footer={<><Button onClick={() => setCreating(false)}>Cancelar</Button><Button variant="primary" loading={create.isPending} disabled={name.trim().length < 2} onClick={() => create.mutate()}>Crear</Button></>}>
        <Input placeholder="Nombre de la organización" value={name} onChange={(e) => setName(e.target.value)} />
      </Modal>
    </div>
  );
}

function NavItem({ to, icon, label, end, badge }: { to: string; icon: React.ReactNode; label: string; end?: boolean; badge?: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cx('group flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13.5px] font-medium transition', isActive ? 'bg-zinc-900/[0.06] text-zinc-900 dark:bg-white/10 dark:text-white' : 'text-zinc-600 hover:bg-zinc-900/[0.04] hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-zinc-100')
      }
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge}
    </NavLink>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { data } = useBlueprint();
  const { can, me } = useSession();
  const modules = (data?.blueprint.modules ?? []).filter((m) => !m.archived);
  return (
    <nav className="flex h-full flex-col gap-4 px-3 py-4" onClick={(e) => (e.target as HTMLElement).closest('a') && onNavigate?.()}>
      <div className="px-2">
        <Logo />
      </div>
      <WorkspaceSwitcher />
      <div className="space-y-0.5">
        <NavItem to="/" end icon={<LayoutDashboard className="size-4" />} label="Panel" />
        <NavItem to="/reports" icon={<BarChart3 className="size-4" />} label="Informes" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        <div className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Módulos</div>
        <div className="space-y-0.5">
          {modules.map((m) => (
            <NavItem key={m.key} to={`/m/${m.key}`} icon={<span className={cx('flex size-5 items-center justify-center rounded-md', MODULE_ACCENT[m.color as Color])}><ModuleIcon name={m.icon} className="size-3.5" /></span>} label={m.labelPlural} />
          ))}
        </div>
        <div className="mb-1 mt-5 px-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Evolución</div>
        <div className="space-y-0.5">
          <NavItem to="/evolve" end icon={<Sparkles className="size-4 text-fuchsia-500" />} label="EVOLVE AI ENGINE" />
          <NavItem to="/evolve/releases" icon={<History className="size-4" />} label="Versiones" />
          {can('admin') && <NavItem to="/evolve/security" icon={<ShieldCheck className="size-4" />} label="Seguridad" />}
        </div>
      </div>
      <div className="space-y-0.5 border-t border-zinc-200/70 pt-3 dark:border-zinc-800">
        <NavItem to="/settings/general" icon={<Settings className="size-4" />} label="Ajustes" />
        {me?.user.isPlatformAdmin && <NavItem to="/settings/platform" icon={<GitBranch className="size-4" />} label="Plataforma" />}
      </div>
    </nav>
  );
}

function Notifications() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const ref = useRef<HTMLDivElement>(null);
  const q = useQuery({ queryKey: ['notifications'], queryFn: () => get<{ items: any[]; unread: number }>('/notifications'), refetchInterval: 60_000 });
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const read = async (n: any) => {
    if (!n.read_at) await post(`/notifications/${n.id}/read`);
    qc.invalidateQueries({ queryKey: ['notifications'] });
    setOpen(false);
    if (n.link) navigate(n.link);
  };
  return (
    <div className="relative" ref={ref}>
      <IconButton label="Notificaciones" onClick={() => setOpen((o) => !o)} className="relative">
        <Bell className="size-4" />
        {!!q.data?.unread && <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-fuchsia-500 text-[9px] font-bold text-white">{q.data.unread > 9 ? '9+' : q.data.unread}</span>}
      </IconButton>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-2 w-[min(360px,calc(100vw-2rem))] rounded-xl bg-white shadow-xl ring-1 ring-zinc-200 animate-pop dark:bg-zinc-900 dark:ring-zinc-800">
          <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-2.5 dark:border-zinc-800">
            <span className="text-sm font-semibold">Notificaciones</span>
            {!!q.data?.unread && (
              <button className="text-xs font-medium text-brand-600 hover:underline dark:text-brand-400" onClick={async () => { await post('/notifications/read-all'); qc.invalidateQueries({ queryKey: ['notifications'] }); }}>
                Marcar todo como leído
              </button>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto scrollbar-thin">
            {q.isLoading ? (
              <div className="flex justify-center p-6"><Spinner /></div>
            ) : !q.data?.items.length ? (
              <p className="px-4 py-8 text-center text-sm text-zinc-500">No tienes notificaciones</p>
            ) : (
              q.data.items.map((n) => (
                <button key={n.id} onClick={() => read(n)} className="flex w-full gap-3 border-b border-zinc-50 px-4 py-3 text-left transition last:border-0 hover:bg-zinc-50 dark:border-zinc-800/60 dark:hover:bg-zinc-800/50">
                  <span className={cx('mt-1.5 size-2 shrink-0 rounded-full', n.read_at ? 'bg-transparent' : 'bg-fuchsia-500')} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{n.title}</span>
                    {n.body && <span className="mt-0.5 block truncate text-xs text-zinc-500">{n.body}</span>}
                    <span className="mt-1 block text-[11px] text-zinc-400">{relativeTime(n.created_at)}</span>
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function UserMenu() {
  const { me, logout } = useSession();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  if (!me) return null;
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} className="rounded-full" aria-label="Menú de usuario">
        <Avatar name={me.user.name} />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-2 w-60 rounded-xl bg-white p-1 shadow-xl ring-1 ring-zinc-200 animate-pop dark:bg-zinc-900 dark:ring-zinc-800">
          <div className="px-3 py-2">
            <div className="truncate text-sm font-medium">{me.user.name}</div>
            <div className="truncate text-xs text-zinc-500">{me.user.email}</div>
          </div>
          <div className="my-1 border-t border-zinc-100 dark:border-zinc-800" />
          <button className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800" onClick={() => { setOpen(false); navigate('/settings/account'); }}>
            <Settings className="size-4" /> Mi cuenta y seguridad
          </button>
          <button className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10" onClick={async () => { await logout(); navigate('/login'); }}>
            <LogOut className="size-4" /> Cerrar sesión
          </button>
        </div>
      )}
    </div>
  );
}

const SHORTCUTS: [string, string][] = [
  ['⌘/Ctrl + K', 'Búsqueda global y comandos'],
  ['⌘/Ctrl + J', 'Abrir/cerrar EVOLVE AI'],
  ['G luego D', 'Ir al panel'],
  ['G luego E', 'Ir a EVOLVE AI ENGINE'],
  ['G luego R', 'Ir a informes'],
  ['G luego S', 'Ir a ajustes'],
  ['C', 'Crear registro (en un módulo)'],
  ['?', 'Ver atajos de teclado'],
];

const isWide = () => typeof window !== 'undefined' && window.matchMedia('(min-width: 1280px)').matches;

export function AppLayout() {
  const { me, loading } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const [theme, setTheme] = useTheme();
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Por defecto EVOLVE AI acompaña siempre en pantallas anchas (panel lateral); en pantallas estrechas es una
  // capa a pantalla completa y nunca se abre sola. Solo se recuerda la elección explícita (⌘J o el botón).
  const [aiOpen, setAiOpenState] = useState(() => {
    if (!isWide()) return false;
    try {
      const saved = localStorage.getItem('evolve-ai-open');
      if (saved !== null) return saved === '1';
    } catch {
      /* sin almacenamiento */
    }
    return true;
  });
  const setAiOpen = useCallback((v: boolean | ((open: boolean) => boolean)) => {
    setAiOpenState((prev) => {
      const next = typeof v === 'function' ? v(prev) : v;
      if (isWide()) {
        try {
          localStorage.setItem('evolve-ai-open', next ? '1' : '0');
        } catch {
          /* sin almacenamiento */
        }
      }
      return next;
    });
  }, []);
  const [mobileNav, setMobileNav] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  // En pantallas estrechas el panel es una capa: se cierra al navegar y al pasar de ancho a estrecho.
  useEffect(() => {
    if (!isWide()) setAiOpenState(false);
  }, [location.pathname]);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1280px)');
    const onChange = () => {
      if (!mq.matches) setAiOpenState(false);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  useHotkeys(
    {
      'mod+k': () => setPaletteOpen((o) => !o),
      'mod+j': () => setAiOpen((o) => !o),
      'g d': () => navigate('/'),
      'g e': () => navigate('/evolve'),
      'g r': () => navigate('/reports'),
      'g s': () => navigate('/settings/general'),
      '?': () => setShortcuts(true),
    },
    [navigate],
  );
  useEffect(() => setMobileNav(false), [location.pathname]);
  useEffect(() => {
    const open = () => setAiOpen(true);
    window.addEventListener('evolve:open-ai', open);
    return () => window.removeEventListener('evolve:open-ai', open);
  }, []);

  if (loading) return <PageLoader />;
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  if (!me.workspace) return <NoWorkspace />;

  const ThemeIcon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor;
  return (
    <div className="flex h-dvh overflow-hidden">
      <aside className="hidden w-64 shrink-0 border-r border-zinc-200/70 bg-zinc-50/80 lg:block dark:border-zinc-800 dark:bg-zinc-950">
        <Sidebar />
      </aside>
      {mobileNav && (
        <div className="fixed inset-0 z-40 bg-zinc-950/40 lg:hidden" onClick={() => setMobileNav(false)}>
          <aside className="h-full w-72 bg-zinc-50 shadow-2xl animate-slide-in dark:bg-zinc-950" onClick={(e) => e.stopPropagation()}>
            <Sidebar onNavigate={() => setMobileNav(false)} />
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-zinc-200/70 bg-white/80 px-3 backdrop-blur sm:px-5 dark:border-zinc-800 dark:bg-zinc-950/80">
          <IconButton label="Menú" className="lg:hidden" onClick={() => setMobileNav(true)}>
            <Menu className="size-5" />
          </IconButton>
          <button onClick={() => setPaletteOpen(true)} className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg bg-zinc-100/80 px-3 text-sm text-zinc-500 ring-1 ring-transparent transition hover:ring-zinc-200 sm:max-w-md dark:bg-zinc-900 dark:hover:ring-zinc-700">
            <Search className="size-4 shrink-0" />
            <span className="truncate">Buscar o ejecutar un comando…</span>
            <span className="ml-auto hidden sm:block"><Kbd>⌘K</Kbd></span>
          </button>
          <div className="ml-auto flex items-center gap-1">
            <span className="hidden sm:block">
              <Button variant={aiOpen ? 'secondary' : 'ai'} size="sm" icon={<Sparkles className="size-3.5" />} onClick={() => setAiOpen((o) => !o)}>
                EVOLVE AI
              </Button>
            </span>
            <IconButton label="EVOLVE AI" className="sm:hidden" onClick={() => setAiOpen((o) => !o)}>
              <Sparkles className="size-4 text-fuchsia-500" />
            </IconButton>
            <IconButton label={`Tema: ${theme === 'system' ? 'sistema' : theme === 'dark' ? 'oscuro' : 'claro'}`} onClick={() => setTheme(theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light')}>
              <ThemeIcon className="size-4" />
            </IconButton>
            <Notifications />
            <UserMenu />
          </div>
        </header>
        {!me.user.emailVerified && me.features.emailEnabled && <VerifyBanner />}
        <div className="flex min-h-0 flex-1">
          <main className="min-w-0 flex-1 overflow-y-auto scrollbar-thin">
            <Outlet />
          </main>
          {aiOpen && <AiPanel onClose={() => setAiOpen(false)} />}
        </div>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onAskAi={() => setAiOpen(true)} />
      <Modal open={shortcuts} onClose={() => setShortcuts(false)} title="Atajos de teclado" size="sm">
        <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
          {SHORTCUTS.map(([k, d]) => (
            <li key={k} className="flex items-center justify-between py-2">
              <span className="text-zinc-600 dark:text-zinc-400">{d}</span>
              <Kbd>{k}</Kbd>
            </li>
          ))}
        </ul>
      </Modal>
    </div>
  );
}

function VerifyBanner() {
  const toast = useToast();
  const [sent, setSent] = useState(false);
  return (
    <div className="flex items-center justify-center gap-3 bg-amber-50 px-4 py-1.5 text-xs text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
      Verifica tu correo para proteger tu cuenta.
      <button
        disabled={sent}
        className="font-semibold underline disabled:no-underline disabled:opacity-60"
        onClick={async () => {
          try {
            await post('/auth/verify-email/resend');
            setSent(true);
            toast('Te hemos enviado un nuevo enlace de verificación');
          } catch (e) {
            toast((e as Error).message, 'error');
          }
        }}
      >
        {sent ? 'Enviado' : 'Reenviar enlace'}
      </button>
    </div>
  );
}

function NoWorkspace() {
  const { setMe, logout } = useSession();
  const [name, setName] = useState('');
  const toast = useToast();
  const create = useMutation({ mutationFn: () => post('/auth/workspaces', { name }), onSuccess: (me) => setMe(me), onError: (e) => toast((e as Error).message, 'error') });
  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
        <Logo />
        <h1 className="mt-6 text-lg font-semibold">No perteneces a ninguna organización</h1>
        <p className="mt-1 text-sm text-zinc-500">Crea una nueva o pide a un administrador que te invite.</p>
        <Input className="mt-4" placeholder="Nombre de la organización" value={name} onChange={(e) => setName(e.target.value)} />
        <Button variant="primary" className="mt-3 w-full" loading={create.isPending} disabled={name.trim().length < 2} onClick={() => create.mutate()}>
          Crear organización
        </Button>
        <button className="mt-3 w-full text-center text-sm text-zinc-500 hover:underline" onClick={() => logout()}>
          Cerrar sesión
        </button>
      </div>
    </div>
  );
}

export { Logo, X as CloseIcon, hasRole, Link };
