import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { setNavigator } from './api/client';
import { ROUTER_FUTURE } from './config';
import { ErrorBoundary } from './components/ErrorBoundary';
import { RequireUser } from './components/guards';
import { CheckEmail } from './screens/auth/CheckEmail';
import { Forgot } from './screens/auth/Forgot';
import { Login } from './screens/auth/Login';
import { Register } from './screens/auth/Register';
import { Reset } from './screens/auth/Reset';
import { Verify } from './screens/auth/Verify';
import { PathIndex, PathScreen } from './screens/Path/PathScreen';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000 } },
});

/** Lets the api client's 401 redirect use the router instead of a full reload. */
function NavigatorBridge() {
  const navigate = useNavigate();
  useEffect(() => setNavigator((to) => navigate(to, { replace: true })), [navigate]);
  return null;
}

export function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter future={ROUTER_FUTURE}>
          <NavigatorBridge />
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route path="/verify" element={<Verify />} />
            <Route path="/forgot" element={<Forgot />} />
            <Route path="/reset" element={<Reset />} />
            <Route
              path="/check-email"
              element={<RequireUser verified={false}>{() => <CheckEmail />}</RequireUser>}
            />
            <Route path="/" element={<RequireUser>{(me) => <PathIndex me={me} />}</RequireUser>} />
            <Route
              path="/track/:trackId"
              element={<RequireUser>{(me) => <PathScreen me={me} />}</RequireUser>}
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
