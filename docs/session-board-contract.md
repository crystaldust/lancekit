# Session board contract

session-board 的上报端（每个会话里的 mod，Phase 2）和看板服务 `plugins/session-board/scripts/board.py` 之间唯一的数据契约。大屏页面（Phase 3）读的也是这里定义的汇总响应。改动服务或上报端时，同时更新这份文档。

契约版本：`v: 1`。

## Endpoints

| 方法 | 路径 | 令牌 | 成功 | 说明 |
|---|---|---|---|---|
| `POST` | `/api/sessions/<sessionId>` | 要 | `204` | 上报一个会话的状态，也用作心跳 |
| `GET` | `/api/sessions` | 要 | `200` | 汇总，JSON，带 `Cache-Control: no-store` |
| `GET` | `/` 或 `/index.html` | 要 | `200` | 看板页面 |
| `GET` | `/healthz` | 不要 | `200` | 响应体 `ok`，用来检查连通性 |

错误：

| 状态码 | 情况 |
|---|---|
| `401` | 没有令牌或令牌不对 |
| `400` | 上报体不符合本契约，响应体是一句说明哪个字段出错的文本 |
| `404` | 路径不存在，或 `sessionId` 不合法 |
| `413` | 缺 `Content-Length`、它不是纯数字、请求体为空，或超过 64 KiB |

请求体在 10 秒内没有按 `Content-Length` 发完时，服务直接断开连接，不回复。

## Auth

请求头 `Authorization: Bearer <token>`。页面也可以用查询参数 `?token=<token>`，因为浏览器打开链接时没法带请求头。服务用常量时间比较令牌。

令牌由启动参数 `--token`、环境变量 `SESSION_BOARD_TOKEN` 给出，都没有时服务随机生成一个，并打印在启动信息里。

## Session ID

只接受 `[A-Za-z0-9._-]{1,128}`，其他情况返回 `404`。服务只按会话 ID 区分卡片。`/clear` 和 resume 之后会话 ID 会变：上报端先把旧 ID 报为 `ended`，再用新 ID 上报，所以大屏上旧卡片变成已退出，另出一张新卡片。

## Report body

`POST` 的请求体是一个 JSON 对象：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `v` | `1` | 是 | 契约版本，不是 `1` 时返回 `400` |
| `host` | string，≤ 64 | 是 | 机器名 |
| `cwd` | string，≤ 512 | 是 | 会话工作目录 |
| `project` | string，≤ 128 | 是 | 显示用的项目名，上报端取 `cwd` 的最后一段 |
| `name` | string，≤ 64 \| null | 否 | 用户用 `/session-board name` 起的名称，大屏用它代替项目名做卡片标题；上报端最长发 40 字。服务把控制字符和不可见的格式字符（双向覆盖、零宽空格等）换成空格、合并空白，结果为空时按 `null` 处理 |
| `state` | `working` \| `needs-approval` \| `your-turn` \| `ended` | 是 | 失联不由上报端发，由服务判定 |
| `since` | 时间 | 是 | 进入当前状态的时间（上报端时钟） |
| `sentAt` | 时间 | 是 | 这次上报发出的时间（上报端时钟） |
| `detail` | string，≤ 200 \| null | 否 | 例如等批准时的 `Bash: pnpm test`；有后台任务在跑时的 `后台 2 个任务：shell · subagent` |
| `lastPrompt` | `{text, at}` \| null | 否 | 最后一次交代，只记录人自己的提示词（终端输入、Remote Control、`claude -p`），不记任务通知或其他会话发来的消息；`text` ≤ 2000 |
| `lastAnswer` | `{tail, at}` \| null | 否 | 最后一次回答的结尾；`tail` 是字符串数组，≤ 10 行、每行 ≤ 500 |
| `ecc` | object \| null | 否 | ECC 进度，见下 |

- **时间**：UTC 的 ISO 8601，精确到毫秒，以 `Z` 结尾，例如 `2026-11-03T08:00:00.000Z`。格式必须完全一致（两位补零、三位毫秒），年份在 2000–2099 之间，否则返回 `400`。
- **字符串**：必须是合法的 Unicode。JSON 允许的孤立代理字符（如 `\ud800`）返回 `400`。
- **长度**：`host`、`cwd`、`project`、`name`、`detail` 超长时返回 `400`。`lastPrompt.text` 和 `lastAnswer.tail` 超长时服务截断，不报错：`text` 保留前 2000 字，`tail` 保留最后 10 行，每行截到 500 字。
- **未知字段**：顶层的未知字段被丢掉，不报错。

### `ecc`

由 ecc-progress 的进度压缩而来：

```json
{
  "prd": { "title": "AI Short Drama Platform", "done": 3, "total": 8, "inProgress": ["4"] },
  "plan": { "name": "Overview web UI", "done": 3, "total": 14, "isArchived": false },
  "phase": "EXECUTE",
  "isActive": true
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `prd` | object \| null | `title` string ≤ 200；`done`、`total` 非负整数；`inProgress` 是阶段编号的字符串数组（≤ 64 项，每项 1–16 字），和 ecc-progress 的 `Milestone.n` 一致 |
| `plan` | object \| null | `name` string ≤ 200；`done`、`total` 非负整数；`isArchived` boolean |
| `phase` | string ≤ 32 \| null | `/prp-implement` 的当前阶段，例如 `EXECUTE` |
| `isActive` | boolean | 是否正在执行 `/prp-implement` |

每一层的未知键都被丢掉。

## Summary response

`GET /api/sessions` 返回：

```json
{ "v": 1, "now": "2026-11-03T08:00:05.000Z", "sessions": [ … ] }
```

每条 session 是上报体加上四个字段：

| 字段 | 说明 |
|---|---|
| `sessionId` | 上报路径里的 ID |
| `receivedAt` | 服务最后一次收到上报的时间（服务器时钟） |
| `waitingSince` | 换算到服务器时钟的 `since`：`since + (receivedAt − sentAt)`，消除机器之间的时钟偏差 |
| `isLost` | 非 `ended` 且超过 30 秒没有收到上报 |

### Order

1. 先按组：`needs-approval` → `your-turn` → `working` → 失联 → `ended`。
2. 组内按 `waitingSince` 从早到晚，等得越久越靠前。

## Timing

| 规则 | 值 |
|---|---|
| 上报端心跳间隔（Phase 2 实现） | 5 秒 |
| 判定失联 | 30 秒没有上报 |
| 删除 `ended` 的会话 | 最后一次上报后 10 分钟 |
| 删除失联的会话 | 最后一次上报后 1 小时 |

服务的状态只在内存里。服务重启后，各会话在下一次心跳时重新出现。

## Record file

启动时加 `--record <path>`，服务把每次状态变化追加为一行 JSON。心跳（`state` 和 `since` 都没变）不写。

```json
{"ts": "…", "sessionId": "s1", "host": "mac", "project": "app",
 "from": "needs-approval", "to": "working",
 "since": "…", "sentAt": "…", "receivedAt": "…",
 "reportDelayS": 0.4, "waitS": 95.2}
```

| 字段 | 说明 |
|---|---|
| `ts` | 写这一行的时间（服务器时钟） |
| `from` | 之前的状态；会话第一次出现时为 `null` |
| `to` | 新状态 |
| `reportDelayS` | `sentAt − since`：从状态变化到上报发出的延迟 |
| `waitS` | 仅当 `from` 是 `needs-approval` 时有：新的 `since` 减旧的 `since`，即等批准用了多久 |

`reportDelayS` 和 `waitS` 都只用同一台上报端的时钟做差，不受机器之间时钟偏差影响。秒数保留一位小数。

会话第一次出现的那一行（`from` 为 `null`）的 `since` 可能早于看板启动，例如看板重启后各会话重新上报，所以它的 `reportDelayS` 不代表上报延迟。`scripts/metrics.py` 只用 `from` 不为 `null` 的行统计延迟。

## Compatibility

- 只能新增可选字段。
- 删除字段或改变字段含义时，`v` 加 1，并在同一个提交里同时改服务、上报端和这份文档。
