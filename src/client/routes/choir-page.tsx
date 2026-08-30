import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { choirMembershipsResponseSchema } from "../../shared/choirs";

export default function ChoirPage() {
  const { choirId = "" } = useParams();
  const [name, setName] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    let active = true;
    void loadChoir(choirId).then((choirName) => {
      if (!active) {
        return;
      }
      if (choirName) {
        setName(choirName);
      } else {
        setDenied(true);
      }
    });
    return () => {
      active = false;
    };
  }, [choirId]);

  return (
    <main className="page-shell compact-page">
      <p className="eyebrow">合唱团</p>
      <h1>{denied ? "无法访问这个合唱团" : name ?? "正在打开…"}</h1>
      <p className="hero__copy">
        {denied
          ? "请返回入口重新输入当前邀请码，或使用有成员关系的邮箱登录。"
          : "身份与权限边界已经就绪。乐谱列表将在 Issue #7 中接入。"}
      </p>
      <div className="hero__actions">
        <Link className="primary-link" to="/">
          返回入口
        </Link>
        {!denied ? (
          <Link className="secondary-link" to="/reader">
            查看 Reader 接入点
          </Link>
        ) : null}
      </div>
    </main>
  );
}

async function loadChoir(choirId: string): Promise<string | null> {
  const guestResponse = await fetch("/api/guest/session");
  if (guestResponse.ok) {
    const payload = (await guestResponse.json()) as {
      choir: { id: string; name: string };
    };
    if (payload.choir.id === choirId) {
      return payload.choir.name;
    }
  }

  const memberResponse = await fetch("/api/choirs");
  if (!memberResponse.ok) {
    return null;
  }
  const memberships = choirMembershipsResponseSchema.parse(
    await memberResponse.json(),
  ).memberships;
  return (
    memberships.find((membership) => membership.choir.id === choirId)?.choir
      .name ?? null
  );
}
