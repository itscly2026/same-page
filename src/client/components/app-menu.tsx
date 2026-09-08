import { Ellipsis } from "lucide-react";
import { Button, MenuItem, MenuTrigger, Popover } from "react-aria-components";
import { Menu } from "../navigation/overlays";

export function AppMenu() {
  return <MenuTrigger><Button className="icon-button" aria-label="应用菜单"><Ellipsis size={23} aria-hidden="true" /></Button><Popover className="file-menu-popover"><Menu aria-label="应用菜单"><MenuItem href="/user">个人设置</MenuItem><MenuItem href="/help">帮助</MenuItem><MenuItem href="/about">关于合谱</MenuItem></Menu></Popover></MenuTrigger>;
}
