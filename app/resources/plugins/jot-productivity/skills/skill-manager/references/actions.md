# 能力操作

每次以 app_help 返回的参数为准。它的 parameters 描述 args，example 则是 app_manage 接收的完整对象。

## 创建

先查 capabilities.skill。新建不传 id，编辑才传现有 id。

```json
{"operation":"capabilities.skill","args":{"action":"save","content":{"name":"reading-notes","title":"阅读提纲","description":"从指定笔记整理阅读要点","body":"先读取指定原文，区分事实和疑问。","requiredTools":["read"]},"enabled":true}}
```

资源通过 capabilities.edit-resources 保存，正文说明何时读取相对路径。完成后用 capabilities.list 或 capabilities.get 查询实际状态，下一轮再加载新技能验证。

## 修改与复制

capabilities.get 获取定义，capabilities.resources 与 capabilities.read-resource 查询资源。预装内容不能直接改，先复制到当前库。替换引用前可通过 capabilities.impact 查看使用者；是否设置 replaceReferences 取决于用户的替代意图。

## 导入

查询 capabilities.import-preview，owner 选择 skill 或 plugin，source 为用户明确提供的目录。预览 token 对应本次文件清单；安装使用同一 owner 和 token 调用 capabilities.import-confirm。来源内容改变后应重新预览。用户取消使用 capabilities.import-cancel。

## 生效和诊断

用 capabilities.tool-enable 管理实际工具启停，capabilities.agent 管理自建智能体绑定。通用助手自动汇集可用能力，无需手工维护其自动列表。capabilities.tasks 查询后台绑定，capabilities.bind-tasks 修改明确的任务绑定。

工具不是凭清单创建的代码。修改完成需核对启用状态、缺失依赖和下一轮可用性；最终回答只报告实际完成的操作。
