# Memory Gardener Playbook

文中的层名和路径是默认布局示例；按当前工作区记忆架构选择实际文件，必要时按该架构补建。

这是 `myagents-memory-gardener` 的操作手册。原则在 `SKILL.md`，这里只写怎么下手。

## 1. 合并同根规则

`04-MEMORY.md` / `MEMORY.md` 里最常见的膨胀，是同一个原则的多个案例变体。

识别信号：

- 多条规则有相同触发词、相同修法或相同失败模式。
- 条目里出现“同根”“类似”“另一个案例”。
- 删除案例后，剩下的行为规则几乎一样。

合并格式：

```markdown
- **<原则名>。** 触发条件：<3-5 个信号>。行动：<一句硬规则>。案例与细节见 `memory/topics/<topic>.md#<anchor>`。
```

纪律：

- 触发条件必须保留；触发条件比故事更能激活下次行为。
- 案例正文下放到 topic，不直接丢掉。
- 一次运行处理 2-4 簇即可，避免把整编变成大型重写。

## 2. 下放故事和证据

自动装载层应该保存“下次会改变行为的规则”，不保存完整故事。

下放位置：

- 项目细节 -> `memory/topics/<project-or-domain>.md`
- 跨项目工程教训 -> `memory/topics/engineering.md`
- 协作/沟通偏好 -> `memory/topics/collaboration.md`
- 方法论/反思案例 -> `memory/topics/meta.md`

topic 里要保留日期、案例、根因、修法；自动装载层只留指针。

## 3. USER 层聚类

`03-USER.md` / `USER.md` 不应该是按日期堆积的观察流水。把观察聚成稳定偏好：

```markdown
- **<稳定偏好>。** 触发词：<词表>。响应方式：<一句行动规则>。案例见 `memory/topics/collaboration.md#<anchor>`。
```

保留触发词表。触发词是 USER 层最有操作价值的部分。

## 4. 删除判断

删前问一个问题：**删掉这条，下次会具体犯什么错？**

- 答得出具体错误 -> 留、合并或下放。
- 只是少一条知识 -> 下放到 topic。
- 情境不存在了、工具换了、项目死了 -> 删除或标历史。
- 判断不确定但可能是信念级 -> 放入 `memory/gardener/flags-for-molt.md`。

## 5. 日志洞补记

如果 lint 报“有 git 活动但缺日志”：

1. `git log --since=<date> --until=<date+1> --stat` 看当天事实。
2. 在 `memory/YYYY-MM-DD.md` 写 2-3 行补记，开头标明“园丁事后补记，基于 git log”。
3. 只记录事实，不虚构当时的思考。

## 6. Drill 抽查

随机抽 3 条自动装载层条目：

- 还成立吗？
- 指针有效吗？
- 与其他条目重复吗？
- 是否放在了正确层级？

发现问题，当场处理或写进报告的 deferred 段。

## 7. flags-for-molt

园丁不改 SOUL，但要给 molt 留队列：

```markdown
- [YYYY-MM-DD] <类型: 信念存疑 / SOUL 不一致 / 底层原则过时 / 结构提案> <一句话> <证据指针>
```

molt 处理后再清理对应条目。
