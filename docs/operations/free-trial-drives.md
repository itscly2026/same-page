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
