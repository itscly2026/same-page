export function lifecycleError(error?: string) {
  if (error === "identity_changed") return "登录身份已变化，请重新读取状态并重新确认。";
  if (error === "last_admin_requires_handoff") return "你仍是某个云盘的最后一位管理员，请先授权另一位管理员再继续。";
  if (error === "reauthentication_required") return "请重新验证原登录方式，并在十分钟内确认删除。";
  if (error === "recovery_unavailable") return "恢复期已过、身份验证已过期或登录方式不匹配，请重新验证并核对状态。";
  if (error === "membership_conflict") return "成员关系已变化或已过恢复期，请重新读取状态。";
  return "操作没有完成，请重新读取状态后重试。";
}
