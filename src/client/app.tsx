import { lazy, Suspense, useLayoutEffect } from "react";
import { BrowserRouter, Route, Routes, useLocation } from "react-router-dom";

import { ReloadPrompt } from "./components/reload-prompt";
import { markRouteTransitionMilestones } from "./performance/loading-performance";
import { LocalIdentityObserver } from "./platform/local-identity-observer";
import { ReaderPage } from "./reader/reader-runtime";
import { HomePage } from "./routes/home-page";

const UserLifecyclePage = lazy(() => import("./routes/user-lifecycle-page"));
const MembershipManagementPage = lazy(() => import("./routes/membership-management-page"));
const AuthPage = lazy(() => import("./routes/auth-page"));
const ChoirPage = lazy(() => import("./routes/choir-page"));
const DriveLayerPreferencesPage = lazy(
  () => import("./routes/drive-layer-preferences-page"),
);
const SharedLayerManagementPage = lazy(
  () => import("./routes/shared-layer-management-page"),
);
const SharedLayerGrantsPage = lazy(
  () => import("./routes/shared-layer-grants-page"),
);
const PrivacyPage = lazy(() => import("./routes/privacy-page"));
const DiagnosticsPage = lazy(() => import("./diagnostics/diagnostics-page"));

export function AppRoutes() {
  return (
    <>
      <RouteScrollReset />
      <Suspense fallback={<p className="route-loading">正在打开乐谱…</p>}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/user" element={<UserLifecyclePage />} />
          <Route path="/choirs/:choirId/memberships" element={<MembershipManagementPage />} />
          <Route path="/login" element={<AuthPage />} />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="/diagnostics" element={<DiagnosticsPage />} />
          <Route path="/choirs/:choirId" element={<ChoirPage />} />
          <Route
            path="/choirs/:choirId/preferences"
            element={<DriveLayerPreferencesPage />}
          />
          <Route
            path="/choirs/:choirId/shared-layers"
            element={<SharedLayerManagementPage />}
          />
          <Route
            path="/choirs/:choirId/shared-layers/:slot"
            element={<SharedLayerGrantsPage />}
          />
          <Route
            path="/choirs/:choirId/scores/:scoreId"
            element={<ReaderPage />}
          />
        </Routes>
      </Suspense>
    </>
  );
}

function RouteScrollReset() {
  const { pathname } = useLocation();

  useLayoutEffect(() => {
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    markRouteTransitionMilestones();
  }, [pathname]);

  return null;
}

export function App() {
  return (
    <BrowserRouter>
      <LocalIdentityObserver />
      <AppRoutes />
      <ReloadPrompt />
    </BrowserRouter>
  );
}
