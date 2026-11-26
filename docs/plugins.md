# 插件与技能

Jot 有两类扩展：AI 能力影响助手如何工作；应用插件增加受支持的界面命令。两者可以一起打包，但分别管理，不要求互相安装。

## AI 技能和插件

独立技能是包含 `SKILL.md` 的目录，可以有 `references/` 等配套资源。库内技能位于 `.jot/skills/`，AI 插件位于 `.jot/plugins/`；随发行版提供的包在 `app/resources/plugins/`。

最小技能示例：

```markdown
---
name: reading-notes
title: 阅读提纲
description: 从用户指定的笔记中整理要点和待确认问题。
required_tools: [read, search]
---
# 阅读提纲

先读取指定原文，整理有依据的要点与问题。默认只回答；用户要求保存时再调用可用写入工具。
```

`required_tools` 声明 Jot 中实际存在的必需工具，不产生工具实现。通过界面或助手的 `app_help`、`app_manage` 能力操作创建、编辑和导入；预装包需先复制为库内包再修改。改变的能力从下一轮提问开始生效。

AI 包使用 `plugin.json` 定义资源，当前格式和实例以 [预装包](../app/resources/plugins/) 及 [共享契约](../app/shared/capabilities.ts) 为准。本地 Codex、Claude 技能可导入诊断，但它们的平台工具、脚本和 hooks 不会自动变成 Jot 能力。

## 应用插件

当前协议是声明式命令和模板，支持 `daily-note` 与 `work-diary` 两类动作，暂不执行任意 JavaScript、注入界面或安装主题样式。包入口是 `extension.json`，库内安装到 `.jot/app-extensions/`；设置中管理启用、多个入口配置和快捷方式。

最小个人日记包：

```json
{
  "schemaVersion": 1,
  "apiVersion": 1,
  "id": "my-diary",
  "name": "我的日记",
  "version": "1.0.0",
  "description": "打开今天的日记",
  "minAppVersion": "0.1.0",
  "commands": [{
    "id": "today",
    "name": "写日记",
    "icon": "book-open",
    "action": "daily-note",
    "defaults": {
      "directory": "content/生活/日记/{{yyyy}}年/{{MM}}月",
      "filename": "{{yyyy}}-{{MM}}-{{dd}}.md",
      "template": { "kind": "none" }
    }
  }]
}
```

目录支持子目录与 `{{yyyy}}`、`{{MM}}`、`{{dd}}` 等受支持日期占位符，具体以 [日期路径契约](../app/shared/date-paths.ts) 为准。预装模板放包内 `templates/`，自定义模板放笔记库 `templates/`，不与 `content/` 中的正式笔记混合。

应用包可以通过 `aiPlugin.path` 引用包内标准 AI 插件目录。用户可选联装或后补安装，卸载应用包不等于卸载已安装的 AI 包。可参考 [个人日记](../app/resources/app-extensions/personal-diary/extension.json) 和 [工作日记](../app/resources/app-extensions/work-diary/extension.json)。导入包前请核对来源、资源清单与许可。
