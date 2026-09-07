import { z } from "zod";

export const operationKeys = ["uploadFiles", "modifyFiles", "trashFiles", "manageInvites", "removeMembers", "configureLayers", "editDriveInfo"] as const;
export type Operation = typeof operationKeys[number];
export const operationLabels: Record<Operation, string> = {
  uploadFiles: "上传文件", modifyFiles: "修改文件", trashFiles: "删除与恢复文件",
  manageInvites: "管理加入方式", removeMembers: "移除成员", configureLayers: "管理共享层配置", editDriveInfo: "修改基本信息",
};
export const permissionSetSchema = z.object({
  operations: z.array(z.enum(operationKeys)),
  sharedLayers: z.union([z.literal("all"), z.array(z.string().min(1))]),
}).strict();
export type PermissionSet = z.infer<typeof permissionSetSchema>;
export const emptyPermissions = (): PermissionSet => ({ operations: [], sharedLayers: [] });
export const allPermissions = (): PermissionSet => ({ operations: [...operationKeys], sharedLayers: "all" });
export function isDelegated(scope: PermissionSet): boolean {
  return scope.operations.length > 0 || scope.sharedLayers === "all" || scope.sharedLayers.length > 0;
}
export function includesLayer(scope: PermissionSet, slot: string): boolean {
  return scope.sharedLayers === "all" || scope.sharedLayers.includes(slot);
}
export function mayChangePermissions(scope: PermissionSet, before: PermissionSet, after: PermissionSet): boolean {
  if (operationKeys.some(key => before.operations.includes(key) !== after.operations.includes(key) && !scope.operations.includes(key))) return false;
  if (scope.sharedLayers === "all") return true;
  if (before.sharedLayers === "all" || after.sharedLayers === "all") return before.sharedLayers === after.sharedLayers;
  return [...before.sharedLayers, ...after.sharedLayers].every(slot =>
    before.sharedLayers.includes(slot) === after.sharedLayers.includes(slot) || includesLayer(scope, slot));
}
export const driveCapabilitiesSchema = z.object({
  isOwner: z.boolean(), operations: permissionSetSchema, management: permissionSetSchema,
});
export type DriveCapabilities = z.infer<typeof driveCapabilitiesSchema>;
export const noCapabilities = (): DriveCapabilities => ({ isOwner: false, operations: emptyPermissions(), management: emptyPermissions() });
export function effectiveCapabilities(isOwner: boolean, operations: PermissionSet, management: PermissionSet): DriveCapabilities {
  return { isOwner, operations: isOwner ? allPermissions() : operations, management: isOwner ? allPermissions() : management };
}
export function hasManagement(capabilities: DriveCapabilities): boolean {
  return capabilities.isOwner || isDelegated(capabilities.management) || capabilities.operations.operations.some(key => key !== "uploadFiles");
}
