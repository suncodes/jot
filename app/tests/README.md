# 测试入口

所有自动化使用临时笔记库、隔离用户配置和本地假模型。不得将用户实际笔记库、真实 API Key 或生产模型作为默认测试环境。

## 当前发行定向入口

在 `app/` 执行：

```powershell
pnpm typecheck
pnpm test:release
pnpm app:dist
pnpm test:packed open-source-release.spec.ts
```

`test:release` 覆盖系统密钥及设置失败、三种模型协议的流式工具调用、推理参数、预算与压缩、内容范围、固定与导航数据、预装技能真实加载和工具链、版本标签及公开源码导出。

`open-source-release.spec.ts` 针对实际 `dist/win-unpacked/Jot.exe`，分别使用 Chat Completions、Responses 和 Anthropic Messages，检查版权文件、完整能力资源、建库、灵感、助手读写、密钥加密及重启后的持久化。只连接测试进程提供的本地假服务。通过 `JOT_PACKED_EXE` 可以选择另一个候选包。

模型表单另使用 `pnpm test:chrome` 验证协议选择、未保存连接测试、保存与重新加载、窗口和推理档位重置及窄窗布局。使用本机 Google Chrome，找不到时可设置 `JOT_CHROME_EXE` 指向 `chrome.exe`，不会回退到 Edge。`tests/chrome/` 提供真实表单入口，后端使用隔离 Core 和本地原生协议假服务。

## 按改动选择测试

- `unit/`：服务和共享契约，使用 `pnpm exec vitest run tests/unit/具体文件.test.ts`。
- `e2e/`：源码 Electron 交互，先构建，再指定相关 Playwright 文件。
- `packed/`：真实发行包和配套资源，明确指定场景，不默认全跑所有历史阶段。
- `llm/`：需明确配置的真实模型专项，不是普通 PR 的默认检查。
- `perf/`：性能专项，按需要运行。

目录中保留了一些历史阶段场景。它们不是当前全部功能均通过的证明；遇到过期目录或交互预期时先核对当前产品边界，不增加兼容逻辑来迎合旧断言。原型专项场景已删除，不作为发行测试入口。

测试结果、截图和打包候选属于临时产物，不提交到公开源码。验证报告应写清实际执行的范围，不将定向测试称为全量验收。
