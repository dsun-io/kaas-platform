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
| `FASTGPT_API_BASE` | 默认 `https://api.fastgpt.cn/api` |
| `SQLITE_PATH` | 默认 `data/conversations.db` |

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
