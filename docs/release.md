# 公开源码与 Windows 发布

## 公开范围

当前工程继续作为正式开发和公开仓库目录。历史设计文档、过程记录、原型及本地开发规则可以留在原位置，由 `.gitignore` 排除，无需移到仓库外。已经跟踪的文件不会因为新增忽略规则自动停止跟踪；首次公开前需核对并移出 Git 索引，保留本地文件。Git 历史最后单独清理，当前文档脱敏不等于旧提交已脱敏。

下面的源码导出用于核对公开文件范围和独立构建，也可作为交付快照；不要求切换到导出目录开发。

在 `app/` 执行：

```powershell
pnpm source:export
```

默认写到根目录的 `tmp/open-source/jot-版本号/`，目标必须为空。也可以用 `--out` 指定工程外的空目录。`SOURCE_MANIFEST.json` 记录每个导出文件的大小和 SHA256；快照不含 `.git`、真实 `.env`、笔记库、状态库、依赖、产物或历史阶段文档。

审核公开文件范围后，在当前工程完成首次公开前的索引与历史清理，再提交并推送到 `https://github.com/suncodes/jot`。导出脚本本身不执行 Git 操作，也不会改变当前仓库的跟踪状态或历史。

## 版本与检查

```powershell
cd "app"
pnpm install --frozen-lockfile
pnpm version:set 0.1.0
pnpm version:check
pnpm licenses:check
pnpm typecheck
pnpm lint
pnpm test:release
pnpm app:dist
pnpm test:packed open-source-release.spec.ts
pnpm release:artifacts
```

`version:set` 只更新包版本，不提交、不打标签。新增或升级依赖后先运行 `licenses:generate`，核对版本和版权文本后再检查；缺失的上游文本来源记录在 `licenses/supplemental.json`。

`app:dist` 生成 `dist/win-unpacked/` 和 `dist/Jot Setup 版本号.exe`。发行整理脚本检查必需资源及版本后生成：

```text
dist/release/
  Jot-版本号-windows-x64-setup.exe
  Jot-版本号-windows-x64.zip
  SHA256SUMS.txt
```

ZIP 包含完整运行目录和许可文件；不能只分发 `Jot.exe`。校验示例：

```powershell
Get-FileHash -LiteralPath "Jot-0.1.0-windows-x64.zip" -Algorithm SHA256
```

## GitHub 工作流

`ci.yml` 在 Windows 上检查元数据、许可证、类型、Lint、定向回归、构建及发行包冒烟，并上传候选产物。

`release.yml` 仅在维护者推送 `v*` 标签时运行，强制标签与 `app/package.json` 一致。它重新构建、测试发行包、生成 ZIP 和 SHA256，再创建 **草稿 Release**。0.x 或带预发行标识的版本标记为 prerelease；维护者检查后手动发布。

本地脚本不会推送标签、上传文件或创建远程 Release。首次发布前还需由维护者确认仓库公开范围和 Git 历史策略。代码签名与自动更新尚未配置，不能将校验值描述为签名或发布者身份保证。
