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

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: (n, e) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && n < 2, refetchOnWindowFocus: false },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
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
    </QueryClientProvider>
  </StrictMode>,
);
