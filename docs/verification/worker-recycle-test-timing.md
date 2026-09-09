# Worker 跨谱回收测试的超时与耗时诊断

PR #223 的 CI 曾在 `recycles E across scores` 超过默认 5 秒期限。同一提交重跑通过，只能证明非稳定失败，不能确定原始时延来源。

本次只调整 `worker/annotations-flow.test.ts` 中 E/custom 两个跨谱回收场景：各自设置 15 秒上限，保留所有真实注册、上传、D1、权限和生命周期断言。其他测试超时、并发及重试策略不变。

失败时输出一条 `worker_recycle_stage_timing` JSON：固定的 E/custom 变体、总耗时、已完成阶段耗时、当前阶段及其已等待时间。阶段分别为拥有者身份、首份谱面准备、成员身份、权限与第二份谱面、删除、恢复、停用状态恢复。首份谱面准备包括云盘创建和上传；成员身份包括注册及加入云盘。数值单位为毫秒，用于定位步骤，不作为产品性能阈值。

通过 Vitest 的 test context 捕获超时信号，在清理前保存快照；仅失败时输出，正常测试保持安静。记录不读取或序列化异常、fixture、请求、URL、用户身份、凭据或笔记。

## 故障注入验证

入口：`npm run test:worker:integration -- worker/annotations-flow.test.ts -t 'recycles E'`。

- 在 delete 阶段临时插入失败断言：测试失败，输出当前 delete 阶段，之前四个阶段分别有耗时。
- 在 delete 阶段临时插入永不完成的 Promise：测试在 15 秒期限失败，输出总耗时约 15010 ms、delete 阶段约 13393 ms；证明超时也会输出，不依赖挂起的测试主体结束。
- 两种注入均已移除；不加入自动重试或通过吞异常把失败改为成功。

最终验证：typecheck、lint、完整 Worker 单元 10 项和集成 98 项通过。校验两份注入输出各只有一条记录，字段仅为固定标签及数字耗时；完整成功测试没有该计时事件。Standards / Spec 两轴审查均无未解决发现。
