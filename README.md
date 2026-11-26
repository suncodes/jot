# Jot

[English](README.en.md) · [下载](https://github.com/suncodes/jot/releases) · [使用指南](docs/user-guide.md) · [问题反馈](https://github.com/suncodes/jot/issues)

Jot 是一款以本地文件为主的 Windows 笔记与 AI 助手。随手记录灵感、按目录管理笔记和附件，并让助手基于实际材料查询、整理和写作。Markdown 文件可以离开 Jot 独立阅读，索引只是可重建的辅助数据。

当前为 **0.x 预览版**，主要支持 Windows x64。重要资料请保留独立备份；已知限制见 [KNOWN_ISSUES.md](KNOWN_ISSUES.md)。

## 可以做什么

- **灵感和内容库**：快捷记录、多级内容目录、文件导入、Markdown 编辑与预览、分类属性、固定文件和目录、展开收起与定位当前文件。
- **时间线和日总结**：按日期浏览记录与更新，用可配置的后台技能生成日总结。工作日报、周报、月报属于独立工作报告能力。
- **通用助手**：通过 `@` 指定文件或目录，通过 `$` 或 `/` 引用技能；展示回答、工具过程、出处、上下文使用估算与压缩状态，支持选择模型推理强度。
- **可管理的能力**：智能体、技能、工具和 AI 插件按库管理；支持本地导入与依赖诊断。应用插件提供独立的个人日记、工作日记和快捷入口。
- **文件操作**：助手默认使用当前笔记库；用户明确指定磁盘绝对路径时，通用文件工具也支持库外读写。删除和整篇覆盖等操作有应用内确认。

## 开始使用

1. 从 [Releases](https://github.com/suncodes/jot/releases) 下载 Windows x64 安装器，或解压 ZIP 后运行 `Jot.exe`。ZIP 中的整个目录需要一起保留。
2. 选择一个本地文件夹作为笔记库。新库会创建默认内容目录，可以自行改名或新增子目录。
3. 在设置中配置支持 `/chat/completions` 的 OpenAI 兼容模型服务；也可以先跳过，只使用记录和编辑功能。
4. 在底部记录灵感，在内容库创建笔记，或打开助手提问。日记快捷入口在“设置 → 应用插件”配置。

笔记、附件、生成内容和按库保存的能力位于所选库中；模型设置默认位于 `%APPDATA%/jot/settings.json`，密钥使用操作系统加密。安装器和免安装 ZIP 均使用该用户配置目录。AI 请求会向你配置的模型服务发送相关材料，详见 [隐私与数据说明](PRIVACY.md)。

## 从源码运行

需要 Windows x64、Node.js **24.x**、pnpm **9.15.4**。

```powershell
cd "app"
pnpm install --frozen-lockfile
pnpm dev
```

开发时也可以从根目录的 `.env.example` 创建自己的 `.env`；正式发行版不读取开发 `.env`。请不要提交密钥、真实笔记库或会话数据。

```powershell
pnpm typecheck
pnpm test:release
pnpm app:dist
pnpm release:artifacts
```

更多说明：[开发与定向测试](docs/development.md)、[架构和存储](docs/architecture.md)、[插件制作](docs/plugins.md)、[工作报告](docs/work-reports.md)、[发布流程](docs/release.md)。

## 参与和许可

欢迎通过 [Issues](https://github.com/suncodes/jot/issues) 提交复现步骤和建议，提交代码前请阅读 [贡献指南](CONTRIBUTING.md)。安全问题请按 [SECURITY.md](SECURITY.md) 处理，不要在公开 Issue 中附上密钥或私人笔记。

Jot 原创源码、文档和随附能力说明采用 [Apache-2.0](LICENSE)。第三方组件保留各自许可，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和 [NOTICE](NOTICE)。
