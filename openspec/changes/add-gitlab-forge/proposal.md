## Why

公司代码托管在自建 GitLab 上（例如 18.x），不用 GitHub。dsh-superagent 的启动、worker 凭据、PR 绑定、仓库读取、prompt 和 setup 引导都写死了 GitHub。本分支在 Forge 抽象层（摘自 feat/gerrit-support 的 `13246aa`，不带 Gerrit）之上增加 GitLab forge 和 GitLab Source，GitHub 行为保持逐字不变。

## What Changes

- `forge` 配置取值改为 `github | gitlab`（默认 `github`）。去掉摘取时带来的 Gerrit 占位（`GerritAccountsSchema`、`gerritOf`、`skill/gerrit` 等）。
- 新增 GitLab forge：智能体通过 `glab` CLI（用 `GLAB_CONFIG_DIR` 隔离账号的包装脚本）访问 GitLab REST API v4；`glab auth git-credential` 作为 git 凭据助手。GitLab 地址、project 都由运维在 setup 时填写，代码中不写死任何地址或版本。
- 新增 GitLab Source：Issue、MR、评论（含 diff 讨论）、MR 审批、MR 流水线与默认分支流水线变化、MR 合并与关闭，转成 Trigger；回复到原 Issue / MR 或原 discussion。
- 工单与 MR 的绑定规则与 GitHub PR 相同：来源 MR，或智能体账号从本仓库、分支最后一段等于 `DSH_SUPERAGENT_NAME` 的 MR。
- 新增 `prompts/forge/gitlab/*.md`、`skills/dsh-superagent-gitlab/SKILL.md`。
- SETUP.md、docs/006 支持 GitLab：探测 glab、询问 GitLab 地址与 project、包装脚本与登录步骤、profile 配置。

## Non-Goals

- 同一部署同时接 GitHub 和 GitLab。
- 部署在子路径下的 GitLab（`https://host/gitlab`）；地址只接受 `https://host[:port]`。
- SSH 推送；GitLab GraphQL；Todos API。
- 改动 SQLite schema 或 GitHub 的 KV、Thread 键。
