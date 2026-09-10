import { trialMessage } from "../drives/trial-messages";
export function lifecycleError(error?: string) {
  if (error === "member_limit_reached" || error === "owned_drive_limit_reached") return trialMessage(error);
  if (error === "identity_changed") return "登录身份已变化，请重新读取状态并重新确认。";
  if (error === "owner_requires_transfer") return "你仍是云盘拥有者，请先转让拥有权或删除云盘再继续。";
  if (error === "reauthentication_required") return "请重新验证原登录方式，并在十分钟内确认删除。";
  if (error === "recovery_unavailable") return "恢复期已过、身份验证已过期或登录方式不匹配，请重新验证并核对状态。";
  if (error === "membership_conflict") return "成员关系已变化或已过恢复期，请重新读取状态。";
  return "操作没有完成，请重新读取状态后重试。";
}
