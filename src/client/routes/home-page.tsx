import { useEffect, useState } from "react";
import { Button } from "react-aria-components";
import { Link } from "react-router-dom";

import { healthResponseSchema } from "../../shared/health";
import { verifyLocalDatabase } from "../platform/local-database";

type CheckState = "checking" | "ready" | "unavailable";

export function HomePage() {
  const [apiState, setApiState] = useState<CheckState>("checking");
  const [storageState, setStorageState] = useState<CheckState>("checking");

  useEffect(() => {
    let active = true;

    void getBaselineStates().then(([nextApiState, nextStorageState]) => {
      if (active) {
        setApiState(nextApiState);
        setStorageState(nextStorageState);
      }
    });

    return () => {
      active = false;
    };
  }, []);

  const recheckBaseline = () => {
    setApiState("checking");
    setStorageState("checking");
    void getBaselineStates().then(([nextApiState, nextStorageState]) => {
      setApiState(nextApiState);
      setStorageState(nextStorageState);
    });
  };

  return (
    <main className="page-shell">
      <section className="hero" aria-labelledby="page-title">
        <p className="eyebrow">小红花合唱团 · 工程基线</p>
        <h1 id="page-title">让每次排练，都在同一页</h1>
        <p className="hero__copy">
          Same Page 正在搭建合唱乐谱、共享批注与离线排练的生产基础。
        </p>
        <div className="hero__actions">
          <Link className="primary-link" to="/reader">
            打开 Reader 占位页
          </Link>
          <Button className="secondary-button" onPress={recheckBaseline}>
            重新检查工程状态
          </Button>
        </div>
      </section>

      <section className="status-panel" aria-labelledby="status-title">
        <h2 id="status-title">运行状态</h2>
        <StatusItem label="同源 Worker API" state={apiState} />
        <StatusItem label="本机 IndexedDB" state={storageState} />
      </section>
    </main>
  );
}

async function getBaselineStates(): Promise<[CheckState, CheckState]> {
  const [apiResult, storageResult] = await Promise.allSettled([
    fetch("/api/health").then(async (response) => {
      if (!response.ok) {
        throw new Error(`Health check failed: ${response.status}`);
      }
      return healthResponseSchema.parse(await response.json());
    }),
    verifyLocalDatabase(),
  ]);

  return [
    apiResult.status === "fulfilled" ? "ready" : "unavailable",
    storageResult.status === "fulfilled" ? "ready" : "unavailable",
  ];
}

function StatusItem({ label, state }: { label: string; state: CheckState }) {
  const copy = {
    checking: "检查中",
    ready: "可用",
    unavailable: "暂不可用",
  }[state];

  return (
    <div className="status-row">
      <span>{label}</span>
      <span className={`status status--${state}`}>{copy}</span>
    </div>
  );
}
