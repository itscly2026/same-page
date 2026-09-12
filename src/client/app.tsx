import { InstallProvider } from "./install/install-provider";
import { LogoutProvider } from "./auth/logout";
import { NavigationProvider } from "./navigation/navigation";
import { RouteContent } from "./components/route-content";
import { lazy, useLayoutEffect, useState } from "react";
import { createBrowserRouter, RouterProvider, Outlet, Route, Routes, useLocation, useNavigationType } from "react-router-dom";

import { AppFooter } from "./components/app-footer";
import { ReloadPrompt } from "./components/reload-prompt";
import { markRouteTransitionMilestones } from "./performance/loading-performance";
import { LocalIdentityObserver } from "./platform/local-identity-observer";
import { ReaderPage } from "./reader/reader-runtime";
import { HomePage } from "./routes/home-page";

const InstallPage = lazy(() => import("./install/install-page"));
const HelpPage = lazy(() => import("./routes/help-page"));
const DriveManagementPage = lazy(() => import("./routes/drive-management-page"));
const AboutPage = lazy(() => import("./routes/about-page"));
const PersonalSettingsPage = lazy(() => import("./routes/personal-settings-page"));
const LeaveDrivePage = lazy(() => import("./routes/leave-drive-page"));
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
const SharedLayerDetailsPage = lazy(
  () => import("./routes/shared-layer-details-page"),
);
const LocalStoragePage = lazy(() => import("./routes/local-storage-page"));
const PrivacyPage = lazy(() => import("./routes/privacy-page"));
const DiagnosticsPage = lazy(() => import("./diagnostics/diagnostics-page"));

export function AppRoutes() {
  const location = useLocation();
  const navigationType = useNavigationType();
  const [startupKey, setStartupKey] = useState<string | null>(() => location.pathname === "/" ? location.key : null);
  if (startupKey !== null && location.pathname !== "/") setStartupKey(null);
  const startup = location.state?.home !== true && (startupKey === location.key || (location.state?.startup === true && navigationType !== "POP"));
  return (
    <>
      <NavigationProvider><LogoutProvider><InstallProvider>
      <RouteScrollReset />

        <Routes>
          <Route element={<PageWithFooter />}>
            <Route path="/" element={<RouteContent><HomePage startup={startup} /></RouteContent>} />
            <Route path="/drives" element={<RouteContent><HomePage /></RouteContent>} />
            <Route path="/choirs/:choirId/storage" element={<RouteContent><LocalStoragePage /></RouteContent>} />
            <Route path="/choirs/:choirId/me" element={<RouteContent><LeaveDrivePage /></RouteContent>} />
            <Route path="/install" element={<RouteContent><InstallPage /></RouteContent>} />
            <Route path="/help" element={<RouteContent><HelpPage /></RouteContent>} />
            {(["info", "admission", "trash"] as const).map(section => <Route key={section} path={`/choirs/:choirId/settings/${section}`} element={<RouteContent><DriveManagementPage section={section} /></RouteContent>} />)}
            <Route path="/about" element={<RouteContent><AboutPage /></RouteContent>} />
            <Route path="/user" element={<RouteContent><PersonalSettingsPage /></RouteContent>} />
            <Route path="/user/lifecycle" element={<RouteContent><UserLifecyclePage /></RouteContent>} />
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
              element={<RouteContent><SharedLayerDetailsPage /></RouteContent>}
            />
          </Route>
          <Route
            path="/choirs/:choirId/scores/:scoreId"
            element={<RouteContent><ReaderPage /></RouteContent>}
          />
        </Routes>
      </InstallProvider></LogoutProvider></NavigationProvider>

    </>
  );
}

function PageWithFooter() {
  return <div className="page-with-footer"><Outlet />{["/", "/drives"].includes(useLocation().pathname) && <AppFooter />}</div>;
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
