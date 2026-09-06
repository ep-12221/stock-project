# 股票模拟交易系统

一个使用 Vue 3、TypeScript 和 Node.js / Express 实现的股票模拟交易应用。用户、订单和成交记录都保存在内存中，**后端重启后数据清空**，无需安装数据库。

## 功能说明

- 注册、登录和退出。每个新账户有 100 万虚拟币，初始持仓为空。
- 展示三只股票的代码、名称、最新价和涨跌幅，行情每秒随机小幅波动。
- 支持限价买入、卖出，按价格优先、时间优先撮合，支持部分成交，并更新资金与持仓。
- 查看当前委托、历史委托、持仓和最近成交，以及可用和冻结的资金、持仓。
- 通过 WebSocket 推送行情、委托、持仓和成交变化，断线后自动重连并同步最新状态。
- 下单响应丢失时，可以按原请求标识重试；刷新页面后可恢复待确认委托，避免重复成交。

默认提供有限的系统买卖挂单，新用户注册后即可尝试交易。模拟行情的涨跌与撮合分开处理，只有实际委托匹配才会产生交易。操作示例见[双账户交易演示](docs/功能演示.md)。

## 启动步骤

需要 Node.js **22.14+（22.x）或 24.x**、npm **10+**。

### 本地开发

```bash
git clone https://github.com/ep-12221/stock-project.git
cd stock-project
npm ci
npm run dev
```

一个命令同时启动前后端：前端为 [localhost:5173](http://localhost:5173)，后端为 [localhost:3000](http://localhost:3000/api/health)。打开前端注册账户即可使用，按 Ctrl+C 停止服务。

默认无需配置文件。如需修改后端端口或关闭系统挂单，可参考 [.env.example](.env.example)，在项目根目录创建 .env。

### 构建后运行

先停止开发服务，再执行：

```bash
npm run build
npm start
```

访问 [localhost:3000](http://localhost:3000)。此时由后端同时提供前端静态页面、REST API 和 WebSocket。

### Docker

需要先启动 Docker Engine 或 Docker Desktop。在 Windows 的 WSL 中运行时，还需在 Docker Desktop 的 Settings → Resources → WSL Integration 中启用当前发行版，确认 `docker info` 能显示 Server 信息后，再在项目目录执行：

```bash
docker compose up --build
```

访问 [localhost:3000](http://localhost:3000)。运行前确保 3000 端口空闲，结束后用 `docker compose down` 清理容器。

## 关键架构决策

1. **一次下单的撮合、冻结和结算，共用一个提交边界。** 一笔委托可能连续匹配多笔挂单，后面的校验失败时，前面的成交也不能留在账户里。因此先只读生成撮合计划，再复制受影响用户的账户、持仓和活跃委托索引，在副本上计算结算；冻结量与剩余委托一致、现金和股数守恒等检查全部通过后，才写回内存。整个命令不包含 `await`，WebSocket 通知放在提交之后，发送失败不改变成交结果。这种做法适合题目要求的单进程内存模型，代价是同步计算会占用事件循环，且不能直接推广为多实例或跨进程事务。[撮合与提交实现](apps/server/src/services/trading.service.ts)、[结算校验](apps/server/src/matching/settlement.ts)。

2. **同一笔委托通过请求标识确认结果，网络超时不直接视为下单失败。** 后端以“用户 + `clientOrderId`”识别请求，并将股票、方向、限价和数量组成参数指纹，与订单一起提交。同标识同参数返回原订单的当前状态，参数不同则拒绝，避免重新撮合。前端在发出请求前把原委托写入 `sessionStorage`；超时或响应丢失后保留它、暂停新下单，刷新后由用户继续确认原单。代价是网络异常时暂时不能下新单；去重只对本次服务进程内、同用户同标识的委托生效，关闭标签页或清空存储后不保证恢复原标识。[后端去重](apps/server/src/services/trading.service.ts)、[前端确认流程](apps/client/src/stores/trading.ts)。

3. **实时同步发送当前状态快照，行情与账户分别判断版本。** HTTP 下单响应和 WebSocket 推送可能交错返回，因此前端统一按 `serverEpoch`（服务进程标识）、用户和版本接收状态，账户与行情分别使用 `accountVersion`、`marketVersion`，避免新行情把尚未到达的账户更新判为过期。连接重建后先接收完整当前状态，再恢复下单；历史记录超出快照窗口时通过游标接口补取。选择快照省去了断线期间事件补发和逐条重放的协议，但会重复传输数据，所以只推送当前状态和有限的近期记录。这一取舍适合三只股票的小规模应用，大规模行情应再考虑增量推送。[实时服务](apps/server/src/services/realtime.service.ts)、[前端同步](apps/client/src/stores/realtime.ts)。

## 测试

```bash
npm run check
```

依次执行类型检查、Lint、格式检查、测试和生产构建。目前包含 553 项测试，覆盖撮合优先级、部分成交、资金守恒、用户隔离、断线恢复和下单幂等等场景。详细结果见[验收记录](docs/交付验收与清单.md)。

开发约定：新增功能或修复问题时，先补测试并确认失败，再实现并完成回归。

## AI 协作记录

[关键 Prompt 记录](docs/AI协作记录.md)整理了四次协作，包含当时的问题、提示词和后续处理。更多实现说明见[详细设计](docs/股票模拟交易系统详细实现文档.md)。

交付材料、复现步骤和使用边界见[项目交付说明](docs/项目交付说明.md)。
