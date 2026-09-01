import { lazy, Suspense, useLayoutEffect } from "react";
import { BrowserRouter, Route, Routes, useLocation } from "react-router-dom";

import { ReloadPrompt } from "./components/reload-prompt";
import { LocalIdentityObserver } from "./platform/local-identity-observer";
import { HomePage } from "./routes/home-page";

const ReaderPage = lazy(() => import("./routes/reader-page"));
const AuthPage = lazy(() => import("./routes/auth-page"));
const ChoirPage = lazy(() => import("./routes/choir-page"));
const PrivacyPage = lazy(() => import("./routes/privacy-page"));

export function AppRoutes() {
  return (
    <>
      <RouteScrollReset />
      <Suspense fallback={<p className="route-loading">正在打开乐谱…</p>}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/login" element={<AuthPage />} />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="/choirs/:choirId" element={<ChoirPage />} />
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
