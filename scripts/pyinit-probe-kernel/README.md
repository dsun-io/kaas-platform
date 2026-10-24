# kaas-pyinit-kernelclone（工单 A6 / E2b）

把**生产内核的同一份源码**部署成一个隔离的探针 Worker，用来回答 E2 的下一个分支：

> init 失败是「我们的模块图/源码规模」引起，还是必须要有生产 bindings（HYPERDRIVE 等）才触发？

## 与生产内核一致
- **同一份 `backend/worker/src/**`**（CI 运行时 `rsync` 同步，不在此目录存副本）
- 同一份依赖声明（fastapi / asyncpg / pydantic / pyjwt / python-multipart / bcrypt）
- 同一 `compatibility_date=2026-09-18` 与 `compatibility_flags=["python_workers"]`
- 同一部署工具链（`pywrangler`）

## 刻意不同
- worker 名 `kaas-pyinit-kernelclone`、无 routes / 无 cron / 仅 `workers_dev`
- **不绑定生产 HYPERDRIVE、不连生产 DB、不挂 Service Binding**
  ⇒ 只能压 `/health` 这类不触库的路径（这也正是我们要隔离的「初始化」路径）

## 判据
- 克隆也出现 `initPyInstance` 类异常 ⇒ 与业务 bindings 无关，**定位到源码/模块图规模**；
- 克隆完全正常 ⇒ 触发条件需要生产 bindings（HYPERDRIVE/DB 连接）或特定版本/流量形态。

## 怎么跑
`.github/workflows/pyinit-probe.yml`（手动触发），输入 `target=kernelclone`。
