# 开发与定向测试

## 环境

当前目标是 Windows x64，使用 Node.js 24.x 和 pnpm 9.15.4。锁文件是 `app/pnpm-lock.yaml`，包管理配置使用 hoisted 布局，以便 Electron 原生依赖打包。

```powershell
cd "app"
pnpm install --frozen-lockfile
pnpm dev
```

项目默认使用 npm 和 Electron 官方下载源。受网络限制时可自行配置包管理器或 `ELECTRON_MIRROR`，不要把组织内部镜像和凭证写回公开配置。

开发模型可在界面填写，或从仓库根目录 `.env.example` 创建 `.env`。`JOT_NO_DOTENV=1` 禁止读取开发文件；发行版本身不读取 `.env`。测试使用隔离的 `JOT_USER_DATA` 和临时笔记库。

## 常用命令

| 命令（在 app 中） | 用途 |
| --- | --- |
| `pnpm typecheck` | 主进程、共享契约、测试与 Vue 类型检查 |
| `pnpm lint` | 静态检查 |
| `pnpm test:release` | 开源发行入口和相关文件、设置、技能的定向回归 |
| `pnpm exec vitest run tests/unit/work-reports.test.ts` | 指定业务单元 |
| `pnpm build` | 主进程、预加载和界面构建 |
| `pnpm exec playwright test --config playwright.packed.config.ts open-source-release.spec.ts` | 现有发行包的隔离冒烟 |
| `pnpm app:dist` | Windows x64 安装器及 win-unpacked |
| `pnpm release:artifacts` | 整理 ZIP、安装器和 SHA256 |
| `pnpm licenses:generate` / `pnpm licenses:check` | 生成／核对第三方版权清单 |

改动文件工具就测试实际文件读写、范围和结果；改动设置就测试持久化与失败路径；UI 改动选相关 Electron 场景。只在新风险或失败需要时扩大范围，不默认运行所有历史用例或真实模型验证。

`app/tests/` 中包含不同阶段的场景；默认 `pnpm test` 会收集全部单元，不能将历史用例直接等同当前发布门槛。当前发行验证入口为 `test:release` 和指定发布冒烟，见 [测试说明](../app/tests/README.md)。

## 公开源码

当前工程作为正式开发目录。历史文档和原型可保留本地，通过 `.gitignore` 排除；首次公开前单独清理已跟踪文件和历史。`pnpm source:export` 用于审核公开范围与独立构建，只导出明确允许的源码、资源、当前文档与发布配置，排除 `.git`、真实配置、运行数据、开发记录和构建产物，并生成逐文件 SHA256 清单。

导出脚本不会创建仓库、提交或推送；目标必须为空。具体审核及发布方法见 [发布流程](release.md)。
