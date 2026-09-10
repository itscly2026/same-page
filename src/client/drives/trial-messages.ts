export function trialMessage(code?: string) {
  switch (code) {
    case "platform_storage_limit_reached": return "免费体验存储暂时已满，请稍后再上传。已有内容仍可使用。";
    case "free_drive_limit_reached": return "免费体验云盘名额暂满，请稍后再试。你仍可以加入其他云盘。";
    case "owned_drive_limit_reached": return "每名用户最多拥有一个免费体验云盘。请先转让或删除已有云盘。";
    case "identity_verification_required": return "请先完成邮箱验证，或使用已验证的第三方身份登录。";
    case "member_limit_reached": return "云盘成员人数已满，请联系拥有者释放名额后再试。";
    case "score_limit_reached": return "文件库乐谱数量已达上限，请先将不需要的乐谱移入回收站。";
    case "try_again_later": return "操作过于频繁，请稍后再试。";
    case "confirmation_mismatch": return "云盘名称已变化或输入不匹配，请刷新后重新确认。";
    case "forbidden": case "identity_changed": return "身份或权限已变化，请刷新后重试。";
    case "resource_deleted": return "内容已被彻底删除，请刷新。";
    default: return "操作未完成，请检查网络后重试。";
  }
}
