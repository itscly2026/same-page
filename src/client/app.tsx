import { lazy, Suspense } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";

import { ReloadPrompt } from "./components/reload-prompt";
import { HomePage } from "./routes/home-page";

const ReaderPage = lazy(() => import("./routes/reader-page"));
const AuthPage = lazy(() => import("./routes/auth-page"));
const ChoirPage = lazy(() => import("./routes/choir-page"));

export function AppRoutes() {
  return (
    <Suspense fallback={<p className="route-loading">正在打开乐谱…</p>}>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/login" element={<AuthPage />} />
        <Route path="/choirs/:choirId" element={<ChoirPage />} />
        <Route path="/reader" element={<ReaderPage />} />
      </Routes>
    </Suspense>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
      <ReloadPrompt />
    </BrowserRouter>
  );
}
