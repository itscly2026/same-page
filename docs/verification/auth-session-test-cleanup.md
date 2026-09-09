# Auth session 测试清理

`main` 合并 #228 后，CI run `34350265116` 的客户端 57 文件 / 497 项断言全部通过，但随后产生未捕获的 `ReferenceError: window is not defined`。栈来自 Better Auth 的 `cleanupBroadcastSetup`，经过 `session-refresh`、`session-atom` 和 Nano Stores 的延迟卸载计时器；visual 与 integration 通过，deploy 被阻止。

Nano Stores 最后一个订阅退出后延迟 1 秒执行卸载；React 测试 cleanup 只解除订阅，不保证卸载回调早于 jsdom 销毁。真实 auth 集成测试现在在清理 React 后显式调用 `cleanStores(session)`，在浏览器环境仍存在时移除监听器。仅增加已锁定的 `nanostores@1.5.2` 为直接测试依赖，未升级运行时依赖或修改产品认证代码。

确定性回归使用实际 auth session store：监听 storage 事件、取消订阅、执行测试清理、移除 window，再推进延迟计时器。修复前同样失败于 `removeEventListener`，修复后通过，不需要等待真实的 1 秒。命令：

```sh
NODE_OPTIONS=--no-experimental-webstorage npm run test:client -- src/client/auth/auth-client-cleanup.test.ts src/client/auth/offline-entry.test.tsx --maxWorkers=2
```

定向 2 文件 / 10 项通过。完整 Node 单元 79 项通过。首次全客户端使用默认并行度时有 3 项等待失败，未出现原未捕获异常；使用 `--maxWorkers=2` 重新验证，不修改测试超时。

最终完整客户端 58 文件 / 498 项全部通过，无未捕获异常；typecheck、lint 通过。Standards / Spec 审查无剩余发现。
