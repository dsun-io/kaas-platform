# 金标对照报告（golden diff）

- 左（将来 = 本地 Python worker）: http://localhost:8000
- 右（将来 = 本地 TS worker / 当前基线）: https://kaas.powervoy.com
- 时间: 2026-10-21T11:06:17+08:00
- 白名单字段: 见 golden/diff_responses.py 的 IGNORE_KEYS / IGNORE_KEY_RE（计划 §2：显式登记）

| # | 请求 | 期望 | 左 status | 右 status | 结论 |
|---|---|---|---|---|---|
| 1 | GET `/health` | 200 | ERR | 200 | 左端失败: URLError: <urlopen error [WinError 10061] 由于目标计算机积极拒绝，无法连接。> |
| 2 | GET `/openapi.json` | 200 | ERR | 200 | 左端失败: URLError: <urlopen error [WinError 10061] 由于目标计算机积极拒绝，无法连接。> |
| 3 | POST `/api/v1/auth/login` | 401 | ERR | 401 | 左端失败: URLError: <urlopen error [WinError 10061] 由于目标计算机积极拒绝，无法连接。> |
| 4 | GET `/api/v1/auth/me` | 401 | ERR | 401 | 左端失败: URLError: <urlopen error [WinError 10061] 由于目标计算机积极拒绝，无法连接。> |
| 5 | GET `/api/v1/auth/me` | 401 | ERR | 401 | 左端失败: URLError: <urlopen error [WinError 10061] 由于目标计算机积极拒绝，无法连接。> |

**汇总: 0/5 一致，5 存在差异/失败。**

## GET `/health`（health）

- 结论: 左端失败: URLError: <urlopen error [WinError 10061] 由于目标计算机积极拒绝，无法连接。>
- 左: status=URLError: <urlopen error [WinError 10061] 由于目标计算机积极拒绝，无法连接。> content-type=—
- 右: status=200 content-type=application/json

## GET `/openapi.json`（openapi_surface）

- 结论: 左端失败: URLError: <urlopen error [WinError 10061] 由于目标计算机积极拒绝，无法连接。>
- 左: status=URLError: <urlopen error [WinError 10061] 由于目标计算机积极拒绝，无法连接。> content-type=—
- 右: status=200 content-type=text/html

## POST `/api/v1/auth/login`（login_unknown_account）

> 不存在的账号 + 错误密码：探的是 401 形状，不碰真实账号（避免锁死/限流真实用户）。

- 结论: 左端失败: URLError: <urlopen error [WinError 10061] 由于目标计算机积极拒绝，无法连接。>
- 左: status=URLError: <urlopen error [WinError 10061] 由于目标计算机积极拒绝，无法连接。> content-type=—
- 右: status=401 content-type=application/json

## GET `/api/v1/auth/me`（me_no_token）

- 结论: 左端失败: URLError: <urlopen error [WinError 10061] 由于目标计算机积极拒绝，无法连接。>
- 左: status=URLError: <urlopen error [WinError 10061] 由于目标计算机积极拒绝，无法连接。> content-type=—
- 右: status=401 content-type=application/json

## GET `/api/v1/auth/me`（me_invalid_token）

- 结论: 左端失败: URLError: <urlopen error [WinError 10061] 由于目标计算机积极拒绝，无法连接。>
- 左: status=URLError: <urlopen error [WinError 10061] 由于目标计算机积极拒绝，无法连接。> content-type=—
- 右: status=401 content-type=application/json
