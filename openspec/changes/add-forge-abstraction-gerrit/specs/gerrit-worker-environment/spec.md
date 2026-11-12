## Purpose

规定 Gerrit 部署中 worker 访问 Gerrit 的方式：worker 用什么命令调用 REST API，git 如何拿到凭据，凭据文件如何保护，提交身份，上传前如何补全 Change-Id，以及执行环境中提供哪些变量。

## ADDED Requirements

### Requirement: 凭据来自运维指定的文件
Gerrit 智能体账号的凭据 SHALL 来自运维在 Gerrit Source 中配置的 netrc 格式文件，该文件包含服务器主机名、用户名和 HTTP 密码。setup SHALL 检查该文件：是普通文件，不是符号链接；只有属主可读写（权限不宽于 0600）；包含服务器主机的条目。凭据 SHALL NOT 出现在 Source 设置、数据库、日志、prompt、执行环境变量或命令行参数中。

#### Scenario: 权限过宽
- **WHEN** 凭据文件权限为 0644
- **THEN** setup 停在等待状态，问题指出该文件必须只对属主可读写

#### Scenario: 缺少主机条目
- **WHEN** 凭据文件中没有 `gerrit.example.com` 的条目
- **THEN** setup 停在等待状态，问题指出文件中缺少该主机

### Requirement: setup 检查账号和权限
setup SHALL 以凭据调用 Gerrit，确认以下各项，任一项失败 SHALL 给出对应的 setup 问题：
- 账号可以登录；
- 账号有用户名和登记邮箱；
- project 存在且可读；
- 账号可以向 project 上传评审（push 到 `refs/for/*`）。

project 名 SHALL 采用 Gerrit 返回的规范名称。

#### Scenario: 密码错误
- **WHEN** 凭据文件中的 HTTP 密码已失效
- **THEN** setup 问题指出 Gerrit 账号无法登录，并附上 HTTP 状态码 401

#### Scenario: 没有上传权限
- **WHEN** 账号能读取 project，但没有上传权限
- **THEN** setup 问题指出该账号不能向该 project 上传

### Requirement: worker 的 gerrit 命令
Gerrit 部署的 worker SHALL 拥有一个 `gerrit` 命令，以智能体账号调用配置服务器的 REST API：
- 输入 API 路径、请求方法和 JSON 请求体；
- 输出去掉 Gerrit 防 XSSI 前缀后的 JSON；
- 失败时以非零状态退出，并输出 HTTP 状态码。

该命令 SHALL 只能访问配置的服务器，SHALL 拒绝绝对地址、其他主机，以及含 `..` 的路径。它 SHALL NOT 输出凭据。

#### Scenario: 读取 change
- **WHEN** worker 运行 `gerrit api changes/12345/detail`
- **THEN** 命令输出该 change 的 JSON，没有 `)]}'` 前缀

#### Scenario: 访问其他主机
- **WHEN** worker 运行 `gerrit api https://other.example.com/a/accounts/self`
- **THEN** 命令拒绝执行，并以非零状态退出

### Requirement: git 凭据与 GitHub 隔离
worker 的 git 配置 SHALL 只为配置的 Gerrit 服务器地址提供凭据，凭据由 `gerrit` 命令充当 credential helper 给出。其他主机 SHALL 得不到任何凭据，git SHALL 不弹出密码提示。Gerrit 部署 SHALL NOT 为 github.com 配置凭据。worker 环境中 SHALL 去掉宿主环境中的 GitHub token 变量，这与现有行为相同。

#### Scenario: 推送到 Gerrit
- **WHEN** worker 在工单目录运行 `gerrit push`，`origin` 指向配置的 Gerrit 服务器
- **THEN** 其中的 `git push` 通过 credential helper 取得智能体凭据，推送成功

#### Scenario: 推送到其他主机
- **WHEN** worker 尝试 `git push https://other.example.com/repo.git`
- **THEN** git 得不到凭据，失败且不提示输入密码

### Requirement: 提交身份
Gerrit 部署 SHALL 为 worker 提供智能体账号在 Gerrit 登记的邮箱作为提交邮箱。系统 SHALL NOT 修改 worker 的 git hook 配置：不设置 `core.hooksPath`，不在工单目录写入或替换任何 hook。仓库自带的 hook 按仓库自己的配置运行，与没有 dsh-superagent 时完全一样。

#### Scenario: 仓库自带 hook 照常运行
- **WHEN** 工单目录的仓库带有 pre-commit 和 commit-msg hook，worker 执行 `git commit`
- **THEN** 两个 hook 都按仓库配置执行，dsh-superagent 没有替换或包裹它们

#### Scenario: worker 的 git 配置
- **WHEN** 检查 Gerrit 部署写入的 worker git 配置
- **THEN** 其中没有 `core.hooksPath`，也没有任何 hook 相关的设置

### Requirement: `gerrit push` 的推送目标
worker 的 `gerrit` 命令 SHALL 提供 `push` 子命令，把当前 HEAD 上传为评审。推送目标为 `refs/for/<目标分支>`，附上 `topic=<工单短名>`，`--topic` 可以覆盖 topic。该命令 SHALL NOT 调用仓库自带的 push 脚本，也 SHALL NOT 读取仓库中的推送配置文件。

目标分支取下面第一个有值的：
1. `--branch` 参数；
2. 当前分支跟踪的远端分支，且该远端指向配置的 Gerrit；
3. project 在 Gerrit 上的 HEAD 分支。

远端取 `--remote` 参数，未指定时取 `origin`。

远端地址按推送地址（`git remote get-url --push`，包含 pushurl）处理：
- 如果是 HTTPS，并且指向配置的服务器和 project，就直接使用这个远端；
- 如果用的是其他协议（例如 `ssh://<user>@<host>:22222/<project>`），但主机和 project 与配置一致，就改用配置的 HTTPS 地址拉取和推送，不修改仓库的远端配置，并在输出中说明；
- `--remote` 指定的远端在仓库中不存在时，SHALL 报错；未指定且没有 `origin` 时，改用配置的 HTTPS 地址；
- 主机或 project 与配置不一致时，SHALL 拒绝执行。

#### Scenario: 默认目标分支
- **WHEN** 当前分支没有跟踪远端分支，worker 运行 `gerrit push` 时没有传 `--branch`，project 的 HEAD 分支是 `master`
- **THEN** 命令推送到 `refs/for/master`，topic 为工单短名

#### Scenario: 跟踪分支
- **WHEN** 当前分支跟踪 `origin/release-2.x`，worker 运行 `gerrit push`
- **THEN** 命令推送到 `refs/for/release-2.x`

#### Scenario: 参数优先
- **WHEN** 当前分支跟踪 `origin/release-2.x`，worker 运行 `gerrit push --branch master`
- **THEN** 命令推送到 `refs/for/master`

#### Scenario: origin 是 SSH
- **WHEN** `origin` 是 `ssh://dev@<host>:22222/<project>`，主机和 project 与配置一致
- **THEN** 命令通过配置的 HTTPS 地址用智能体凭据推送，输出说明改用了 HTTPS；仓库的 `origin` 配置不变

#### Scenario: 远端不是配置的 Gerrit
- **WHEN** 要使用的远端指向另一台主机或另一个 project
- **THEN** 命令拒绝执行，并说明远端地址与配置不符

### Requirement: 上传前补全 Change-Id
`gerrit push` SHALL 在推送前检查每个待上传提交，即 HEAD 可达、但目标分支在远端的最新提交不可达的提交。目标分支在远端前进了，SHALL NOT 要求先 rebase，Gerrit 本身也只按这组提交接收。具体要求如下：
- 缺少 Change-Id 的提交，SHALL 用 Gerrit 3.10 官方 commit-msg 脚本（作为独立脚本单独执行，不安装为 hook）生成 Change-Id 并补进提交说明。
- 补写提交 SHALL 保留原有的作者、提交者、时间、tree 和父提交关系，并且只改动缺少 Change-Id 的提交及其后代。
- 补写过程 SHALL NOT 触发仓库的任何 hook。
- 已有 Change-Id 的提交 SHALL 原样保留，amend 过的提交因此沿用原来的 Change-Id。
- 补写之后，本地分支 SHALL 指向新的提交，命令输出 SHALL 列出被补写的提交（原 sha 到新 sha）。
- 推送本身是一次普通的 `git push`，仓库的 pre-push hook 照常运行。
- 待上传提交中有合并提交时，SHALL 报错退出，不做补写和推送。

#### Scenario: 一个提交缺 Change-Id
- **WHEN** worker 在新工单目录提交一次，仓库没有 commit-msg hook，然后运行 `gerrit push`
- **THEN** 命令为该提交补上 `Change-Id: I<40 位十六进制>`，本地分支指向补写后的提交，并以 topic 为工单短名推送到 `refs/for/<HEAD 分支>`

#### Scenario: 多个提交部分缺失
- **WHEN** 待上传的 3 个提交中，第 2 个已有 Change-Id，第 1 和第 3 个没有
- **THEN** 第 1 和第 3 个补上新的 Change-Id，第 2 个保留原来的 Change-Id，3 个提交的作者、时间和 tree 都不变

#### Scenario: 补写不触发仓库 hook
- **WHEN** 仓库带有会失败的 pre-commit hook，worker 运行 `gerrit push`，且需要补写 Change-Id
- **THEN** 补写成功，pre-commit hook 没有被执行

#### Scenario: amend 之后再次上传
- **WHEN** worker 根据评审意见 amend 一个已有 Change-Id 的提交，然后再次运行 `gerrit push`
- **THEN** Change-Id 不变，Gerrit 把这次上传作为同一 change 的新 patchset

#### Scenario: 没有可上传的提交
- **WHEN** HEAD 与目标分支在远端的最新提交相同
- **THEN** 命令以非零状态退出，提示没有可上传的提交，不做任何推送

#### Scenario: 官方脚本没有生成 Change-Id
- **WHEN** 仓库设置了 `gerrit.createChangeId=false`，或者待上传的提交是 `fixup!`、`squash!` 提交，官方脚本因此没有加 Change-Id
- **THEN** 命令以非零状态退出，说明哪个提交缺 Change-Id 及原因，不做任何推送

#### Scenario: 远端分支已经前进
- **WHEN** worker 基于 `main` 的旧提交做了 1 个提交，此后别人往 `main` 合入了 3 个提交
- **THEN** 命令不要求 rebase，只检查并上传 worker 的这 1 个提交

#### Scenario: 含合并提交
- **WHEN** 待上传提交中有一个合并提交
- **THEN** 命令以非零状态退出，提示改为线性历史，不做补写和推送

### Requirement: 执行环境变量
Gerrit 部署的执行环境 SHALL 提供以下变量，且不包含凭据：
- `DSH_SUPERAGENT_GERRIT_URL`：服务器地址；
- `DSH_SUPERAGENT_GERRIT_PROJECT`：project 名；
- `DSH_SUPERAGENT_GERRIT_ACCOUNT`：智能体用户名；
- `DSH_SUPERAGENT_GERRIT_COMMIT_EMAIL`：提交邮箱；
- `DSH_SUPERAGENT_GERRIT_CHANGE`：发起工单的 change 编号，不是从 Gerrit 发起时为空；
- `DSH_SUPERAGENT_GERRIT_CHANGE_REF`：发起工单的 change 当前 patchset 的 ref，形如 `refs/changes/45/12345/3`，不是从 Gerrit 发起时为空。

#### Scenario: 飞书发起的工单
- **WHEN** 工单从飞书话题发起
- **THEN** `DSH_SUPERAGENT_GERRIT_CHANGE` 和 `DSH_SUPERAGENT_GERRIT_CHANGE_REF` 为空，其他 Gerrit 变量有值

#### Scenario: 来自 change 的工单
- **WHEN** 工单从 change 12345 当前 patchset 3 上的一条评论发起
- **THEN** `DSH_SUPERAGENT_GERRIT_CHANGE` 为 `12345`，`DSH_SUPERAGENT_GERRIT_CHANGE_REF` 为 `refs/changes/45/12345/3`

### Requirement: 被屏蔽的命令
在 Gerrit 部署中，`gerrit` 和 `git` SHALL 不能被执行设置里的屏蔽命令列表屏蔽。`gh` SHALL 被替换为一个失败并提示改用 `gerrit` 的命令，以免 worker 误用宿主机上登录的其他 GitHub 账号。

#### Scenario: worker 调用 gh
- **WHEN** Gerrit 部署的 worker 运行 `gh pr list`
- **THEN** 命令失败，提示本部署使用 Gerrit，请用 `gerrit` 命令
