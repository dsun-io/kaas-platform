"""S5 预览环境脚本共享库（ensure / teardown / preflight / render-config 共用）。

设计约束（README §2.3 + lead 2026-10-20 口径）：
  * **纯标准库** —— CI（ubuntu-latest）只有 python3，不许引入三方依赖；
  * **机密只从环境变量读**（NEON_API_KEY / CLOUDFLARE_API_TOKEN …），严禁写进任何文件；
  * **幂等** —— 已存在即复用，404 即视为成功，重复跑不出错；
  * **dry-run** —— 所有写操作经 `Runner.write()` 代理，``--dry-run`` 时只打印证据不调用；
  * **每步打印证据** —— 谁创建/复用/删除、返回的 id 是什么，全程可审计；
  * 生产资源红线：本库只操作名字带 ``preview`` 的 Neon 分支与 Hyperdrive config，
    绝不触碰 Neon 根分支与 ``kaas-prod-hyperdrive``。

常量说明：``KAAS_PREVIEW_KV_NAMESPACE_ID`` 与 ``kaas-preview-storage`` 这类**共享预览资源**
的标识在 CI 里以明文变量注入（不是机密）；脚本从环境变量读，代码不硬编码机密。
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

NEON_API_BASE = "https://console.neon.tech/api/v2"
CF_API_BASE = "https://api.cloudflare.com/client/v4"

# 预览资源命名约定（与 README §2.2 矩阵一致）：
#   Neon 分支  preview-pr-<num>      （从根分支派生）
#   Hyperdrive  kaas-preview-<num>   （→ 该 PR 的 Neon 分支）
#   R2 键前缀   pr-<num>/            （kaas-preview-storage 桶内）
#   KV 键前缀   pr-<num>:            （KAAS_PREVIEW namespace 内）
PR_SLUG_RE = re.compile(r"^[0-9]{1,9}$")  # slug = PR 号：唯一、确定性、可排序


class PreviewError(RuntimeError):
    """预览脚本 fatal 错误：打印给用户/CI 日志后直接退出非 0。"""


# ── 日志（测量纪律：完整不过滤，全部打印） ──────────────────────────────────
def log(msg: str) -> None:
    print(f"[preview {time.strftime('%H:%M:%S')}] {msg}", flush=True)


def step(title: str) -> None:
    print(f"\n=== {title} ===", flush=True)


def evidence(label: str, value) -> None:
    print(f"  ✔ {label}: {value}", flush=True)


def github_output(pairs: dict[str, str]) -> None:
    """有 GITHUB_OUTPUT 时写入 step outputs（CI），否则只打印。

    敏感值（连接串/密码/token）**只写文件、不进日志** ——  Neon 连接串含明文密码，
    且不是预注册 secret，GitHub 不会自动打码。
    """
    path = os.environ.get("GITHUB_OUTPUT")
    sensitive = ("DATABASE_URL", "PASSWORD", "TOKEN", "SECRET", "API_KEY")
    if path:
        with open(path, "a", encoding="utf-8") as fh:
            for key, value in pairs.items():
                fh.write(f"{key}<<__KAAS_EOF__\n{value}\n__KAAS_EOF__\n")
    for key, value in pairs.items():
        if any(s in key for s in sensitive):
            log(f"output {key} = ***（敏感值已写入 GITHUB_OUTPUT，不打印）***")
        else:
            log(f"output {key} = {value}")


def require_env(names: list[str]) -> dict[str, str]:
    missing = [n for n in names if not os.environ.get(n)]
    if missing:
        raise PreviewError(
            "缺少环境变量: " + ", ".join(missing) +
            "（CI 应由 repo secrets/variables 注入；本机测试用 $env:NAME=... 传入）")
    return {n: os.environ[n] for n in names}


# ── HTTP（urllib 裸实现） ───────────────────────────────────────────────────
def http_json(method: str, url: str, *, headers: dict[str, str] | None = None,
              payload: dict | None = None, timeout: int = 60,
              ok: tuple[int, ...] = (200, 201, 202)) -> tuple[int, dict | list | None]:
    """发请求并解析 JSON。返回 (status, body)；非 2xx 抛 PreviewError（带响应体）。"""
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Accept", "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", "replace")
            return resp.status, (json.loads(body) if body.strip() else None)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        if exc.code in ok:
            try:
                return exc.code, (json.loads(body) if body.strip() else None)
            except json.JSONDecodeError:
                return exc.code, None
        raise PreviewError(f"{method} {url} → HTTP {exc.code}: {body[:800]}") from exc
    except urllib.error.URLError as exc:
        raise PreviewError(f"{method} {url} → 网络错误: {exc}") from exc


def http_download(method: str, url: str, *, timeout: int = 60) -> tuple[int, bytes]:
    req = urllib.request.Request(url, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


class Runner:
    """dry-run 代理：写操作一律经它，--dry-run 时只打印。"""

    def __init__(self, dry_run: bool):
        self.dry_run = dry_run

    def write(self, desc: str, fn):
        if self.dry_run:
            log(f"[dry-run] 将执行: {desc}")
            return None
        log(f"执行: {desc}")
        return fn()


# ── Neon ────────────────────────────────────────────────────────────────────
class NeonClient:
    def __init__(self, api_key: str, project_id: str):
        self.project_id = project_id
        self.headers = {"Authorization": f"Bearer {api_key}"}

    def _url(self, path: str, **query) -> str:
        qs = ("?" + urllib.parse.urlencode(query)) if query else ""
        return f"{NEON_API_BASE}/projects/{self.project_id}{path}{qs}"

    def get_project(self) -> dict:
        _, body = http_json("GET", self._url(""), headers=self.headers)
        # Neon 单项目响应是 {"project": {...}} 包一层；容错两种形状
        return (body or {}).get("project", body)  # type: ignore[return-value,union-attr]

    def list_branches(self) -> list[dict]:
        _, body = http_json("GET", self._url("/branches"), headers=self.headers)
        return (body or {}).get("branches", [])  # type: ignore[union-attr]

    def find_branch(self, name: str) -> dict | None:
        for branch in self.list_branches():
            if branch.get("name") == name:
                return branch
        return None

    def create_branch(self, name: str, parent_id: str) -> dict:
        _, body = http_json("POST", self._url("/branches"), headers=self.headers,
                            payload={"branch": {"name": name, "parent_id": parent_id,
                                                # 不挂 endpoint 的分支拿不到连接串（实测 404
                                                # "endpoint not found"），创建时一并挂读写端点
                                                "endpoints": [{"type": "read_write"}]}})
        # Neon 创建响应包一层 {"branch": {...}}
        return (body or {}).get("branch", body)  # type: ignore[union-attr]

    def delete_branch(self, branch_id: str) -> bool:
        """删除分支；404（已不存在）= 幂等成功。返回是否真的删了。

        **双保险校验**（lead 2026-10-20 口径，不依赖 Neon Protected 本身）：
        删除前重拉分支列表，目标是任何 `parent_id` 为空的根分支、或名字等于
        `production` 的分支 ⇒ 拒绝删除并告警。两个条件独立校验，缺一即拒。
        """
        target = None
        for branch in self.list_branches():
            if branch.get("id") == branch_id:
                target = branch
                break
        if target is None:
            log(f"分支 {branch_id} 已不存在（404 幂等语义），跳过")
            return False
        roots = [b for b in self.list_branches() if not b.get("parent_id")]
        if (not target.get("parent_id")) or (target.get("name") == "production") \
                or any(r.get("id") == branch_id for r in roots):
            raise PreviewError(
                f"🛑 拒绝删除受保护分支: name={target.get('name')!r} id={branch_id} "
                "（根分支/production 双保险校验命中；若是误报请联系 lead）")
        http_json("DELETE", self._url(f"/branches/{branch_id}"), headers=self.headers,
                  ok=(200, 202, 404))
        return True

    def list_roles(self, branch_id: str) -> list[dict]:
        _, body = http_json("GET", self._url(f"/branches/{branch_id}/roles"),
                            headers=self.headers)
        return (body or {}).get("roles", [])  # type: ignore[union-attr]

    def list_databases(self, branch_id: str) -> list[dict]:
        _, body = http_json("GET", self._url(f"/branches/{branch_id}/databases"),
                            headers=self.headers)
        return (body or {}).get("databases", [])  # type: ignore[union-attr]

    def list_endpoints(self, branch_id: str) -> list[dict]:
        # Neon 该端点不支持 branch_id 过滤（实测返回全项目），客户端自行过滤
        _, body = http_json("GET", self._url("/endpoints"), headers=self.headers)
        endpoints = (body or {}).get("endpoints", [])  # type: ignore[union-attr]
        return [e for e in endpoints if e.get("branch_id") == branch_id]

    def create_endpoint(self, branch_id: str) -> dict:
        _, body = http_json("POST", self._url("/endpoints"), headers=self.headers,
                            payload={"endpoint": {"branch_id": branch_id,
                                                  "type": "read_write"}})
        return (body or {}).get("endpoint", body)  # type: ignore[union-attr]

    def wait_endpoint_active(self, branch_id: str, timeout_s: int = 180) -> dict:
        """轮询分支的读写 endpoint 直到可用。

        Neon 状态字段是 ``current_state``；"idle" = 计算缩容但端点可用（自动唤醒），
        也算就绪；只有 init/provisioning 这类中间态需要等。
        """
        import time as _time
        ready = {"active", "idle"}
        deadline = _time.time() + timeout_s
        while True:
            endpoints = [e for e in self.list_endpoints(branch_id)
                         if e.get("type") == "read_write"]
            if endpoints and str(endpoints[0].get("current_state", "")).lower() in ready:
                return endpoints[0]
            if _time.time() > deadline:
                raise PreviewError(
                    f"分支 {branch_id} 的 read_write endpoint 未在 {timeout_s}s 内就绪")
            _time.sleep(5)

    def connection_uri(self, branch_id: str, role: str, database: str,
                       pooled: bool = False) -> str:
        """拿分支连接串（含密码）。pooled=False 给迁移用（直连），True 也可给冒烟。"""
        _, body = http_json("GET", self._url(
            "/connection_uri", branch_id=branch_id, database_name=database,
            role_name=role, pooler="true" if pooled else "false"), headers=self.headers)
        uri = (body or {}).get("uri", "")
        if not uri:
            raise PreviewError(f"Neon 未返回连接串（branch={branch_id} role={role}）")
        return uri


# ── Cloudflare ──────────────────────────────────────────────────────────────
class CloudflareClient:
    def __init__(self, api_key: str, account_id: str):
        self.account_id = account_id
        self.headers = {"Authorization": f"Bearer {api_key}"}

    def _acct(self, path: str, **query) -> str:
        qs = ("?" + urllib.parse.urlencode(query)) if query else ""
        return f"{CF_API_BASE}/accounts/{self.account_id}{path}{qs}"

    # -- token 校验（preflight） --
    def token_verify(self) -> dict:
        _, body = http_json("GET", f"{CF_API_BASE}/user/tokens/verify",
                            headers=self.headers)
        return (body or {}).get("result", {})  # type: ignore[union-attr]

    def token_policies(self, token_id: str) -> list[dict]:
        """取 token 的 policies（permission_groups 名单）。失败返回 []（由调用方降级处理）。"""
        try:
            _, body = http_json("GET", f"{CF_API_BASE}/user/tokens/{token_id}",
                                headers=self.headers)
        except PreviewError as exc:
            log(f"⚠ 读取 token policies 失败（降级为探针式校验）: {exc}")
            return []
        return ((body or {}).get("result", {}) or {}).get("policies", [])  # type: ignore[union-attr]

    # -- Hyperdrive --
    def hyperdrive_list(self) -> list[dict]:
        _, body = http_json("GET", self._acct("/hyperdrive/configs"), headers=self.headers)
        return (body or {}).get("result", [])  # type: ignore[union-attr]

    def hyperdrive_find(self, name: str) -> dict | None:
        for cfg in self.hyperdrive_list():
            if cfg.get("name") == name:
                return cfg
        return None

    def hyperdrive_create(self, name: str, *, host: str, port: int, user: str,
                          password: str, database: str) -> dict:
        _, body = http_json("POST", self._acct("/hyperdrive/configs"), headers=self.headers,
                            payload={"name": name, "origin": {
                                "type": "postgres", "scheme": "postgres",
                                "host": host, "port": port,
                                "user": user, "password": password, "database": database},
                                "caching": {"disabled": False}})
        return (body or {}).get("result", {})  # type: ignore[union-attr]

    def hyperdrive_delete(self, config_id: str) -> bool:
        """删除 config；404 = 幂等成功。返回是否真的删了。"""
        try:
            http_json("DELETE", self._acct(f"/hyperdrive/configs/{config_id}"),
                      headers=self.headers, ok=(200, 202, 404))
            return True
        except PreviewError as exc:
            if "404" in str(exc):
                return False
            raise

    # -- R2 / KV（探测与清理用） --
    def r2_list_buckets(self) -> list[dict]:
        _, body = http_json("GET", self._acct("/r2/buckets"), headers=self.headers)
        return (body or {}).get("result", {}).get("buckets", [])  # type: ignore[union-attr]

    def kv_list_keys(self, namespace_id: str, prefix: str) -> list[dict]:
        """分页拉全某前缀下的所有键（测量纪律：不截断）。"""
        keys: list[dict] = []
        cursor = ""
        while True:
            query: dict[str, str] = {"prefix": prefix, "limit": "1000"}
            if cursor:
                query["cursor"] = cursor
            _, body = http_json("GET", self._acct(
                f"/storage/kv/namespaces/{namespace_id}/keys", **query),
                headers=self.headers)
            result = (body or {}).get("result", [])  # type: ignore[union-attr]
            info = (body or {}).get("result_info", {})  # type: ignore[union-attr]
            keys.extend(result)
            cursor = info.get("cursor") or ""
            if not cursor or not result:
                break
        return keys

    def kv_delete_key(self, namespace_id: str, key_name: str) -> None:
        quoted = urllib.parse.quote(key_name, safe="")
        http_json("DELETE", self._acct(
            f"/storage/kv/namespaces/{namespace_id}/keys/{quoted}"),
            headers=self.headers, ok=(200, 204, 404))

    def workers_subdomain(self) -> str:
        """账号的 workers.dev 子域（拼预览 URL 用）；无则返回 ''。"""
        try:
            _, body = http_json("GET", self._acct("/workers/subdomain"),
                                headers=self.headers)
            return ((body or {}).get("result", {}) or {}).get("subdomain", "")  # type: ignore[union-attr]
        except PreviewError as exc:
            log(f"⚠ 读取 workers.dev 子域失败: {exc}")
            return ""

    def delete_worker(self, script: str) -> bool:
        """删除 worker（预览回收用）；404 = 幂等成功。返回是否真的删了。"""
        try:
            http_json("DELETE", self._acct(f"/workers/scripts/{script}"),
                      headers=self.headers, ok=(200, 202, 404))
            return True
        except PreviewError as exc:
            if "404" in str(exc):
                return False
            raise


# ── 公共小工具 ──────────────────────────────────────────────────────────────
def parse_pr_slug(raw: str | None) -> str:
    """slug 只允许纯数字 PR 号（命名确定、无注入面）。非法即拒绝。"""
    slug = (raw or "").strip()
    if not PR_SLUG_RE.match(slug):
        raise PreviewError(
            f"PR slug 非法: {raw!r}（只允许 1-9 位纯数字 = PR 号；例: --pr 123）")
    return slug


def parse_postgres_uri(uri: str) -> dict:
    """postgres://user:pass@host:port/db?... → 连接五要素（给 Hyperdrive origin 用）。"""
    parsed = urllib.parse.urlparse(uri)
    if parsed.scheme not in ("postgres", "postgresql"):
        raise PreviewError(f"连接串 scheme 非法（不含密码明文不回显，只显 scheme）: {parsed.scheme}")
    host = parsed.hostname or ""
    try:
        port = parsed.port or 5432
    except ValueError as exc:
        raise PreviewError("连接串端口非法") from exc
    return {
        "host": host, "port": port,
        "user": urllib.parse.unquote(parsed.username or ""),
        "password": urllib.parse.unquote(parsed.password or ""),
        "database": (parsed.path or "/").lstrip("/").split("?")[0],
    }


def fail(msg: str) -> "NoReturn":  # noqa: F821
    log(f"❌ {msg}")
    sys.exit(1)
