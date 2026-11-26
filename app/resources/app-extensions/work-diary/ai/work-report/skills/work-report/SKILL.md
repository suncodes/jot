---
name: work-report
description: 根据工作草稿、工程日志和正式报告生成或更新工作日报、周报、月报及 OKR 进展，直接保存正式报告。
required_tools: [read, find_files, list_directory, app_help, app_manage]
---
# 工作总结

先确定报告类型、日期和用户材料范围，再加载对应规则。默认简体中文，面向主管说明事实、结果和下一步。

## 读取本次规则

生成日报、周报、月报或 OKR 进展前，调用 use_skill，name 使用本技能的完整标识（默认 work-report:work-report），path 按本次类型选择：

| request.kind | path | 规则 |
|---|---|---|
| daily | references/daily.md | [日报](references/daily.md) |
| weekly | references/weekly.md | [周报](references/weekly.md) |
| monthly | references/monthly.md | [月报](references/monthly.md) |
| okr | references/okr.md | [OKR](references/okr.md) |

例如生成日报时传 {"name":"work-report:work-report","path":"references/daily.md"}。本入口不包含各报告的完整格式要求；配套规则尚未读取时先读取，不能按印象生成。只修改已有报告的一处时，按该处要求处理，无需把整篇重写成默认模板。

## 路径与取材

用 app_help 的 group=work_reports 查询分组；查询单项使用 name=work_reports.write 等实际完整名称。返回的 parameters 是 args 的结构，example 是 app_manage 的完整参数，可按实际值填入。

1. 用 work_reports.profiles 查询入口名称、启停和公开 paths。多入口按用户选择；配置损坏需说明，不能当作未配置。
2. work_reports.prepare 的 source 使用 {"kind":"profile","extensionId":"实际标识","profileId":"实际入口"}，request.kind 从上表选择。未指定日期可省略 date；后续沿用返回的 request，避免跨午夜改变周期。
3. 没有入口时使用用户明确的 paths，例如 {"kind":"paths","paths":{"root":"content/实际工作根","draftDirectory":"草稿/{{yyyy}}年{{MM}}月","reportDirectory":"正式/{{yyyy}}年{{MM}}月","filename":"{{yyyy}}-{{MM}}-{{dd}}.md","worklogDirectory":null}}。不猜固定目录，不要求安装应用插件，也不另存 AI 配置。

prepare 只计算候选，不代表文件存在。path 是正式目标，days 是逐日草稿和正式日报，months 含原始 OKR、正式 OKR 和月报，weekly 是相交周报的实际路径。跨月／年使用这些路径，不手算另一套目录。省略日期取本地今天，周报周一至周五，当前周／月截至今天；周报归实际结束日所在月。

用 find_files／list_directory 核对候选，再 read 当前正文；有 nextRead 时继续读取需要范围。工程日志从 worklogDirectory 按“工程名/YYYY/YYYY-MM/YYYY-MM-DD.md”查找，空值不扫描全库猜来源；用户明确指定的外部目录可用绝对路径读取。目录缺失只说明来源缺失，不代表当天没有工作。用户 @ 与“仅根据材料”约束所有读取；prepare 不扩大权限，材料不足时说明或询问。必要时先读已有正式目标以保留人工说明，严格范围外不能回读旧内容。

## 事实与保存

草稿决定日报主题，工程日志补证据；周月报优先汇总正式日报／周报；OKR 从正式材料提炼进展。区分计划、分析、实现、静态校验、真实联调和发布。保留原文数量、范围和状态，同一事实只计一次；文件时间只能说明更新，不能据此推断当天成果。

用户要求生成或更新正式报告时，调用 work_reports.write，传同一 source、prepare 返回的 request 和 body。body 只传报告正文，不带 frontmatter；应用直接保存计算出的唯一正式目标并保留已有属性，无需先预览或再次询问。完整调用形如：

~~~json
{"operation":"work_reports.write","args":{"source":{"kind":"profile","extensionId":"work-diary","profileId":"today"},"request":{"kind":"daily","date":"2026-11-24"},"body":"# 工作日报\n\n有材料依据的今日进展。"}}
~~~

示例的入口、日期和正文须换成本次实际值。app_manage 只接收一个完整 JSON 参数对象；正文换行、引号按 JSON 转义，JSON 外不要附带说明文字或第二个对象。调用失败先按错误和 app_help 修正，不原样重复失败参数。

不使用普通 write_files 代替正式报告操作，也不传 path、skipConfirm；草稿和草稿 OKR 不随之修改。用户只要建议／对比／不保存时只回答。

保存正文用从正式目标到来源的相对 Markdown 链接，不用本轮片段编号；特殊字符需 URL 编码。跨盘外部来源用标准 file URL。以 updated／failed 为准判断保存结果，失败或停止不声称已保存。

## 完成前检查

1. 核对本次请求与实际目标：类型、日期／范围、路径是否一致，草稿是否保持。
2. 保存成功后用 read 回读最终报告，按对应规则核对结构和关键事实，确认没有漏段、重复内容或把计划写成已完成。长报告只继续读取需要核对的部分，局部修改只核对修改段落。
3. 正式目标在严格材料范围外时，不扩大读取范围；依据保存工具的回读一致结果，核对本轮提交正文。说明材料缺口，不能为填满章节编造计划或 OKR。
4. 若有遗漏，在本次授权内定向修正后再核对；无法完成时如实说明。完成后返回实际正式文件链接与仍缺少的材料，不向用户罗列内部检查步骤。
