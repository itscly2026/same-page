import { Button, MenuItem, MenuTrigger, Popover } from "react-aria-components";
import { driveSettingsSchema } from "../../shared/choirs";
import { diagnosticFetch, parseDiagnosticResponse } from "../diagnostics/diagnostics";
import { Menu } from "../navigation/overlays";
import { SettingsRequestError } from "../settings/settings-request";
import { useReadResource } from "../settings/use-read-resource";

type Props = { choirId: string; userId: string; displayName?: string; localOnly: boolean; onEditDisplayName?: () => void };

export function DrivePersonalMenu(props: Props) {
  const { userId, choirId } = props;
  const settings = useReadResource(`${userId}:${choirId}:settings`, async signal => {
    const response = await diagnosticFetch(`/api/choirs/${choirId}/settings`, { signal });
    if (!response.ok) throw new SettingsRequestError(response.status);
    return parseDiagnosticResponse(response, driveSettingsSchema);
  });
  return <PersonalActions {...props} displayName={props.displayName ?? settings.data?.displayName} />;
}

function PersonalActions({ choirId, displayName: name, localOnly, onEditDisplayName }: Props) {
  return <MenuTrigger><Button className="drive-avatar" aria-label="我在此云盘">{name ? Array.from(name)[0] : "我"}</Button>
    <Popover className="file-menu-popover account-menu-popover"><Menu aria-label="我在此云盘">
      <MenuItem isDisabled>{name || "我在此云盘"}</MenuItem>
      {onEditDisplayName && <MenuItem isDisabled={localOnly} onAction={onEditDisplayName}>云盘内显示名</MenuItem>}
      <MenuItem href={`/choirs/${choirId}/preferences`}>阅读偏好</MenuItem>
      <MenuItem href={`/choirs/${choirId}/storage`}>本机存储</MenuItem>
      {onEditDisplayName && <MenuItem className="destructive-menu-item" href={`/choirs/${choirId}/me`}>退出云盘成员身份</MenuItem>}
    </Menu></Popover></MenuTrigger>;
}
