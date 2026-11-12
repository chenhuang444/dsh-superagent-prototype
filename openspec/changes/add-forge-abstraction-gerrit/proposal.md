## Why

公司代码托管在私有部署的 Gerrit 3.10.0 上，不用 GitHub。dsh-superagent 现在把 GitHub 同时当作"消息来源"和"部署前提"：启动必须解析出 GitHub 仓库和 `gh` 账号，worker 的 git 凭据、PR 绑定、合并通知、仓库读取和 prompt 都写死了 GitHub。不把这层抽出来，Gerrit 只能以替换 GitHub 的方式接入，fork 以后就无法再同步上游。

## What Changes

- 新增"代码托管"（forge）这一层：每个部署只选一个 forge（`github` 或 `gerrit`），由插件配置的新字段 `forge` 指定，默认 `github`。启动、worker 环境、评审单绑定、结束通知、仓库读取、资源读取、内置 skill 都从选中的 forge 取，不再直接引用 GitHub。
- 现有 GitHub 行为改为 forge 的一个实现，对外行为不变：不改配置的部署照旧运行，GitHub 部署渲染出的内置 prompt 与现在逐字相同。
- 新增 Gerrit Source 和 Gerrit forge：
  - 轮询一个 Gerrit project 里的 change，把 change message（含投票，例如员工手动投的 `Verified+1`）、inline comment 和新 change 转成 Trigger；
  - 识别 `@用户名`、`@邮箱` 和 Gerrit 的账号提及作为点名；
  - 通过 review API 回复，包括 inline 回复和标记 resolved；
  - change MERGED 或 ABANDONED 时结束对应工单。
- 新增 Gerrit 的 worker 环境：打包一个 `gerrit` 命令供 worker 调用 REST API，同时作为 git credential helper。它的 `gerrit push` 子命令在上传前检查 Change-Id，缺的话用 Gerrit 官方 commit-msg 脚本补上（作为单独执行的脚本，不安装为 hook），再以工单的 topic 推送。不调用仓库自带的 push 脚本，也不读取仓库里的推送配置文件。系统不改动仓库自带的 hook。凭据来自运维指定的 netrc 格式文件，用 HTTPS + HTTP 密码。提交身份使用智能体账号在 Gerrit 上登记的邮箱。
- 工单与 change 的绑定规则：change 是工单的来源 change，或者是智能体账号上传、topic 等于工单短名（`DSH_SUPERAGENT_NAME`）的 change。智能体只上传 patchset、回复评审，不做 +2，也不 Submit。
- `Deployment` 里写死的 `repository` 和 `github` 字段改为通用的 forge 账号结构。这是**内部 BREAKING** 变更：第三方 Source 插件如果读了 `deployment.github` 需要改用新字段。
- `/orchestrator/api/state` 的 `setup.accounts` 增加 `forge` 字段，原有字段保留。
- 不在本次范围：仓库定制的 push 脚本（例如按分支拼接 reviewer）、`.gitreview`、飞书项目 Source（单独的后续 change）、同一部署同时接 GitHub 和 Gerrit、SSH 访问 Gerrit、Gerrit Checks API、Gerrit 默认分支 CI。

## Capabilities

### New Capabilities
- `forge-selection`: 部署如何选定唯一的代码托管、启动时检查什么、未配置时 GitHub 默认行为如何保持不变，以及通用代码通过 forge 取得的能力（绑定、通知、仓库读取、资源、skill、prompt 用词）。
- `gerrit-source`: Gerrit 作为来源和回复渠道的行为：读哪些事件、什么算点名、接收表各行、投票（含手动 Verified）、change 结束、回复与链接、搜索。
- `gerrit-change-binding`: 工单与 Gerrit change 的绑定和解绑规则、一个 change 只属于一个进行中的工单、change 结束时的 IM 通知。
- `gerrit-worker-environment`: worker 访问 Gerrit 的命令、凭据文件的要求与保护、git 凭据和提交身份、执行环境变量。

### Modified Capabilities
<!-- 仓库此前没有 openspec/specs，无已有能力可修改。 -->

## Impact

- 代码：
  - `src/deployment.ts`、`src/setup.ts`、`src/app/setup.ts`
  - `src/infra/commands.ts`、`src/infra/environment.ts`
  - `src/app/runtime.ts`、`src/app/tools/executor.ts`、`src/app/cards.ts`、`src/app/assessment.ts`、`src/app/resources.ts`
  - `src/app/prompts.ts`、`src/app/sessions.ts`、`src/app/context.ts`、`src/app/skill-files.ts`、`src/app/http.ts`
  - `src/kv.ts`、`src/client/deployment.tsx`、`src/client/locales.ts`
  - 新增 `src/forge/` 和 `src/sources/gerrit*.ts`
- 打包：`package.json` 的 exports 和 `tsdown.config.ts` 增加 `./gerrit-watch` 和 worker 用的 `gerrit` 命令；`vendor/gerrit/commit-msg` 收录官方脚本（Apache-2.0）；`cordis.patch.yml` 加入默认禁用的 Gerrit Source 插件。
- 内容：新增 `skills/dsh-superagent-gerrit/SKILL.md`。`prompts/` 中引用 PR、GitHub 的句子改为按 forge 替换的模板。
- 文档：更新 `docs/006-deployment.md`、`docs/007-architecture.md`、`docs/008-cookbook.md`，补充 Gerrit 部署步骤（凭据文件、`gerrit push`、prepare 命令示例）。
- 数据：SQLite schema 不变。Thread 键 `github:<n>` 和 GitHub 的 KV 记录保持原样；Gerrit 使用新的 `gerrit:<n>` 键和 `gerrit-*` KV 前缀。
- 外部依赖：Gerrit REST API（3.10）。不引入新的 npm 依赖：HTTP 请求用 Node 自带的 `node:https`，以便支持自签 CA 文件。
