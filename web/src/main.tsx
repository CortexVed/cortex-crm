import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@fontsource-variable/inter';
import './index.css';
import { SessionProvider } from './lib/session';
import { reportClientError, ApiError } from './lib/api';
import { ToastProvider } from './components/toast';
import { PageLoader } from './components/ui';
import { AppLayout } from './components/Layout';
import { AuthLayout } from './pages/auth/AuthLayout';
import { applyAppearance, cachedAppearance } from './lib/theme';
import { I18nBoundary, initI18n, onLocaleChange } from './lib/i18n';

const Login = lazy(() => import('./pages/auth/Login'));
const Register = lazy(() => import('./pages/auth/Register'));
const ForgotPassword = lazy(() => import('./pages/auth/ForgotPassword'));
const ResetPassword = lazy(() => import('./pages/auth/ResetPassword'));
const VerifyEmail = lazy(() => import('./pages/auth/VerifyEmail'));
const AcceptInvite = lazy(() => import('./pages/auth/AcceptInvite'));
const PublicForm = lazy(() => import('./pages/PublicForm'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const ModulePage = lazy(() => import('./pages/ModulePage'));
const RecordPage = lazy(() => import('./pages/RecordPage'));
const Reports = lazy(() => import('./pages/Reports'));
const EvolveHome = lazy(() => import('./pages/evolve/EvolveHome'));
const RequestDetail = lazy(() => import('./pages/evolve/RequestDetail'));
const Releases = lazy(() => import('./pages/evolve/Releases'));
const Security = lazy(() => import('./pages/evolve/Security'));
const Settings = lazy(() => import('./pages/settings/Settings'));
const CustomPage = lazy(() => import('./pages/CustomPage'));
const CodeEngine = lazy(() => import('./pages/platform/CodeEngine'));
const NotFound = lazy(() => import('./pages/NotFound'));

window.addEventListener('error', (e) => reportClientError(e.message, e.error?.stack));
window.addEventListener('unhandledrejection', (e) => {
  if (e.reason instanceof ApiError) return;
  reportClientError(String(e.reason?.message ?? e.reason), e.reason?.stack);
});

// Antes del primer pintado, la última apariencia de este navegador (tokens, nunca el CSS personalizado): así el
// cargador y la primera pantalla no salen con la paleta por defecto para cambiar de color al llegar la sesión.
// Las pantallas de acceso y los formularios públicos mantienen el aspecto de Cortex CRM.
if (!/^\/(login|register|forgot-password|reset-password|verify-email|invite|f)(\/|$)/.test(window.location.pathname)) {
  applyAppearance(cachedAppearance(undefined, true));
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: (n, e) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && n < 2, refetchOnWindowFocus: false },
  },
});

// Lo que traduce el servidor (pasos, avisos, descripciones…) se vuelve a pedir en el idioma nuevo.
onLocaleChange(() => void queryClient.invalidateQueries());

// El idioma (y su catálogo) se carga antes del primer pintado: así no se ve la interfaz en otro idioma.
function render() {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <I18nBoundary>
          <ToastProvider>
            <SessionProvider>
              <BrowserRouter>
                <Suspense fallback={<PageLoader />}>
                  <Routes>
                    <Route element={<AuthLayout />}>
                      <Route path="/login" element={<Login />} />
                      <Route path="/register" element={<Register />} />
                      <Route path="/forgot-password" element={<ForgotPassword />} />
                      <Route path="/reset-password" element={<ResetPassword />} />
                      <Route path="/verify-email" element={<VerifyEmail />} />
                      <Route path="/invite/:token" element={<AcceptInvite />} />
                    </Route>
                    <Route path="/f/:slug/:form" element={<PublicForm />} />
                    <Route element={<AppLayout />}>
                      <Route path="/" element={<Dashboard />} />
                      <Route path="/m/:module" element={<ModulePage />} />
                      <Route path="/m/:module/:id" element={<RecordPage />} />
                      <Route path="/reports" element={<Reports />} />
                      <Route path="/evolve" element={<EvolveHome />} />
                      <Route path="/evolve/requests/:id" element={<RequestDetail />} />
                      <Route path="/evolve/releases" element={<Releases />} />
                      <Route path="/evolve/security" element={<Security />} />
                      <Route path="/p/:page" element={<CustomPage />} />
                      <Route path="/platform/code" element={<CodeEngine />} />
                      <Route path="/settings" element={<Navigate to="/settings/general" replace />} />
                      <Route path="/settings/:tab" element={<Settings />} />
                      <Route path="*" element={<NotFound />} />
                    </Route>
                  </Routes>
                </Suspense>
              </BrowserRouter>
            </SessionProvider>
          </ToastProvider>
        </I18nBoundary>
      </QueryClientProvider>
    </StrictMode>,
  );
}

void initI18n().finally(render);
