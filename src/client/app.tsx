import { RouteContent } from "./components/route-content";
import { lazy, useLayoutEffect, useState } from "react";
import { createBrowserRouter, RouterProvider, Outlet, Route, Routes, useLocation } from "react-router-dom";

import { AppFooter } from "./components/app-footer";
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

        <Routes>
          <Route element={<PageWithFooter />}>
            <Route path="/" element={<RouteContent><HomePage /></RouteContent>} />
            <Route path="/user" element={<RouteContent><UserLifecyclePage /></RouteContent>} />
            <Route path="/choirs/:choirId/memberships" element={<RouteContent><MembershipManagementPage /></RouteContent>} />
            <Route path="/login" element={<RouteContent><AuthPage /></RouteContent>} />
            <Route path="/privacy" element={<RouteContent><PrivacyPage /></RouteContent>} />
            <Route path="/diagnostics" element={<RouteContent><DiagnosticsPage /></RouteContent>} />
            <Route path="/choirs/:choirId" element={<RouteContent><ChoirPage /></RouteContent>} />
            <Route
              path="/choirs/:choirId/preferences"
              element={<RouteContent><DriveLayerPreferencesPage /></RouteContent>}
            />
            <Route
              path="/choirs/:choirId/shared-layers"
              element={<RouteContent><SharedLayerManagementPage /></RouteContent>}
            />
            <Route
              path="/choirs/:choirId/shared-layers/:slot"
              element={<RouteContent><SharedLayerGrantsPage /></RouteContent>}
            />
          </Route>
          <Route
            path="/choirs/:choirId/scores/:scoreId"
            element={<RouteContent><ReaderPage /></RouteContent>}
          />
        </Routes>

    </>
  );
}

function PageWithFooter() {
  return <div className="page-with-footer"><Outlet /><AppFooter /></div>;
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
  const [router] = useState(() => createBrowserRouter([{ path: "*", element: <AppContent /> }]));
  return <RouterProvider router={router} />;
}

function AppContent() {
  return <>
    <LocalIdentityObserver />
    <AppRoutes />
    <ReloadPrompt />
  </>;
}
