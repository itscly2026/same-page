# 免费体验云盘运维

新盘默认 10 份当前乐谱、50 × 1024 × 1024 bytes、20 位成员。既有云盘保持 configured 及已有容量，数量不追溯限制。全站免费盘数默认 100，配置在 drive_platform_limits；每人只允许拥有一个免费盘，转让也检查。注册不受盘数限制。

创建每用户每天最多 3 次尝试，上传每小时 30 次，彻底删除每分钟 20 次；全部通过现有限流机制。免费盘的当前和后台保留 PDF 合计默认上限 20 GiB，达到后暂停新增上传而非取消保留。笔记另受已有技术限制。

彻底删除使用 purged_at，在 API 层、授权层及关键写入约束中拒绝访问。关联版本释放计费额度一次，后台到期清理不再扣减。scores / score_versions / choirs 保留三十天，R2 删除走持久队列，可重试。不要通过修改 purged_at 恢复用户可见内容；不存在产品恢复工具，也不得通过事故处理复活已撤销授权。

只读容量审计（字节）：

```sql
SELECT c.plan,
 sum(CASE WHEN v.purged_at IS NULL THEN v.size_bytes ELSE 0 END) AS product_pdf_bytes,
 sum(CASE WHEN v.purged_at IS NOT NULL THEN v.size_bytes ELSE 0 END) AS retained_pdf_bytes,
 count(*) AS pdf_versions
FROM score_versions v JOIN choirs c ON c.id = v.choir_id GROUP BY c.plan;
SELECT count(*) AS awaiting_r2_deletion FROM score_object_deletions;
SELECT * FROM drive_platform_limits;
```

此统计不包括笔记、R2 待清理孤立对象；实际基础设施用量需同时查看 R2 / D1 指标。迁移不修改存量 storage_limit_bytes。

## 调整指定云盘的额度

目前通过运维修改 D1 的 `choirs` 记录，产品界面没有额度编辑入口。
按云盘 ID 定位，先记录原额度，再更新并回读同一条记录；避免按重名的云盘名称更新。
查询时仅选取以下字段，不输出邀请码相关字段。

```sql
SELECT id, name, plan, storage_used_bytes, storage_limit_bytes, member_limit, score_limit
FROM choirs WHERE id = '<云盘 ID>' AND purged_at IS NULL;

-- 示例：容量调为 1 GiB、有效成员上限调为 100；仅在原额度不更高时执行。
UPDATE choirs
SET storage_limit_bytes = 1073741824, member_limit = 100
WHERE id = '<云盘 ID>' AND purged_at IS NULL
  AND storage_limit_bytes <= 1073741824
  AND member_limit IS NOT NULL AND member_limit <= 100;

SELECT id, name, plan, storage_used_bytes, storage_limit_bytes, member_limit, score_limit
FROM choirs WHERE id = '<云盘 ID>' AND purged_at IS NULL;
```

只调整容量或成员数时，只更新对应字段并保留对应的额度条件。
`member_limit` 统计有效成员关系（包含拥有者），`score_limit` 限制当前乐谱数；
这两个字段为 `NULL` 表示不设该项上限，正整数表示明确上限。
`storage_limit_bytes` 必须是正整数，不能用 `NULL` 表示无限容量。
容量仍包括当前、候选、回收站及保留期内历史 PDF。

单盘提额无需更改 `plan`，后续请求直接按数据库额度执行，无需重新部署。
保留 `plan = 'free'` 时，仍受免费云盘的平台总容量、每人拥有数等限制；
调整 `plan` 是另一个运营决定，不应作为单盘提额的附带操作。
单 PDF 大小和页数限制也独立于云盘总容量。
