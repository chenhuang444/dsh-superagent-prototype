## Purpose

规定一个 dsh-superagent 部署如何选定唯一的代码托管（forge），启动时检查什么，以及通用功能如何经由选中的 forge 取得代码托管相关的行为，使 GitHub 与 Gerrit 可以互换而核心工单逻辑不变。

## ADDED Requirements

### Requirement: 每个部署只有一个 forge
部署 SHALL 通过插件配置项 `forge` 选择且只选择一个代码托管，取值为 `github` 或 `gerrit`。未设置时 SHALL 视为 `github`。取值以外的内容 SHALL 被拒绝，并在启动日志中说明合法取值。

#### Scenario: 未设置 forge 的已有部署
- **WHEN** 一个现有 GitHub 部署升级后没有设置 `forge`
- **THEN** 系统按 `github` 运行，Source 设置、Thread、工单、KV 记录均无需迁移

#### Scenario: 取值非法
- **WHEN** `forge` 被设为 `gitlab`
- **THEN** 插件拒绝启动，并在日志中指出 `forge` 只接受 `github` 或 `gerrit`

### Requirement: 启动只检查选中的 forge
Setup SHALL 只解析选中 forge 对应 Source 的账号配置：智能体账号、目标仓库或 project、写入权限。未选中 forge 的 Source 配置缺失或错误 SHALL NOT 产生 setup 问题。选中 forge 解析失败时，系统 SHALL 停在等待 setup 状态，与现在 GitHub 解析失败时的行为一致，并在面板指出出错的 Source。

#### Scenario: Gerrit 部署不需要 GitHub
- **WHEN** `forge` 为 `gerrit`，且 GitHub Source 没有配置仓库和 CLI
- **THEN** setup 成功，面板不显示任何 GitHub 的 setup 问题

#### Scenario: 选中 forge 无写权限
- **WHEN** `forge` 为 `gerrit`，智能体账号对配置的 project 没有上传权限
- **THEN** setup 停在等待状态，面板在 Gerrit Source 下显示"账号不能向该 project 上传"一类的问题，并给出账号和 project 名

#### Scenario: 飞书照常降级
- **WHEN** 选中 forge 解析成功，飞书 bot 解析失败
- **THEN** 系统照常就绪，仅缺少飞书，与现有行为一致

### Requirement: 选中 forge 的 Source 必须启用
选中 forge 对应的 Source SHALL 被视为部署所必需：
- 该 Source 实例在设置中被关闭时，行为与现在关闭 GitHub Source 相同：setup 照常完成，该 Source 的健康项显示"已关闭"，不轮询也不回复；
- 启动完成后，若该 Source 插件仍未注册（插件被禁用或未安装），`runtime` 健康项 SHALL 报告错误，并指出需要启用的插件 id。

未选中 forge 的 Source SHALL NOT 轮询，健康项显示"未被选为代码托管"。它的账号字段 SHALL NOT 参与 setup，可以保持安装。

#### Scenario: Gerrit Source 实例被关闭
- **WHEN** `forge` 为 `gerrit`，setup 已完成，人在设置中关闭了 Gerrit Source
- **THEN** Gerrit Source 的健康项显示已关闭，不再轮询；setup 状态不变，与关闭 GitHub Source 的现有行为一致

#### Scenario: Gerrit 插件被禁用
- **WHEN** `forge` 为 `gerrit`，但 profile 中 `dsh-superagent-gerrit` 插件处于禁用状态
- **THEN** `runtime` 健康项报告错误，并指出需要启用 `dsh-superagent-gerrit`

#### Scenario: Gerrit 部署中的 GitHub Source
- **WHEN** `forge` 为 `gerrit`，GitHub Source 插件仍然安装并启用
- **THEN** GitHub Source 不轮询，健康项为暂停，说明它未被选为代码托管

### Requirement: 通用功能经由 forge 取得托管行为
下列行为 SHALL 由选中的 forge 提供，通用代码 SHALL NOT 对某一种托管做特殊判断：
- worker 报告评审单（`orchestrator_report` 的评审单参数）时的读取和认领；
- 工单卡片上的评审单编号；
- 工单随评审单合并或关闭而结束时，发往 IM 的通知；
- 评估时读取仓库文件和目录；
- `orchestrator_read` 中该 forge 的原始资源前缀；
- 注册给 Session 的内置 forge skill；
- 执行环境变量；
- prompt 中代码托管的用词。

#### Scenario: Gerrit 部署的评估读取仓库文件
- **WHEN** `forge` 为 `gerrit`，评估需要读取仓库默认分支上的 `README.md`
- **THEN** 内容通过 Gerrit 读取，不调用 GitHub

#### Scenario: Gerrit 部署注册的 skill
- **WHEN** `forge` 为 `gerrit` 的部署创建 Executor Session
- **THEN** Session 拥有 `dsh-superagent-gerrit` skill，没有 `dsh-superagent-github` skill

### Requirement: GitHub 部署行为不变
选择 `github` 的部署 SHALL 保持现有的外部行为：轮询、回复、PR 绑定规则、合并通知文字、工具参数名（含 `pr_number`）、资源路径、执行环境变量名和取值、内置 prompt 的渲染结果。

#### Scenario: 内置 prompt 逐字一致
- **WHEN** 对 GitHub 部署分别用改动前后的代码渲染 orchestrator 和 worker 的完整内置 prompt
- **THEN** 两次渲染结果逐字相同

#### Scenario: 已有测试通过
- **WHEN** 在改动后运行仓库现有的 GitHub 相关测试
- **THEN** 测试全部通过，只允许因内部类型改名而调整 import

### Requirement: worker 报告评审单的参数按 forge 命名
`orchestrator_report` 的评审单参数 SHALL 按选中 forge 命名并说明：GitHub 部署为 `pr_number`（PR 编号），Gerrit 部署为 `change_number`（change 编号）。参数含义 SHALL 相同：可省略，传入时认领该评审单，被拒绝时整次报告不生效。

#### Scenario: Gerrit 部署报告 change
- **WHEN** Gerrit 部署的 worker 调用 `orchestrator_report`，状态为 progress，`change_number` 为 1234
- **THEN** 系统读取 change 1234，按 change 绑定规则认领，然后记录报告

#### Scenario: 使用错误的参数名
- **WHEN** Gerrit 部署的 worker 传入 `pr_number`
- **THEN** 工具因参数不合法而拒绝调用，且不记录报告

### Requirement: 面板和状态接口显示选中 forge
`/orchestrator/api/state` 的 `setup.accounts` SHALL 增加 `forge` 对象，包含托管种类、智能体账号名、仓库或 project 名和网页地址。原有的 `repository` 和 `agent` 字段 SHALL 保留并填入同样含义的值。部署设置页 SHALL 显示当前 forge。

#### Scenario: Gerrit 部署的状态
- **WHEN** Gerrit 部署 setup 成功后请求 `/orchestrator/api/state`
- **THEN** `setup.accounts.forge.kind` 为 `gerrit`，`setup.accounts.repository` 为 project 名，`setup.accounts.agent` 为智能体的 Gerrit 用户名
