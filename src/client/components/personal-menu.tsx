import { UserRound } from "lucide-react";
import { Button, MenuItem, MenuTrigger, Popover } from "react-aria-components";
import { useLogout } from "../auth/logout-context";
import { Menu } from "../navigation/overlays";

export function PersonalMenu({ email }: { email?: string | null }) {
  const logout = useLogout();
  const realEmail = email || null;
  const initial = realEmail ? Array.from(realEmail.split("@")[0])[0]?.toLocaleUpperCase() : null;
  return <MenuTrigger>
    <Button className="drive-avatar" aria-label="我的">{initial ?? <UserRound aria-hidden="true" size={20} />}</Button>
    <Popover className="file-menu-popover account-menu-popover"><Menu aria-label="我的">
      <MenuItem isDisabled>{realEmail ?? "已登录"}</MenuItem>
      <MenuItem href="/user">账户</MenuItem>
      <MenuItem onAction={() => void logout.request()}>退出登录</MenuItem>
    </Menu></Popover>
  </MenuTrigger>;
}
