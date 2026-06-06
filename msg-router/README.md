# msg-router

RPA（千牛 / 拼多多）与 [FastGPT](https://cloud.fastgpt.cn) 在线版之间的轻量消息路由：统一管理 API Key、会话 `conversation_id`、转人工判定与 SQLite 对话日志。

## 环境

- Python 3.11+
- 在 FastGPT 中为工作流应用「电商售前助手」创建 **应用 API Key**（非账号 Key）

## 配置

```bash
cd msg-router
copy .env.example .env
# 编辑 .env，填入 FASTGPT_API_KEY
```

可选环境变量：

| 变量 | 说明 |
|------|------|
| `FASTGPT_API_KEY` | 必填，应用 API Key |
| `FASTGPT_API_BASE` | 默认 `https://cloud.fastgpt.cn/api` |
| `SQLITE_PATH` | 默认 `data/conversations.db` |
| `CHAT_AUGMENT_ENABLED` | 默认 `true`：根据买家原文做轻量意图归类，并向 FastGPT 注入「像真人、先答具体问题、禁机械开场」等行为说明；设为 `false` 则只转发原文（调试用） |

### 意图与回复风格（默认开启）

路由层会对买家消息做**关键词级意图归类**（如询价、物流、规格、售后等），把原话 + 意图 + 执行要求打成**一条 user 消息**发给 FastGPT，并附带 `variables`：`platform`、`intent_tags`、`intent_summary`。这样模型更容易先回应对方具体问题，减少「专属客服模板腔」。

若你在 FastGPT 工作流里配置了同名全局变量，可按意图分支走不同节点；**最终话术仍以应用内提示词与知识库为准**，本层只做轻量引导。

关闭增强：`.env` 中设置 `CHAT_AUGMENT_ENABLED=false` 后需重启 `uvicorn`。

## 安装与启动

```bash
cd msg-router
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --port 8000
```

## API

### `GET /health`

健康检查。

### `POST /v1/chat`

请求体：

```json
{
  "platform": "qianniu",
  "buyer_id": "buyer_xxx",
  "message": "牛栏网多少钱",
  "conversation_id": "conv_xxx"
}
```

- `platform`：`qianniu` 或 `pdd`
- `conversation_id`：可选；省略时由服务生成，后续轮次原样回传以维持 FastGPT 侧 `chatId` 上下文

响应体：

```json
{
  "reply": "……",
  "conversation_id": "conv_xxx",
  "should_transfer": false,
  "response_time_ms": 1200
}
```

### 转人工关键词

消息命中 **转人工、找人工、真人、人工客服** 时，不调用 FastGPT，直接 `should_transfer: true` 并返回固定话术。

### FastGPT 调用失败

统一兜底回复：`稍等，我帮您转接人工客服`。

## 对话日志

SQLite 表 `chat_logs`：`id`, `platform`, `buyer_id`, `message`, `reply`, `conversation_id`, `should_transfer`, `response_time_ms`, `created_at`（UTC ISO8601）。

查看示例：

```bash
sqlite3 data/conversations.db "SELECT id, platform, substr(message,1,40), should_transfer, created_at FROM chat_logs ORDER BY id DESC LIMIT 5;"
```

## 本地验证（curl）

```bash
curl -s http://localhost:8000/health

curl -s http://localhost:8000/v1/chat -H "Content-Type: application/json" -d "{\"platform\":\"qianniu\",\"buyer_id\":\"buyer_test\",\"message\":\"你好\"}"
```

第二轮带上返回的 `conversation_id` 即可验证多轮上下文。
