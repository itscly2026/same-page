import { Info } from "lucide-react";
import { Button, DialogTrigger, Heading, Popover } from "react-aria-components";
import { Dialog } from "../navigation/overlays";
import { operationKeys, operationLabels, type Operation, type PermissionSet } from "../../shared/drive-permissions";

const descriptions: Record<Operation, string> = {
  uploadFiles: "向云盘上传新的 PDF 乐谱。不包含修改、删除已有文件的权限。",
  modifyFiles: "重命名乐谱、替换 PDF、查看和回滚历史 PDF 版本。不会自动重新对齐批注。",
  trashFiles: "将乐谱移到回收站，并在三十天内恢复。删除和恢复共用此权限。",
  manageInvites: "查看和轮换云盘邀请码。轮换会使旧邀请码、邀请链接与二维码立即失效。",
  removeMembers: "移除普通成员，并在保留期内恢复成员关系。恢复不会恢复旧权限或笔记分享。",
  configureLayers: "新增、改名、排序、停用、删除和恢复共享层，影响云盘内全部乐谱。不包含编辑批注或给别人授权。",
  editDriveInfo: "修改云盘名称等基本信息。不包含文件、成员或共享层操作。",
};

export function PermissionMatrix({ operations, management, scope, owner, disabled, layers, onOperations, onManagement }: {
  operations: PermissionSet; management: PermissionSet; scope: PermissionSet; owner: boolean; disabled: boolean;
  layers: { slot: string; name: string }[];
  onOperations: (value: PermissionSet) => void; onManagement: (value: PermissionSet) => void;
}) {
  const columns = [{ label: "可以操作", value: operations, change: onOperations }, ...(owner ? [{ label: "可以授权他人", value: management, change: onManagement }] : [])];
  function row(name: string, description: string, key: string, checked: (set: PermissionSet) => boolean, update: (set: PermissionSet, next: boolean) => PermissionSet, locked?: (set: PermissionSet) => boolean) {
    return <tr key={key}><th scope="row"><span>{name}</span><DialogTrigger>
      <Button className="permission-info icon-button" aria-label={`${name}说明`}><Info size={17} aria-hidden="true" /></Button>
      <Popover className="file-menu-popover permission-help"><Dialog><Heading slot="title">{name}</Heading><p>{description}</p><p>“可以操作”允许本人执行；“可以授权他人”允许在受托范围内调整普通成员的这项操作权限，不授予本人操作能力，也不能继续转委托。</p></Dialog></Popover>
    </DialogTrigger></th>{columns.map(column => <td key={column.label}><label className="permission-check"><input type="checkbox" aria-label={`${name}：${column.label}`} checked={checked(column.value)} disabled={disabled || locked?.(column.value)} onChange={event => column.change(update(column.value, event.target.checked))} /><span className="visually-hidden">{name}：{column.label}</span></label></td>)}</tr>;
  }
  return <div className="permission-matrix"><table><caption>操作与授权分别设置</caption><thead><tr><th scope="col">权限</th>{columns.map(column => <th scope="col" key={column.label}>{column.label}</th>)}</tr></thead><tbody>
    {operationKeys.filter(key => scope.operations.includes(key)).map(key => row(operationLabels[key], descriptions[key], key, set => set.operations.includes(key), (set, next) => ({ ...set, operations: next ? [...new Set([...set.operations, key])] : set.operations.filter(item => item !== key) })))}
    {scope.sharedLayers === "all" && row("编辑全部共享层", "包含当前及未来新增的共享层。只允许编辑共享批注，不允许编辑他人的笔记，也不包含共享层配置。", "all-layers", set => set.sharedLayers === "all", (set, next) => ({ ...set, sharedLayers: next ? "all" : [] }))}
    {layers.filter(layer => scope.sharedLayers === "all" || scope.sharedLayers.includes(layer.slot)).map(layer => row(`编辑 ${layer.name}`, "允许在此云盘全部乐谱的这个共享层中创建、修改和删除批注。显示选择不会授予编辑权。", layer.slot, set => set.sharedLayers === "all" || set.sharedLayers.includes(layer.slot), (set, next) => ({ ...set, sharedLayers: set.sharedLayers === "all" ? "all" : next ? [...new Set([...set.sharedLayers, layer.slot])] : set.sharedLayers.filter(slot => slot !== layer.slot) }), set => set.sharedLayers === "all"))}
  </tbody></table></div>;
}
