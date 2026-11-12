## 1. 回归基线（只加测试，不改行为）

- [x] 1.1 新增 `tests/github-baseline.spec.ts`：用默认设置和 GitHub 部署渲染 orchestrator、worker 的完整内置 prompt、全部 `builtInParts`、两个 skill 以及 Executor 工具的 JSON schema，存为 vitest 快照 `tests/__snapshots__/github-baseline.spec.ts.snap`。验证：`pnpm test` 通过，快照文件已提交。
- [x] 1.2 新增执行环境快照：GitHub 部署从 Issue、PR 和飞书发起的工单，各自对应的 `ticketEnvironment` 变量名和取值。验证：测试通过。
- [x] 1.3 在改动前运行 `pnpm check` 并记录基线结果。验证：基线为全绿；如果原本就有失败，在 tasks 中注明，后续以基线为准。（基线：typecheck 通过；59 个测试文件、1197 个测试全部通过；build 成功。依赖用 `pnpm install --registry=https://registry.npmjs.org` 安装，因为公司镜像缺 `@deepseek-ai/schemastery@3.18.5-alpha.1`。）

## 2. Forge 接口与 Deployment 通用化

- [x] 2.1 新增 `src/forge/types.ts`，定义 `Forge`、`ForgeAccount` 和 `ForgeKind`，内容见 design D1。新增 `src/forge/index.ts`，导出静态表 `FORGES` 和 `forgeOf(kind)`。验证：`pnpm typecheck` 通过。
- [x] 2.2 在插件 `Config` 和 `Machine` 中加入 `forge: 'github' | 'gerrit'`，默认 `github`，并把它加进 `machineOf` 的白名单。验证：新增测试，非法取值时启动被拒绝，未设置时为 `github`。
- [x] 2.3 改造 `Deployment`：加入 `forge: ForgeAccount & {detail}`，`github` 改为可选，`repository` 由 `forge.repository` 派生（D3）。根据 `tsc` 的报错，逐个改正读取 `deployment.github` 的地方。验证：`pnpm typecheck` 通过。
- [x] 2.4 把 `resolveDeployment` 中 GitHub 的部分搬到 `src/forge/github.ts` 的 `resolve`，`src/deployment.ts` 改为按 `machine.forge` 分发。验证：`tests/deployment.spec.ts` 不改断言即可通过。
- [x] 2.5 `SetupPlace` 增加 `gerrit`。`SETUP_FIELDS` 和 `setupChanged` 只看选中 forge 和 feishu 的字段。`Setup.checkAccounts` 按 block 选 forge。验证：新增测试，Gerrit 部署修改 GitHub Source 字段时不触发 setup 检查；现有 `tests/settings.spec.ts` 通过。

## 3. worker 环境按 forge 生成

- [x] 3.1 把 `writeEnvironment` 和 `verifyEnvironment` 中 GitHub 专用的 shim、credential 段、`insteadOf` 段移到 `githubForge.environment`，通用部分保留在 `environment.ts`：MARKER、原子写入、屏蔽命令、LFS、`useConfigOnly`。验证：`tests/environment.spec.ts` 不改断言即可通过，生成的文件与改动前逐字节相同。
- [ ] 3.2 `WORKER_COMMANDS` 改为"通用的 git，加上当前 forge 的 CLI，加上 lark-cli"。Gerrit 部署下，`gh` 写成一个失败并提示改用 `gerrit` 的 shim。验证：新增测试，覆盖 Gerrit 部署下的 shim 列表和 `gh` 的提示文字。

## 4. 通用代码改走 forge

- [x] 4.1 `ExecutorToolsHost.github` 改为 `forge` 加 `forgeContext`。`orchestrator_report` 的评审单参数名和说明由 `forge.review.param` 生成，认领逻辑调用 `forge.review.claim`。GitHub 的实现包装现有的 `readPull` 和 `claimPull`。验证：`tests/tools.spec.ts` 通过，GitHub 部署的工具 schema 快照不变。
- [x] 4.2 `cards.ts` 改用 `forge.review.of`，`runtime.ts` 改用 `forge.review.endNotices`，替换 `pullOf` 和 `pullEndNotices`。验证：`tests/cards.spec.ts` 和 `tests/runtime.spec.ts` 通过。
- [x] 4.3 `assessment.ts` 改用 `forge.readPath`，`resources.ts` 改为注册 `forge.resource` 的前缀和读取函数，并把错误文字里的 "GitHub" 改为 `forge.words.forge`。验证：`tests/assessment.spec.ts`、`tests/views.spec.ts` 和资源相关测试通过。
- [x] 4.4 `skill-files.ts`、`context.ts`、`prompts.ts` 和 `sessions.ts` 中的内置 skill 改为"feishu 加上当前 forge 的 skill"。`PART_KEYS` 增加 `skill/gerrit`；非当前 forge 的 skill 覆盖内容不注册、不显示。验证：`tests/prompts.spec.ts` 和 `tests/prompt-config.spec.ts` 通过。
- [x] 4.5 `http.ts` 的 `setupView` 增加 `accounts.forge`，原有 `repository` 和 `agent` 字段保留。`src/app/api.ts` 同步类型。面板 `deployment.tsx` 显示 forge 种类，文案加入 `locales.ts`。验证：`tests/http.spec.ts` 和 `tests/panel-deployment.spec.tsx` 通过；新增断言检查 `accounts.forge.kind`。
- [x] 4.6 `src/core/assignments.ts` 的 `RECOVERY_NOTE` 中的 "GitHub state" 改为中性的说法，或由宿主注入 forge 用词，但 GitHub 部署的文字保持不变。验证：`tests/core-engine.spec.ts` 通过，快照不变。

## 5. prompt 模板化

- [ ] 5.1 让 `promptFile`、`builtInParts`、`teamDefaults`、内置 skill 都按 forge 生成（D10）：Gerrit 部署优先读取 `prompts/forge/gerrit/` 下的同名文件，skill 键按 forge 取 `skill/github` 或 `skill/gerrit`。验证：1.1 的 GitHub 快照逐字一致。
- [ ] 5.2 新增 `prompts/forge/gerrit/`，写入含托管用词的文件的 Gerrit 版本：一律用 `gerrit push` 上传（它负责 Change-Id 和 topic），不用仓库自带的 push 脚本，但上传前要执行"交付要求"列出的检查、修改时 amend 同一个提交、回复评论线程并标记 resolved、不投票也不 Submit、不新开 change。片段在 Gerrit 部署中替换 GitHub 的对应片段。验证：新增 Gerrit prompt 快照测试；人工通读 Gerrit 渲染结果，确认没有残留的 PR 或 gh 字样（测试用正则断言）。
- [ ] 5.3 新增 `skills/dsh-superagent-gerrit/SKILL.md`：说明 `gerrit/` 资源路径、`gerrit api` 的用法、inline 回复和 resolve 的 REST 请求体示例、`change_number` 报告规则。验证：`tests/docs.spec.ts`（如有 skill 格式校验）通过，Gerrit 部署的 Session 注册了该 skill。

## 6. Gerrit 传输层与 forge 解析

- [ ] 6.1 新增 `src/forge/gerrit-http.ts`，用 `node:https` 实现请求函数。要求：
  - 解析 netrc；
  - 使用 Basic auth，可选 CA 文件；
  - 去掉 `)]}'` 前缀；
  - HTTP 错误转成 `CliError(code=status)`；
  - 校验路径，拒绝绝对地址、其他主机和 `..`；
  - 拼接 `projects/<p>` 和 `changes/<p>~<n>` 前缀；
  - 分页使用 `S=` 加 `_more_changes`。

  验证：单元测试用本地 https 测试服务器（自签证书加 CA 文件）覆盖 200、401、404、410、XSSI 前缀、分页、路径拒绝，并确认错误信息不含密码。
- [ ] 6.2 `Commands` 增加 `gerrit<T>(schema, method, path, body?)`；`api` 和 `pages` 在非 GitHub 部署下抛出明确的错误。验证：`tests/commands.spec.ts` 新增用例通过。
- [ ] 6.3 新增 `src/forge/gerrit.ts` 的 `resolve`。要求：
  - 检查凭据文件：普通文件、不是符号链接、权限不宽于 0600、包含该主机；
  - 调用 `accounts/self` 读取 id、用户名和邮箱；
  - 调用 `projects/<p>` 取得规范名；
  - 调用 `projects/<p>/access` 检查 `can_upload`；
  - 每种失败对应一个 `gerrit*` setup 错误码，并在 `setup.ts` 中加上中英文案。

  验证：针对每个错误码都有测试；`tests/locales.spec.ts` 通过。
- [ ] 6.4 时间工具：Gerrit 时间戳与 ISO 字符串互相转换，以及 `after:"…"` 查询参数的格式化。验证：往返测试，覆盖纳秒精度和 UTC。

## 7. worker 的 gerrit 命令与 git 环境

- [ ] 7.1 新增 `src/forge/gerrit-cli.ts`，提供 `api` 和 `credential get|store|erase` 子命令，复用 6.1 的请求代码。`tsdown.config.ts` 增加入口，产出带 shebang 的 `lib/gerrit-cli.js`。验证：构建产物存在；端到端测试在测试服务器上运行 `gerrit api accounts/self` 得到 JSON；`credential get` 对其他主机不输出任何内容。
- [ ] 7.2 `gerritForge.environment`：
  - 写 `<stateDir>/gerrit.json`，只含路径和地址，不含密码；
  - 写 `worker-bin/gerrit` shim，用 `process.execPath` 的绝对路径调用 node；
  - 在 git 配置中写 `[credential "<origin>"] helper` 和 `[http "<origin>"] sslCAInfo`，不写任何 hook 相关的设置；
  - `verify` 时用 `git config --get-all` 确认 helper 生效。

  验证：环境测试检查生成文件的内容；在临时裸仓库上通过本地 https git 服务器（或 helper 调用日志）确认 push 取到凭据，并且不会弹出密码提示。
- [ ] 7.3 把 Gerrit stable-3.10 的官方 `commit-msg` 原样放到 `vendor/gerrit/commit-msg`，在 `vendor/gerrit/README.md` 中记录来源 commit 和 Apache-2.0 许可证，并在 `package.json` 的 `files` 中加入 `vendor`。验证：测试比较文件的 sha256 与 README 中记录的值一致。
- [ ] 7.4 实现推送目标与远端解析（design D6a）：目标分支的三级优先级（参数、指向配置 Gerrit 的跟踪分支、project HEAD）；远端推送地址解析（HTTPS、`ssh://`、`user@host:path`，去掉 `/a/` 和 `.git`）；SSH 远端改用配置的 HTTPS 地址。验证：用临时仓库测试 gerrit-worker-environment spec 中"`gerrit push` 的推送目标"一节的每个场景，并断言命令前后 `git config --list --local` 不变。
- [ ] 7.5 实现 `gerrit push`（design D6）：用 7.4 的结果 `fetch` 后列出待上传提交；拒绝合并提交；用官方脚本为缺 Change-Id 的提交生成 Change-Id，再用 `commit-tree` 补写，同时保留作者、提交者和时间；用带旧值检查的 `update-ref` 更新分支；以 `refs/for/<b>%topic=<name>` 推送。验证：在临时仓库和本地裸仓库上测试 gerrit-worker-environment spec 中"上传前补全 Change-Id"一节的每个场景，包括一个提交缺失、多个提交部分缺失、补写不触发会失败的 pre-commit hook、amend 后 Change-Id 不变、没有可上传的提交、`createChangeId=false` 和 `fixup!`、远端分支已经前进、含合并提交、远端不符；另外断言工作区和 index 在命令前后不变，pre-push hook 被执行了一次。
- [ ] 7.6 Gerrit 的执行环境变量：`DSH_SUPERAGENT_GERRIT_URL`、`_PROJECT`、`_ACCOUNT`、`_COMMIT_EMAIL`、`_CHANGE`、`_CHANGE_REF`。验证：对飞书来源和 change 来源的工单各写一条测试，核对取值。

## 8. Gerrit Source

- [ ] 8.1 新增 `src/sources/gerrit-trigger.ts`：把 change、change message（含投票和 `<GERRIT_ACCOUNT_id>` 提及）、inline comment 转成 Trigger；只有投票、没有文字的消息也要生成 Trigger，文本写明投票内容。识别点名（用户名、邮箱、账号 id），判断是否为人（`autogenerated:`、`SERVICE_USER`、机器人名单），生成 Trigger id。验证：用 fixtures 中的 Gerrit JSON 做单元测试，覆盖 spec 中"点名和发送者类型""Thread 和 Trigger 的划分""投票"三节的每个场景。
- [ ] 8.2 新增 `src/sources/gerrit-channel.ts`：发送普通消息和 inline 回复，带 `tag`，不投票；先查重再发送；处理 gone。链接指向 change 或评论。验证：测试覆盖重试不重复、inline 回复的位置、请求体中没有 `labels`。
- [ ] 8.3 新增 `src/sources/gerrit-change.ts`：实现 `readChange`、`claimChange`、`observeChange`、`changesOf` 和 `changeEndNotices`（D9），并接入 `gerritForge.review`。验证：测试覆盖 gerrit-change-binding spec 的每个场景，包括 topic 不符、他人上传、已被占用、自动认领、新 patchset、restore，以及通知只发一次。
- [ ] 8.4 新增 `src/sources/gerrit-read.ts`：读取 `gerrit/` 资源（change、messages、comments、comment 线程、Verified）、`gerritThreadContext` 和 `readPath`。读文件和列目录按 design D9a 实现：文件用核心 REST，目录用 gitiles 的 `?format=JSON`。验证：单元测试覆盖读文件、gitiles 列目录、gitiles 返回 404 时的错误；评估读取 README 的测试走 Gerrit。
- [ ] 8.5 新增 `src/sources/gerrit.ts`：定义 kind，包括 schema、fields、facts、scope、policy 及接收表两行、find（编号和两种 URL 形式）、environment；作为插件入口注册 kind 和 forge；按 D7 实现轮询循环；增加 `KV.gerrit`。`package.json` 的 exports 增加 `./gerrit-watch`，`tsdown.config.ts` 增加入口。验证：`tests/sources.spec.ts` 新增 Gerrit 部分，用伪造的 `Commands.gerrit` 覆盖增量查询、分页、游标、接收范围、人工 Verified 投票送达、Thread 上投票汇总的更新、MERGED/ABANDONED、单个 change 失败、24 小时放弃、失败阈值。
- [ ] 8.6 GitHub 和 Gerrit 两个 Source 在未被选为 forge 时，都只报告 `notForge` 健康状态，不轮询。Runtime 在 ready 之后检查选中 forge 的 Source 插件是否已注册，未注册则在 `runtime` 健康项报错。验证：用测试覆盖 forge-selection spec 中"选中 forge 的 Source 必须启用"一节的三个场景。
- [ ] 8.7 `cordis.patch.yml` 加入 `dsh-superagent-gerrit`（`disabled: true`）。验证：`tests/bundle-patch.spec.ts` 通过，并新增断言检查该条目。

## 9. 文档与整体验证

- [ ] 9.1 更新文档：
  - `docs/006-deployment.md`：增加 Gerrit 部署一节，包括服务账号权限、netrc 与 0600 权限、CA、profile 中的 `forge`、prepare 命令示例（从 Gerrit clone 的本地仓库添加 worktree，并 `git fetch` `$DSH_SUPERAGENT_GERRIT_CHANGE_REF`）、`gerrit push` 如何补全 Change-Id 且不动仓库 hook、为什么不调用仓库自带的 push 脚本（以及如何把脚本中的检查写进"交付要求"，reviewer 需要人在 Gerrit 上添加），以及 CI 恢复时改用服务账号并加入机器人名单的建议；
  - `docs/007-architecture.md`：加入 Forge 一节，改写 "Source-specific dependencies"，补充模块表和测试表；
  - `docs/008-cookbook.md`：说明如何新增一个 forge。

  验证：`tests/docs.spec.ts` 和 `tests/class-docs.spec.ts` 通过。
- [ ] 9.2 运行 `pnpm check`（typecheck、test、build）。验证：全部通过；1.1 的 GitHub prompt 快照没有变化。
- [ ] 9.3 在公司的 Gerrit 3.10.0 测试 project 上做一次手动联调，并把结果记在本 change 目录的 `verification.md` 中：
  - setup 通过；
  - 在 change 上 @ 智能体会产生 Trigger；
  - 从飞书话题发起工单，智能体上传 topic 为工单短名的 change，并自动绑定；
  - inline 评论送达 worker，worker 回复并标记 resolved；
  - 员工手动投 `Verified+1`（或 `-1`）后，投票送达 worker；
  - 在带有仓库自带 hook 的工单目录中运行 `gerrit push`，确认 hook 行为与平时一致，上传的 change 带 Change-Id，topic 等于工单短名；
  - 在 `origin` 为 SSH 的仓库中运行 `gerrit push`，确认改用 HTTPS 上传成功，且仓库的远端配置没有被修改；
  - 人 +2 并 Submit 后工单以 merged 结束，飞书话题收到一条通知。

  验证：记录每一步的结果和截图链接。
