## Purpose

规定工单如何与 Gerrit change 绑定：哪些 change 属于哪个工单、一个 change 同时只属于一个进行中的工单、change 结束如何通知 IM，以及智能体在 change 上能做和不能做的事。

## ADDED Requirements

### Requirement: 哪些 change 可以属于工单
只有下列 change SHALL 可以被认领给工单：
- 工单的来源 change：工单由该 change 上的 Trigger 发起；
- 工单自己的 change：位于配置的 project，当前 patchset 由智能体账号上传，topic 等于工单短名 `DSH_SUPERAGENT_NAME`。

其他 change SHALL 被拒绝，拒绝原因 SHALL 说明上面两条规则。

#### Scenario: 认领自己的 change
- **WHEN** 工单短名为 `fix-date-12`，worker 用 `gerrit push` 上传（推送目标为 `refs/for/main%topic=fix-date-12`）后，以 `change_number` 报告 progress
- **THEN** change 被绑定到工单，工单开始跟随 `gerrit:<编号>`，报告被记录

#### Scenario: topic 不符
- **WHEN** worker 报告一个由智能体上传、但 topic 为空的 change
- **THEN** 报告被拒绝，原因说明需要来源 change，或者 topic 等于 `DSH_SUPERAGENT_NAME` 的 change

#### Scenario: 别人上传的 change
- **WHEN** worker 报告一个由他人上传、topic 恰好等于工单短名的 change
- **THEN** 报告被拒绝

### Requirement: 一个 change 只属于一个进行中的工单
同一个 change 同时 SHALL 至多被一个未结束的工单认领。另一个未结束工单已认领时，认领 SHALL 被拒绝。

#### Scenario: 已被占用
- **WHEN** 工单 A 已认领 change 100，工单 B 的 worker 报告 change 100
- **THEN** 工单 B 的报告被拒绝，原因是该 change 已属于另一个进行中的工单

### Requirement: 自动认领
轮询读到配置 project 中一个打开的 change，且它由智能体上传、topic 恰好匹配一个未结束工单的短名时，SHALL 自动认领给该工单。工单已经跟随另一个打开的 change 时，SHALL NOT 自动认领，只有 worker 的报告可以改变。

#### Scenario: worker 忘记报告
- **WHEN** worker 上传了 topic 为工单短名的 change，但没有调用 `orchestrator_report`
- **THEN** 下一轮轮询把该 change 绑定到工单

### Requirement: 新 patchset 不产生新的绑定
在已绑定的 change 上上传新 patchset（同一 Change-Id）SHALL 保持原有绑定，不创建新的 Thread，不改变工单跟随的内容。

#### Scenario: 按评审意见修改
- **WHEN** worker amend 提交后再次运行 `gerrit push`，产生 patchset 2
- **THEN** 工单仍跟随同一个 `gerrit:<编号>`，change 上的新评论继续送达 worker

### Requirement: 智能体的权限边界
智能体在 Gerrit 上 SHALL 只做以下操作：上传 patchset、发布评论和回复、把自己发起的评论标记为已解决、回复评审者的评论线程。智能体 SHALL NOT 投 `Code-Review` 或 `Verified` 票，SHALL NOT Submit，SHALL NOT abandon 或 restore 他人的 change，SHALL NOT 修改 project 配置。合并 SHALL 由人完成。

#### Scenario: 评审通过后的处理
- **WHEN** 智能体的 change 获得 `Code-Review +2`，并由员工手动投了 `Verified +1`
- **THEN** 智能体不 Submit，只报告 change 已可合并；工单在人 Submit 后以 merged 结束

### Requirement: change 结束时的 IM 通知
工单因跟随的 change 合并或 abandon 而结束时，系统 SHALL 向工单的非 Gerrit 渠道（如飞书话题）各发一条通知，且只发一次。通知包含指向 change 的链接和结果：合并，或关闭未合并。语言规则与现有 PR 通知相同。Gerrit 渠道本身 SHALL NOT 收到这条通知。

#### Scenario: 飞书来源的工单合并
- **WHEN** 一个从飞书话题发起的工单，其 change 12345 被合并
- **THEN** 该飞书话题收到一条中文通知，带有指向 `<服务器地址>/c/<project>/+/12345` 的链接，并说明已合并；Gerrit change 上没有额外通知

#### Scenario: 重复事件
- **WHEN** 由于重启，同一个合并结果被处理两次
- **THEN** 飞书话题只有一条通知
