import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { RequireAuth, RequirePermission } from './components/layout/guards';
import { NAV } from './components/layout/nav';
import Landing from './pages/Landing';
import { AcceptInvite, ForgotPassword, Login, ResetPassword, Signup } from './pages/auth/AuthPages';
import Companies from './pages/admin/Companies';
import AiEmployees from './pages/app/AiEmployees';
import Overview from './pages/app/Overview';
import Planned from './pages/app/Planned';
import Settings from './pages/app/Settings';
import Team from './pages/app/Team';

function NotFound() {
  return (
    <div className="grid min-h-dvh place-items-center px-4 text-center">
      <div>
        <p className="font-display text-6xl font-semibold text-burgundy-700">404</p>
        <p className="mt-3 text-mist-600">This page doesn’t exist.</p>
        <a href="/" className="mt-5 inline-block font-medium text-burgundy-700 hover:underline">Back to home</a>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<Signup />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/accept-invite" element={<AcceptInvite />} />

      {/* Business workspace */}
      <Route element={<RequireAuth roles="tenant" />}>
        <Route path="/app" element={<AppShell />}>
          <Route index element={<Overview />} />
          <Route path="ai-employees" element={<RequirePermission permission="ai_employees:read"><AiEmployees /></RequirePermission>} />
          <Route path="team" element={<RequirePermission permission="team:read"><Team /></RequirePermission>} />
          <Route path="settings" element={<RequirePermission permission="settings:read"><Settings /></RequirePermission>} />
          {NAV.filter((n) => n.planned).map((n) => (
            <Route key={n.to} path={n.to.replace('/app/', '')} element={<Planned />} />
          ))}
          <Route path="*" element={<Navigate to="/app" replace />} />
        </Route>
      </Route>

      {/* Platform admin */}
      <Route element={<RequireAuth roles="platform" />}>
        <Route path="/admin" element={<AppShell />}>
          <Route index element={<Companies />} />
          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Route>
      </Route>

      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
