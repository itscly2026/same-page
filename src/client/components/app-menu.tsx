import { Button, MenuItem, MenuTrigger, Popover } from "react-aria-components";
import { Menu } from "../navigation/overlays";

export function AppMenu() {
  return <MenuTrigger><Button className="secondary-button" aria-label="应用菜单">合谱菜单</Button><Popover className="file-menu-popover"><Menu aria-label="应用菜单"><MenuItem href="/user">个人设置</MenuItem><MenuItem href="/help">帮助</MenuItem><MenuItem href="/about">关于合谱</MenuItem></Menu></Popover></MenuTrigger>;
}
